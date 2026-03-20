/**
 * CLI command: ov inspect <agent-name>
 *
 * Deep per-agent inspection aggregating data from EventStore, SessionStore,
 * MetricsStore, and tmux capture-pane.
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { Command } from "commander";
import { loadConfig } from "../config.ts";
import { ValidationError } from "../errors.ts";
import { createEventStore } from "../events/store.ts";
import { jsonOutput } from "../json.ts";
import { accent } from "../logging/color.ts";
import { formatDuration } from "../logging/format.ts";
import { renderHeader, separator, stateIconColored } from "../logging/theme.ts";
import { createMetricsStore } from "../metrics/store.ts";
import { openSessionStore } from "../sessions/compat.ts";
import type { AgentSession, StoredEvent, ToolStats } from "../types.ts";
import { buildProjectTmuxCliArgs } from "../worktree/tmux.ts";

/**
 * Extract current file from most recent Edit/Write/Read tool_start event.
 */
function extractCurrentFile(events: StoredEvent[]): string | null {
	// Scan backwards for tool_start events with Edit/Write/Read
	const fileTools = ["Edit", "Write", "Read"];
	for (let i = events.length - 1; i >= 0; i--) {
		const event = events[i];
		if (
			event &&
			event.eventType === "tool_start" &&
			event.toolName &&
			fileTools.includes(event.toolName) &&
			event.toolArgs
		) {
			try {
				const args = JSON.parse(event.toolArgs) as Record<string, unknown>;
				const filePath = (args.file_path as string) ?? (args.path as string);
				if (filePath) {
					return filePath;
				}
			} catch {
				// Failed to parse JSON, continue
			}
		}
	}
	return null;
}

/**
 * Summarize tool arguments for display (truncate long values).
 */
function summarizeArgs(toolArgs: string | null): string {
	if (!toolArgs) return "";
	try {
		const parsed = JSON.parse(toolArgs) as Record<string, unknown>;
		const entries = Object.entries(parsed)
			.map(([key, value]) => {
				const str = String(value);
				return `${key}=${str.length > 40 ? `${str.slice(0, 37)}...` : str}`;
			})
			.join(", ");
		return entries.length > 100 ? `${entries.slice(0, 97)}...` : entries;
	} catch {
		return toolArgs.length > 100 ? `${toolArgs.slice(0, 97)}...` : toolArgs;
	}
}

/**
 * Capture tmux pane output.
 */
async function captureTmux(
	sessionName: string,
	lines: number,
	projectRoot: string,
): Promise<string | null> {
	try {
		const proc = Bun.spawn(
			buildProjectTmuxCliArgs(
				["capture-pane", "-t", sessionName, "-p", "-S", `-${lines}`],
				projectRoot,
			),
			{
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const exitCode = await proc.exited;
		if (exitCode !== 0) {
			return null;
		}
		const output = await new Response(proc.stdout).text();
		return output.trim();
	} catch {
		return null;
	}
}

/** Parsed data from a headless agent's stdout.log NDJSON event stream. */
interface StdoutLogData {
	toolCalls: Array<{
		toolName: string;
		argsSummary: string;
		durationMs: number | null;
		timestamp: string;
	}>;
	cumulativeInputTokens: number;
	cumulativeOutputTokens: number;
	cumulativeCacheReadTokens: number;
	lastModel: string;
	lastContextUtilization: number | null;
	currentTurn: number;
	isMidTool: boolean;
}

/**
 * Find the most recent log directory for a headless agent.
 * Looks under logsBaseDir/{agentName}/ and returns the last entry
 * when sorted alphabetically (ISO timestamps sort = chronological).
 */
async function findLatestLogDir(logsBaseDir: string, agentName: string): Promise<string | null> {
	const agentLogsDir = join(logsBaseDir, agentName);
	try {
		const entries = await readdir(agentLogsDir);
		if (entries.length === 0) return null;
		entries.sort();
		const latest = entries[entries.length - 1];
		if (!latest) return null;
		return join(agentLogsDir, latest);
	} catch {
		return null;
	}
}

/**
 * Parse the last 200 lines of a headless agent's stdout.log NDJSON file.
 *
 * Extracts tool call activity and token usage from Sapling/Codex event streams.
 * Handles partial lines and malformed JSON gracefully.
 *
 * @param logPath - Absolute path to stdout.log
 * @returns Parsed data, or null if file missing or unreadable
 */
async function parseStdoutLog(logPath: string): Promise<StdoutLogData | null> {
	const file = Bun.file(logPath);
	if (!(await file.exists())) return null;

	try {
		const text = await file.text();
		const allLines = text.split("\n");
		// Tail last 200 lines for efficiency
		const lines = allLines.length > 200 ? allLines.slice(-200) : allLines;

		const toolCalls: StdoutLogData["toolCalls"] = [];

		// Track pending tool_start events for durationMs matching.
		// When tool_end arrives, pop the most recent pending entry with matching toolName.
		const pendingTools: Array<{
			toolName: string;
			argsSummary: string;
			timestamp: string;
		}> = [];

		let cumulativeInputTokens = 0;
		let cumulativeOutputTokens = 0;
		let cumulativeCacheReadTokens = 0;
		let lastModel = "";
		let lastContextUtilization: number | null = null;
		let currentTurn = 0;
		let lastEventType: string | null = null;

		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed) continue;

			let event: Record<string, unknown>;
			try {
				event = JSON.parse(trimmed) as Record<string, unknown>;
			} catch {
				continue;
			}

			const type = typeof event.type === "string" ? event.type : null;
			if (!type) continue;

			lastEventType = type;
			const timestamp =
				typeof event.timestamp === "string" ? event.timestamp : new Date().toISOString();

			if (type === "tool_start") {
				const toolName = typeof event.toolName === "string" ? event.toolName : "unknown";
				const argsSummary = typeof event.argsSummary === "string" ? event.argsSummary : "";
				pendingTools.push({ toolName, argsSummary, timestamp });
			} else if (type === "tool_end") {
				const toolName = typeof event.toolName === "string" ? event.toolName : "";
				const durationMs = typeof event.durationMs === "number" ? event.durationMs : null;

				// Find and pop the most recent matching pending tool
				let pendingIdx = -1;
				for (let i = pendingTools.length - 1; i >= 0; i--) {
					if (pendingTools[i]?.toolName === toolName) {
						pendingIdx = i;
						break;
					}
				}
				if (pendingIdx >= 0) {
					const pending = pendingTools[pendingIdx];
					if (pending) {
						pendingTools.splice(pendingIdx, 1);
						toolCalls.push({
							toolName: pending.toolName,
							argsSummary: pending.argsSummary,
							durationMs,
							timestamp: pending.timestamp,
						});
					}
				}
			} else if (type === "turn_start") {
				const turn = typeof event.turn === "number" ? event.turn : currentTurn + 1;
				currentTurn = turn;
			} else if (type === "turn_end") {
				const inputTokens = typeof event.inputTokens === "number" ? event.inputTokens : 0;
				const outputTokens = typeof event.outputTokens === "number" ? event.outputTokens : 0;
				const cacheReadTokens =
					typeof event.cacheReadTokens === "number" ? event.cacheReadTokens : 0;
				const model = typeof event.model === "string" ? event.model : "";
				const ctxUtil =
					typeof event.contextUtilization === "number" ? event.contextUtilization : null;

				cumulativeInputTokens += inputTokens;
				cumulativeOutputTokens += outputTokens;
				cumulativeCacheReadTokens += cacheReadTokens;
				if (model) lastModel = model;
				if (ctxUtil !== null) lastContextUtilization = ctxUtil;
			}
		}

		// Any still-pending tool_starts are mid-execution — include them without durationMs
		for (const pending of pendingTools) {
			toolCalls.push({
				toolName: pending.toolName,
				argsSummary: pending.argsSummary,
				durationMs: null,
				timestamp: pending.timestamp,
			});
		}

		return {
			toolCalls,
			cumulativeInputTokens,
			cumulativeOutputTokens,
			cumulativeCacheReadTokens,
			lastModel,
			lastContextUtilization,
			currentTurn,
			isMidTool: lastEventType === "tool_start",
		};
	} catch {
		return null;
	}
}

export interface InspectData {
	session: AgentSession;
	timeSinceLastActivity: number;
	recentToolCalls: Array<{
		toolName: string;
		args: string;
		durationMs: number | null;
		timestamp: string;
	}>;
	currentFile: string | null;
	toolStats: ToolStats[];
	tokenUsage: {
		inputTokens: number;
		outputTokens: number;
		cacheReadTokens: number;
		cacheCreationTokens: number;
		estimatedCostUsd: number | null;
		modelUsed: string | null;
	} | null;
	tmuxOutput: string | null;
	/** Turn progress for headless agents (populated from stdout.log). */
	headlessTurnInfo: {
		currentTurn: number;
		contextUtilization: number | null;
		isMidTool: boolean;
	} | null;
}

/**
 * Gather all inspection data for an agent.
 */
export async function gatherInspectData(
	root: string,
	agentName: string,
	opts: {
		limit?: number;
		noTmux?: boolean;
		tmuxLines?: number;
	} = {},
): Promise<InspectData> {
	const overstoryDir = join(root, ".overstory");
	const { store } = openSessionStore(overstoryDir);

	let session: AgentSession | null = null;
	try {
		session = store.getByName(agentName);
		if (!session) {
			throw new ValidationError(`Agent not found: ${agentName}`, {
				field: "agent-name",
				value: agentName,
			});
		}

		const now = Date.now();
		const timeSinceLastActivity = now - new Date(session.lastActivity).getTime();

		// EventStore: recent tool calls and tool stats
		let recentToolCalls: InspectData["recentToolCalls"] = [];
		let currentFile: string | null = null;
		let toolStats: ToolStats[] = [];

		const eventsDbPath = join(overstoryDir, "events.db");
		const eventsFile = Bun.file(eventsDbPath);
		if (await eventsFile.exists()) {
			const eventStore = createEventStore(eventsDbPath);
			try {
				// Get recent events for this agent
				const events = eventStore.getByAgent(agentName, { limit: 200 });

				// Extract current file from most recent Edit/Write/Read tool_start
				currentFile = extractCurrentFile(events);

				// Filter to tool_start events for recent tool calls display
				const toolStartEvents = events.filter((e) => e.eventType === "tool_start");
				const limit = opts.limit ?? 20;
				recentToolCalls = toolStartEvents.slice(0, limit).map((event) => ({
					toolName: event.toolName ?? "unknown",
					args: summarizeArgs(event.toolArgs),
					durationMs: event.toolDurationMs,
					timestamp: event.createdAt,
				}));

				// Tool usage statistics
				toolStats = eventStore.getToolStats({ agentName });
			} finally {
				eventStore.close();
			}
		}

		// MetricsStore: token usage
		let tokenUsage: InspectData["tokenUsage"] = null;
		const metricsDbPath = join(overstoryDir, "metrics.db");
		const metricsFile = Bun.file(metricsDbPath);
		if (await metricsFile.exists()) {
			const metricsStore = createMetricsStore(metricsDbPath);
			try {
				const sessions = metricsStore.getSessionsByAgent(agentName);
				const mostRecent = sessions[0];
				if (mostRecent) {
					tokenUsage = {
						inputTokens: mostRecent.inputTokens,
						outputTokens: mostRecent.outputTokens,
						cacheReadTokens: mostRecent.cacheReadTokens,
						cacheCreationTokens: mostRecent.cacheCreationTokens,
						estimatedCostUsd: mostRecent.estimatedCostUsd,
						modelUsed: mostRecent.modelUsed,
					};
				}
			} finally {
				metricsStore.close();
			}
		}

		// tmux capture (skipped for headless agents where tmuxSession is empty)
		let tmuxOutput: string | null = null;
		if (!opts.noTmux && session.tmuxSession) {
			const lines = opts.tmuxLines ?? 30;
			tmuxOutput = await captureTmux(session.tmuxSession, lines, root);
		}

		// Headless stdout.log fallback: parse NDJSON event stream for rich activity data.
		// Used when tmuxSession is empty (headless agent: sapling, codex, etc.).
		let headlessTurnInfo: InspectData["headlessTurnInfo"] = null;
		if (session.tmuxSession === "") {
			const logsBaseDir = join(overstoryDir, "logs");
			const latestLogDir = await findLatestLogDir(logsBaseDir, agentName);
			if (latestLogDir !== null) {
				const stdoutData = await parseStdoutLog(join(latestLogDir, "stdout.log"));
				if (stdoutData !== null) {
					// Populate recentToolCalls from stdout.log when events.db had nothing.
					if (recentToolCalls.length === 0 && stdoutData.toolCalls.length > 0) {
						const limit = opts.limit ?? 20;
						recentToolCalls = stdoutData.toolCalls.slice(0, limit).map((call) => ({
							toolName: call.toolName,
							args: call.argsSummary,
							durationMs: call.durationMs,
							timestamp: call.timestamp,
						}));
					}

					// Populate tokenUsage from turn_end events when metrics.db had nothing.
					if (
						tokenUsage === null &&
						(stdoutData.cumulativeInputTokens > 0 || stdoutData.cumulativeOutputTokens > 0)
					) {
						tokenUsage = {
							inputTokens: stdoutData.cumulativeInputTokens,
							outputTokens: stdoutData.cumulativeOutputTokens,
							cacheReadTokens: stdoutData.cumulativeCacheReadTokens,
							cacheCreationTokens: 0,
							estimatedCostUsd: null,
							modelUsed: stdoutData.lastModel || null,
						};
					}

					// Always populate turn progress info for headless agents.
					headlessTurnInfo = {
						currentTurn: stdoutData.currentTurn,
						contextUtilization: stdoutData.lastContextUtilization,
						isMidTool: stdoutData.isMidTool,
					};
				}
			}
		}

		// Headless fallback: show recent events as live output when no tmux
		if (!tmuxOutput && session.tmuxSession === "" && recentToolCalls.length > 0) {
			const lines: string[] = ["[Headless agent — showing recent tool events]", ""];
			for (const call of recentToolCalls.slice(0, 15)) {
				const time = new Date(call.timestamp).toLocaleTimeString();
				const dur = call.durationMs !== null ? `${call.durationMs}ms` : "pending";
				lines.push(`  [${time}] ${call.toolName.padEnd(15)} ${dur}`);
			}
			tmuxOutput = lines.join("\n");
		}

		return {
			session,
			timeSinceLastActivity,
			recentToolCalls,
			currentFile,
			toolStats,
			tokenUsage,
			tmuxOutput,
			headlessTurnInfo,
		};
	} finally {
		store.close();
	}
}

/**
 * Print inspection data in human-readable format.
 */
export function printInspectData(data: InspectData): void {
	const w = process.stdout.write.bind(process.stdout);
	const { session } = data;

	w(`\n${renderHeader(`Agent Inspection: ${accent(session.agentName)}`)}\n\n`);

	// Agent state and metadata
	w(`${stateIconColored(session.state)} State: ${session.state}\n`);
	w(`Last activity: ${formatDuration(data.timeSinceLastActivity)} ago\n`);
	w(`Task: ${accent(session.taskId)}\n`);
	w(`Capability: ${session.capability}\n`);
	w(`Branch: ${accent(session.branchName)}\n`);
	if (session.parentAgent) {
		w(`Parent: ${accent(session.parentAgent)} (depth: ${session.depth})\n`);
	}
	w(`Started: ${session.startedAt}\n`);
	if (session.tmuxSession) {
		w(`Tmux: ${accent(session.tmuxSession)}\n`);
	} else if (session.pid !== null) {
		w(`Process: PID ${accent(String(session.pid))} (headless)\n`);
	}
	w("\n");

	// Current file
	if (data.currentFile) {
		w(`Current file: ${data.currentFile}\n\n`);
	}

	// Headless turn progress
	if (data.headlessTurnInfo) {
		const { currentTurn, contextUtilization, isMidTool } = data.headlessTurnInfo;
		w("Turn Progress\n");
		w(`${separator()}\n`);
		if (currentTurn > 0) {
			w(`  Current turn:  ${currentTurn}\n`);
		}
		if (contextUtilization !== null) {
			const pct = (contextUtilization * 100).toFixed(1);
			w(`  Context usage: ${pct}%\n`);
		}
		const status = isMidTool ? "executing tool" : "between turns";
		w(`  Status:        ${status}\n`);
		w("\n");
	}

	// Token usage
	if (data.tokenUsage) {
		w("Token Usage\n");
		w(`${separator()}\n`);
		w(`  Input:         ${data.tokenUsage.inputTokens.toLocaleString()}\n`);
		w(`  Output:        ${data.tokenUsage.outputTokens.toLocaleString()}\n`);
		w(`  Cache read:    ${data.tokenUsage.cacheReadTokens.toLocaleString()}\n`);
		w(`  Cache created: ${data.tokenUsage.cacheCreationTokens.toLocaleString()}\n`);
		if (data.tokenUsage.estimatedCostUsd !== null) {
			w(`  Estimated cost: $${data.tokenUsage.estimatedCostUsd.toFixed(4)}\n`);
		}
		if (data.tokenUsage.modelUsed) {
			w(`  Model: ${data.tokenUsage.modelUsed}\n`);
		}
		w("\n");
	}

	// Tool usage statistics (top 10)
	if (data.toolStats.length > 0) {
		w("Tool Usage (Top 10)\n");
		w(`${separator()}\n`);
		const top10 = data.toolStats.slice(0, 10);
		for (const stat of top10) {
			const avgMs = stat.avgDurationMs.toFixed(0);
			w(`  ${stat.toolName.padEnd(20)} ${String(stat.count).padStart(6)} calls  `);
			w(`avg: ${String(avgMs).padStart(6)}ms  max: ${stat.maxDurationMs}ms\n`);
		}
		w("\n");
	}

	// Recent tool calls
	if (data.recentToolCalls.length > 0) {
		w(`Recent Tool Calls (last ${data.recentToolCalls.length})\n`);
		w(`${separator()}\n`);
		for (const call of data.recentToolCalls) {
			const time = new Date(call.timestamp).toLocaleTimeString();
			const duration = call.durationMs !== null ? `${call.durationMs}ms` : "pending";
			w(`  [${time}] ${call.toolName.padEnd(15)} ${duration.padStart(10)}`);
			if (call.args) {
				w(`  ${call.args}`);
			}
			w("\n");
		}
		w("\n");
	}

	// tmux output (or headless fallback)
	if (data.tmuxOutput) {
		w(data.session.tmuxSession ? "Live Tmux Output\n" : "Recent Activity (headless)\n");
		w(`${separator()}\n`);
		w(`${data.tmuxOutput}\n`);
		w(`${separator()}\n`);
	}
}

interface InspectOpts {
	json?: boolean;
	follow?: boolean;
	interval?: string;
	limit?: string;
	tmux?: boolean; // Commander: --no-tmux sets tmux=false
}

async function executeInspect(agentName: string, opts: InspectOpts): Promise<void> {
	const json = opts.json ?? false;
	const follow = opts.follow ?? false;
	// Commander --no-tmux sets opts.tmux = false
	const noTmux = opts.tmux === false;

	const intervalStr = opts.interval;
	const interval = intervalStr ? Number.parseInt(intervalStr, 10) : 3000;
	if (Number.isNaN(interval) || interval < 500) {
		throw new ValidationError("--interval must be a number >= 500 (milliseconds)", {
			field: "interval",
			value: intervalStr,
		});
	}

	const limitStr = opts.limit;
	const limit = limitStr ? Number.parseInt(limitStr, 10) : 20;
	if (Number.isNaN(limit) || limit < 1) {
		throw new ValidationError("--limit must be a number >= 1", {
			field: "limit",
			value: limitStr,
		});
	}

	const cwd = process.cwd();
	const config = await loadConfig(cwd);
	const root = config.project.root;

	if (follow) {
		// Polling loop
		while (true) {
			// Clear screen
			process.stdout.write("\x1b[2J\x1b[H");
			const data = await gatherInspectData(root, agentName, {
				limit,
				noTmux,
				tmuxLines: 30,
			});
			if (json) {
				jsonOutput("inspect", data as unknown as Record<string, unknown>);
			} else {
				printInspectData(data);
			}
			await Bun.sleep(interval);
		}
	} else {
		// Single snapshot
		const data = await gatherInspectData(root, agentName, { limit, noTmux, tmuxLines: 30 });
		if (json) {
			jsonOutput("inspect", data as unknown as Record<string, unknown>);
		} else {
			printInspectData(data);
		}
	}
}

export function createInspectCommand(): Command {
	return new Command("inspect")
		.description("Deep inspection of a single agent")
		.argument("<agent-name>", "Agent name to inspect")
		.option("--json", "Output as JSON")
		.option("--follow", "Poll and refresh continuously")
		.option("--interval <ms>", "Polling interval for --follow in milliseconds (default: 3000)")
		.option("--limit <n>", "Number of recent tool calls to show (default: 20)")
		.option("--no-tmux", "Skip tmux capture-pane")
		.action(async (agentName: string, opts: InspectOpts) => {
			await executeInspect(agentName, opts);
		});
}

export async function inspectCommand(args: string[]): Promise<void> {
	const cmd = createInspectCommand();
	cmd.exitOverride();
	try {
		await cmd.parseAsync(args, { from: "user" });
	} catch (err: unknown) {
		if (err && typeof err === "object" && "code" in err) {
			const code = (err as { code: string }).code;
			if (code === "commander.helpDisplayed" || code === "commander.version") {
				return;
			}
			if (code.startsWith("commander.")) {
				const message = err instanceof Error ? err.message : String(err);
				throw new ValidationError(message, { field: "args" });
			}
		}
		throw err;
	}
}

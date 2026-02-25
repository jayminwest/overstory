/**
 * CLI command: ov inspect <agent-name>
 *
 * Deep per-agent inspection aggregating data from EventStore, SessionStore,
 * MetricsStore, and tmux capture-pane.
 */

import { join } from "node:path";
import { Command } from "commander";
import { ValidationError } from "../errors.ts";
import { createEventStore } from "../events/store.ts";
import { jsonOutput } from "../json.ts";
import { accent } from "../logging/color.ts";
import { formatDuration } from "../logging/format.ts";
import { renderHeader, separator, stateIconColored } from "../logging/theme.ts";
import { createMetricsStore } from "../metrics/store.ts";
import { openSessionStore } from "../sessions/compat.ts";
import type { AgentSession, StoredEvent, ToolStats } from "../types.ts";
import { resolveContext } from "../workspace/resolver.ts";

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
async function captureTmux(sessionName: string, lines: number): Promise<string | null> {
	try {
		const proc = Bun.spawn(["tmux", "capture-pane", "-t", sessionName, "-p", "-S", `-${lines}`], {
			stdout: "pipe",
			stderr: "pipe",
		});
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
	projectId?: string;
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
		dbRoot?: string;
		projectId?: string;
	} = {},
): Promise<InspectData> {
	const overstoryDir = join(root, ".overstory");
	const dbRoot = opts.dbRoot ?? overstoryDir;
	const { store } = openSessionStore(overstoryDir);

	let session: AgentSession | null = null;
	try {
		session = store.getByName(agentName, opts.projectId);
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

		const eventsDbPath = join(dbRoot, "events.db");
		const eventsFile = Bun.file(eventsDbPath);
		if (await eventsFile.exists()) {
			const eventStore = createEventStore(eventsDbPath);
			try {
				// Get recent events for this agent
				const events = eventStore.getByAgent(agentName, {
					limit: 200,
					projectId: opts.projectId,
				});

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
		const metricsDbPath = join(dbRoot, "metrics.db");
		const metricsFile = Bun.file(metricsDbPath);
		if (await metricsFile.exists()) {
			const metricsStore = createMetricsStore(metricsDbPath);
			try {
				const sessions = metricsStore.getSessionsByAgent(agentName, opts.projectId);
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

		// tmux capture
		let tmuxOutput: string | null = null;
		if (!opts.noTmux && session.tmuxSession) {
			const lines = opts.tmuxLines ?? 30;
			tmuxOutput = await captureTmux(session.tmuxSession, lines);
		}

		return {
			session,
			timeSinceLastActivity,
			recentToolCalls,
			currentFile,
			toolStats,
			tokenUsage,
			tmuxOutput,
			projectId: opts.projectId,
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
	if (data.projectId !== undefined) {
		w(`Project: ${data.projectId}\n`);
	}
	w(`Branch: ${accent(session.branchName)}\n`);
	if (session.parentAgent) {
		w(`Parent: ${accent(session.parentAgent)} (depth: ${session.depth})\n`);
	}
	w(`Started: ${session.startedAt}\n`);
	w(`Tmux: ${accent(session.tmuxSession)}\n`);
	w("\n");

	// Current file
	if (data.currentFile) {
		w(`Current file: ${data.currentFile}\n\n`);
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

	// tmux output
	if (data.tmuxOutput) {
		w("Live Tmux Output\n");
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
	project?: string;
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

	const ctx = await resolveContext({ project: opts.project });
	const isWorkspace = ctx.mode === "workspace";
	const root = ctx.projectRoot;

	// In workspace mode, check for agent name ambiguity across projects
	let resolvedProjectId: string | undefined;
	if (isWorkspace) {
		if (opts.project !== undefined) {
			resolvedProjectId = ctx.projectId;
		} else {
			// Workspace-level: no specific project filter — agent looked up across all
			resolvedProjectId = undefined;
		}
	}

	if (follow) {
		// Polling loop
		while (true) {
			// Clear screen
			process.stdout.write("\x1b[2J\x1b[H");
			const data = await gatherInspectData(root, agentName, {
				limit,
				noTmux,
				tmuxLines: 30,
				dbRoot: ctx.dbRoot,
				projectId: resolvedProjectId,
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
		const data = await gatherInspectData(root, agentName, {
			limit,
			noTmux,
			tmuxLines: 30,
			dbRoot: ctx.dbRoot,
			projectId: resolvedProjectId,
		});
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
		.action(async (agentName: string, opts: InspectOpts, cmd: Command) => {
			const globalOpts = cmd.optsWithGlobals();
			await executeInspect(agentName, {
				...opts,
				project: globalOpts.project as string | undefined,
			});
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

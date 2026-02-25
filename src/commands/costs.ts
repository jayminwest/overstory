/**
 * CLI command: ov costs [--agent <name>] [--run <id>] [--by-capability] [--by-project] [--last <n>] [--self] [--json]
 *
 * Shows token/cost analysis and breakdown for agent sessions.
 * Data source: metrics.db via createMetricsStore().
 * Use --self to parse the current orchestrator session's transcript directly.
 */

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { Command } from "commander";
import { loadConfig } from "../config.ts";
import { ValidationError } from "../errors.ts";
import { jsonError, jsonOutput } from "../json.ts";
import { color } from "../logging/color.ts";
import { renderHeader, separator } from "../logging/theme.ts";
import { createMetricsStore } from "../metrics/store.ts";
import { estimateCost, parseTranscriptUsage } from "../metrics/transcript.ts";
import { getRuntime } from "../runtimes/registry.ts";
import { openSessionStore } from "../sessions/compat.ts";
import type { SessionMetrics } from "../types.ts";
import { resolveContext } from "../workspace/resolver.ts";

/** Format a number with thousands separators (e.g., 12345 -> "12,345"). */
function formatNumber(n: number): string {
	return n.toLocaleString("en-US");
}

/** Format a cost value as "$X.XX". Returns "$0.00" for null/undefined. */
function formatCost(cost: number | null): string {
	if (cost === null || cost === undefined) {
		return "$0.00";
	}
	return `$${cost.toFixed(2)}`;
}

/** Right-pad a string to the given width. */
function padRight(str: string, width: number): string {
	return str.length >= width ? str : str + " ".repeat(width - str.length);
}

/** Left-pad a string to the given width. */
function padLeft(str: string, width: number): string {
	return str.length >= width ? str : " ".repeat(width - str.length) + str;
}

/**
 * Resolve the transcript directory for a given runtime and project root.
 *
 * @param runtimeId - The runtime identifier (e.g. "claude")
 * @param projectRoot - Absolute path to the project root
 * @returns Absolute path to the transcript directory, or null if not supported
 */
function getTranscriptDir(runtimeId: string, projectRoot: string): string | null {
	const homeDir = process.env.HOME ?? "";
	if (homeDir.length === 0) return null;
	switch (runtimeId) {
		case "claude": {
			const projectKey = projectRoot.replace(/\//g, "-");
			return join(homeDir, ".claude", "projects", projectKey);
		}
		default:
			return null;
	}
}

/**
 * Discover the orchestrator's transcript JSONL file for the given runtime.
 *
 * Scans the runtime-specific transcript directory for JSONL files and returns
 * the most recently modified one, corresponding to the current orchestrator session.
 *
 * @param runtimeId - The runtime identifier (e.g. "claude")
 * @param projectRoot - Absolute path to the project root
 * @returns Absolute path to the most recent transcript, or null if none found
 */
async function discoverOrchestratorTranscript(
	runtimeId: string,
	projectRoot: string,
): Promise<string | null> {
	const transcriptDir = getTranscriptDir(runtimeId, projectRoot);
	if (transcriptDir === null) return null;

	let entries: string[];
	try {
		entries = await readdir(transcriptDir);
	} catch {
		return null;
	}

	const jsonlFiles = entries.filter((e) => e.endsWith(".jsonl"));
	if (jsonlFiles.length === 0) return null;

	let bestPath: string | null = null;
	let bestMtime = 0;

	for (const file of jsonlFiles) {
		const filePath = join(transcriptDir, file);
		try {
			const fileStat = await stat(filePath);
			if (fileStat.mtimeMs > bestMtime) {
				bestMtime = fileStat.mtimeMs;
				bestPath = filePath;
			}
		} catch {
			// Skip files we cannot stat
		}
	}

	return bestPath;
}

/** Aggregate totals from a list of SessionMetrics. */
interface Totals {
	inputTokens: number;
	outputTokens: number;
	cacheTokens: number;
	costUsd: number;
}

function computeTotals(sessions: SessionMetrics[]): Totals {
	let inputTokens = 0;
	let outputTokens = 0;
	let cacheTokens = 0;
	let costUsd = 0;
	for (const s of sessions) {
		inputTokens += s.inputTokens;
		outputTokens += s.outputTokens;
		cacheTokens += s.cacheReadTokens + s.cacheCreationTokens;
		costUsd += s.estimatedCostUsd ?? 0;
	}
	return { inputTokens, outputTokens, cacheTokens, costUsd };
}

/** Group SessionMetrics by capability. */
interface CapabilityGroup {
	capability: string;
	sessions: SessionMetrics[];
	totals: Totals;
}

function groupByCapability(sessions: SessionMetrics[]): CapabilityGroup[] {
	const groups = new Map<string, SessionMetrics[]>();
	for (const s of sessions) {
		const existing = groups.get(s.capability);
		if (existing) {
			existing.push(s);
		} else {
			groups.set(s.capability, [s]);
		}
	}
	const result: CapabilityGroup[] = [];
	for (const [capability, capSessions] of groups) {
		result.push({
			capability,
			sessions: capSessions,
			totals: computeTotals(capSessions),
		});
	}
	// Sort by cost descending
	result.sort((a, b) => b.totals.costUsd - a.totals.costUsd);
	return result;
}

/** Group SessionMetrics by projectId. */
interface ProjectGroup {
	projectId: string;
	sessions: SessionMetrics[];
	totals: Totals;
}

function groupByProject(sessions: SessionMetrics[]): ProjectGroup[] {
	const groups = new Map<string, SessionMetrics[]>();
	for (const s of sessions) {
		const pid = s.projectId ?? "_default";
		const existing = groups.get(pid);
		if (existing) {
			existing.push(s);
		} else {
			groups.set(pid, [s]);
		}
	}
	const result: ProjectGroup[] = [];
	for (const [projectId, projSessions] of groups) {
		result.push({
			projectId,
			sessions: projSessions,
			totals: computeTotals(projSessions),
		});
	}
	// Sort by cost descending
	result.sort((a, b) => b.totals.costUsd - a.totals.costUsd);
	return result;
}

/** Print the standard per-agent cost summary table. Optionally show [project] column. */
function printCostSummary(sessions: SessionMetrics[], showProject = false): void {
	const w = process.stdout.write.bind(process.stdout);
	const tableWidth = showProject ? 86 : 70;
	const labelWidth = showProject ? 47 : 31;
	w(`${renderHeader("Cost Summary")}\n`);

	if (sessions.length === 0) {
		w(`${color.dim("No session data found.")}\n`);
		return;
	}

	if (showProject) {
		w(
			`${padRight("Agent", 19)}${padRight("Project", 16)}${padRight("Capability", 12)}` +
				`${padLeft("Input", 10)}${padLeft("Output", 10)}` +
				`${padLeft("Cache", 10)}${padLeft("Cost", 10)}\n`,
		);
	} else {
		w(
			`${padRight("Agent", 19)}${padRight("Capability", 12)}` +
				`${padLeft("Input", 10)}${padLeft("Output", 10)}` +
				`${padLeft("Cache", 10)}${padLeft("Cost", 10)}\n`,
		);
	}
	w(`${color.dim(separator(tableWidth))}\n`);

	for (const s of sessions) {
		const cacheTotal = s.cacheReadTokens + s.cacheCreationTokens;
		if (showProject) {
			const pid = s.projectId ?? "_default";
			w(
				`${padRight(s.agentName, 19)}${padRight(pid, 16)}${padRight(s.capability, 12)}` +
					`${padLeft(formatNumber(s.inputTokens), 10)}` +
					`${padLeft(formatNumber(s.outputTokens), 10)}` +
					`${padLeft(formatNumber(cacheTotal), 10)}` +
					`${padLeft(formatCost(s.estimatedCostUsd), 10)}\n`,
			);
		} else {
			w(
				`${padRight(s.agentName, 19)}${padRight(s.capability, 12)}` +
					`${padLeft(formatNumber(s.inputTokens), 10)}` +
					`${padLeft(formatNumber(s.outputTokens), 10)}` +
					`${padLeft(formatNumber(cacheTotal), 10)}` +
					`${padLeft(formatCost(s.estimatedCostUsd), 10)}\n`,
			);
		}
	}

	const totals = computeTotals(sessions);
	w(`${color.dim(separator(tableWidth))}\n`);
	w(
		`${color.green(
			color.bold(
				padRight("Total", labelWidth) +
					padLeft(formatNumber(totals.inputTokens), 10) +
					padLeft(formatNumber(totals.outputTokens), 10) +
					padLeft(formatNumber(totals.cacheTokens), 10) +
					padLeft(formatCost(totals.costUsd), 10),
			),
		)}\n`,
	);
}

/** Print the capability-grouped cost table. */
function printByCapability(sessions: SessionMetrics[]): void {
	const w = process.stdout.write.bind(process.stdout);

	w(`${renderHeader("Cost by Capability")}\n`);

	if (sessions.length === 0) {
		w(`${color.dim("No session data found.")}\n`);
		return;
	}

	w(
		`${padRight("Capability", 14)}${padLeft("Sessions", 10)}` +
			`${padLeft("Input", 10)}${padLeft("Output", 10)}` +
			`${padLeft("Cache", 10)}${padLeft("Cost", 10)}\n`,
	);
	w(`${color.dim(separator())}\n`);

	const groups = groupByCapability(sessions);

	for (const group of groups) {
		w(
			`${padRight(group.capability, 14)}` +
				`${padLeft(formatNumber(group.sessions.length), 10)}` +
				`${padLeft(formatNumber(group.totals.inputTokens), 10)}` +
				`${padLeft(formatNumber(group.totals.outputTokens), 10)}` +
				`${padLeft(formatNumber(group.totals.cacheTokens), 10)}` +
				`${padLeft(formatCost(group.totals.costUsd), 10)}\n`,
		);
	}

	const totals = computeTotals(sessions);
	w(`${color.dim(separator())}\n`);
	w(
		`${color.green(
			color.bold(
				padRight("Total", 14) +
					padLeft(formatNumber(sessions.length), 10) +
					padLeft(formatNumber(totals.inputTokens), 10) +
					padLeft(formatNumber(totals.outputTokens), 10) +
					padLeft(formatNumber(totals.cacheTokens), 10) +
					padLeft(formatCost(totals.costUsd), 10),
			),
		)}\n`,
	);
}

/** Print costs grouped by project with subtotals. */
function printByProject(sessions: SessionMetrics[]): void {
	const w = process.stdout.write.bind(process.stdout);
	const separator = "\u2500".repeat(70);

	w(`${color.bold("Cost by Project")}\n`);
	w(`${"=".repeat(70)}\n`);

	if (sessions.length === 0) {
		w(`${color.dim("No session data found.")}\n`);
		return;
	}

	const projectGroups = groupByProject(sessions);

	for (const group of projectGroups) {
		w(`\n${color.bold(`Project: ${group.projectId}`)}\n`);
		w(`${color.dim(separator)}\n`);
		w(
			`${padRight("Agent", 19)}${padRight("Capability", 12)}` +
				`${padLeft("Input", 10)}${padLeft("Output", 10)}` +
				`${padLeft("Cache", 10)}${padLeft("Cost", 10)}\n`,
		);
		w(`${color.dim(separator)}\n`);

		for (const s of group.sessions) {
			const cacheTotal = s.cacheReadTokens + s.cacheCreationTokens;
			w(
				`${padRight(s.agentName, 19)}${padRight(s.capability, 12)}` +
					`${padLeft(formatNumber(s.inputTokens), 10)}` +
					`${padLeft(formatNumber(s.outputTokens), 10)}` +
					`${padLeft(formatNumber(cacheTotal), 10)}` +
					`${padLeft(formatCost(s.estimatedCostUsd), 10)}\n`,
			);
		}

		w(`${color.dim(separator)}\n`);
		w(
			`${color.cyan(
				color.bold(
					padRight(`Subtotal (${group.projectId})`, 31) +
						padLeft(formatNumber(group.totals.inputTokens), 10) +
						padLeft(formatNumber(group.totals.outputTokens), 10) +
						padLeft(formatNumber(group.totals.cacheTokens), 10) +
						padLeft(formatCost(group.totals.costUsd), 10),
				),
			)}\n`,
		);
	}

	const totals = computeTotals(sessions);
	w(`\n${"=".repeat(70)}\n`);
	w(
		`${color.green(
			color.bold(
				padRight("Workspace Total", 31) +
					padLeft(formatNumber(totals.inputTokens), 10) +
					padLeft(formatNumber(totals.outputTokens), 10) +
					padLeft(formatNumber(totals.cacheTokens), 10) +
					padLeft(formatCost(totals.costUsd), 10),
			),
		)}\n`,
	);
}

interface CostsOpts {
	live?: boolean;
	self?: boolean;
	byCapability?: boolean;
	byProject?: boolean;
	agent?: string;
	run?: string;
	bead?: string;
	last?: string;
	json?: boolean;
	project?: string;
}

async function executeCosts(opts: CostsOpts): Promise<void> {
	const json = opts.json ?? false;
	const live = opts.live ?? false;
	const self = opts.self ?? false;
	const byCapability = opts.byCapability ?? false;
	const byProject = opts.byProject ?? false;
	const agentName = opts.agent;
	const runId = opts.run;
	const beadId = opts.bead;
	const lastStr = opts.last;

	if (lastStr !== undefined) {
		const parsed = Number.parseInt(lastStr, 10);
		if (Number.isNaN(parsed) || parsed < 1) {
			throw new ValidationError("--last must be a positive integer", {
				field: "last",
				value: lastStr,
			});
		}
	}

	const last = lastStr ? Number.parseInt(lastStr, 10) : 20;

	const ctx = await resolveContext({ project: opts.project });
	const isWorkspace = ctx.mode === "workspace";
	const metricsDbPath = join(ctx.dbRoot, "metrics.db");

	// Handle --self flag (early return for self-scan)
	if (self) {
		const config = await loadConfig(ctx.projectRoot);
		const runtime = getRuntime(undefined, config);
		const transcriptPath = await discoverOrchestratorTranscript(runtime.id, ctx.projectRoot);
		if (!transcriptPath) {
			if (json) {
				jsonError("costs", `No transcript found for runtime '${runtime.id}'`);
			} else {
				process.stdout.write(
					`No transcript found for runtime '${runtime.id}'.\n` +
						"Transcript discovery may not be supported for this runtime.\n",
				);
			}
			return;
		}

		const usage = await parseTranscriptUsage(transcriptPath);
		const cost = estimateCost(usage);
		const cacheTotal = usage.cacheReadTokens + usage.cacheCreationTokens;

		if (json) {
			jsonOutput("costs", {
				source: "self",
				transcriptPath,
				model: usage.modelUsed,
				inputTokens: usage.inputTokens,
				outputTokens: usage.outputTokens,
				cacheReadTokens: usage.cacheReadTokens,
				cacheCreationTokens: usage.cacheCreationTokens,
				estimatedCostUsd: cost,
			});
		} else {
			const w = process.stdout.write.bind(process.stdout);

			w(`${renderHeader("Orchestrator Session Cost")}\n`);
			w(`${padRight("Model:", 12)}${usage.modelUsed ?? "unknown"}\n`);
			w(`${padRight("Transcript:", 12)}${transcriptPath}\n`);
			w(`${color.dim(separator())}\n`);
			w(`${padRight("Input tokens:", 22)}${padLeft(formatNumber(usage.inputTokens), 12)}\n`);
			w(`${padRight("Output tokens:", 22)}${padLeft(formatNumber(usage.outputTokens), 12)}\n`);
			w(`${padRight("Cache tokens:", 22)}${padLeft(formatNumber(cacheTotal), 12)}\n`);
			w(`${color.dim(separator())}\n`);
			w(
				`${color.green(color.bold(padRight("Estimated cost:", 22) + padLeft(formatCost(cost), 12)))}\n`,
			);
		}
		return;
	}

	// Handle --live flag (early return for live view)
	if (live) {
		const metricsFile = Bun.file(metricsDbPath);
		if (!(await metricsFile.exists())) {
			if (json) {
				jsonOutput("costs", {
					agents: [],
					totals: {
						inputTokens: 0,
						outputTokens: 0,
						cacheTokens: 0,
						costUsd: 0,
						burnRatePerMin: 0,
						tokensPerMin: 0,
					},
				});
			} else {
				process.stdout.write(
					"No live data available. Token snapshots begin after first tool call.\n",
				);
			}
			return;
		}

		const metricsStore = createMetricsStore(metricsDbPath);
		const { store: sessionStore } = openSessionStore(ctx.overstoryDir);

		try {
			const snapshots = metricsStore.getLatestSnapshots();
			if (snapshots.length === 0) {
				if (json) {
					jsonOutput("costs", {
						agents: [],
						totals: {
							inputTokens: 0,
							outputTokens: 0,
							cacheTokens: 0,
							costUsd: 0,
							burnRatePerMin: 0,
							tokensPerMin: 0,
						},
					});
				} else {
					process.stdout.write(
						"No live data available. Token snapshots begin after first tool call.\n",
					);
				}
				return;
			}

			// Get active sessions to join with snapshots
			const activeSessions = sessionStore.getActive();

			// Filter snapshots by agent if --agent is provided
			const filteredSnapshots = agentName
				? snapshots.filter((s) => s.agentName === agentName)
				: snapshots;

			// Build agent data with session info
			interface LiveAgentData {
				agentName: string;
				capability: string;
				inputTokens: number;
				outputTokens: number;
				cacheReadTokens: number;
				cacheCreationTokens: number;
				estimatedCostUsd: number;
				modelUsed: string | null;
				snapshotAt: string;
				sessionStartedAt: string;
				elapsedMs: number;
			}

			const agentData: LiveAgentData[] = [];
			const now = Date.now();

			for (const snapshot of filteredSnapshots) {
				const session = activeSessions.find((s) => s.agentName === snapshot.agentName);
				if (!session) continue; // Skip inactive agents

				const startedAt = new Date(session.startedAt).getTime();
				const elapsedMs = now - startedAt;

				agentData.push({
					agentName: snapshot.agentName,
					capability: session.capability,
					inputTokens: snapshot.inputTokens,
					outputTokens: snapshot.outputTokens,
					cacheReadTokens: snapshot.cacheReadTokens,
					cacheCreationTokens: snapshot.cacheCreationTokens,
					estimatedCostUsd: snapshot.estimatedCostUsd ?? 0,
					modelUsed: snapshot.modelUsed,
					snapshotAt: snapshot.createdAt,
					sessionStartedAt: session.startedAt,
					elapsedMs,
				});
			}

			// Compute totals
			let totalInput = 0;
			let totalOutput = 0;
			let totalCacheRead = 0;
			let totalCacheCreate = 0;
			let totalCost = 0;
			let totalElapsedMs = 0;

			for (const agent of agentData) {
				totalInput += agent.inputTokens;
				totalOutput += agent.outputTokens;
				totalCacheRead += agent.cacheReadTokens;
				totalCacheCreate += agent.cacheCreationTokens;
				totalCost += agent.estimatedCostUsd;
				totalElapsedMs += agent.elapsedMs;
			}

			const avgElapsedMs = agentData.length > 0 ? totalElapsedMs / agentData.length : 0;
			const totalCacheTokens = totalCacheRead + totalCacheCreate;
			const totalTokens = totalInput + totalOutput;
			const burnRatePerMin = avgElapsedMs > 0 ? totalCost / (avgElapsedMs / 60_000) : 0;
			const tokensPerMin = avgElapsedMs > 0 ? totalTokens / (avgElapsedMs / 60_000) : 0;

			if (json) {
				jsonOutput("costs", {
					agents: agentData,
					totals: {
						inputTokens: totalInput,
						outputTokens: totalOutput,
						cacheTokens: totalCacheTokens,
						costUsd: totalCost,
						burnRatePerMin,
						tokensPerMin,
					},
				});
			} else {
				const w = process.stdout.write.bind(process.stdout);

				w(`${renderHeader(`Live Token Usage (${agentData.length} active agents)`)}\n`);
				w(
					`${padRight("Agent", 19)}${padRight("Capability", 12)}` +
						`${padLeft("Input", 10)}${padLeft("Output", 10)}` +
						`${padLeft("Cache", 10)}${padLeft("Cost", 10)}\n`,
				);
				w(`${color.dim(separator())}\n`);

				for (const agent of agentData) {
					const cacheTotal = agent.cacheReadTokens + agent.cacheCreationTokens;
					w(
						`${padRight(agent.agentName, 19)}${padRight(agent.capability, 12)}` +
							`${padLeft(formatNumber(agent.inputTokens), 10)}` +
							`${padLeft(formatNumber(agent.outputTokens), 10)}` +
							`${padLeft(formatNumber(cacheTotal), 10)}` +
							`${padLeft(formatCost(agent.estimatedCostUsd), 10)}\n`,
					);
				}

				w(`${color.dim(separator())}\n`);
				w(
					`${color.green(
						color.bold(
							padRight("Total", 31) +
								padLeft(formatNumber(totalInput), 10) +
								padLeft(formatNumber(totalOutput), 10) +
								padLeft(formatNumber(totalCacheTokens), 10) +
								padLeft(formatCost(totalCost), 10),
						),
					)}\n\n`,
				);

				// Format elapsed time
				const totalElapsedSec = Math.floor(avgElapsedMs / 1000);
				const minutes = Math.floor(totalElapsedSec / 60);
				const seconds = totalElapsedSec % 60;
				const elapsedStr = `${minutes}m ${seconds}s`;

				w(
					`Burn rate: ${formatCost(burnRatePerMin)}/min  |  ` +
						`${formatNumber(Math.floor(tokensPerMin))} tokens/min  |  ` +
						`Elapsed: ${elapsedStr}\n`,
				);
			}
		} finally {
			metricsStore.close();
			sessionStore.close();
		}
		return;
	}

	// Check if metrics.db exists
	const metricsFile = Bun.file(metricsDbPath);
	if (!(await metricsFile.exists())) {
		if (json) {
			jsonOutput("costs", { sessions: [] });
		} else {
			process.stdout.write("No metrics data yet.\n");
		}
		return;
	}

	const metricsStore = createMetricsStore(metricsDbPath);

	try {
		// Determine projectId filter for workspace mode with explicit --project
		const projectIdFilter = isWorkspace && opts.project !== undefined ? ctx.projectId : undefined;

		let sessions: SessionMetrics[];

		if (agentName !== undefined) {
			sessions = metricsStore.getSessionsByAgent(agentName, projectIdFilter);
		} else if (runId !== undefined) {
			sessions = metricsStore.getSessionsByRun(runId, projectIdFilter);
		} else if (beadId !== undefined) {
			sessions = metricsStore.getSessionsByTask(beadId, projectIdFilter);
		} else {
			sessions = metricsStore.getRecentSessions(last, projectIdFilter);
		}

		if (json) {
			if (byCapability) {
				const groups = groupByCapability(sessions);
				const grouped: Record<string, { sessions: SessionMetrics[]; totals: Totals }> = {};
				for (const group of groups) {
					grouped[group.capability] = {
						sessions: group.sessions,
						totals: group.totals,
					};
				}
				jsonOutput("costs", { grouped });
			} else if (byProject) {
				const groups = groupByProject(sessions);
				const grouped: Record<string, { sessions: SessionMetrics[]; totals: Totals }> = {};
				for (const group of groups) {
					grouped[group.projectId] = {
						sessions: group.sessions,
						totals: group.totals,
					};
				}
				jsonOutput("costs", { grouped });
			} else {
				jsonOutput("costs", { sessions });
			}
			return;
		}

		if (byCapability) {
			printByCapability(sessions);
		} else if (byProject) {
			printByProject(sessions);
		} else {
			// In workspace mode without --project, show project column
			printCostSummary(sessions, isWorkspace && opts.project === undefined);
		}
	} finally {
		metricsStore.close();
	}
}

export function createCostsCommand(): Command {
	return new Command("costs")
		.description("Token/cost analysis and breakdown")
		.option("--live", "Show real-time token usage for active agents")
		.option("--self", "Show cost for the current orchestrator session")
		.option("--agent <name>", "Filter by agent name")
		.option("--run <id>", "Filter by run ID")
		.option("--bead <id>", "Show cost breakdown for a specific task/bead")
		.option("--by-capability", "Group results by capability with subtotals")
		.option("--by-project", "Group results by project with subtotals")
		.option("--last <n>", "Number of recent sessions (default: 20)")
		.option("--json", "Output as JSON")
		.action(async (opts: CostsOpts, cmd: Command) => {
			const globalOpts = cmd.optsWithGlobals();
			await executeCosts({ ...opts, project: globalOpts.project as string | undefined });
		});
}

export async function costsCommand(args: string[]): Promise<void> {
	const cmd = createCostsCommand();
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

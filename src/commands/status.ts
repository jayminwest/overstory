/**
 * CLI command: overstory status [--json] [--watch]
 *
 * Shows active agents, worktree status, task summary, mail queue depth,
 * and merge queue state. --watch mode uses polling for live updates.
 */

import { join } from "node:path";
import { Command } from "commander";
import { loadConfig } from "../config.ts";
import { ValidationError } from "../errors.ts";
import { jsonOutput } from "../json.ts";
import { accent, color } from "../logging/color.ts";
import { formatDuration } from "../logging/format.ts";
import { renderHeader } from "../logging/theme.ts";
import { createMailStore } from "../mail/store.ts";
import { createMergeQueue } from "../merge/queue.ts";
import { createMetricsStore } from "../metrics/store.ts";
import { openSessionStore } from "../sessions/compat.ts";
import type { AgentSession } from "../types.ts";
import { evaluateHealth } from "../watchdog/health.ts";
import { listWorktrees } from "../worktree/manager.ts";
import { isProcessAlive } from "../worktree/process-utils.ts";
import { getSessionManager } from "../worktree/session-factory.ts";

// ---------------------------------------------------------------------------
// Subprocess result cache (TTL-based, module-level)
// ---------------------------------------------------------------------------

interface CacheEntry<T> {
	data: T;
	timestamp: number;
}

let worktreeCache: CacheEntry<Array<{ path: string; branch: string; head: string }>> | null = null;
let tmuxCache: CacheEntry<Array<{ name: string; pid: number }>> | null = null;

const DEFAULT_CACHE_TTL_MS = 10_000; // 10 seconds

export function invalidateStatusCache(): void {
	worktreeCache = null;
	tmuxCache = null;
}

export async function getCachedWorktrees(
	root: string,
	ttlMs: number = DEFAULT_CACHE_TTL_MS,
): Promise<Array<{ path: string; branch: string; head: string }>> {
	const now = Date.now();
	if (worktreeCache && now - worktreeCache.timestamp < ttlMs) {
		return worktreeCache.data;
	}
	const data = await listWorktrees(root);
	worktreeCache = { data, timestamp: now };
	return data;
}

export async function getCachedTmuxSessions(
	ttlMs: number = DEFAULT_CACHE_TTL_MS,
): Promise<Array<{ name: string; pid: number }>> {
	const now = Date.now();
	if (tmuxCache && now - tmuxCache.timestamp < ttlMs) {
		return tmuxCache.data;
	}
	try {
		const sm = await getSessionManager();
		const data = await sm.listSessions();
		tmuxCache = { data, timestamp: now };
		return data;
	} catch {
		return tmuxCache?.data ?? [];
	}
}

export interface VerboseAgentDetail {
	worktreePath: string;
	logsDir: string;
	lastMailSent: string | null;
	lastMailReceived: string | null;
	capability: string;
}

export interface StatusData {
	currentRunId?: string | null;
	agents: AgentSession[];
	worktrees: Array<{ path: string; branch: string; head: string }>;
	tmuxSessions: Array<{ name: string; pid: number }>;
	unreadMailCount: number;
	mergeQueueCount: number;
	recentMetricsCount: number;
	verboseDetails?: Record<string, VerboseAgentDetail>;
}

async function readCurrentRunId(overstoryDir: string): Promise<string | null> {
	const path = join(overstoryDir, "current-run.txt");
	const file = Bun.file(path);
	if (!(await file.exists())) {
		return null;
	}
	const text = await file.text();
	const trimmed = text.trim();
	return trimmed.length > 0 ? trimmed : null;
}

/**
 * Gather all status data.
 * @param agentName - Which agent's perspective for unread mail count (default "orchestrator")
 * @param verbose - When true, collect extra per-agent detail (worktree path, logs dir, last mail)
 * @param runId - When provided, only sessions for that run are returned; null/undefined shows all
 */
export async function gatherStatus(
	root: string,
	agentName = "orchestrator",
	verbose = false,
	runId?: string | null,
): Promise<StatusData> {
	const overstoryDir = join(root, ".overstory");
	const { store } = openSessionStore(overstoryDir);

	let sessions: AgentSession[];
	try {
		// When run-scoped, also include sessions with null runId (e.g. coordinator)
		// because SQL WHERE run_id = $run_id never matches NULL rows.
		sessions = runId
			? [...store.getByRun(runId), ...store.getAll().filter((s) => s.runId === null)]
			: store.getAll();

		const worktrees = await getCachedWorktrees(root);

		const tmuxSessions = await getCachedTmuxSessions();

		// Reconcile agent states using the same health evaluation as the
		// dashboard and watchdog. This handles:
		//   1. tmux dead -> zombie (regardless of recorded state)
		//   2. persistent capabilities (coordinator, monitor) booting -> working when tmux alive
		//   3. time-based stale/zombie detection for non-persistent agents
		const tmuxSessionNames = new Set(tmuxSessions.map((s) => s.name));
		const healthThresholds = { staleMs: 300_000, zombieMs: 600_000 };
		for (const session of sessions) {
			if (session.state === "completed") continue;
			const tmuxAlive = tmuxSessionNames.has(session.tmuxSession);
			const check = evaluateHealth(session, tmuxAlive, healthThresholds);
			if (check.state !== session.state) {
				try {
					store.updateState(session.agentName, check.state);
					session.state = check.state;
				} catch {
					// Best effort: don't fail status display if update fails
				}
			}
		}

		let unreadMailCount = 0;
		let mailStore: ReturnType<typeof createMailStore> | null = null;
		try {
			const mailDbPath = join(root, ".overstory", "mail.db");
			const mailFile = Bun.file(mailDbPath);
			if (await mailFile.exists()) {
				mailStore = createMailStore(mailDbPath);
				const unread = mailStore.getAll({ to: agentName, unread: true });
				unreadMailCount = unread.length;
			}
		} catch {
			// mail db might not exist
		}

		let mergeQueueCount = 0;
		try {
			const queuePath = join(root, ".overstory", "merge-queue.db");
			const queue = createMergeQueue(queuePath);
			mergeQueueCount = queue.list("pending").length;
			queue.close();
		} catch {
			// queue might not exist
		}

		let recentMetricsCount = 0;
		try {
			const metricsDbPath = join(root, ".overstory", "metrics.db");
			const metricsFile = Bun.file(metricsDbPath);
			if (await metricsFile.exists()) {
				const metricsStore = createMetricsStore(metricsDbPath);
				recentMetricsCount = metricsStore.countSessions();
				metricsStore.close();
			}
		} catch {
			// metrics db might not exist
		}

		let verboseDetails: Record<string, VerboseAgentDetail> | undefined;
		if (verbose && sessions.length > 0) {
			verboseDetails = {};
			for (const session of sessions) {
				const logsDir = join(root, ".overstory", "logs", session.agentName);

				let lastMailSent: string | null = null;
				let lastMailReceived: string | null = null;
				if (mailStore) {
					try {
						const sent = mailStore.getAll({ from: session.agentName });
						if (sent.length > 0 && sent[0]) {
							lastMailSent = sent[0].createdAt;
						}
						const received = mailStore.getAll({ to: session.agentName });
						if (received.length > 0 && received[0]) {
							lastMailReceived = received[0].createdAt;
						}
					} catch {
						// Best effort
					}
				}

				verboseDetails[session.agentName] = {
					worktreePath: session.worktreePath,
					logsDir,
					lastMailSent,
					lastMailReceived,
					capability: session.capability,
				};
			}
		}

		if (mailStore) {
			mailStore.close();
		}

		return {
			currentRunId: runId,
			agents: sessions,
			worktrees,
			tmuxSessions,
			unreadMailCount,
			mergeQueueCount,
			recentMetricsCount,
			verboseDetails,
		};
	} finally {
		store.close();
	}
}

/**
 * Print status in human-readable format.
 */
export function printStatus(data: StatusData): void {
	const now = Date.now();
	const w = process.stdout.write.bind(process.stdout);

	w(`${renderHeader("Overstory Status")}\n\n`);
	if (data.currentRunId) {
		w(`Run: ${accent(data.currentRunId)}\n`);
	}

	// Active agents
	const active = data.agents.filter((a) => a.state !== "zombie" && a.state !== "completed");
	w(`Agents: ${active.length} active\n`);
	if (active.length > 0) {
		const tmuxSessionNames = new Set(data.tmuxSessions.map((s) => s.name));
		for (const agent of active) {
			const endTime =
				agent.state === "completed" || agent.state === "zombie"
					? new Date(agent.lastActivity).getTime()
					: now;
			const duration = formatDuration(endTime - new Date(agent.startedAt).getTime());
			const isHeadless = agent.tmuxSession === "" && agent.pid !== null;
			const alive = isHeadless
				? agent.pid !== null && isProcessAlive(agent.pid)
				: tmuxSessionNames.has(agent.tmuxSession);
			const aliveMarker = alive ? color.green(">") : color.red("x");
			w(`   ${aliveMarker} ${accent(agent.agentName)} [${agent.capability}] `);
			w(`${agent.state} | ${accent(agent.taskId)} | ${duration}\n`);

			const detail = data.verboseDetails?.[agent.agentName];
			if (detail) {
				w(`     Worktree: ${detail.worktreePath}\n`);
				w(`     Logs:     ${detail.logsDir}\n`);
				w(`     Mail sent: ${detail.lastMailSent ?? "none"}`);
				w(` | received: ${detail.lastMailReceived ?? "none"}\n`);
			}
		}
	} else {
		w("   No active agents\n");
	}
	w("\n");

	// Worktrees
	const overstoryWts = data.worktrees.filter((wt) => wt.branch.startsWith("overstory/"));
	w(`Worktrees: ${overstoryWts.length}\n`);
	for (const wt of overstoryWts) {
		w(`   ${wt.branch}\n`);
	}
	if (overstoryWts.length === 0) {
		w("   No agent worktrees\n");
	}
	w("\n");

	// Mail
	w(`Mail: ${data.unreadMailCount} unread\n`);

	// Merge queue
	w(`Merge queue: ${data.mergeQueueCount} pending\n`);

	// Metrics
	w(`Sessions recorded: ${data.recentMetricsCount}\n`);
}

interface StatusOpts {
	json?: boolean;
	watch?: boolean;
	verbose?: boolean;
	all?: boolean;
	interval?: string;
	agent?: string;
}

async function executeStatus(opts: StatusOpts): Promise<void> {
	const json = opts.json ?? false;
	const watch = opts.watch ?? false;
	const verbose = opts.verbose ?? false;
	const all = opts.all ?? false;
	const intervalStr = opts.interval;
	const interval = intervalStr ? Number.parseInt(intervalStr, 10) : 3000;

	if (Number.isNaN(interval) || interval < 500) {
		throw new ValidationError("--interval must be a number >= 500 (milliseconds)", {
			field: "interval",
			value: intervalStr,
		});
	}

	const agentName = opts.agent ?? "orchestrator";

	const cwd = process.cwd();
	const config = await loadConfig(cwd);
	const root = config.project.root;

	let runId: string | null | undefined;
	if (!all) {
		const overstoryDir = join(root, ".overstory");
		runId = await readCurrentRunId(overstoryDir);
	}

	if (watch) {
		process.stderr.write(
			"Warning: --watch is deprecated. Use 'ov dashboard' for live monitoring.\n\n",
		);
		// Polling loop (kept for one release cycle)
		while (true) {
			// Clear screen
			process.stdout.write("\x1b[2J\x1b[H");
			const data = await gatherStatus(root, agentName, verbose, runId);
			if (json) {
				jsonOutput("status", data as unknown as Record<string, unknown>);
			} else {
				printStatus(data);
			}
			await Bun.sleep(interval);
		}
	} else {
		const data = await gatherStatus(root, agentName, verbose, runId);
		if (json) {
			jsonOutput("status", data as unknown as Record<string, unknown>);
		} else {
			printStatus(data);
		}
	}
}

export function createStatusCommand(): Command {
	return new Command("status")
		.description("Show all active agents and project state")
		.option("--json", "Output as JSON")
		.option("--verbose", "Show extra detail per agent (worktree, logs, mail timestamps)")
		.option("--agent <name>", "Show unread mail for this agent (default: orchestrator)")
		.option("--all", "Show sessions from all runs (default: current run only)")
		.option("--watch", "(deprecated) Use 'ov dashboard' for live monitoring")
		.option("--interval <ms>", "Poll interval for --watch in milliseconds (default: 3000)")
		.action(async (opts: StatusOpts) => {
			await executeStatus(opts);
		});
}

export async function statusCommand(args: string[]): Promise<void> {
	const cmd = createStatusCommand();
	cmd.exitOverride();
	try {
		await cmd.parseAsync(args, { from: "user" });
	} catch (err: unknown) {
		if (err && typeof err === "object" && "code" in err) {
			const code = (err as { code: string }).code;
			if (code === "commander.helpDisplayed" || code === "commander.version") {
				return;
			}
		}
		throw err;
	}
}

/**
 * CLI command: ov clean [--all] [--mail] [--sessions] [--metrics]
 *   [--logs] [--worktrees] [--branches] [--agents] [--specs]
 *
 * Nuclear cleanup of overstory runtime state.
 * --all does everything. Individual flags allow selective cleanup.
 *
 * Execution order for --all (processes → filesystem → databases):
 *   0. Run mulch health checks (informational, non-destructive):
 *      - Check domains approaching governance limits
 *      - Run mulch prune --dry-run (report stale record counts)
 *      - Run mulch doctor (report health issues)
 *   1. Kill all overstory tmux sessions
 *   2. Remove all worktrees
 *   3. Delete orphaned overstory/* branches
 *   4. Delete SQLite databases (mail.db, metrics.db)
 *   5. Wipe sessions.db, merge-queue.db
 *   6. Clear directory contents (logs/, agents/, specs/)
 *   7. Delete nudge-state.json
 */

import { existsSync } from "node:fs";
import { readdir, rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "../config.ts";
import { ValidationError } from "../errors.ts";
import { createEventStore } from "../events/store.ts";
import { jsonOutput } from "../json.ts";
import { printHint, printSuccess } from "../logging/color.ts";
import { createMulchClient } from "../mulch/client.ts";
import { openSessionStore } from "../sessions/compat.ts";
import type { AgentSession, MulchDoctorResult, MulchPruneResult, MulchStatus } from "../types.ts";
import { listWorktrees, removeWorktree } from "../worktree/manager.ts";
import { getSessionManager } from "../worktree/session-factory.ts";

export interface CleanOptions {
	all?: boolean;
	mail?: boolean;
	sessions?: boolean;
	metrics?: boolean;
	logs?: boolean;
	worktrees?: boolean;
	branches?: boolean;
	agents?: boolean;
	specs?: boolean;
	json?: boolean;
}

/**
 * Load active agent sessions from SessionStore for session-end event logging.
 * Returns sessions that are in an active state (booting, working, stalled).
 *
 * Checks for sessions.db or sessions.json existence first to avoid creating
 * an empty database file as a side effect (which would interfere with
 * the "Nothing to clean" detection later in the pipeline).
 */
function loadActiveSessions(overstoryDir: string): AgentSession[] {
	try {
		const dbPath = join(overstoryDir, "sessions.db");
		const jsonPath = join(overstoryDir, "sessions.json");
		if (!existsSync(dbPath) && !existsSync(jsonPath)) {
			return [];
		}
		const { store } = openSessionStore(overstoryDir);
		try {
			return store.getActive();
		} finally {
			store.close();
		}
	} catch {
		return [];
	}
}

/**
 * Log synthetic session-end events for all active agents before killing tmux sessions.
 *
 * When clean --all or --worktrees kills tmux sessions, the Stop hook never fires
 * because the process is killed externally. This function writes session_end events
 * to the EventStore with reason='clean' so observability records are complete.
 */
async function logSyntheticSessionEndEvents(overstoryDir: string): Promise<number> {
	let logged = 0;
	try {
		const activeSessions = loadActiveSessions(overstoryDir);
		if (activeSessions.length === 0) {
			return 0;
		}

		const eventsDbPath = join(overstoryDir, "events.db");
		const eventStore = createEventStore(eventsDbPath);
		try {
			for (const session of activeSessions) {
				eventStore.insert({
					runId: session.runId,
					agentName: session.agentName,
					sessionId: session.id,
					eventType: "session_end",
					toolName: null,
					toolArgs: null,
					toolDurationMs: null,
					level: "info",
					data: JSON.stringify({ reason: "clean", capability: session.capability }),
				});
				logged++;
			}
		} finally {
			eventStore.close();
		}
	} catch {
		// Best effort: event logging should not block cleanup
	}
	return logged;
}

interface CleanResult {
	sessionEndEventsLogged: number;
	tmuxKilled: number;
	worktreesCleaned: number;
	branchesDeleted: number;
	mailWiped: boolean;
	sessionsCleared: boolean;
	mergeQueueCleared: boolean;
	metricsWiped: boolean;
	logsCleared: boolean;
	agentsCleared: boolean;
	specsCleared: boolean;
	nudgeStateCleared: boolean;
	currentRunCleared: boolean;
	mulchHealth: {
		checked: boolean;
		domainsNearLimit: Array<{ domain: string; recordCount: number; warnThreshold: number }>;
		stalePruneCandidates: number;
		doctorIssues: number;
		doctorWarnings: number;
	} | null;
}

/**
 * Kill overstory tmux sessions registered in THIS project's SessionStore.
 *
 * Project-scoped: only kills tmux sessions whose names appear in the
 * project's sessions.db (or sessions.json). This prevents cross-project
 * kills during dogfooding, where `bun test` might run inside a live swarm.
 *
 * Falls back to killing all "overstory-{projectName}-" prefixed tmux sessions
 * only if the SessionStore is unavailable (graceful degradation for broken state).
 */
async function killAllTmuxSessions(overstoryDir: string, projectName: string): Promise<number> {
	let killed = 0;
	const projectPrefix = `overstory-${projectName}-`;
	try {
		const sm = await getSessionManager();
		const tmuxSessions = await sm.listSessions();
		const overStorySessions = tmuxSessions.filter((s) => s.name.startsWith(projectPrefix));
		if (overStorySessions.length === 0) {
			return 0;
		}

		// Build a set of tmux session names registered in this project's SessionStore.
		const registeredNames = loadRegisteredTmuxNames(overstoryDir);

		// If we got registered names, only kill those. Otherwise fall back to all
		// overstory-{projectName}-* sessions.
		const toKill =
			registeredNames !== null
				? overStorySessions.filter((s) => registeredNames.has(s.name))
				: overStorySessions;

		for (const session of toKill) {
			try {
				await sm.killSession(session.name);
				killed++;
			} catch {
				// Best effort
			}
		}
	} catch {
		// tmux not available or no server running
	}
	return killed;
}

/**
 * Load the set of tmux session names registered in this project's SessionStore.
 *
 * Returns null if the SessionStore cannot be opened (signals the caller to
 * fall back to the legacy "kill all overstory-*" behavior).
 */
function loadRegisteredTmuxNames(overstoryDir: string): Set<string> | null {
	try {
		const dbPath = join(overstoryDir, "sessions.db");
		const jsonPath = join(overstoryDir, "sessions.json");
		if (!existsSync(dbPath) && !existsSync(jsonPath)) {
			// No session data at all -- return empty set (not null).
			// This is distinct from "store unavailable": it means the project
			// has no registered sessions, so nothing should be killed.
			return new Set();
		}
		const { store } = openSessionStore(overstoryDir);
		try {
			const allSessions = store.getAll();
			return new Set(allSessions.map((s) => s.tmuxSession));
		} finally {
			store.close();
		}
	} catch {
		// SessionStore is broken -- fall back to legacy behavior
		return null;
	}
}

/**
 * Remove all overstory worktrees (force remove with branch deletion).
 */
async function cleanAllWorktrees(root: string): Promise<number> {
	let cleaned = 0;
	try {
		const worktrees = await listWorktrees(root);
		const overstoryWts = worktrees.filter((wt) => wt.branch.startsWith("overstory/"));
		for (const wt of overstoryWts) {
			try {
				await removeWorktree(root, wt.path, { force: true, forceBranch: true });
				cleaned++;
			} catch {
				// Best effort
			}
		}
	} catch {
		// No worktrees or git error
	}
	return cleaned;
}

/**
 * Delete orphaned overstory/* branch refs not tied to a worktree.
 */
async function deleteOrphanedBranches(root: string): Promise<number> {
	let deleted = 0;
	try {
		const proc = Bun.spawn(
			["git", "for-each-ref", "refs/heads/overstory/", "--format=%(refname:short)"],
			{ cwd: root, stdout: "pipe", stderr: "pipe" },
		);
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;

		const branches = stdout
			.trim()
			.split("\n")
			.filter((b) => b.length > 0);
		for (const branch of branches) {
			try {
				const del = Bun.spawn(["git", "branch", "-D", branch], {
					cwd: root,
					stdout: "pipe",
					stderr: "pipe",
				});
				const exitCode = await del.exited;
				if (exitCode === 0) deleted++;
			} catch {
				// Best effort
			}
		}
	} catch {
		// Git error
	}
	return deleted;
}

/**
 * Delete a SQLite database file and its WAL/SHM companions.
 */
async function wipeSqliteDb(dbPath: string): Promise<boolean> {
	const extensions = ["", "-wal", "-shm"];
	let wiped = false;
	for (const ext of extensions) {
		try {
			await unlink(`${dbPath}${ext}`);
			if (ext === "") wiped = true;
		} catch {
			// File may not exist
		}
	}
	return wiped;
}

/**
 * Reset a JSON file to an empty array.
 */
async function resetJsonFile(path: string): Promise<boolean> {
	const file = Bun.file(path);
	if (await file.exists()) {
		await Bun.write(path, "[]\n");
		return true;
	}
	return false;
}

/**
 * Clear all entries inside a directory but keep the directory itself.
 */
async function clearDirectory(dirPath: string): Promise<boolean> {
	try {
		const entries = await readdir(dirPath);
		for (const entry of entries) {
			await rm(join(dirPath, entry), { recursive: true, force: true });
		}
		return entries.length > 0;
	} catch {
		// Directory may not exist
		return false;
	}
}

/**
 * Delete a single file if it exists.
 */
async function deleteFile(path: string): Promise<boolean> {
	try {
		await unlink(path);
		return true;
	} catch {
		return false;
	}
}

/**
 * Check mulch repository health and return diagnostic information.
 *
 * Governance limits warn threshold (based on mulch defaults):
 * - Max records per domain: 500 (warn at 400 = 80%)
 *
 * This is informational only — no data is modified.
 */
async function checkMulchHealth(repoRoot: string): Promise<{
	domainsNearLimit: Array<{ domain: string; recordCount: number; warnThreshold: number }>;
	stalePruneCandidates: number;
	doctorIssues: number;
	doctorWarnings: number;
} | null> {
	try {
		const mulch = createMulchClient(repoRoot);

		// 1. Check domain sizes against governance limits
		let status: MulchStatus;
		try {
			status = await mulch.status();
		} catch {
			// Mulch not available or no .mulch directory
			return null;
		}

		const warnThreshold = 400; // 80% of 500 max
		const domainsNearLimit = status.domains
			.filter((d) => d.recordCount >= warnThreshold)
			.map((d) => ({ domain: d.name, recordCount: d.recordCount, warnThreshold }));

		// 2. Run prune --dry-run to count stale records
		let pruneResult: MulchPruneResult;
		try {
			pruneResult = await mulch.prune({ dryRun: true });
		} catch {
			// Prune failed — skip this check
			pruneResult = { success: false, command: "prune", dryRun: true, totalPruned: 0, results: [] };
		}

		const stalePruneCandidates = pruneResult.totalPruned;

		// 3. Run doctor to check repository health
		let doctorResult: MulchDoctorResult;
		try {
			doctorResult = await mulch.doctor({ fix: false });
		} catch {
			// Doctor failed — skip this check
			doctorResult = {
				success: false,
				command: "doctor",
				checks: [],
				summary: { pass: 0, warn: 0, fail: 0 },
			};
		}

		const doctorIssues = doctorResult.summary.fail;
		const doctorWarnings = doctorResult.summary.warn;

		return {
			domainsNearLimit,
			stalePruneCandidates,
			doctorIssues,
			doctorWarnings,
		};
	} catch {
		// Mulch not available or other error — skip health checks
		return null;
	}
}

/**
 * Entry point for `ov clean [flags]`.
 *
 * @param opts - Command options
 */
export async function cleanCommand(opts: CleanOptions): Promise<void> {
	const json = opts.json ?? false;
	const all = opts.all ?? false;

	const doWorktrees = all || (opts.worktrees ?? false);
	const doBranches = all || (opts.branches ?? false);
	const doMail = all || (opts.mail ?? false);
	const doSessions = all || (opts.sessions ?? false);
	const doMetrics = all || (opts.metrics ?? false);
	const doLogs = all || (opts.logs ?? false);
	const doAgents = all || (opts.agents ?? false);
	const doSpecs = all || (opts.specs ?? false);

	const anySelected =
		doWorktrees || doBranches || doMail || doSessions || doMetrics || doLogs || doAgents || doSpecs;

	if (!anySelected) {
		throw new ValidationError(
			"No cleanup targets specified. Use --all for full cleanup, or individual flags (--mail, --sessions, --metrics, --logs, --worktrees, --branches, --agents, --specs).",
			{ field: "flags" },
		);
	}

	const config = await loadConfig(process.cwd());
	const root = config.project.root;
	const overstoryDir = join(root, ".overstory");

	const result: CleanResult = {
		sessionEndEventsLogged: 0,
		tmuxKilled: 0,
		worktreesCleaned: 0,
		branchesDeleted: 0,
		mailWiped: false,
		sessionsCleared: false,
		mergeQueueCleared: false,
		metricsWiped: false,
		logsCleared: false,
		agentsCleared: false,
		specsCleared: false,
		nudgeStateCleared: false,
		currentRunCleared: false,
		mulchHealth: null,
	};

	// 0. Run mulch health checks BEFORE cleanup operations (when --all is set).
	// This is informational only — no data is modified.
	if (all) {
		const healthCheck = await checkMulchHealth(root);
		if (healthCheck) {
			result.mulchHealth = {
				checked: true,
				domainsNearLimit: healthCheck.domainsNearLimit,
				stalePruneCandidates: healthCheck.stalePruneCandidates,
				doctorIssues: healthCheck.doctorIssues,
				doctorWarnings: healthCheck.doctorWarnings,
			};
		}
	}

	// 1. Log synthetic session-end events BEFORE killing tmux sessions.
	// When processes are killed externally, the Stop hook never fires,
	// so session_end events would be lost without this step.
	if (doWorktrees || all) {
		result.sessionEndEventsLogged = await logSyntheticSessionEndEvents(overstoryDir);
	}

	// 2. Kill tmux sessions (must happen before worktree removal)
	if (doWorktrees || all) {
		result.tmuxKilled = await killAllTmuxSessions(overstoryDir, config.project.name);
	}

	// 3. Remove worktrees
	if (doWorktrees) {
		result.worktreesCleaned = await cleanAllWorktrees(root);
	}

	// 4. Delete orphaned branches
	if (doBranches) {
		result.branchesDeleted = await deleteOrphanedBranches(root);
	}

	// 5. Wipe databases
	if (doMail) {
		result.mailWiped = await wipeSqliteDb(join(overstoryDir, "mail.db"));
	}
	if (doMetrics) {
		result.metricsWiped = await wipeSqliteDb(join(overstoryDir, "metrics.db"));
	}

	// 6. Wipe sessions.db + legacy sessions.json
	if (doSessions) {
		result.sessionsCleared = await wipeSqliteDb(join(overstoryDir, "sessions.db"));
		// Also clean legacy sessions.json if it still exists
		await resetJsonFile(join(overstoryDir, "sessions.json"));
	}
	if (all) {
		result.mergeQueueCleared = await wipeSqliteDb(join(overstoryDir, "merge-queue.db"));
	}

	// 7. Clear directories
	if (doLogs) {
		result.logsCleared = await clearDirectory(join(overstoryDir, "logs"));
	}
	if (doAgents) {
		result.agentsCleared = await clearDirectory(join(overstoryDir, "agents"));
	}
	if (doSpecs) {
		result.specsCleared = await clearDirectory(join(overstoryDir, "specs"));
	}

	// 8. Delete nudge state + pending nudge markers + current-run.txt
	if (all) {
		result.nudgeStateCleared = await deleteFile(join(overstoryDir, "nudge-state.json"));
		await clearDirectory(join(overstoryDir, "pending-nudges"));
		result.currentRunCleared = await deleteFile(join(overstoryDir, "current-run.txt"));
	}

	// Output
	if (json) {
		jsonOutput("clean", { ...result });
		return;
	}

	const lines: string[] = [];
	if (result.sessionEndEventsLogged > 0) {
		lines.push(
			`Logged ${result.sessionEndEventsLogged} synthetic session-end event${result.sessionEndEventsLogged === 1 ? "" : "s"}`,
		);
	}
	if (result.tmuxKilled > 0) {
		lines.push(`Killed ${result.tmuxKilled} tmux session${result.tmuxKilled === 1 ? "" : "s"}`);
	}
	if (result.worktreesCleaned > 0) {
		lines.push(
			`Removed ${result.worktreesCleaned} worktree${result.worktreesCleaned === 1 ? "" : "s"}`,
		);
	}
	if (result.branchesDeleted > 0) {
		lines.push(
			`Deleted ${result.branchesDeleted} orphaned branch${result.branchesDeleted === 1 ? "" : "es"}`,
		);
	}
	if (result.mailWiped) lines.push("Wiped mail.db");
	if (result.metricsWiped) lines.push("Wiped metrics.db");
	if (result.sessionsCleared) lines.push("Wiped sessions.db");
	if (result.mergeQueueCleared) lines.push("Wiped merge-queue.db");
	if (result.logsCleared) lines.push("Cleared logs/");
	if (result.agentsCleared) lines.push("Cleared agents/");
	if (result.specsCleared) lines.push("Cleared specs/");
	if (result.nudgeStateCleared) lines.push("Cleared nudge-state.json");
	if (result.currentRunCleared) lines.push("Cleared current-run.txt");

	// Mulch health diagnostics (shown before cleanup results)
	if (result.mulchHealth?.checked) {
		const health = result.mulchHealth;
		const healthLines: string[] = [];

		if (health.domainsNearLimit.length > 0) {
			healthLines.push("\nWarning: Mulch domains approaching governance limits:");
			for (const d of health.domainsNearLimit) {
				healthLines.push(
					`   ${d.domain}: ${d.recordCount} records (warn threshold: ${d.warnThreshold})`,
				);
			}
		}

		if (health.stalePruneCandidates > 0) {
			healthLines.push(
				`\nStale records found: ${health.stalePruneCandidates} candidate${health.stalePruneCandidates === 1 ? "" : "s"} (run 'mulch prune' to remove)`,
			);
		}

		if (health.doctorWarnings > 0 || health.doctorIssues > 0) {
			healthLines.push(
				`\nMulch health check: ${health.doctorWarnings} warning${health.doctorWarnings === 1 ? "" : "s"}, ${health.doctorIssues} issue${health.doctorIssues === 1 ? "" : "s"} (run 'mulch doctor' for details)`,
			);
		}

		if (healthLines.length > 0) {
			for (const line of healthLines) {
				process.stdout.write(`${line}\n`);
			}
		}
	}

	if (lines.length === 0) {
		printHint("Nothing to clean");
	} else {
		if (result.mulchHealth?.checked) {
			process.stdout.write("\n--- Cleanup Results ---\n");
		}
		for (const line of lines) {
			process.stdout.write(`${line}\n`);
		}
		printSuccess("Clean complete");
	}
}

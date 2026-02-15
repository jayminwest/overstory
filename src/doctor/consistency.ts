import { realpathSync } from "node:fs";
import { join } from "node:path";
import { openSessionStore } from "../sessions/compat.ts";
import type { AgentSession, OverstoryConfig } from "../types.ts";
import { listWorktrees } from "../worktree/manager.ts";
import { isProcessAlive, listSessions } from "../worktree/tmux.ts";
import type { DoctorCheck, DoctorCheckFn } from "./types.ts";

/**
 * Cross-subsystem consistency checks.
 * Validates SessionStore vs worktrees, tmux sessions vs sessions, etc.
 */
export const checkConsistency: DoctorCheckFn = async (
	config: OverstoryConfig,
	overstoryDir: string,
): Promise<DoctorCheck[]> => {
	const checks: DoctorCheck[] = [];

	// Gather data from all three sources
	let worktrees: Array<{ path: string; branch: string; head: string }> = [];
	let tmuxSessions: Array<{ name: string; pid: number }> = [];
	let storeSessions: AgentSession[] = [];

	// 1. List git worktrees
	try {
		worktrees = await listWorktrees(config.project.root);
	} catch (error) {
		checks.push({
			name: "worktree-listing",
			category: "consistency",
			status: "fail",
			message: "Failed to list git worktrees",
			details: [error instanceof Error ? error.message : String(error)],
		});
		// Can't continue consistency checks without worktree data
		return checks;
	}

	// 2. List tmux sessions
	try {
		tmuxSessions = await listSessions();
	} catch (error) {
		// Tmux not installed or not running is not necessarily a fatal error
		checks.push({
			name: "tmux-listing",
			category: "consistency",
			status: "warn",
			message: "Failed to list tmux sessions (tmux may not be installed)",
			details: [error instanceof Error ? error.message : String(error)],
		});
		// Continue with empty tmux session list
		tmuxSessions = [];
	}

	// 3. Open SessionStore and get all sessions
	let storeHandle: ReturnType<typeof openSessionStore>["store"] | null = null;
	try {
		const { store } = openSessionStore(overstoryDir);
		storeHandle = store;
		storeSessions = store.getAll();
	} catch (error) {
		checks.push({
			name: "sessionstore-open",
			category: "consistency",
			status: "fail",
			message: "Failed to open SessionStore",
			details: [error instanceof Error ? error.message : String(error)],
		});
		// Can't do consistency checks without SessionStore
		return checks;
	}

	// Now perform cross-validation checks

	// 4. Check for orphaned worktrees (worktree exists but no SessionStore entry)
	// Normalize all paths to handle symlinks like /tmp -> /private/tmp on macOS
	const worktreeBasePath = realpathSync(join(overstoryDir, "worktrees"));
	const overstoryWorktrees = worktrees.filter((wt) => wt.path.startsWith(worktreeBasePath));

	// Normalize SessionStore paths for comparison
	const storeWorktreePaths = new Set(
		storeSessions.map((s) => {
			try {
				return realpathSync(s.worktreePath);
			} catch {
				// Path doesn't exist, use as-is
				return s.worktreePath;
			}
		}),
	);

	const orphanedWorktrees = overstoryWorktrees.filter((wt) => !storeWorktreePaths.has(wt.path));

	if (orphanedWorktrees.length > 0) {
		checks.push({
			name: "orphaned-worktrees",
			category: "consistency",
			status: "warn",
			message: `Found ${orphanedWorktrees.length} orphaned worktree(s) with no SessionStore entry`,
			details: orphanedWorktrees.map((wt) => `${wt.path} (branch: ${wt.branch})`),
			fixable: true,
		});
	} else {
		checks.push({
			name: "orphaned-worktrees",
			category: "consistency",
			status: "pass",
			message: "No orphaned worktrees found",
		});
	}

	// 5. Check for orphaned tmux sessions (tmux session exists but no SessionStore entry)
	const projectName = config.project.name;
	const overstoryTmuxPrefix = `overstory-${projectName}-`;
	const overstoryTmuxSessions = tmuxSessions.filter((s) => s.name.startsWith(overstoryTmuxPrefix));
	const storeTmuxNames = new Set(storeSessions.map((s) => s.tmuxSession));

	const orphanedTmux = overstoryTmuxSessions.filter((s) => !storeTmuxNames.has(s.name));

	if (orphanedTmux.length > 0) {
		checks.push({
			name: "orphaned-tmux",
			category: "consistency",
			status: "warn",
			message: `Found ${orphanedTmux.length} orphaned tmux session(s) with no SessionStore entry`,
			details: orphanedTmux.map((s) => `${s.name} (pid: ${s.pid})`),
			fixable: true,
		});
	} else {
		checks.push({
			name: "orphaned-tmux",
			category: "consistency",
			status: "pass",
			message: "No orphaned tmux sessions found",
		});
	}

	// 6. Check for dead processes in SessionStore
	const deadSessions = storeSessions.filter((s) => s.pid !== null && !isProcessAlive(s.pid));

	if (deadSessions.length > 0) {
		checks.push({
			name: "dead-pids",
			category: "consistency",
			status: "warn",
			message: `Found ${deadSessions.length} session(s) with dead PIDs`,
			details: deadSessions.map((s) => `${s.agentName} (pid: ${s.pid}, state: ${s.state})`),
			fixable: true,
		});
	} else {
		checks.push({
			name: "dead-pids",
			category: "consistency",
			status: "pass",
			message: "All SessionStore PIDs are alive or null",
		});
	}

	// 7. Check for SessionStore entries with missing worktrees
	const existingWorktreePaths = new Set(worktrees.map((wt) => wt.path));
	const missingWorktrees = storeSessions.filter((s) => {
		// Try to normalize the SessionStore path for comparison
		try {
			const normalizedPath = realpathSync(s.worktreePath);
			return !existingWorktreePaths.has(normalizedPath);
		} catch {
			// Path doesn't exist or can't be resolved, check as-is
			return !existingWorktreePaths.has(s.worktreePath);
		}
	});

	if (missingWorktrees.length > 0) {
		checks.push({
			name: "missing-worktrees",
			category: "consistency",
			status: "warn",
			message: `Found ${missingWorktrees.length} session(s) with missing worktrees`,
			details: missingWorktrees.map((s) => `${s.agentName}: ${s.worktreePath}`),
			fixable: true,
		});
	} else {
		checks.push({
			name: "missing-worktrees",
			category: "consistency",
			status: "pass",
			message: "All SessionStore worktrees exist",
		});
	}

	// 8. Check for SessionStore entries with missing tmux sessions
	const existingTmuxNames = new Set(tmuxSessions.map((s) => s.name));
	const missingTmux = storeSessions.filter((s) => !existingTmuxNames.has(s.tmuxSession));

	if (missingTmux.length > 0) {
		checks.push({
			name: "missing-tmux",
			category: "consistency",
			status: "warn",
			message: `Found ${missingTmux.length} session(s) with missing tmux sessions`,
			details: missingTmux.map((s) => `${s.agentName}: ${s.tmuxSession}`),
			fixable: true,
		});
	} else {
		checks.push({
			name: "missing-tmux",
			category: "consistency",
			status: "pass",
			message: "All SessionStore tmux sessions exist",
		});
	}

	// Close the SessionStore
	if (storeHandle) {
		storeHandle.close();
	}

	return checks;
};

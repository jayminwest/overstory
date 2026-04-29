/**
 * CLI command: ov stop <agent-name>
 *
 * Explicitly terminates a running agent by:
 * 1. Looking up the agent session by name
 * 2a. For TUI agents: killing its tmux session (if alive)
 * 2b. For headless agents (tmuxSession === ''): sending SIGTERM to the process tree
 * 3. Marking it as completed in the SessionStore
 * 4. Optionally removing its worktree and branch (--clean-worktree)
 *
 * Completed agents: ov stop <name> without --clean-worktree throws a helpful error.
 * With --clean-worktree, completed agents skip the kill step and proceed to cleanup.
 */

import { join } from "node:path";
import { removeAgentFifo } from "../agents/headless-stdin.ts";
import { loadConfig } from "../config.ts";
import { AgentError, ValidationError } from "../errors.ts";
import { jsonOutput } from "../json.ts";
import { printSuccess, printWarning } from "../logging/color.ts";
import { openSessionStore } from "../sessions/compat.ts";
import { removeWorktree } from "../worktree/manager.ts";
import { isProcessAlive, isSessionAlive, killProcessTree, killSession } from "../worktree/tmux.ts";

export interface StopOptions {
	force?: boolean;
	cleanWorktree?: boolean;
	json?: boolean;
}

/** Dependency injection for testing. Uses real implementations when omitted. */
export interface StopDeps {
	_tmux?: {
		isSessionAlive: (name: string) => Promise<boolean>;
		killSession: (name: string) => Promise<void>;
	};
	_worktree?: {
		remove: (
			repoRoot: string,
			path: string,
			options?: { force?: boolean; forceBranch?: boolean },
		) => Promise<void>;
	};
	_process?: {
		isAlive: (pid: number) => boolean;
		killTree: (pid: number) => Promise<void>;
	};
	_git?: {
		deleteBranch: (repoRoot: string, branch: string) => Promise<boolean>;
	};
}

/** Delete a git branch (best-effort, non-fatal). */
async function deleteBranchBestEffort(repoRoot: string, branch: string): Promise<boolean> {
	try {
		const proc = Bun.spawn(["git", "branch", "-D", branch], {
			cwd: repoRoot,
			stdout: "pipe",
			stderr: "pipe",
		});
		const exitCode = await proc.exited;
		return exitCode === 0;
	} catch {
		return false;
	}
}

/**
 * Entry point for `ov stop <agent-name>`.
 *
 * @param agentName - Name of the agent to stop
 * @param opts - Command options
 * @param deps - Optional dependency injection for testing (tmux, worktree, process, git)
 */
export async function stopCommand(
	agentName: string,
	opts: StopOptions,
	deps: StopDeps = {},
): Promise<void> {
	if (!agentName || agentName.trim().length === 0) {
		throw new ValidationError("Missing required argument: <agent-name>", {
			field: "agentName",
			value: "",
		});
	}

	const json = opts.json ?? false;
	const force = opts.force ?? false;
	const cleanWorktree = opts.cleanWorktree ?? false;

	const tmux = deps._tmux ?? { isSessionAlive, killSession };
	const worktree = deps._worktree ?? { remove: removeWorktree };
	const proc = deps._process ?? { isAlive: isProcessAlive, killTree: killProcessTree };
	const git = deps._git ?? { deleteBranch: deleteBranchBestEffort };

	const cwd = process.cwd();
	const config = await loadConfig(cwd);
	const projectRoot = config.project.root;
	const overstoryDir = join(projectRoot, ".overstory");

	const { store } = openSessionStore(overstoryDir);
	try {
		const session = store.getByName(agentName);
		if (!session) {
			throw new AgentError(`Agent "${agentName}" not found`, { agentName });
		}

		const isAlreadyCompleted = session.state === "completed";

		// Completed agents without --clean-worktree: throw with helpful message
		if (isAlreadyCompleted && !cleanWorktree) {
			throw new AgentError(
				`Agent "${agentName}" is already completed. Use --clean-worktree to remove its worktree.`,
				{ agentName },
			);
		}

		const isZombie = session.state === "zombie";
		const isHeadless = session.tmuxSession === "" && session.pid !== null;

		let tmuxKilled = false;
		let pidKilled = false;

		// Skip kill operations for already-completed agents (process/tmux already gone)
		if (!isAlreadyCompleted) {
			if (isHeadless && session.pid !== null) {
				// Headless agent: kill via process tree instead of tmux
				const alive = proc.isAlive(session.pid);
				if (alive) {
					await proc.killTree(session.pid);
					pidKilled = true;
				}
			} else {
				// TUI agent: kill via tmux session
				const alive = await tmux.isSessionAlive(session.tmuxSession);
				if (alive) {
					await tmux.killSession(session.tmuxSession);
					tmuxKilled = true;
				}
			}

			// Mark session as completed
			store.updateState(agentName, "completed");
			store.updateLastActivity(agentName);

			// Reap the per-agent stdin FIFO. Headless agents spawned via ov sling
			// own a FIFO under .overstory/agents/<name>/stdin.fifo for cross-process
			// signal delivery; once we kill the agent it is no longer reading and
			// the file should be removed so ov serve's mail injector can drop the
			// loop. Idempotent and safe for tmux agents (no-op if FIFO absent).
			removeAgentFifo(overstoryDir, agentName);

			// Auto-nudge coordinator when a lead truly completes so it wakes up
			// to process merge_ready / worker_done messages without waiting for
			// user input. Fires from `ov stop` (real completion signal) rather
			// than the per-turn Stop hook, which was spamming the coordinator
			// (overstory-49a7).
			if (session.capability === "lead") {
				try {
					const nudgesDir = join(overstoryDir, "pending-nudges");
					const { mkdir } = await import("node:fs/promises");
					await mkdir(nudgesDir, { recursive: true });
					const markerPath = join(nudgesDir, "coordinator.json");
					const marker = {
						from: agentName,
						reason: "lead_completed",
						subject: `Lead ${agentName} completed — check mail for merge_ready/worker_done`,
						messageId: `auto-nudge-${agentName}-${Date.now()}`,
						createdAt: new Date().toISOString(),
					};
					await Bun.write(markerPath, `${JSON.stringify(marker, null, "\t")}\n`);
				} catch {
					// Non-fatal: nudge failure should not break stop
				}
			}
		}

		// Optionally remove worktree and branch (best-effort, non-fatal)
		let worktreeRemoved = false;
		let branchDeleted = false;
		if (cleanWorktree) {
			if (session.worktreePath) {
				try {
					await worktree.remove(projectRoot, session.worktreePath, {
						force,
						forceBranch: false,
					});
					worktreeRemoved = true;
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					if (!json) printWarning("Failed to remove worktree", msg);
				}
			}

			// Delete the branch after removing the worktree (best-effort, non-fatal)
			if (session.branchName) {
				try {
					branchDeleted = await git.deleteBranch(projectRoot, session.branchName);
				} catch {
					branchDeleted = false;
				}
			}
		}

		if (json) {
			jsonOutput("stop", {
				stopped: true,
				agentName,
				sessionId: session.id,
				capability: session.capability,
				tmuxKilled,
				pidKilled,
				worktreeRemoved,
				branchDeleted,
				force,
				wasZombie: isZombie,
				wasCompleted: isAlreadyCompleted,
			});
		} else {
			printSuccess("Agent stopped", agentName);
			if (!isAlreadyCompleted) {
				if (isHeadless) {
					if (pidKilled) {
						process.stdout.write(`  Process tree killed: PID ${session.pid}\n`);
					} else {
						process.stdout.write(`  Process was already dead (PID ${session.pid})\n`);
					}
				} else {
					if (tmuxKilled) {
						process.stdout.write(`  Tmux session killed: ${session.tmuxSession}\n`);
					} else {
						process.stdout.write(`  Tmux session was already dead\n`);
					}
				}
			}
			if (isZombie) {
				process.stdout.write(`  Zombie agent cleaned up (state → completed)\n`);
			}
			if (isAlreadyCompleted) {
				process.stdout.write(`  Agent was already completed (skipped kill)\n`);
			}
			if (cleanWorktree && worktreeRemoved) {
				process.stdout.write(`  Worktree removed: ${session.worktreePath}\n`);
			}
			if (cleanWorktree && branchDeleted) {
				process.stdout.write(`  Branch deleted: ${session.branchName}\n`);
			}
		}
	} finally {
		store.close();
	}
}

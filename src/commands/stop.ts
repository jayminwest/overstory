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

import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "../config.ts";
import { AgentError, ValidationError } from "../errors.ts";
import { jsonOutput } from "../json.ts";
import { printSuccess, printWarning } from "../logging/color.ts";
import { createMailStore } from "../mail/store.ts";
import { openSessionStore } from "../sessions/compat.ts";
import type { MergeReadyPayload } from "../types.ts";
import { readPidFile } from "../utils/pid.ts";
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

/**
 * Build the lead_completed nudge subject based on whether the lead actually sent
 * merge_ready before exiting (overstory-41fe). The merge_ready close-gate
 * (commit 3e21338) prevents leads from running `sd close` without it, but a
 * lead can still exit (process termination, watchdog kill, manual `ov stop`)
 * without ever having sent one. The coordinator's surfacing of this nudge
 * needs to distinguish those two cases.
 */
function buildLeadCompletedSubject(agentName: string, mailDbPath: string): string {
	let mergeReadyBranches: string[] = [];
	let mergeReadyCount = 0;
	try {
		const store = createMailStore(mailDbPath);
		try {
			const messages = store.getAll({ from: agentName, type: "merge_ready" });
			mergeReadyCount = messages.length;
			for (const msg of messages) {
				if (msg.payload === null) continue;
				try {
					const parsed = JSON.parse(msg.payload) as Partial<MergeReadyPayload>;
					if (typeof parsed.branch === "string" && parsed.branch.length > 0) {
						mergeReadyBranches.push(parsed.branch);
					}
				} catch {
					// Skip messages with unparseable payloads
				}
			}
		} finally {
			store.close();
		}
	} catch {
		// If the mail store can't be opened (corrupt db, permissions), fall back
		// to the historical ambiguous phrasing rather than blocking the stop.
		return `Lead ${agentName} completed — check mail for merge_ready/worker_done`;
	}

	if (mergeReadyCount === 0) {
		return `Lead ${agentName} exited — no merge_ready sent, needs coordinator follow-up`;
	}
	// Dedupe in case a lead resent merge_ready for the same branch
	mergeReadyBranches = Array.from(new Set(mergeReadyBranches));
	if (mergeReadyBranches.length === 0) {
		return `Lead ${agentName} sent ${mergeReadyCount} merge_ready (branch unknown)`;
	}
	if (mergeReadyBranches.length === 1) {
		return `Lead ${agentName} sent merge_ready for branch ${mergeReadyBranches[0]}`;
	}
	return `Lead ${agentName} sent ${mergeReadyBranches.length} merge_ready (branches: ${mergeReadyBranches.join(", ")})`;
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
		// Headless task-scoped agents (Phase 3 spawn-per-turn): tmuxSession is ""
		// and session.pid is null between turns. The live PID for an in-flight
		// turn is published at .overstory/agents/<name>/turn.pid. Sapling RPC
		// agents still use session.pid for their long-lived process.
		const isHeadless = session.tmuxSession === "";
		const turnPidPath = join(overstoryDir, "agents", agentName, "turn.pid");

		let tmuxKilled = false;
		let pidKilled = false;

		// Skip kill operations for already-completed agents (process/tmux already gone)
		if (!isAlreadyCompleted) {
			if (isHeadless) {
				// Prefer the per-turn PID file (Phase 3) — this catches an in-flight
				// claude turn for any task-scoped capability. Fall back to the
				// session row's pid for legacy/long-lived headless runtimes (Sapling).
				const turnPid = await readPidFile(turnPidPath);
				const targetPid = turnPid ?? session.pid;
				if (targetPid !== null && proc.isAlive(targetPid)) {
					await proc.killTree(targetPid);
					pidKilled = true;
				}
				// Reap the turn.pid file so a subsequent ov stop / mail injector
				// doesn't see a stale entry. Idempotent.
				try {
					await unlink(turnPidPath);
				} catch {
					// already gone — non-fatal
				}
			} else {
				// TUI agent: kill via tmux session
				const alive = await tmux.isSessionAlive(session.tmuxSession);
				if (alive) {
					await tmux.killSession(session.tmuxSession);
					tmuxKilled = true;
				}
			}

			// Mark session as completed via the guarded transition. `completed` is
			// reachable from every non-completed state (including zombie, so `ov
			// stop` can promote a watchdog-flagged zombie to a clean completion),
			// so the only way this rejects is if state is already `completed` —
			// which is the no-op we want anyway. Race-safe under overstory-a993.
			store.tryTransitionState(agentName, "completed");
			store.updateLastActivity(agentName);

			// Auto-nudge coordinator when a lead truly completes so it wakes up
			// to process merge_ready / worker_done messages without waiting for
			// user input. Fires from `ov stop` (real completion signal) rather
			// than the per-turn Stop hook, which was spamming the coordinator
			// (overstory-49a7).
			if (session.capability === "lead") {
				try {
					const mailDbPath = join(overstoryDir, "mail.db");
					const subject = buildLeadCompletedSubject(agentName, mailDbPath);
					const nudgesDir = join(overstoryDir, "pending-nudges");
					const { mkdir } = await import("node:fs/promises");
					await mkdir(nudgesDir, { recursive: true });
					const markerPath = join(nudgesDir, "coordinator.json");
					const marker = {
						from: agentName,
						reason: "lead_completed",
						subject,
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

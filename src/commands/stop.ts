/**
 * CLI command: ov stop <agent-name>
 *
 * Explicitly terminates a running agent by:
 * 1. Looking up the agent session by name
 * 2. Killing its tmux session (if alive)
 * 3. Marking it as completed in the SessionStore
 * 4. Optionally removing its worktree (--clean-worktree)
 */

import { join } from "node:path";
import { loadConfig } from "../config.ts";
import { AgentError, ValidationError } from "../errors.ts";
import { jsonOutput } from "../json.ts";
import { printSuccess, printWarning } from "../logging/color.ts";
import { openSessionStore } from "../sessions/compat.ts";
import { resolveContext } from "../workspace/resolver.ts";
import { removeWorktree } from "../worktree/manager.ts";
import { isSessionAlive, killSession } from "../worktree/tmux.ts";

export interface StopOptions {
	force?: boolean;
	cleanWorktree?: boolean;
	json?: boolean;
	project?: string;
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
}

/**
 * Entry point for `ov stop <agent-name>`.
 *
 * @param agentName - Name of the agent to stop
 * @param opts - Command options
 * @param deps - Optional dependency injection for testing (tmux, worktree)
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

	const cwd = process.cwd();
	await loadConfig(cwd);
	const ctx = await resolveContext({ project: opts.project });
	const projectRoot = ctx.projectRoot;

	const { store } = openSessionStore(ctx.dbRoot);
	try {
		const session = store.getByName(agentName);
		if (!session) {
			throw new AgentError(`Agent "${agentName}" not found`, { agentName });
		}

		if (session.state === "completed") {
			throw new AgentError(`Agent "${agentName}" is already completed`, { agentName });
		}

		if (session.state === "zombie") {
			throw new AgentError(`Agent "${agentName}" is already zombie (dead)`, { agentName });
		}

		// Kill tmux session if alive
		const alive = await tmux.isSessionAlive(session.tmuxSession);
		if (alive) {
			await tmux.killSession(session.tmuxSession);
		}

		// Mark session as completed
		store.updateState(agentName, "completed");
		store.updateLastActivity(agentName);

		// Optionally remove worktree (best-effort, non-fatal)
		let worktreeRemoved = false;
		if (cleanWorktree && session.worktreePath) {
			try {
				await worktree.remove(projectRoot, session.worktreePath, {
					force,
					forceBranch: force,
				});
				worktreeRemoved = true;
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				if (!json) printWarning("Failed to remove worktree", msg);
			}
		}

		if (json) {
			jsonOutput("stop", {
				stopped: true,
				agentName,
				sessionId: session.id,
				capability: session.capability,
				tmuxKilled: alive,
				worktreeRemoved,
				force,
			});
		} else {
			printSuccess("Agent stopped", agentName);
			if (alive) {
				process.stdout.write(`  Tmux session killed: ${session.tmuxSession}\n`);
			} else {
				process.stdout.write(`  Tmux session was already dead\n`);
			}
			if (cleanWorktree && worktreeRemoved) {
				process.stdout.write(`  Worktree removed: ${session.worktreePath}\n`);
			}
		}
	} finally {
		store.close();
	}
}

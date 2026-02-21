/**
 * CLI command: overstory stop <agent-name>
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
import { openSessionStore } from "../sessions/compat.ts";
import { removeWorktree } from "../worktree/manager.ts";
import { isSessionAlive, killSession } from "../worktree/tmux.ts";

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

const STOP_HELP = `overstory stop — Terminate a running agent

Usage: overstory stop <agent-name> [flags]

Arguments:
  <agent-name>          Name of the agent to stop

Options:
  --force               Force kill and force-delete branch when cleaning worktree
  --clean-worktree      Remove the agent's worktree after stopping
  --json                Output as JSON
  --help, -h            Show this help

Examples:
  overstory stop my-builder
  overstory stop my-builder --clean-worktree
  overstory stop my-builder --clean-worktree --force
  overstory stop my-builder --json`;

/**
 * Entry point for `overstory stop <agent-name>`.
 *
 * @param args - CLI arguments after "stop"
 * @param deps - Optional dependency injection for testing (tmux, worktree)
 */
export async function stopCommand(args: string[], deps: StopDeps = {}): Promise<void> {
	if (args.includes("--help") || args.includes("-h")) {
		process.stdout.write(`${STOP_HELP}\n`);
		return;
	}

	const json = args.includes("--json");
	const force = args.includes("--force");
	const cleanWorktree = args.includes("--clean-worktree");

	// First non-flag arg is the agent name
	const agentName = args.find((a) => !a.startsWith("-"));
	if (!agentName) {
		throw new ValidationError("Missing required argument: <agent-name>", {
			field: "agentName",
			value: "",
		});
	}

	const tmux = deps._tmux ?? { isSessionAlive, killSession };
	const worktree = deps._worktree ?? { remove: removeWorktree };

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
				process.stderr.write(`Warning: failed to remove worktree: ${msg}\n`);
			}
		}

		if (json) {
			process.stdout.write(
				`${JSON.stringify({
					stopped: true,
					agentName,
					sessionId: session.id,
					capability: session.capability,
					tmuxKilled: alive,
					worktreeRemoved,
					force,
				})}\n`,
			);
		} else {
			process.stdout.write(`Agent "${agentName}" stopped (session: ${session.id})\n`);
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

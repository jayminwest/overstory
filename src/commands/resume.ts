/**
 * CLI command: ov resume [agent-name]
 *
 * Resumes interrupted agent sessions by recreating tmux sessions.
 * For Claude Code agents, uses `--resume <session-id>` to restore
 * full conversation context from the JSONL transcript store.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import { loadConfig } from "../config.ts";
import { jsonOutput } from "../json.ts";
import { printSuccess, printWarning } from "../logging/color.ts";
import { formatRelativeTime } from "../logging/format.ts";
import { getRuntime } from "../runtimes/registry.ts";
import { openSessionStore } from "../sessions/compat.ts";
import type { AgentSession, OverstoryConfig } from "../types.ts";
import { createSession, listSessions } from "../worktree/tmux.ts";

export function createResumeCommand(): Command {
	return new Command("resume")
		.description("Resume interrupted agent sessions")
		.argument("[agent-name]", "Resume a specific agent (default: all)")
		.option("--list", "List resumable sessions without resuming")
		.option("--json", "JSON output")
		.action(async (agentName: string | undefined, opts: { list?: boolean; json?: boolean }) => {
			await resumeCommand(agentName, opts);
		});
}

async function resumeCommand(
	agentName: string | undefined,
	opts: { list?: boolean; json?: boolean },
): Promise<void> {
	const json = opts.json ?? false;
	const config = await loadConfig(process.cwd());
	const root = config.project.root;
	const overstoryDir = join(root, ".overstory");

	const { store } = openSessionStore(overstoryDir);
	try {
		const allResumable = store.getResumable();

		// Filter to sessions with dead tmux + existing worktree
		const aliveSessions = new Set((await listSessions()).map((s) => s.name));

		const resumable = allResumable.filter((s) => {
			if (aliveSessions.has(s.tmuxSession)) return false;
			if (!existsSync(s.worktreePath)) return false;
			if (agentName && s.agentName !== agentName) return false;
			return true;
		});

		if (opts.list) {
			if (json) {
				jsonOutput("resume", {
					resumable: resumable.map((s) => ({
						agentName: s.agentName,
						taskId: s.taskId,
						runtime: s.runtime ?? "claude",
						lastActivity: s.lastActivity,
						branchName: s.branchName,
						state: s.state,
					})),
				});
				return;
			}

			if (resumable.length === 0) {
				printWarning("No resumable sessions found.");
				return;
			}

			console.log("Resumable sessions:\n");
			console.log(
				"  %-24s %-14s %-10s %-14s %s",
				"Agent",
				"Task",
				"Runtime",
				"Interrupted",
				"Branch",
			);
			for (const s of resumable) {
				console.log(
					"  %-24s %-14s %-10s %-14s %s",
					s.agentName,
					s.taskId,
					s.runtime ?? "claude",
					formatRelativeTime(s.lastActivity),
					s.branchName,
				);
			}
			return;
		}

		if (resumable.length === 0) {
			if (agentName) {
				printWarning(`No resumable session found for agent '${agentName}'.`);
			} else {
				printWarning("No sessions to resume.");
			}
			return;
		}

		const results: Array<{ agentName: string; success: boolean; error?: string }> = [];

		for (const session of resumable) {
			try {
				await resumeAgent(session, config, root);
				results.push({ agentName: session.agentName, success: true });
				if (!json) {
					printSuccess(`Resumed ${session.agentName}`, session.id);
				}
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				results.push({ agentName: session.agentName, success: false, error: msg });
				if (!json) {
					printWarning(`Failed to resume ${session.agentName}: ${msg}`);
				}
			}
		}

		if (json) {
			jsonOutput("resume", { results });
		}
	} finally {
		store.close();
	}
}

async function resumeAgent(
	session: AgentSession,
	config: OverstoryConfig,
	root: string,
): Promise<void> {
	const runtime = getRuntime(session.runtime ?? "claude", config, session.capability);
	const overstoryDir = join(root, ".overstory");

	const env: Record<string, string> = {
		...runtime.buildEnv({ model: "default", env: {} }),
		OVERSTORY_AGENT_NAME: session.agentName,
		OVERSTORY_WORKTREE_PATH: session.worktreePath,
	};

	const spawnCmd = runtime.buildSpawnCommand({
		model: config.runtime?.default === runtime.id ? "default" : "default",
		permissionMode: "bypass",
		cwd: session.worktreePath,
		env,
		resumeSessionId: session.id,
	});

	const pid = await createSession(session.tmuxSession, session.worktreePath, spawnCmd, env);

	const { store } = openSessionStore(overstoryDir);
	try {
		store.upsert({
			...session,
			pid,
			state: "booting",
			lastActivity: new Date().toISOString(),
			escalationLevel: 0,
			stalledSince: null,
		});
	} finally {
		store.close();
	}
}

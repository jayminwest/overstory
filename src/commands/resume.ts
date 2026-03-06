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
import { createSession, listSessions, sendKeys, waitForTuiReady } from "../worktree/tmux.ts";

export function createResumeCommand(): Command {
	return new Command("resume")
		.description("Resume interrupted agent sessions")
		.argument("[agent-name]", "Resume a specific agent (default: all)")
		.option("--list", "List resumable sessions without resuming")
		.option("--json", "JSON output")
		.action(async (agentName: string | undefined, _opts: unknown, cmd: Command) => {
			await resumeCommand(agentName, cmd.optsWithGlobals());
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

			const pad = (str: string, len: number) => str.padEnd(len);
			console.log("Resumable sessions:\n");
			console.log(
				`  ${pad("Agent", 24)} ${pad("Task", 14)} ${pad("Runtime", 10)} ${pad("Interrupted", 14)} Branch`,
			);
			for (const s of resumable) {
				console.log(
					`  ${pad(s.agentName, 24)} ${pad(s.taskId, 14)} ${pad(s.runtime ?? "claude", 10)} ${pad(formatRelativeTime(s.lastActivity), 14)} ${s.branchName}`,
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

		// Resume all agents in parallel — each waits for TUI ready independently
		const promises = resumable.map(async (session) => {
			try {
				await resumeAgent(session, config, root);
				return { agentName: session.agentName, success: true } as const;
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return { agentName: session.agentName, success: false, error: msg } as const;
			}
		});

		const results = await Promise.all(promises);

		for (const r of results) {
			if (json) continue;
			if (r.success) {
				printSuccess(`Resumed ${r.agentName}`);
			} else {
				printWarning(`Failed to resume ${r.agentName}: ${r.error}`);
			}
		}

		if (json) {
			jsonOutput("resume", { results });
		}
	} finally {
		store.close();
	}
}

/**
 * Build a resume nudge message for a restarted agent.
 * Tells the agent it was interrupted and gives it a recovery protocol.
 */
function buildResumeNudge(session: AgentSession): string {
	const parts = [
		`[OVERSTORY RESUME] ${session.agentName} (${session.capability}) — session restored after interruption.`,
		`Recovery: check git status, run ov mail check --agent ${session.agentName}, then continue task ${session.taskId}.`,
	];
	return parts.join(" ");
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

	// Update session store immediately so hooks can find the entry
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

	// Wait for TUI to be ready, then send resume nudge
	const ready = await waitForTuiReady(session.tmuxSession, (content) =>
		runtime.detectReady(content),
	);
	if (ready) {
		await Bun.sleep(1_000);
		const nudge = buildResumeNudge(session);
		await sendKeys(session.tmuxSession, nudge);
		// Follow-up Enter to ensure submission
		await Bun.sleep(1_000);
		await sendKeys(session.tmuxSession, "");
	}
}

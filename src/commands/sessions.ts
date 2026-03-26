/**
 * CLI command: ov sessions <subcommand>
 *
 * Manage overstory-managed tmux sessions through the project's isolated
 * tmux socket. This provides a user-facing roof over list/attach/kill
 * without requiring direct `tmux -S ...` usage.
 */

import { join } from "node:path";
import { Command } from "commander";
import { loadConfig } from "../config.ts";
import { jsonOutput } from "../json.ts";
import { accent, muted, printError, printHint, printSuccess } from "../logging/color.ts";
import { openSessionStore } from "../sessions/compat.ts";
import type { AgentSession } from "../types.ts";
import {
	buildProjectTmuxCliArgs,
	getCurrentSessionName,
	isSessionAlive,
	killSession,
} from "../worktree/tmux.ts";

function attachableSessions(sessions: readonly AgentSession[]): AgentSession[] {
	return sessions.filter((session) => session.tmuxSession.trim().length > 0);
}

function listSessionHints(sessions: readonly AgentSession[]): void {
	if (sessions.length === 0) {
		printHint("No attachable tmux sessions found.");
		return;
	}

	printHint("Attachable sessions:");
	for (const session of sessions) {
		console.log(
			`  ${accent(session.agentName)} -> ${session.tmuxSession} ${muted(`(${session.capability}, ${session.state})`)}`,
		);
	}
}

function resolveTargetSession(
	sessions: readonly AgentSession[],
	requested?: string,
): { session: AgentSession | null; reason?: "ambiguous" | "missing" } {
	if (requested) {
		const match =
			sessions.find((session) => session.agentName === requested) ??
			sessions.find((session) => session.tmuxSession === requested) ??
			null;
		return { session: match, reason: match ? undefined : "missing" };
	}

	const coordinator = sessions.find((session) => session.agentName === "coordinator");
	if (coordinator) {
		return { session: coordinator };
	}

	const monitor = sessions.find((session) => session.agentName === "monitor");
	if (monitor) {
		return { session: monitor };
	}

	if (sessions.length === 1) {
		return { session: sessions[0] ?? null };
	}

	return { session: null, reason: sessions.length === 0 ? "missing" : "ambiguous" };
}

async function loadAttachableSessions(
	projectRoot: string,
	includeAll = false,
): Promise<AgentSession[]> {
	const overstoryDir = join(projectRoot, ".overstory");
	const { store } = openSessionStore(overstoryDir);
	try {
		return attachableSessions(includeAll ? store.getAll() : store.getActive());
	} finally {
		store.close();
	}
}

async function attachToSession(
	projectRoot: string,
	sessions: readonly AgentSession[],
	agent: string | undefined,
	json: boolean,
): Promise<void> {
	const resolved = resolveTargetSession(sessions, agent);

	if (!resolved.session) {
		if (json) {
			jsonOutput("sessions attach", {
				ok: false,
				reason: resolved.reason ?? "missing",
				requested: agent ?? null,
				sessions: sessions.map((session) => ({
					agentName: session.agentName,
					tmuxSession: session.tmuxSession,
					capability: session.capability,
					state: session.state,
				})),
			});
			process.exitCode = 1;
			return;
		}

		if (resolved.reason === "ambiguous") {
			printError("Multiple attachable sessions found", "pass an agent name");
		} else {
			printError("No matching attachable session found", agent);
		}
		listSessionHints(sessions);
		process.exitCode = 1;
		return;
	}

	const alive = await isSessionAlive(resolved.session.tmuxSession);
	if (!alive) {
		if (json) {
			jsonOutput("sessions attach", {
				ok: false,
				reason: "dead",
				agentName: resolved.session.agentName,
				tmuxSession: resolved.session.tmuxSession,
			});
			process.exitCode = 1;
			return;
		}

		printError(
			"tmux session is not alive",
			`${resolved.session.agentName} -> ${resolved.session.tmuxSession}`,
		);
		process.exitCode = 1;
		return;
	}

	if (json) {
		jsonOutput("sessions attach", {
			ok: true,
			agentName: resolved.session.agentName,
			tmuxSession: resolved.session.tmuxSession,
		});
		return;
	}

	printSuccess(`Attaching to ${resolved.session.agentName}`, resolved.session.tmuxSession);
	Bun.spawnSync(
		buildProjectTmuxCliArgs(["attach-session", "-t", resolved.session.tmuxSession], projectRoot),
		{
			stdio: ["inherit", "inherit", "inherit"],
		},
	);
}

export function createSessionsCommand(): Command {
	const cmd = new Command("sessions").description("Manage isolated overstory tmux sessions");

	cmd
		.command("list")
		.alias("ls")
		.description("List overstory-managed tmux sessions")
		.option("--all", "Include completed and zombie sessions")
		.option("--json", "Output as JSON")
		.action(async (opts: { all?: boolean; json?: boolean }) => {
			const config = await loadConfig(process.cwd());
			const projectRoot = config.project.root;
			const sessions = await loadAttachableSessions(projectRoot, opts.all ?? false);
			const rows = await Promise.all(
				sessions.map(async (session) => ({
					agentName: session.agentName,
					tmuxSession: session.tmuxSession,
					capability: session.capability,
					state: session.state,
					alive: await isSessionAlive(session.tmuxSession),
				})),
			);

			if (opts.json) {
				jsonOutput("sessions list", { sessions: rows });
				return;
			}

			if (rows.length === 0) {
				printHint("No attachable tmux sessions found.");
				return;
			}

			for (const row of rows) {
				console.log(
					`${accent(row.agentName)} -> ${row.tmuxSession} ${muted(`(${row.capability}, ${row.state}, ${row.alive ? "alive" : "dead"})`)}`,
				);
			}
		});

	cmd
		.command("attach")
		.description("Attach to an active overstory tmux session")
		.argument("[agent]", "Agent name or tmux session name")
		.option("--json", "Output as JSON")
		.action(async (agent: string | undefined, opts: { json?: boolean }) => {
			const config = await loadConfig(process.cwd());
			const projectRoot = config.project.root;
			const sessions = await loadAttachableSessions(projectRoot, false);
			await attachToSession(projectRoot, sessions, agent, opts.json ?? false);
		});

	cmd
		.command("kill")
		.description("Kill an overstory tmux session by agent or session name")
		.argument("<agent>", "Agent name or tmux session name")
		.option("--json", "Output as JSON")
		.action(async (agent: string, opts: { json?: boolean }) => {
			const config = await loadConfig(process.cwd());
			const projectRoot = config.project.root;
			const sessions = await loadAttachableSessions(projectRoot, true);
			const resolved = resolveTargetSession(sessions, agent);

			if (!resolved.session) {
				if (opts.json) {
					jsonOutput("sessions kill", {
						ok: false,
						reason: resolved.reason ?? "missing",
						requested: agent,
					});
				} else {
					printError("No matching attachable session found", agent);
				}
				process.exitCode = 1;
				return;
			}

			await killSession(resolved.session.tmuxSession);
			if (opts.json) {
				jsonOutput("sessions kill", {
					ok: true,
					agentName: resolved.session.agentName,
					tmuxSession: resolved.session.tmuxSession,
				});
			} else {
				printSuccess(`Killed ${resolved.session.agentName}`, resolved.session.tmuxSession);
			}
		});

	cmd
		.command("current")
		.description("Print the current tmux session name when inside overstory tmux")
		.option("--json", "Output as JSON")
		.action(async (opts: { json?: boolean }) => {
			const sessionName = await getCurrentSessionName();
			if (opts.json) {
				jsonOutput("sessions current", { tmuxSession: sessionName });
				if (!sessionName) process.exitCode = 1;
				return;
			}
			if (!sessionName) {
				printError("Not running inside a tmux session");
				process.exitCode = 1;
				return;
			}
			process.stdout.write(`${sessionName}\n`);
		});

	return cmd;
}

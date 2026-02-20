/**
 * CLI command: overstory supervisor start|stop|status
 *
 * Manages per-project supervisor agent lifecycle. The supervisor is a persistent
 * agent that runs at the project root (NOT in a worktree), assigned to a specific
 * bead task, and operates at depth 1 (between coordinator and leaf workers).
 *
 * Unlike the coordinator:
 * - Has a bead assignment (required via --task flag)
 * - Has a parent agent (typically "coordinator")
 * - Has depth 1 (default)
 * - Multiple supervisors can run concurrently (distinguished by --name)
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { deployHooks } from "../agents/hooks-deployer.ts";
import { createIdentity, loadIdentity } from "../agents/identity.ts";
import { createManifestLoader, resolveModel } from "../agents/manifest.ts";
import { createBeadsClient } from "../beads/client.ts";
import { loadConfig } from "../config.ts";
import { AgentError, ValidationError } from "../errors.ts";
import { openSessionStore } from "../sessions/compat.ts";
import type { AgentSession } from "../types.ts";
import {
	createSession,
	isSessionAlive,
	killSession,
	sendKeys,
	waitForTuiReady,
} from "../worktree/tmux.ts";
import { isRunningAsRoot } from "./sling.ts";

/**
 * Build the supervisor startup beacon.
 *
 * @param opts.name - Supervisor agent name
 * @param opts.beadId - Bead task ID
 * @param opts.depth - Hierarchy depth (default 1)
 * @param opts.parent - Parent agent name (default "coordinator")
 */
export function buildSupervisorBeacon(opts: {
	name: string;
	beadId: string;
	depth: number;
	parent: string;
}): string {
	const timestamp = new Date().toISOString();
	const parts = [
		`[OVERSTORY] ${opts.name} (supervisor) ${timestamp} task:${opts.beadId}`,
		`Depth: ${opts.depth} | Parent: ${opts.parent} | Role: per-project supervisor`,
		`Startup: run mulch prime, check mail (overstory mail check --agent ${opts.name}), read task (bd show ${opts.beadId}), then begin supervising`,
	];
	return parts.join(" — ");
}

/**
 * Parse flags from command args.
 */
function parseFlags(args: string[]): {
	task: string | null;
	name: string | null;
	parent: string;
	depth: number;
	json: boolean;
} {
	const flags = {
		task: null as string | null,
		name: null as string | null,
		parent: "coordinator",
		depth: 1,
		json: false,
	};

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--task" && i + 1 < args.length) {
			const val = args[i + 1];
			if (val !== undefined) {
				flags.task = val;
			}
			i++;
		} else if (arg === "--name" && i + 1 < args.length) {
			const val = args[i + 1];
			if (val !== undefined) {
				flags.name = val;
			}
			i++;
		} else if (arg === "--parent" && i + 1 < args.length) {
			const val = args[i + 1];
			if (val !== undefined) {
				flags.parent = val;
			}
			i++;
		} else if (arg === "--depth" && i + 1 < args.length) {
			const val = args[i + 1];
			if (val !== undefined) {
				flags.depth = Number.parseInt(val, 10);
			}
			i++;
		} else if (arg === "--json") {
			flags.json = true;
		}
	}

	return flags;
}

/**
 * Start a supervisor agent.
 *
 * 1. Parse flags (--task required, --name required)
 * 2. Load config
 * 3. Validate: name is unique in sessions, bead exists and is workable
 * 4. Check no supervisor with same name is already running
 * 5. Deploy hooks with capability "supervisor"
 * 6. Create identity if first run
 * 7. Spawn tmux session at project root with Claude Code
 * 8. Send startup beacon
 * 9. Record session in SessionStore (sessions.db)
 */
async function startSupervisor(args: string[]): Promise<void> {
	const flags = parseFlags(args);

	if (!flags.task) {
		throw new ValidationError("--task <bead-id> is required", {
			field: "task",
			value: flags.task ?? "",
		});
	}
	if (!flags.name) {
		throw new ValidationError("--name <name> is required", {
			field: "name",
			value: flags.name ?? "",
		});
	}

	if (isRunningAsRoot()) {
		throw new AgentError(
			"Cannot spawn agents as root (UID 0). The claude CLI rejects --dangerously-skip-permissions when run as root, causing the tmux session to die immediately. Run overstory as a non-root user.",
		);
	}

	const cwd = process.cwd();
	const config = await loadConfig(cwd);
	const projectRoot = config.project.root;

	// Validate bead exists and is workable (open or in_progress)
	const beads = createBeadsClient(projectRoot);
	const bead = await beads.show(flags.task);
	if (bead.status !== "open" && bead.status !== "in_progress") {
		throw new ValidationError(`Bead ${flags.task} is not workable (status: ${bead.status})`, {
			field: "task",
			value: flags.task,
		});
	}

	// Check for existing supervisor with same name
	const overstoryDir = join(projectRoot, ".overstory");
	const { store } = openSessionStore(overstoryDir);
	try {
		const existing = store.getByName(flags.name);

		if (
			existing &&
			existing.capability === "supervisor" &&
			existing.state !== "completed" &&
			existing.state !== "zombie"
		) {
			const alive = await isSessionAlive(existing.tmuxSession);
			if (alive) {
				throw new AgentError(
					`Supervisor '${flags.name}' is already running (tmux: ${existing.tmuxSession}, since: ${existing.startedAt})`,
					{ agentName: flags.name },
				);
			}
			// Session recorded but tmux is dead — mark as completed and continue
			store.updateState(flags.name, "completed");
		}

		// Deploy supervisor-specific hooks to the project root's .claude/ directory.
		await deployHooks(projectRoot, flags.name, "supervisor");

		// Create supervisor identity if first run
		const identityBaseDir = join(projectRoot, ".overstory", "agents");
		await mkdir(identityBaseDir, { recursive: true });
		const existingIdentity = await loadIdentity(identityBaseDir, flags.name);
		if (!existingIdentity) {
			await createIdentity(identityBaseDir, {
				name: flags.name,
				capability: "supervisor",
				created: new Date().toISOString(),
				sessionsCompleted: 0,
				expertiseDomains: config.mulch.enabled ? config.mulch.domains : [],
				recentTasks: [],
			});
		}

		// Resolve model from config > manifest > fallback
		const manifestLoader = createManifestLoader(
			join(projectRoot, config.agents.manifestPath),
			join(projectRoot, config.agents.baseDir),
		);
		const manifest = await manifestLoader.load();
		const { model } = resolveModel(config, manifest, "supervisor", "opus");

		// Spawn tmux session at project root with Claude Code (interactive mode).
		// Inject the supervisor base definition via --append-system-prompt.
		const tmuxSession = `overstory-${config.project.name}-supervisor-${flags.name}`;
		const agentDefPath = join(projectRoot, ".overstory", "agent-defs", "supervisor.md");
		const agentDefFile = Bun.file(agentDefPath);
		let claudeCmd = `claude --model ${model} --dangerously-skip-permissions`;
		if (await agentDefFile.exists()) {
			const agentDef = await agentDefFile.text();
			const escaped = agentDef.replace(/'/g, "'\\''");
			claudeCmd += ` --append-system-prompt '${escaped}'`;
		}
		const pid = await createSession(tmuxSession, projectRoot, claudeCmd, {
			OVERSTORY_AGENT_NAME: flags.name,
		});

		// Wait for Claude Code TUI to render before sending input
		await waitForTuiReady(tmuxSession);
		await Bun.sleep(1_000);

		const beacon = buildSupervisorBeacon({
			name: flags.name,
			beadId: flags.task,
			depth: flags.depth,
			parent: flags.parent,
		});
		await sendKeys(tmuxSession, beacon);

		// Follow-up Enters with increasing delays to ensure submission
		for (const delay of [1_000, 2_000]) {
			await Bun.sleep(delay);
			await sendKeys(tmuxSession, "");
		}

		// Record session
		const session: AgentSession = {
			id: `session-${Date.now()}-${flags.name}`,
			agentName: flags.name,
			capability: "supervisor",
			worktreePath: projectRoot, // Supervisor uses project root, not a worktree
			branchName: config.project.canonicalBranch, // Operates on canonical branch
			beadId: flags.task,
			tmuxSession,
			state: "booting",
			pid,
			parentAgent: flags.parent,
			depth: flags.depth,
			runId: null,
			startedAt: new Date().toISOString(),
			lastActivity: new Date().toISOString(),
			escalationLevel: 0,
			stalledSince: null,
		};

		store.upsert(session);

		const output = {
			agentName: flags.name,
			capability: "supervisor",
			tmuxSession,
			projectRoot,
			beadId: flags.task,
			parent: flags.parent,
			depth: flags.depth,
			pid,
		};

		if (flags.json) {
			process.stdout.write(`${JSON.stringify(output)}\n`);
		} else {
			process.stdout.write(`Supervisor '${flags.name}' started\n`);
			process.stdout.write(`  Tmux:    ${tmuxSession}\n`);
			process.stdout.write(`  Root:    ${projectRoot}\n`);
			process.stdout.write(`  Task:    ${flags.task}\n`);
			process.stdout.write(`  Parent:  ${flags.parent}\n`);
			process.stdout.write(`  Depth:   ${flags.depth}\n`);
			process.stdout.write(`  PID:     ${pid}\n`);
		}
	} finally {
		store.close();
	}
}

/**
 * Stop a supervisor agent.
 *
 * 1. Find the active supervisor session by name
 * 2. Kill the tmux session (with process tree cleanup)
 * 3. Mark session as completed in SessionStore
 */
async function stopSupervisor(args: string[]): Promise<void> {
	const flags = parseFlags(args);

	if (!flags.name) {
		throw new ValidationError("--name <name> is required", {
			field: "name",
			value: flags.name ?? "",
		});
	}

	const cwd = process.cwd();
	const config = await loadConfig(cwd);
	const projectRoot = config.project.root;

	const overstoryDir = join(projectRoot, ".overstory");
	const { store } = openSessionStore(overstoryDir);
	try {
		const session = store.getByName(flags.name);

		if (
			!session ||
			session.capability !== "supervisor" ||
			session.state === "completed" ||
			session.state === "zombie"
		) {
			throw new AgentError(`No active supervisor session found for '${flags.name}'`, {
				agentName: flags.name,
			});
		}

		// Kill tmux session with process tree cleanup
		const alive = await isSessionAlive(session.tmuxSession);
		if (alive) {
			await killSession(session.tmuxSession);
		}

		// Update session state
		store.updateState(flags.name, "completed");
		store.updateLastActivity(flags.name);

		if (flags.json) {
			process.stdout.write(`${JSON.stringify({ stopped: true, sessionId: session.id })}\n`);
		} else {
			process.stdout.write(`Supervisor '${flags.name}' stopped (session: ${session.id})\n`);
		}
	} finally {
		store.close();
	}
}

/**
 * Show supervisor status.
 *
 * If --name is provided, show status for that specific supervisor.
 * Otherwise, list all supervisors.
 */
async function statusSupervisor(args: string[]): Promise<void> {
	const flags = parseFlags(args);
	const cwd = process.cwd();
	const config = await loadConfig(cwd);
	const projectRoot = config.project.root;

	const overstoryDir = join(projectRoot, ".overstory");
	const { store } = openSessionStore(overstoryDir);
	try {
		if (flags.name) {
			// Show specific supervisor
			const session = store.getByName(flags.name);

			if (
				!session ||
				session.capability !== "supervisor" ||
				session.state === "completed" ||
				session.state === "zombie"
			) {
				if (flags.json) {
					process.stdout.write(`${JSON.stringify({ running: false })}\n`);
				} else {
					process.stdout.write(`Supervisor '${flags.name}' is not running\n`);
				}
				return;
			}

			const alive = await isSessionAlive(session.tmuxSession);

			// Reconcile state: we already filtered out completed/zombie above,
			// so if tmux is dead this session needs to be marked as zombie.
			if (!alive) {
				store.updateState(flags.name, "zombie");
				store.updateLastActivity(flags.name);
				session.state = "zombie";
			}

			const status = {
				running: alive,
				sessionId: session.id,
				agentName: session.agentName,
				state: session.state,
				tmuxSession: session.tmuxSession,
				beadId: session.beadId,
				parentAgent: session.parentAgent,
				depth: session.depth,
				pid: session.pid,
				startedAt: session.startedAt,
				lastActivity: session.lastActivity,
			};

			if (flags.json) {
				process.stdout.write(`${JSON.stringify(status)}\n`);
			} else {
				const stateLabel = alive ? "running" : session.state;
				process.stdout.write(`Supervisor '${flags.name}': ${stateLabel}\n`);
				process.stdout.write(`  Session:   ${session.id}\n`);
				process.stdout.write(`  Tmux:      ${session.tmuxSession}\n`);
				process.stdout.write(`  Task:      ${session.beadId}\n`);
				process.stdout.write(`  Parent:    ${session.parentAgent}\n`);
				process.stdout.write(`  Depth:     ${session.depth}\n`);
				process.stdout.write(`  PID:       ${session.pid}\n`);
				process.stdout.write(`  Started:   ${session.startedAt}\n`);
				process.stdout.write(`  Activity:  ${session.lastActivity}\n`);
			}
		} else {
			// List all supervisors
			const allSessions = store.getAll();
			const supervisors = allSessions.filter((s) => s.capability === "supervisor");

			if (supervisors.length === 0) {
				if (flags.json) {
					process.stdout.write(`${JSON.stringify([])}\n`);
				} else {
					process.stdout.write("No supervisor sessions found\n");
				}
				return;
			}

			const statuses = await Promise.all(
				supervisors.map(async (session) => {
					const alive = await isSessionAlive(session.tmuxSession);

					// Reconcile state
					if (!alive && session.state !== "completed" && session.state !== "zombie") {
						store.updateState(session.agentName, "zombie");
						store.updateLastActivity(session.agentName);
					}

					return {
						agentName: session.agentName,
						running: alive,
						state:
							!alive && session.state !== "completed" && session.state !== "zombie"
								? ("zombie" as const)
								: session.state,
						tmuxSession: session.tmuxSession,
						beadId: session.beadId,
						parentAgent: session.parentAgent,
						depth: session.depth,
						startedAt: session.startedAt,
					};
				}),
			);

			if (flags.json) {
				process.stdout.write(`${JSON.stringify(statuses)}\n`);
			} else {
				process.stdout.write("Supervisor sessions:\n");
				for (const status of statuses) {
					const stateLabel = status.running ? "running" : status.state;
					process.stdout.write(
						`  ${status.agentName}: ${stateLabel} (task: ${status.beadId}, parent: ${status.parentAgent})\n`,
					);
				}
			}
		}
	} finally {
		store.close();
	}
}

const SUPERVISOR_HELP = `overstory supervisor — Manage per-project supervisor agents

Usage: overstory supervisor <subcommand> [flags]

Subcommands:
  start                    Start a supervisor (spawns Claude Code at project root)
  stop                     Stop a supervisor (kills tmux session)
  status                   Show supervisor state

Options (start):
  --task <bead-id>         Bead task ID (required)
  --name <name>            Unique supervisor name (required)
  --parent <agent>         Parent agent name (default: "coordinator")
  --depth <n>              Hierarchy depth (default: 1)
  --json                   Output as JSON

Options (stop):
  --name <name>            Supervisor name to stop (required)
  --json                   Output as JSON

Options (status):
  --name <name>            Show specific supervisor (optional, lists all if omitted)
  --json                   Output as JSON

The supervisor runs at the project root (like the coordinator) but is assigned
to a specific bead task and operates at depth 1. Supervisors can spawn workers
via overstory sling and coordinate their work.`;

/**
 * Entry point for `overstory supervisor <subcommand>`.
 */
export async function supervisorCommand(args: string[]): Promise<void> {
	if (args.includes("--help") || args.includes("-h") || args.length === 0) {
		process.stdout.write(`${SUPERVISOR_HELP}\n`);
		return;
	}

	const subcommand = args[0];
	const subArgs = args.slice(1);

	switch (subcommand) {
		case "start":
			await startSupervisor(subArgs);
			break;
		case "stop":
			await stopSupervisor(subArgs);
			break;
		case "status":
			await statusSupervisor(subArgs);
			break;
		default:
			throw new ValidationError(
				`Unknown supervisor subcommand: ${subcommand}. Run 'overstory supervisor --help' for usage.`,
				{ field: "subcommand", value: subcommand },
			);
	}
}

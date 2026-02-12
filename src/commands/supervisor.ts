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
import { createBeadsClient } from "../beads/client.ts";
import { loadConfig } from "../config.ts";
import { AgentError, ValidationError } from "../errors.ts";
import type { AgentSession } from "../types.ts";
import { createSession, isSessionAlive, killSession, sendKeys } from "../worktree/tmux.ts";

/**
 * Load sessions registry from .overstory/sessions.json.
 */
export async function loadSessions(sessionsPath: string): Promise<AgentSession[]> {
	const file = Bun.file(sessionsPath);
	if (!(await file.exists())) {
		return [];
	}
	try {
		const text = await file.text();
		return JSON.parse(text) as AgentSession[];
	} catch {
		return [];
	}
}

/**
 * Save sessions registry to .overstory/sessions.json.
 */
export async function saveSessions(sessionsPath: string, sessions: AgentSession[]): Promise<void> {
	await Bun.write(sessionsPath, `${JSON.stringify(sessions, null, "\t")}\n`);
}

/**
 * Find a supervisor session by name.
 */
function findSupervisorSession(sessions: AgentSession[], name: string): AgentSession | undefined {
	return sessions.find(
		(s) =>
			s.agentName === name &&
			s.capability === "supervisor" &&
			s.state !== "completed" &&
			s.state !== "zombie",
	);
}

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
 * 9. Record session in sessions.json
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
	const sessionsPath = join(projectRoot, ".overstory", "sessions.json");
	const sessions = await loadSessions(sessionsPath);
	const existing = findSupervisorSession(sessions, flags.name);

	if (existing) {
		const alive = await isSessionAlive(existing.tmuxSession);
		if (alive) {
			throw new AgentError(
				`Supervisor '${flags.name}' is already running (tmux: ${existing.tmuxSession}, since: ${existing.startedAt})`,
				{ agentName: flags.name },
			);
		}
		// Session recorded but tmux is dead — mark as completed and continue
		existing.state = "completed";
		await saveSessions(sessionsPath, sessions);
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

	// Spawn tmux session at project root with Claude Code (interactive mode)
	const tmuxSession = `overstory-supervisor-${flags.name}`;
	const claudeCmd = "claude --model opus --dangerously-skip-permissions";
	const pid = await createSession(tmuxSession, projectRoot, claudeCmd, {
		OVERSTORY_AGENT_NAME: flags.name,
	});

	// Send beacon after TUI initialization delay
	await Bun.sleep(3_000);
	const beacon = buildSupervisorBeacon({
		name: flags.name,
		beadId: flags.task,
		depth: flags.depth,
		parent: flags.parent,
	});
	await sendKeys(tmuxSession, beacon);

	// Follow-up Enter to ensure submission
	await Bun.sleep(500);
	await sendKeys(tmuxSession, "");

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
		startedAt: new Date().toISOString(),
		lastActivity: new Date().toISOString(),
	};

	sessions.push(session);
	await saveSessions(sessionsPath, sessions);

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
}

/**
 * Stop a supervisor agent.
 *
 * 1. Find the active supervisor session by name
 * 2. Kill the tmux session (with process tree cleanup)
 * 3. Mark session as completed in sessions.json
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

	const sessionsPath = join(projectRoot, ".overstory", "sessions.json");
	const sessions = await loadSessions(sessionsPath);
	const session = findSupervisorSession(sessions, flags.name);

	if (!session) {
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
	session.state = "completed";
	session.lastActivity = new Date().toISOString();
	await saveSessions(sessionsPath, sessions);

	if (flags.json) {
		process.stdout.write(`${JSON.stringify({ stopped: true, sessionId: session.id })}\n`);
	} else {
		process.stdout.write(`Supervisor '${flags.name}' stopped (session: ${session.id})\n`);
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

	const sessionsPath = join(projectRoot, ".overstory", "sessions.json");
	const sessions = await loadSessions(sessionsPath);

	if (flags.name) {
		// Show specific supervisor
		const session = findSupervisorSession(sessions, flags.name);

		if (!session) {
			if (flags.json) {
				process.stdout.write(`${JSON.stringify({ running: false })}\n`);
			} else {
				process.stdout.write(`Supervisor '${flags.name}' is not running\n`);
			}
			return;
		}

		const alive = await isSessionAlive(session.tmuxSession);

		// Reconcile state
		if (!alive && session.state !== "completed" && session.state !== "zombie") {
			session.state = "zombie";
			session.lastActivity = new Date().toISOString();
			await saveSessions(sessionsPath, sessions);
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
		const supervisors = sessions.filter((s) => s.capability === "supervisor");

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
					session.state = "zombie";
					session.lastActivity = new Date().toISOString();
				}

				return {
					agentName: session.agentName,
					running: alive,
					state: session.state,
					tmuxSession: session.tmuxSession,
					beadId: session.beadId,
					parentAgent: session.parentAgent,
					depth: session.depth,
					startedAt: session.startedAt,
				};
			}),
		);

		// Save reconciled state
		await saveSessions(sessionsPath, sessions);

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

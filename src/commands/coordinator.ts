/**
 * CLI command: overstory coordinator start|stop|status
 *
 * Manages the persistent coordinator agent lifecycle. The coordinator runs
 * at the project root (NOT in a worktree), receives work via mail and beads,
 * and dispatches agents via overstory sling.
 *
 * Unlike regular agents spawned by sling, the coordinator:
 * - Has no worktree (operates on the main working tree)
 * - Has no bead assignment (it creates beads, not works on them)
 * - Has no overlay CLAUDE.md (context comes via mail + beads + checkpoints)
 * - Persists across work batches
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { deployHooks } from "../agents/hooks-deployer.ts";
import { createIdentity, loadIdentity } from "../agents/identity.ts";
import { loadConfig } from "../config.ts";
import { AgentError, ValidationError } from "../errors.ts";
import { openSessionStore } from "../sessions/compat.ts";
import type { AgentSession } from "../types.ts";
import { createSession, isSessionAlive, killSession, sendKeys } from "../worktree/tmux.ts";

/** Default coordinator agent name. */
const COORDINATOR_NAME = "coordinator";

/**
 * Build the tmux session name for the coordinator.
 * Includes the project name to prevent cross-project collisions (overstory-pcef).
 */
function coordinatorTmuxSession(projectName: string): string {
	return `overstory-${projectName}-${COORDINATOR_NAME}`;
}

/** Dependency injection for testing. Uses real implementations when omitted. */
export interface CoordinatorDeps {
	_tmux?: {
		createSession: (
			name: string,
			cwd: string,
			command: string,
			env?: Record<string, string>,
		) => Promise<number>;
		isSessionAlive: (name: string) => Promise<boolean>;
		killSession: (name: string) => Promise<void>;
		sendKeys: (name: string, keys: string) => Promise<void>;
	};
}

/**
 * Build the coordinator startup beacon — the first message sent to the coordinator
 * via tmux send-keys after Claude Code initializes.
 */
export function buildCoordinatorBeacon(): string {
	const timestamp = new Date().toISOString();
	const parts = [
		`[OVERSTORY] ${COORDINATOR_NAME} (coordinator) ${timestamp}`,
		"Depth: 0 | Parent: none | Role: persistent orchestrator",
		"HIERARCHY: You ONLY spawn leads (overstory sling --capability lead). Leads spawn scouts, builders, reviewers. NEVER spawn non-lead agents directly.",
		"DELEGATION: For any exploration/scouting, spawn a lead who will spawn scouts. Do NOT explore the codebase yourself beyond initial planning.",
		`Startup: run mulch prime, check mail (overstory mail check --agent ${COORDINATOR_NAME}), check bd ready, check overstory group status, then begin work`,
	];
	return parts.join(" — ");
}

/**
 * Start the coordinator agent.
 *
 * 1. Verify no coordinator is already running
 * 2. Load config
 * 3. Create agent identity (if first time)
 * 4. Deploy hooks to project root's .claude/settings.local.json
 * 5. Spawn tmux session at project root with Claude Code
 * 6. Send startup beacon
 * 7. Record session in SessionStore (sessions.db)
 */
/**
 * Determine whether to auto-attach to the tmux session after starting.
 * Exported for testing.
 */
export function resolveAttach(args: string[], isTTY: boolean): boolean {
	if (args.includes("--attach")) return true;
	if (args.includes("--no-attach")) return false;
	return isTTY;
}

async function startCoordinator(args: string[], deps: CoordinatorDeps = {}): Promise<void> {
	const tmux = deps._tmux ?? { createSession, isSessionAlive, killSession, sendKeys };

	const json = args.includes("--json");
	const shouldAttach = resolveAttach(args, !!process.stdout.isTTY);
	const cwd = process.cwd();
	const config = await loadConfig(cwd);
	const projectRoot = config.project.root;
	const tmuxSession = coordinatorTmuxSession(config.project.name);

	// Check for existing coordinator
	const overstoryDir = join(projectRoot, ".overstory");
	const { store } = openSessionStore(overstoryDir);
	try {
		const existing = store.getByName(COORDINATOR_NAME);

		if (
			existing &&
			existing.capability === "coordinator" &&
			existing.state !== "completed" &&
			existing.state !== "zombie"
		) {
			const alive = await tmux.isSessionAlive(existing.tmuxSession);
			if (alive) {
				throw new AgentError(
					`Coordinator is already running (tmux: ${existing.tmuxSession}, since: ${existing.startedAt})`,
					{ agentName: COORDINATOR_NAME },
				);
			}
			// Session recorded but tmux is dead — mark as completed and continue
			store.updateState(COORDINATOR_NAME, "completed");
		}

		// Deploy hooks to the project root so the coordinator gets event logging,
		// mail check --inject, and activity tracking via the standard hook pipeline.
		// The ENV_GUARD prefix on all hooks (both template and generated guards)
		// ensures they only activate when OVERSTORY_AGENT_NAME is set (i.e. for
		// the coordinator's tmux session), so the user's own Claude Code session
		// at the project root is unaffected.
		await deployHooks(projectRoot, COORDINATOR_NAME, "coordinator");

		// Create coordinator identity if first run
		const identityBaseDir = join(projectRoot, ".overstory", "agents");
		await mkdir(identityBaseDir, { recursive: true });
		const existingIdentity = await loadIdentity(identityBaseDir, COORDINATOR_NAME);
		if (!existingIdentity) {
			await createIdentity(identityBaseDir, {
				name: COORDINATOR_NAME,
				capability: "coordinator",
				created: new Date().toISOString(),
				sessionsCompleted: 0,
				expertiseDomains: config.mulch.enabled ? config.mulch.domains : [],
				recentTasks: [],
			});
		}

		// Spawn tmux session at project root with Claude Code (interactive mode).
		// Inject the coordinator base definition via --append-system-prompt so the
		// coordinator knows its role, hierarchy rules, and delegation patterns
		// (overstory-gaio, overstory-0kwf).
		const agentDefPath = join(projectRoot, ".overstory", "agent-defs", "coordinator.md");
		const agentDefFile = Bun.file(agentDefPath);
		let claudeCmd = "claude --model opus --dangerously-skip-permissions";
		if (await agentDefFile.exists()) {
			const agentDef = await agentDefFile.text();
			// Single-quote the content for safe shell expansion (only escape single quotes)
			const escaped = agentDef.replace(/'/g, "'\\''");
			claudeCmd += ` --append-system-prompt '${escaped}'`;
		}
		const pid = await tmux.createSession(tmuxSession, projectRoot, claudeCmd, {
			OVERSTORY_AGENT_NAME: COORDINATOR_NAME,
		});

		// Record session BEFORE sending the beacon so that hook-triggered
		// updateLastActivity() can find the entry and transition booting->working.
		// Without this, a race exists: hooks fire before the session is persisted,
		// leaving the coordinator stuck in "booting" (overstory-036f).
		const session: AgentSession = {
			id: `session-${Date.now()}-${COORDINATOR_NAME}`,
			agentName: COORDINATOR_NAME,
			capability: "coordinator",
			worktreePath: projectRoot, // Coordinator uses project root, not a worktree
			branchName: config.project.canonicalBranch, // Operates on canonical branch
			beadId: "", // No specific bead assignment
			tmuxSession,
			state: "booting",
			pid,
			parentAgent: null, // Top of hierarchy
			depth: 0,
			runId: null,
			startedAt: new Date().toISOString(),
			lastActivity: new Date().toISOString(),
			escalationLevel: 0,
			stalledSince: null,
		};

		store.upsert(session);

		// Send beacon after TUI initialization delay
		await Bun.sleep(3_000);
		const beacon = buildCoordinatorBeacon();
		await tmux.sendKeys(tmuxSession, beacon);

		// Follow-up Enter to ensure submission (same pattern as sling.ts)
		await Bun.sleep(500);
		await tmux.sendKeys(tmuxSession, "");

		const output = {
			agentName: COORDINATOR_NAME,
			capability: "coordinator",
			tmuxSession,
			projectRoot,
			pid,
		};

		if (json) {
			process.stdout.write(`${JSON.stringify(output)}\n`);
		} else {
			process.stdout.write("Coordinator started\n");
			process.stdout.write(`  Tmux:    ${tmuxSession}\n`);
			process.stdout.write(`  Root:    ${projectRoot}\n`);
			process.stdout.write(`  PID:     ${pid}\n`);
		}

		if (shouldAttach) {
			Bun.spawnSync(["tmux", "attach-session", "-t", tmuxSession], {
				stdio: ["inherit", "inherit", "inherit"],
			});
		}
	} finally {
		store.close();
	}
}

/**
 * Stop the coordinator agent.
 *
 * 1. Find the active coordinator session
 * 2. Kill the tmux session (with process tree cleanup)
 * 3. Mark session as completed in SessionStore
 */
async function stopCoordinator(args: string[], deps: CoordinatorDeps = {}): Promise<void> {
	const tmux = deps._tmux ?? { createSession, isSessionAlive, killSession, sendKeys };

	const json = args.includes("--json");
	const cwd = process.cwd();
	const config = await loadConfig(cwd);
	const projectRoot = config.project.root;

	const overstoryDir = join(projectRoot, ".overstory");
	const { store } = openSessionStore(overstoryDir);
	try {
		const session = store.getByName(COORDINATOR_NAME);

		if (
			!session ||
			session.capability !== "coordinator" ||
			session.state === "completed" ||
			session.state === "zombie"
		) {
			throw new AgentError("No active coordinator session found", {
				agentName: COORDINATOR_NAME,
			});
		}

		// Kill tmux session with process tree cleanup
		const alive = await tmux.isSessionAlive(session.tmuxSession);
		if (alive) {
			await tmux.killSession(session.tmuxSession);
		}

		// Update session state
		store.updateState(COORDINATOR_NAME, "completed");
		store.updateLastActivity(COORDINATOR_NAME);

		if (json) {
			process.stdout.write(`${JSON.stringify({ stopped: true, sessionId: session.id })}\n`);
		} else {
			process.stdout.write(`Coordinator stopped (session: ${session.id})\n`);
		}
	} finally {
		store.close();
	}
}

/**
 * Show coordinator status.
 *
 * Checks session registry and tmux liveness to report actual state.
 */
async function statusCoordinator(args: string[], deps: CoordinatorDeps = {}): Promise<void> {
	const tmux = deps._tmux ?? { createSession, isSessionAlive, killSession, sendKeys };

	const json = args.includes("--json");
	const cwd = process.cwd();
	const config = await loadConfig(cwd);
	const projectRoot = config.project.root;

	const overstoryDir = join(projectRoot, ".overstory");
	const { store } = openSessionStore(overstoryDir);
	try {
		const session = store.getByName(COORDINATOR_NAME);

		if (
			!session ||
			session.capability !== "coordinator" ||
			session.state === "completed" ||
			session.state === "zombie"
		) {
			if (json) {
				process.stdout.write(`${JSON.stringify({ running: false })}\n`);
			} else {
				process.stdout.write("Coordinator is not running\n");
			}
			return;
		}

		const alive = await tmux.isSessionAlive(session.tmuxSession);

		// Reconcile state: if session says active but tmux is dead, update.
		// We already filtered out completed/zombie states above, so if tmux is dead
		// this session needs to be marked as zombie.
		if (!alive) {
			store.updateState(COORDINATOR_NAME, "zombie");
			store.updateLastActivity(COORDINATOR_NAME);
			session.state = "zombie";
		}

		const status = {
			running: alive,
			sessionId: session.id,
			state: session.state,
			tmuxSession: session.tmuxSession,
			pid: session.pid,
			startedAt: session.startedAt,
			lastActivity: session.lastActivity,
		};

		if (json) {
			process.stdout.write(`${JSON.stringify(status)}\n`);
		} else {
			const stateLabel = alive ? "running" : session.state;
			process.stdout.write(`Coordinator: ${stateLabel}\n`);
			process.stdout.write(`  Session:   ${session.id}\n`);
			process.stdout.write(`  Tmux:      ${session.tmuxSession}\n`);
			process.stdout.write(`  PID:       ${session.pid}\n`);
			process.stdout.write(`  Started:   ${session.startedAt}\n`);
			process.stdout.write(`  Activity:  ${session.lastActivity}\n`);
		}
	} finally {
		store.close();
	}
}

const COORDINATOR_HELP = `overstory coordinator — Manage the persistent coordinator agent

Usage: overstory coordinator <subcommand> [flags]

Subcommands:
  start                    Start the coordinator (spawns Claude Code at project root)
  stop                     Stop the coordinator (kills tmux session)
  status                   Show coordinator state

Start options:
  --attach                 Always attach to tmux session after start
  --no-attach              Never attach to tmux session after start
                           Default: attach when running in an interactive TTY

General options:
  --json                   Output as JSON
  --help, -h               Show this help

The coordinator runs at the project root and orchestrates work by:
  - Decomposing objectives into beads issues
  - Dispatching agents via overstory sling
  - Tracking batches via task groups
  - Handling escalations from agents and watchdog`;

/**
 * Entry point for `overstory coordinator <subcommand>`.
 *
 * @param args - CLI arguments after "coordinator"
 * @param deps - Optional dependency injection for testing (tmux)
 */
export async function coordinatorCommand(
	args: string[],
	deps: CoordinatorDeps = {},
): Promise<void> {
	if (args.includes("--help") || args.includes("-h") || args.length === 0) {
		process.stdout.write(`${COORDINATOR_HELP}\n`);
		return;
	}

	const subcommand = args[0];
	const subArgs = args.slice(1);

	switch (subcommand) {
		case "start":
			await startCoordinator(subArgs, deps);
			break;
		case "stop":
			await stopCoordinator(subArgs, deps);
			break;
		case "status":
			await statusCoordinator(subArgs, deps);
			break;
		default:
			throw new ValidationError(
				`Unknown coordinator subcommand: ${subcommand}. Run 'overstory coordinator --help' for usage.`,
				{ field: "subcommand", value: subcommand },
			);
	}
}

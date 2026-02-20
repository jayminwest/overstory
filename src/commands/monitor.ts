/**
 * CLI command: overstory monitor start|stop|status
 *
 * Manages the persistent Tier 2 monitor agent lifecycle. The monitor runs
 * at the project root (NOT in a worktree), continuously patrols the agent
 * fleet, sends nudges to stalled agents, and reports health summaries to
 * the coordinator.
 *
 * Unlike regular agents spawned by sling, the monitor:
 * - Has no worktree (operates on the main working tree)
 * - Has no bead assignment (it monitors, not implements)
 * - Has no per-task instruction overlay (context comes via overstory status + mail)
 * - Persists across patrol cycles
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { deployHooks } from "../agents/hooks-deployer.ts";
import { createIdentity, loadIdentity } from "../agents/identity.ts";
import { createManifestLoader, resolveRoute } from "../agents/manifest.ts";
import { buildInteractiveAgentCommand, requiresNonRoot, resolveCliBase } from "../cli-base.ts";
import { loadConfig } from "../config.ts";
import { AgentError, ValidationError } from "../errors.ts";
import { openSessionStore } from "../sessions/compat.ts";
import type { AgentSession } from "../types.ts";
import { createSession, isSessionAlive, killSession, sendKeys } from "../worktree/tmux.ts";
import { isRunningAsRoot } from "./sling.ts";

/** Default monitor agent name. */
const MONITOR_NAME = "monitor";

/**
 * Build the tmux session name for the monitor.
 * Includes the project name to prevent cross-project collisions (overstory-pcef).
 */
function monitorTmuxSession(projectName: string): string {
	return `overstory-${projectName}-${MONITOR_NAME}`;
}

/**
 * Build the monitor startup beacon — the first message sent to the monitor
 * via tmux send-keys after Claude Code initializes.
 */
export function buildMonitorBeacon(): string {
	const timestamp = new Date().toISOString();
	const parts = [
		`[OVERSTORY] ${MONITOR_NAME} (monitor/tier-2) ${timestamp}`,
		"Depth: 0 | Parent: none | Role: continuous fleet patrol",
		`Startup: run overstory init --ensure, check fleet (overstory status --json), check mail (overstory mail check --agent ${MONITOR_NAME}), then begin patrol loop`,
	];
	return parts.join(" — ");
}

/**
 * Determine whether to auto-attach to the tmux session after starting.
 */
function resolveAttach(args: string[], isTTY: boolean): boolean {
	if (args.includes("--attach")) return true;
	if (args.includes("--no-attach")) return false;
	return isTTY;
}

/**
 * Start the monitor agent.
 *
 * 1. Verify no monitor is already running
 * 2. Load config
 * 3. Deploy hooks to project root's .claude/ (monitor-specific guards)
 * 4. Create agent identity (if first time)
 * 5. Spawn tmux session at project root with Claude Code
 * 6. Send startup beacon
 * 7. Record session in SessionStore (sessions.db)
 */
async function startMonitor(args: string[]): Promise<void> {
	const json = args.includes("--json");
	const shouldAttach = resolveAttach(args, !!process.stdout.isTTY);

	const cwd = process.cwd();
	const config = await loadConfig(cwd);
	const cliBase = resolveCliBase(config);
	if (requiresNonRoot(cliBase) && isRunningAsRoot()) {
		throw new AgentError(
			"Cannot spawn agents as root (UID 0). The claude CLI rejects --dangerously-skip-permissions when run as root, causing the tmux session to die immediately. Run overstory as a non-root user.",
		);
	}

	// Gate on tier2Enabled config flag
	if (!config.watchdog.tier2Enabled) {
		throw new AgentError(
			"Monitor agent (Tier 2) is disabled. Set watchdog.tier2Enabled: true in .overstory/config.yaml to enable.",
			{ agentName: MONITOR_NAME },
		);
	}

	const projectRoot = config.project.root;
	const tmuxSession = monitorTmuxSession(config.project.name);

	// Check for existing monitor
	const overstoryDir = join(projectRoot, ".overstory");
	const { store } = openSessionStore(overstoryDir);
	try {
		const existing = store.getByName(MONITOR_NAME);

		if (
			existing &&
			existing.capability === "monitor" &&
			existing.state !== "completed" &&
			existing.state !== "zombie"
		) {
			const alive = await isSessionAlive(existing.tmuxSession);
			if (alive) {
				throw new AgentError(
					`Monitor is already running (tmux: ${existing.tmuxSession}, since: ${existing.startedAt})`,
					{ agentName: MONITOR_NAME },
				);
			}
			// Session recorded but tmux is dead — mark as completed and continue
			store.updateState(MONITOR_NAME, "completed");
		}

		// Deploy monitor-specific hooks only for Claude runtime sessions.
		if (cliBase === "claude") {
			await deployHooks(projectRoot, MONITOR_NAME, "monitor");
		}

		// Create monitor identity if first run
		const identityBaseDir = join(projectRoot, ".overstory", "agents");
		await mkdir(identityBaseDir, { recursive: true });
		const existingIdentity = await loadIdentity(identityBaseDir, MONITOR_NAME);
		if (!existingIdentity) {
			await createIdentity(identityBaseDir, {
				name: MONITOR_NAME,
				capability: "monitor",
				created: new Date().toISOString(),
				sessionsCompleted: 0,
				expertiseDomains: config.mulch.enabled ? config.mulch.domains : [],
				recentTasks: [],
			});
		}

		// Resolve model/provider route from config > manifest > fallback chain.
		const manifestLoader = createManifestLoader(
			join(projectRoot, config.agents.manifestPath),
			join(projectRoot, config.agents.baseDir),
		);
		const manifest = await manifestLoader.load();
		const route = resolveRoute(config, manifest, "monitor", "sonnet");

		// Spawn tmux session at project root with Claude Code (interactive mode).
		// Inject the monitor base definition via --append-system-prompt.
		const agentDefPath = join(projectRoot, ".overstory", "agent-defs", "monitor.md");
		const agentDefFile = Bun.file(agentDefPath);
		let systemPrompt: string | undefined;
		if (await agentDefFile.exists()) {
			systemPrompt = await agentDefFile.text();
		}
		const launchCommand = buildInteractiveAgentCommand({
			cliBase,
			model: route.model,
			systemPrompt,
		});
		const pid = await createSession(tmuxSession, projectRoot, launchCommand.command, {
			...route.env,
			OVERSTORY_AGENT_NAME: MONITOR_NAME,
		});

		// Record session BEFORE sending the beacon so that hook-triggered
		// updateLastActivity() can find the entry and transition booting->working.
		const session: AgentSession = {
			id: `session-${Date.now()}-${MONITOR_NAME}`,
			agentName: MONITOR_NAME,
			capability: "monitor",
			worktreePath: projectRoot, // Monitor uses project root, not a worktree
			branchName: config.project.canonicalBranch, // Operates on canonical branch
			beadId: "", // No specific bead assignment
			tmuxSession,
			state: "booting",
			pid,
			parentAgent: null, // Top of hierarchy (alongside coordinator)
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
		const beacon = buildMonitorBeacon();
		await sendKeys(tmuxSession, beacon);

		// Follow-up Enter to ensure submission (same pattern as sling.ts)
		await Bun.sleep(500);
		await sendKeys(tmuxSession, "");

		const output = {
			agentName: MONITOR_NAME,
			capability: "monitor",
			tmuxSession,
			projectRoot,
			pid,
		};

		if (json) {
			process.stdout.write(`${JSON.stringify(output)}\n`);
		} else {
			process.stdout.write("Monitor started\n");
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
 * Stop the monitor agent.
 *
 * 1. Find the active monitor session
 * 2. Kill the tmux session (with process tree cleanup)
 * 3. Mark session as completed in SessionStore
 */
async function stopMonitor(args: string[]): Promise<void> {
	const json = args.includes("--json");
	const cwd = process.cwd();
	const config = await loadConfig(cwd);
	const projectRoot = config.project.root;

	const overstoryDir = join(projectRoot, ".overstory");
	const { store } = openSessionStore(overstoryDir);
	try {
		const session = store.getByName(MONITOR_NAME);

		if (
			!session ||
			session.capability !== "monitor" ||
			session.state === "completed" ||
			session.state === "zombie"
		) {
			throw new AgentError("No active monitor session found", {
				agentName: MONITOR_NAME,
			});
		}

		// Kill tmux session with process tree cleanup
		const alive = await isSessionAlive(session.tmuxSession);
		if (alive) {
			await killSession(session.tmuxSession);
		}

		// Update session state
		store.updateState(MONITOR_NAME, "completed");
		store.updateLastActivity(MONITOR_NAME);

		if (json) {
			process.stdout.write(`${JSON.stringify({ stopped: true, sessionId: session.id })}\n`);
		} else {
			process.stdout.write(`Monitor stopped (session: ${session.id})\n`);
		}
	} finally {
		store.close();
	}
}

/**
 * Show monitor status.
 *
 * Checks session registry and tmux liveness to report actual state.
 */
async function statusMonitor(args: string[]): Promise<void> {
	const json = args.includes("--json");
	const cwd = process.cwd();
	const config = await loadConfig(cwd);
	const projectRoot = config.project.root;

	const overstoryDir = join(projectRoot, ".overstory");
	const { store } = openSessionStore(overstoryDir);
	try {
		const session = store.getByName(MONITOR_NAME);

		if (
			!session ||
			session.capability !== "monitor" ||
			session.state === "completed" ||
			session.state === "zombie"
		) {
			if (json) {
				process.stdout.write(`${JSON.stringify({ running: false })}\n`);
			} else {
				process.stdout.write("Monitor is not running\n");
			}
			return;
		}

		const alive = await isSessionAlive(session.tmuxSession);

		// Reconcile state: if session says active but tmux is dead, update.
		// We already filtered out completed/zombie states above, so if tmux is dead
		// this session needs to be marked as zombie.
		if (!alive) {
			store.updateState(MONITOR_NAME, "zombie");
			store.updateLastActivity(MONITOR_NAME);
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
			process.stdout.write(`Monitor: ${stateLabel}\n`);
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

const MONITOR_HELP = `overstory monitor — Manage the persistent Tier 2 monitor agent

Usage: overstory monitor <subcommand> [flags]

Subcommands:
  start                    Start the monitor (spawns configured CLI at project root)
  stop                     Stop the monitor (kills tmux session)
  status                   Show monitor state

Start options:
  --attach                 Always attach to tmux session after start
  --no-attach              Never attach to tmux session after start
                           Default: attach when running in an interactive TTY

General options:
  --json                   Output as JSON
  --help, -h               Show this help

The monitor agent (Tier 2) continuously patrols the agent fleet by:
  - Checking agent health via overstory status
  - Sending progressive nudges to stalled agents
  - Escalating unresponsive agents to the coordinator
  - Producing periodic health summaries`;

/**
 * Entry point for `overstory monitor <subcommand>`.
 */
export async function monitorCommand(args: string[]): Promise<void> {
	if (args.includes("--help") || args.includes("-h") || args.length === 0) {
		process.stdout.write(`${MONITOR_HELP}\n`);
		return;
	}

	const subcommand = args[0];
	const subArgs = args.slice(1);

	switch (subcommand) {
		case "start":
			await startMonitor(subArgs);
			break;
		case "stop":
			await stopMonitor(subArgs);
			break;
		case "status":
			await statusMonitor(subArgs);
			break;
		default:
			throw new ValidationError(
				`Unknown monitor subcommand: ${subcommand}. Run 'overstory monitor --help' for usage.`,
				{ field: "subcommand", value: subcommand },
			);
	}
}

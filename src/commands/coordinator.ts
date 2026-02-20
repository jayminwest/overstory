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
 * - Has no per-task instruction overlay (context comes via mail + beads + checkpoints)
 * - Persists across work batches
 */

import { mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { deployHooks } from "../agents/hooks-deployer.ts";
import { createIdentity, loadIdentity } from "../agents/identity.ts";
import { createManifestLoader, resolveRoute } from "../agents/manifest.ts";
import { buildInteractiveAgentCommand, requiresNonRoot, resolveCliBase } from "../cli-base.ts";
import { loadConfig } from "../config.ts";
import { AgentError, ValidationError } from "../errors.ts";
import { openSessionStore } from "../sessions/compat.ts";
import { createRunStore } from "../sessions/store.ts";
import type { AgentSession } from "../types.ts";
import { isProcessRunning } from "../watchdog/health.ts";
import {
	createSession,
	isSessionAlive,
	killSession,
	sendKeys,
	waitForTuiReady,
} from "../worktree/tmux.ts";
import { isRunningAsRoot } from "./sling.ts";

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
		waitForTuiReady: (
			name: string,
			timeoutMs?: number,
			pollIntervalMs?: number,
		) => Promise<boolean>;
	};
	_watchdog?: {
		start: () => Promise<{ pid: number } | null>;
		stop: () => Promise<boolean>;
		isRunning: () => Promise<boolean>;
	};
	_monitor?: {
		start: (args: string[]) => Promise<{ pid: number } | null>;
		stop: () => Promise<boolean>;
		isRunning: () => Promise<boolean>;
	};
}

/**
 * Read the PID from the watchdog PID file.
 * Returns null if the file doesn't exist or can't be parsed.
 */
async function readWatchdogPid(projectRoot: string): Promise<number | null> {
	const pidFilePath = join(projectRoot, ".overstory", "watchdog.pid");
	const file = Bun.file(pidFilePath);
	const exists = await file.exists();
	if (!exists) {
		return null;
	}

	try {
		const text = await file.text();
		const pid = Number.parseInt(text.trim(), 10);
		if (Number.isNaN(pid) || pid <= 0) {
			return null;
		}
		return pid;
	} catch {
		return null;
	}
}

/**
 * Remove the watchdog PID file.
 */
async function removeWatchdogPid(projectRoot: string): Promise<void> {
	const pidFilePath = join(projectRoot, ".overstory", "watchdog.pid");
	try {
		await unlink(pidFilePath);
	} catch {
		// File may already be gone — not an error
	}
}

/**
 * Default watchdog implementation for production use.
 * Starts/stops the watchdog daemon via `overstory watch --background`.
 */
function createDefaultWatchdog(projectRoot: string): NonNullable<CoordinatorDeps["_watchdog"]> {
	return {
		async start(): Promise<{ pid: number } | null> {
			// Check if watchdog is already running
			const existingPid = await readWatchdogPid(projectRoot);
			if (existingPid !== null && isProcessRunning(existingPid)) {
				return null; // Already running
			}

			// Clean up stale PID file
			if (existingPid !== null) {
				await removeWatchdogPid(projectRoot);
			}

			// Start watchdog in background
			const proc = Bun.spawn(["overstory", "watch", "--background"], {
				cwd: projectRoot,
				stdout: "pipe",
				stderr: "pipe",
			});

			const exitCode = await proc.exited;
			if (exitCode !== 0) {
				return null; // Failed to start
			}

			// Read the PID file that was written by the background process
			const pid = await readWatchdogPid(projectRoot);
			if (pid === null) {
				return null; // PID file wasn't created
			}

			return { pid };
		},

		async stop(): Promise<boolean> {
			const pid = await readWatchdogPid(projectRoot);
			if (pid === null) {
				return false; // No PID file
			}

			// Check if process is running
			if (!isProcessRunning(pid)) {
				// Process is dead, clean up PID file
				await removeWatchdogPid(projectRoot);
				return false;
			}

			// Kill the process
			try {
				process.kill(pid, 15); // SIGTERM
			} catch {
				return false;
			}

			// Remove PID file
			await removeWatchdogPid(projectRoot);
			return true;
		},

		async isRunning(): Promise<boolean> {
			const pid = await readWatchdogPid(projectRoot);
			if (pid === null) {
				return false;
			}
			return isProcessRunning(pid);
		},
	};
}

/**
 * Default monitor implementation for production use.
 * Starts/stops the monitor agent via `overstory monitor start/stop`.
 */
function createDefaultMonitor(projectRoot: string): NonNullable<CoordinatorDeps["_monitor"]> {
	return {
		async start(): Promise<{ pid: number } | null> {
			const proc = Bun.spawn(["overstory", "monitor", "start", "--no-attach", "--json"], {
				cwd: projectRoot,
				stdout: "pipe",
				stderr: "pipe",
			});
			const exitCode = await proc.exited;
			if (exitCode !== 0) return null;
			try {
				const stdout = await new Response(proc.stdout).text();
				const result = JSON.parse(stdout.trim()) as { pid?: number };
				return result.pid ? { pid: result.pid } : null;
			} catch {
				return null;
			}
		},
		async stop(): Promise<boolean> {
			const proc = Bun.spawn(["overstory", "monitor", "stop", "--json"], {
				cwd: projectRoot,
				stdout: "pipe",
				stderr: "pipe",
			});
			const exitCode = await proc.exited;
			return exitCode === 0;
		},
		async isRunning(): Promise<boolean> {
			const proc = Bun.spawn(["overstory", "monitor", "status", "--json"], {
				cwd: projectRoot,
				stdout: "pipe",
				stderr: "pipe",
			});
			const exitCode = await proc.exited;
			if (exitCode !== 0) return false;
			try {
				const stdout = await new Response(proc.stdout).text();
				const result = JSON.parse(stdout.trim()) as { running?: boolean };
				return result.running === true;
			} catch {
				return false;
			}
		},
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
		`Startup: run overstory init --ensure, check mail (overstory mail check --agent ${COORDINATOR_NAME}), optionally check backlog (bd ready if available), check overstory group status, then begin work`,
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
	const tmux = deps._tmux ?? {
		createSession,
		isSessionAlive,
		killSession,
		sendKeys,
		waitForTuiReady,
	};

	const json = args.includes("--json");
	const shouldAttach = resolveAttach(args, !!process.stdout.isTTY);
	const watchdogFlag = args.includes("--watchdog");
	const monitorFlag = args.includes("--monitor");

	const cwd = process.cwd();
	const config = await loadConfig(cwd);
	const cliBase = resolveCliBase(config);
	if (requiresNonRoot(cliBase) && isRunningAsRoot()) {
		throw new AgentError(
			"Cannot spawn agents as root (UID 0). The claude CLI rejects --dangerously-skip-permissions when run as root, causing the tmux session to die immediately. Run overstory as a non-root user.",
		);
	}
	const projectRoot = config.project.root;
	const watchdog = deps._watchdog ?? createDefaultWatchdog(projectRoot);
	const monitor = deps._monitor ?? createDefaultMonitor(projectRoot);
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

		// Deploy hooks only for Claude runtime sessions.
		// ENV_GUARD ensures project-root hooks only affect overstory-managed sessions.
		if (cliBase === "claude") {
			await deployHooks(projectRoot, COORDINATOR_NAME, "coordinator");
		}

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

		// Resolve model/provider route from config > manifest > fallback chain.
		const manifestLoader = createManifestLoader(
			join(projectRoot, config.agents.manifestPath),
			join(projectRoot, config.agents.baseDir),
		);
		const manifest = await manifestLoader.load();
		const route = resolveRoute(config, manifest, "coordinator", "opus");

		// Spawn tmux session at project root with Claude Code (interactive mode).
		// Inject the coordinator base definition via --append-system-prompt so the
		// coordinator knows its role, hierarchy rules, and delegation patterns
		// (overstory-gaio, overstory-0kwf).
		const agentDefPath = join(projectRoot, ".overstory", "agent-defs", "coordinator.md");
		const agentDefFile = Bun.file(agentDefPath);
		let systemPrompt: string | undefined;
		if (await agentDefFile.exists()) {
			systemPrompt = await agentDefFile.text();
		}
		const launchCommand = buildInteractiveAgentCommand({
			cliBase,
			model: route.model,
			systemPrompt,
			extraArgs: route.cliArgs,
		});
		const pid = await tmux.createSession(tmuxSession, projectRoot, launchCommand.command, {
			...route.env,
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

		// Wait for Claude Code TUI to render before sending input
		await tmux.waitForTuiReady(tmuxSession);
		await Bun.sleep(1_000);

		const beacon = buildCoordinatorBeacon();
		await tmux.sendKeys(tmuxSession, beacon);

		// Follow-up Enters with increasing delays to ensure submission
		for (const delay of [1_000, 2_000]) {
			await Bun.sleep(delay);
			await tmux.sendKeys(tmuxSession, "");
		}

		// Auto-start watchdog if --watchdog flag is present
		let watchdogPid: number | undefined;
		if (watchdogFlag) {
			const watchdogResult = await watchdog.start();
			if (watchdogResult) {
				watchdogPid = watchdogResult.pid;
				if (!json) process.stdout.write(`  Watchdog: started (PID ${watchdogResult.pid})\n`);
			} else {
				if (!json) process.stderr.write("  Watchdog: failed to start or already running\n");
			}
		}

		// Auto-start monitor if --monitor flag is present and tier2 is enabled
		let monitorPid: number | undefined;
		if (monitorFlag) {
			if (!config.watchdog.tier2Enabled) {
				if (!json)
					process.stderr.write("  Monitor:  skipped (watchdog.tier2Enabled is false in config)\n");
			} else {
				const monitorResult = await monitor.start([]);
				if (monitorResult) {
					monitorPid = monitorResult.pid;
					if (!json) process.stdout.write(`  Monitor:  started (PID ${monitorResult.pid})\n`);
				} else {
					if (!json) process.stderr.write("  Monitor:  failed to start or already running\n");
				}
			}
		}

		const output = {
			agentName: COORDINATOR_NAME,
			capability: "coordinator",
			tmuxSession,
			projectRoot,
			pid,
			watchdog: watchdogFlag ? watchdogPid !== undefined : false,
			monitor: monitorFlag ? monitorPid !== undefined : false,
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
 * 4. Auto-complete the active run (if current-run.txt exists)
 */
async function stopCoordinator(args: string[], deps: CoordinatorDeps = {}): Promise<void> {
	const tmux = deps._tmux ?? {
		createSession,
		isSessionAlive,
		killSession,
		sendKeys,
		waitForTuiReady,
	};

	const json = args.includes("--json");
	const cwd = process.cwd();
	const config = await loadConfig(cwd);
	const projectRoot = config.project.root;
	const watchdog = deps._watchdog ?? createDefaultWatchdog(projectRoot);
	const monitor = deps._monitor ?? createDefaultMonitor(projectRoot);

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

		// Always attempt to stop watchdog
		const watchdogStopped = await watchdog.stop();

		// Always attempt to stop monitor
		const monitorStopped = await monitor.stop();

		// Update session state
		store.updateState(COORDINATOR_NAME, "completed");
		store.updateLastActivity(COORDINATOR_NAME);

		// Auto-complete the current run
		let runCompleted = false;
		try {
			const currentRunPath = join(overstoryDir, "current-run.txt");
			const currentRunFile = Bun.file(currentRunPath);
			if (await currentRunFile.exists()) {
				const runId = (await currentRunFile.text()).trim();
				if (runId.length > 0) {
					const runStore = createRunStore(join(overstoryDir, "sessions.db"));
					try {
						runStore.completeRun(runId, "completed");
						runCompleted = true;
					} finally {
						runStore.close();
					}
					try {
						await unlink(currentRunPath);
					} catch {
						// File may already be gone
					}
				}
			}
		} catch {
			// Non-fatal: run completion should not break coordinator stop
		}

		if (json) {
			process.stdout.write(
				`${JSON.stringify({ stopped: true, sessionId: session.id, watchdogStopped, monitorStopped, runCompleted })}\n`,
			);
		} else {
			process.stdout.write(`Coordinator stopped (session: ${session.id})\n`);
			if (watchdogStopped) {
				process.stdout.write("Watchdog stopped\n");
			} else {
				process.stdout.write("No watchdog running\n");
			}
			if (monitorStopped) {
				process.stdout.write("Monitor stopped\n");
			} else {
				process.stdout.write("No monitor running\n");
			}
			if (runCompleted) {
				process.stdout.write("Run completed\n");
			} else {
				process.stdout.write("No active run\n");
			}
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
	const tmux = deps._tmux ?? {
		createSession,
		isSessionAlive,
		killSession,
		sendKeys,
		waitForTuiReady,
	};

	const json = args.includes("--json");
	const cwd = process.cwd();
	const config = await loadConfig(cwd);
	const projectRoot = config.project.root;
	const watchdog = deps._watchdog ?? createDefaultWatchdog(projectRoot);
	const monitor = deps._monitor ?? createDefaultMonitor(projectRoot);

	const overstoryDir = join(projectRoot, ".overstory");
	const { store } = openSessionStore(overstoryDir);
	try {
		const session = store.getByName(COORDINATOR_NAME);
		const watchdogRunning = await watchdog.isRunning();
		const monitorRunning = await monitor.isRunning();

		if (
			!session ||
			session.capability !== "coordinator" ||
			session.state === "completed" ||
			session.state === "zombie"
		) {
			if (json) {
				process.stdout.write(
					`${JSON.stringify({ running: false, watchdogRunning, monitorRunning })}\n`,
				);
			} else {
				process.stdout.write("Coordinator is not running\n");
				if (watchdogRunning) {
					process.stdout.write("Watchdog: running\n");
				}
				if (monitorRunning) {
					process.stdout.write("Monitor: running\n");
				}
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
			watchdogRunning,
			monitorRunning,
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
			process.stdout.write(`  Watchdog:  ${watchdogRunning ? "running" : "not running"}\n`);
			process.stdout.write(`  Monitor:   ${monitorRunning ? "running" : "not running"}\n`);
		}
	} finally {
		store.close();
	}
}

const COORDINATOR_HELP = `overstory coordinator — Manage the persistent coordinator agent

Usage: overstory coordinator <subcommand> [flags]

Subcommands:
  start                    Start the coordinator (spawns configured CLI at project root)
  stop                     Stop the coordinator (kills tmux session)
  status                   Show coordinator state

Start options:
  --attach                 Always attach to tmux session after start
  --no-attach              Never attach to tmux session after start
                           Default: attach when running in an interactive TTY
  --watchdog               Auto-start watchdog daemon with coordinator
  --monitor                Auto-start monitor agent (Tier 2) with coordinator

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

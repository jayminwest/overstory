/**
 * CLI command: ov coordinator start|stop|status
 *
 * Manages the persistent coordinator agent lifecycle. The coordinator runs
 * at the project root (NOT in a worktree), receives work via mail and tasks,
 * and dispatches agents via ov sling.
 *
 * Unlike regular agents spawned by sling, the coordinator:
 * - Has no worktree (operates on the main working tree)
 * - Has no task assignment (it creates tasks, not works on them)
 * - Has no overlay CLAUDE.md (context comes via mail + tasks + checkpoints)
 * - Persists across work batches
 */

import { mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { Command } from "commander";
import { createIdentity, loadIdentity } from "../agents/identity.ts";
import { createManifestLoader, resolveModel } from "../agents/manifest.ts";
import { loadConfig } from "../config.ts";
import { AgentError, ValidationError } from "../errors.ts";
import { jsonOutput } from "../json.ts";
import { printHint, printSuccess, printWarning } from "../logging/color.ts";
import { createMailClient } from "../mail/client.ts";
import { createMailStore } from "../mail/store.ts";
import { getRuntime } from "../runtimes/registry.ts";
import { openSessionStore } from "../sessions/compat.ts";
import { createRunStore, createSessionStore } from "../sessions/store.ts";
import { resolveBackend, trackerCliName } from "../tracker/factory.ts";
import type { AgentSession } from "../types.ts";
import { isProcessRunning } from "../watchdog/health.ts";
import { resolveProfileName, validateWorkflowName } from "../workflow.ts";
import type { SessionState } from "../worktree/tmux.ts";
import {
	capturePaneContent,
	checkSessionState,
	createSession,
	ensureTmuxAvailable,
	isSessionAlive,
	killSession,
	sanitizeTmuxName,
	sendKeys,
	TMUX_SOCKET,
	waitForTuiReady,
} from "../worktree/tmux.ts";
import { nudgeAgent } from "./nudge.ts";
import { isRunningAsRoot } from "./sling.ts";

/** Default coordinator agent name. */
const COORDINATOR_NAME = "coordinator";

export interface PersistentAgentSpec {
	commandName: string;
	displayName: string;
	agentName: string;
	capability: string;
	agentDefFile: string;
	beaconBuilder: (trackerCli: string) => string;
}

const COORDINATOR_SPEC: PersistentAgentSpec = {
	commandName: "coordinator",
	displayName: "Coordinator",
	agentName: COORDINATOR_NAME,
	capability: "coordinator",
	agentDefFile: "coordinator.md",
	beaconBuilder: buildCoordinatorBeacon,
};

/** Poll interval for the ask subcommand reply loop. */
const ASK_POLL_INTERVAL_MS = 2_000;

/** Default timeout in seconds for the ask subcommand. */
const ASK_DEFAULT_TIMEOUT_S = 120;

/**
 * Build the tmux session name for the coordinator.
 * Includes the project name to prevent cross-project collisions (overstory-pcef).
 */
function coordinatorTmuxSession(projectName: string, name: string = COORDINATOR_NAME): string {
	return `overstory-${sanitizeTmuxName(projectName)}-${name}`;
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
		checkSessionState: (name: string) => Promise<SessionState>;
		killSession: (name: string) => Promise<void>;
		sendKeys: (name: string, keys: string) => Promise<void>;
		waitForTuiReady: (
			name: string,
			detectReady: (paneContent: string) => import("../runtimes/types.ts").ReadyState,
			timeoutMs?: number,
			pollIntervalMs?: number,
		) => Promise<boolean>;
		ensureTmuxAvailable: () => Promise<void>;
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
	_nudge?: (
		projectRoot: string,
		agentName: string,
		message: string,
		force: boolean,
	) => Promise<{ delivered: boolean; reason?: string }>;
	_capturePaneContent?: (name: string, lines?: number) => Promise<string | null>;
	/** Override poll interval for ask subcommand (default: ASK_POLL_INTERVAL_MS). Used in tests. */
	_pollIntervalMs?: number;
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
 * Starts/stops the watchdog daemon via `ov watch --background`.
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
			const proc = Bun.spawn(["ov", "watch", "--background"], {
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
 * Starts/stops the monitor agent via `ov monitor start/stop`.
 */
function createDefaultMonitor(projectRoot: string): NonNullable<CoordinatorDeps["_monitor"]> {
	return {
		async start(): Promise<{ pid: number } | null> {
			const proc = Bun.spawn(["ov", "monitor", "start", "--no-attach", "--json"], {
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
			const proc = Bun.spawn(["ov", "monitor", "stop", "--json"], {
				cwd: projectRoot,
				stdout: "pipe",
				stderr: "pipe",
			});
			const exitCode = await proc.exited;
			return exitCode === 0;
		},
		async isRunning(): Promise<boolean> {
			const proc = Bun.spawn(["ov", "monitor", "status", "--json"], {
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
 *
 * @param cliName - The tracker CLI name to use in startup instructions (default: "bd")
 */
export function buildCoordinatorBeacon(cliName = "bd"): string {
	const timestamp = new Date().toISOString();
	const parts = [
		`[OVERSTORY] ${COORDINATOR_NAME} (coordinator) ${timestamp}`,
		"Depth: 0 | Parent: none | Role: persistent orchestrator",
		"HIERARCHY: Default to leads (ov sling --capability lead). For low-budget or very narrow work, you may spawn scout/builder directly. NEVER spawn reviewer or merger directly.",
		"DELEGATION: For substantial work streams, spawn a lead who will handle scouts/builders/reviewers. For tight agent budgets, compress roles by using direct scout/builder fallback or --dispatch-max-agents 1/2 on the lead.",
		`Startup: run mulch prime, check mail (ov mail check --agent ${COORDINATOR_NAME}), check ${cliName} ready, check ov group status, then begin work`,
	];
	return parts.join(" — ");
}

/**
 * Determine whether to auto-attach to the tmux session after starting.
 * Exported for testing.
 */
export function resolveAttach(args: string[], isTTY: boolean): boolean {
	if (args.includes("--attach")) return true;
	if (args.includes("--no-attach")) return false;
	return isTTY;
}

/**
 * Options for the reusable coordinator session startup core.
 * Used by startCoordinatorSession() and consumed by commands like ov discover.
 */
export interface CoordinatorSessionOptions {
	json: boolean;
	attach: boolean;
	watchdog: boolean;
	monitor: boolean;
	profile?: string;
	workflow?: string;
	/** Override coordinator name (default: "coordinator"). */
	coordinatorName?: string;
	/** Generic persistent agent name override. Preferred over coordinatorName for new callers. */
	agentName?: string;
	/** Capability stored in the session registry and used for manifest/runtime resolution. */
	capability?: string;
	/** Agent definition file to append as the system prompt. */
	agentDefFile?: string;
	/** Human-readable label for output. */
	displayName?: string;
	/** Custom beacon builder. Receives tracker CLI name, returns beacon string. */
	beaconBuilder?: (trackerCli: string) => string;
}

/**
 * Core coordinator session startup logic. Reusable by commands that need to
 * start a coordinator-like session with a custom name or beacon
 * (e.g., ov discover uses coordinatorName: "discover-coordinator").
 */
export async function startCoordinatorSession(
	opts: CoordinatorSessionOptions,
	deps: CoordinatorDeps = {},
): Promise<void> {
	const tmux = deps._tmux ?? {
		createSession,
		isSessionAlive,
		checkSessionState,
		killSession,
		sendKeys,
		waitForTuiReady,
		ensureTmuxAvailable,
	};

	const {
		json,
		attach: shouldAttach,
		watchdog: watchdogFlag,
		monitor: monitorFlag,
		profile: profileFlag,
		workflow: workflowFlag,
		coordinatorName: coordinatorNameOpt,
		agentName: agentNameOpt,
		capability: capabilityOpt,
		agentDefFile: agentDefFileOpt,
		displayName: displayNameOpt,
		beaconBuilder: beaconBuilderOpt,
	} = opts;

	const coordinatorName = agentNameOpt ?? coordinatorNameOpt ?? COORDINATOR_NAME;
	const capability = capabilityOpt ?? COORDINATOR_SPEC.capability;
	const agentDefFile = agentDefFileOpt ?? COORDINATOR_SPEC.agentDefFile;
	const displayName = displayNameOpt ?? COORDINATOR_SPEC.displayName;
	const beaconBuilder = beaconBuilderOpt ?? buildCoordinatorBeacon;
	const workflow = validateWorkflowName(workflowFlag);
	const effectiveProfile = resolveProfileName(profileFlag ?? workflow);

	if (isRunningAsRoot()) {
		throw new AgentError(
			"Cannot spawn agents as root (UID 0). The claude CLI rejects --permission-mode bypassPermissions when run as root, causing the tmux session to die immediately. Run overstory as a non-root user.",
		);
	}

	const cwd = process.cwd();
	const config = await loadConfig(cwd);
	const projectRoot = config.project.root;
	const watchdog = deps._watchdog ?? createDefaultWatchdog(projectRoot);
	const monitor = deps._monitor ?? createDefaultMonitor(projectRoot);
	const tmuxSession = coordinatorTmuxSession(config.project.name, coordinatorName);

	// Check for existing coordinator session with the same name
	const overstoryDir = join(projectRoot, ".overstory");
	const { store } = openSessionStore(overstoryDir);
	try {
		const existing = store.getByName(coordinatorName);

		if (
			existing &&
			existing.capability === capability &&
			existing.state !== "completed" &&
			existing.state !== "zombie"
		) {
			const sessionState = await tmux.checkSessionState(existing.tmuxSession);

			if (sessionState === "alive") {
				// Tmux session exists -- but is the process inside still running?
				// A crashed Claude Code leaves a zombie tmux pane that blocks retries.
				if (existing.pid !== null && !isProcessRunning(existing.pid)) {
					// Zombie: tmux pane exists but agent process has exited.
					// Kill the empty session and reclaim the slot.
					await tmux.killSession(existing.tmuxSession);
					store.updateState(coordinatorName, "completed");
				} else {
					// Either the process is genuinely running (pid alive), or pid is null
					// (e.g. sessions migrated from an older schema). In both cases we
					// cannot prove the session is a zombie, so treat it as active.
					throw new AgentError(
						`${displayName} is already running (tmux: ${existing.tmuxSession}, since: ${existing.startedAt})`,
						{ agentName: coordinatorName },
					);
				}
			} else {
				// Session is dead or tmux server is not running -- clean up stale DB entry.
				store.updateState(coordinatorName, "completed");
			}
		}

		// Resolve model and runtime early (needed for deployConfig and spawn)
		const manifestLoader = createManifestLoader(
			join(projectRoot, config.agents.manifestPath),
			join(projectRoot, config.agents.baseDir),
		);
		const manifest = await manifestLoader.load();
		const resolvedModel = resolveModel(config, manifest, capability, "opus");
		const runtime = getRuntime(undefined, config, capability);

		// Deploy hooks to the project root so the coordinator gets event logging,
		// mail check --inject, and activity tracking via the standard hook pipeline.
		// The ENV_GUARD prefix on all hooks (both template and generated guards)
		// ensures they only activate when OVERSTORY_AGENT_NAME is set (i.e. for
		// the coordinator's tmux session), so the user's own Claude Code session
		// at the project root is unaffected.
		await runtime.deployConfig(projectRoot, undefined, {
			agentName: coordinatorName,
			capability,
			worktreePath: projectRoot,
		});

		// Create coordinator identity if first run
		const identityBaseDir = join(projectRoot, ".overstory", "agents");
		await mkdir(identityBaseDir, { recursive: true });
		const existingIdentity = await loadIdentity(identityBaseDir, coordinatorName);
		if (!existingIdentity) {
			await createIdentity(identityBaseDir, {
				name: coordinatorName,
				capability,
				created: new Date().toISOString(),
				sessionsCompleted: 0,
				expertiseDomains: config.mulch.enabled ? config.mulch.domains : [],
				recentTasks: [],
			});
		}

		// Preflight: verify tmux is installed before attempting to spawn.
		// Without this check, a missing tmux leads to cryptic errors later.
		await tmux.ensureTmuxAvailable();

		// Spawn tmux session at project root with Claude Code (interactive mode).
		// Inject the coordinator base definition via --append-system-prompt so the
		// coordinator knows its role, hierarchy rules, and delegation patterns
		// (overstory-gaio, overstory-0kwf).
		// Pass the file path (not content) so the shell inside the tmux pane reads
		// it via $(cat ...) — avoids tmux IPC "command too long" errors with large
		// agent definitions (overstory#45).
		const agentDefPath = join(projectRoot, ".overstory", "agent-defs", agentDefFile);
		const agentDefHandle = Bun.file(agentDefPath);
		let appendSystemPromptFile: string | undefined;
		if (await agentDefHandle.exists()) {
			appendSystemPromptFile = agentDefPath;
		}
		const spawnCmd = runtime.buildSpawnCommand({
			model: resolvedModel.model,
			permissionMode: "bypass",
			cwd: projectRoot,
			appendSystemPromptFile,
			env: {
				...runtime.buildEnv(resolvedModel),
				OVERSTORY_AGENT_NAME: coordinatorName,
				...(effectiveProfile ? { OVERSTORY_PROFILE: effectiveProfile } : {}),
			},
		});
		const pid = await tmux.createSession(tmuxSession, projectRoot, spawnCmd, {
			...runtime.buildEnv(resolvedModel),
			OVERSTORY_AGENT_NAME: coordinatorName,
			...(effectiveProfile ? { OVERSTORY_PROFILE: effectiveProfile } : {}),
		});

		// Create a run for this coordinator session BEFORE recording the session,
		// so the session can reference the run ID from the start.
		const sessionId = `session-${Date.now()}-${coordinatorName}`;
		const runId = `run-${new Date().toISOString().replace(/[:.]/g, "-")}`;
		const runStore = createRunStore(join(overstoryDir, "sessions.db"));
		try {
			runStore.createRun({
				id: runId,
				startedAt: new Date().toISOString(),
				coordinatorSessionId: sessionId,
				coordinatorName,
				status: "active",
			});
		} finally {
			runStore.close();
		}
		// Write current-run.txt for backward compatibility with ov sling and other consumers.
		await Bun.write(join(overstoryDir, "current-run.txt"), runId);

		// Record session BEFORE sending the beacon so that hook-triggered
		// updateLastActivity() can find the entry and transition booting->working.
		// Without this, a race exists: hooks fire before the session is persisted,
		// leaving the coordinator stuck in "booting" (overstory-036f).
		const session: AgentSession = {
			id: sessionId,
			agentName: coordinatorName,
			capability,
			worktreePath: projectRoot, // Coordinator uses project root, not a worktree
			branchName: config.project.canonicalBranch, // Operates on canonical branch
			taskId: "", // No specific task assignment
			tmuxSession,
			state: "booting",
			pid,
			parentAgent: null, // Top of hierarchy
			depth: 0,
			runId,
			startedAt: new Date().toISOString(),
			lastActivity: new Date().toISOString(),
			escalationLevel: 0,
			stalledSince: null,
			transcriptPath: null,
		};

		store.upsert(session);

		// Give slow shells time to finish initializing before polling for TUI readiness.
		const shellDelay = config.runtime?.shellInitDelayMs ?? 0;
		if (shellDelay > 0) {
			await Bun.sleep(shellDelay);
		}

		// Wait for Claude Code TUI to render before sending input
		const tuiReady = await tmux.waitForTuiReady(tmuxSession, (content) =>
			runtime.detectReady(content),
		);
		if (!tuiReady) {
			// Session may have died — check liveness before proceeding
			const alive = await tmux.isSessionAlive(tmuxSession);
			if (!alive) {
				// Clean up the stale session record
				store.updateState(coordinatorName, "completed");
				const sessionState = await tmux.checkSessionState(tmuxSession);
				const detail =
					sessionState === "no_server"
						? "The tmux server is no longer running. It may have crashed or been killed externally."
						: "The Claude Code process may have crashed or exited immediately. Check tmux logs or try running the claude command manually.";
				throw new AgentError(
					`${displayName} tmux session "${tmuxSession}" died during startup. ${detail}`,
					{ agentName: coordinatorName },
				);
			}
			await tmux.killSession(tmuxSession);
			store.updateState(coordinatorName, "completed");
			throw new AgentError(
				`${displayName} tmux session "${tmuxSession}" did not become ready during startup. Claude Code may still be waiting on an interactive dialog or initializing too slowly.`,
				{ agentName: coordinatorName },
			);
		}
		await Bun.sleep(1_000);

		const resolvedBackend = await resolveBackend(config.taskTracker.backend, config.project.root);
		const trackerCli = trackerCliName(resolvedBackend);
		const beacon = beaconBuilder(trackerCli);
		await tmux.sendKeys(tmuxSession, beacon);

		// Follow-up Enters with increasing delays to ensure submission
		for (const delay of [1_000, 2_000, 3_000, 5_000]) {
			await Bun.sleep(delay);
			await tmux.sendKeys(tmuxSession, "");
		}

		// Auto-start watchdog if --watchdog flag is present
		let watchdogPid: number | undefined;
		if (watchdogFlag) {
			const watchdogResult = await watchdog.start();
			if (watchdogResult) {
				watchdogPid = watchdogResult.pid;
				if (!json) printHint("Watchdog started");
			} else {
				if (!json) printWarning("Watchdog failed to start");
			}
		}

		// Auto-start monitor if --monitor flag is present and tier2 is enabled
		let monitorPid: number | undefined;
		if (monitorFlag) {
			if (!config.watchdog.tier2Enabled) {
				if (!json) printWarning("Monitor skipped", "watchdog.tier2Enabled is false");
			} else {
				const monitorResult = await monitor.start([]);
				if (monitorResult) {
					monitorPid = monitorResult.pid;
					if (!json) printHint("Monitor started");
				} else {
					if (!json) printWarning("Monitor failed to start");
				}
			}
		}

		const output = {
			agentName: coordinatorName,
			capability,
			tmuxSession,
			projectRoot,
			pid,
			watchdog: watchdogFlag ? watchdogPid !== undefined : false,
			monitor: monitorFlag ? monitorPid !== undefined : false,
		};

		if (json) {
			jsonOutput(`${capability} start`, output);
		} else {
			printSuccess(`${displayName} started`);
			process.stdout.write(`  Tmux:    ${tmuxSession}\n`);
			process.stdout.write(`  Root:    ${projectRoot}\n`);
			process.stdout.write(`  PID:     ${pid}\n`);
		}

		if (shouldAttach) {
			Bun.spawnSync(["tmux", "-L", TMUX_SOCKET, "attach-session", "-t", tmuxSession], {
				stdio: ["inherit", "inherit", "inherit"],
			});
		}
	} finally {
		store.close();
	}
}

async function startPersistentAgent(
	spec: PersistentAgentSpec,
	opts: {
		json: boolean;
		attach: boolean;
		watchdog: boolean;
		monitor: boolean;
		profile?: string;
		workflow?: string;
	},
	deps: CoordinatorDeps = {},
): Promise<void> {
	await startCoordinatorSession(
		{
			...opts,
			agentName: spec.agentName,
			capability: spec.capability,
			agentDefFile: spec.agentDefFile,
			displayName: spec.displayName,
			beaconBuilder: spec.beaconBuilder,
		},
		deps,
	);
}

export async function startCoordinator(
	opts: {
		json: boolean;
		attach: boolean;
		watchdog: boolean;
		monitor: boolean;
		profile?: string;
		workflow?: string;
	},
	deps: CoordinatorDeps = {},
): Promise<void> {
	await startPersistentAgent(COORDINATOR_SPEC, opts, deps);
}

function isActivePersistentAgentSession(
	session: AgentSession | null,
	spec: PersistentAgentSpec,
): session is AgentSession {
	return (
		session !== null &&
		session.capability === spec.capability &&
		session.state !== "completed" &&
		session.state !== "zombie"
	);
}

/**
 * Stop the coordinator agent.
 *
 * 1. Find the active coordinator session
 * 2. Kill the tmux session (with process tree cleanup)
 * 3. Mark session as completed in SessionStore
 * 4. Auto-complete the active run (if current-run.txt exists)
 */
async function stopPersistentAgent(
	spec: PersistentAgentSpec,
	opts: { json: boolean },
	deps: CoordinatorDeps = {},
): Promise<void> {
	const tmux = deps._tmux ?? {
		createSession,
		isSessionAlive,
		checkSessionState,
		killSession,
		sendKeys,
		waitForTuiReady,
		ensureTmuxAvailable,
	};

	const { json } = opts;
	const cwd = process.cwd();
	const config = await loadConfig(cwd);
	const projectRoot = config.project.root;
	const watchdog = deps._watchdog ?? createDefaultWatchdog(projectRoot);
	const monitor = deps._monitor ?? createDefaultMonitor(projectRoot);

	const overstoryDir = join(projectRoot, ".overstory");
	const { store } = openSessionStore(overstoryDir);
	try {
		const session = store.getByName(spec.agentName);

		if (!isActivePersistentAgentSession(session, spec)) {
			throw new AgentError(`No active ${spec.commandName} session found`, {
				agentName: spec.agentName,
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
		store.updateState(spec.agentName, "completed");
		store.updateLastActivity(spec.agentName);

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
			jsonOutput(`${spec.commandName} stop`, {
				stopped: true,
				sessionId: session.id,
				watchdogStopped,
				monitorStopped,
				runCompleted,
			});
		} else {
			printSuccess(`${spec.displayName} stopped`, session.id);
			if (watchdogStopped) {
				printHint("Watchdog stopped");
			} else {
				printHint("No watchdog running");
			}
			if (monitorStopped) {
				printHint("Monitor stopped");
			} else {
				printHint("No monitor running");
			}
			if (runCompleted) {
				printHint("Run completed");
			} else {
				printHint("No active run");
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
async function statusPersistentAgent(
	spec: PersistentAgentSpec,
	opts: { json: boolean },
	deps: CoordinatorDeps = {},
): Promise<void> {
	const tmux = deps._tmux ?? {
		createSession,
		isSessionAlive,
		checkSessionState,
		killSession,
		sendKeys,
		waitForTuiReady,
		ensureTmuxAvailable,
	};

	const { json } = opts;
	const cwd = process.cwd();
	const config = await loadConfig(cwd);
	const projectRoot = config.project.root;
	const watchdog = deps._watchdog ?? createDefaultWatchdog(projectRoot);
	const monitor = deps._monitor ?? createDefaultMonitor(projectRoot);

	const overstoryDir = join(projectRoot, ".overstory");
	const { store } = openSessionStore(overstoryDir);
	try {
		const session = store.getByName(spec.agentName);
		const watchdogRunning = await watchdog.isRunning();
		const monitorRunning = await monitor.isRunning();

		if (!isActivePersistentAgentSession(session, spec)) {
			if (json) {
				jsonOutput(`${spec.commandName} status`, {
					running: false,
					watchdogRunning,
					monitorRunning,
				});
			} else {
				printHint(`${spec.displayName} is not running`);
				if (watchdogRunning) {
					printHint("Watchdog: running");
				}
				if (monitorRunning) {
					printHint("Monitor: running");
				}
			}
			return;
		}

		const alive = await tmux.isSessionAlive(session.tmuxSession);

		// Reconcile state: if session says active but tmux is dead, update.
		// We already filtered out completed/zombie states above, so if tmux is dead
		// this session needs to be marked as zombie.
		if (!alive) {
			store.updateState(spec.agentName, "zombie");
			store.updateLastActivity(spec.agentName);
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
			jsonOutput(`${spec.commandName} status`, status);
		} else {
			const stateLabel = alive ? "running" : session.state;
			process.stdout.write(`${spec.displayName}: ${stateLabel}\n`);
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

/**
 * Send a fire-and-forget message to the running coordinator.
 *
 * Sends a mail message (from: operator, type: dispatch) and auto-nudges the
 * coordinator via tmux sendKeys. Replaces the two-step `ov mail send + ov nudge` pattern.
 */
async function sendToPersistentAgent(
	spec: PersistentAgentSpec,
	body: string,
	opts: { subject: string; json: boolean },
	deps: CoordinatorDeps = {},
): Promise<void> {
	const tmux = deps._tmux ?? {
		createSession,
		isSessionAlive,
		checkSessionState,
		killSession,
		sendKeys,
		waitForTuiReady,
		ensureTmuxAvailable,
	};
	const nudge = deps._nudge ?? nudgeAgent;

	const { subject, json } = opts;
	const cwd = process.cwd();
	const config = await loadConfig(cwd);
	const projectRoot = config.project.root;

	const overstoryDir = join(projectRoot, ".overstory");
	const { store } = openSessionStore(overstoryDir);
	try {
		const session = store.getByName(spec.agentName);

		if (!isActivePersistentAgentSession(session, spec)) {
			throw new AgentError(`No active ${spec.commandName} session found`, {
				agentName: spec.agentName,
			});
		}

		const alive = await tmux.isSessionAlive(session.tmuxSession);
		if (!alive) {
			store.updateState(spec.agentName, "zombie");
			store.updateLastActivity(spec.agentName);
			throw new AgentError(
				`${spec.displayName} tmux session "${session.tmuxSession}" is not alive`,
				{
					agentName: spec.agentName,
				},
			);
		}

		// Send mail
		const mailDbPath = join(overstoryDir, "mail.db");
		const mailStore = createMailStore(mailDbPath);
		const mailClient = createMailClient(mailStore);
		let id: string;
		try {
			id = mailClient.send({
				from: "operator",
				to: spec.agentName,
				subject,
				body,
				type: "dispatch",
				priority: "normal",
			});
		} finally {
			mailClient.close();
		}

		// Auto-nudge (fire-and-forget)
		const nudgeMessage = `[DISPATCH] ${subject}: ${body.slice(0, 500)}`;
		let nudged = false;
		try {
			const nudgeResult = await nudge(projectRoot, spec.agentName, nudgeMessage, true);
			nudged = nudgeResult.delivered;
		} catch {
			// Nudge is fire-and-forget — silently ignore errors
		}

		if (json) {
			jsonOutput(`${spec.commandName} send`, { id, nudged });
		} else {
			printSuccess(`Sent to ${spec.commandName}`, id);
		}
	} finally {
		store.close();
	}
}

/**
 * Send a synchronous request to the coordinator and wait for a reply.
 *
 * Sends a mail message (from: operator, type: dispatch) with a correlationId,
 * auto-nudges the coordinator via tmux, then polls mail.db for a reply in the
 * same thread. Prints the reply body (or structured JSON) and exits.
 * Throws AgentError if no reply arrives before the timeout.
 */
export async function askCoordinator(
	body: string,
	opts: { subject: string; timeout: number; json: boolean },
	deps: CoordinatorDeps = {},
): Promise<void> {
	await askPersistentAgent(COORDINATOR_SPEC, body, opts, deps);
}

export async function askPersistentAgent(
	spec: PersistentAgentSpec,
	body: string,
	opts: { subject: string; timeout: number; json: boolean },
	deps: CoordinatorDeps = {},
): Promise<void> {
	const tmux = deps._tmux ?? {
		createSession,
		isSessionAlive,
		checkSessionState,
		killSession,
		sendKeys,
		waitForTuiReady,
		ensureTmuxAvailable,
	};
	const nudge = deps._nudge ?? nudgeAgent;
	const pollIntervalMs = deps._pollIntervalMs ?? ASK_POLL_INTERVAL_MS;

	const { subject, timeout, json } = opts;
	const cwd = process.cwd();
	const config = await loadConfig(cwd);
	const projectRoot = config.project.root;

	const overstoryDir = join(projectRoot, ".overstory");
	const { store } = openSessionStore(overstoryDir);
	try {
		const session = store.getByName(spec.agentName);

		if (!isActivePersistentAgentSession(session, spec)) {
			throw new AgentError(`No active ${spec.commandName} session found`, {
				agentName: spec.agentName,
			});
		}

		const alive = await tmux.isSessionAlive(session.tmuxSession);
		if (!alive) {
			store.updateState(spec.agentName, "zombie");
			store.updateLastActivity(spec.agentName);
			throw new AgentError(
				`${spec.displayName} tmux session "${session.tmuxSession}" is not alive`,
				{
					agentName: spec.agentName,
				},
			);
		}

		// Generate correlation ID for tracking this request/response pair
		const correlationId = crypto.randomUUID();

		// Send mail with correlationId in payload
		const mailDbPath = join(overstoryDir, "mail.db");
		const mailStore = createMailStore(mailDbPath);
		const mailClient = createMailClient(mailStore);
		let sentId: string;
		try {
			sentId = mailClient.send({
				from: "operator",
				to: spec.agentName,
				subject,
				body,
				type: "dispatch",
				priority: "normal",
				payload: JSON.stringify({ correlationId }),
			});
		} finally {
			mailClient.close();
		}

		// Auto-nudge (fire-and-forget)
		const nudgeMessage = `[ASK] ${subject}: ${body.slice(0, 500)}`;
		try {
			await nudge(projectRoot, spec.agentName, nudgeMessage, true);
		} catch {
			// Nudge is fire-and-forget — silently ignore errors
		}

		// Poll for a reply in the same thread
		const deadline = Date.now() + timeout * 1000;
		while (Date.now() < deadline) {
			await Bun.sleep(pollIntervalMs);
			// Open a fresh store connection each cycle so we see the latest committed writes
			const pollStore = createMailStore(mailDbPath);
			let reply: import("../types.ts").MailMessage | undefined;
			try {
				const replies = pollStore.getByThread(sentId);
				reply = replies.find((m) => m.from === spec.agentName && m.to === "operator");
			} finally {
				pollStore.close();
			}
			if (reply) {
				if (json) {
					jsonOutput(`${spec.commandName} ask`, {
						correlationId,
						sentId,
						replyId: reply.id,
						subject: reply.subject,
						body: reply.body,
						payload: reply.payload,
					});
				} else {
					process.stdout.write(`${reply.body}\n`);
				}
				return;
			}
		}

		throw new AgentError(
			`Timed out after ${timeout}s waiting for ${spec.commandName} reply (correlationId: ${correlationId})`,
			{ agentName: spec.agentName },
		);
	} finally {
		store.close();
	}
}

/**
 * Show recent coordinator tmux pane content without attaching.
 *
 * Wraps capturePaneContent() from tmux.ts. Supports --follow for continuous polling.
 */
async function outputPersistentAgent(
	spec: PersistentAgentSpec,
	opts: { follow: boolean; lines: number; interval: number; json: boolean },
	deps: CoordinatorDeps = {},
): Promise<void> {
	const tmux = deps._tmux ?? {
		createSession,
		isSessionAlive,
		checkSessionState,
		killSession,
		sendKeys,
		waitForTuiReady,
		ensureTmuxAvailable,
	};
	const capturePane = deps._capturePaneContent ?? capturePaneContent;

	const { follow, lines, interval, json } = opts;
	const cwd = process.cwd();
	const config = await loadConfig(cwd);
	const projectRoot = config.project.root;

	const overstoryDir = join(projectRoot, ".overstory");
	const { store } = openSessionStore(overstoryDir);
	try {
		const session = store.getByName(spec.agentName);

		if (!isActivePersistentAgentSession(session, spec)) {
			throw new AgentError(`No active ${spec.commandName} session found`, {
				agentName: spec.agentName,
			});
		}

		const alive = await tmux.isSessionAlive(session.tmuxSession);
		if (!alive) {
			store.updateState(spec.agentName, "zombie");
			store.updateLastActivity(spec.agentName);
			throw new AgentError(
				`${spec.displayName} tmux session "${session.tmuxSession}" is not alive`,
				{
					agentName: spec.agentName,
				},
			);
		}

		const tmuxSession = session.tmuxSession;

		if (follow) {
			// Set up SIGINT handler for clean exit
			let running = true;
			process.once("SIGINT", () => {
				running = false;
			});

			while (running) {
				const content = await capturePane(tmuxSession, lines);
				if (json) {
					jsonOutput(`${spec.commandName} output`, { content, lines });
				} else {
					process.stdout.write(content ?? "");
				}
				if (running) {
					await Bun.sleep(interval);
				}
			}
		} else {
			const content = await capturePane(tmuxSession, lines);
			if (json) {
				jsonOutput(`${spec.commandName} output`, { content, lines });
			} else {
				process.stdout.write(content ?? "");
			}
		}
	} finally {
		store.close();
	}
}

/** Per-trigger evaluation result for checkComplete. */
export interface TriggerResult {
	enabled: boolean;
	met: boolean;
	detail: string;
}

/** Result of `ov coordinator check-complete`. */
export interface CheckCompleteResult {
	complete: boolean;
	triggers: {
		allAgentsDone: TriggerResult;
		taskTrackerEmpty: TriggerResult;
		onShutdownSignal: TriggerResult;
	};
}

/**
 * Evaluate configured exit triggers and return per-trigger status.
 *
 * Logic:
 * - complete = true only if ALL enabled triggers are met
 * - No enabled triggers → complete: false (safety default)
 */
export async function checkComplete(
	opts: { json: boolean },
	deps?: CoordinatorDeps,
): Promise<CheckCompleteResult> {
	void deps; // reserved for future DI

	const config = await loadConfig(process.cwd());
	const triggers = config.coordinator?.exitTriggers ?? {
		allAgentsDone: false,
		taskTrackerEmpty: false,
		onShutdownSignal: false,
	};

	const result: CheckCompleteResult = {
		complete: false,
		triggers: {
			allAgentsDone: { enabled: triggers.allAgentsDone, met: false, detail: "" },
			taskTrackerEmpty: { enabled: triggers.taskTrackerEmpty, met: false, detail: "" },
			onShutdownSignal: { enabled: triggers.onShutdownSignal, met: false, detail: "" },
		},
	};

	// allAgentsDone: read current-run.txt, query SessionStore
	if (triggers.allAgentsDone) {
		const runIdPath = join(config.project.root, ".overstory", "current-run.txt");
		const runIdFile = Bun.file(runIdPath);
		if (await runIdFile.exists()) {
			const runId = (await runIdFile.text()).trim();
			const sessionsDb = join(config.project.root, ".overstory", "sessions.db");
			const store = createSessionStore(sessionsDb);
			try {
				const sessions = store.getByRun(runId);
				const agentSessions = sessions.filter((s) => s.capability !== "coordinator");
				let allDone =
					agentSessions.length > 0 && agentSessions.every((s) => s.state === "completed");
				const states = agentSessions.map((s) => `${s.agentName}:${s.state}`);

				// Also check the merge queue — agents may be "completed" but branches
				// not yet merged. This prevents premature issue closure when a builder
				// finishes but its lead hasn't merged yet (overstory-5c08).
				if (allDone) {
					const mergeQueuePath = join(config.project.root, ".overstory", "merge-queue.db");
					const mergeQueueFile = Bun.file(mergeQueuePath);
					if (await mergeQueueFile.exists()) {
						const { createMergeQueue } = await import("../merge/queue.ts");
						const queue = createMergeQueue(mergeQueuePath);
						try {
							const pending = queue.list("pending");
							if (pending.length > 0) {
								allDone = false;
								result.triggers.allAgentsDone.detail = `${pending.length} branch(es) pending merge: ${pending.map((e) => e.branchName).join(", ")}`;
							}
						} finally {
							queue.close();
						}
					}
				}

				result.triggers.allAgentsDone.met = allDone;
				if (result.triggers.allAgentsDone.detail === "") {
					result.triggers.allAgentsDone.detail = allDone
						? `All ${agentSessions.length} agents completed`
						: states.join(", ");
				}
			} finally {
				store.close();
			}
		} else {
			result.triggers.allAgentsDone.detail = "No current run found";
		}
	}

	// taskTrackerEmpty: shell out to tracker CLI
	if (triggers.taskTrackerEmpty) {
		try {
			const backend = await resolveBackend(config.taskTracker.backend, config.project.root);
			const cliName = trackerCliName(backend);
			const proc = Bun.spawn([cliName, "ready", "--json"], {
				cwd: config.project.root,
				stdout: "pipe",
				stderr: "pipe",
			});
			const exitCode = await proc.exited;
			const stdout = await new Response(proc.stdout).text();
			if (exitCode === 0) {
				try {
					const issues = JSON.parse(stdout.trim()) as unknown;
					const isEmpty = Array.isArray(issues) && issues.length === 0;
					result.triggers.taskTrackerEmpty.met = isEmpty;
					result.triggers.taskTrackerEmpty.detail = isEmpty
						? "No unblocked issues"
						: `${(issues as unknown[]).length} unblocked issue(s)`;
				} catch {
					const isEmpty = stdout.trim() === "" || stdout.trim() === "[]";
					result.triggers.taskTrackerEmpty.met = isEmpty;
					result.triggers.taskTrackerEmpty.detail = isEmpty
						? "No unblocked issues"
						: "Issues found";
				}
			} else {
				result.triggers.taskTrackerEmpty.detail = `Tracker command failed (exit ${exitCode})`;
			}
		} catch (err) {
			result.triggers.taskTrackerEmpty.detail = `Tracker error: ${err instanceof Error ? err.message : String(err)}`;
		}
	}

	// onShutdownSignal: check mail for shutdown messages to coordinator
	if (triggers.onShutdownSignal) {
		const mailDb = join(config.project.root, ".overstory", "mail.db");
		const mailStore = createMailStore(mailDb);
		try {
			const unread = mailStore.getUnread("coordinator");
			const shutdownMsg = unread.find((m) => m.subject.toLowerCase().includes("shutdown"));
			result.triggers.onShutdownSignal.met = shutdownMsg !== undefined;
			result.triggers.onShutdownSignal.detail = shutdownMsg
				? `Shutdown signal from ${shutdownMsg.from}: ${shutdownMsg.subject}`
				: "No shutdown signal received";
		} finally {
			mailStore.close();
		}
	}

	// Overall: complete only if ALL enabled triggers are met
	const enabledTriggers = Object.values(result.triggers).filter((t) => t.enabled);
	result.complete = enabledTriggers.length > 0 && enabledTriggers.every((t) => t.met);

	if (opts.json) {
		jsonOutput("coordinator check-complete", result as unknown as Record<string, unknown>);
	} else {
		for (const [name, trigger] of Object.entries(result.triggers)) {
			const status = !trigger.enabled ? "disabled" : trigger.met ? "MET" : "NOT MET";
			process.stdout.write(`  ${name}: ${status} — ${trigger.detail}\n`);
		}
		process.stdout.write(`\nComplete: ${result.complete ? "YES" : "NO"}\n`);
	}

	return result;
}

export function createPersistentAgentCommand(
	spec: PersistentAgentSpec,
	deps: CoordinatorDeps = {},
): Command {
	const cmd = new Command(spec.commandName).description(
		`Manage the persistent ${spec.commandName} agent`,
	);

	cmd
		.command("start")
		.description(`Start the ${spec.commandName} (spawns Claude Code at project root)`)
		.option("--attach", "Always attach to tmux session after start")
		.option("--no-attach", "Never attach to tmux session after start")
		.option("--watchdog", `Auto-start watchdog daemon with ${spec.commandName}`)
		.option("--monitor", `Auto-start the Tier 2 monitor agent alongside the ${spec.commandName}`)
		.option("--profile <name>", "Canopy profile to apply to spawned agents")
		.option("--workflow <name>", "Workflow profile alias: delivery or co-creation")
		.option("--json", "Output as JSON")
		.action(
			async (opts: {
				attach?: boolean;
				watchdog?: boolean;
				monitor?: boolean;
				json?: boolean;
				profile?: string;
				workflow?: string;
			}) => {
				// opts.attach = true if --attach, false if --no-attach, undefined if neither
				const shouldAttach = opts.attach !== undefined ? opts.attach : !!process.stdout.isTTY;
				await startPersistentAgent(
					spec,
					{
						json: opts.json ?? false,
						attach: shouldAttach,
						watchdog: opts.watchdog ?? false,
						monitor: opts.monitor ?? false,
						profile: opts.profile,
						workflow: opts.workflow,
					},
					deps,
				);
			},
		);

	cmd
		.command("stop")
		.description(`Stop the ${spec.commandName} (kills tmux session)`)
		.option("--json", "Output as JSON")
		.action(async (opts: { json?: boolean }) => {
			await stopPersistentAgent(spec, { json: opts.json ?? false }, deps);
		});

	cmd
		.command("status")
		.description(`Show ${spec.commandName} state`)
		.option("--json", "Output as JSON")
		.action(async (opts: { json?: boolean }) => {
			await statusPersistentAgent(spec, { json: opts.json ?? false }, deps);
		});

	cmd
		.command("send")
		.description(`Send a message to the ${spec.commandName} (fire-and-forget)`)
		.requiredOption("--body <text>", "Message body")
		.option("--subject <text>", "Message subject", "operator dispatch")
		.option("--json", "Output as JSON")
		.action(async (opts: { body: string; subject: string; json?: boolean }) => {
			await sendToPersistentAgent(
				spec,
				opts.body,
				{ subject: opts.subject, json: opts.json ?? false },
				deps,
			);
		});

	cmd
		.command("ask")
		.description(`Send a request to the ${spec.commandName} and wait for a reply`)
		.requiredOption("--body <text>", "Message body")
		.option("--subject <text>", "Message subject", "operator request")
		.option("--timeout <seconds>", "Timeout in seconds", String(ASK_DEFAULT_TIMEOUT_S))
		.option("--json", "Output as JSON")
		.action(async (opts: { body: string; subject: string; timeout?: string; json?: boolean }) => {
			await askPersistentAgent(
				spec,
				opts.body,
				{
					subject: opts.subject,
					timeout: Number.parseInt(opts.timeout ?? String(ASK_DEFAULT_TIMEOUT_S), 10),
					json: opts.json ?? false,
				},
				deps,
			);
		});

	cmd
		.command("output")
		.description(`Show recent ${spec.commandName} output (tmux pane content)`)
		.option("--follow, -f", "Continuously poll for new output")
		.option("--lines <n>", "Number of lines to capture", "50")
		.option("--interval <ms>", "Poll interval in milliseconds (with --follow)", "2000")
		.option("--json", "Output as JSON")
		.action(
			async (opts: { follow?: boolean; lines?: string; interval?: string; json?: boolean }) => {
				await outputPersistentAgent(
					spec,
					{
						follow: opts.follow ?? false,
						lines: Number.parseInt(opts.lines ?? "50", 10),
						interval: Number.parseInt(opts.interval ?? "2000", 10),
						json: opts.json ?? false,
					},
					deps,
				);
			},
		);

	return cmd;
}

/**
 * Create the Commander command for `ov coordinator`.
 */
export function createCoordinatorCommand(deps: CoordinatorDeps = {}): Command {
	const cmd = createPersistentAgentCommand(COORDINATOR_SPEC, deps);

	cmd
		.command("check-complete")
		.description("Evaluate exit triggers and report completion status")
		.option("--json", "Output as JSON")
		.action(async (opts: { json?: boolean }) => {
			await checkComplete({ json: opts.json ?? false }, deps);
		});

	return cmd;
}

export async function persistentAgentCommand(
	args: string[],
	spec: PersistentAgentSpec,
	deps: CoordinatorDeps = {},
): Promise<void> {
	const cmd = createPersistentAgentCommand(spec, deps);
	cmd.exitOverride();

	if (args.length === 0) {
		process.stdout.write(cmd.helpInformation());
		return;
	}

	try {
		await cmd.parseAsync(args, { from: "user" });
	} catch (err: unknown) {
		if (err && typeof err === "object" && "code" in err) {
			const code = (err as { code: string }).code;
			if (code === "commander.helpDisplayed" || code === "commander.version") {
				return;
			}
			if (code === "commander.unknownCommand") {
				const message = err instanceof Error ? err.message : String(err);
				throw new ValidationError(message, { field: "subcommand" });
			}
		}
		throw err;
	}
}

/**
 * Entry point for `ov coordinator <subcommand>`.
 *
 * @param args - CLI arguments after "coordinator"
 * @param deps - Optional dependency injection for testing (tmux)
 */
export async function coordinatorCommand(
	args: string[],
	deps: CoordinatorDeps = {},
): Promise<void> {
	const cmd = createCoordinatorCommand(deps);
	cmd.exitOverride();

	if (args.length === 0) {
		process.stdout.write(cmd.helpInformation());
		return;
	}

	try {
		await cmd.parseAsync(args, { from: "user" });
	} catch (err: unknown) {
		if (err && typeof err === "object" && "code" in err) {
			const code = (err as { code: string }).code;
			if (code === "commander.helpDisplayed" || code === "commander.version") {
				return;
			}
			if (code === "commander.unknownCommand") {
				const message = err instanceof Error ? err.message : String(err);
				throw new ValidationError(message, { field: "subcommand" });
			}
		}
		throw err;
	}
}

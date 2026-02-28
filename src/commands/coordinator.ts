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
import { getRuntime } from "../runtimes/registry.ts";
import { openSessionStore } from "../sessions/compat.ts";
import { createRunStore } from "../sessions/store.ts";
import { resolveBackend, trackerCliName } from "../tracker/factory.ts";
import type { AgentSession } from "../types.ts";
import { isProcessRunning } from "../watchdog/health.ts";
import { resolveContext } from "../workspace/resolver.ts";
import {
	createSession,
	ensureTmuxAvailable,
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
		"HIERARCHY: You ONLY spawn leads (ov sling --capability lead). Leads spawn scouts, builders, reviewers. NEVER spawn non-lead agents directly.",
		"DELEGATION: For any exploration/scouting, spawn a lead who will spawn scouts. Do NOT explore the codebase yourself beyond initial planning.",
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

async function startCoordinator(
	opts: { json: boolean; attach: boolean; watchdog: boolean; monitor: boolean; project?: string },
	deps: CoordinatorDeps = {},
): Promise<void> {
	const tmux = deps._tmux ?? {
		createSession,
		isSessionAlive,
		killSession,
		sendKeys,
		waitForTuiReady,
		ensureTmuxAvailable,
	};

	const { json, attach: shouldAttach, watchdog: watchdogFlag, monitor: monitorFlag } = opts;

	if (isRunningAsRoot()) {
		throw new AgentError(
			"Cannot spawn agents as root (UID 0). The claude CLI rejects --permission-mode bypassPermissions when run as root, causing the tmux session to die immediately. Run overstory as a non-root user.",
		);
	}

	const ctx = await resolveContext({ project: opts.project, requireProject: true });
	const projectRoot = ctx.projectRoot;
	const dbRoot = ctx.dbRoot;
	const config = await loadConfig(projectRoot);
	const watchdog = deps._watchdog ?? createDefaultWatchdog(projectRoot);
	const monitor = deps._monitor ?? createDefaultMonitor(projectRoot);
	const tmuxSession = coordinatorTmuxSession(config.project.name);

	// Check for existing coordinator
	const { store } = openSessionStore(dbRoot);
	try {
		const existing = store.getByName(COORDINATOR_NAME, ctx.projectId);

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
			store.updateState(COORDINATOR_NAME, "completed", ctx.projectId);
		}

		// Resolve model and runtime early (needed for deployConfig and spawn)
		const manifestLoader = createManifestLoader(
			join(projectRoot, config.agents.manifestPath),
			join(projectRoot, config.agents.baseDir),
		);
		const manifest = await manifestLoader.load();
		const resolvedModel = resolveModel(config, manifest, "coordinator", "opus");
		const runtime = getRuntime(undefined, config);

		// Deploy hooks to the project root so the coordinator gets event logging,
		// mail check --inject, and activity tracking via the standard hook pipeline.
		// The ENV_GUARD prefix on all hooks (both template and generated guards)
		// ensures they only activate when OVERSTORY_AGENT_NAME is set (i.e. for
		// the coordinator's tmux session), so the user's own Claude Code session
		// at the project root is unaffected.
		await runtime.deployConfig(projectRoot, undefined, {
			agentName: COORDINATOR_NAME,
			capability: "coordinator",
			worktreePath: projectRoot,
		});

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
		const agentDefPath = join(projectRoot, ".overstory", "agent-defs", "coordinator.md");
		const agentDefFile = Bun.file(agentDefPath);
		let appendSystemPromptFile: string | undefined;
		if (await agentDefFile.exists()) {
			appendSystemPromptFile = agentDefPath;
		}
		const spawnCmd = runtime.buildSpawnCommand({
			model: resolvedModel.model,
			permissionMode: "bypass",
			cwd: projectRoot,
			appendSystemPromptFile,
			env: {
				...runtime.buildEnv(resolvedModel),
				OVERSTORY_AGENT_NAME: COORDINATOR_NAME,
			},
		});
		const pid = await tmux.createSession(tmuxSession, projectRoot, spawnCmd, {
			...runtime.buildEnv(resolvedModel),
			OVERSTORY_AGENT_NAME: COORDINATOR_NAME,
			OVERSTORY_PROJECT_ID: ctx.projectId,
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
			taskId: "", // No specific task assignment
			tmuxSession,
			state: "booting",
			pid,
			parentAgent: null, // Top of hierarchy
			depth: 0,
			runId: null,
			projectId: ctx.projectId,
			startedAt: new Date().toISOString(),
			lastActivity: new Date().toISOString(),
			escalationLevel: 0,
			stalledSince: null,
			transcriptPath: null,
		};

		store.upsert(session, ctx.projectId);

		// Wait for Claude Code TUI to render before sending input
		const tuiReady = await tmux.waitForTuiReady(tmuxSession, (content) =>
			runtime.detectReady(content),
		);
		if (!tuiReady) {
			// Session may have died — check liveness before proceeding
			const alive = await tmux.isSessionAlive(tmuxSession);
			if (!alive) {
				// Clean up the stale session record
				store.updateState(COORDINATOR_NAME, "completed", ctx.projectId);
				throw new AgentError(
					`Coordinator tmux session "${tmuxSession}" died during startup. The Claude Code process may have crashed or exited immediately. Check tmux logs or try running the claude command manually.`,
					{ agentName: COORDINATOR_NAME },
				);
			}
			// Session is alive but TUI didn't render in time — proceed with warning
		}
		await Bun.sleep(1_000);

		const resolvedBackend = await resolveBackend(config.taskTracker.backend, config.project.root);
		const trackerCli = trackerCliName(resolvedBackend);
		const beacon = buildCoordinatorBeacon(trackerCli);
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
			agentName: COORDINATOR_NAME,
			capability: "coordinator",
			tmuxSession,
			projectRoot,
			pid,
			watchdog: watchdogFlag ? watchdogPid !== undefined : false,
			monitor: monitorFlag ? monitorPid !== undefined : false,
		};

		if (json) {
			jsonOutput("coordinator start", output);
		} else {
			printSuccess("Coordinator started");
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
async function stopCoordinator(
	opts: { json: boolean; project?: string },
	deps: CoordinatorDeps = {},
): Promise<void> {
	const tmux = deps._tmux ?? {
		createSession,
		isSessionAlive,
		killSession,
		sendKeys,
		waitForTuiReady,
		ensureTmuxAvailable,
	};

	const { json } = opts;
	const ctx = await resolveContext({ project: opts.project, requireProject: true });
	const projectRoot = ctx.projectRoot;
	const dbRoot = ctx.dbRoot;
	const watchdog = deps._watchdog ?? createDefaultWatchdog(projectRoot);
	const monitor = deps._monitor ?? createDefaultMonitor(projectRoot);

	const overstoryDir = join(projectRoot, ".overstory");
	const { store } = openSessionStore(dbRoot);
	try {
		const session = store.getByName(COORDINATOR_NAME, ctx.projectId);

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
		store.updateState(COORDINATOR_NAME, "completed", ctx.projectId);
		store.updateLastActivity(COORDINATOR_NAME, ctx.projectId);

		// Auto-complete the current run
		let runCompleted = false;
		try {
			const currentRunPath = join(overstoryDir, "current-run.txt");
			const currentRunFile = Bun.file(currentRunPath);
			if (await currentRunFile.exists()) {
				const runId = (await currentRunFile.text()).trim();
				if (runId.length > 0) {
					const runStore = createRunStore(join(dbRoot, "sessions.db"));
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
			jsonOutput("coordinator stop", {
				stopped: true,
				sessionId: session.id,
				watchdogStopped,
				monitorStopped,
				runCompleted,
			});
		} else {
			printSuccess("Coordinator stopped", session.id);
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
async function statusCoordinator(
	opts: { json: boolean; project?: string },
	deps: CoordinatorDeps = {},
): Promise<void> {
	const tmux = deps._tmux ?? {
		createSession,
		isSessionAlive,
		killSession,
		sendKeys,
		waitForTuiReady,
		ensureTmuxAvailable,
	};

	const { json } = opts;
	const ctx = await resolveContext({ project: opts.project, requireProject: true });
	const projectRoot = ctx.projectRoot;
	const dbRoot = ctx.dbRoot;
	const watchdog = deps._watchdog ?? createDefaultWatchdog(projectRoot);
	const monitor = deps._monitor ?? createDefaultMonitor(projectRoot);

	const { store } = openSessionStore(dbRoot);
	try {
		const session = store.getByName(COORDINATOR_NAME, ctx.projectId);
		const watchdogRunning = await watchdog.isRunning();
		const monitorRunning = await monitor.isRunning();

		if (
			!session ||
			session.capability !== "coordinator" ||
			session.state === "completed" ||
			session.state === "zombie"
		) {
			if (json) {
				jsonOutput("coordinator status", { running: false, watchdogRunning, monitorRunning });
			} else {
				printHint("Coordinator is not running");
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
			store.updateState(COORDINATOR_NAME, "zombie", ctx.projectId);
			store.updateLastActivity(COORDINATOR_NAME, ctx.projectId);
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
			jsonOutput("coordinator status", status);
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

/**
 * Create the Commander command for `ov coordinator`.
 */
export function createCoordinatorCommand(deps: CoordinatorDeps = {}): Command {
	const cmd = new Command("coordinator").description("Manage the persistent coordinator agent");

	cmd
		.command("start")
		.description("Start the coordinator (spawns Claude Code at project root)")
		.option("--attach", "Always attach to tmux session after start")
		.option("--no-attach", "Never attach to tmux session after start")
		.option("--watchdog", "Auto-start watchdog daemon with coordinator")
		.option("--monitor", "Auto-start Tier 2 monitor agent with coordinator")
		.option("-p, --project <name>", "Target project (workspace mode)")
		.option("--json", "Output as JSON")
		.action(
			async (opts: {
				attach?: boolean;
				watchdog?: boolean;
				monitor?: boolean;
				project?: string;
				json?: boolean;
			}) => {
				// opts.attach = true if --attach, false if --no-attach, undefined if neither
				const shouldAttach = opts.attach !== undefined ? opts.attach : !!process.stdout.isTTY;
				await startCoordinator(
					{
						json: opts.json ?? false,
						attach: shouldAttach,
						watchdog: opts.watchdog ?? false,
						monitor: opts.monitor ?? false,
						project: opts.project,
					},
					deps,
				);
			},
		);

	cmd
		.command("stop")
		.description("Stop the coordinator (kills tmux session)")
		.option("-p, --project <name>", "Target project (workspace mode)")
		.option("--json", "Output as JSON")
		.action(async (opts: { project?: string; json?: boolean }) => {
			await stopCoordinator({ json: opts.json ?? false, project: opts.project }, deps);
		});

	cmd
		.command("status")
		.description("Show coordinator state")
		.option("-p, --project <name>", "Target project (workspace mode)")
		.option("--json", "Output as JSON")
		.action(async (opts: { project?: string; json?: boolean }) => {
			await statusCoordinator({ json: opts.json ?? false, project: opts.project }, deps);
		});

	return cmd;
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

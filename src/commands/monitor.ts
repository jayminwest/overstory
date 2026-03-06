/**
 * CLI command: ov monitor start|stop|status
 *
 * Manages the persistent Tier 2 monitor agent lifecycle. The monitor runs
 * at the project root (NOT in a worktree), continuously patrols the agent
 * fleet, sends nudges to stalled agents, and reports health summaries to
 * the coordinator.
 *
 * Unlike regular agents spawned by sling, the monitor:
 * - Has no worktree (operates on the main working tree)
 * - Has no task assignment (it monitors, not implements)
 * - Has no overlay CLAUDE.md (context comes via ov status + mail)
 * - Persists across patrol cycles
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Command } from "commander";
import { createIdentity, loadIdentity } from "../agents/identity.ts";
import { createManifestLoader, resolveModel } from "../agents/manifest.ts";
import { loadConfig } from "../config.ts";
import { AgentError, ValidationError } from "../errors.ts";
import { jsonOutput } from "../json.ts";
import { printHint, printSuccess } from "../logging/color.ts";
import { getRuntime } from "../runtimes/registry.ts";
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
		`Startup: run mulch prime, check fleet (ov status --json), check mail (ov mail check --agent ${MONITOR_NAME}), then begin patrol loop`,
	];
	return parts.join(" — ");
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
async function startMonitor(opts: { json: boolean; attach: boolean }): Promise<void> {
	const { json, attach: shouldAttach } = opts;

	if (isRunningAsRoot()) {
		throw new AgentError(
			"Cannot spawn agents as root (UID 0). The claude CLI rejects --permission-mode bypassPermissions when run as root, causing the tmux session to die immediately. Run overstory as a non-root user.",
		);
	}

	const cwd = process.cwd();
	const config = await loadConfig(cwd);

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

		// Resolve model and runtime early (needed for deployConfig and spawn)
		const manifestLoader = createManifestLoader(
			join(projectRoot, config.agents.manifestPath),
			join(projectRoot, config.agents.baseDir),
		);
		const manifest = await manifestLoader.load();
		const resolvedModel = resolveModel(config, manifest, "monitor", "sonnet");
		const runtime = getRuntime(undefined, config, "monitor");

		// Deploy monitor-specific hooks to the project root's .claude/ directory.
		await runtime.deployConfig(projectRoot, undefined, {
			agentName: MONITOR_NAME,
			capability: "monitor",
			worktreePath: projectRoot,
		});

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

		// Spawn tmux session at project root with Claude Code (interactive mode).
		// Pass file path (not content) to avoid tmux "command too long" (overstory#45).
		const agentDefPath = join(projectRoot, ".overstory", "agent-defs", "monitor.md");
		const agentDefFile = Bun.file(agentDefPath);
		let appendSystemPromptFile: string | undefined;
		if (await agentDefFile.exists()) {
			appendSystemPromptFile = agentDefPath;
		}
		const sessionId = crypto.randomUUID();
		const spawnCmd = runtime.buildSpawnCommand({
			model: resolvedModel.model,
			permissionMode: "bypass",
			sessionId,
			cwd: projectRoot,
			appendSystemPromptFile,
			env: {
				...runtime.buildEnv(resolvedModel),
				OVERSTORY_AGENT_NAME: MONITOR_NAME,
			},
		});
		const pid = await createSession(tmuxSession, projectRoot, spawnCmd, {
			...runtime.buildEnv(resolvedModel),
			OVERSTORY_AGENT_NAME: MONITOR_NAME,
		});

		// Record session BEFORE sending the beacon so that hook-triggered
		// updateLastActivity() can find the entry and transition booting->working.
		const session: AgentSession = {
			id: sessionId,
			agentName: MONITOR_NAME,
			capability: "monitor",
			runtime: runtime.id,
			worktreePath: projectRoot, // Monitor uses project root, not a worktree
			branchName: config.project.canonicalBranch, // Operates on canonical branch
			taskId: "", // No specific task assignment
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
			rateLimitedSince: null,
			transcriptPath: null,
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
			jsonOutput("monitor start", output);
		} else {
			printSuccess("Monitor started");
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
async function stopMonitor(opts: { json: boolean }): Promise<void> {
	const { json } = opts;
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
			jsonOutput("monitor stop", { stopped: true, sessionId: session.id });
		} else {
			printSuccess("Monitor stopped", session.id);
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
async function statusMonitor(opts: { json: boolean }): Promise<void> {
	const { json } = opts;
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
				jsonOutput("monitor status", { running: false });
			} else {
				printHint("Monitor is not running");
			}
			return;
		}

		const alive = await isSessionAlive(session.tmuxSession);

		// Reconcile state: if session says active but tmux is dead, update.
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
			jsonOutput("monitor status", status);
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

export function createMonitorCommand(): Command {
	const cmd = new Command("monitor").description("Manage the persistent Tier 2 monitor agent");

	cmd
		.command("start")
		.description("Start the monitor (spawns Claude Code at project root)")
		.option("--attach", "Always attach to tmux session after start")
		.option("--no-attach", "Never attach to tmux session after start")
		.option("--json", "Output as JSON")
		.action(async (opts: { attach?: boolean; json?: boolean }) => {
			// opts.attach = true if --attach, false if --no-attach, undefined if neither
			const shouldAttach = opts.attach !== undefined ? opts.attach : !!process.stdout.isTTY;
			await startMonitor({ json: opts.json ?? false, attach: shouldAttach });
		});

	cmd
		.command("stop")
		.description("Stop the monitor (kills tmux session)")
		.option("--json", "Output as JSON")
		.action(async (opts: { json?: boolean }) => {
			await stopMonitor({ json: opts.json ?? false });
		});

	cmd
		.command("status")
		.description("Show monitor state")
		.option("--json", "Output as JSON")
		.action(async (opts: { json?: boolean }) => {
			await statusMonitor({ json: opts.json ?? false });
		});

	return cmd;
}

/**
 * Entry point for `ov monitor <subcommand>`.
 */
export async function monitorCommand(args: string[]): Promise<void> {
	const cmd = createMonitorCommand();
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

/**
 * CLI command: ov supervisor start|stop|status
 *
 * Manages per-project supervisor agent lifecycle. The supervisor is a persistent
 * agent that runs at the project root (NOT in a worktree), assigned to a specific
 * task, and operates at depth 1 (between coordinator and leaf workers).
 *
 * Unlike the coordinator:
 * - Has a task assignment (required via --task flag)
 * - Has a parent agent (typically "coordinator")
 * - Has depth 1 (default)
 * - Multiple supervisors can run concurrently (distinguished by --name)
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
import { createTrackerClient, resolveBackend, trackerCliName } from "../tracker/factory.ts";
import type { AgentSession } from "../types.ts";
import { getSessionManager } from "../worktree/session-factory.ts";
import { isRunningAsRoot } from "./sling.ts";

/**
 * Build the supervisor startup beacon.
 *
 * @param opts.name - Supervisor agent name
 * @param opts.taskId - Bead task ID
 * @param opts.depth - Hierarchy depth (default 1)
 * @param opts.parent - Parent agent name (default "coordinator")
 */
export function buildSupervisorBeacon(opts: {
	name: string;
	taskId: string;
	depth: number;
	parent: string;
	trackerCli?: string;
}): string {
	const cli = opts.trackerCli ?? "bd";
	const timestamp = new Date().toISOString();
	const parts = [
		`[OVERSTORY] ${opts.name} (supervisor) ${timestamp} task:${opts.taskId}`,
		`Depth: ${opts.depth} | Parent: ${opts.parent} | Role: per-project supervisor`,
		`Startup: run mulch prime, check mail (ov mail check --agent ${opts.name}), read task (${cli} show ${opts.taskId}), then begin supervising`,
	];
	return parts.join(" — ");
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
async function startSupervisor(opts: {
	task: string;
	name: string;
	parent: string;
	depth: number;
	json: boolean;
}): Promise<void> {
	if (!opts.task) {
		throw new ValidationError("--task <task-id> is required", {
			field: "task",
			value: opts.task,
		});
	}
	if (!opts.name) {
		throw new ValidationError("--name <name> is required", {
			field: "name",
			value: opts.name,
		});
	}

	if (isRunningAsRoot()) {
		throw new AgentError(
			"Cannot spawn agents as root (UID 0). The claude CLI rejects --permission-mode bypassPermissions when run as root, causing the tmux session to die immediately. Run overstory as a non-root user.",
		);
	}

	const cwd = process.cwd();
	const config = await loadConfig(cwd);
	const projectRoot = config.project.root;

	// Validate task exists and is workable (open or in_progress)
	const resolvedBackend = await resolveBackend(config.taskTracker.backend, projectRoot);
	const tracker = createTrackerClient(resolvedBackend, projectRoot);
	const issue = await tracker.show(opts.task);
	if (issue.status !== "open" && issue.status !== "in_progress") {
		throw new ValidationError(`Task ${opts.task} is not workable (status: ${issue.status})`, {
			field: "task",
			value: opts.task,
		});
	}

	// Check for existing supervisor with same name
	const overstoryDir = join(projectRoot, ".overstory");
	const { store } = openSessionStore(overstoryDir);
	try {
		const sm = await getSessionManager();
		const existing = store.getByName(opts.name);

		if (
			existing &&
			existing.capability === "supervisor" &&
			existing.state !== "completed" &&
			existing.state !== "zombie"
		) {
			const alive = await sm.isSessionAlive(existing.tmuxSession);
			if (alive) {
				throw new AgentError(
					`Supervisor '${opts.name}' is already running (tmux: ${existing.tmuxSession}, since: ${existing.startedAt})`,
					{ agentName: opts.name },
				);
			}
			// Session recorded but tmux is dead — mark as completed and continue
			store.updateState(opts.name, "completed");
		}

		// Resolve model and runtime early (needed for deployConfig and spawn)
		const manifestLoader = createManifestLoader(
			join(projectRoot, config.agents.manifestPath),
			join(projectRoot, config.agents.baseDir),
		);
		const manifest = await manifestLoader.load();
		const resolvedModel = resolveModel(config, manifest, "supervisor", "opus");
		const runtime = getRuntime(undefined, config);

		// Deploy supervisor-specific hooks to the project root's .claude/ directory.
		await runtime.deployConfig(projectRoot, undefined, {
			agentName: opts.name,
			capability: "supervisor",
			worktreePath: projectRoot,
		});

		// Create supervisor identity if first run
		const identityBaseDir = join(projectRoot, ".overstory", "agents");
		await mkdir(identityBaseDir, { recursive: true });
		const existingIdentity = await loadIdentity(identityBaseDir, opts.name);
		if (!existingIdentity) {
			await createIdentity(identityBaseDir, {
				name: opts.name,
				capability: "supervisor",
				created: new Date().toISOString(),
				sessionsCompleted: 0,
				expertiseDomains: config.mulch.enabled ? config.mulch.domains : [],
				recentTasks: [],
			});
		}

		// Spawn tmux session at project root with Claude Code (interactive mode).
		// Inject the supervisor base definition via --append-system-prompt.
		// Pass file path (not content) to avoid tmux "command too long" (overstory#45).
		const tmuxSession = `overstory-${config.project.name}-supervisor-${opts.name}`;
		const agentDefPath = join(projectRoot, ".overstory", "agent-defs", "supervisor.md");
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
				OVERSTORY_AGENT_NAME: opts.name,
			},
		});
		const pid = await sm.createSession(tmuxSession, projectRoot, spawnCmd, {
			...runtime.buildEnv(resolvedModel),
			OVERSTORY_AGENT_NAME: opts.name,
		});

		// Wait for Claude Code TUI to render before sending input
		await sm.waitForTuiReady(tmuxSession, (content) => runtime.detectReady(content));
		await Bun.sleep(1_000);

		const beacon = buildSupervisorBeacon({
			name: opts.name,
			taskId: opts.task,
			depth: opts.depth,
			parent: opts.parent,
			trackerCli: trackerCliName(resolvedBackend),
		});
		await sm.sendKeys(tmuxSession, beacon);

		// Follow-up Enters with increasing delays to ensure submission
		for (const delay of [1_000, 2_000, 3_000, 5_000]) {
			await Bun.sleep(delay);
			await sm.sendKeys(tmuxSession, "");
		}

		// Record session
		const session: AgentSession = {
			id: `session-${Date.now()}-${opts.name}`,
			agentName: opts.name,
			capability: "supervisor",
			worktreePath: projectRoot, // Supervisor uses project root, not a worktree
			branchName: config.project.canonicalBranch, // Operates on canonical branch
			taskId: opts.task,
			tmuxSession,
			state: "booting",
			pid,
			parentAgent: opts.parent,
			depth: opts.depth,
			runId: null,
			startedAt: new Date().toISOString(),
			lastActivity: new Date().toISOString(),
			escalationLevel: 0,
			stalledSince: null,
			transcriptPath: null,
		};

		store.upsert(session);

		const output = {
			agentName: opts.name,
			capability: "supervisor",
			tmuxSession,
			projectRoot,
			taskId: opts.task,
			parent: opts.parent,
			depth: opts.depth,
			pid,
		};

		if (opts.json) {
			jsonOutput("supervisor start", output);
		} else {
			printSuccess("Supervisor started", opts.name);
			process.stdout.write(`  Tmux:    ${tmuxSession}\n`);
			process.stdout.write(`  Root:    ${projectRoot}\n`);
			process.stdout.write(`  Task:    ${opts.task}\n`);
			process.stdout.write(`  Parent:  ${opts.parent}\n`);
			process.stdout.write(`  Depth:   ${opts.depth}\n`);
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
async function stopSupervisor(opts: { name: string; json: boolean }): Promise<void> {
	if (!opts.name) {
		throw new ValidationError("--name <name> is required", {
			field: "name",
			value: opts.name,
		});
	}

	const cwd = process.cwd();
	const config = await loadConfig(cwd);
	const projectRoot = config.project.root;

	const overstoryDir = join(projectRoot, ".overstory");
	const { store } = openSessionStore(overstoryDir);
	try {
		const session = store.getByName(opts.name);

		if (
			!session ||
			session.capability !== "supervisor" ||
			session.state === "completed" ||
			session.state === "zombie"
		) {
			throw new AgentError(`No active supervisor session found for '${opts.name}'`, {
				agentName: opts.name,
			});
		}

		// Kill tmux session with process tree cleanup
		const sm = await getSessionManager();
		const alive = await sm.isSessionAlive(session.tmuxSession);
		if (alive) {
			await sm.killSession(session.tmuxSession);
		}

		// Update session state
		store.updateState(opts.name, "completed");
		store.updateLastActivity(opts.name);

		if (opts.json) {
			jsonOutput("supervisor stop", { stopped: true, sessionId: session.id });
		} else {
			printSuccess("Supervisor stopped", opts.name);
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
async function statusSupervisor(opts: { name?: string; json: boolean }): Promise<void> {
	const cwd = process.cwd();
	const config = await loadConfig(cwd);
	const projectRoot = config.project.root;

	const overstoryDir = join(projectRoot, ".overstory");
	const { store } = openSessionStore(overstoryDir);
	try {
		const sm = await getSessionManager();
		if (opts.name) {
			// Show specific supervisor
			const session = store.getByName(opts.name);

			if (
				!session ||
				session.capability !== "supervisor" ||
				session.state === "completed" ||
				session.state === "zombie"
			) {
				if (opts.json) {
					jsonOutput("supervisor status", { running: false });
				} else {
					printHint("Supervisor not running");
				}
				return;
			}

			const alive = await sm.isSessionAlive(session.tmuxSession);

			// Reconcile state: we already filtered out completed/zombie above,
			// so if tmux is dead this session needs to be marked as zombie.
			if (!alive) {
				store.updateState(opts.name, "zombie");
				store.updateLastActivity(opts.name);
				session.state = "zombie";
			}

			const status = {
				running: alive,
				sessionId: session.id,
				agentName: session.agentName,
				state: session.state,
				tmuxSession: session.tmuxSession,
				taskId: session.taskId,
				parentAgent: session.parentAgent,
				depth: session.depth,
				pid: session.pid,
				startedAt: session.startedAt,
				lastActivity: session.lastActivity,
			};

			if (opts.json) {
				jsonOutput("supervisor status", status);
			} else {
				const stateLabel = alive ? "running" : session.state;
				process.stdout.write(`Supervisor '${opts.name}': ${stateLabel}\n`);
				process.stdout.write(`  Session:   ${session.id}\n`);
				process.stdout.write(`  Tmux:      ${session.tmuxSession}\n`);
				process.stdout.write(`  Task:      ${session.taskId}\n`);
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
				if (opts.json) {
					jsonOutput("supervisor status", { supervisors: [] });
				} else {
					printHint("No supervisor sessions found");
				}
				return;
			}

			const statuses = await Promise.all(
				supervisors.map(async (session) => {
					const alive = await sm.isSessionAlive(session.tmuxSession);

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
						taskId: session.taskId,
						parentAgent: session.parentAgent,
						depth: session.depth,
						startedAt: session.startedAt,
					};
				}),
			);

			if (opts.json) {
				jsonOutput("supervisor status", { supervisors: statuses });
			} else {
				process.stdout.write("Supervisor sessions:\n");
				for (const status of statuses) {
					const stateLabel = status.running ? "running" : status.state;
					process.stdout.write(
						`  ${status.agentName}: ${stateLabel} (task: ${status.taskId}, parent: ${status.parentAgent})\n`,
					);
				}
			}
		}
	} finally {
		store.close();
	}
}

/**
 * Create the Commander command for `ov supervisor`.
 */
export function createSupervisorCommand(): Command {
	const cmd = new Command("supervisor").description("[DEPRECATED] Per-project supervisor agent");

	cmd
		.command("start")
		.description("Start a supervisor (spawns Claude Code at project root)")
		.requiredOption("--task <task-id>", "Task ID (required)")
		.requiredOption("--name <name>", "Unique supervisor name (required)")
		.option("--parent <agent>", "Parent agent name", "coordinator")
		.option("--depth <n>", "Hierarchy depth", "1")
		.option("--json", "Output as JSON")
		.action(
			async (opts: {
				task: string;
				name: string;
				parent: string;
				depth: string;
				json?: boolean;
			}) => {
				console.error(
					"[DEPRECATED] ov supervisor is deprecated. Use 'ov sling --capability lead' instead.",
				);
				await startSupervisor({
					task: opts.task,
					name: opts.name,
					parent: opts.parent,
					depth: Number.parseInt(opts.depth, 10),
					json: opts.json ?? false,
				});
			},
		);

	cmd
		.command("stop")
		.description("Stop a supervisor (kills tmux session)")
		.requiredOption("--name <name>", "Supervisor name to stop (required)")
		.option("--json", "Output as JSON")
		.action(async (opts: { name: string; json?: boolean }) => {
			await stopSupervisor({ name: opts.name, json: opts.json ?? false });
		});

	cmd
		.command("status")
		.description("Show supervisor state")
		.option("--name <name>", "Show specific supervisor (optional, lists all if omitted)")
		.option("--json", "Output as JSON")
		.action(async (opts: { name?: string; json?: boolean }) => {
			await statusSupervisor({ name: opts.name, json: opts.json ?? false });
		});

	return cmd;
}

/**
 * Entry point for `ov supervisor <subcommand>`.
 */
export async function supervisorCommand(args: string[]): Promise<void> {
	const cmd = createSupervisorCommand();
	cmd.exitOverride();
	cmd.configureOutput({ writeErr: () => {} });
	for (const sub of cmd.commands) {
		sub.exitOverride();
		sub.configureOutput({ writeErr: () => {} });
	}

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

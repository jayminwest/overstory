/**
 * CLI command: ov workspace <subcommand>
 *
 * Subcommands for multi-repo workspace management (Phase 2B).
 * Phase 2A (config loader, resolver, types) is in src/workspace/config.ts.
 */

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { Command } from "commander";
import { deployHooks } from "../agents/hooks-deployer.ts";
import { createIdentity, loadIdentity } from "../agents/identity.ts";
import { createManifestLoader, resolveModel } from "../agents/manifest.ts";
import { AgentError, ValidationError } from "../errors.ts";
import { openSessionStore } from "../sessions/compat.ts";
import type { AgentSession, WorkspaceProject } from "../types.ts";
import {
	loadWorkspaceConfig,
	resolveWorkspaceRoot,
	WORKSPACE_CONFIG_FILENAME,
	WORKSPACE_DIR,
	WORKSPACE_PROJECT_ID,
} from "../workspace/config.ts";
import {
	createSession,
	ensureTmuxAvailable,
	isSessionAlive,
	killSession,
	sendKeys,
	waitForTuiReady,
} from "../worktree/tmux.ts";
import { isRunningAsRoot } from "./sling.ts";

// === Helpers ===

/**
 * Detect the canonical branch name from git.
 * Mirrors detectCanonicalBranch in src/commands/init.ts.
 */
async function detectCanonicalBranch(root: string): Promise<string> {
	try {
		const proc = Bun.spawn(["git", "symbolic-ref", "refs/remotes/origin/HEAD"], {
			cwd: root,
			stdout: "pipe",
			stderr: "pipe",
		});
		const exitCode = await proc.exited;
		if (exitCode === 0) {
			const ref = (await new Response(proc.stdout).text()).trim();
			const branch = ref.split("/").pop();
			if (branch) return branch;
		}
	} catch {
		// Not available
	}

	try {
		const proc = Bun.spawn(["git", "branch", "--show-current"], {
			cwd: root,
			stdout: "pipe",
			stderr: "pipe",
		});
		const exitCode = await proc.exited;
		if (exitCode === 0) {
			const branch = (await new Response(proc.stdout).text()).trim();
			if (branch) return branch;
		}
	} catch {
		// Not available
	}

	return "main";
}

/**
 * Serialize workspace configuration to YAML format.
 *
 * Produces a minimal, human-readable workspace.yaml with a comment header,
 * the workspace name, and a projects array (or `projects: []` for empty).
 */
export function serializeWorkspaceYaml(name: string, projects: WorkspaceProject[]): string {
	const lines: string[] = ["# Overstory workspace configuration", `name: ${name}`];

	if (projects.length === 0) {
		lines.push("projects: []");
	} else {
		lines.push("projects:");
		for (const p of projects) {
			lines.push(`  - name: ${p.name}`);
			lines.push(`    root: ${p.root}`);
			lines.push(`    canonicalBranch: ${p.canonicalBranch}`);
		}
	}

	return `${lines.join("\n")}\n`;
}

/**
 * Read workspace name and projects from config, handling the `projects: []` case.
 *
 * loadWorkspaceConfig() rejects empty projects arrays. When the config has
 * `projects: []`, we parse the workspace name from raw YAML text and return
 * an empty projects array.
 */
async function loadConfigOrEmpty(wsRoot: string): Promise<{
	workspaceName: string;
	projects: WorkspaceProject[];
	maxConcurrentTotal: number;
	maxDepth: number;
}> {
	const configPath = join(wsRoot, WORKSPACE_DIR, WORKSPACE_CONFIG_FILENAME);
	const rawText = await Bun.file(configPath).text();

	if (/projects:\s*\[\]/.test(rawText)) {
		const nameMatch = rawText.match(/^name:\s*(.+)$/m);
		const workspaceName = nameMatch?.[1]?.trim() ?? basename(wsRoot);
		return { workspaceName, projects: [], maxConcurrentTotal: 25, maxDepth: 4 };
	}

	const config = await loadWorkspaceConfig(wsRoot);
	return {
		workspaceName: config.name,
		projects: config.projects,
		maxConcurrentTotal: config.maxConcurrentTotal,
		maxDepth: config.maxDepth,
	};
}

// === Command Handlers ===

export interface WorkspaceInitOptions {
	name?: string;
}

/**
 * ov workspace init [--name <name>]
 *
 * Creates .overstory-workspace/ in cwd with workspace.yaml skeleton,
 * subdirectories, and .gitignore.
 */
export async function workspaceInitCommand(opts: WorkspaceInitOptions): Promise<void> {
	const cwd = process.cwd();
	const workspaceDir = join(cwd, WORKSPACE_DIR);

	if (existsSync(workspaceDir)) {
		process.stdout.write(`Warning: ${WORKSPACE_DIR}/ already exists in this directory.\n`);
		return;
	}

	const workspaceName = opts.name ?? basename(cwd);
	process.stdout.write(`Initializing workspace "${workspaceName}"...\n\n`);

	// Create directory structure
	const dirs = [
		WORKSPACE_DIR,
		join(WORKSPACE_DIR, "agents"),
		join(WORKSPACE_DIR, "agent-defs"),
		join(WORKSPACE_DIR, "pending-nudges"),
	];

	for (const dir of dirs) {
		await mkdir(join(cwd, dir), { recursive: true });
		process.stdout.write(`  \u2713 Created ${dir}/\n`);
	}

	// Write workspace.yaml skeleton
	const configContent = serializeWorkspaceYaml(workspaceName, []);
	await Bun.write(join(workspaceDir, WORKSPACE_CONFIG_FILENAME), configContent);
	process.stdout.write(`  \u2713 Created ${WORKSPACE_DIR}/${WORKSPACE_CONFIG_FILENAME}\n`);

	// Write .gitignore
	const gitignore = `# Overstory workspace runtime state
*.db
*.db-wal
*.db-shm
logs/
pending-nudges/
`;
	await Bun.write(join(workspaceDir, ".gitignore"), gitignore);
	process.stdout.write(`  \u2713 Created ${WORKSPACE_DIR}/.gitignore\n`);

	process.stdout.write("\nDone.\n");
	process.stdout.write("  Next: run `ov workspace add <path>` to register projects.\n");
}

export interface WorkspaceAddOptions {
	name?: string;
}

/**
 * ov workspace add <path> [--name <name>]
 *
 * Registers a project in the workspace config. Validates that the target
 * path has .git/ and .overstory/, checks for duplicates, auto-detects
 * canonical branch, and appends to workspace.yaml.
 */
export async function workspaceAddCommand(
	projectPath: string,
	opts: WorkspaceAddOptions,
): Promise<void> {
	const cwd = process.cwd();
	const wsRoot = resolveWorkspaceRoot(cwd);
	if (!wsRoot) {
		throw new ValidationError("No workspace found. Run 'ov workspace init' first.", {
			field: "workspace",
		});
	}

	const absPath = resolve(cwd, projectPath);

	if (!existsSync(join(absPath, ".git"))) {
		throw new ValidationError(`Path is not a git repository (no .git found): '${absPath}'`, {
			field: "path",
		});
	}

	if (!existsSync(join(absPath, ".overstory"))) {
		throw new ValidationError(
			`Path is not an overstory project (no .overstory found): '${absPath}'`,
			{ field: "path" },
		);
	}

	const projectName = opts.name ?? basename(absPath);
	const canonicalBranch = await detectCanonicalBranch(absPath);

	const { workspaceName, projects } = await loadConfigOrEmpty(wsRoot);

	if (projects.some((p) => p.name === projectName)) {
		throw new ValidationError(`Duplicate project name: '${projectName}'`, { field: "name" });
	}

	if (projects.some((p) => p.root === absPath)) {
		throw new ValidationError(`Project root already registered: '${absPath}'`, { field: "path" });
	}

	const newProject: WorkspaceProject = { name: projectName, root: absPath, canonicalBranch };
	const updated = [...projects, newProject];

	const configPath = join(wsRoot, WORKSPACE_DIR, WORKSPACE_CONFIG_FILENAME);
	await Bun.write(configPath, serializeWorkspaceYaml(workspaceName, updated));

	process.stdout.write(`  \u2713 Added project "${projectName}" (${absPath})\n`);
}

/**
 * ov workspace remove <name>
 *
 * Removes a project from the workspace config by name.
 */
export async function workspaceRemoveCommand(name: string): Promise<void> {
	const cwd = process.cwd();
	const wsRoot = resolveWorkspaceRoot(cwd);
	if (!wsRoot) {
		throw new ValidationError("No workspace found. Run 'ov workspace init' first.", {
			field: "workspace",
		});
	}

	const config = await loadWorkspaceConfig(wsRoot);
	const idx = config.projects.findIndex((p) => p.name === name);
	if (idx === -1) {
		throw new ValidationError(`Project not found: '${name}'`, { field: "name" });
	}

	const updated = config.projects.filter((_, i) => i !== idx);
	const configPath = join(wsRoot, WORKSPACE_DIR, WORKSPACE_CONFIG_FILENAME);
	await Bun.write(configPath, serializeWorkspaceYaml(config.name, updated));

	process.stdout.write(`  \u2713 Removed project "${name}"\n`);
}

/**
 * ov workspace list
 *
 * Lists all registered projects with name, root, and canonical branch.
 */
export async function workspaceListCommand(): Promise<void> {
	const cwd = process.cwd();
	const wsRoot = resolveWorkspaceRoot(cwd);
	if (!wsRoot) {
		throw new ValidationError("No workspace found. Run 'ov workspace init' first.", {
			field: "workspace",
		});
	}

	const { projects } = await loadConfigOrEmpty(wsRoot);

	if (projects.length === 0) {
		process.stdout.write("No projects registered. Use `ov workspace add <path>` to add one.\n");
		return;
	}

	for (const p of projects) {
		process.stdout.write(`  ${p.name}  ${p.root}  [${p.canonicalBranch}]\n`);
	}
}

export interface WorkspaceStatusOptions {
	json?: boolean;
}

/**
 * ov workspace status [--json]
 *
 * Shows workspace configuration and per-project overstory presence status.
 */
export async function workspaceStatusCommand(opts: WorkspaceStatusOptions): Promise<void> {
	const cwd = process.cwd();
	const wsRoot = resolveWorkspaceRoot(cwd);
	if (!wsRoot) {
		throw new ValidationError("No workspace found. Run 'ov workspace init' first.", {
			field: "workspace",
		});
	}

	const { workspaceName, projects, maxConcurrentTotal, maxDepth } = await loadConfigOrEmpty(wsRoot);

	const projectsWithStatus = projects.map((p) => ({
		name: p.name,
		root: p.root,
		canonicalBranch: p.canonicalBranch,
		hasOverstory: existsSync(join(p.root, ".overstory")),
	}));

	if (opts.json) {
		process.stdout.write(
			`${JSON.stringify(
				{
					workspace: workspaceName,
					root: wsRoot,
					maxConcurrentTotal,
					maxDepth,
					projects: projectsWithStatus,
				},
				null,
				2,
			)}\n`,
		);
		return;
	}

	process.stdout.write(`Workspace: ${workspaceName}\n`);
	process.stdout.write(`Root:      ${wsRoot}\n`);
	process.stdout.write(
		`Limits:    maxConcurrentTotal=${maxConcurrentTotal}  maxDepth=${maxDepth}\n`,
	);
	process.stdout.write(`Projects:  ${projectsWithStatus.length}\n\n`);

	if (projectsWithStatus.length === 0) {
		process.stdout.write("  (no projects registered)\n");
		return;
	}

	for (const p of projectsWithStatus) {
		const marker = p.hasOverstory ? "+" : "-";
		process.stdout.write(`  [${marker}] ${p.name}  ${p.root}  [${p.canonicalBranch}]\n`);
	}
}

// === Workspace Start/Stop ===

/** Default workspace agent name. */
const WORKSPACE_AGENT_NAME = "workspace";

/** Fixed tmux session name for the workspace orchestrator. */
const WORKSPACE_TMUX_SESSION = "overstory-workspace";

/** Dependency injection for testing. Uses real implementations when omitted. */
export interface WorkspaceDeps {
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
		ensureTmuxAvailable: () => Promise<void>;
	};
}

/**
 * Build the workspace orchestrator startup beacon — the first message sent to
 * the workspace orchestrator via tmux send-keys after Claude Code initializes.
 */
export function buildWorkspaceBeacon(): string {
	const timestamp = new Date().toISOString();
	const parts = [
		`[OVERSTORY] ${WORKSPACE_AGENT_NAME} (workspace) ${timestamp}`,
		"Depth: 0 | Parent: none | Role: workspace orchestrator",
		`Startup: run mulch prime, check mail (ov mail check --agent ${WORKSPACE_AGENT_NAME}), check workspace status (ov workspace status), then begin work`,
	];
	return parts.join(" — ");
}

/**
 * Start the workspace orchestrator agent.
 *
 * Spawns Claude Code in a tmux session at the workspace root with the
 * workspace agent overlay. The workspace orchestrator can then dispatch
 * per-project coordinators via `ov coordinator start --project <name>`.
 */
async function startWorkspace(
	opts: { json: boolean; attach: boolean },
	deps: WorkspaceDeps = {},
): Promise<void> {
	const tmux = deps._tmux ?? {
		createSession,
		isSessionAlive,
		killSession,
		sendKeys,
		waitForTuiReady,
		ensureTmuxAvailable,
	};

	const { json, attach: shouldAttach } = opts;

	if (isRunningAsRoot()) {
		throw new AgentError(
			"Cannot spawn agents as root (UID 0). The claude CLI rejects --dangerously-skip-permissions when run as root, causing the tmux session to die immediately. Run overstory as a non-root user.",
		);
	}

	const wsRoot = resolveWorkspaceRoot(process.cwd());
	if (!wsRoot) {
		throw new AgentError(
			"No workspace found. Run 'ov workspace init' first to initialize a workspace.",
		);
	}

	const wsDir = join(wsRoot, WORKSPACE_DIR);

	// Check for existing workspace session
	const { store } = openSessionStore(wsDir);
	try {
		const existing = store.getByName(WORKSPACE_AGENT_NAME);

		if (
			existing &&
			existing.capability === "workspace" &&
			existing.state !== "completed" &&
			existing.state !== "zombie"
		) {
			const alive = await tmux.isSessionAlive(existing.tmuxSession);
			if (alive) {
				throw new AgentError(
					`Workspace orchestrator is already running (tmux: ${existing.tmuxSession}, since: ${existing.startedAt})`,
					{ agentName: WORKSPACE_AGENT_NAME },
				);
			}
			// Session recorded but tmux is dead — mark as completed and continue
			store.updateState(WORKSPACE_AGENT_NAME, "completed");
		}

		// Deploy hooks to workspace root
		await deployHooks(wsRoot, WORKSPACE_AGENT_NAME, "workspace");

		// Create workspace agent identity if first run
		const identityBaseDir = join(wsDir, "agents");
		await mkdir(identityBaseDir, { recursive: true });
		const existingIdentity = await loadIdentity(identityBaseDir, WORKSPACE_AGENT_NAME);
		if (!existingIdentity) {
			await createIdentity(identityBaseDir, {
				name: WORKSPACE_AGENT_NAME,
				capability: "workspace",
				created: new Date().toISOString(),
				sessionsCompleted: 0,
				expertiseDomains: [],
				recentTasks: [],
			});
		}

		// Resolve model from workspace manifest > fallback
		const manifestLoader = createManifestLoader(
			join(wsDir, "agent-manifest.json"),
			join(wsDir, "agent-defs"),
		);
		let model = "opus";
		let env: Record<string, string> = {};
		try {
			const manifest = await manifestLoader.load();
			// Use a minimal config-like object for resolveModel — workspace has no OverstoryConfig
			const fakeConfig = {
				models: {} as Record<string, string>,
				providers: {} as Record<string, never>,
			} as unknown as Parameters<typeof resolveModel>[0];
			const resolved = resolveModel(fakeConfig, manifest, "workspace", "opus");
			model = resolved.model;
			env = resolved.env ?? {};
		} catch {
			// Manifest not found or invalid — use default model
		}

		// Preflight: verify tmux is installed
		await tmux.ensureTmuxAvailable();

		// Build claude command with optional system prompt from agent-defs
		const agentDefPath = join(wsDir, "agent-defs", "workspace.md");
		const agentDefFile = Bun.file(agentDefPath);
		let claudeCmd = `claude --model ${model} --dangerously-skip-permissions`;
		if (await agentDefFile.exists()) {
			const agentDef = await agentDefFile.text();
			const escaped = agentDef.replace(/'/g, "'\\''");
			claudeCmd += ` --append-system-prompt '${escaped}'`;
		}

		const pid = await tmux.createSession(WORKSPACE_TMUX_SESSION, wsRoot, claudeCmd, {
			...env,
			OVERSTORY_AGENT_NAME: WORKSPACE_AGENT_NAME,
			OVERSTORY_WORKSPACE_ROOT: wsRoot,
			OVERSTORY_PROJECT_ID: WORKSPACE_PROJECT_ID,
		});

		// Record session BEFORE sending the beacon
		const session: AgentSession = {
			id: `session-${Date.now()}-${WORKSPACE_AGENT_NAME}`,
			agentName: WORKSPACE_AGENT_NAME,
			capability: "workspace",
			worktreePath: wsRoot,
			branchName: "",
			taskId: "",
			tmuxSession: WORKSPACE_TMUX_SESSION,
			state: "booting",
			pid,
			parentAgent: null,
			depth: 0,
			runId: null,
			projectId: WORKSPACE_PROJECT_ID,
			startedAt: new Date().toISOString(),
			lastActivity: new Date().toISOString(),
			escalationLevel: 0,
			stalledSince: null,
		};

		store.upsert(session);

		// Wait for Claude Code TUI to render before sending input
		const tuiReady = await tmux.waitForTuiReady(WORKSPACE_TMUX_SESSION);
		if (!tuiReady) {
			const alive = await tmux.isSessionAlive(WORKSPACE_TMUX_SESSION);
			if (!alive) {
				store.updateState(WORKSPACE_AGENT_NAME, "completed");
				throw new AgentError(
					`Workspace orchestrator tmux session "${WORKSPACE_TMUX_SESSION}" died during startup. The Claude Code process may have crashed or exited immediately.`,
					{ agentName: WORKSPACE_AGENT_NAME },
				);
			}
		}
		await Bun.sleep(1_000);

		const beacon = buildWorkspaceBeacon();
		await tmux.sendKeys(WORKSPACE_TMUX_SESSION, beacon);

		// Follow-up Enters with increasing delays to ensure submission
		for (const delay of [1_000, 2_000]) {
			await Bun.sleep(delay);
			await tmux.sendKeys(WORKSPACE_TMUX_SESSION, "");
		}

		const output = {
			agentName: WORKSPACE_AGENT_NAME,
			capability: "workspace",
			tmuxSession: WORKSPACE_TMUX_SESSION,
			workspaceRoot: wsRoot,
			pid,
		};

		if (json) {
			process.stdout.write(`${JSON.stringify(output)}\n`);
		} else {
			process.stdout.write("Workspace orchestrator started\n");
			process.stdout.write(`  Tmux:    ${WORKSPACE_TMUX_SESSION}\n`);
			process.stdout.write(`  Root:    ${wsRoot}\n`);
			process.stdout.write(`  PID:     ${pid}\n`);
		}

		if (shouldAttach) {
			Bun.spawnSync(["tmux", "attach-session", "-t", WORKSPACE_TMUX_SESSION], {
				stdio: ["inherit", "inherit", "inherit"],
			});
		}
	} finally {
		store.close();
	}
}

/**
 * Stop the workspace orchestrator agent.
 *
 * 1. Find the active workspace session
 * 2. Kill tmux session
 * 3. Mark session as completed
 * 4. Output result
 */
async function stopWorkspace(opts: { json: boolean }, deps: WorkspaceDeps = {}): Promise<void> {
	const tmux = deps._tmux ?? {
		createSession,
		isSessionAlive,
		killSession,
		sendKeys,
		waitForTuiReady,
		ensureTmuxAvailable,
	};

	const { json } = opts;

	const wsRoot = resolveWorkspaceRoot(process.cwd());
	if (!wsRoot) {
		throw new AgentError(
			"No workspace found. Run 'ov workspace init' first to initialize a workspace.",
		);
	}

	const wsDir = join(wsRoot, WORKSPACE_DIR);
	const { store } = openSessionStore(wsDir);
	try {
		const session = store.getByName(WORKSPACE_AGENT_NAME);

		if (
			!session ||
			session.capability !== "workspace" ||
			session.state === "completed" ||
			session.state === "zombie"
		) {
			throw new AgentError("No active workspace orchestrator session found", {
				agentName: WORKSPACE_AGENT_NAME,
			});
		}

		// Kill tmux session
		const alive = await tmux.isSessionAlive(session.tmuxSession);
		if (alive) {
			await tmux.killSession(session.tmuxSession);
		}

		// Update session state
		store.updateState(WORKSPACE_AGENT_NAME, "completed");
		store.updateLastActivity(WORKSPACE_AGENT_NAME);

		if (json) {
			process.stdout.write(`${JSON.stringify({ stopped: true, sessionId: session.id })}\n`);
		} else {
			process.stdout.write(`Workspace orchestrator stopped (session: ${session.id})\n`);
		}
	} finally {
		store.close();
	}
}

// === Command Factory ===

/**
 * Build the `ov workspace` Commander command with all subcommands.
 */
export function createWorkspaceCommand(deps: WorkspaceDeps = {}): Command {
	const workspace = new Command("workspace").description(
		"Workspace management for multi-repo orchestration",
	);

	workspace
		.command("init")
		.description("Initialize a workspace in the current directory")
		.option("--name <name>", "Workspace name (default: directory name)")
		.action(async (opts: WorkspaceInitOptions) => {
			await workspaceInitCommand(opts);
		});

	workspace
		.command("add")
		.description("Register a project in the workspace")
		.argument("<path>", "Path to project root")
		.option("--name <name>", "Project name (default: directory basename)")
		.action(async (path: string, opts: WorkspaceAddOptions) => {
			await workspaceAddCommand(path, opts);
		});

	workspace
		.command("remove")
		.description("Unregister a project from the workspace")
		.argument("<name>", "Project name to remove")
		.action(async (name: string) => {
			await workspaceRemoveCommand(name);
		});

	workspace
		.command("list")
		.description("List registered projects")
		.action(async () => {
			await workspaceListCommand();
		});

	workspace
		.command("status")
		.description("Show workspace status")
		.option("--json", "JSON output")
		.action(async (opts: WorkspaceStatusOptions) => {
			await workspaceStatusCommand(opts);
		});

	workspace
		.command("start")
		.description("Start workspace orchestrator (spawns Claude Code at workspace root)")
		.option("--attach", "Always attach to tmux session after start")
		.option("--no-attach", "Never attach to tmux session after start")
		.option("--json", "Output as JSON")
		.action(async (opts: { attach?: boolean; json?: boolean }) => {
			const shouldAttach = opts.attach !== undefined ? opts.attach : !!process.stdout.isTTY;
			await startWorkspace({ json: opts.json ?? false, attach: shouldAttach }, deps);
		});

	workspace
		.command("stop")
		.description("Stop workspace orchestrator (kills tmux session)")
		.option("--json", "Output as JSON")
		.action(async (opts: { json?: boolean }) => {
			await stopWorkspace({ json: opts.json ?? false }, deps);
		});

	return workspace;
}

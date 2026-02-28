/**
 * CLI command: ov workspace <subcommand>
 *
 * Subcommands for multi-repo workspace management (Phase 2B).
 * Phase 2A (config loader, resolver, types) is in src/workspace/config.ts.
 */

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { Command } from "commander";
import { deployHooks } from "../agents/hooks-deployer.ts";
import { createIdentity, loadIdentity } from "../agents/identity.ts";
import { createManifestLoader, resolveModel } from "../agents/manifest.ts";
import { AgentError, ValidationError } from "../errors.ts";
import { installHooksForProject } from "./hooks.ts";
import { initCommand } from "./init.ts";
import type { ReadyState } from "../runtimes/types.ts";
import { createMetricsStore } from "../metrics/store.ts";
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

		// BUG 2: Parse optional settings from raw YAML text instead of hardcoding
		const depthMatch = rawText.match(/^maxDepth:\s*(\d+)$/m);
		const concurrentMatch = rawText.match(/^maxConcurrentTotal:\s*(\d+)$/m);
		const maxDepth = depthMatch?.[1] !== undefined ? Number.parseInt(depthMatch[1], 10) : 4;
		const maxConcurrentTotal =
			concurrentMatch?.[1] !== undefined ? Number.parseInt(concurrentMatch[1], 10) : 25;

		if (maxDepth < 3) {
			throw new ValidationError(
				"maxDepth must be >= 3 (workspace needs workspace -> coordinator -> lead -> specialist)",
				{ field: "maxDepth", value: maxDepth },
			);
		}
		if (maxConcurrentTotal <= 0) {
			throw new ValidationError("maxConcurrentTotal must be a positive integer", {
				field: "maxConcurrentTotal",
				value: maxConcurrentTotal,
			});
		}

		return { workspaceName, projects: [], maxConcurrentTotal, maxDepth };
	}

	// BUG 3: Use lenient mode so missing project dirs don't crash status/list/start
	const config = await loadWorkspaceConfig(wsRoot, { lenient: true });
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

	await Bun.write(join(workspaceDir, "mail-check-state.json"), "{}");
	process.stdout.write(`  \u2713 Created mail-check-state.json\n`);

	// BUG 4: Create metrics.db eagerly (other DBs are lazy, but metrics may be expected)
	const metricsDb = createMetricsStore(join(workspaceDir, "metrics.db"));
	metricsDb.close();
	process.stdout.write(`  \u2713 Created metrics.db\n`);

	process.stdout.write("\nDone.\n");
	process.stdout.write("  Next: run `ov workspace add <path>` to register projects.\n");
}

export interface WorkspaceAddOptions {
	name?: string;
	/** Auto-run `ov init` in target project when .overstory is missing. */
	init?: boolean;
	/** Auto-run `ov hooks install` in target project when hooks.json is present. */
	hooks?: boolean;
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
		if (opts.init === false) {
			throw new ValidationError(
				`Path is not an overstory project (no .overstory found): '${absPath}'. Run ov init there first.`,
				{ field: "path" },
			);
		}
		process.stdout.write(`  - .overstory missing in ${absPath}; running ov init...\n`);
		const previousCwd = process.cwd();
		try {
			process.chdir(absPath);
			await initCommand({ yes: true });
		} finally {
			process.chdir(previousCwd);
		}
		if (!existsSync(join(absPath, ".overstory"))) {
			throw new ValidationError(
				`Path is not an overstory project (auto-init failed to create .overstory): '${absPath}'`,
				{ field: "path" },
			);
		}
	}

	if (opts.hooks !== false) {
		const hooksPath = join(absPath, ".overstory", "hooks.json");
		if (existsSync(hooksPath)) {
			try {
				await installHooksForProject(absPath);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				process.stdout.write(`  - Warning: hooks install skipped for ${absPath}: ${message}\n`);
			}
		}
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

	// C4: Guard against removing a project with active agents.
	// In workspace mode, all sessions live in the shared .overstory-workspace/
	// session store, not in each project's local .overstory/. Filter by projectId
	// so we only block removal when agents for THIS project are still running.
	const project = config.projects[idx];
	if (project) {
		const dbRoot = join(wsRoot, WORKSPACE_DIR);
		const { store } = openSessionStore(dbRoot);
		try {
			const sessions = store.getAll();
			const activeSessions = sessions.filter(
				(s) => s.state !== "completed" && s.state !== "zombie" && s.projectId === name,
			);
			if (activeSessions.length > 0) {
				throw new ValidationError(
					`Cannot remove project "${name}": ${activeSessions.length} active agent(s). Stop them first.`,
					{ field: "name" },
				);
			}
		} finally {
			store.close();
		}
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
			detectReady: (paneContent: string) => ReadyState,
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
export async function startWorkspace(
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

			// H3: Render workspace overlay to .claude/CLAUDE.md.
			// Prefer workspace-overlay.md.tmpl when present; fall back to a built-in
			// template so workspace startup still produces a usable overlay.
			const templatePath = join(
				dirname(dirname(import.meta.dir)),
				"templates",
				"workspace-overlay.md.tmpl",
			);
			const templateFile = Bun.file(templatePath);
			let tmpl: string;
			if (await templateFile.exists()) {
				tmpl = await templateFile.text();
			} else {
				tmpl = [
					"# Overstory Workspace",
					"",
					"Workspace root: {{WORKSPACE_ROOT}}",
					"",
					"Projects:",
					"{{PROJECTS_LIST}}",
					"",
				].join("\n");
			}
			const { projects } = await loadConfigOrEmpty(wsRoot);
			const projectsList =
				projects.length === 0
					? "(no projects registered)"
					: projects.map((p) => `- **${p.name}**: ${p.root} [${p.canonicalBranch}]`).join("\n");
			tmpl = tmpl.replace(/\{\{WORKSPACE_ROOT\}\}/g, wsRoot);
			tmpl = tmpl.replace(/\{\{PROJECTS_LIST\}\}/g, projectsList);
			const claudeDir = join(wsRoot, ".claude");
			await mkdir(claudeDir, { recursive: true });
			await Bun.write(join(claudeDir, "CLAUDE.md"), tmpl);

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
				transcriptPath: null,
			};

		store.upsert(session, WORKSPACE_PROJECT_ID);

		// Wait for Claude Code TUI to render before sending input
			const tuiReady = await tmux.waitForTuiReady(WORKSPACE_TMUX_SESSION, (content) => {
				if (content.includes("Press Enter to continue")) return { phase: "dialog", action: "Enter" };
				if (content.includes("❯") || content.includes(">")) return { phase: "ready" };
				return { phase: "loading" };
			});
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
		.option("--no-init", "Do not auto-run ov init when .overstory is missing")
		.option("--no-hooks", "Do not auto-run ov hooks install when hooks.json is present")
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
		.action(async (_opts: WorkspaceStatusOptions, cmd: Command) => {
			// BUG 1: Use cmd.opts() to ensure --json is picked up correctly when
			// workspace is nested under program (Commander option routing can bypass
			// the `opts` first parameter in deeply nested command chains)
			await workspaceStatusCommand(cmd.opts() as WorkspaceStatusOptions);
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

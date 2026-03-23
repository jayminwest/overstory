/**
 * CLI command: ov init [--force] [--yes|-y] [--name <name>]
 *
 * Scaffolds the `.overstory/` directory in the current project with:
 * - config.yaml (serialized from DEFAULT_CONFIG)
 * - agent-manifest.json (starter agent definitions)
 * - hooks.json (central hooks config)
 * - Required subdirectories (agents/, worktrees/, specs/, logs/)
 * - .gitignore entries for transient files
 */

import { Database } from "bun:sqlite";
import { mkdir, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { DEFAULT_CONFIG } from "../config.ts";
import { ValidationError } from "../errors.ts";
import { jsonOutput } from "../json.ts";
import { printHint, printSuccess, printWarning } from "../logging/color.ts";
import type { AgentManifest, OverstoryConfig } from "../types.ts";

const OVERSTORY_DIR = ".overstory";

// ---- Ecosystem Bootstrap ----

/**
 * Spawner abstraction for testability.
 * Wraps Bun.spawn for running sibling CLI tools.
 */
export type Spawner = (
	args: string[],
	opts?: { cwd?: string },
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

const defaultSpawner: Spawner = async (args, opts) => {
	try {
		const proc = Bun.spawn(args, {
			cwd: opts?.cwd,
			stdout: "pipe",
			stderr: "pipe",
		});
		const exitCode = await proc.exited;
		const stdout = await new Response(proc.stdout).text();
		const stderr = await new Response(proc.stderr).text();
		return { exitCode, stdout, stderr };
	} catch (err) {
		// Binary not found (ENOENT) or other spawn failure — treat as non-zero exit
		const message = err instanceof Error ? err.message : String(err);
		return { exitCode: 1, stdout: "", stderr: message };
	}
};

interface SiblingTool {
	name: string;
	cli: string;
	dotDir: string;
	initCmd: string[];
	onboardCmd: string[];
}

const SIBLING_TOOLS: SiblingTool[] = [
	{ name: "mulch", cli: "ml", dotDir: ".mulch", initCmd: ["init"], onboardCmd: ["onboard"] },
	{ name: "seeds", cli: "sd", dotDir: ".seeds", initCmd: ["init"], onboardCmd: ["onboard"] },
	{ name: "canopy", cli: "cn", dotDir: ".canopy", initCmd: ["init"], onboardCmd: ["onboard"] },
];

type ToolStatus = "initialized" | "already_initialized" | "skipped";
type OnboardStatus = "appended" | "current";

/**
 * Resolve the set of sibling tools to bootstrap.
 *
 * If opts.tools is set (comma-separated list of names), filter to those.
 * Otherwise start with all three and remove any skipped via skip flags.
 */
export function resolveToolSet(opts: InitOptions): SiblingTool[] {
	if (opts.tools) {
		const requested = opts.tools.split(",").map((t) => t.trim());
		return SIBLING_TOOLS.filter((t) => requested.includes(t.name));
	}
	return SIBLING_TOOLS.filter((t) => {
		if (t.name === "mulch" && opts.skipMulch) return false;
		if (t.name === "seeds" && opts.skipSeeds) return false;
		if (t.name === "canopy" && opts.skipCanopy) return false;
		return true;
	});
}

async function isToolInstalled(cli: string, spawner: Spawner): Promise<boolean> {
	try {
		const result = await spawner([cli, "--version"]);
		return result.exitCode === 0;
	} catch {
		return false;
	}
}

async function initSiblingTool(
	tool: SiblingTool,
	projectRoot: string,
	spawner: Spawner,
): Promise<ToolStatus> {
	const installed = await isToolInstalled(tool.cli, spawner);
	if (!installed) {
		printWarning(
			`${tool.name} not installed — skipping`,
			`install: npm i -g @os-eco/${tool.name}-cli`,
		);
		return "skipped";
	}

	let result: { exitCode: number; stdout: string; stderr: string };
	try {
		result = await spawner([tool.cli, ...tool.initCmd], { cwd: projectRoot });
	} catch (err) {
		// Spawn failure (e.g. ENOENT) — treat as not installed
		const message = err instanceof Error ? err.message : String(err);
		printWarning(`${tool.name} init failed`, message);
		return "skipped";
	}
	if (result.exitCode !== 0) {
		// Check if dot directory already exists (already initialized)
		try {
			await stat(join(projectRoot, tool.dotDir));
			return "already_initialized";
		} catch {
			// Directory doesn't exist — real failure
			printWarning(`${tool.name} init failed`, result.stderr.trim() || result.stdout.trim());
			return "skipped";
		}
	}

	printSuccess(`Bootstrapped ${tool.name}`);
	return "initialized";
}

async function onboardTool(
	tool: SiblingTool,
	projectRoot: string,
	spawner: Spawner,
): Promise<OnboardStatus> {
	const installed = await isToolInstalled(tool.cli, spawner);
	if (!installed) return "current";

	try {
		const result = await spawner([tool.cli, ...tool.onboardCmd], { cwd: projectRoot });
		return result.exitCode === 0 ? "appended" : "current";
	} catch {
		return "current";
	}
}

/**
 * Known runtime CLI candidates in detection priority order.
 * First installed runtime wins.
 */
const RUNTIME_CANDIDATES: Array<{ name: string; cli: string }> = [
	{ name: "claude", cli: "claude" },
	{ name: "copilot", cli: "copilot" },
	{ name: "gemini", cli: "gemini" },
	{ name: "opencode", cli: "opencode" },
	{ name: "sapling", cli: "sp" },
	{ name: "pi", cli: "pi" },
];

/**
 * Detect the default runtime by checking which coding agent CLIs are installed.
 *
 * Uses `which <cli>` via the spawner abstraction so detection is testable
 * without real binaries on PATH. Returns the first installed runtime by
 * priority order, or "claude" as the safe fallback.
 *
 * @param spawner - Spawner abstraction (defaults to Bun.spawn wrapper)
 * @returns Runtime name suitable for config.runtime.default
 */
export async function detectDefaultRuntime(spawner: Spawner): Promise<string> {
	for (const { name, cli } of RUNTIME_CANDIDATES) {
		const result = await spawner(["which", cli]);
		if (result.exitCode === 0) {
			return name;
		}
	}
	return "claude";
}

/**
 * Set up .gitattributes with merge=union entries for JSONL files.
 *
 * Only adds entries not already present. Returns true if file was modified.
 */
async function setupGitattributes(projectRoot: string): Promise<boolean> {
	const entries = [".mulch/expertise/*.jsonl merge=union", ".seeds/issues.jsonl merge=union"];

	const gitattrsPath = join(projectRoot, ".gitattributes");
	let existing = "";

	try {
		existing = await Bun.file(gitattrsPath).text();
	} catch {
		// File doesn't exist yet — will be created
	}

	const missing = entries.filter((e) => !existing.includes(e));
	if (missing.length === 0) return false;

	const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
	await Bun.write(gitattrsPath, `${existing}${separator}${missing.join("\n")}\n`);
	return true;
}

/**
 * Detect the project name from git or fall back to directory name.
 */
async function detectProjectName(root: string): Promise<string> {
	// Try git remote origin
	try {
		const proc = Bun.spawn(["git", "remote", "get-url", "origin"], {
			cwd: root,
			stdout: "pipe",
			stderr: "pipe",
		});
		const exitCode = await proc.exited;
		if (exitCode === 0) {
			const url = (await new Response(proc.stdout).text()).trim();
			// Extract repo name from URL: git@host:user/repo.git or https://host/user/repo.git
			const match = url.match(/\/([^/]+?)(?:\.git)?$/);
			if (match?.[1]) {
				return match[1];
			}
		}
	} catch {
		// Git not available or not a git repo
	}

	return basename(root);
}

/**
 * Detect the canonical branch name from git.
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
			// refs/remotes/origin/main -> main
			const branch = ref.split("/").pop();
			if (branch) {
				return branch;
			}
		}
	} catch {
		// Not available
	}

	// Fall back to checking current branch
	try {
		const proc = Bun.spawn(["git", "branch", "--show-current"], {
			cwd: root,
			stdout: "pipe",
			stderr: "pipe",
		});
		const exitCode = await proc.exited;
		if (exitCode === 0) {
			const branch = (await new Response(proc.stdout).text()).trim();
			if (branch) {
				return branch;
			}
		}
	} catch {
		// Not available
	}

	return "main";
}

/**
 * Serialize an OverstoryConfig to YAML format.
 *
 * Handles nested objects with indentation, scalar values,
 * arrays with `- item` syntax, and empty arrays as `[]`.
 */
function serializeConfigToYaml(config: OverstoryConfig): string {
	const lines: string[] = [];
	lines.push("# Overstory configuration");
	lines.push("# See: https://github.com/overstory/overstory");
	lines.push("");

	serializeObject(config as unknown as Record<string, unknown>, lines, 0);

	return `${lines.join("\n")}\n`;
}

/**
 * Recursively serialize an object to YAML lines.
 */
function serializeObject(obj: Record<string, unknown>, lines: string[], depth: number): void {
	const indent = "  ".repeat(depth);

	for (const [key, value] of Object.entries(obj)) {
		if (value === null || value === undefined) {
			lines.push(`${indent}${key}: null`);
		} else if (typeof value === "object" && !Array.isArray(value)) {
			lines.push(`${indent}${key}:`);
			serializeObject(value as Record<string, unknown>, lines, depth + 1);
		} else if (Array.isArray(value)) {
			if (value.length === 0) {
				lines.push(`${indent}${key}: []`);
			} else {
				lines.push(`${indent}${key}:`);
				const itemIndent = "  ".repeat(depth + 1);
				const propIndent = "  ".repeat(depth + 2);
				for (const item of value) {
					if (item !== null && typeof item === "object" && !Array.isArray(item)) {
						// Object array item: "- firstKey: firstVal\n  otherKey: otherVal"
						const entries = Object.entries(item as Record<string, unknown>);
						if (entries.length > 0) {
							const [firstKey, firstVal] = entries[0] ?? [];
							lines.push(`${itemIndent}- ${firstKey}: ${formatYamlValue(firstVal)}`);
							for (let j = 1; j < entries.length; j++) {
								const [k, v] = entries[j] ?? [];
								lines.push(`${propIndent}${k}: ${formatYamlValue(v)}`);
							}
						}
					} else {
						lines.push(`${itemIndent}- ${formatYamlValue(item)}`);
					}
				}
			}
		} else {
			lines.push(`${indent}${key}: ${formatYamlValue(value)}`);
		}
	}
}

/**
 * Format a scalar value for YAML output.
 */
function formatYamlValue(value: unknown): string {
	if (typeof value === "string") {
		// Quote strings that could be misinterpreted
		if (
			value === "" ||
			value === "true" ||
			value === "false" ||
			value === "null" ||
			value.includes(":") ||
			value.includes("#") ||
			value.includes("'") ||
			value.includes('"') ||
			value.includes("\n") ||
			/^\d/.test(value)
		) {
			// Use double quotes, escaping inner double quotes
			return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
		}
		return value;
	}

	if (typeof value === "number") {
		return String(value);
	}

	if (typeof value === "boolean") {
		return value ? "true" : "false";
	}

	if (value === null || value === undefined) {
		return "null";
	}

	return String(value);
}

/**
 * Build the starter agent manifest.
 */
export function buildAgentManifest(): AgentManifest {
	const agents: AgentManifest["agents"] = {
		scout: {
			file: "scout.md",
			model: "haiku",
			tools: ["Read", "Glob", "Grep", "Bash"],
			capabilities: ["explore", "research"],
			canSpawn: false,
			constraints: ["read-only"],
		},
		builder: {
			file: "builder.md",
			model: "sonnet",
			tools: ["Read", "Write", "Edit", "Glob", "Grep", "Bash"],
			capabilities: ["implement", "refactor", "fix"],
			canSpawn: false,
			constraints: [],
		},
		reviewer: {
			file: "reviewer.md",
			model: "sonnet",
			tools: ["Read", "Glob", "Grep", "Bash"],
			capabilities: ["review", "validate"],
			canSpawn: false,
			constraints: ["read-only"],
		},
		lead: {
			file: "lead.md",
			model: "opus",
			tools: ["Read", "Write", "Edit", "Glob", "Grep", "Bash", "Task"],
			capabilities: ["coordinate", "implement", "review"],
			canSpawn: true,
			constraints: [],
		},
		merger: {
			file: "merger.md",
			model: "sonnet",
			tools: ["Read", "Write", "Edit", "Glob", "Grep", "Bash"],
			capabilities: ["merge", "resolve-conflicts"],
			canSpawn: false,
			constraints: [],
		},
		coordinator: {
			file: "coordinator.md",
			model: "opus",
			tools: ["Read", "Glob", "Grep", "Bash"],
			capabilities: ["coordinate", "dispatch", "escalate"],
			canSpawn: true,
			constraints: ["read-only", "no-worktree"],
		},
		orchestrator: {
			file: "orchestrator.md",
			model: "opus",
			tools: ["Read", "Glob", "Grep", "Bash"],
			capabilities: ["orchestrate", "coordinate", "dispatch", "escalate"],
			canSpawn: true,
			constraints: ["read-only", "no-worktree"],
		},
		monitor: {
			file: "monitor.md",
			model: "sonnet",
			tools: ["Read", "Glob", "Grep", "Bash"],
			capabilities: ["monitor", "patrol"],
			canSpawn: false,
			constraints: ["read-only", "no-worktree"],
		},
	};

	// Build capability index: map each capability to agent names that declare it
	const capabilityIndex: Record<string, string[]> = {};
	for (const [name, def] of Object.entries(agents)) {
		for (const cap of def.capabilities) {
			const existing = capabilityIndex[cap];
			if (existing) {
				existing.push(name);
			} else {
				capabilityIndex[cap] = [name];
			}
		}
	}

	return { version: "1.0", agents, capabilityIndex };
}

/**
 * Build the hooks.json content for the project orchestrator.
 *
 * Always generates from scratch (not from the agent template, which contains
 * {{AGENT_NAME}} placeholders and space indentation). Uses tab indentation
 * to match Biome formatting rules.
 */
export function buildHooksJson(): string {
	// Tool name extraction: reads hook stdin JSON and extracts tool_name field.
	// Claude Code sends {"tool_name":"Bash","tool_input":{...}} on stdin for
	// PreToolUse/PostToolUse hooks.
	const toolNameExtract =
		'read -r INPUT; TOOL_NAME=$(echo "$INPUT" | sed \'s/.*"tool_name": *"\\([^"]*\\)".*/\\1/\');';

	const hooks = {
		hooks: {
			SessionStart: [
				{
					matcher: "",
					hooks: [
						{
							type: "command",
							command: "ov prime --agent orchestrator",
						},
					],
				},
			],
			UserPromptSubmit: [
				{
					matcher: "",
					hooks: [
						{
							type: "command",
							command: "ov mail check --inject --agent orchestrator",
						},
					],
				},
			],
			PreToolUse: [
				{
					matcher: "Bash",
					hooks: [
						{
							type: "command",
							command:
								'read -r INPUT; CMD=$(echo "$INPUT" | sed \'s/.*"command": *"\\([^"]*\\)".*/\\1/\'); if echo "$CMD" | grep -qE \'\\bgit\\s+push\\b\'; then echo \'{"decision":"block","reason":"git push is blocked by overstory — merge locally, push manually when ready"}\'; exit 0; fi;',
						},
					],
				},
				{
					matcher: "",
					hooks: [
						{
							type: "command",
							command: `${toolNameExtract} ov log tool-start --agent orchestrator --tool-name "$TOOL_NAME"`,
						},
					],
				},
			],
			PostToolUse: [
				{
					matcher: "",
					hooks: [
						{
							type: "command",
							command: `${toolNameExtract} ov log tool-end --agent orchestrator --tool-name "$TOOL_NAME"`,
						},
					],
				},
				{
					matcher: "Bash",
					hooks: [
						{
							type: "command",
							command:
								"read -r INPUT; if echo \"$INPUT\" | grep -q 'git commit'; then mulch diff HEAD~1 2>/dev/null || true; fi",
						},
					],
				},
			],
			Stop: [
				{
					matcher: "",
					hooks: [
						{
							type: "command",
							command: "ov log session-end --agent orchestrator",
						},
						{
							type: "command",
							command: "mulch learn",
						},
					],
				},
			],
			PreCompact: [
				{
					matcher: "",
					hooks: [
						{
							type: "command",
							command: "ov prime --agent orchestrator --compact",
						},
					],
				},
			],
		},
	};

	return `${JSON.stringify(hooks, null, "\t")}\n`;
}

/**
 * Migrate existing SQLite databases on --force reinit.
 *
 * Opens each DB, enables WAL mode, and re-runs CREATE TABLE/INDEX IF NOT EXISTS
 * to apply any schema additions without losing existing data.
 */
async function migrateExistingDatabases(overstoryPath: string): Promise<string[]> {
	const migrated: string[] = [];

	// Migrate mail.db
	const mailDbPath = join(overstoryPath, "mail.db");
	if (await Bun.file(mailDbPath).exists()) {
		const db = new Database(mailDbPath);
		db.exec("PRAGMA journal_mode = WAL");
		db.exec("PRAGMA busy_timeout = 5000");
		db.exec(`
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  from_agent TEXT NOT NULL,
  to_agent TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'status',
  priority TEXT NOT NULL DEFAULT 'normal',
  thread_id TEXT,
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);
		db.exec(`
CREATE INDEX IF NOT EXISTS idx_inbox ON messages(to_agent, read);
CREATE INDEX IF NOT EXISTS idx_thread ON messages(thread_id)`);
		db.close();
		migrated.push("mail.db");
	}

	// Migrate metrics.db
	const metricsDbPath = join(overstoryPath, "metrics.db");
	if (await Bun.file(metricsDbPath).exists()) {
		const db = new Database(metricsDbPath);
		db.exec("PRAGMA journal_mode = WAL");
		db.exec("PRAGMA busy_timeout = 5000");
		db.exec(`
CREATE TABLE IF NOT EXISTS sessions (
  agent_name TEXT NOT NULL,
  task_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  exit_code INTEGER,
  merge_result TEXT,
  parent_agent TEXT,
  PRIMARY KEY (agent_name, task_id)
)`);
		db.close();
		migrated.push("metrics.db");
	}

	return migrated;
}

/**
 * Content for .overstory/.gitignore — runtime state that should not be tracked.
 * Uses wildcard+whitelist pattern: ignore everything, whitelist tracked files.
 * Auto-healed by ov prime on each session start.
 * Config files (config.yaml, agent-manifest.json, hooks.json) remain tracked.
 */
export const OVERSTORY_GITIGNORE = `# Wildcard+whitelist: ignore everything, whitelist tracked files
# Auto-healed by ov prime on each session start
*
!.gitignore
!config.yaml
!agent-manifest.json
!hooks.json
!groups.json
!agent-defs/
!agent-defs/**
!README.md
`;

/**
 * Content for .overstory/README.md — explains the directory to contributors.
 */
export const OVERSTORY_README = `# .overstory/

This directory is managed by [overstory](https://github.com/jayminwest/overstory) — a multi-agent orchestration system for Claude Code.

Overstory turns a single Claude Code session into a multi-agent team by spawning worker agents in git worktrees via tmux, coordinating them through a custom SQLite mail system, and merging their work back with tiered conflict resolution.

## Key Commands

- \`ov init\`          — Initialize this directory
- \`ov status\`        — Show active agents and state
- \`ov sling <id>\`    — Spawn a worker agent
- \`ov mail check\`    — Check agent messages
- \`ov merge\`         — Merge agent work back
- \`ov dashboard\`     — Live TUI monitoring
- \`ov doctor\`        — Run health checks

## Structure

- \`config.yaml\`             — Project configuration
- \`agent-manifest.json\`     — Agent registry
- \`hooks.json\`              — Claude Code hooks config
- \`agent-defs/\`             — Agent definition files (.md)
- \`specs/\`                  — Task specifications
- \`agents/\`                 — Per-agent state and identity
- \`worktrees/\`              — Git worktrees (gitignored)
- \`logs/\`                   — Agent logs (gitignored)
`;

/**
 * Write .overstory/.gitignore for runtime state files.
 * Always overwrites to support --force reinit and auto-healing via prime.
 */
export async function writeOverstoryGitignore(overstoryPath: string): Promise<void> {
	const gitignorePath = join(overstoryPath, ".gitignore");
	await Bun.write(gitignorePath, OVERSTORY_GITIGNORE);
}

/**
 * Write .overstory/README.md explaining the directory to contributors.
 * Always overwrites to support --force reinit.
 */
export async function writeOverstoryReadme(overstoryPath: string): Promise<void> {
	const readmePath = join(overstoryPath, "README.md");
	await Bun.write(readmePath, OVERSTORY_README);
}

export interface InitOptions {
	yes?: boolean;
	name?: string;
	force?: boolean;
	/** Comma-separated list of ecosystem tools to bootstrap (e.g. "mulch,seeds"). Default: all. */
	tools?: string;
	skipMulch?: boolean;
	skipSeeds?: boolean;
	skipCanopy?: boolean;
	/** Skip the onboard step (injecting CLAUDE.md sections for ecosystem tools). */
	skipOnboard?: boolean;
	/** Output final result as JSON envelope. */
	json?: boolean;
	/** Injectable spawner for testability. */
	_spawner?: Spawner;
}

/**
 * Print a success status line.
 */
function printCreated(relativePath: string): void {
	printSuccess("Created", relativePath);
}

/**
 * Entry point for `ov init [--force] [--yes|-y] [--name <name>]`.
 *
 * Scaffolds the .overstory/ directory structure in the current working directory.
 *
 * @param opts - Command options
 */
export async function initCommand(opts: InitOptions): Promise<void> {
	const force = opts.force ?? false;
	const yes = opts.yes ?? false;
	const projectRoot = process.cwd();
	const spawner = opts._spawner ?? defaultSpawner;
	const overstoryPath = join(projectRoot, OVERSTORY_DIR);

	// 0. Verify we're inside a git repository
	const gitCheck = Bun.spawn(["git", "rev-parse", "--is-inside-work-tree"], {
		cwd: projectRoot,
		stdout: "pipe",
		stderr: "pipe",
	});
	const gitCheckExit = await gitCheck.exited;
	if (gitCheckExit !== 0) {
		throw new ValidationError("overstory requires a git repository. Run 'git init' first.", {
			field: "git",
		});
	}

	// 1. Check if .overstory/ already exists
	const existingDir = Bun.file(join(overstoryPath, "config.yaml"));
	if (await existingDir.exists()) {
		if (!force && !yes) {
			process.stdout.write(
				"Warning: .overstory/ already initialized in this project.\n" +
					"Use --force or --yes to reinitialize.\n",
			);
			return;
		}
		const flag = yes ? "--yes" : "--force";
		process.stdout.write(`Reinitializing .overstory/ (${flag})\n\n`);
	}

	// 2. Detect project info
	const projectName = opts.name ?? (await detectProjectName(projectRoot));
	const canonicalBranch = await detectCanonicalBranch(projectRoot);
	let defaultRuntime = "claude";
	try {
		defaultRuntime = await detectDefaultRuntime(spawner);
	} catch {
		// Non-fatal: fall back to claude if runtime detection fails
	}

	process.stdout.write(`Initializing overstory for "${projectName}"...\n\n`);

	// 3. Create directory structure
	const dirs = [
		OVERSTORY_DIR,
		join(OVERSTORY_DIR, "agents"),
		join(OVERSTORY_DIR, "agent-defs"),
		join(OVERSTORY_DIR, "worktrees"),
		join(OVERSTORY_DIR, "specs"),
		join(OVERSTORY_DIR, "logs"),
	];

	for (const dir of dirs) {
		await mkdir(join(projectRoot, dir), { recursive: true });
		printCreated(`${dir}/`);
	}

	// 3b. Deploy agent definition .md files from overstory install directory
	const overstoryAgentsDir = join(import.meta.dir, "..", "..", "agents");
	const agentDefsTarget = join(overstoryPath, "agent-defs");
	const agentDefFiles = await readdir(overstoryAgentsDir);
	for (const fileName of agentDefFiles) {
		if (!fileName.endsWith(".md")) continue;
		if (fileName === "supervisor.md") continue; // Deprecated: not deployed to new projects
		const source = Bun.file(join(overstoryAgentsDir, fileName));
		const content = await source.text();
		await Bun.write(join(agentDefsTarget, fileName), content);
		printCreated(`${OVERSTORY_DIR}/agent-defs/${fileName}`);
	}

	// 4. Write config.yaml
	const config = structuredClone(DEFAULT_CONFIG);
	config.project.name = projectName;
	config.project.root = projectRoot;
	config.project.canonicalBranch = canonicalBranch;
	if (config.runtime) {
		config.runtime.default = defaultRuntime;
	}

	const configYaml = serializeConfigToYaml(config);
	const configPath = join(overstoryPath, "config.yaml");
	await Bun.write(configPath, configYaml);
	printCreated(`${OVERSTORY_DIR}/config.yaml`);

	// 5. Write agent-manifest.json
	const manifest = buildAgentManifest();
	const manifestPath = join(overstoryPath, "agent-manifest.json");
	await Bun.write(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`);
	printCreated(`${OVERSTORY_DIR}/agent-manifest.json`);

	// 6. Write hooks.json
	const hooksContent = buildHooksJson();
	const hooksPath = join(overstoryPath, "hooks.json");
	await Bun.write(hooksPath, hooksContent);
	printCreated(`${OVERSTORY_DIR}/hooks.json`);

	// 7. Write .overstory/.gitignore for runtime state
	await writeOverstoryGitignore(overstoryPath);
	printCreated(`${OVERSTORY_DIR}/.gitignore`);

	// 7b. Write .overstory/README.md
	await writeOverstoryReadme(overstoryPath);
	printCreated(`${OVERSTORY_DIR}/README.md`);

	// 8. Migrate existing SQLite databases on --force reinit
	if (force || yes) {
		const migrated = await migrateExistingDatabases(overstoryPath);
		for (const dbName of migrated) {
			printSuccess("Migrated", dbName);
		}
	}

	// 9. Bootstrap sibling ecosystem tools
	const toolSet = resolveToolSet(opts);
	const toolResults: Record<string, { status: ToolStatus; path: string }> = {
		overstory: { status: "initialized", path: overstoryPath },
	};

	if (toolSet.length > 0) {
		process.stdout.write("\n");
		process.stdout.write("Bootstrapping ecosystem tools...\n\n");
	}

	for (const tool of toolSet) {
		const status = await initSiblingTool(tool, projectRoot, spawner);
		toolResults[tool.name] = {
			status,
			path: join(projectRoot, tool.dotDir),
		};
	}

	// 10. Set up .gitattributes with merge=union for JSONL files
	const gitattrsUpdated = await setupGitattributes(projectRoot);
	if (gitattrsUpdated) {
		printCreated(".gitattributes");
	}

	// 11. Run onboard for each tool (inject CLAUDE.md sections)
	const onboardResults: Record<string, OnboardStatus> = {};
	if (!opts.skipOnboard) {
		for (const tool of toolSet) {
			if (toolResults[tool.name]?.status !== "skipped") {
				const status = await onboardTool(tool, projectRoot, spawner);
				onboardResults[tool.name] = status;
			}
		}
	}

	// 12. Auto-commit scaffold files so ecosystem dirs are tracked before agents create branches.
	// Without this, agent branches that add files to .mulch/.seeds/.canopy cause
	// untracked-vs-tracked conflicts in ov merge (overstory-fe42).
	let scaffoldCommitted = false;
	const pathsToAdd: string[] = [OVERSTORY_DIR];

	// Add .gitattributes if it exists
	try {
		await stat(join(projectRoot, ".gitattributes"));
		pathsToAdd.push(".gitattributes");
	} catch {
		// not present — skip
	}

	// Add CLAUDE.md if it exists (may have been modified by onboard)
	try {
		await stat(join(projectRoot, "CLAUDE.md"));
		pathsToAdd.push("CLAUDE.md");
	} catch {
		// not present — skip
	}

	// Add sibling tool dirs that were created
	for (const tool of SIBLING_TOOLS) {
		try {
			await stat(join(projectRoot, tool.dotDir));
			pathsToAdd.push(tool.dotDir);
		} catch {
			// not present — skip
		}
	}

	const addResult = await spawner(["git", "add", ...pathsToAdd], { cwd: projectRoot });
	if (addResult.exitCode !== 0) {
		printWarning("Scaffold commit skipped", addResult.stderr.trim() || "git add failed");
	} else {
		// git diff --cached --quiet exits 0 if nothing staged, 1 if changes are staged
		const diffResult = await spawner(["git", "diff", "--cached", "--quiet"], {
			cwd: projectRoot,
		});
		if (diffResult.exitCode !== 0) {
			// Changes are staged — commit them
			const commitResult = await spawner(
				["git", "commit", "-m", "chore: initialize overstory and ecosystem tools"],
				{ cwd: projectRoot },
			);
			if (commitResult.exitCode === 0) {
				printSuccess("Committed", "scaffold files");
				scaffoldCommitted = true;
			} else {
				printWarning("Scaffold commit failed", commitResult.stderr.trim() || "git commit failed");
			}
		}
	}

	// 13. Output final result
	if (opts.json) {
		jsonOutput("init", {
			project: projectName,
			tools: toolResults,
			onboard: onboardResults,
			gitattributes: gitattrsUpdated,
			scaffoldCommitted,
		});
		return;
	}

	printSuccess("Initialized");
	printHint("Next: run `ov hooks install` to enable Claude Code hooks.");
	printHint("Then: run `ov status` to see the current state.");
}

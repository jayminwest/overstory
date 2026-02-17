/**
 * CLI command: overstory init [--force]
 *
 * Scaffolds the `.overstory/` directory in the current project with:
 * - config.yaml (serialized from DEFAULT_CONFIG)
 * - agent-manifest.json (starter agent definitions)
 * - hooks.json (central hooks config)
 * - Required subdirectories (agents/, worktrees/, specs/, logs/)
 * - .gitignore entries for transient files
 */

import { Database } from "bun:sqlite";
import { mkdir, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { DEFAULT_CONFIG } from "../config.ts";
import { ValidationError } from "../errors.ts";
import type { AgentManifest, OverstoryConfig } from "../types.ts";

const OVERSTORY_DIR = ".overstory";

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
			if (branch === "main" || branch === "master" || branch === "develop") {
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
				for (const item of value) {
					lines.push(`${itemIndent}- ${formatYamlValue(item)}`);
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
function buildAgentManifest(): AgentManifest {
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
		supervisor: {
			file: "supervisor.md",
			model: "opus",
			tools: ["Read", "Write", "Edit", "Glob", "Grep", "Bash", "Task"],
			capabilities: ["coordinate", "supervise"],
			canSpawn: true,
			constraints: [],
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
function buildHooksJson(): string {
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
							command: "overstory prime --agent orchestrator",
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
							command: "overstory mail check --inject --agent orchestrator",
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
							command: `${toolNameExtract} overstory log tool-start --agent orchestrator --tool-name "$TOOL_NAME"`,
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
							command: `${toolNameExtract} overstory log tool-end --agent orchestrator --tool-name "$TOOL_NAME"`,
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
							command: "overstory log session-end --agent orchestrator",
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
							command: "overstory prime --agent orchestrator --compact",
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
  bead_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  exit_code INTEGER,
  merge_result TEXT,
  parent_agent TEXT,
  PRIMARY KEY (agent_name, bead_id)
)`);
		db.close();
		migrated.push("metrics.db");
	}

	return migrated;
}

/**
 * Content for .overstory/.gitignore — runtime state that should not be tracked.
 * Paths are relative to .overstory/ directory.
 * Config files (config.yaml, agent-manifest.json, hooks.json) remain tracked.
 */
const OVERSTORY_GITIGNORE = `# Runtime state (auto-generated, do not edit)
worktrees/
logs/
mail.db
mail.db-wal
mail.db-shm
metrics.db
metrics.db-wal
metrics.db-shm
events.db
events.db-wal
events.db-shm
sessions.json
sessions.db
sessions.db-wal
sessions.db-shm
merge-queue.db
merge-queue.db-wal
merge-queue.db-shm
nudge-state.json
session-branch.txt
pending-nudges/
agents/
specs/
`;

/**
 * Create .overstory/.gitignore for runtime state files.
 * Follows the same pattern as .beads/.gitignore.
 */
async function writeOverstoryGitignore(overstoryPath: string): Promise<boolean> {
	const gitignorePath = join(overstoryPath, ".gitignore");
	const file = Bun.file(gitignorePath);

	if (await file.exists()) {
		return false;
	}

	await Bun.write(gitignorePath, OVERSTORY_GITIGNORE);
	return true;
}

/**
 * Print a success status line.
 */
function printCreated(relativePath: string): void {
	process.stdout.write(`  \u2713 Created ${relativePath}\n`);
}

/**
 * Print a skip status line.
 */
function printSkipped(relativePath: string, reason: string): void {
	process.stdout.write(`  - Skipped ${relativePath} (${reason})\n`);
}

/**
 * Entry point for `overstory init [--force]`.
 *
 * Scaffolds the .overstory/ directory structure in the current working directory.
 *
 * @param args - CLI arguments after "init" subcommand
 */
const INIT_HELP = `overstory init — Initialize .overstory/ in current project

Usage: overstory init [--force]

Options:
  --force      Reinitialize even if .overstory/ already exists
  --help, -h   Show this help`;

export async function initCommand(args: string[]): Promise<void> {
	if (args.includes("--help") || args.includes("-h")) {
		process.stdout.write(`${INIT_HELP}\n`);
		return;
	}

	const force = args.includes("--force");
	const projectRoot = process.cwd();
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
		if (!force) {
			process.stdout.write(
				"Warning: .overstory/ already initialized in this project.\n" +
					"Use --force to reinitialize.\n",
			);
			return;
		}
		process.stdout.write("Reinitializing .overstory/ (--force)\n\n");
	}

	// 2. Detect project info
	const projectName = await detectProjectName(projectRoot);
	const canonicalBranch = await detectCanonicalBranch(projectRoot);

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
	const gitignoreCreated = await writeOverstoryGitignore(overstoryPath);
	if (gitignoreCreated) {
		printCreated(`${OVERSTORY_DIR}/.gitignore`);
	} else {
		printSkipped(`${OVERSTORY_DIR}/.gitignore`, "already exists");
	}

	// 8. Migrate existing SQLite databases on --force reinit
	if (force) {
		const migrated = await migrateExistingDatabases(overstoryPath);
		for (const dbName of migrated) {
			process.stdout.write(`  \u2713 Migrated ${OVERSTORY_DIR}/${dbName} (schema validated)\n`);
		}
	}

	process.stdout.write("\nDone.\n");
	process.stdout.write("  Next: run `overstory hooks install` to enable Claude Code hooks.\n");
	process.stdout.write("  Then: run `overstory status` to see the current state.\n");
}

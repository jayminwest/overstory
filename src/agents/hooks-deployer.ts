import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AgentError } from "../errors.ts";

/**
 * Capabilities that must never modify project files.
 * Includes read-only roles (scout, reviewer) and coordination roles (lead).
 * Only "builder" and "merger" are allowed to modify files.
 */
const NON_IMPLEMENTATION_CAPABILITIES = new Set([
	"scout",
	"reviewer",
	"lead",
	"coordinator",
	"supervisor",
	"monitor",
]);

/**
 * Claude Code native team/task tools that bypass overstory orchestration.
 * All overstory agents must use `overstory sling` for delegation, not these.
 */
const NATIVE_TEAM_TOOLS = [
	"Task",
	"TeamCreate",
	"TeamDelete",
	"SendMessage",
	"TaskCreate",
	"TaskUpdate",
	"TaskList",
	"TaskGet",
	"TaskOutput",
	"TaskStop",
];

/** Tools that non-implementation agents must not use. */
const WRITE_TOOLS = ["Write", "Edit", "NotebookEdit"];

/**
 * Bash commands that modify files and must be blocked for non-implementation agents.
 * Each pattern is a regex fragment used inside a grep -qE check.
 */
const DANGEROUS_BASH_PATTERNS = [
	"sed\\s+-i",
	"sed\\s+--in-place",
	"echo\\s+.*>",
	"printf\\s+.*>",
	"cat\\s+.*>",
	"tee\\s",
	"\\bvim\\b",
	"\\bnano\\b",
	"\\bvi\\b",
	"\\bmv\\s",
	"\\bcp\\s",
	"\\brm\\s",
	"\\bmkdir\\s",
	"\\btouch\\s",
	"\\bchmod\\s",
	"\\bchown\\s",
	">>",
	"\\bgit\\s+add\\b",
	"\\bgit\\s+commit\\b",
	"\\bgit\\s+merge\\b",
	"\\bgit\\s+push\\b",
	"\\bgit\\s+reset\\b",
	"\\bgit\\s+checkout\\b",
	"\\bgit\\s+rebase\\b",
	"\\bgit\\s+stash\\b",
	"\\bnpm\\s+install\\b",
	"\\bbun\\s+install\\b",
	"\\bbun\\s+add\\b",
	// Runtime eval flags — bypass shell pattern guards by executing JS/Python directly
	"\\bbun\\s+-e\\b",
	"\\bbun\\s+--eval\\b",
	"\\bnode\\s+-e\\b",
	"\\bnode\\s+--eval\\b",
	"\\bdeno\\s+eval\\b",
	"\\bpython3?\\s+-c\\b",
	"\\bperl\\s+-e\\b",
	"\\bruby\\s+-e\\b",
];

/**
 * Bash commands that are always safe for non-implementation agents.
 * If a command starts with any of these prefixes, it bypasses the dangerous command check.
 * This whitelist is checked BEFORE the blocklist.
 */
const SAFE_BASH_PREFIXES = [
	"overstory ",
	"bd ",
	"git status",
	"git log",
	"git diff",
	"git show",
	"git blame",
	"git branch",
	"mulch ",
	"bun test",
	"bun run lint",
	"bun run typecheck",
	"bun run biome",
];

/** Hook entry shape matching Claude Code's settings.local.json format. */
interface HookEntry {
	matcher: string;
	hooks: Array<{ type: string; command: string }>;
}

/**
 * Resolve the path to the hooks template file.
 * The template lives at `templates/hooks.json.tmpl` relative to the repo root.
 */
function getTemplatePath(): string {
	// src/agents/hooks-deployer.ts -> repo root is ../../
	return join(dirname(import.meta.dir), "..", "templates", "hooks.json.tmpl");
}

/**
 * Env var guard prefix for hook commands.
 *
 * When hooks are deployed to the project root (e.g. for the coordinator),
 * they affect ALL Claude Code sessions in that directory. This prefix
 * ensures hooks only activate for overstory-managed agent sessions
 * (which have OVERSTORY_AGENT_NAME set in their environment) and are
 * no-ops for the user's own Claude Code session.
 */
const ENV_GUARD = '[ -z "$OVERSTORY_AGENT_NAME" ] && exit 0;';

/**
 * Build a PreToolUse guard script that validates file paths are within
 * the agent's worktree boundary.
 *
 * Applied to Write, Edit, and NotebookEdit tools. Uses the
 * OVERSTORY_WORKTREE_PATH env var set during tmux session creation
 * to determine the allowed path boundary.
 *
 * @param filePathField - The JSON field name containing the file path
 *   ("file_path" for Write/Edit, "notebook_path" for NotebookEdit)
 */
export function buildPathBoundaryGuardScript(filePathField: string): string {
	const script = [
		// Only enforce for overstory agent sessions
		ENV_GUARD,
		// Skip if worktree path is not set (e.g., orchestrator)
		'[ -z "$OVERSTORY_WORKTREE_PATH" ] && exit 0;',
		"read -r INPUT;",
		// Extract file path from JSON (sed -n + p = empty if no match)
		`FILE_PATH=$(echo "$INPUT" | sed -n 's/.*"${filePathField}": *"\\([^"]*\\)".*/\\1/p');`,
		// No path extracted — fail open (tool may be called differently)
		'[ -z "$FILE_PATH" ] && exit 0;',
		// Resolve relative paths against cwd
		'case "$FILE_PATH" in /*) ;; *) FILE_PATH="$(pwd)/$FILE_PATH" ;; esac;',
		// Allow if path is inside the worktree (exact match or subpath)
		'case "$FILE_PATH" in "$OVERSTORY_WORKTREE_PATH"/*) exit 0 ;; "$OVERSTORY_WORKTREE_PATH") exit 0 ;; esac;',
		// Block: path is outside the worktree boundary
		'echo \'{"decision":"block","reason":"Path boundary violation: file is outside your assigned worktree. All writes must target files within your worktree."}\';',
	].join(" ");
	return script;
}

/**
 * Generate PreToolUse guards that enforce worktree path boundaries.
 *
 * Returns guards for Write (file_path), Edit (file_path), and
 * NotebookEdit (notebook_path). Applied to ALL agent capabilities
 * as defense-in-depth (non-implementation agents already have these
 * tools blocked, but the path guard catches any bypass).
 */
export function getPathBoundaryGuards(): HookEntry[] {
	return [
		{
			matcher: "Write",
			hooks: [{ type: "command", command: buildPathBoundaryGuardScript("file_path") }],
		},
		{
			matcher: "Edit",
			hooks: [{ type: "command", command: buildPathBoundaryGuardScript("file_path") }],
		},
		{
			matcher: "NotebookEdit",
			hooks: [{ type: "command", command: buildPathBoundaryGuardScript("notebook_path") }],
		},
	];
}

/**
 * Build a PreToolUse guard that blocks a specific tool.
 *
 * Returns a JSON response with decision=block so Claude Code rejects
 * the tool call before execution.
 */
function blockGuard(toolName: string, reason: string): HookEntry {
	const response = JSON.stringify({ decision: "block", reason });
	return {
		matcher: toolName,
		hooks: [
			{
				type: "command",
				command: `${ENV_GUARD} echo '${response}'`,
			},
		],
	};
}

/**
 * Build a Bash guard script that inspects the command from stdin JSON.
 *
 * Claude Code PreToolUse hooks receive `{"tool_name": "Bash", "tool_input": {"command": "..."}, ...}` on stdin.
 * This builds a bash script that reads stdin, extracts the command, and checks for
 * dangerous patterns (push to canonical branch, hard reset, wrong branch naming).
 */
function buildBashGuardScript(agentName: string): string {
	// The script reads JSON from stdin, extracts the command field, then checks patterns.
	// Uses parameter expansion to avoid requiring jq (zero runtime deps).
	const script = [
		// Only enforce for overstory agent sessions (skip for user's own Claude Code)
		ENV_GUARD,
		"read -r INPUT;",
		// Extract command value from JSON — grab everything after "command": (with optional space)
		'CMD=$(echo "$INPUT" | sed \'s/.*"command": *"\\([^"]*\\)".*/\\1/\');',
		// Check 1: Block all git push — agents must never push to remote
		"if echo \"$CMD\" | grep -qE '\\bgit\\s+push\\b'; then",
		'  echo \'{"decision":"block","reason":"git push is blocked — use overstory merge to integrate changes, push manually when ready"}\';',
		"  exit 0;",
		"fi;",
		// Check 2: Block git reset --hard
		"if echo \"$CMD\" | grep -qE 'git\\s+reset\\s+--hard'; then",
		'  echo \'{"decision":"block","reason":"git reset --hard is not allowed — it destroys uncommitted work"}\';',
		"  exit 0;",
		"fi;",
		// Check 3: Warn on git checkout -b with wrong naming convention
		"if echo \"$CMD\" | grep -qE 'git\\s+checkout\\s+-b\\s'; then",
		`  BRANCH=$(echo "$CMD" | sed 's/.*git\\s*checkout\\s*-b\\s*\\([^ ]*\\).*/\\1/');`,
		`  if ! echo "$BRANCH" | grep -qE '^overstory/${agentName}/'; then`,
		`    echo '{"decision":"block","reason":"Branch must follow overstory/${agentName}/{bead-id} convention"}';`,
		"    exit 0;",
		"  fi;",
		"fi;",
	].join(" ");
	return script;
}

/**
 * Generate Bash-level PreToolUse guards for dangerous operations.
 *
 * Applied to ALL agent capabilities. Inspects Bash tool commands for:
 * - `git push` to canonical branches (main/master) — blocked
 * - `git reset --hard` — blocked
 * - `git checkout -b` with non-standard branch naming — blocked
 *
 * @param agentName - The agent name, used for branch naming validation
 */
export function getDangerGuards(agentName: string): HookEntry[] {
	return [
		{
			matcher: "Bash",
			hooks: [
				{
					type: "command",
					command: buildBashGuardScript(agentName),
				},
			],
		},
	];
}

/**
 * Build a Bash guard script that blocks file-modifying commands for non-implementation agents.
 *
 * Uses a whitelist-first approach: if the command matches a known-safe prefix, it passes.
 * Otherwise, it checks against dangerous patterns and blocks if any match.
 *
 * @param capability - The agent capability, included in block reason messages
 * @param extraSafePrefixes - Additional safe prefixes for this capability (e.g. git add/commit for coordinators)
 */
export function buildBashFileGuardScript(
	capability: string,
	extraSafePrefixes: string[] = [],
): string {
	// Build the safe prefix check: if command starts with any safe prefix, allow it
	const allSafePrefixes = [...SAFE_BASH_PREFIXES, ...extraSafePrefixes];
	const safePrefixChecks = allSafePrefixes
		.map((prefix) => `if echo "$CMD" | grep -qE '^\\s*${prefix}'; then exit 0; fi;`)
		.join(" ");

	// Build the dangerous pattern check
	const dangerPattern = DANGEROUS_BASH_PATTERNS.join("|");

	const script = [
		// Only enforce for overstory agent sessions (skip for user's own Claude Code)
		ENV_GUARD,
		"read -r INPUT;",
		// Extract command value from JSON (with optional space after colon)
		'CMD=$(echo "$INPUT" | sed \'s/.*"command": *"\\([^"]*\\)".*/\\1/\');',
		// First: whitelist safe commands
		safePrefixChecks,
		// Then: check for dangerous patterns
		`if echo "$CMD" | grep -qE '${dangerPattern}'; then`,
		`  echo '{"decision":"block","reason":"${capability} agents cannot modify files — this command is not allowed"}';`,
		"  exit 0;",
		"fi;",
	].join(" ");
	return script;
}

/**
 * Capabilities that are allowed to modify files via Bash commands.
 * These get the Bash path boundary guard instead of a blanket file-modification block.
 */
const IMPLEMENTATION_CAPABILITIES = new Set(["builder", "merger"]);

/**
 * Bash patterns that modify files and require path boundary validation.
 * Each entry is a regex fragment matched against the extracted command.
 * When matched, all absolute paths in the command are checked against the worktree boundary.
 */
const FILE_MODIFYING_BASH_PATTERNS = [
	"sed\\s+-i",
	"sed\\s+--in-place",
	"echo\\s+.*>",
	"printf\\s+.*>",
	"cat\\s+.*>",
	"tee\\s",
	"\\bmv\\s",
	"\\bcp\\s",
	"\\brm\\s",
	"\\bmkdir\\s",
	"\\btouch\\s",
	"\\bchmod\\s",
	"\\bchown\\s",
	">>",
	"\\binstall\\s",
	"\\brsync\\s",
];

/**
 * Build a Bash PreToolUse guard script that validates file-modifying commands
 * keep their target paths within the agent's worktree boundary.
 *
 * Applied to builder/merger agents. For file-modifying Bash commands (sed -i,
 * echo >, cp, mv, tee, install, rsync, etc.), extracts all absolute paths
 * from the command and verifies they resolve within the worktree.
 *
 * Limitations (documented by design):
 * - Cannot detect paths constructed via variable expansion ($VAR/file)
 * - Cannot detect paths reached via cd + relative path
 * - Cannot detect paths inside subshells or backtick evaluation
 * - Relative paths are assumed safe (tmux cwd IS the worktree)
 *
 * Uses OVERSTORY_WORKTREE_PATH env var set during tmux session creation.
 */
export function buildBashPathBoundaryScript(): string {
	const fileModifyPattern = FILE_MODIFYING_BASH_PATTERNS.join("|");

	const script = [
		// Only enforce for overstory agent sessions
		ENV_GUARD,
		// Skip if worktree path is not set (e.g., orchestrator)
		'[ -z "$OVERSTORY_WORKTREE_PATH" ] && exit 0;',
		"read -r INPUT;",
		// Extract command value from JSON (with optional space after colon)
		'CMD=$(echo "$INPUT" | sed \'s/.*"command": *"\\([^"]*\\)".*/\\1/\');',
		// Only check file-modifying commands — non-modifying commands pass through
		`if ! echo "$CMD" | grep -qE '${fileModifyPattern}'; then exit 0; fi;`,
		// Extract all absolute paths (tokens starting with /) from the command.
		// Uses tr to split on whitespace, grep to find /paths, sed to strip trailing quotes/semicolons.
		"PATHS=$(echo \"$CMD\" | tr ' \\t' '\\n\\n' | grep '^/' | sed 's/[\";>]*$//');",
		// If no absolute paths found, allow (relative paths resolve from worktree cwd)
		'[ -z "$PATHS" ] && exit 0;',
		// Check each absolute path against the worktree boundary
		'echo "$PATHS" | while IFS= read -r P; do',
		'  case "$P" in',
		'    "$OVERSTORY_WORKTREE_PATH"/*) ;;',
		'    "$OVERSTORY_WORKTREE_PATH") ;;',
		"    /dev/*) ;;",
		"    /tmp/*) ;;",
		'    *) echo \'{"decision":"block","reason":"Bash path boundary violation: command targets a path outside your worktree. All file modifications must stay within your assigned worktree."}\'; exit 0; ;;',
		"  esac;",
		"done;",
	].join(" ");
	return script;
}

/**
 * Generate Bash path boundary guards for implementation capabilities.
 *
 * Returns a single Bash PreToolUse guard that checks file-modifying commands
 * for absolute paths outside the worktree boundary.
 *
 * Only applied to builder/merger agents (implementation capabilities).
 * Non-implementation agents already have all file-modifying Bash commands
 * blocked via buildBashFileGuardScript().
 */
export function getBashPathBoundaryGuards(): HookEntry[] {
	return [
		{
			matcher: "Bash",
			hooks: [{ type: "command", command: buildBashPathBoundaryScript() }],
		},
	];
}

/**
 * Generate capability-specific PreToolUse guards.
 *
 * Non-implementation capabilities (scout, reviewer, lead, coordinator, supervisor, monitor) get:
 * - Write, Edit, NotebookEdit tool blocks
 * - Bash file-modification command guards (sed -i, echo >, mv, rm, etc.)
 *
 * Implementation capabilities (builder, merger) get:
 * - Bash path boundary guards (validates absolute paths stay in worktree)
 *
 * All overstory-managed agents get:
 * - Claude Code native team/task tool blocks (Task, TeamCreate, SendMessage, etc.)
 *   to ensure delegation goes through overstory sling
 *
 * Note: All capabilities also receive Bash danger guards via getDangerGuards().
 */
export function getCapabilityGuards(capability: string): HookEntry[] {
	const guards: HookEntry[] = [];

	// Block Claude Code native team/task tools for ALL overstory agents.
	// Agents must use `overstory sling` for delegation, not native Task/Team tools.
	const teamToolGuards = NATIVE_TEAM_TOOLS.map((tool) =>
		blockGuard(
			tool,
			`Overstory agents must use 'overstory sling' for delegation — ${tool} is not allowed`,
		),
	);
	guards.push(...teamToolGuards);

	if (NON_IMPLEMENTATION_CAPABILITIES.has(capability)) {
		const toolGuards = WRITE_TOOLS.map((tool) =>
			blockGuard(tool, `${capability} agents cannot modify files — ${tool} is not allowed`),
		);
		guards.push(...toolGuards);

		const bashFileGuard: HookEntry = {
			matcher: "Bash",
			hooks: [
				{
					type: "command",
					command: buildBashFileGuardScript(capability),
				},
			],
		};
		guards.push(bashFileGuard);
	}

	// Implementation capabilities get Bash path boundary validation
	// (non-implementation agents already block all file-modifying Bash commands)
	if (IMPLEMENTATION_CAPABILITIES.has(capability)) {
		guards.push(...getBashPathBoundaryGuards());
	}

	return guards;
}

/**
 * Deploy hooks config to an agent's worktree as `.claude/settings.local.json`.
 *
 * Reads `templates/hooks.json.tmpl`, replaces `{{AGENT_NAME}}`, then merges
 * capability-specific PreToolUse guards into the resulting config.
 *
 * @param worktreePath - Absolute path to the agent's git worktree
 * @param agentName - The unique name of the agent
 * @param capability - Agent capability (builder, scout, reviewer, lead, merger)
 * @throws {AgentError} If the template is not found or the write fails
 */
export async function deployHooks(
	worktreePath: string,
	agentName: string,
	capability = "builder",
): Promise<void> {
	const templatePath = getTemplatePath();
	const file = Bun.file(templatePath);
	const exists = await file.exists();

	if (!exists) {
		throw new AgentError(`Hooks template not found: ${templatePath}`, {
			agentName,
		});
	}

	let template: string;
	try {
		template = await file.text();
	} catch (err) {
		throw new AgentError(`Failed to read hooks template: ${templatePath}`, {
			agentName,
			cause: err instanceof Error ? err : undefined,
		});
	}

	// Replace all occurrences of {{AGENT_NAME}}
	let content = template;
	while (content.includes("{{AGENT_NAME}}")) {
		content = content.replace("{{AGENT_NAME}}", agentName);
	}

	// Parse the base config and merge guards into PreToolUse
	const config = JSON.parse(content) as { hooks: Record<string, HookEntry[]> };
	const pathGuards = getPathBoundaryGuards();
	const dangerGuards = getDangerGuards(agentName);
	const capabilityGuards = getCapabilityGuards(capability);
	const allGuards = [...pathGuards, ...dangerGuards, ...capabilityGuards];

	if (allGuards.length > 0) {
		const preToolUse = config.hooks.PreToolUse ?? [];
		config.hooks.PreToolUse = [...allGuards, ...preToolUse];
	}

	const finalContent = `${JSON.stringify(config, null, "\t")}\n`;

	const claudeDir = join(worktreePath, ".claude");
	const outputPath = join(claudeDir, "settings.local.json");

	try {
		await mkdir(claudeDir, { recursive: true });
	} catch (err) {
		throw new AgentError(`Failed to create .claude/ directory at: ${claudeDir}`, {
			agentName,
			cause: err instanceof Error ? err : undefined,
		});
	}

	try {
		await Bun.write(outputPath, finalContent);
	} catch (err) {
		throw new AgentError(`Failed to write hooks config to: ${outputPath}`, {
			agentName,
			cause: err instanceof Error ? err : undefined,
		});
	}
}

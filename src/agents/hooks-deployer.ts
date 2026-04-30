import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DEFAULT_QUALITY_GATES } from "../config.ts";
import { AgentError } from "../errors.ts";
import type { QualityGate } from "../types.ts";
import {
	DANGEROUS_BASH_PATTERNS,
	INTERACTIVE_TOOLS,
	NATIVE_TEAM_TOOLS,
	SAFE_BASH_PREFIXES,
	WRITE_TOOLS,
} from "./guard-rules.ts";

/**
 * Capabilities that must never modify project files.
 * Includes read-only roles (scout, reviewer) and coordination roles (lead).
 * Only "builder" and "merger" are allowed to modify files.
 */
const NON_IMPLEMENTATION_CAPABILITIES = new Set([
	"scout",
	"reviewer",
	"lead",
	"orchestrator",
	"coordinator",
	"supervisor",
	"monitor",
]);

/**
 * Capabilities that coordinate work and need git add/commit for syncing
 * tasks, mulch, and other metadata — but must NOT git push.
 */
const COORDINATION_CAPABILITIES = new Set(["coordinator", "orchestrator", "supervisor", "monitor"]);

/**
 * Additional safe Bash prefixes for coordination capabilities.
 * Allows git add/commit for task sync, mulch records, etc.
 * git push remains blocked via DANGEROUS_BASH_PATTERNS.
 */
const COORDINATION_SAFE_PREFIXES = ["git add", "git commit"];

/**
 * Extract command prefixes from quality gate configurations.
 *
 * Each gate's command is used as a safe prefix so non-implementation agents
 * can still run quality gate commands (e.g., reviewers running tests).
 * This makes the safe prefix list configurable instead of hardcoding
 * specific tool commands like "bun test".
 */
export function extractQualityGatePrefixes(gates: QualityGate[]): string[] {
	return gates.map((g) => g.command);
}

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
 * PATH setup prefix for hook commands.
 *
 * Claude Code executes hook commands via /bin/sh with a minimal PATH
 * (/usr/bin:/bin:/usr/sbin:/sbin). Bun-installed CLIs — ov, ml, sd, cn, bd —
 * live in ~/.bun/bin which is absent from that PATH, causing hooks like
 * `ov prime` (SessionStart) and `ml learn` (Stop) to fail with
 * "command not found".
 *
 * Prepend this to any hook command that invokes one of those CLIs so they
 * resolve correctly regardless of how Claude Code was launched.
 *
 * Exported so tests can verify the exact prefix value.
 */
export const PATH_PREFIX = 'export PATH="$HOME/.bun/bin:/usr/local/bin:/opt/homebrew/bin:$PATH";';

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
 * Escape a string for use inside a single-quoted POSIX shell string.
 *
 * POSIX single-quoted strings cannot contain single quotes at all.
 * The standard technique is to end the single-quoted segment, emit an escaped
 * single quote using $'\'', then start a new single-quoted segment:
 *   'it'\''s fine'  →  it's fine
 *
 * Exported so tests can verify escaping directly.
 */
export function escapeForSingleQuotedShell(str: string): string {
	return str.replace(/'/g, "'\\''");
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
				command: `${ENV_GUARD} echo '${escapeForSingleQuotedShell(response)}'`,
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
		'  echo \'{"decision":"block","reason":"git push is blocked — use ov merge to integrate changes, push manually when ready"}\';',
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
		`    echo '{"decision":"block","reason":"Branch must follow overstory/${agentName}/{task-id} convention"}';`,
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
 * Build a PreToolUse guard script that prevents agents from closing or updating
 * issues they don't own.
 *
 * Guards against two patterns:
 * - `sd/bd close <id>` — blocks if <id> != $OVERSTORY_TASK_ID
 * - `sd/bd update <id> --status` — blocks if <id> != $OVERSTORY_TASK_ID
 *
 * Agents without OVERSTORY_TASK_ID (coordinator, monitor) exit early and are unaffected.
 */
export function buildTrackerCloseGuardScript(): string {
	const script = [
		// Only enforce for overstory agent sessions
		ENV_GUARD,
		// Skip if task ID is not set (coordinator/monitor have no task)
		'[ -z "$OVERSTORY_TASK_ID" ] && exit 0;',
		"read -r INPUT;",
		// Extract command value from JSON
		'CMD=$(echo "$INPUT" | sed \'s/.*"command": *"\\([^"]*\\)".*/\\1/\');',
		// Check for sd/bd close <id>
		"if echo \"$CMD\" | grep -qE '^\\s*(sd|bd)\\s+close\\s'; then",
		"  ISSUE_ID=$(echo \"$CMD\" | sed -E 's/^[[:space:]]*(sd|bd)[[:space:]]+close[[:space:]]+([^ ]+).*/\\2/');",
		'  if [ "$ISSUE_ID" != "$OVERSTORY_TASK_ID" ]; then',
		'    echo "{\\"decision\\":\\"block\\",\\"reason\\":\\"Cannot close issue $ISSUE_ID — agents may only close their own task ($OVERSTORY_TASK_ID). Report completion via worker_done mail to your parent instead.\\"}";',
		"    exit 0;",
		"  fi;",
		"fi;",
		// Check for sd/bd update <id> --status
		"if echo \"$CMD\" | grep -qE '^\\s*(sd|bd)\\s+update\\s.*--status'; then",
		"  ISSUE_ID=$(echo \"$CMD\" | sed -E 's/^[[:space:]]*(sd|bd)[[:space:]]+update[[:space:]]+([^ ]+).*/\\2/');",
		'  if [ "$ISSUE_ID" != "$OVERSTORY_TASK_ID" ]; then',
		'    echo "{\\"decision\\":\\"block\\",\\"reason\\":\\"Cannot update issue $ISSUE_ID — agents may only update their own task ($OVERSTORY_TASK_ID).\\"}";',
		"    exit 0;",
		"  fi;",
		"fi;",
	].join(" ");
	return script;
}

/**
 * Generate a PreToolUse guard that blocks tracker close/update for foreign issues.
 *
 * Returns a single Bash matcher entry. Applied to ALL agent capabilities
 * so that no agent can accidentally close the coordinator's dispatch issue.
 * Agents without OVERSTORY_TASK_ID (coordinator, monitor) are unaffected.
 */
export function getTrackerCloseGuards(): HookEntry[] {
	return [
		{
			matcher: "Bash",
			hooks: [{ type: "command", command: buildTrackerCloseGuardScript() }],
		},
	];
}

/**
 * Build a PreToolUse guard script that enforces the merge_ready gate on lead
 * agents (overstory-3899, overstory-da9b): a lead may not run
 * `sd/bd close $OVERSTORY_TASK_ID` unless (a) it has sent at least one
 * `merge_ready` mail AND has sent at least one `merge_ready` per `worker_done`
 * it has received, AND (b) the lead's branch (worktree HEAD) is reachable
 * from the merge target (session-branch.txt > "main") via
 * `git merge-base --is-ancestor`. (a) proves the lead reported completion;
 * (b) proves the coordinator actually merged the work.
 *
 * Counts are derived by querying `ov mail list --json` and grep-counting
 * `"id":"` occurrences in the JSON response (no jq dependency). The gate
 * is a no-op for non-lead agents because it is only deployed to leads via
 * `getLeadCloseGateGuards()`, but it still self-protects: the script
 * exits early when OVERSTORY_AGENT_NAME or OVERSTORY_TASK_ID is unset.
 * The merge-ancestor check fails open when OVERSTORY_WORKTREE_PATH is unset
 * or the target ref cannot be resolved locally — in those cases we cannot
 * make a definitive claim, so we don't block.
 *
 * Foreign-task closes are caught earlier by `buildTrackerCloseGuardScript`,
 * so this gate only fires when the issue ID matches OVERSTORY_TASK_ID.
 */
export function buildLeadCloseGateScript(): string {
	const blockNoMergeReady = JSON.stringify({
		decision: "block",
		reason:
			'merge_ready gate: cannot close your task — you have not sent a merge_ready mail to coordinator. Required: ov mail send --to coordinator --subject "merge_ready: <task>" --body "<branch + files>" --type merge_ready --from $OVERSTORY_AGENT_NAME. Then retry the close.',
	});
	const blockUnderCount = JSON.stringify({
		decision: "block",
		reason:
			"merge_ready gate: cannot close your task — merge_ready count is less than worker_done received. Send one merge_ready per worker_done before closing.",
	});
	const blockNotMerged = JSON.stringify({
		decision: "block",
		reason:
			"merge_ready gate: cannot close your task — your branch is not yet merged into the target (session-branch.txt or main). Wait for the coordinator to merge before closing. The merge step is what makes the work real.",
	});

	const script = [
		// Only enforce for overstory agent sessions
		ENV_GUARD,
		// Skip if task ID is not set (coordinator/monitor have no task)
		'[ -z "$OVERSTORY_TASK_ID" ] && exit 0;',
		"read -r INPUT;",
		// Extract command value from JSON
		'CMD=$(echo "$INPUT" | sed \'s/.*"command": *"\\([^"]*\\)".*/\\1/\');',
		// Only inspect sd/bd close commands
		"if ! echo \"$CMD\" | grep -qE '^\\s*(sd|bd)\\s+close\\s'; then exit 0; fi;",
		// Extract the issue ID being closed
		"ISSUE_ID=$(echo \"$CMD\" | sed -E 's/^[[:space:]]*(sd|bd)[[:space:]]+close[[:space:]]+([^ ]+).*/\\2/');",
		// Only gate when the lead is closing its own task. Foreign closes are blocked by buildTrackerCloseGuardScript.
		'[ "$ISSUE_ID" != "$OVERSTORY_TASK_ID" ] && exit 0;',
		// Count merge_ready mails sent by this agent
		'MR=$(ov mail list --json --from "$OVERSTORY_AGENT_NAME" --type merge_ready 2>/dev/null | grep -o \'"id":"\' | wc -l | tr -d \' \');',
		// Count worker_done mails received by this agent
		'WD=$(ov mail list --json --to "$OVERSTORY_AGENT_NAME" --type worker_done 2>/dev/null | grep -o \'"id":"\' | wc -l | tr -d \' \');',
		// Default to 0 if the count failed for any reason.
		// biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion, not a JS template
		"MR=${MR:-0}; WD=${WD:-0};",
		// Block if no merge_ready was ever sent
		'if [ "$MR" -eq 0 ]; then',
		`  echo '${escapeForSingleQuotedShell(blockNoMergeReady)}';`,
		"  exit 0;",
		"fi;",
		// Block if not enough merge_ready for the worker_done count
		'if [ "$MR" -lt "$WD" ]; then',
		`  echo '${escapeForSingleQuotedShell(blockUnderCount)}';`,
		"  exit 0;",
		"fi;",
		// Verify the lead's branch is actually merged into the target (overstory-da9b).
		// merge_ready alone doesn't prove the work landed — the coordinator may still be
		// verifying or the merge may have failed.
		// Skip if worktree path is missing (test envs etc.) — fail open.
		'[ -z "$OVERSTORY_WORKTREE_PATH" ] && exit 0;',
		// Resolve target branch: $OVERSTORY_PROJECT_ROOT/.overstory/session-branch.txt > "main"
		'TARGET="";',
		'if [ -n "$OVERSTORY_PROJECT_ROOT" ] && [ -f "$OVERSTORY_PROJECT_ROOT/.overstory/session-branch.txt" ]; then',
		'  TARGET=$(tr -d "[:space:]" < "$OVERSTORY_PROJECT_ROOT/.overstory/session-branch.txt" 2>/dev/null);',
		"fi;",
		'[ -z "$TARGET" ] && TARGET=main;',
		// If the target ref doesn't exist locally, we can't verify — fail open.
		'if ! git -C "$OVERSTORY_WORKTREE_PATH" rev-parse --verify "$TARGET" >/dev/null 2>&1; then exit 0; fi;',
		// Block if HEAD is not yet an ancestor of the target.
		'if ! git -C "$OVERSTORY_WORKTREE_PATH" merge-base --is-ancestor HEAD "$TARGET" >/dev/null 2>&1; then',
		`  echo '${escapeForSingleQuotedShell(blockNotMerged)}';`,
		"  exit 0;",
		"fi;",
	].join(" ");
	return script;
}

/**
 * Generate the lead-only PreToolUse guard that gates `sd/bd close <own-task>`
 * on merge_ready emission. Wraps `buildLeadCloseGateScript` with the standard
 * PATH_PREFIX so `ov` resolves under Claude Code's minimal hook PATH.
 *
 * Only deployed to lead agents (see getCapabilityGuards).
 */
export function getLeadCloseGateGuards(): HookEntry[] {
	return [
		{
			matcher: "Bash",
			hooks: [{ type: "command", command: `${PATH_PREFIX} ${buildLeadCloseGateScript()}` }],
		},
	];
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
 * - Coordination capabilities (coordinator, supervisor) get git add/commit whitelisted
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
export function getCapabilityGuards(capability: string, qualityGates?: QualityGate[]): HookEntry[] {
	const guards: HookEntry[] = [];
	const gates = qualityGates ?? DEFAULT_QUALITY_GATES;
	const gatePrefixes = extractQualityGatePrefixes(gates);

	// Block Claude Code native team/task tools for ALL overstory agents.
	// Agents must use `overstory sling` for delegation, not native Task/Team tools.
	const teamToolGuards = NATIVE_TEAM_TOOLS.map((tool) =>
		blockGuard(
			tool,
			`Overstory agents must use 'ov sling' for delegation — ${tool} is not allowed`,
		),
	);
	guards.push(...teamToolGuards);

	// Block interactive tools for ALL overstory agents.
	// These tools require a human to respond and block indefinitely in tmux sessions.
	// Agents must use overstory mail (--type question) to escalate instead.
	const interactiveGuards = INTERACTIVE_TOOLS.map((tool) =>
		blockGuard(
			tool,
			`${tool} requires human interaction -- agents run non-interactively. Use ov mail (--type question) to escalate`,
		),
	);
	guards.push(...interactiveGuards);

	if (NON_IMPLEMENTATION_CAPABILITIES.has(capability)) {
		const toolGuards = WRITE_TOOLS.map((tool) =>
			blockGuard(tool, `${capability} agents cannot modify files — ${tool} is not allowed`),
		);
		guards.push(...toolGuards);

		// Coordination capabilities get git add/commit whitelisted for task/mulch sync
		const extraSafe = COORDINATION_CAPABILITIES.has(capability)
			? [...COORDINATION_SAFE_PREFIXES, ...gatePrefixes]
			: gatePrefixes;
		const bashFileGuard: HookEntry = {
			matcher: "Bash",
			hooks: [
				{
					type: "command",
					command: buildBashFileGuardScript(capability, extraSafe),
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

	// Lead agents get the merge_ready gate on sd/bd close (overstory-3899).
	// Blocks closing the lead's own task unless at least one merge_ready mail
	// has been sent and the count covers all worker_done received.
	if (capability === "lead") {
		guards.push(...getLeadCloseGateGuards());
	}

	return guards;
}

/**
 * Check whether a hook entry is overstory-managed.
 *
 * Overstory hook commands always reference either `ov ` / `overstory` (CLI commands)
 * or `OVERSTORY_` (env var guards like OVERSTORY_AGENT_NAME, OVERSTORY_WORKTREE_PATH).
 * User hooks will not contain these patterns.
 */
export function isOverstoryHookEntry(entry: HookEntry): boolean {
	return entry.hooks.some(
		(h) =>
			h.command.includes("ov ") ||
			h.command.includes("overstory") ||
			h.command.includes("OVERSTORY_"),
	);
}

/**
 * Deploy hooks config to an agent's worktree as `.claude/settings.local.json`.
 *
 * Reads `templates/hooks.json.tmpl`, replaces `{{AGENT_NAME}}`, then merges
 * capability-specific PreToolUse guards into the resulting config.
 *
 * When the target file already exists (e.g. at the project root for coordinator/
 * supervisor/monitor), preserves non-hooks keys and user-defined hook entries.
 * Stale overstory hook entries are stripped and replaced with the new set.
 * Overstory hooks are placed before user hooks per event type so security
 * guards run first.
 *
 * In `headlessOnly` mode, only PreToolUse hooks are deployed (overstory-e24b).
 * Headless Claude Code (`-p --output-format stream-json`) DOES dispatch hooks
 * from settings.local.json, so PreToolUse security guards (path boundary,
 * capability blocks, bash danger patterns, tracker close, lead close gate)
 * are required to keep parity with tmux mode. The other hook types are dropped
 * because they have headless equivalents already wired up:
 *  - SessionStart  → buildInitialHeadlessPrompt() in sling.ts
 *  - UserPromptSubmit → mail injection loop owned by `ov serve`
 *  - PostToolUse → stream-json parser captures tool_use/tool_result
 *  - Stop → stream-json parser captures the `result` event
 *  - PreCompact → deferred (tracked separately)
 *
 * @param worktreePath - Absolute path to the agent's git worktree (or project root)
 * @param agentName - The unique name of the agent
 * @param capability - Agent capability (builder, scout, reviewer, lead, merger)
 * @param qualityGates - Quality gates whose commands are whitelisted as safe Bash prefixes
 * @param headlessOnly - When true, deploy only PreToolUse entries (overstory-e24b)
 * @throws {AgentError} If the template is not found or the write fails
 */
export async function deployHooks(
	worktreePath: string,
	agentName: string,
	capability = "builder",
	qualityGates?: QualityGate[],
	headlessOnly = false,
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

	// Parse the base config from the template
	const config = JSON.parse(content) as { hooks: Record<string, HookEntry[]> };

	// Headless mode: drop all template-derived hook entries.
	// Under spawn-per-turn (Phase 3, overstory-2cf9), the turn-runner provides
	// the user prompt and emits its own observability events for every turn;
	// the template's SessionStart/UserPromptSubmit/PostToolUse/Stop/PreCompact
	// hooks would either double-deliver mail (UserPromptSubmit re-injects on top
	// of the runner's prompt) or duplicate session_end / per-tool events.
	// Only the dynamic PreToolUse security guards added below are retained.
	if (headlessOnly) {
		config.hooks = {};
	}

	// Extend PATH in all template hook commands.
	// Claude Code invokes hooks with PATH=/usr/bin:/bin:/usr/sbin:/sbin — ~/.bun/bin
	// (where ov, ml, sd, etc. live) is not included. Prepend PATH_PREFIX so CLIs resolve.
	for (const entries of Object.values(config.hooks)) {
		for (const entry of entries) {
			for (const hook of entry.hooks) {
				hook.command = `${PATH_PREFIX} ${hook.command}`;
			}
		}
	}

	// Merge capability-specific PreToolUse guards into the config.
	// Guards are generated scripts using only shell built-ins (grep, sed, echo, exit)
	// and do not require PATH extension.
	const pathGuards = getPathBoundaryGuards();
	const dangerGuards = getDangerGuards(agentName);
	const capabilityGuards = getCapabilityGuards(capability, qualityGates);
	const trackerCloseGuards = getTrackerCloseGuards();
	const allGuards = [...pathGuards, ...dangerGuards, ...capabilityGuards, ...trackerCloseGuards];

	if (allGuards.length > 0) {
		const preToolUse = config.hooks.PreToolUse ?? [];
		config.hooks.PreToolUse = [...allGuards, ...preToolUse];
	}

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

	// Read existing settings.local.json to preserve user hooks and non-hooks keys
	let existingConfig: Record<string, unknown> = {};
	const existingFile = Bun.file(outputPath);
	if (await existingFile.exists()) {
		try {
			const existingContent = await existingFile.text();
			existingConfig = JSON.parse(existingContent) as Record<string, unknown>;
		} catch {
			// Malformed existing file — start fresh
		}
	}

	// Separate non-hooks keys (permissions, env, $schema, etc.) from hooks
	const { hooks: existingHooksRaw, ...nonHooksKeys } = existingConfig;

	// Partition existing hooks: keep user entries, discard stale overstory entries
	const existingHooks = (existingHooksRaw ?? {}) as Record<string, HookEntry[]>;
	const userHooks: Record<string, HookEntry[]> = {};
	for (const [eventType, entries] of Object.entries(existingHooks)) {
		const userEntries = entries.filter((e) => !isOverstoryHookEntry(e));
		if (userEntries.length > 0) {
			userHooks[eventType] = userEntries;
		}
	}

	// Merge: overstory hooks first (security guards must run first), then user hooks
	const mergedHooks: Record<string, HookEntry[]> = {};
	const allEventTypes = new Set([...Object.keys(config.hooks), ...Object.keys(userHooks)]);
	for (const eventType of allEventTypes) {
		const overstoryEntries = config.hooks[eventType] ?? [];
		const userEntries = userHooks[eventType] ?? [];
		mergedHooks[eventType] = [...overstoryEntries, ...userEntries];
	}

	const finalConfig = { ...nonHooksKeys, hooks: mergedHooks };
	const finalContent = `${JSON.stringify(finalConfig, null, "\t")}\n`;

	try {
		await Bun.write(outputPath, finalContent);
	} catch (err) {
		throw new AgentError(`Failed to write hooks config to: ${outputPath}`, {
			agentName,
			cause: err instanceof Error ? err : undefined,
		});
	}
}

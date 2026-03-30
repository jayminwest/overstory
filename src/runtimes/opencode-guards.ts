// OpenCode runtime guard plugin generator.
// Generates self-contained TypeScript code for .opencode/plugins/overstory-guard.ts.
//
// OpenCode's plugin system uses the named-export factory style:
//   export const OverstoryGuard = async (ctx) => ({ "tool.execute.before": handler })
//
// Guards fire via "tool.execute.before" and throw Error(reason) to block tool execution —
// equivalent to Claude Code's PreToolUse hooks and Pi's tool_call extension events.
//
// OpenCode tool names are lowercase: bash, edit, write, read, grep, glob, list, task, skill.
//
// Activity tracking fires via $`ov log ...` on tool.execute.after so the SessionStore
// lastActivity stays fresh and the watchdog does not zombie-classify agents.

import { DANGEROUS_BASH_PATTERNS, SAFE_BASH_PREFIXES, WRITE_TOOLS } from "../agents/guard-rules.ts";
import { extractQualityGatePrefixes } from "../agents/hooks-deployer.ts";
import { DEFAULT_QUALITY_GATES } from "../config.ts";
import type { HooksDef } from "./types.ts";

/** Capabilities that must not modify project files. */
const NON_IMPLEMENTATION_CAPABILITIES = new Set([
	"scout",
	"reviewer",
	"lead",
	"orchestrator",
	"coordinator",
	"supervisor",
	"monitor",
]);

/** Coordination capabilities that get git add/commit whitelisted for metadata sync. */
const COORDINATION_CAPABILITIES = new Set(["coordinator", "orchestrator", "supervisor", "monitor"]);

/**
 * Bash patterns that modify files and require path boundary validation.
 * Mirrors FILE_MODIFYING_BASH_PATTERNS in hooks-deployer.ts (not exported, duplicated here).
 * Applied to implementation agents (builder/merger) only.
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

/** Serialize a string array as a JavaScript Set literal (tab-indented entries). */
function toSetLiteral(items: string[]): string {
	if (items.length === 0) return "new Set([])";
	const entries = items.map((s) => `\t"${s}",`).join("\n");
	return `new Set([\n${entries}\n])`;
}

/** Serialize a string array as a JavaScript string[] literal (tab-indented entries). */
function toStringArrayLiteral(items: string[]): string {
	if (items.length === 0) return "[]";
	const entries = items.map((s) => `\t"${s}",`).join("\n");
	return `[\n${entries}\n]`;
}

/**
 * Serialize grep -qE pattern strings as a JavaScript RegExp[] literal.
 * Pattern strings use \\b/\\s double-escaping: their string values (\b/\s) map
 * directly to JavaScript regex word boundary/whitespace tokens.
 */
function toRegExpArrayLiteral(patterns: string[]): string {
	if (patterns.length === 0) return "[]";
	const entries = patterns.map((p) => `\t/${p}/,`).join("\n");
	return `[\n${entries}\n]`;
}

/**
 * Generate a self-contained TypeScript guard plugin for OpenCode's plugin system.
 *
 * The returned string is ready to write as `.opencode/plugins/overstory-guard.ts`.
 * OpenCode auto-loads all files from `.opencode/plugins/` at startup.
 *
 * Plugin uses the correct OpenCode factory style:
 *   export const OverstoryGuard = async (ctx) => ({ "tool.execute.before": handler })
 *
 * Guard order (per AgentRuntime spec):
 * 1. Block write tools for non-implementation capabilities.
 *    OpenCode tool names are lowercase: "edit", "write" (also include mixed-case from
 *    WRITE_TOOLS for forward compatibility).
 * 2. Path boundary on write/edit tools (all agents, defense-in-depth).
 *    OpenCode uses output.args.filePath for edit/write tools.
 * 3. Universal Bash danger guards: git push, reset --hard, wrong branch naming.
 *    OpenCode's bash tool is named "bash" (lowercase).
 * 4a. Non-implementation agents: safe prefix whitelist then dangerous pattern blocklist.
 * 4b. Implementation agents (builder/merger): file-modifying bash path boundary.
 * 5. Default allow.
 *
 * Activity tracking:
 * - tool.execute.after handler: fire-and-forget "ov log tool-end" to update lastActivity.
 *   OpenCode does not have separate agent_end / session_shutdown hooks in the plugin
 *   system, so we rely on the watchdog's existing tmux-based lifecycle detection.
 *
 * @param hooks - Agent identity, capability, worktree path, and optional quality gates.
 * @returns Self-contained TypeScript source code for the OpenCode guard plugin file.
 */
export function generateOpenCodeGuardPlugin(hooks: HooksDef): string {
	const { agentName, capability, worktreePath, qualityGates } = hooks;
	const gates = qualityGates ?? DEFAULT_QUALITY_GATES;
	const gatePrefixes = extractQualityGatePrefixes(gates);

	const isNonImpl = NON_IMPLEMENTATION_CAPABILITIES.has(capability);
	const isCoordination = COORDINATION_CAPABILITIES.has(capability);

	// Build safe Bash prefixes: base set + coordination extras + quality gate commands.
	const safePrefixes: string[] = [
		...SAFE_BASH_PREFIXES,
		...(isCoordination ? ["git add", "git commit"] : []),
		...gatePrefixes,
	];

	// OpenCode uses lowercase tool names; also include the original mixed-case names
	// from WRITE_TOOLS as a safety net for any future OpenCode version that adopts them.
	const ocWriteToolsBlocked = ["write", "edit", ...WRITE_TOOLS];

	const writeBlockedCode = isNonImpl ? toSetLiteral(ocWriteToolsBlocked) : null;
	const safePrefixesCode = toStringArrayLiteral(safePrefixes);
	const dangerousPatternsCode = toRegExpArrayLiteral(DANGEROUS_BASH_PATTERNS);
	const fileModifyingPatternsCode = toRegExpArrayLiteral(FILE_MODIFYING_BASH_PATTERNS);

	// Capability-specific Bash guard block (mutually exclusive).
	// Indented for insertion inside the "bash" tool_execute_before branch.
	const capabilityBashBlock = isNonImpl
		? [
				"",
				`\t\t\t// Non-implementation agents: whitelist safe prefixes, block dangerous patterns.`,
				`\t\t\tconst trimmed = cmd.trimStart();`,
				`\t\t\tif (SAFE_PREFIXES.some((p) => trimmed.startsWith(p))) {`,
				`\t\t\t\treturn; // Safe command — allow through.`,
				`\t\t\t}`,
				`\t\t\tif (DANGEROUS_PATTERNS.some((re) => re.test(cmd))) {`,
				`\t\t\t\tthrow new Error("${capability} agents cannot modify files — this command is not allowed");`,
				`\t\t\t}`,
			].join("\n")
		: [
				"",
				`\t\t\t// Implementation agents: path boundary on file-modifying Bash commands.`,
				`\t\t\tif (FILE_MODIFYING_PATTERNS.some((re) => re.test(cmd))) {`,
				`\t\t\t\tconst tokens = cmd.split(/\\s+/);`,
				`\t\t\t\tconst paths = tokens`,
				`\t\t\t\t\t.filter((t) => t.startsWith("/"))`,
				`\t\t\t\t\t.map((t) => t.replace(/[";>]*$/, ""));`,
				`\t\t\t\tfor (const p of paths) {`,
				`\t\t\t\t\tif (!p.startsWith("/dev/") && !p.startsWith("/tmp/") && !p.startsWith(WORKTREE_PATH + "/") && p !== WORKTREE_PATH) {`,
				`\t\t\t\t\t\tthrow new Error("Bash path boundary violation: command targets a path outside your worktree. All file modifications must stay within your assigned worktree.");`,
				`\t\t\t\t\t}`,
				`\t\t\t\t}`,
				`\t\t\t}`,
			].join("\n");

	const lines = [
		`// .opencode/plugins/overstory-guard.ts`,
		`// Generated by overstory — do not edit manually.`,
		`// Agent: ${agentName} | Capability: ${capability}`,
		`//`,
		`// Uses OpenCode's plugin system: export const Name = async (ctx) => ({ hooks })`,
		`// tool.execute.before: throw Error(reason) to block tool execution.`,
		``,
		`const AGENT_NAME = "${agentName}";`,
		`const WORKTREE_PATH = "${worktreePath}";`,
		``,
		...(isNonImpl && writeBlockedCode !== null
			? [
					`// Write tools blocked for non-implementation capabilities.`,
					`// Includes OpenCode lowercase names ("write", "edit") and Claude Code names for compat.`,
					`const WRITE_BLOCKED = ${writeBlockedCode};`,
					``,
				]
			: []),
		`// Write-scope tools where path boundary is enforced (all agents, defense-in-depth).`,
		`// OpenCode uses lowercase tool names; also include Claude Code names for forward compat.`,
		`const WRITE_SCOPE_TOOLS = new Set(["write", "edit", "Write", "Edit", "NotebookEdit"]);`,
		``,
		`// Safe Bash command prefixes — checked before the dangerous pattern blocklist.`,
		`const SAFE_PREFIXES = ${safePrefixesCode};`,
		``,
		`// Dangerous Bash patterns blocked for non-implementation agents.`,
		`const DANGEROUS_PATTERNS = ${dangerousPatternsCode};`,
		``,
		`// File-modifying Bash patterns requiring path boundary validation (implementation agents).`,
		`const FILE_MODIFYING_PATTERNS = ${fileModifyingPatternsCode};`,
		``,
		`export const OverstoryGuard = async ({ $: shell }) => {`,
		`\treturn {`,
		`\t\t/**`,
		`\t\t * Tool call guard.`,
		`\t\t *`,
		`\t\t * Fires before each tool executes. Throw Error(reason) to block.`,
		`\t\t * OpenCode tool names are lowercase: "bash", "edit", "write", "read", etc.`,
		`\t\t */`,
		`\t\t"tool.execute.before": async (input, output) => {`,
		...(isNonImpl
			? [
					`\t\t\t// 1. Block write tools for non-implementation capabilities.`,
					`\t\t\tif (WRITE_BLOCKED.has(input.tool)) {`,
					`\t\t\t\tthrow new Error(\`${capability} agents cannot modify files — \${input.tool} is not allowed\`);`,
					`\t\t\t}`,
					``,
				]
			: []),
		`\t\t\t// ${isNonImpl ? "2" : "1"}. Path boundary enforcement for write/edit tools (all agents).`,
		`\t\t\t// OpenCode uses output.args.filePath for edit/write tools.`,
		`\t\t\tif (WRITE_SCOPE_TOOLS.has(input.tool)) {`,
		`\t\t\t\tconst filePath = String(output.args?.filePath ?? output.args?.file_path ?? output.args?.notebook_path ?? "");`,
		`\t\t\t\tif (filePath && !filePath.startsWith(WORKTREE_PATH + "/") && filePath !== WORKTREE_PATH) {`,
		`\t\t\t\t\tthrow new Error("Path boundary violation: file is outside your assigned worktree. All writes must target files within your worktree.");`,
		`\t\t\t\t}`,
		`\t\t\t}`,
		``,
		`\t\t\t// ${isNonImpl ? "3" : "2"}. Bash command guards.`,
		`\t\t\tif (input.tool === "bash") {`,
		`\t\t\t\tconst cmd = String(output.args?.command ?? "");`,
		``,
		`\t\t\t\t// Universal danger guards (all agents).`,
		`\t\t\t\tif (/\\bgit\\s+push\\b/.test(cmd)) {`,
		`\t\t\t\t\tthrow new Error("git push is blocked — use ov merge to integrate changes, push manually when ready");`,
		`\t\t\t\t}`,
		`\t\t\t\tif (/git\\s+reset\\s+--hard/.test(cmd)) {`,
		`\t\t\t\t\tthrow new Error("git reset --hard is not allowed — it destroys uncommitted work");`,
		`\t\t\t\t}`,
		`\t\t\t\tconst branchMatch = /git\\s+checkout\\s+-b\\s+(\\S+)/.exec(cmd);`,
		`\t\t\t\tif (branchMatch) {`,
		`\t\t\t\t\tconst branch = branchMatch[1] ?? "";`,
		`\t\t\t\t\tif (!branch.startsWith(\`overstory/\${AGENT_NAME}/\`)) {`,
		`\t\t\t\t\t\tthrow new Error(\`Branch must follow overstory/\${AGENT_NAME}/{task-id} convention\`);`,
		`\t\t\t\t\t}`,
		`\t\t\t\t}`,
		capabilityBashBlock,
		`\t\t\t}`,
		``,
		`\t\t\t// Default: allow.`,
		`\t\t},`,
		``,
		`\t\t/**`,
		`\t\t * Tool execution end: fire-and-forget "ov log tool-end" for event tracking.`,
		`\t\t * Keeps lastActivity fresh so the watchdog does not zombie-classify this agent.`,
		`\t\t */`,
		`\t\t"tool.execute.after": async (input) => {`,
		`\t\t\ttry {`,
		`\t\t\t\tawait shell\`ov log tool-end --agent \${AGENT_NAME} --tool-name \${input.tool}\`;`,
		`\t\t\t} catch {`,
		`\t\t\t\t// Fire-and-forget — do not block on logging failures.`,
		`\t\t\t}`,
		`\t\t},`,
		`\t};`,
		`};`,
		``,
	];

	return lines.join("\n");
}

/**
 * Generate an OpenCode permission config for defense-in-depth guard enforcement.
 *
 * The permission config provides a second layer of protection beyond the guard plugin.
 * OpenCode's permission system uses "allow" / "ask" / "deny" per tool, with optional
 * granular rules for bash commands via object syntax.
 *
 * Non-implementation capabilities get write tools denied and bash restricted.
 * Implementation capabilities get permissive defaults (the plugin handles fine-grained guards).
 * All capabilities get git push denied via bash permission rules.
 *
 * @param capability - Agent capability (builder, scout, reviewer, lead, etc.)
 * @returns OpenCode config object ready to merge into opencode.json
 */
export function generateOpenCodePermissionConfig(capability: string): Record<string, unknown> {
	const isNonImpl = NON_IMPLEMENTATION_CAPABILITIES.has(capability);

	const permission: Record<string, unknown> = {};

	if (isNonImpl) {
		// Non-implementation: deny file modification tools at the permission level.
		permission.edit = "deny";
		permission.write = "deny";
		// Bash: allow safe commands, deny dangerous ones.
		permission.bash = {
			"*": "ask",
			"ov *": "allow",
			"overstory *": "allow",
			"sd *": "allow",
			"bd *": "allow",
			"git status *": "allow",
			"git log *": "allow",
			"git diff *": "allow",
			"git show *": "allow",
			"git blame *": "allow",
			"git branch *": "allow",
			"mulch *": "allow",
			"git push *": "deny",
			"git reset --hard *": "deny",
		};
	} else {
		// Implementation: allow most things, block git push.
		permission["*"] = "allow";
		permission.bash = {
			"*": "allow",
			"git push *": "deny",
			"git reset --hard *": "deny",
		};
	}

	return {
		$schema: "https://opencode.ai/config.json",
		permission,
		// Disable snapshot (undo/redo) for agents — saves disk and avoids indexing overhead.
		snapshot: false,
	};
}

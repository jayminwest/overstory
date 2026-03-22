// Pi runtime guard extension generator.
// Generates self-contained TypeScript code for .pi/extensions/overstory-guard.ts.
//
// Pi's extension system uses the ExtensionAPI factory style:
//   export default function(pi: ExtensionAPI) { pi.on("event", handler) }
//
// Guards fire via pi.on("tool_call", ...) and return { block: true, reason }
// to prevent tool execution — equivalent to Claude Code's PreToolUse hooks.
//
// Activity tracking fires via pi.exec("ov log ...") on tool_call,
// tool_execution_end, agent_end, and session_shutdown events so the SessionStore
// lastActivity stays fresh and the watchdog does not zombie-classify agents.

import {
	DANGEROUS_BASH_PATTERNS,
	INTERACTIVE_TOOLS,
	NATIVE_TEAM_TOOLS,
	SAFE_BASH_PREFIXES,
	WRITE_TOOLS,
} from "../agents/guard-rules.ts";
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

/** Serialize a string array as a TypeScript Set<string> literal (tab-indented entries). */
function toSetLiteral(items: string[]): string {
	if (items.length === 0) return "new Set<string>([])";
	const entries = items.map((s) => `\t"${s}",`).join("\n");
	return `new Set<string>([\n${entries}\n])`;
}

/** Serialize a string array as a TypeScript string[] literal (tab-indented entries). */
function toStringArrayLiteral(items: string[]): string {
	if (items.length === 0) return "[]";
	const entries = items.map((s) => `\t"${s}",`).join("\n");
	return `[\n${entries}\n]`;
}

/**
 * Serialize grep -qE pattern strings as a TypeScript RegExp[] literal.
 * Pattern strings use \\b/\\s double-escaping: their string values (\b/\s) map
 * directly to JavaScript regex word boundary/whitespace tokens.
 */
function toRegExpArrayLiteral(patterns: string[]): string {
	if (patterns.length === 0) return "[]";
	const entries = patterns.map((p) => `\t/${p}/,`).join("\n");
	return `[\n${entries}\n]`;
}

/**
 * Generate a self-contained TypeScript guard extension for Pi's extension system.
 *
 * The returned string is ready to write as `.pi/extensions/overstory-guard.ts`.
 * Pi loads this file and calls the default export with an ExtensionAPI instance.
 *
 * Extension uses the correct Pi factory style:
 *   export default function(pi: ExtensionAPI) { pi.on("event", handler); }
 *
 * Guard order (per AgentRuntime spec):
 * 1. Block NATIVE_TEAM_TOOLS (all agents) — use ov sling for delegation.
 *    (Safety net: Pi does not use Claude Code's native team tools, so these
 *    are no-ops unless a future Pi version adds similar tool names.)
 * 2. Block INTERACTIVE_TOOLS (all agents) — escalate via ov mail instead.
 *    (Safety net: Pi does not have AskUserQuestion/EnterPlanMode natively.)
 * 3. Block write tools for non-implementation capabilities.
 *    (Pi uses lowercase tool names: "write", "edit" — checked in addition to
 *    the original mixed-case Claude Code names for forward compatibility.)
 * 4. Path boundary on write/edit tools (all agents, defense-in-depth).
 *    (Pi uses event.input.path, not file_path.)
 * 5. Universal Bash danger guards: git push, reset --hard, wrong branch naming.
 *    (Pi bash tool is named "bash" in lowercase.)
 * 6a. Non-implementation agents: safe prefix whitelist then dangerous pattern blocklist.
 * 6b. Implementation agents (builder/merger): file-modifying bash path boundary.
 * 7. Default allow.
 *
 * Activity tracking:
 * - tool_call handler: fire-and-forget "ov log tool-start" to update lastActivity.
 * - tool_execution_end handler: fire-and-forget "ov log tool-end".
 * - agent_end handler: awaited "ov log session-end" — fires when the agentic loop
 *   completes (task done). Without this, completed Pi agents get watchdog-escalated
 *   through stalled → nudge → triage → terminate.
 * - session_shutdown handler: awaited "ov log session-end" — fires on Ctrl+C/SIGTERM.
 *   Kept as a safety net in case agent_end does not fire (e.g., crash, force-kill).
 *
 * These tracking calls prevent the watchdog from zombie-classifying Pi agents due
 * to stale lastActivity timestamps (the root cause of the zombie state bug).
 *
 * @param hooks - Agent identity, capability, worktree path, and optional quality gates.
 * @returns Self-contained TypeScript source code for the Pi guard extension file.
 */
export function generatePiGuardExtension(hooks: HooksDef): string {
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

	// Pi uses lowercase tool names; also include the original mixed-case names
	// from WRITE_TOOLS as a safety net for any future Pi version that adopts them.
	const piWriteToolsBlocked = ["write", "edit", ...WRITE_TOOLS];

	const teamBlockedCode = toSetLiteral([...NATIVE_TEAM_TOOLS]);
	const interactiveBlockedCode = toSetLiteral([...INTERACTIVE_TOOLS]);
	const writeBlockedCode = isNonImpl ? toSetLiteral(piWriteToolsBlocked) : null;
	const safePrefixesCode = toStringArrayLiteral(safePrefixes);
	const dangerousPatternsCode = toRegExpArrayLiteral(DANGEROUS_BASH_PATTERNS);
	const fileModifyingPatternsCode = toRegExpArrayLiteral(FILE_MODIFYING_BASH_PATTERNS);

	// Capability-specific Bash guard block (mutually exclusive).
	// Indented for insertion inside the "bash" tool_call branch.
	const capabilityBashBlock = isNonImpl
		? [
				"",
				`\t\t\t// Non-implementation agents: whitelist safe prefixes, block dangerous patterns.`,
				`\t\t\tconst trimmed = cmd.trimStart();`,
				`\t\t\tif (SAFE_PREFIXES.some((p) => trimmed.startsWith(p))) {`,
				`\t\t\t\treturn; // Safe command — allow through.`,
				`\t\t\t}`,
				`\t\t\tif (DANGEROUS_PATTERNS.some((re) => re.test(cmd))) {`,
				`\t\t\t\treturn {`,
				`\t\t\t\t\tblock: true,`,
				`\t\t\t\t\treason: "${capability} agents cannot modify files — this command is not allowed",`,
				`\t\t\t\t};`,
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
				`\t\t\t\t\t\treturn {`,
				`\t\t\t\t\t\t\tblock: true,`,
				`\t\t\t\t\t\t\treason: "Bash path boundary violation: command targets a path outside your worktree. All file modifications must stay within your assigned worktree.",`,
				`\t\t\t\t\t\t};`,
				`\t\t\t\t\t}`,
				`\t\t\t\t}`,
				`\t\t\t}`,
			].join("\n");

	const lines = [
		`// .pi/extensions/overstory-guard.ts`,
		`// Generated by overstory — do not edit manually.`,
		`// Agent: ${agentName} | Capability: ${capability}`,
		`//`,
		`// Uses Pi's ExtensionAPI factory style: export default function(pi: ExtensionAPI) { ... }`,
		`// pi.on("tool_call", ...) returns { block: true, reason } to prevent tool execution.`,
		`// pi.exec("ov", [...]) calls the overstory CLI for activity tracking and lifecycle.`,
		`import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";`,
		``,
		`const AGENT_NAME = "${agentName}";`,
		`const WORKTREE_PATH = "${worktreePath}";`,
		``,
		`// Native team/task tools blocked (all agents) — use ov sling for delegation.`,
		`// Safety net: Pi does not use Claude Code team tool names natively.`,
		`const TEAM_BLOCKED = ${teamBlockedCode};`,
		``,
		`// Interactive tools blocked (all agents) — escalate via ov mail instead.`,
		`// Safety net: Pi does not use these Claude Code tool names natively.`,
		`const INTERACTIVE_BLOCKED = ${interactiveBlockedCode};`,
		``,
		...(isNonImpl && writeBlockedCode !== null
			? [
					`// Write tools blocked for non-implementation capabilities.`,
					`// Includes Pi lowercase names ("write", "edit") and Claude Code names for compat.`,
					`const WRITE_BLOCKED = ${writeBlockedCode};`,
					``,
				]
			: []),
		`// Write-scope tools where path boundary is enforced (all agents, defense-in-depth).`,
		`// Pi uses lowercase tool names; also include Claude Code names for forward compat.`,
		`const WRITE_SCOPE_TOOLS = new Set<string>(["write", "edit", "Write", "Edit", "NotebookEdit"]);`,
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
		`export default function (pi: ExtensionAPI) {`,
		`\t/**`,
		`\t * Tool call guard + activity tracking.`,
		`\t *`,
		`\t * Fires before each tool executes. Returns { block: true, reason } to block.`,
		`\t * Fire-and-forgets "ov log tool-start" to update lastActivity in the SessionStore,`,
		`\t * preventing the Tier 0 watchdog from zombie-classifying this agent due to stale`,
		`\t * lastActivity timestamps (the root cause of the Pi zombie state bug).`,
		`\t *`,
		`\t * NOTE: Pi tool names are lowercase ("bash", "write", "edit").`,
		`\t * event.toolName is used (not event.name — that field does not exist on ToolCallEvent).`,
		`\t * Path boundary uses event.input.path (not file_path — that is Claude Code's field name).`,
		`\t */`,
		`\tpi.on("tool_call", async (event) => {`,
		`\t\t// Activity tracking: update lastActivity so watchdog knows agent is alive.`,
		`\t\t// Fire-and-forget — do not await (avoids latency on every tool call).`,
		`\t\tpi.exec("ov", ["log", "tool-start", "--agent", AGENT_NAME, "--tool-name", event.toolName]).catch(() => {});`,
		``,
		`\t\t// 1. Block native team/task tools (all agents).`,
		`\t\tif (TEAM_BLOCKED.has(event.toolName)) {`,
		`\t\t\treturn {`,
		`\t\t\t\tblock: true,`,
		`\t\t\t\treason: \`Overstory agents must use 'ov sling' for delegation — \${event.toolName} is not allowed\`,`,
		`\t\t\t};`,
		`\t\t}`,
		``,
		`\t\t// 2. Block interactive tools (all agents).`,
		`\t\tif (INTERACTIVE_BLOCKED.has(event.toolName)) {`,
		`\t\t\treturn {`,
		`\t\t\t\tblock: true,`,
		`\t\t\t\treason: \`\${event.toolName} requires human interaction — use ov mail (--type question) to escalate\`,`,
		`\t\t\t};`,
		`\t\t}`,
		``,
		...(isNonImpl
			? [
					`\t\t// 3. Block write tools for non-implementation capabilities.`,
					`\t\tif (WRITE_BLOCKED.has(event.toolName)) {`,
					`\t\t\treturn {`,
					`\t\t\t\tblock: true,`,
					`\t\t\t\treason: \`${capability} agents cannot modify files — \${event.toolName} is not allowed\`,`,
					`\t\t\t};`,
					`\t\t}`,
					``,
				]
			: []),
		`\t\t// ${isNonImpl ? "4" : "3"}. Path boundary enforcement for write/edit tools (all agents).`,
		`\t\t// Pi uses event.input.path (not file_path — that is Claude Code's field name).`,
		`\t\tif (WRITE_SCOPE_TOOLS.has(event.toolName)) {`,
		`\t\t\tconst filePath = String(`,
		`\t\t\t\t(event.input as Record<string, unknown>)?.path ??`,
		`\t\t\t\t(event.input as Record<string, unknown>)?.file_path ??`,
		`\t\t\t\t(event.input as Record<string, unknown>)?.notebook_path ??`,
		`\t\t\t\t"",`,
		`\t\t\t);`,
		`\t\t\tif (filePath && !filePath.startsWith(WORKTREE_PATH + "/") && filePath !== WORKTREE_PATH) {`,
		`\t\t\t\treturn {`,
		`\t\t\t\t\tblock: true,`,
		`\t\t\t\t\treason: "Path boundary violation: file is outside your assigned worktree. All writes must target files within your worktree.",`,
		`\t\t\t\t};`,
		`\t\t\t}`,
		`\t\t}`,
		``,
		`\t\t// ${isNonImpl ? "5" : "4"}. Bash command guards.`,
		`\t\t// Pi's bash tool is named "bash" (lowercase).`,
		`\t\tif (event.toolName === "bash" || event.toolName === "Bash") {`,
		`\t\t\tconst cmd = String((event.input as Record<string, unknown>)?.command ?? "");`,
		``,
		`\t\t\t// Universal danger guards (all agents).`,
		`\t\t\tif (/\\bgit\\s+push\\b/.test(cmd)) {`,
		`\t\t\t\treturn {`,
		`\t\t\t\t\tblock: true,`,
		`\t\t\t\t\treason: "git push is blocked — use ov merge to integrate changes, push manually when ready",`,
		`\t\t\t\t};`,
		`\t\t\t}`,
		`\t\t\tif (/git\\s+reset\\s+--hard/.test(cmd)) {`,
		`\t\t\t\treturn {`,
		`\t\t\t\t\tblock: true,`,
		`\t\t\t\t\treason: "git reset --hard is not allowed — it destroys uncommitted work",`,
		`\t\t\t\t};`,
		`\t\t\t}`,
		`\t\t\tconst branchMatch = /git\\s+checkout\\s+-b\\s+(\\S+)/.exec(cmd);`,
		`\t\t\tif (branchMatch) {`,
		`\t\t\t\tconst branch = branchMatch[1] ?? "";`,
		`\t\t\t\tif (!branch.startsWith(\`overstory/\${AGENT_NAME}/\`)) {`,
		`\t\t\t\t\treturn {`,
		`\t\t\t\t\t\tblock: true,`,
		`\t\t\t\t\t\treason: \`Branch must follow overstory/\${AGENT_NAME}/{task-id} convention\`,`,
		`\t\t\t\t\t};`,
		`\t\t\t\t}`,
		`\t\t\t}`,
		capabilityBashBlock,
		`\t\t}`,
		``,
		`\t\t// Default: allow.`,
		`\t});`,
		``,
		`\t/**`,
		`\t * Tool execution end: fire-and-forget "ov log tool-end" for event tracking.`,
		`\t * Paired with tool_call's tool-start fire for proper begin/end event logging.`,
		`\t */`,
		`\tpi.on("tool_execution_end", async (event) => {`,
		`\t\tpi.exec("ov", ["log", "tool-end", "--agent", AGENT_NAME, "--tool-name", event.toolName]).catch(() => {});`,
		`\t});`,
		``,
		`\t/**`,
		`\t * Agent end: log session-end when the agentic loop completes (task done).`,
		`\t *`,
		`\t * Awaited so it completes before Pi moves on. Without this handler, completed`,
		`\t * Pi agents never transition to "completed" state in the SessionStore, causing`,
		`\t * the watchdog to escalate them through stalled → nudge → triage → terminate.`,
		`\t *`,
		`\t * Fires when the agent finishes its work — before session_shutdown.`,
		`\t */`,
		`\tpi.on("agent_end", async (_event) => {`,
		`\t\tawait pi.exec("ov", ["log", "session-end", "--agent", AGENT_NAME]).catch(() => {});`,
		`\t});`,
		``,
		`\t/**`,
		`\t * Session shutdown: safety-net session-end log for non-graceful exits.`,
		`\t *`,
		`\t * Awaited so it completes before Pi exits. Kept as a fallback in case`,
		`\t * agent_end does not fire (e.g., crash, force-kill, Ctrl+C before task completes).`,
		`\t *`,
		`\t * Fires on Ctrl+C, Ctrl+D, or SIGTERM.`,
		`\t */`,
		`\tpi.on("session_shutdown", async (_event) => {`,
		`\t\tawait pi.exec("ov", ["log", "session-end", "--agent", AGENT_NAME]).catch(() => {});`,
		`\t});`,
		`}`,
		``,
	];

	return lines.join("\n");
}

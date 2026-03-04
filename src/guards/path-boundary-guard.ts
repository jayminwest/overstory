/**
 * Path boundary guard — ensures file-targeting tools stay within the agent's worktree.
 *
 * Replaces `buildPathBoundaryGuardScript(filePathField)` from hooks-deployer.ts.
 *
 * Reads JSON from stdin (Claude Code PreToolUse hook format) and checks that the
 * file path in the specified tool_input field resolves within OVERSTORY_WORKTREE_PATH.
 *
 * Usage: bun run src/guards/path-boundary-guard.ts [--field <name>]
 *   --field <name>  JSON field in tool_input containing the path (default: "file_path")
 *
 * Cross-platform TypeScript replacement for the POSIX shell script.
 * Runs under Bun.
 */

import { resolve } from "node:path";

// Parse --field argument
let fieldName = "file_path";
const fieldIdx = process.argv.indexOf("--field");
if (fieldIdx !== -1 && process.argv[fieldIdx + 1]) {
	fieldName = process.argv[fieldIdx + 1];
}

// Guard chain: skip if not an overstory agent session
const agentName = process.env.OVERSTORY_AGENT_NAME;
if (!agentName) {
	process.exit(0);
}

// Skip if worktree path is not set (e.g., orchestrator session)
const worktreePath = process.env.OVERSTORY_WORKTREE_PATH;
if (!worktreePath) {
	process.exit(0);
}

// Read JSON from stdin
const input = await Bun.stdin.text();

let toolInput: Record<string, unknown> = {};
try {
	const parsed = JSON.parse(input) as { tool_input?: Record<string, unknown> };
	toolInput = parsed.tool_input ?? {};
} catch {
	// Malformed JSON — fail open
	process.exit(0);
}

// Extract the file path from the specified field
const filePath = toolInput[fieldName];
if (typeof filePath !== "string" || filePath.length === 0) {
	// No path found — fail open
	process.exit(0);
}

// Resolve relative paths against cwd
const resolvedPath = resolve(filePath);
const normalizedWorktree = resolve(worktreePath);

// Check if the resolved path is within the worktree (exact match or subpath)
if (
	resolvedPath === normalizedWorktree ||
	resolvedPath.startsWith(`${normalizedWorktree}/`) ||
	resolvedPath.startsWith(`${normalizedWorktree}\\`)
) {
	process.exit(0);
}

// Path is outside the worktree — block
console.log(
	JSON.stringify({
		decision: "block",
		reason:
			"Path boundary violation: file is outside your assigned worktree. " +
			"All writes must target files within your worktree.",
	}),
);
process.exit(0);

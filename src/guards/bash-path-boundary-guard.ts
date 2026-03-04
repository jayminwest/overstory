/**
 * Bash path boundary guard — ensures file-modifying Bash commands stay within the worktree.
 *
 * Replaces `buildBashPathBoundaryScript()` from hooks-deployer.ts.
 *
 * For builder/merger agents, checks that file-modifying Bash commands (sed -i,
 * echo >, cp, mv, tee, install, rsync, etc.) only target paths within the
 * agent's assigned worktree.
 *
 * Limitations (documented by design):
 * - Cannot detect paths constructed via variable expansion ($VAR/file)
 * - Cannot detect paths reached via cd + relative path
 * - Cannot detect paths inside subshells or backtick evaluation
 * - Relative paths are assumed safe (tmux cwd IS the worktree)
 *
 * Usage: bun run src/guards/bash-path-boundary-guard.ts
 *
 * Cross-platform TypeScript replacement for the POSIX shell script.
 * Runs under Bun.
 */

import { resolve } from "node:path";

/**
 * Bash patterns that modify files and require path boundary validation.
 * Each entry is a regex fragment matched against the extracted command.
 * Mirrors FILE_MODIFYING_BASH_PATTERNS from hooks-deployer.ts.
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

// Guard chain: skip if not an overstory agent session
if (!process.env.OVERSTORY_AGENT_NAME) {
	process.exit(0);
}

// Skip if worktree path is not set (e.g., orchestrator session)
const worktreePath = process.env.OVERSTORY_WORKTREE_PATH;
if (!worktreePath) {
	process.exit(0);
}

// Read JSON from stdin
const input = await Bun.stdin.text();

let command = "";
try {
	const parsed = JSON.parse(input) as { tool_input?: { command?: string } };
	command = parsed.tool_input?.command ?? "";
} catch {
	// Malformed JSON — fail open
	process.exit(0);
}

if (!command) {
	process.exit(0);
}

// Only check file-modifying commands — non-modifying commands pass through
const fileModifyPattern = new RegExp(FILE_MODIFYING_BASH_PATTERNS.join("|"));
if (!fileModifyPattern.test(command)) {
	process.exit(0);
}

// Extract all absolute paths from the command.
// On Unix: tokens starting with /
// On Windows: tokens starting with drive letter (e.g., C:\, D:/)
const tokens = command.split(/[\s\t]+/);
const absolutePaths: string[] = [];

for (const token of tokens) {
	// Strip trailing quotes, semicolons, redirects
	const cleaned = token.replace(/[";>]*$/, "");
	if (!cleaned) continue;

	// Unix absolute path
	if (cleaned.startsWith("/")) {
		absolutePaths.push(cleaned);
		continue;
	}

	// Windows absolute path (e.g., C:\, D:/, E:\)
	if (/^[A-Za-z]:[/\\]/.test(cleaned)) {
		absolutePaths.push(cleaned);
	}
}

// If no absolute paths found, allow (relative paths resolve from worktree cwd)
if (absolutePaths.length === 0) {
	process.exit(0);
}

const normalizedWorktree = resolve(worktreePath);

// Allowed path prefixes beyond the worktree
const isUnix = process.platform !== "win32";
const allowedPrefixes: string[] = [normalizedWorktree];

if (isUnix) {
	allowedPrefixes.push("/dev/", "/tmp/");
} else {
	// Windows: allow TEMP directory
	const tempDir = process.env.TEMP || process.env.TMP;
	if (tempDir) {
		allowedPrefixes.push(resolve(tempDir));
	}
}

function isAllowedPath(filePath: string): boolean {
	const resolved = resolve(filePath);
	for (const prefix of allowedPrefixes) {
		if (
			resolved === prefix ||
			resolved.startsWith(`${prefix}/`) ||
			resolved.startsWith(`${prefix}\\`)
		) {
			return true;
		}
	}
	return false;
}

// Check each absolute path
for (const absPath of absolutePaths) {
	if (!isAllowedPath(absPath)) {
		console.log(
			JSON.stringify({
				decision: "block",
				reason:
					"Bash path boundary violation: command targets a path outside your worktree. " +
					"All file modifications must stay within your assigned worktree.",
			}),
		);
		process.exit(0);
	}
}

// All paths are within allowed boundaries
process.exit(0);

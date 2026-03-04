/**
 * Bash command guard — blocks dangerous git operations for overstory agents.
 *
 * Replaces `buildBashGuardScript(agentName)` from hooks-deployer.ts.
 *
 * Reads JSON from stdin (Bash tool hook format) and blocks:
 * - `git push` (any form) — use ov merge instead
 * - `git reset --hard` — destroys uncommitted work
 * - `git checkout -b` with non-conforming branch names
 *
 * Usage: bun run src/guards/bash-guard.ts [--agent <name>]
 *   --agent <name>  Agent name for branch naming validation
 *
 * Cross-platform TypeScript replacement for the POSIX shell script.
 * Runs under Bun.
 */

// Module marker so TSC treats top-level await as valid
export {};

function block(reason: string): void {
	console.log(JSON.stringify({ decision: "block", reason }));
	process.exit(0);
}

// Parse --agent argument
let resolvedAgent = process.env.OVERSTORY_AGENT_NAME ?? "";
const agentIdx = process.argv.indexOf("--agent");
if (agentIdx !== -1 && process.argv[agentIdx + 1]) {
	resolvedAgent = process.argv[agentIdx + 1];
}

// Guard chain: skip if not an overstory agent session
if (!process.env.OVERSTORY_AGENT_NAME) {
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

// Block git push (any form)
if (/\bgit\s+push\b/.test(command)) {
	block("git push is blocked — use ov merge to integrate changes, push manually when ready");
}

// Block git reset --hard
if (/\bgit\s+reset\s+--hard\b/.test(command)) {
	block("git reset --hard is not allowed — it destroys uncommitted work");
}

// Block git checkout -b with non-conforming branch names
const checkoutMatch = command.match(/\bgit\s+checkout\s+-b\s+(\S+)/);
if (checkoutMatch) {
	const branchName = checkoutMatch[1];
	const expectedPrefix = `overstory/${resolvedAgent}/`;
	if (branchName && !branchName.startsWith(expectedPrefix)) {
		block(`Branch must follow overstory/${resolvedAgent}/{task-id} convention`);
	}
}

// Command is allowed
process.exit(0);

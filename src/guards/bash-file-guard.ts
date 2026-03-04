/**
 * Bash file modification guard — blocks file-modifying commands for non-implementation agents.
 *
 * Replaces `buildBashFileGuardScript(capability, extraSafePrefixes)` from hooks-deployer.ts.
 *
 * For non-implementation agents (scout, reviewer, lead, etc.), checks if a Bash
 * command matches dangerous file-modifying patterns while allowing safe prefixes.
 *
 * Usage: bun run src/guards/bash-file-guard.ts [--capability <name>] [--safe-prefixes <comma-sep>]
 *   --capability <name>          Agent capability name (for error messages)
 *   --safe-prefixes <list>       Additional safe command prefixes (comma-separated)
 *
 * Cross-platform TypeScript replacement for the POSIX shell script.
 * Runs under Bun.
 */

import { DANGEROUS_BASH_PATTERNS, SAFE_BASH_PREFIXES } from "../agents/guard-rules.ts";

// Parse arguments
let capability = "agent";
let extraSafePrefixes: string[] = [];

const capIdx = process.argv.indexOf("--capability");
if (capIdx !== -1 && process.argv[capIdx + 1]) {
	capability = process.argv[capIdx + 1];
}

const safePrefixIdx = process.argv.indexOf("--safe-prefixes");
if (safePrefixIdx !== -1 && process.argv[safePrefixIdx + 1]) {
	extraSafePrefixes = process.argv[safePrefixIdx + 1].split(",").filter(Boolean);
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

// Check safe prefixes first (whitelist before blocklist)
const allSafePrefixes = [...SAFE_BASH_PREFIXES, ...extraSafePrefixes];
const trimmedCommand = command.trimStart();

for (const prefix of allSafePrefixes) {
	if (trimmedCommand.startsWith(prefix)) {
		process.exit(0);
	}
}

// Check against dangerous patterns
const dangerPattern = new RegExp(DANGEROUS_BASH_PATTERNS.join("|"));
if (dangerPattern.test(command)) {
	console.log(
		JSON.stringify({
			decision: "block",
			reason: `${capability} agents cannot modify files — this command is not allowed`,
		}),
	);
	process.exit(0);
}

// Command is allowed
process.exit(0);

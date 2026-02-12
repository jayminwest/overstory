#!/usr/bin/env bun
/**
 * Overstory CLI — main entry point and command router.
 *
 * Routes subcommands to their respective handlers in src/commands/.
 * Usage: overstory <command> [args...]
 */

import { coordinatorCommand } from "./commands/coordinator.ts";
import { groupCommand } from "./commands/group.ts";
import { initCommand } from "./commands/init.ts";
import { logCommand } from "./commands/log.ts";
import { mailCommand } from "./commands/mail.ts";
import { mergeCommand } from "./commands/merge.ts";
import { metricsCommand } from "./commands/metrics.ts";
import { nudgeCommand } from "./commands/nudge.ts";
import { primeCommand } from "./commands/prime.ts";
import { slingCommand } from "./commands/sling.ts";
import { statusCommand } from "./commands/status.ts";
import { supervisorCommand } from "./commands/supervisor.ts";
import { watchCommand } from "./commands/watch.ts";
import { worktreeCommand } from "./commands/worktree.ts";
import { OverstoryError, WorktreeError } from "./errors.ts";

const VERSION = "0.1.0";

const HELP = `overstory v${VERSION} — Multi-agent orchestration for Claude Code

Usage: overstory <command> [args...]

Commands:
  init                    Initialize .overstory/ in current project
  sling <task-id>         Spawn a worker agent
  prime                   Load context for orchestrator/agent
  status                  Show all active agents and project state
  coordinator <sub>       Persistent coordinator agent (start/stop/status)
  supervisor <sub>        Per-project supervisor agent (start/stop/status)
  mail <sub>              Mail system (send/check/list/read/reply)
  merge                   Merge agent branches into canonical
  nudge <agent> [msg]     Send a text nudge to an agent
  group <sub>             Task groups (create/status/add/remove/list)
  worktree <sub>          Manage worktrees (list/clean)
  log <event>             Log a hook event
  watch                   Start watchdog daemon
  metrics                 Show session metrics

Options:
  --help, -h              Show this help
  --version, -v           Show version

Run 'overstory <command> --help' for command-specific help.`;

const COMMANDS = [
	"init",
	"sling",
	"prime",
	"status",
	"coordinator",
	"supervisor",
	"mail",
	"merge",
	"nudge",
	"group",
	"worktree",
	"log",
	"watch",
	"metrics",
];

function editDistance(a: string, b: string): number {
	const m = a.length;
	const n = b.length;
	// Use a flat 1D array to avoid nested indexing warnings
	const dp = new Array<number>((m + 1) * (n + 1)).fill(0);
	const idx = (i: number, j: number) => i * (n + 1) + j;
	for (let i = 0; i <= m; i++) dp[idx(i, 0)] = i;
	for (let j = 0; j <= n; j++) dp[idx(0, j)] = j;
	for (let i = 1; i <= m; i++) {
		for (let j = 1; j <= n; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			const del = (dp[idx(i - 1, j)] ?? 0) + 1;
			const ins = (dp[idx(i, j - 1)] ?? 0) + 1;
			const sub = (dp[idx(i - 1, j - 1)] ?? 0) + cost;
			dp[idx(i, j)] = Math.min(del, ins, sub);
		}
	}
	return dp[idx(m, n)] ?? 0;
}

function suggestCommand(input: string): string | undefined {
	let bestMatch: string | undefined;
	let bestDist = 3; // Only suggest if distance <= 2
	for (const cmd of COMMANDS) {
		const dist = editDistance(input, cmd);
		if (dist < bestDist) {
			bestDist = dist;
			bestMatch = cmd;
		}
	}
	return bestMatch;
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const command = args[0];
	const commandArgs = args.slice(1);

	if (!command || command === "--help" || command === "-h") {
		process.stdout.write(`${HELP}\n`);
		return;
	}

	if (command === "--version" || command === "-v") {
		process.stdout.write(`overstory v${VERSION}\n`);
		return;
	}

	switch (command) {
		case "init":
			await initCommand(commandArgs);
			break;
		case "sling":
			await slingCommand(commandArgs);
			break;
		case "prime":
			await primeCommand(commandArgs);
			break;
		case "status":
			await statusCommand(commandArgs);
			break;
		case "coordinator":
			await coordinatorCommand(commandArgs);
			break;
		case "supervisor":
			await supervisorCommand(commandArgs);
			break;
		case "mail":
			await mailCommand(commandArgs);
			break;
		case "merge":
			await mergeCommand(commandArgs);
			break;
		case "nudge":
			await nudgeCommand(commandArgs);
			break;
		case "group":
			await groupCommand(commandArgs);
			break;
		case "worktree":
			await worktreeCommand(commandArgs);
			break;
		case "log":
			await logCommand(commandArgs);
			break;
		case "watch":
			await watchCommand(commandArgs);
			break;
		case "metrics":
			await metricsCommand(commandArgs);
			break;
		default: {
			process.stderr.write(`Unknown command: ${command}\n`);
			const suggestion = suggestCommand(command);
			if (suggestion) {
				process.stderr.write(`Did you mean '${suggestion}'?\n`);
			}
			process.stderr.write(`Run 'overstory --help' for usage.\n`);
			process.exit(1);
		}
	}
}

main().catch((err: unknown) => {
	// Friendly message when running outside a git repository
	if (err instanceof WorktreeError && err.message.includes("not a git repository")) {
		process.stderr.write("Not in an overstory project. Run 'overstory init' first.\n");
		process.exit(1);
	}
	if (err instanceof OverstoryError) {
		process.stderr.write(`Error [${err.code}]: ${err.message}\n`);
		process.exit(1);
	}
	if (err instanceof Error) {
		process.stderr.write(`Error: ${err.message}\n`);
		if (process.argv.includes("--verbose")) {
			process.stderr.write(`${err.stack}\n`);
		}
		process.exit(1);
	}
	process.stderr.write(`Unknown error: ${String(err)}\n`);
	process.exit(1);
});

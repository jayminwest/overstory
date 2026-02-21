#!/usr/bin/env bun

/**
 * Overstory CLI — main entry point and command router.
 *
 * Routes subcommands to their respective handlers in src/commands/.
 * Usage: overstory <command> [args...]
 */

import { agentsCommand } from "./commands/agents.ts";
import { cleanCommand } from "./commands/clean.ts";
import { completionsCommand } from "./commands/completions.ts";
import { coordinatorCommand } from "./commands/coordinator.ts";
import { costsCommand } from "./commands/costs.ts";
import { dashboardCommand } from "./commands/dashboard.ts";
import { doctorCommand } from "./commands/doctor.ts";
import { errorsCommand } from "./commands/errors.ts";
import { feedCommand } from "./commands/feed.ts";
import { groupCommand } from "./commands/group.ts";
import { hooksCommand } from "./commands/hooks.ts";
import { initCommand } from "./commands/init.ts";
import { inspectCommand } from "./commands/inspect.ts";
import { logCommand } from "./commands/log.ts";
import { logsCommand } from "./commands/logs.ts";
import { mailCommand } from "./commands/mail.ts";
import { mergeCommand } from "./commands/merge.ts";
import { metricsCommand } from "./commands/metrics.ts";
import { monitorCommand } from "./commands/monitor.ts";
import { nudgeCommand } from "./commands/nudge.ts";
import { primeCommand } from "./commands/prime.ts";
import { replayCommand } from "./commands/replay.ts";
import { runCommand } from "./commands/run.ts";
import { slingCommand } from "./commands/sling.ts";
import { specCommand } from "./commands/spec.ts";
import { statusCommand } from "./commands/status.ts";
import { supervisorCommand } from "./commands/supervisor.ts";
import { traceCommand } from "./commands/trace.ts";
import { watchCommand } from "./commands/watch.ts";
import { webCommand } from "./commands/web.ts";
import { worktreeCommand } from "./commands/worktree.ts";
import { OverstoryError, WorktreeError } from "./errors.ts";
import { setQuiet } from "./logging/color.ts";

const VERSION = "0.5.8";

const HELP = `overstory v${VERSION} — Multi-agent orchestration for Claude Code

Usage: overstory <command> [args...]

Commands:
  agents <sub>            Discover and query agents (discover)
  init                    Initialize .overstory/ in current project
  sling <task-id>         Spawn a worker agent
  spec <sub>              Manage task specs (write)
  prime                   Load context for orchestrator/agent
  status                  Show all active agents and project state
  dashboard               Live TUI dashboard for agent monitoring
  inspect <agent>         Deep inspection of a single agent
  coordinator <sub>       Persistent coordinator agent (start/stop/status)
  supervisor <sub>        Per-project supervisor agent (start/stop/status)
  hooks <sub>             Manage orchestrator hooks (install/uninstall/status)
  mail <sub>              Mail system (send/check/list/read/reply)
  monitor <sub>           Tier 2 monitor agent (start/stop/status)
  merge                   Merge agent branches into canonical
  nudge <agent> [msg]     Send a text nudge to an agent
  group <sub>             Task groups (create/status/add/remove/list)
  clean                   Wipe runtime state (nuclear cleanup)
  doctor                  Run health checks on overstory setup
  worktree <sub>          Manage worktrees (list/clean)
  log <event>             Log a hook event
  logs [options]          Query NDJSON logs across agents
  watch                   Start watchdog daemon
  web                     Start web dashboard server
  feed [options]          Unified real-time event stream across all agents
  trace <target>         Chronological event timeline for agent/bead
  errors [options]        Aggregated error view across agents
  run [sub]               Manage runs (list/show/complete)
  replay [options]        Interleaved chronological replay across agents
  costs [options]          Token/cost analysis and breakdown
  metrics                 Show session metrics

Options:
  --help, -h              Show this help
  --version, -v           Show version
  --quiet, -q             Suppress non-error output
  --completions <shell>   Generate shell completions (bash, zsh, fish)

Run 'overstory <command> --help' for command-specific help.`;

const COMMANDS = [
	"agents",
	"init",
	"sling",
	"spec",
	"prime",
	"status",
	"dashboard",
	"inspect",
	"clean",
	"doctor",
	"coordinator",
	"supervisor",
	"hooks",
	"monitor",
	"mail",
	"merge",
	"nudge",
	"group",
	"worktree",
	"log",
	"logs",
	"watch",
	"web",
	"trace",
	"feed",
	"errors",
	"replay",
	"run",
	"costs",
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

	// Parse global flags before command routing
	const quietIndex = args.indexOf("--quiet");
	const qIndex = args.indexOf("-q");
	if (quietIndex !== -1 || qIndex !== -1) {
		setQuiet(true);
		// Remove the flag from args so commands do not see it
		if (quietIndex !== -1) args.splice(quietIndex, 1);
		if (qIndex !== -1) {
			const idx = args.indexOf("-q");
			if (idx !== -1) args.splice(idx, 1);
		}
	}

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

	if (command === "--completions") {
		completionsCommand(commandArgs);
		return;
	}

	switch (command) {
		case "agents":
			await agentsCommand(commandArgs);
			break;
		case "init":
			await initCommand(commandArgs);
			break;
		case "sling":
			await slingCommand(commandArgs);
			break;
		case "spec":
			await specCommand(commandArgs);
			break;
		case "prime":
			await primeCommand(commandArgs);
			break;
		case "status":
			await statusCommand(commandArgs);
			break;
		case "dashboard":
			await dashboardCommand(commandArgs);
			break;
		case "inspect":
			await inspectCommand(commandArgs);
			break;
		case "clean":
			await cleanCommand(commandArgs);
			break;
		case "doctor": {
			const exitCode = await doctorCommand(commandArgs);
			if (exitCode !== undefined) {
				process.exitCode = exitCode;
			}
			break;
		}
		case "coordinator":
			await coordinatorCommand(commandArgs);
			break;
		case "supervisor":
			await supervisorCommand(commandArgs);
			break;
		case "hooks":
			await hooksCommand(commandArgs);
			break;
		case "monitor":
			await monitorCommand(commandArgs);
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
		case "logs":
			await logsCommand(commandArgs);
			break;
		case "watch":
			await watchCommand(commandArgs);
			break;
		case "web":
			await webCommand(commandArgs);
			break;
		case "trace":
			await traceCommand(commandArgs);
			break;
		case "feed":
			await feedCommand(commandArgs);
			break;
		case "errors":
			await errorsCommand(commandArgs);
			break;
		case "replay":
			await replayCommand(commandArgs);
			break;
		case "run":
			await runCommand(commandArgs);
			break;
		case "costs":
			await costsCommand(commandArgs);
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

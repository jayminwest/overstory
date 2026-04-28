#!/usr/bin/env bun

/**
 * Overstory CLI — main entry point and command router.
 *
 * Routes subcommands to their respective handlers in src/commands/.
 * Usage: ov <command> [args...]
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { Command, Help } from "commander";
import { createAgentsCommand } from "./commands/agents.ts";
import { cleanCommand } from "./commands/clean.ts";
import { createCompletionsCommand } from "./commands/completions.ts";
import { createCoordinatorCommand } from "./commands/coordinator.ts";
import { createCostsCommand } from "./commands/costs.ts";
import { createDashboardCommand } from "./commands/dashboard.ts";
import { createDiscoverCommand } from "./commands/discover.ts";
import { createDoctorCommand } from "./commands/doctor.ts";
import { createEcosystemCommand } from "./commands/ecosystem.ts";
import { createErrorsCommand } from "./commands/errors.ts";
import { createFeedCommand } from "./commands/feed.ts";
import { createGroupCommand } from "./commands/group.ts";
import { createHooksCommand } from "./commands/hooks.ts";
import { initCommand } from "./commands/init.ts";
import { createInspectCommand } from "./commands/inspect.ts";
import { createLogCommand } from "./commands/log.ts";
import { logsCommand } from "./commands/logs.ts";
import { mailCommand } from "./commands/mail.ts";
import { mergeCommand } from "./commands/merge.ts";
import { createMetricsCommand } from "./commands/metrics.ts";
import { createMonitorCommand } from "./commands/monitor.ts";
import { nudgeCommand } from "./commands/nudge.ts";
import { createOrchestratorCommand } from "./commands/orchestrator.ts";
import { primeCommand } from "./commands/prime.ts";
import { createReplayCommand } from "./commands/replay.ts";
import { createRunCommand } from "./commands/run.ts";
import { createServeCommand } from "./commands/serve.ts";
import { slingCommand } from "./commands/sling.ts";
import { specWriteCommand } from "./commands/spec.ts";
import { createStatusCommand } from "./commands/status.ts";
import { stopCommand } from "./commands/stop.ts";
import { createSupervisorCommand } from "./commands/supervisor.ts";
import { traceCommand } from "./commands/trace.ts";
import { createUpdateCommand } from "./commands/update.ts";
import { createUpgradeCommand } from "./commands/upgrade.ts";
import { createWatchCommand } from "./commands/watch.ts";
import { createWorktreeCommand } from "./commands/worktree.ts";
import { setProjectRootOverride } from "./config.ts";
import { ConfigError, OverstoryError, WorktreeError } from "./errors.ts";
import { jsonError } from "./json.ts";
import { brand, chalk, muted, setQuiet } from "./logging/color.ts";

export const VERSION = "0.10.0";

const rawArgs = process.argv.slice(2);

// Handle --version --json before Commander processes the flag
if ((rawArgs.includes("-v") || rawArgs.includes("--version")) && rawArgs.includes("--json")) {
	const platform = `${process.platform}-${process.arch}`;
	console.log(
		JSON.stringify({
			name: "@os-eco/overstory-cli",
			version: VERSION,
			runtime: "bun",
			platform,
		}),
	);
	process.exit();
}

const COMMANDS = [
	"agents",
	"init",
	"sling",
	"spec",
	"prime",
	"stop",
	"status",
	"dashboard",
	"discover",
	"inspect",
	"clean",
	"doctor",
	"orchestrator",
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
	"trace",
	"ecosystem",
	"feed",
	"errors",
	"replay",
	"run",
	"costs",
	"metrics",
	"serve",
	"update",
	"upgrade",
	"completions",
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

const program = new Command();

let timingStart: number | undefined;

program
	.name("ov")
	.description("Multi-agent orchestration for Claude Code")
	.version(VERSION, "-v, --version", "Print version")
	.enablePositionalOptions()
	.option("-q, --quiet", "Suppress non-error output")
	.option("--json", "JSON output")
	.option("--verbose", "Verbose output")
	.option("--timing", "Print command execution time to stderr")
	.option("--project <path>", "Target project root (overrides auto-detection)")
	.addHelpCommand(false)
	.configureHelp({
		formatHelp(cmd, helper): string {
			if (cmd.parent) {
				return Help.prototype.formatHelp.call(helper, cmd, helper);
			}

			const COL_WIDTH = 20;
			const lines: string[] = [];

			lines.push(`${brand.bold("overstory")} ${muted(`v${VERSION}`)} — Multi-agent orchestration`);
			lines.push("");

			lines.push(`Usage: ${chalk.dim("ov")} <command> [options]`);
			lines.push("");

			const visibleCmds = helper.visibleCommands(cmd);
			if (visibleCmds.length > 0) {
				lines.push("Commands:");
				for (const sub of visibleCmds) {
					const term = helper.subcommandTerm(sub);
					const firstSpace = term.indexOf(" ");
					const name = firstSpace >= 0 ? term.slice(0, firstSpace) : term;
					const args = firstSpace >= 0 ? ` ${term.slice(firstSpace + 1)}` : "";
					const coloredTerm = `${chalk.green(name)}${args ? chalk.dim(args) : ""}`;
					const rawLen = term.length;
					const padding = " ".repeat(Math.max(2, COL_WIDTH - rawLen));
					lines.push(`  ${coloredTerm}${padding}${helper.subcommandDescription(sub)}`);
				}
				lines.push("");
			}

			const visibleOpts = helper.visibleOptions(cmd);
			if (visibleOpts.length > 0) {
				lines.push("Options:");
				for (const opt of visibleOpts) {
					const flags = helper.optionTerm(opt);
					const padding = " ".repeat(Math.max(2, COL_WIDTH - flags.length));
					lines.push(`  ${chalk.dim(flags)}${padding}${helper.optionDescription(opt)}`);
				}
				lines.push("");
			}

			lines.push(`Run '${chalk.dim("ov")} <command> --help' for command-specific help.`);

			return `${lines.join("\n")}\n`;
		},
	});

// Apply global flags before any command action runs
program.hook("preAction", (thisCmd) => {
	const opts = thisCmd.optsWithGlobals();
	if (opts.quiet) {
		setQuiet(true);
	}
	const projectFlag = opts.project as string | undefined;
	if (projectFlag !== undefined) {
		const resolvedProject = resolve(process.cwd(), projectFlag);
		if (!existsSync(join(resolvedProject, ".overstory", "config.yaml"))) {
			throw new ConfigError(
				`'${resolvedProject}' is not an overstory project (missing .overstory/config.yaml). Run 'ov init' first.`,
				{ configPath: join(resolvedProject, ".overstory", "config.yaml") },
			);
		}
		setProjectRootOverride(resolvedProject);
	}
	if (opts.timing) {
		timingStart = performance.now();
	}
});
program.hook("postAction", () => {
	if (program.opts().timing && timingStart !== undefined) {
		const elapsed = performance.now() - timingStart;
		const formatted =
			elapsed < 1000 ? `${Math.round(elapsed)}ms` : `${(elapsed / 1000).toFixed(2)}s`;
		process.stderr.write(`${muted(`Done in ${formatted}`)}\n`);
	}
});

// Migrated commands — use addCommand() with createXCommand() factories
program.addCommand(createAgentsCommand());
program.addCommand(createDoctorCommand());
program.addCommand(createOrchestratorCommand());
program.addCommand(createCoordinatorCommand());
program.addCommand(createSupervisorCommand());
program.addCommand(createHooksCommand());
program.addCommand(createMonitorCommand());
program.addCommand(createWorktreeCommand());
program.addCommand(createLogCommand());
program.addCommand(createWatchCommand());
program.addCommand(createGroupCommand());
program.addCommand(createServeCommand());
program.addCommand(createCompletionsCommand());

// Unmigrated commands — passthrough pattern
program
	.command("init")
	.description("Initialize .overstory/ and bootstrap os-eco ecosystem tools")
	.option("--force", "Reinitialize even if .overstory/ already exists")
	.option("-y, --yes", "Accept all defaults without prompting (non-interactive mode)")
	.option("--name <name>", "Project name (skips auto-detection)")
	.option(
		"--tools <list>",
		"Comma-separated list of ecosystem tools to bootstrap (default: mulch,seeds,canopy)",
	)
	.option("--skip-mulch", "Skip mulch bootstrap")
	.option("--skip-seeds", "Skip seeds bootstrap")
	.option("--skip-canopy", "Skip canopy bootstrap")
	.option("--skip-onboard", "Skip CLAUDE.md onboarding step for ecosystem tools")
	.option("--json", "Output result as JSON")
	.action(async (opts) => {
		await initCommand(opts);
	});

program
	.command("sling")
	.description("Spawn a worker agent")
	.argument("<task-id>", "Task ID to assign")
	.option(
		"--capability <type>",
		"Agent type: builder | scout | reviewer | lead | merger",
		"builder",
	)
	.option("--name <name>", "Unique agent name (auto-generated if omitted)")
	.option("--spec <path>", "Path to task spec file")
	.option("--files <list>", "Exclusive file scope (comma-separated)")
	.option("--parent <agent>", "Parent agent for hierarchy tracking")
	.option("--depth <n>", "Current hierarchy depth", "0")
	.option("--skip-scout", "Skip scout phase for lead agents")
	.option("--skip-task-check", "Skip task existence validation")
	.option("--force-hierarchy", "Bypass hierarchy validation")
	.option("--max-agents <n>", "Max children per lead (overrides config)")
	.option("--skip-review", "Skip review phase for lead agents")
	.option("--no-scout-check", "Suppress the parentHasScouts scout-before-build warning")
	.option("--dispatch-max-agents <n>", "Per-lead max agents ceiling (injected into overlay)")
	.option("--runtime <name>", "Runtime adapter (default: config or claude)")
	.option("--base-branch <branch>", "Base branch for worktree creation (default: current HEAD)")
	.option("--profile <name>", "Canopy profile to apply to agent overlay")
	.option(
		"--headless",
		"Spawn through Bun.spawn (stream-json) instead of tmux. Requires runtime with buildDirectSpawn.",
	)
	.option("--json", "Output result as JSON")
	.action(async (taskId, opts) => {
		await slingCommand(taskId, opts);
	});

const specCmd = program.command("spec").description("Manage task specifications");

specCmd
	.command("write")
	.description("Write a spec file to .overstory/specs/<task-id>.md")
	.argument("<task-id>", "Task ID for the spec file")
	.option("--body <content>", "Spec content (or pipe via stdin)")
	.option("--agent <name>", "Agent writing the spec (for attribution)")
	.option("--json", "Output as JSON")
	.action(async (taskId, opts) => {
		await specWriteCommand(taskId, opts);
	});

program
	.command("prime")
	.description("Load context for orchestrator/agent")
	.option("--agent <name>", "Prime for a specific agent")
	.option("--compact", "Output reduced context (for PreCompact hook)")
	.option("--json", "Output as JSON")
	.action(async (opts) => {
		await primeCommand(opts);
	});

program
	.command("stop")
	.description("Terminate a running agent")
	.argument("<agent-name>", "Name of the agent to stop")
	.option("--force", "Force kill and force-delete branch")
	.option("--clean-worktree", "Remove the agent's worktree after stopping")
	.option("--json", "Output as JSON")
	.action(async (agentName, opts) => {
		await stopCommand(agentName, opts);
	});

program.addCommand(createStatusCommand());

program.addCommand(createDashboardCommand());

program.addCommand(createDiscoverCommand());

program.addCommand(createInspectCommand());

program
	.command("clean")
	.description("Wipe runtime state (nuclear cleanup)")
	.option("--all", "Wipe everything (nuclear option)")
	.option("--mail", "Delete mail.db")
	.option("--sessions", "Wipe sessions.db")
	.option("--metrics", "Delete metrics.db")
	.option("--logs", "Remove all agent logs")
	.option("--worktrees", "Remove all worktrees + kill tmux sessions")
	.option("--branches", "Delete all overstory/* branch refs")
	.option("--agents", "Remove agent identity files")
	.option("--specs", "Remove task spec files")
	.option("--json", "Output as JSON")
	.action(async (opts) => {
		await cleanCommand(opts);
	});

program
	.command("mail")
	.description("Mail system (send/check/list/read/reply)")
	.allowUnknownOption()
	.allowExcessArguments()
	.action(async (_opts, cmd) => {
		await mailCommand(cmd.args);
	});

program
	.command("merge")
	.description("Merge agent branches into canonical")
	.option("--branch <name>", "Merge a specific branch")
	.option("--all", "Merge all pending branches in the queue")
	.option("--into <branch>", "Target branch to merge into")
	.option("--dry-run", "Check for conflicts without actually merging")
	.option("--json", "Output results as JSON")
	.action(async (opts) => {
		await mergeCommand(opts);
	});

program
	.command("nudge")
	.description("Send a text nudge to an agent")
	.allowUnknownOption()
	.allowExcessArguments()
	.action(async (_opts, cmd) => {
		await nudgeCommand(cmd.args);
	});

program
	.command("logs")
	.description("Query NDJSON logs across agents")
	.allowUnknownOption()
	.allowExcessArguments()
	.action(async (_opts, cmd) => {
		await logsCommand(cmd.args);
	});

program
	.command("trace")
	.description("Chronological event timeline for agent or task")
	.allowUnknownOption()
	.allowExcessArguments()
	.action(async (_opts, cmd) => {
		await traceCommand(cmd.args);
	});

program.addCommand(createFeedCommand());

program.addCommand(createEcosystemCommand());

program.addCommand(createErrorsCommand());

program.addCommand(createReplayCommand());

program.addCommand(createRunCommand());

program.addCommand(createCostsCommand());

program.addCommand(createMetricsCommand());

program.addCommand(createUpdateCommand());

program.addCommand(createUpgradeCommand());

// Handle unknown commands with Levenshtein fuzzy-match suggestions
program.on("command:*", (operands) => {
	const unknown = operands[0] ?? "";
	process.stderr.write(`Unknown command: ${unknown}\n`);
	const suggestion = suggestCommand(unknown);
	if (suggestion) {
		process.stderr.write(`Did you mean '${suggestion}'?\n`);
	}
	process.stderr.write("Run 'ov --help' for usage.\n");
	process.exitCode = 1;
});

async function main(): Promise<void> {
	await program.parseAsync(process.argv);
}

if (import.meta.main)
	main().catch((err: unknown) => {
		const useJson = process.argv.includes("--json");
		// Friendly message when running outside a git repository
		if (err instanceof WorktreeError && err.message.includes("not a git repository")) {
			if (useJson) {
				jsonError("ov", "Not in an overstory project. Run 'ov init' first.");
			} else {
				process.stderr.write("Not in an overstory project. Run 'ov init' first.\n");
			}
			process.exitCode = 1;
			return;
		}
		if (err instanceof OverstoryError) {
			if (useJson) {
				jsonError("ov", err.message);
			} else {
				process.stderr.write(`Error [${err.code}]: ${err.message}\n`);
			}
			process.exitCode = 1;
			return;
		}
		if (err instanceof Error) {
			if (useJson) {
				jsonError("ov", err.message);
			} else {
				process.stderr.write(`Error: ${err.message}\n`);
				if (process.argv.includes("--verbose")) {
					process.stderr.write(`${err.stack}\n`);
				}
			}
			process.exitCode = 1;
			return;
		}
		if (useJson) {
			jsonError("ov", String(err));
		} else {
			process.stderr.write(`Unknown error: ${String(err)}\n`);
		}
		process.exitCode = 1;
	});

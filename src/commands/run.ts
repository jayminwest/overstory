/**
 * CLI command: overstory run [subcommand] [--json]
 *
 * Manage runs (coordinator session groupings).
 * A "run" groups all agents spawned from one coordinator session.
 *
 * Subcommands:
 *   (default)     Show current run status
 *   list          List recent runs
 *   complete      Mark current run as completed
 *   show <id>     Show run details with agents
 */

import { join } from "node:path";
import { Command, CommanderError } from "commander";
import { loadConfig } from "../config.ts";
import { ValidationError } from "../errors.ts";
import { jsonError, jsonOutput } from "../json.ts";
import { accent, printError, printHint, printSuccess } from "../logging/color.ts";
import { formatDuration } from "../logging/format.ts";
import { renderHeader, separator } from "../logging/theme.ts";
import { createRunStore, createSessionStore } from "../sessions/store.ts";
import type { AgentSession, Run } from "../types.ts";
import { resolveContext } from "../workspace/resolver.ts";

/**
 * Get the path to the current-run.txt file.
 */
function currentRunPath(overstoryDir: string): string {
	return join(overstoryDir, "current-run.txt");
}

/**
 * Read the current run ID from current-run.txt, or null if no active run.
 */
async function readCurrentRunId(overstoryDir: string): Promise<string | null> {
	const path = currentRunPath(overstoryDir);
	const file = Bun.file(path);
	if (!(await file.exists())) {
		return null;
	}
	const text = await file.text();
	const trimmed = text.trim();
	return trimmed.length > 0 ? trimmed : null;
}

/**
 * Compute duration string for a run.
 */
function runDuration(run: Run): string {
	const start = new Date(run.startedAt).getTime();
	const end = run.completedAt ? new Date(run.completedAt).getTime() : Date.now();
	return formatDuration(end - start);
}

/**
 * Format an agent's duration from startedAt to now (or completion).
 */
function formatAgentDuration(agent: AgentSession): string {
	const start = new Date(agent.startedAt).getTime();
	const end =
		agent.state === "completed" || agent.state === "zombie"
			? new Date(agent.lastActivity).getTime()
			: Date.now();
	return formatDuration(end - start);
}

/**
 * Show current run status (default subcommand).
 */
async function showCurrentRun(overstoryDir: string, dbRoot: string, json: boolean): Promise<void> {
	const runId = await readCurrentRunId(overstoryDir);
	if (!runId) {
		if (json) {
			jsonOutput("run", { run: null, message: "No active run" });
		} else {
			printHint("No active run");
		}
		return;
	}

	const dbPath = join(dbRoot, "sessions.db");
	const runStore = createRunStore(dbPath);
	try {
		const run = runStore.getRun(runId);
		if (!run) {
			if (json) {
				jsonOutput("run", { run: null, message: `Run ${runId} not found in store` });
			} else {
				process.stdout.write(`Run ${accent(runId)} not found in store\n`);
			}
			return;
		}

		if (json) {
			jsonOutput("run", { run, duration: runDuration(run) });
			return;
		}

		process.stdout.write(`${renderHeader("Current Run")}\n`);
		process.stdout.write(`  ID:       ${accent(run.id)}\n`);
		process.stdout.write(`  Status:   ${run.status}\n`);
		process.stdout.write(`  Started:  ${run.startedAt}\n`);
		process.stdout.write(`  Agents:   ${run.agentCount}\n`);
		process.stdout.write(`  Duration: ${runDuration(run)}\n`);
	} finally {
		runStore.close();
	}
}

/**
 * List recent runs.
 */
async function listRuns(dbRoot: string, limit: number, json: boolean): Promise<void> {
	const dbPath = join(dbRoot, "sessions.db");
	const dbFile = Bun.file(dbPath);
	if (!(await dbFile.exists())) {
		if (json) {
			jsonOutput("run list", { runs: [] });
		} else {
			printHint("No runs recorded yet");
		}
		return;
	}

	const runStore = createRunStore(dbPath);
	try {
		const runs = runStore.listRuns({ limit });

		if (json) {
			const runsWithDuration = runs.map((r) => ({ ...r, duration: runDuration(r) }));
			jsonOutput("run list", { runs: runsWithDuration });
			return;
		}

		if (runs.length === 0) {
			printHint("No runs recorded yet");
			return;
		}

		process.stdout.write(`${renderHeader("Recent Runs")}\n`);
		process.stdout.write(
			`${"ID".padEnd(36)} ${"Status".padEnd(10)} ${"Agents".padEnd(7)} Duration\n`,
		);
		process.stdout.write(`${separator()}\n`);

		for (const run of runs) {
			const id = accent(run.id.length > 35 ? `${run.id.slice(0, 32)}...` : run.id.padEnd(36));
			const status = run.status.padEnd(10);
			const agents = String(run.agentCount).padEnd(7);
			const duration = runDuration(run);
			process.stdout.write(`${id} ${status} ${agents} ${duration}\n`);
		}
	} finally {
		runStore.close();
	}
}

/**
 * Mark the current run as completed.
 */
async function completeCurrentRun(
	overstoryDir: string,
	dbRoot: string,
	json: boolean,
): Promise<void> {
	const runId = await readCurrentRunId(overstoryDir);
	if (!runId) {
		if (json) {
			jsonError("run complete", "No active run to complete");
		} else {
			printError("No active run to complete");
		}
		process.exitCode = 1;
		return;
	}

	const dbPath = join(dbRoot, "sessions.db");
	const runStore = createRunStore(dbPath);
	try {
		runStore.completeRun(runId, "completed");
	} finally {
		runStore.close();
	}

	// Delete current-run.txt
	const { unlink } = await import("node:fs/promises");
	try {
		await unlink(currentRunPath(overstoryDir));
	} catch {
		// File may already be gone, that's fine
	}

	if (json) {
		jsonOutput("run complete", { runId, status: "completed" });
	} else {
		printSuccess("Run completed", runId);
	}
}

/**
 * Show detailed information for a specific run.
 */
async function showRun(dbRoot: string, runId: string, json: boolean): Promise<void> {
	const dbPath = join(dbRoot, "sessions.db");
	const dbFile = Bun.file(dbPath);
	if (!(await dbFile.exists())) {
		if (json) {
			jsonError("run show", `Run ${runId} not found`);
		} else {
			printError("Run not found", runId);
		}
		process.exitCode = 1;
		return;
	}

	const runStore = createRunStore(dbPath);
	const sessionStore = createSessionStore(dbPath);
	try {
		const run = runStore.getRun(runId);
		if (!run) {
			if (json) {
				jsonError("run show", `Run ${runId} not found`);
			} else {
				printError("Run not found", runId);
			}
			process.exitCode = 1;
			return;
		}

		const agents = sessionStore.getByRun(runId);

		if (json) {
			jsonOutput("run show", { run, duration: runDuration(run), agents });
			return;
		}

		process.stdout.write(`${renderHeader("Run Details")}\n`);
		process.stdout.write(`  ID:       ${accent(run.id)}\n`);
		process.stdout.write(`  Status:   ${run.status}\n`);
		process.stdout.write(`  Started:  ${run.startedAt}\n`);
		if (run.completedAt) {
			process.stdout.write(`  Ended:    ${run.completedAt}\n`);
		}
		process.stdout.write(`  Agents:   ${run.agentCount}\n`);
		process.stdout.write(`  Duration: ${runDuration(run)}\n`);

		if (agents.length > 0) {
			process.stdout.write(`\nAgents (${agents.length}):\n`);
			process.stdout.write(`${separator()}\n`);
			for (const agent of agents) {
				const agentDuration = formatAgentDuration(agent);
				process.stdout.write(
					`  ${accent(agent.agentName)} [${agent.capability}] ${agent.state} | ${agentDuration}\n`,
				);
			}
		} else {
			process.stdout.write("\nNo agents recorded for this run.\n");
		}
	} finally {
		runStore.close();
		sessionStore.close();
	}
}

interface RunDefaultOpts {
	json?: boolean;
}

interface RunListOpts {
	last?: string;
	json?: boolean;
}

interface RunShowOpts {
	json?: boolean;
}

interface RunCompleteOpts {
	json?: boolean;
}

export function createRunCommand(): Command {
	const cmd = new Command("run").description("Manage runs (coordinator session groupings)");

	// Default action (bare `overstory run`)
	cmd.option("--json", "Output as JSON").action(async (opts: RunDefaultOpts, cmdObj: Command) => {
		const cwd = process.cwd();
		await loadConfig(cwd);
		const globalOpts = cmdObj.optsWithGlobals();
		const ctx = await resolveContext({ project: globalOpts.project as string | undefined });
		await showCurrentRun(ctx.overstoryDir, ctx.dbRoot, opts.json ?? false);
	});

	// `overstory run list`
	cmd
		.command("list")
		.description("List recent runs")
		.option("--last <n>", "Number of recent runs to show (default: 10)")
		.option("--json", "Output as JSON")
		.action(async (opts: RunListOpts, cmdObj: Command) => {
			const lastStr = opts.last;
			const limit = lastStr ? Number.parseInt(lastStr, 10) : 10;
			if (Number.isNaN(limit) || limit < 1) {
				throw new ValidationError("--last must be a positive integer", {
					field: "last",
					value: lastStr,
				});
			}
			const cwd = process.cwd();
			await loadConfig(cwd);
			const globalOpts = cmdObj.optsWithGlobals();
			const ctx = await resolveContext({ project: globalOpts.project as string | undefined });
			await listRuns(ctx.dbRoot, limit, opts.json ?? false);
		});

	// `overstory run show <id>`
	cmd
		.command("show")
		.description("Show run details (agents, duration)")
		.argument("<id>", "Run ID")
		.option("--json", "Output as JSON")
		.action(async (id: string, opts: RunShowOpts, cmdObj: Command) => {
			const cwd = process.cwd();
			await loadConfig(cwd);
			const globalOpts = cmdObj.optsWithGlobals();
			const ctx = await resolveContext({ project: globalOpts.project as string | undefined });
			await showRun(ctx.dbRoot, id, opts.json ?? false);
		});

	// `overstory run complete`
	cmd
		.command("complete")
		.description("Mark current run as completed")
		.option("--json", "Output as JSON")
		.action(async (opts: RunCompleteOpts, cmdObj: Command) => {
			const cwd = process.cwd();
			await loadConfig(cwd);
			const globalOpts = cmdObj.optsWithGlobals();
			const ctx = await resolveContext({ project: globalOpts.project as string | undefined });
			await completeCurrentRun(ctx.overstoryDir, ctx.dbRoot, opts.json ?? false);
		});

	return cmd;
}

export async function runCommand(args: string[]): Promise<void> {
	const program = new Command("ov").exitOverride().configureOutput({
		writeOut: (str) => process.stdout.write(str),
		writeErr: (str) => process.stderr.write(str),
	});
	program.addCommand(createRunCommand());
	try {
		await program.parseAsync(["node", "ov", "run", ...args]);
	} catch (err: unknown) {
		if (err instanceof CommanderError) {
			if (err.code === "commander.helpDisplayed" || err.code === "commander.version") return;
			throw new ValidationError(err.message, { field: "args" });
		}
		throw err;
	}
}

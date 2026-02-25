/**
 * CLI command: ov metrics [--last <n>] [--json]
 *
 * Shows metrics summary from SQLite store: session durations, success rates,
 * merge tier distribution, agent utilization.
 */

import { join } from "node:path";
import { Command } from "commander";
import { jsonOutput } from "../json.ts";
import { formatDuration } from "../logging/format.ts";
import { renderHeader } from "../logging/theme.ts";
import { createMetricsStore } from "../metrics/store.ts";
import { resolveContext } from "../workspace/resolver.ts";

interface MetricsOpts {
	last?: string;
	json?: boolean;
	project?: string;
}

async function executeMetrics(opts: MetricsOpts): Promise<void> {
	const limit = opts.last ? Number.parseInt(opts.last, 10) : 20;
	const json = opts.json ?? false;

	const ctx = await resolveContext({ project: opts.project });
	const isWorkspace = ctx.mode === "workspace";
	const dbPath = join(ctx.dbRoot, "metrics.db");

	const dbFile = Bun.file(dbPath);
	if (!(await dbFile.exists())) {
		if (json) {
			jsonOutput("metrics", { sessions: [] });
		} else {
			process.stdout.write("No metrics data yet.\n");
		}
		return;
	}

	const store = createMetricsStore(dbPath);

	// Determine projectId filter for workspace mode with explicit --project
	const projectIdFilter = isWorkspace && opts.project !== undefined ? ctx.projectId : undefined;

	try {
		const sessions = store.getRecentSessions(limit, projectIdFilter);

		if (json) {
			jsonOutput("metrics", { sessions } as Record<string, unknown>);
			return;
		}

		if (sessions.length === 0) {
			process.stdout.write("No sessions recorded yet.\n");
			return;
		}

		process.stdout.write(`${renderHeader("Session Metrics")}\n\n`);
		if (isWorkspace && opts.project === undefined) {
			process.stdout.write("(workspace: all projects)\n\n");
		} else if (isWorkspace) {
			process.stdout.write(`(project: ${ctx.projectId})\n\n`);
		}

		// Summary stats
		const completed = sessions.filter((s) => s.completedAt !== null);
		const avgDuration = store.getAverageDuration(undefined, projectIdFilter);

		process.stdout.write(`Total sessions: ${sessions.length}\n`);
		process.stdout.write(`Completed: ${completed.length}\n`);
		process.stdout.write(`Avg duration: ${formatDuration(avgDuration)}\n\n`);

		// Merge tier distribution
		const tierCounts: Record<string, number> = {};
		for (const s of completed) {
			if (s.mergeResult) {
				tierCounts[s.mergeResult] = (tierCounts[s.mergeResult] ?? 0) + 1;
			}
		}
		if (Object.keys(tierCounts).length > 0) {
			process.stdout.write("Merge tiers:\n");
			for (const [tier, count] of Object.entries(tierCounts)) {
				process.stdout.write(`  ${tier}: ${count}\n`);
			}
			process.stdout.write("\n");
		}

		// Capability breakdown
		const capCounts: Record<string, number> = {};
		for (const s of sessions) {
			capCounts[s.capability] = (capCounts[s.capability] ?? 0) + 1;
		}
		process.stdout.write("By capability:\n");
		for (const [cap, count] of Object.entries(capCounts)) {
			const capAvg = store.getAverageDuration(cap, projectIdFilter);
			process.stdout.write(`  ${cap}: ${count} sessions (avg ${formatDuration(capAvg)})\n`);
		}
		process.stdout.write("\n");

		// Recent sessions table
		process.stdout.write("Recent sessions:\n");
		for (const s of sessions) {
			const status = s.completedAt ? "done" : "running";
			const duration = formatDuration(s.durationMs);
			if (isWorkspace && opts.project === undefined) {
				const pid = s.projectId ?? "_default";
				process.stdout.write(
					`  ${s.agentName} [${s.capability}] [${pid}] ${s.taskId} | ${status} | ${duration}\n`,
				);
			} else {
				process.stdout.write(
					`  ${s.agentName} [${s.capability}] ${s.taskId} | ${status} | ${duration}\n`,
				);
			}
		}
	} finally {
		store.close();
	}
}

export function createMetricsCommand(): Command {
	return new Command("metrics")
		.description("Show session metrics")
		.option("--last <n>", "Number of recent sessions to show (default: 20)")
		.option("--json", "Output as JSON")
		.action(async (opts: MetricsOpts, cmd: Command) => {
			const globalOpts = cmd.optsWithGlobals();
			await executeMetrics({ ...opts, project: globalOpts.project as string | undefined });
		});
}

export async function metricsCommand(args: string[]): Promise<void> {
	const cmd = createMetricsCommand();
	cmd.exitOverride();
	try {
		await cmd.parseAsync(args, { from: "user" });
	} catch (err: unknown) {
		if (err && typeof err === "object" && "code" in err) {
			const code = (err as { code: string }).code;
			if (code === "commander.helpDisplayed" || code === "commander.version") {
				return;
			}
		}
		throw err;
	}
}

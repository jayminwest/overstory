/**
 * CLI command: ov errors [--agent <name>] [--run <id>] [--json] [--since <ts>] [--until <ts>] [--limit <n>]
 *
 * Shows aggregated error-level events across all agents.
 * Errors can be filtered by agent name, run ID, or time range.
 * Human output groups errors by agent; JSON output returns a flat array.
 */

import { join } from "node:path";
import { Command } from "commander";
import { ValidationError } from "../errors.ts";
import { createEventStore } from "../events/store.ts";
import { jsonOutput } from "../json.ts";
import { accent, color } from "../logging/color.ts";
import { buildEventDetail, formatAbsoluteTime, formatDate } from "../logging/format.ts";
import { separator } from "../logging/theme.ts";
import type { StoredEvent } from "../types.ts";
import { resolveContext } from "../workspace/resolver.ts";

/**
 * Group errors by agent name, preserving insertion order.
 */
function groupByAgent(events: StoredEvent[]): Map<string, StoredEvent[]> {
	const groups = new Map<string, StoredEvent[]>();
	for (const event of events) {
		const existing = groups.get(event.agentName);
		if (existing) {
			existing.push(event);
		} else {
			groups.set(event.agentName, [event]);
		}
	}
	return groups;
}

/**
 * Print errors grouped by agent with ANSI colors.
 * When projectName is provided, it is shown as a header prefix.
 */
function printErrors(events: StoredEvent[], projectName?: string): void {
	const w = process.stdout.write.bind(process.stdout);

	w(`${color.bold(color.red("Errors"))}\n${separator()}\n`);

	if (events.length === 0) {
		w(`${color.dim("No errors found.")}\n`);
		return;
	}

	w(`${color.dim(`${events.length} error${events.length === 1 ? "" : "s"}`)}\n\n`);

	const grouped = groupByAgent(events);

	let firstGroup = true;
	for (const [agentName, agentEvents] of grouped) {
		if (!firstGroup) {
			w("\n");
		}
		firstGroup = false;

		const projectSuffix = projectName ? ` ${color.dim(`[${projectName}]`)}` : "";
		w(
			`${accent(agentName)}${projectSuffix} ${color.dim(`(${agentEvents.length} error${agentEvents.length === 1 ? "" : "s"})`)}\n`,
		);

		for (const event of agentEvents) {
			const date = formatDate(event.createdAt);
			const time = formatAbsoluteTime(event.createdAt);
			const timestamp = date ? `${date} ${time}` : time;

			const detail = buildEventDetail(event);
			const detailSuffix = detail ? ` ${color.dim(detail)}` : "";

			w(`  ${color.dim(timestamp)} ${color.red(color.bold("ERROR"))}${detailSuffix}\n`);
		}
	}
}

/**
 * Print errors grouped by project, then by agent (workspace mode).
 */
function printErrorsWorkspace(
	taggedEvents: Array<{ event: StoredEvent; projectName: string }>,
): void {
	const w = process.stdout.write.bind(process.stdout);

	w(`${color.bold(color.red("Errors"))}\n`);
	w(`${"=".repeat(70)}\n`);

	if (taggedEvents.length === 0) {
		w(`${color.dim("No errors found.")}\n`);
		return;
	}

	w(`${color.dim(`${taggedEvents.length} error${taggedEvents.length === 1 ? "" : "s"}`)}\n\n`);

	// Group by project
	const byProject = new Map<string, StoredEvent[]>();
	for (const { event, projectName } of taggedEvents) {
		const existing = byProject.get(projectName);
		if (existing) {
			existing.push(event);
		} else {
			byProject.set(projectName, [event]);
		}
	}

	let firstProject = true;
	for (const [projectName, projectEvents] of byProject) {
		if (!firstProject) {
			w("\n");
		}
		firstProject = false;

		w(
			`${color.bold(color.cyan(projectName))} ${color.dim(`(${projectEvents.length} error${projectEvents.length === 1 ? "" : "s"})`)}\n`,
		);

		const grouped = groupByAgent(projectEvents);
		let firstGroup = true;
		for (const [agentName, agentEvents] of grouped) {
			if (!firstGroup) {
				w("\n");
			}
			firstGroup = false;

			w(
				`  ${color.bold(agentName)} ${color.dim(`(${agentEvents.length} error${agentEvents.length === 1 ? "" : "s"})`)}\n`,
			);

			for (const event of agentEvents) {
				const date = formatDate(event.createdAt);
				const time = formatAbsoluteTime(event.createdAt);
				const timestamp = date ? `${date} ${time}` : time;

				const detail = buildErrorDetail(event);
				const detailSuffix = detail ? ` ${color.dim(detail)}` : "";

				w(`    ${color.dim(timestamp)} ${color.red(color.bold("ERROR"))}${detailSuffix}\n`);
			}
		}
	}
}

interface ErrorsOpts {
	agent?: string;
	run?: string;
	since?: string;
	until?: string;
	limit?: string;
	json?: boolean;
	project?: string;
}

async function executeErrors(opts: ErrorsOpts): Promise<void> {
	const json = opts.json ?? false;
	const agentName = opts.agent;
	const runId = opts.run;
	const sinceStr = opts.since;
	const untilStr = opts.until;
	const limitStr = opts.limit;
	const limit = limitStr ? Number.parseInt(limitStr, 10) : 100;

	if (Number.isNaN(limit) || limit < 1) {
		throw new ValidationError("--limit must be a positive integer", {
			field: "limit",
			value: limitStr,
		});
	}

	// Validate timestamps if provided
	if (sinceStr !== undefined && Number.isNaN(new Date(sinceStr).getTime())) {
		throw new ValidationError("--since must be a valid ISO 8601 timestamp", {
			field: "since",
			value: sinceStr,
		});
	}
	if (untilStr !== undefined && Number.isNaN(new Date(untilStr).getTime())) {
		throw new ValidationError("--until must be a valid ISO 8601 timestamp", {
			field: "until",
			value: untilStr,
		});
	}

	const ctx = await resolveContext({ project: opts.project });

	// Workspace-aggregate mode: no --project flag in workspace context
	const isWorkspaceAggregate =
		ctx.mode === "workspace" && ctx.workspaceConfig !== null && opts.project === undefined;

	if (isWorkspaceAggregate) {
		const projects = ctx.workspaceConfig!.projects;
		const allTagged: Array<{ event: StoredEvent; projectName: string }> = [];
		const queryOpts = { since: sinceStr, until: untilStr, limit };

		for (const project of projects) {
			const eventsDbPath = join(project.root, ".overstory", "events.db");
			if (!(await Bun.file(eventsDbPath).exists())) continue;
			const store = createEventStore(eventsDbPath);
			try {
				let events: StoredEvent[];
				if (agentName !== undefined) {
					events = store.getByAgent(agentName, { ...queryOpts, level: "error" });
				} else if (runId !== undefined) {
					events = store.getByRun(runId, { ...queryOpts, level: "error" });
				} else {
					events = store.getErrors(queryOpts);
				}
				for (const event of events) {
					allTagged.push({ event, projectName: project.name });
				}
			} finally {
				store.close();
			}
		}

		// Sort by timestamp and apply limit
		allTagged.sort((a, b) => a.event.createdAt.localeCompare(b.event.createdAt));
		const limited = allTagged.slice(0, limit);

		if (json) {
			process.stdout.write(
				`${JSON.stringify(limited.map((t) => ({ ...t.event, projectName: t.projectName })))}\n`,
			);
			return;
		}

		printErrorsWorkspace(limited);
		return;
	}

	// Single-project mode (single-repo or workspace with --project)
	const eventsDbPath = join(ctx.overstoryDir, "events.db");
	const eventsFile = Bun.file(eventsDbPath);
	if (!(await eventsFile.exists())) {
		if (json) {
			jsonOutput("errors", { events: [] });
		} else {
			process.stdout.write("No events data yet.\n");
		}
		return;
	}

	const eventStore = createEventStore(eventsDbPath);

	try {
		const queryOpts = {
			since: sinceStr,
			until: untilStr,
			limit,
		};

		let events: StoredEvent[];

		if (agentName !== undefined) {
			// Filter by agent: use getByAgent with level filter
			events = eventStore.getByAgent(agentName, { ...queryOpts, level: "error" });
		} else if (runId !== undefined) {
			// Filter by run: use getByRun with level filter
			events = eventStore.getByRun(runId, { ...queryOpts, level: "error" });
		} else {
			// Global errors: use getErrors (already filters level='error')
			events = eventStore.getErrors(queryOpts);
		}

		if (json) {
			jsonOutput("errors", { events });
			return;
		}

		// Pass project name when in workspace mode with specific project
		const projectLabel = ctx.mode === "workspace" ? ctx.projectId : undefined;
		printErrors(events, projectLabel);
	} finally {
		eventStore.close();
	}
}

export function createErrorsCommand(): Command {
	return new Command("errors")
		.description("Aggregated error view across agents")
		.option("--agent <name>", "Filter errors by agent name")
		.option("--run <id>", "Filter errors by run ID")
		.option("--since <timestamp>", "Start time filter (ISO 8601)")
		.option("--until <timestamp>", "End time filter (ISO 8601)")
		.option("--limit <n>", "Max errors to show (default: 100)")
		.option("--json", "Output as JSON array of StoredEvent objects")
		.action(async (opts: ErrorsOpts, cmd: Command) => {
			const globalOpts = cmd.optsWithGlobals();
			await executeErrors({ ...opts, project: globalOpts.project as string | undefined });
		});
}

export async function errorsCommand(args: string[]): Promise<void> {
	const cmd = createErrorsCommand();
	cmd.exitOverride();
	try {
		await cmd.parseAsync(args, { from: "user" });
	} catch (err: unknown) {
		if (err && typeof err === "object" && "code" in err) {
			const code = (err as { code: string }).code;
			if (code === "commander.helpDisplayed" || code === "commander.version") {
				return;
			}
			if (code.startsWith("commander.")) {
				const message = err instanceof Error ? err.message : String(err);
				throw new ValidationError(message, { field: "args" });
			}
		}
		throw err;
	}
}

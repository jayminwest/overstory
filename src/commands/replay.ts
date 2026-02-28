/**
 * CLI command: ov replay [--run <id>] [--agent <name>...] [--json]
 *              [--since <ts>] [--until <ts>] [--limit <n>]
 *
 * Shows an interleaved chronological replay of events across multiple agents.
 * Like reading a combined log — all agents' events merged by timestamp.
 */

import { join } from "node:path";
import { Command } from "commander";
import { ValidationError } from "../errors.ts";
import { createEventStore } from "../events/store.ts";
import { jsonOutput } from "../json.ts";
import { color } from "../logging/color.ts";
import {
	buildAgentColorMap,
	buildEventDetail,
	formatAbsoluteTime,
	formatDate,
	formatRelativeTime,
} from "../logging/format.ts";
import { eventLabel, renderHeader } from "../logging/theme.ts";
import type { StoredEvent } from "../types.ts";
import { WORKSPACE_PROJECT_ID } from "../workspace/config.ts";
import { resolveContext } from "../workspace/resolver.ts";

/**
 * Print events as an interleaved timeline with ANSI colors and agent labels.
 * projectNames: optional map from event index to project name (for workspace mode).
 */
function printReplay(
	events: StoredEvent[],
	useAbsoluteTime: boolean,
	projectNames?: Map<number, string>,
): void {
	const w = process.stdout.write.bind(process.stdout);

	w(`${renderHeader("Replay")}\n`);

	if (events.length === 0) {
		w(`${color.dim("No events found.")}\n`);
		return;
	}

	w(`${color.dim(`${events.length} event${events.length === 1 ? "" : "s"}`)}\n\n`);

	const colorMap = buildAgentColorMap(events);
	let lastDate = "";

	for (let i = 0; i < events.length; i++) {
		const event = events[i];
		if (!event) continue;

		// Print date separator when the date changes
		const date = formatDate(event.createdAt);
		if (date && date !== lastDate) {
			if (lastDate !== "") {
				w("\n");
			}
			w(`${color.dim(`--- ${date} ---`)}\n`);
			lastDate = date;
		}

		const timeStr = useAbsoluteTime
			? formatAbsoluteTime(event.createdAt)
			: formatRelativeTime(event.createdAt);

		const label = eventLabel(event.eventType);

		const levelColorFn =
			event.level === "error" ? color.red : event.level === "warn" ? color.yellow : null;
		const applyLevel = (text: string) => (levelColorFn ? levelColorFn(text) : text);

		const detail = buildEventDetail(event);
		const detailSuffix = detail ? ` ${color.dim(detail)}` : "";

		const agentColorFn = colorMap.get(event.agentName) ?? color.gray;
		const agentLabel = ` ${agentColorFn(`[${event.agentName}]`)}`;
		const projectLabel = projectNames?.get(i) ? ` ${color.dim(`[${projectNames.get(i)}]`)}` : "";

		w(
			`${color.dim(timeStr.padStart(10))} ` +
				`${applyLevel(label.color(color.bold(label.full)))}` +
				`${agentLabel}${projectLabel}${detailSuffix}\n`,
		);
	}
}

interface ReplayOpts {
	run?: string;
	agent: string[]; // repeatable
	since?: string;
	until?: string;
	limit?: string;
	json?: boolean;
	project?: string;
}

async function executeReplay(opts: ReplayOpts): Promise<void> {
	const json = opts.json ?? false;
	const runId = opts.run;
	const agentNames = opts.agent;
	const sinceStr = opts.since;
	const untilStr = opts.until;
	const limitStr = opts.limit;
	const limit = limitStr ? Number.parseInt(limitStr, 10) : 200;

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
	const activeProjectId =
		ctx.mode === "workspace" && ctx.projectId !== WORKSPACE_PROJECT_ID ? ctx.projectId : undefined;

	// Workspace-aggregate mode: no --project flag in workspace context
	const isWorkspaceAggregate =
		ctx.mode === "workspace" && ctx.workspaceConfig !== null && opts.project === undefined;

	if (isWorkspaceAggregate) {
		const projects = ctx.workspaceConfig!.projects;
		const eventsDbPath = join(ctx.dbRoot, "events.db");
		const eventsFile = Bun.file(eventsDbPath);
		if (!(await eventsFile.exists())) {
			if (json) {
				jsonOutput("replay", { events: [] });
			} else {
				process.stdout.write("No events data yet.\n");
			}
			return;
		}
		const store = createEventStore(eventsDbPath);
		const allTagged: Array<{ event: StoredEvent; projectName: string }> = [];
		const queryOpts = { since: sinceStr, until: untilStr, limit };

		try {
			for (const project of projects) {
				let events: StoredEvent[];
				if (runId) {
					events = store.getByRun(runId, { ...queryOpts, projectId: project.name });
				} else if (agentNames.length > 0) {
					const merged: StoredEvent[] = [];
					for (const name of agentNames) {
						merged.push(
							...store.getByAgent(name, {
								since: sinceStr,
								until: untilStr,
								projectId: project.name,
							}),
						);
					}
					merged.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
					events = merged.slice(0, limit);
				} else {
					const since24h = sinceStr ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
					events = store.getTimeline({
						since: since24h,
						until: untilStr,
						limit,
						projectId: project.name,
					});
				}
				for (const event of events) {
					allTagged.push({ event, projectName: project.name });
				}
			}
		} finally {
			store.close();
		}

		// Sort merged results chronologically and apply limit
		allTagged.sort((a, b) => a.event.createdAt.localeCompare(b.event.createdAt));
		const limited = allTagged.slice(0, limit);

		if (json) {
			process.stdout.write(
				`${JSON.stringify(limited.map((t) => ({ ...t.event, projectName: t.projectName })))}\n`,
			);
			return;
		}

		const events = limited.map((t) => t.event);
		const projectNameMap = new Map<number, string>();
		for (let i = 0; i < limited.length; i++) {
			const item = limited[i];
			if (item) projectNameMap.set(i, item.projectName);
		}
		const useAbsoluteTime = sinceStr !== undefined;
		printReplay(events, useAbsoluteTime, projectNameMap);
		return;
	}

	// Single-project mode (single-repo or workspace with --project)
	const eventsDbPath = join(ctx.dbRoot, "events.db");
	const eventsFile = Bun.file(eventsDbPath);
	if (!(await eventsFile.exists())) {
		if (json) {
			jsonOutput("replay", { events: [] });
		} else {
			process.stdout.write("No events data yet.\n");
		}
		return;
	}

	const eventStore = createEventStore(eventsDbPath);

	try {
		let events: StoredEvent[];
		const queryOpts = { since: sinceStr, until: untilStr, limit };

		if (runId) {
			// Query by run ID
			events = eventStore.getByRun(runId, { ...queryOpts, projectId: activeProjectId });
		} else if (agentNames.length > 0) {
			// Query each agent and merge
			const allEvents: StoredEvent[] = [];
			for (const name of agentNames) {
				const agentEvents = eventStore.getByAgent(name, {
					since: sinceStr,
					until: untilStr,
					projectId: activeProjectId,
				});
				allEvents.push(...agentEvents);
			}
			// Sort by createdAt chronologically
			allEvents.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
			// Apply limit after merge
			events = allEvents.slice(0, limit);
		} else {
			// Default: try current-run.txt, then fall back to 24h timeline
			const currentRunPath = join(ctx.overstoryDir, "current-run.txt");
			const currentRunFile = Bun.file(currentRunPath);
			if (await currentRunFile.exists()) {
				const currentRunId = (await currentRunFile.text()).trim();
					if (currentRunId) {
						events = eventStore.getByRun(currentRunId, {
							...queryOpts,
							projectId: activeProjectId,
						});
					} else {
					// Empty file, fall back to timeline
					const since24h = sinceStr ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
						events = eventStore.getTimeline({
							since: since24h,
							until: untilStr,
							limit,
							projectId: activeProjectId,
						});
				}
			} else {
				// No current run file, fall back to 24h timeline
				const since24h = sinceStr ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
					events = eventStore.getTimeline({
						since: since24h,
						until: untilStr,
						limit,
						projectId: activeProjectId,
					});
			}
		}

		if (json) {
			jsonOutput("replay", { events });
			return;
		}

		// Use absolute time if --since is specified, relative otherwise
		const useAbsoluteTime = sinceStr !== undefined;
		printReplay(events, useAbsoluteTime);
	} finally {
		eventStore.close();
	}
}

export function createReplayCommand(): Command {
	return new Command("replay")
		.description("Interleaved chronological replay across agents")
		.option("--run <id>", "Filter events by run ID")
		.option(
			"--agent <name>",
			"Filter by agent name (can appear multiple times)",
			(val: string, prev: string[]) => [...prev, val],
			[] as string[],
		)
		.option("--since <timestamp>", "Start time filter (ISO 8601)")
		.option("--until <timestamp>", "End time filter (ISO 8601)")
		.option("--limit <n>", "Max events to show (default: 200)")
		.option("--json", "Output as JSON array of StoredEvent objects")
		.action(async (opts: ReplayOpts, cmd: Command) => {
			const globalOpts = cmd.optsWithGlobals();
			await executeReplay({ ...opts, project: globalOpts.project as string | undefined });
		});
}

export async function replayCommand(args: string[]): Promise<void> {
	const cmd = createReplayCommand();
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

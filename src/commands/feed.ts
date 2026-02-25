/**
 * CLI command: ov feed [--follow] [--agent <name>...] [--run <id>]
 *              [--since <ts>] [--limit <n>] [--interval <ms>] [--json]
 *
 * Unified real-time event stream across all agents — like `tail -f` for the fleet.
 * Shows chronological events from all agents merged into a single feed.
 */

import { join } from "node:path";
import { Command } from "commander";
import { ValidationError } from "../errors.ts";
import { createEventStore } from "../events/store.ts";
import { jsonOutput } from "../json.ts";
import type { ColorFn } from "../logging/color.ts";
import { color } from "../logging/color.ts";
import type { EventType, StoredEvent } from "../types.ts";
import { resolveContext } from "../workspace/resolver.ts";

/** Compact 5-char labels for feed output. */
const EVENT_LABELS: Record<EventType, { label: string; color: ColorFn }> = {
	tool_start: { label: "TOOL+", color: color.blue },
	tool_end: { label: "TOOL-", color: color.blue },
	session_start: { label: "SESS+", color: color.green },
	session_end: { label: "SESS-", color: color.yellow },
	mail_sent: { label: "MAIL>", color: color.cyan },
	mail_received: { label: "MAIL<", color: color.cyan },
	spawn: { label: "SPAWN", color: color.magenta },
	error: { label: "ERROR", color: color.red },
	custom: { label: "CUSTM", color: color.gray },
};

/** Color functions assigned to agents in order of first appearance. */
const AGENT_COLORS: readonly ColorFn[] = [
	color.blue,
	color.green,
	color.yellow,
	color.cyan,
	color.magenta,
];

/**
 * Format an absolute time from an ISO timestamp.
 * Returns "HH:MM:SS" portion.
 */
function formatAbsoluteTime(timestamp: string): string {
	const match = /T(\d{2}:\d{2}:\d{2})/.exec(timestamp);
	if (match?.[1]) {
		return match[1];
	}
	return timestamp;
}

/**
 * Build a detail string for a feed event based on its type and fields.
 */
function buildEventDetail(event: StoredEvent): string {
	const parts: string[] = [];

	if (event.toolName) {
		parts.push(`tool=${event.toolName}`);
	}

	if (event.toolDurationMs !== null) {
		parts.push(`${event.toolDurationMs}ms`);
	}

	if (event.data) {
		try {
			const parsed: unknown = JSON.parse(event.data);
			if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
				const data = parsed as Record<string, unknown>;
				for (const [key, value] of Object.entries(data)) {
					if (value !== null && value !== undefined) {
						const strValue = typeof value === "string" ? value : JSON.stringify(value);
						// Truncate long values
						const truncated = strValue.length > 60 ? `${strValue.slice(0, 57)}...` : strValue;
						parts.push(`${key}=${truncated}`);
					}
				}
			}
		} catch {
			// data is not valid JSON; show it raw if short enough
			if (event.data.length <= 60) {
				parts.push(event.data);
			}
		}
	}

	return parts.join(" ");
}

/**
 * Assign a stable color function to each agent based on order of first appearance.
 */
function buildAgentColorMap(events: StoredEvent[]): Map<string, ColorFn> {
	const colorMap = new Map<string, ColorFn>();
	for (const event of events) {
		if (!colorMap.has(event.agentName)) {
			const colorIndex = colorMap.size % AGENT_COLORS.length;
			const agentColorFn = AGENT_COLORS[colorIndex];
			if (agentColorFn !== undefined) {
				colorMap.set(event.agentName, agentColorFn);
			}
		}
	}
	return colorMap;
}

/**
 * Print a single event in compact feed format:
 * HH:MM:SS LABEL agentname    detail
 */
function printEvent(
	event: StoredEvent,
	colorMap: Map<string, ColorFn>,
	projectName?: string,
): void {
	const w = process.stdout.write.bind(process.stdout);

	const timeStr = formatAbsoluteTime(event.createdAt);

	const eventInfo = EVENT_LABELS[event.eventType] ?? {
		label: event.eventType.padEnd(5),
		color: color.gray,
	};

	const levelColorFn =
		event.level === "error" ? color.red : event.level === "warn" ? color.yellow : null;
	const applyLevel = (text: string) => (levelColorFn ? levelColorFn(text) : text);

	const detail = buildEventDetail(event);
	const detailSuffix = detail ? ` ${color.dim(detail)}` : "";

	const agentColorFn = colorMap.get(event.agentName) ?? color.gray;
	const agentLabel = ` ${agentColorFn(event.agentName.padEnd(15))}`;
	const projectLabel = projectName ? ` ${color.dim(`[${projectName}]`)}` : "";

	w(
		`${color.dim(timeStr)} ` +
			`${applyLevel(eventInfo.color(color.bold(eventInfo.label)))}` +
			`${agentLabel}${projectLabel}${detailSuffix}\n`,
	);
}

interface FeedOpts {
	follow?: boolean;
	interval?: string;
	agent: string[]; // repeatable
	run?: string;
	since?: string;
	limit?: string;
	json?: boolean;
	project?: string;
}

async function executeFeed(opts: FeedOpts): Promise<void> {
	const json = opts.json ?? false;
	const follow = opts.follow ?? false;
	const runId = opts.run;
	const agentNames = opts.agent;
	const sinceStr = opts.since;
	const limitStr = opts.limit;
	const limit = limitStr ? Number.parseInt(limitStr, 10) : 50;

	const intervalStr = opts.interval;
	const interval = intervalStr ? Number.parseInt(intervalStr, 10) : 1000;

	if (Number.isNaN(limit) || limit < 1) {
		throw new ValidationError("--limit must be a positive integer", {
			field: "limit",
			value: limitStr,
		});
	}

	if (Number.isNaN(interval) || interval < 200) {
		throw new ValidationError("--interval must be a number >= 200 (milliseconds)", {
			field: "interval",
			value: intervalStr,
		});
	}

	// Validate timestamp if provided
	if (sinceStr !== undefined && Number.isNaN(new Date(sinceStr).getTime())) {
		throw new ValidationError("--since must be a valid ISO 8601 timestamp", {
			field: "since",
			value: sinceStr,
		});
	}

	const ctx = await resolveContext({ project: opts.project });

	// Workspace-aggregate mode: no --project flag in workspace context
	const isWorkspaceAggregate =
		ctx.mode === "workspace" && ctx.workspaceConfig !== null && opts.project === undefined;

	if (isWorkspaceAggregate) {
		// Workspace mode without --project: aggregate events from all projects
		const projects = ctx.workspaceConfig!.projects;

		// Default since: 5 minutes ago
		const since = sinceStr ?? new Date(Date.now() - 5 * 60 * 1000).toISOString();

		// Helper to query all projects and merge events with project labels
		const queryAllProjects = async (
			queryOpts: { since: string; limit: number },
		): Promise<Array<{ event: StoredEvent; projectName: string }>> => {
			const allTagged: Array<{ event: StoredEvent; projectName: string }> = [];
			for (const project of projects) {
				const eventsDbPath = join(project.root, ".overstory", "events.db");
				if (!(await Bun.file(eventsDbPath).exists())) continue;
				const store = createEventStore(eventsDbPath);
				try {
					let events: StoredEvent[];
					if (runId) {
						events = store.getByRun(runId, queryOpts);
					} else if (agentNames.length > 0) {
						const merged: StoredEvent[] = [];
						for (const name of agentNames) {
							merged.push(...store.getByAgent(name, { since: queryOpts.since }));
						}
						merged.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
						events = merged.slice(0, queryOpts.limit);
					} else {
						events = store.getTimeline(queryOpts);
					}
					for (const event of events) {
						allTagged.push({ event, projectName: project.name });
					}
				} finally {
					store.close();
				}
			}
			// Sort merged results chronologically
			allTagged.sort((a, b) => a.event.createdAt.localeCompare(b.event.createdAt));
			return allTagged.slice(0, queryOpts.limit);
		};

		if (!follow) {
			const tagged = await queryAllProjects({ since, limit });

			if (json) {
				process.stdout.write(`${JSON.stringify(tagged.map((t) => ({ ...t.event, projectName: t.projectName })))}\n`);
				return;
			}

			if (tagged.length === 0) {
				process.stdout.write("No events found.\n");
				return;
			}

			const colorMap = buildAgentColorMap(tagged.map((t) => t.event));
			for (const { event, projectName } of tagged) {
				printEvent(event, colorMap, projectName);
			}
			return;
		}

		// Follow mode: continuous polling (workspace aggregate)
		// Use timestamps for deduplication since IDs are per-database and not comparable across projects
		let lastSeenAt = since;
		const initialTagged = await queryAllProjects({ since, limit });

		const globalColorMap = buildAgentColorMap(initialTagged.map((t) => t.event));
		if (!json) {
			for (const { event, projectName } of initialTagged) {
				printEvent(event, globalColorMap, projectName);
			}
		} else {
			for (const { event, projectName } of initialTagged) {
				process.stdout.write(`${JSON.stringify({ ...event, projectName })}\n`);
			}
		}
		if (initialTagged.length > 0) {
			const last = initialTagged[initialTagged.length - 1];
			if (last) lastSeenAt = last.event.createdAt;
		}

		while (true) {
			await Bun.sleep(interval);
			const pollSince = new Date(Date.now() - 60 * 1000).toISOString();
			const recentTagged = await queryAllProjects({ since: pollSince, limit: 1000 });
			const newTagged = recentTagged.filter((t) => t.event.createdAt > lastSeenAt);
			if (newTagged.length > 0) {
				if (!json) {
					for (const { event, projectName } of newTagged) {
						if (!globalColorMap.has(event.agentName)) {
							const colorIndex = globalColorMap.size % AGENT_COLORS.length;
							const agentColorFn = AGENT_COLORS[colorIndex];
							if (agentColorFn !== undefined) {
								globalColorMap.set(event.agentName, agentColorFn);
							}
						}
					}
					for (const { event, projectName } of newTagged) {
						printEvent(event, globalColorMap, projectName);
					}
				} else {
					for (const { event, projectName } of newTagged) {
						process.stdout.write(`${JSON.stringify({ ...event, projectName })}\n`);
					}
				}
				const last = newTagged[newTagged.length - 1];
				if (last) lastSeenAt = last.event.createdAt;
			}
		}
	}

	// Single-project mode (single-repo or workspace with --project)
	const eventsDbPath = join(ctx.overstoryDir, "events.db");
	const eventsFile = Bun.file(eventsDbPath);
	if (!(await eventsFile.exists())) {
		if (json) {
			jsonOutput("feed", { events: [] });
		} else {
			process.stdout.write("No events data yet.\n");
		}
		return;
	}

	const eventStore = createEventStore(eventsDbPath);

	try {
		// Default since: 5 minutes ago
		const since = sinceStr ?? new Date(Date.now() - 5 * 60 * 1000).toISOString();

		// Helper to query events based on filters
		const queryEvents = (queryOpts: { since: string; limit: number }): StoredEvent[] => {
			if (runId) {
				return eventStore.getByRun(runId, queryOpts);
			}
			if (agentNames.length > 0) {
				const allEvents: StoredEvent[] = [];
				for (const name of agentNames) {
					const agentEvents = eventStore.getByAgent(name, {
						since: queryOpts.since,
					});
					allEvents.push(...agentEvents);
				}
				// Sort by createdAt chronologically
				allEvents.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
				// Apply limit after merge
				return allEvents.slice(0, queryOpts.limit);
			}
			return eventStore.getTimeline(queryOpts);
		};

		if (!follow) {
			// Non-follow mode: single snapshot
			const events = queryEvents({ since, limit });

			if (json) {
				jsonOutput("feed", { events });
				return;
			}

			if (events.length === 0) {
				process.stdout.write("No events found.\n");
				return;
			}

			const colorMap = buildAgentColorMap(events);
			for (const event of events) {
				printEvent(event, colorMap);
			}
			return;
		}

		// Follow mode: continuous polling
		// Print initial events
		let lastSeenId = 0;
		const initialEvents = queryEvents({ since, limit });

		if (!json) {
			const colorMap = buildAgentColorMap(initialEvents);
			for (const event of initialEvents) {
				printEvent(event, colorMap);
			}
			if (initialEvents.length > 0) {
				const lastEvent = initialEvents[initialEvents.length - 1];
				if (lastEvent) {
					lastSeenId = lastEvent.id;
				}
			}
		} else {
			// JSON mode: print each event as a line
			for (const event of initialEvents) {
				jsonOutput("feed", { event });
			}
			if (initialEvents.length > 0) {
				const lastEvent = initialEvents[initialEvents.length - 1];
				if (lastEvent) {
					lastSeenId = lastEvent.id;
				}
			}
		}

		// Maintain a color map across polling iterations (for non-JSON mode)
		const globalColorMap = buildAgentColorMap(initialEvents);

		// Poll for new events
		while (true) {
			await Bun.sleep(interval);

			// Query events from 60s ago, then filter client-side for id > lastSeenId
			const pollSince = new Date(Date.now() - 60 * 1000).toISOString();
			const recentEvents = queryEvents({ since: pollSince, limit: 1000 });

			// Filter to new events only
			const newEvents = recentEvents.filter((e) => e.id > lastSeenId);

			if (newEvents.length > 0) {
				if (!json) {
					// Update color map for any new agents
					extendAgentColorMap(globalColorMap, newEvents);

					// Print new events
					for (const event of newEvents) {
						printEvent(event, globalColorMap);
					}
				} else {
					// JSON mode: print each event as a line
					for (const event of newEvents) {
						jsonOutput("feed", { event });
					}
				}

				// Update lastSeenId
				const lastNew = newEvents[newEvents.length - 1];
				if (lastNew) {
					lastSeenId = lastNew.id;
				}
			}
		}
	} finally {
		eventStore.close();
	}
}

export function createFeedCommand(): Command {
	return new Command("feed")
		.description("Unified real-time event stream across all agents")
		.option("-f, --follow", "Continuously poll for new events (like tail -f)")
		.option("--interval <ms>", "Polling interval for --follow (default: 1000, min: 200)")
		.option(
			"--agent <name>",
			"Filter by agent name (can appear multiple times)",
			(val: string, prev: string[]) => [...prev, val],
			[] as string[],
		)
		.option("--run <id>", "Filter events by run ID")
		.option("--since <timestamp>", "Start time (ISO 8601, default: 5 minutes ago)")
		.option("--limit <n>", "Max initial events to show (default: 50)")
		.option("--json", "Output events as JSON (one per line in follow mode)")
		.action(async (opts: FeedOpts, cmd: Command) => {
			const globalOpts = cmd.optsWithGlobals();
			await executeFeed({ ...opts, project: globalOpts.project as string | undefined });
		});
}

export async function feedCommand(args: string[]): Promise<void> {
	const cmd = createFeedCommand();
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

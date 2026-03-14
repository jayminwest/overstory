/**
 * CLI command: ov feed [--follow] [--agent <name>...] [--run <id>]
 *              [--since <ts>] [--limit <n>] [--interval <ms>] [--json]
 *
 * Unified real-time event stream across all agents — like `tail -f` for the fleet.
 * Shows chronological events from all agents merged into a single feed.
 */

import { join } from "node:path";
import { Command } from "commander";
import { loadConfig } from "../config.ts";
import { ValidationError } from "../errors.ts";
import { createEventStore } from "../events/store.ts";
import { jsonOutput } from "../json.ts";
import type { ColorFn } from "../logging/color.ts";
import { buildAgentColorMap, extendAgentColorMap, formatEventLine } from "../logging/format.ts";
import type { StoredEvent } from "../types.ts";

/**
 * Print a single event in compact feed format:
 * HH:MM:SS LABEL agentname    detail
 */
function printEvent(event: StoredEvent, colorMap: Map<string, ColorFn>): void {
	process.stdout.write(`${formatEventLine(event, colorMap)}\n`);
}

/**
 * Process one poll tick of the feed follow loop: query recent events,
 * filter to those newer than lastSeenId, print them, and return the
 * updated lastSeenId.
 * @internal Exported for testing.
 */
export function pollFeedTick(
	lastSeenId: number,
	queryFn: (opts: { since: string; limit: number }) => StoredEvent[],
	colorMap: Map<string, ColorFn>,
	json: boolean,
): number {
	// Query events from 60s ago, then filter client-side for id > lastSeenId
	const pollSince = new Date(Date.now() - 60 * 1000).toISOString();
	const recentEvents = queryFn({ since: pollSince, limit: 1000 });

	// Filter to new events only
	const newEvents = recentEvents.filter((e) => e.id > lastSeenId);

	if (newEvents.length > 0) {
		if (!json) {
			// Update color map for any new agents
			extendAgentColorMap(colorMap, newEvents);

			// Print new events
			for (const event of newEvents) {
				printEvent(event, colorMap);
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
			return lastNew.id;
		}
	}

	return lastSeenId;
}

interface FeedOpts {
	follow?: boolean;
	interval?: string;
	agent: string[]; // repeatable
	run?: string;
	since?: string;
	limit?: string;
	json?: boolean;
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

	const cwd = process.cwd();
	const config = await loadConfig(cwd);
	const overstoryDir = join(config.project.root, ".overstory");

	// Open event store
	const eventsDbPath = join(overstoryDir, "events.db");
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
			lastSeenId = pollFeedTick(lastSeenId, queryEvents, globalColorMap, json);
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
		.action(async (opts: FeedOpts) => {
			await executeFeed(opts);
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

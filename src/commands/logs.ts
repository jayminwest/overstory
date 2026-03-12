/**
 * CLI command: ov logs [--agent <name>] [--level <level>] [--since <time>] [--until <time>] [--limit <n>] [--follow] [--json]
 *
 * Queries NDJSON log files from .overstory/logs/{agent-name}/{session-timestamp}/events.ndjson
 * and presents a unified timeline view.
 *
 * Unlike trace/errors/replay which query events.db (SQLite), this command reads raw NDJSON files
 * on disk — the source of truth written by each agent logger.
 */

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { Command } from "commander";
import { loadConfig } from "../config.ts";
import { ValidationError } from "../errors.ts";
import { jsonOutput } from "../json.ts";
import { color } from "../logging/color.ts";
import { formatAbsoluteTime, formatDate, logLevelColor, logLevelLabel } from "../logging/format.ts";
import { renderHeader } from "../logging/theme.ts";
import type { LogEvent } from "../types.ts";
import { parseRelativeTime } from "../utils/time.ts";

/**
 * Build a detail string for a log event based on its data.
 * @internal Exported for testing.
 */
export function buildLogDetail(event: LogEvent): string {
	const parts: string[] = [];

	for (const [key, value] of Object.entries(event.data)) {
		if (value !== null && value !== undefined) {
			const strValue = typeof value === "string" ? value : JSON.stringify(value);
			// Truncate long values
			const truncated = strValue.length > 80 ? `${strValue.slice(0, 77)}...` : strValue;
			parts.push(`${key}=${truncated}`);
		}
	}

	return parts.join(" ");
}

/**
 * Discover all events.ndjson files in the logs directory.
 * Returns array of { agentName, sessionTimestamp, path }.
 * @internal Exported for testing.
 */
export async function discoverLogFiles(
	logsDir: string,
	agentFilter?: string,
): Promise<
	Array<{
		agentName: string;
		sessionTimestamp: string;
		path: string;
	}>
> {
	const discovered: Array<{
		agentName: string;
		sessionTimestamp: string;
		path: string;
	}> = [];

	try {
		const agentDirs = await readdir(logsDir);

		for (const agentName of agentDirs) {
			if (agentFilter !== undefined && agentName !== agentFilter) {
				continue;
			}

			const agentDir = join(logsDir, agentName);
			let agentStat: Awaited<ReturnType<typeof stat>>;
			try {
				agentStat = await stat(agentDir);
			} catch {
				continue; // Not a directory or doesn't exist
			}

			if (!agentStat.isDirectory()) {
				continue;
			}

			const sessionDirs = await readdir(agentDir);

			for (const sessionTimestamp of sessionDirs) {
				const eventsPath = join(agentDir, sessionTimestamp, "events.ndjson");
				let eventsStat: Awaited<ReturnType<typeof stat>>;
				try {
					eventsStat = await stat(eventsPath);
				} catch {
					continue; // File doesn't exist
				}

				if (eventsStat.isFile()) {
					discovered.push({
						agentName,
						sessionTimestamp,
						path: eventsPath,
					});
				}
			}
		}
	} catch {
		// Logs directory doesn't exist or can't be read
		return [];
	}

	// Sort by session timestamp (chronological)
	discovered.sort((a, b) => a.sessionTimestamp.localeCompare(b.sessionTimestamp));

	return discovered;
}

/**
 * Parse a single NDJSON file and return log events.
 * Silently skips invalid lines.
 * @internal Exported for testing.
 */
export async function parseLogFile(path: string): Promise<LogEvent[]> {
	const events: LogEvent[] = [];

	try {
		const file = Bun.file(path);
		const text = await file.text();
		const lines = text.split("\n");

		for (const line of lines) {
			if (line.trim() === "") {
				continue;
			}

			try {
				const parsed: unknown = JSON.parse(line);
				// Validate that it has required LogEvent fields
				if (
					typeof parsed === "object" &&
					parsed !== null &&
					"timestamp" in parsed &&
					"event" in parsed
				) {
					events.push(parsed as LogEvent);
				}
			} catch {
				// Invalid JSON line, skip silently
			}
		}
	} catch {
		// File can't be read, return empty array
		return [];
	}

	return events;
}

/**
 * Apply filters to log events.
 * @internal Exported for testing.
 */
export function filterEvents(
	events: LogEvent[],
	filters: {
		level?: string;
		since?: Date;
		until?: Date;
	},
): LogEvent[] {
	return events.filter((event) => {
		if (filters.level !== undefined && event.level !== filters.level) {
			return false;
		}

		const eventTime = new Date(event.timestamp).getTime();

		if (filters.since !== undefined && eventTime < filters.since.getTime()) {
			return false;
		}

		if (filters.until !== undefined && eventTime > filters.until.getTime()) {
			return false;
		}

		return true;
	});
}

/**
 * Print log events with ANSI colors and date separators.
 */
function printLogs(events: LogEvent[]): void {
	const w = process.stdout.write.bind(process.stdout);

	w(`${renderHeader("Logs")}\n`);

	if (events.length === 0) {
		w(`${color.dim("No log files found.")}\n`);
		return;
	}

	w(`${color.dim(`${events.length} ${events.length === 1 ? "entry" : "entries"}`)}\n\n`);

	let lastDate = "";

	for (const event of events) {
		// Print date separator when the date changes
		const date = formatDate(event.timestamp);
		if (date && date !== lastDate) {
			if (lastDate !== "") {
				w("\n");
			}
			w(`${color.dim(`--- ${date} ---`)}\n`);
			lastDate = date;
		}

		const time = formatAbsoluteTime(event.timestamp);
		const levelColorFn = logLevelColor(event.level);
		const levelStr = logLevelLabel(event.level);

		const agentLabel = event.agentName ? `[${event.agentName}]` : "[unknown]";
		const detail = buildLogDetail(event);
		const detailSuffix = detail ? ` ${color.dim(detail)}` : "";

		w(
			`${time} ${levelColorFn(levelStr)} ` +
				`${event.event} ${color.dim(agentLabel)}${detailSuffix}\n`,
		);
	}
}

/**
 * Process one poll tick of log tailing: scan discovered log files for new data
 * since lastKnownSizes, parse new lines, apply filters, and return the count
 * of new events found.
 * @internal Exported for testing.
 *
 * @param logFiles - Array of discovered log file paths
 * @param lastKnownSizes - Map of file path to last-seen byte offset (mutated in place)
 * @param filters - Level filter to apply
 * @returns Number of new events emitted
 */
export async function pollLogTick(
	logFiles: Array<{ path: string }>,
	lastKnownSizes: Map<string, number>,
	filters: { level?: string },
): Promise<number> {
	const w = process.stdout.write.bind(process.stdout);
	let emitted = 0;

	for (const { path } of logFiles) {
		const file = Bun.file(path);
		let fileSize: number;

		try {
			const fileStat = await stat(path);
			fileSize = fileStat.size;
		} catch {
			continue; // File disappeared
		}

		const lastPosition = lastKnownSizes.get(path) ?? 0;

		if (fileSize > lastPosition) {
			// New data available
			try {
				const fullText = await file.text();
				const newText = fullText.slice(lastPosition);
				const lines = newText.split("\n");

				for (const line of lines) {
					if (line.trim() === "") {
						continue;
					}

					try {
						const parsed: unknown = JSON.parse(line);
						if (
							typeof parsed === "object" &&
							parsed !== null &&
							"timestamp" in parsed &&
							"event" in parsed
						) {
							const event = parsed as LogEvent;

							// Apply level filter
							if (filters.level !== undefined && event.level !== filters.level) {
								continue;
							}

							// Print immediately
							const time = formatAbsoluteTime(event.timestamp);
							const levelColorFn = logLevelColor(event.level);
							const levelStr = logLevelLabel(event.level);

							const agentLabel = event.agentName ? `[${event.agentName}]` : "[unknown]";
							const detail = buildLogDetail(event);
							const detailSuffix = detail ? ` ${color.dim(detail)}` : "";

							w(
								`${time} ${levelColorFn(levelStr)} ` +
									`${event.event} ${color.dim(agentLabel)}${detailSuffix}\n`,
							);
							emitted++;
						}
					} catch {
						// Invalid JSON line, skip
					}
				}

				lastKnownSizes.set(path, fileSize);
			} catch {
				// File read error, skip
			}
		}
	}

	return emitted;
}

/**
 * Follow mode: tail logs in real time.
 */
async function followLogs(
	logsDir: string,
	filters: {
		agent?: string;
		level?: string;
	},
): Promise<void> {
	const w = process.stdout.write.bind(process.stdout);

	w(`${color.bold("Following logs (Ctrl+C to stop)")}\n\n`);

	// Track file positions for tailing
	const filePositions = new Map<string, number>();

	while (true) {
		const discovered = await discoverLogFiles(logsDir, filters.agent);
		await pollLogTick(discovered, filePositions, { level: filters.level });

		// Sleep for 1 second before next poll
		await Bun.sleep(1000);
	}
}

interface LogsOpts {
	agent?: string;
	level?: string;
	since?: string;
	until?: string;
	limit?: string;
	follow?: boolean;
	json?: boolean;
}

async function executeLogs(opts: LogsOpts): Promise<void> {
	const json = opts.json ?? false;
	const follow = opts.follow ?? false;
	const agentName = opts.agent;
	const level = opts.level;
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

	// Validate level if provided
	if (level !== undefined && !["debug", "info", "warn", "error"].includes(level)) {
		throw new ValidationError("--level must be one of: debug, info, warn, error", {
			field: "level",
			value: level,
		});
	}

	// Parse time filters
	let since: Date | undefined;
	let until: Date | undefined;

	if (sinceStr !== undefined) {
		since = parseRelativeTime(sinceStr);
		if (Number.isNaN(since.getTime())) {
			throw new ValidationError("--since must be a valid ISO 8601 timestamp or relative time", {
				field: "since",
				value: sinceStr,
			});
		}
	}

	if (untilStr !== undefined) {
		until = new Date(untilStr);
		if (Number.isNaN(until.getTime())) {
			throw new ValidationError("--until must be a valid ISO 8601 timestamp", {
				field: "until",
				value: untilStr,
			});
		}
	}

	const cwd = process.cwd();
	const config = await loadConfig(cwd);
	const logsDir = join(config.project.root, ".overstory", "logs");

	// Follow mode: tail logs in real time
	if (follow) {
		await followLogs(logsDir, { agent: agentName, level });
		return;
	}

	// Discovery phase: find all events.ndjson files
	const discovered = await discoverLogFiles(logsDir, agentName);

	if (discovered.length === 0) {
		if (json) {
			process.stdout.write("[]\n");
		} else {
			process.stdout.write("No log files found.\n");
		}
		return;
	}

	// Parsing phase: read and parse all files
	const allEvents: LogEvent[] = [];

	for (const { path } of discovered) {
		const events = await parseLogFile(path);
		allEvents.push(...events);
	}

	// Apply filters
	const filtered = filterEvents(allEvents, { level, since, until });

	// Sort by timestamp chronologically
	filtered.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

	// Apply limit: take the LAST N entries (most recent)
	const limited = filtered.slice(-limit);

	if (json) {
		jsonOutput("logs", { entries: limited });
		return;
	}

	printLogs(limited);
}

export function createLogsCommand(): Command {
	return new Command("logs")
		.description("Query NDJSON logs across agents")
		.option("--agent <name>", "Filter logs by agent name")
		.option("--level <level>", "Filter by log level: debug, info, warn, error")
		.option("--since <time>", "Start time filter (ISO 8601 or relative: 1h, 30m, 2d, 10s)")
		.option("--until <time>", "End time filter (ISO 8601)")
		.option("--limit <n>", "Max entries to show (default: 100, returns most recent)")
		.option("--follow", "Tail logs in real time (poll every 1s, Ctrl+C to stop)")
		.option("--json", "Output as JSON array of LogEvent objects")
		.action(async (opts: LogsOpts) => {
			await executeLogs(opts);
		});
}

export async function logsCommand(args: string[]): Promise<void> {
	const cmd = createLogsCommand();
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

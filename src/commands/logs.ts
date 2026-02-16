/**
 * CLI command: overstory logs [--agent <name>] [--level <level>] [--since <time>] [--until <time>] [--limit <n>] [--follow] [--json]
 *
 * Queries NDJSON log files from .overstory/logs/{agent-name}/{session-timestamp}/events.ndjson
 * and presents a unified timeline view.
 *
 * Unlike trace/errors/replay which query events.db (SQLite), this command reads raw NDJSON files
 * on disk — the source of truth written by each agent logger.
 */

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "../config.ts";
import { ValidationError } from "../errors.ts";
import { color } from "../logging/color.ts";
import type { LogEvent } from "../types.ts";

/**
 * Parse a named flag value from args.
 */
function getFlag(args: string[], flag: string): string | undefined {
	const idx = args.indexOf(flag);
	if (idx === -1 || idx + 1 >= args.length) {
		return undefined;
	}
	return args[idx + 1];
}

function hasFlag(args: string[], flag: string): boolean {
	return args.includes(flag);
}

/**
 * Parse relative time formats like "1h", "30m", "2d", "10s" into a Date object.
 * Falls back to parsing as ISO 8601 if not in relative format.
 */
function parseRelativeTime(timeStr: string): Date {
	const relativeMatch = /^(\d+)(s|m|h|d)$/.exec(timeStr);
	if (relativeMatch) {
		const value = Number.parseInt(relativeMatch[1] ?? "0", 10);
		const unit = relativeMatch[2];
		const now = Date.now();
		let offsetMs = 0;

		switch (unit) {
			case "s":
				offsetMs = value * 1000;
				break;
			case "m":
				offsetMs = value * 60 * 1000;
				break;
			case "h":
				offsetMs = value * 60 * 60 * 1000;
				break;
			case "d":
				offsetMs = value * 24 * 60 * 60 * 1000;
				break;
		}

		return new Date(now - offsetMs);
	}

	// Not a relative format, treat as ISO 8601
	return new Date(timeStr);
}

/**
 * Format the date portion of an ISO timestamp.
 * Returns "YYYY-MM-DD".
 */
function formatDate(timestamp: string): string {
	const match = /^(\d{4}-\d{2}-\d{2})/.exec(timestamp);
	if (match?.[1]) {
		return match[1];
	}
	return "";
}

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
 * Build a detail string for a log event based on its data.
 */
function buildLogDetail(event: LogEvent): string {
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
 */
async function discoverLogFiles(
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
 */
async function parseLogFile(path: string): Promise<LogEvent[]> {
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
 */
function filterEvents(
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

	w(`${color.bold}Logs${color.reset}\n`);
	w(`${"=".repeat(70)}\n`);

	if (events.length === 0) {
		w(`${color.dim}No log files found.${color.reset}\n`);
		return;
	}

	w(`${color.dim}${events.length} ${events.length === 1 ? "entry" : "entries"}${color.reset}\n\n`);

	let lastDate = "";

	for (const event of events) {
		// Print date separator when the date changes
		const date = formatDate(event.timestamp);
		if (date && date !== lastDate) {
			if (lastDate !== "") {
				w("\n");
			}
			w(`${color.dim}--- ${date} ---${color.reset}\n`);
			lastDate = date;
		}

		const time = formatAbsoluteTime(event.timestamp);

		// Format level display
		let levelStr: string;
		let levelColorCode: string;
		switch (event.level) {
			case "debug":
				levelStr = "DBG";
				levelColorCode = color.gray;
				break;
			case "info":
				levelStr = "INF";
				levelColorCode = color.blue;
				break;
			case "warn":
				levelStr = "WRN";
				levelColorCode = color.yellow;
				break;
			case "error":
				levelStr = "ERR";
				levelColorCode = color.red;
				break;
			default:
				levelStr = String(event.level).slice(0, 3).toUpperCase();
				levelColorCode = color.gray;
		}

		const agentLabel = event.agentName ? `[${event.agentName}]` : "[unknown]";
		const detail = buildLogDetail(event);
		const detailSuffix = detail ? ` ${color.dim}${detail}${color.reset}` : "";

		w(
			`${time} ${levelColorCode}${levelStr}${color.reset} ` +
				`${event.event} ${color.dim}${agentLabel}${color.reset}${detailSuffix}\n`,
		);
	}
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

	w(`${color.bold}Following logs (Ctrl+C to stop)${color.reset}\n\n`);

	// Track file positions for tailing
	const filePositions = new Map<string, number>();

	while (true) {
		const discovered = await discoverLogFiles(logsDir, filters.agent);

		for (const { path } of discovered) {
			const file = Bun.file(path);
			let fileSize: number;

			try {
				const fileStat = await stat(path);
				fileSize = fileStat.size;
			} catch {
				continue; // File disappeared
			}

			const lastPosition = filePositions.get(path) ?? 0;

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

								let levelStr: string;
								let levelColorCode: string;
								switch (event.level) {
									case "debug":
										levelStr = "DBG";
										levelColorCode = color.gray;
										break;
									case "info":
										levelStr = "INF";
										levelColorCode = color.blue;
										break;
									case "warn":
										levelStr = "WRN";
										levelColorCode = color.yellow;
										break;
									case "error":
										levelStr = "ERR";
										levelColorCode = color.red;
										break;
									default:
										levelStr = String(event.level).slice(0, 3).toUpperCase();
										levelColorCode = color.gray;
								}

								const agentLabel = event.agentName ? `[${event.agentName}]` : "[unknown]";
								const detail = buildLogDetail(event);
								const detailSuffix = detail ? ` ${color.dim}${detail}${color.reset}` : "";

								w(
									`${time} ${levelColorCode}${levelStr}${color.reset} ` +
										`${event.event} ${color.dim}${agentLabel}${color.reset}${detailSuffix}\n`,
								);
							}
						} catch {
							// Invalid JSON line, skip
						}
					}

					filePositions.set(path, fileSize);
				} catch {
					// File read error, skip
				}
			}
		}

		// Sleep for 1 second before next poll
		await Bun.sleep(1000);
	}
}

const LOGS_HELP = `overstory logs -- Query NDJSON log files from .overstory/logs

Usage: overstory logs [options]

Options:
  --agent <name>         Filter logs by agent name
  --level <level>        Filter by log level: debug, info, warn, error
  --since <time>         Start time filter (ISO 8601 or relative: 1h, 30m, 2d, 10s)
  --until <time>         End time filter (ISO 8601)
  --limit <n>            Max entries to show (default: 100, returns most recent)
  --follow               Tail logs in real time (poll every 1s, Ctrl+C to stop)
  --json                 Output as JSON array of LogEvent objects
  --help, -h             Show this help`;

/**
 * Entry point for `overstory logs` command.
 */
export async function logsCommand(args: string[]): Promise<void> {
	if (args.includes("--help") || args.includes("-h")) {
		process.stdout.write(`${LOGS_HELP}\n`);
		return;
	}

	const json = hasFlag(args, "--json");
	const follow = hasFlag(args, "--follow");
	const agentName = getFlag(args, "--agent");
	const level = getFlag(args, "--level");
	const sinceStr = getFlag(args, "--since");
	const untilStr = getFlag(args, "--until");
	const limitStr = getFlag(args, "--limit");
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
		process.stdout.write(`${JSON.stringify(limited)}\n`);
		return;
	}

	printLogs(limited);
}

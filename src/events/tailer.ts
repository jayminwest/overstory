/**
 * Background NDJSON event tailer for headless agent stdout logs.
 *
 * Headless agents (e.g. Sapling) write NDJSON events to a stdout.log file
 * in .overstory/logs/{agentName}/{timestamp}/stdout.log. After ov sling exits,
 * nobody reads this stream — so ov status, ov dashboard, and ov feed cannot
 * show live progress for headless agents.
 *
 * This module provides startEventTailer(), which polls the log file on a
 * configurable interval, parses new NDJSON lines, and writes them into events.db
 * via EventStore. The watchdog daemon starts a tailer for each headless agent
 * session and stops it when the session completes or terminates.
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { createSessionStore, type SessionStore } from "../sessions/store.ts";
import type { EventStore, EventType } from "../types.ts";
import { createEventStore } from "./store.ts";

/**
 * Handle to a running event tailer.
 * Call stop() to halt polling and close the database connection.
 */
export interface TailerHandle {
	/** Agent name being tailed. */
	readonly agentName: string;
	/** Absolute path to the stdout.log file being tailed. */
	readonly logPath: string;
	/** Stop polling and release all resources. */
	stop(): void;
}

/** Map NDJSON event type strings to EventStore EventType. */
function mapEventType(type: string): EventType {
	switch (type) {
		case "tool_start":
			return "tool_start";
		case "tool_end":
			return "tool_end";
		case "session_start":
			return "session_start";
		case "session_end":
			return "session_end";
		case "turn_start":
			return "turn_start";
		case "turn_end":
			return "turn_end";
		case "progress":
			return "progress";
		case "result":
			return "result";
		case "error":
			return "error";
		default:
			return "custom";
	}
}

/** Options for startEventTailer. */
export interface TailerOptions {
	/** Absolute path to the stdout.log file to tail. */
	stdoutLogPath: string;
	/** Agent name for event attribution in events.db. */
	agentName: string;
	/** Run ID to associate events with, or null. */
	runId: string | null;
	/** Absolute path to events.db. The tailer opens its own connection. */
	eventsDbPath: string;
	/**
	 * Absolute path to sessions.db. When present and not equal to ":memory:",
	 * the tailer opens a dedicated SessionStore to persist the runtime-provided
	 * session_id (e.g. Claude stream-json `session_id`). Omit (or set to
	 * ":memory:") for tailers that should not write to SessionStore.
	 */
	sessionsDbPath?: string;
	/** Poll interval in milliseconds (default: 500). */
	pollIntervalMs?: number;
	/** DI: injected EventStore for testing (overrides eventsDbPath). */
	_eventStore?: EventStore;
	/** DI: injected SessionStore for testing (overrides sessionsDbPath). */
	_sessionStore?: SessionStore;
	/**
	 * DI: invoked exactly once per tailer when an observed session_id differs
	 * from the prior claudeSessionId stored in SessionStore. Receives the agent
	 * name, the prior (requested) id, and the newly observed id. Production
	 * code logs a warning to stderr instead.
	 */
	_onResumeMismatch?: (agentName: string, requested: string, observed: string) => void;
}

/**
 * Start a background event tailer for a headless agent's stdout.log.
 *
 * Polls the log file on a configurable interval, reads new bytes since the
 * last poll using file.size as a byte cursor, parses NDJSON lines, and writes
 * normalized events to events.db. Maintains its own SQLite connection so it
 * can outlive the daemon tick that created it.
 *
 * All errors (file not found, parse failures, DB write failures) are swallowed
 * silently — the tailer must never crash the watchdog daemon.
 *
 * @param opts - Tailer configuration (log path, agent, run, db path)
 * @returns TailerHandle with stop() to halt polling and close resources
 */
export function startEventTailer(opts: TailerOptions): TailerHandle {
	const { stdoutLogPath, agentName, runId, eventsDbPath, pollIntervalMs = 500 } = opts;

	// Open a dedicated EventStore for this tailer's lifetime (not tick-scoped).
	// Injected _eventStore is used for testing without an actual DB file.
	let eventStore: EventStore | null = opts._eventStore ?? null;
	let ownedEventStore = false;
	if (!eventStore) {
		try {
			eventStore = createEventStore(eventsDbPath);
			ownedEventStore = true;
		} catch {
			// EventStore creation failed — return a no-op handle immediately.
			// Scheduling a poll loop that silently discards every event would
			// burn CPU and file descriptors for zero benefit.
			return {
				agentName,
				logPath: stdoutLogPath,
				stop() {},
			};
		}
	}

	// Open a dedicated SessionStore for this tailer's lifetime when a real
	// sessionsDbPath is provided. Tailers that omit sessionsDbPath (or pass
	// ":memory:") skip session_id persistence entirely — backward compat for
	// callers that don't yet route through the watchdog wiring.
	let sessionStore: SessionStore | null = opts._sessionStore ?? null;
	let ownedSessionStore = false;
	if (!sessionStore && opts.sessionsDbPath && opts.sessionsDbPath !== ":memory:") {
		try {
			sessionStore = createSessionStore(opts.sessionsDbPath);
			ownedSessionStore = true;
		} catch {
			// SessionStore failure is non-fatal — events still flow.
			sessionStore = null;
		}
	}

	// Single-fire guard for session_id pinning. Mirrors claude.ts:312
	// `sessionIdPinned` so that updateClaudeSessionId is called at most once
	// per tailer lifetime, even if many system events stream by.
	let sessionIdPinned = false;
	const onResumeMismatch = opts._onResumeMismatch;

	let stopped = false;
	let byteOffset = 0;
	let timer: ReturnType<typeof setTimeout> | null = null;

	const poll = async (): Promise<void> => {
		if (stopped) return;

		try {
			const file = Bun.file(stdoutLogPath);
			const size = file.size;

			if (size > byteOffset) {
				// Read only new bytes since last poll — avoids re-processing old lines.
				const newContent = await file.slice(byteOffset, size).text();
				byteOffset = size;

				const lines = newContent.split("\n");
				for (const line of lines) {
					const trimmed = line.trim();
					if (!trimmed) continue;

					let event: Record<string, unknown>;
					try {
						event = JSON.parse(trimmed) as Record<string, unknown>;
					} catch {
						// Skip malformed lines — partial writes or debug output.
						continue;
					}

					const type = typeof event.type === "string" ? event.type : "custom";
					const eventType = mapEventType(type);
					const level = type === "error" ? "error" : "info";

					// Extract tool name from various field names runtimes may use.
					let toolName: string | null = null;
					if (typeof event.tool === "string") {
						toolName = event.tool;
					} else if (typeof event.tool_name === "string") {
						toolName = event.tool_name;
					} else if (typeof event.toolName === "string") {
						toolName = event.toolName;
					}

					const toolDurationMs = typeof event.duration_ms === "number" ? event.duration_ms : null;

					// Extract session_id from stream-json system events (e.g. Claude Code
					// emits `{type:"system", subtype:"init", session_id:"sess-..."}` on
					// every spawn — including --resume spawns, which assign a fresh id).
					// The "result" event also carries session_id; treat both as authoritative.
					// Single-fire per tailer lifetime so we don't churn writes.
					if (!sessionIdPinned && sessionStore !== null) {
						const sid =
							typeof event.session_id === "string" && event.session_id.length > 0
								? event.session_id
								: null;
						if (sid !== null && (type === "system" || type === "result")) {
							sessionIdPinned = true;
							let prior: string | null = null;
							try {
								prior = sessionStore.getByName(agentName)?.claudeSessionId ?? null;
							} catch {
								prior = null;
							}
							try {
								sessionStore.updateClaudeSessionId(agentName, sid);
							} catch {
								// Non-fatal: SessionStore write failure must not break tailing.
							}
							// Resume mismatch: requested != observed. The observed id wins
							// (claude assigns fresh ids on --resume), but operators need to
							// know — log a warning, and call DI hook for tests.
							if (prior !== null && prior !== sid) {
								if (onResumeMismatch) {
									try {
										onResumeMismatch(agentName, prior, sid);
									} catch {
										// DI hook errors must not crash the tailer.
									}
								} else {
									process.stderr.write(
										`[tailer] resume mismatch for ${agentName}: requested=${prior} observed=${sid}\n`,
									);
								}
							}
						}
					}

					try {
						eventStore?.insert({
							runId,
							agentName,
							sessionId: null,
							eventType,
							toolName,
							toolArgs: null,
							toolDurationMs,
							level,
							data: JSON.stringify(event),
						});
					} catch {
						// DB write failure is non-fatal.
					}
				}
			}
		} catch {
			// File read failure is non-fatal — agent may not have started writing yet.
		}

		if (!stopped) {
			timer = setTimeout(poll, pollIntervalMs);
		}
	};

	// Schedule first poll.
	timer = setTimeout(poll, pollIntervalMs);

	return {
		agentName,
		logPath: stdoutLogPath,
		stop() {
			stopped = true;
			if (timer !== null) {
				clearTimeout(timer);
				timer = null;
			}
			// Close only the EventStore this tailer owns (not the injected one).
			if (ownedEventStore && eventStore) {
				try {
					eventStore.close();
				} catch {
					// Non-fatal.
				}
				eventStore = null;
			}
			// Close only the SessionStore this tailer owns.
			if (ownedSessionStore && sessionStore) {
				try {
					sessionStore.close();
				} catch {
					// Non-fatal.
				}
				sessionStore = null;
			}
		},
	};
}

/**
 * Discover the most recent stdout.log path for a headless agent.
 *
 * Scans .overstory/logs/{agentName}/ for timestamped session directories and
 * returns the stdout.log path from the lexicographically last directory.
 * Directories use ISO timestamps with `-` replacing `.` and `:`, which sort
 * correctly in lexicographic order (e.g. 2026-03-05T14-52-26-089Z).
 *
 * Returns null if no log directory exists or no stdout.log is found.
 *
 * @param overstoryDir - Absolute path to .overstory/
 * @param agentName - Agent name to look up (matches .overstory/logs/{agentName}/)
 */
export async function findLatestStdoutLog(
	overstoryDir: string,
	agentName: string,
): Promise<string | null> {
	const agentLogsDir = join(overstoryDir, "logs", agentName);
	try {
		const entries = await readdir(agentLogsDir);
		if (entries.length === 0) return null;

		// Lexicographic sort: ISO timestamps sort correctly without parsing.
		const sorted = entries.sort();
		const latest = sorted[sorted.length - 1];
		if (!latest) return null;

		const logPath = join(agentLogsDir, latest, "stdout.log");
		const file = Bun.file(logPath);
		if (await file.exists()) return logPath;
		return null;
	} catch {
		return null;
	}
}

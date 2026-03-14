/**
 * Tests for `overstory feed` command.
 *
 * Uses real bun:sqlite (temp files) to test the feed command end-to-end.
 * Captures process.stdout.write to verify output formatting.
 *
 * Real implementations used for: filesystem (temp dirs), SQLite (EventStore).
 * No mocks needed -- all dependencies are cheap and local.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ValidationError } from "../errors.ts";
import { createEventStore } from "../events/store.ts";
import type { ColorFn } from "../logging/color.ts";
import { cleanupTempDir } from "../test-helpers.ts";
import type { InsertEvent, StoredEvent } from "../types.ts";
import { feedCommand, pollFeedTick } from "./feed.ts";

/** Helper to create an InsertEvent with sensible defaults. */
function makeEvent(overrides: Partial<InsertEvent> = {}): InsertEvent {
	return {
		runId: "run-001",
		agentName: "builder-1",
		sessionId: "sess-abc",
		eventType: "tool_start",
		toolName: "Read",
		toolArgs: '{"file": "src/index.ts"}',
		toolDurationMs: null,
		level: "info",
		data: null,
		...overrides,
	};
}

describe("feedCommand", () => {
	let chunks: string[];
	let originalWrite: typeof process.stdout.write;
	let tempDir: string;
	let originalCwd: string;

	beforeEach(async () => {
		// Spy on stdout
		chunks = [];
		originalWrite = process.stdout.write;
		process.stdout.write = ((chunk: string) => {
			chunks.push(chunk);
			return true;
		}) as typeof process.stdout.write;

		// Create temp dir with .overstory/config.yaml structure
		tempDir = await mkdtemp(join(tmpdir(), "feed-test-"));
		const overstoryDir = join(tempDir, ".overstory");
		await Bun.write(
			join(overstoryDir, "config.yaml"),
			`project:\n  name: test\n  root: ${tempDir}\n  canonicalBranch: main\n`,
		);

		// Change to temp dir so loadConfig() works
		originalCwd = process.cwd();
		process.chdir(tempDir);
	});

	afterEach(async () => {
		process.stdout.write = originalWrite;
		process.chdir(originalCwd);
		await cleanupTempDir(tempDir);
	});

	function output(): string {
		return chunks.join("");
	}

	// === Help flag ===

	describe("help flag", () => {
		test("--help shows help text", async () => {
			await feedCommand(["--help"]);
			const out = output();

			expect(out).toContain("feed");
			expect(out).toContain("--follow");
			expect(out).toContain("--agent");
			expect(out).toContain("--run");
			expect(out).toContain("--since");
			expect(out).toContain("--limit");
			expect(out).toContain("--interval");
			expect(out).toContain("--json");
		});

		test("-h shows help text", async () => {
			await feedCommand(["-h"]);
			const out = output();

			expect(out).toContain("feed");
		});
	});

	// === Argument parsing ===

	describe("argument parsing", () => {
		test("--limit with non-numeric value throws ValidationError", async () => {
			await expect(feedCommand(["--limit", "abc"])).rejects.toThrow(ValidationError);
		});

		test("--limit with zero throws ValidationError", async () => {
			await expect(feedCommand(["--limit", "0"])).rejects.toThrow(ValidationError);
		});

		test("--limit with negative value throws ValidationError", async () => {
			await expect(feedCommand(["--limit", "-5"])).rejects.toThrow(ValidationError);
		});

		test("--interval with non-numeric value throws ValidationError", async () => {
			await expect(feedCommand(["--interval", "abc"])).rejects.toThrow(ValidationError);
		});

		test("--interval below 200 throws ValidationError", async () => {
			await expect(feedCommand(["--interval", "100"])).rejects.toThrow(ValidationError);
		});

		test("--since with invalid timestamp throws ValidationError", async () => {
			await expect(feedCommand(["--since", "not-a-date"])).rejects.toThrow(ValidationError);
		});
	});

	// === Missing events.db (graceful handling) ===

	describe("missing events.db", () => {
		test("text mode outputs friendly message when no events.db exists", async () => {
			await feedCommand([]);
			const out = output();

			expect(out).toBe("No events data yet.\n");
		});

		test("JSON mode outputs empty array when no events.db exists", async () => {
			await feedCommand(["--json"]);
			const out = output();

			const parsed = JSON.parse(out.trim()) as {
				success: boolean;
				command: string;
				events: unknown[];
			};
			expect(parsed.success).toBe(true);
			expect(parsed.command).toBe("feed");
			expect(parsed.events).toEqual([]);
		});
	});

	// === JSON output mode ===

	describe("JSON output mode", () => {
		test("outputs valid JSON array with events", async () => {
			const dbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(dbPath);
			store.insert(makeEvent({ agentName: "builder-1", eventType: "session_start" }));
			store.insert(makeEvent({ agentName: "builder-2", eventType: "tool_start" }));
			store.insert(makeEvent({ agentName: "builder-1", eventType: "session_end" }));
			store.close();

			await feedCommand(["--json"]);
			const out = output();

			const parsed = JSON.parse(out.trim()) as { events: unknown[] };
			expect(parsed.events).toHaveLength(3);
			expect(Array.isArray(parsed.events)).toBe(true);
		});

		test("JSON output includes expected fields", async () => {
			const dbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(dbPath);
			store.insert(
				makeEvent({
					agentName: "builder-1",
					eventType: "tool_start",
					toolName: "Bash",
					level: "info",
				}),
			);
			store.close();

			await feedCommand(["--json"]);
			const out = output();

			const parsed = JSON.parse(out.trim()) as { events: Record<string, unknown>[] };
			expect(parsed.events).toHaveLength(1);
			const event = parsed.events[0];
			expect(event).toBeDefined();
			expect(event?.agentName).toBe("builder-1");
			expect(event?.eventType).toBe("tool_start");
			expect(event?.toolName).toBe("Bash");
			expect(event?.level).toBe("info");
			expect(event?.createdAt).toBeTruthy();
		});

		test("JSON output returns empty array when no events match since filter", async () => {
			const dbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(dbPath);
			store.insert(makeEvent({ agentName: "builder-1" }));
			store.close();

			// Query from future date
			await feedCommand(["--json", "--since", "2099-01-01T00:00:00Z"]);
			const out = output();

			const parsed = JSON.parse(out.trim()) as { events: unknown[] };
			expect(parsed.events).toEqual([]);
		});
	});

	// === Feed output format ===

	describe("feed output", () => {
		test("shows events from multiple agents", async () => {
			const dbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(dbPath);
			store.insert(makeEvent({ agentName: "builder-1" }));
			store.insert(makeEvent({ agentName: "scout-1" }));
			store.insert(makeEvent({ agentName: "builder-2" }));
			store.close();

			await feedCommand([]);
			const out = output();

			expect(out).toContain("builder-1");
			expect(out).toContain("scout-1");
			expect(out).toContain("builder-2");
		});

		test("compact event labels are shown", async () => {
			const dbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(dbPath);
			store.insert(makeEvent({ agentName: "builder-1", eventType: "session_start" }));
			store.insert(makeEvent({ agentName: "builder-1", eventType: "tool_start" }));
			store.insert(makeEvent({ agentName: "builder-1", eventType: "mail_sent" }));
			store.insert(makeEvent({ agentName: "builder-1", eventType: "error", level: "error" }));
			store.close();

			await feedCommand([]);
			const out = output();

			expect(out).toContain("SESS+");
			expect(out).toContain("TOOL+");
			expect(out).toContain("MAIL>");
			expect(out).toContain("ERROR");
		});

		test("tool name is shown in detail", async () => {
			const dbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(dbPath);
			store.insert(
				makeEvent({
					agentName: "builder-1",
					eventType: "tool_start",
					toolName: "Bash",
				}),
			);
			store.close();

			await feedCommand([]);
			const out = output();

			expect(out).toContain("tool=Bash");
		});

		test("tool duration is shown in detail", async () => {
			const dbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(dbPath);
			store.insert(
				makeEvent({
					agentName: "builder-1",
					eventType: "tool_start",
					toolName: "Read",
					toolDurationMs: 42,
				}),
			);
			store.close();

			await feedCommand([]);
			const out = output();

			expect(out).toContain("42ms");
		});

		test("absolute time format is shown (HH:MM:SS)", async () => {
			const dbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(dbPath);
			store.insert(makeEvent({ agentName: "builder-1" }));
			store.close();

			await feedCommand([]);
			const out = output();

			// Should show HH:MM:SS format
			expect(out).toMatch(/\d{2}:\d{2}:\d{2}/);
		});

		test("no events shows 'No events found' message", async () => {
			const dbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(dbPath);
			// Create DB but no events
			store.close();

			await feedCommand([]);
			const out = output();

			expect(out).toContain("No events found");
		});
	});

	// === --agent filter ===

	describe("--agent filter", () => {
		test("filters to single agent", async () => {
			const dbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(dbPath);
			store.insert(makeEvent({ agentName: "builder-1" }));
			store.insert(makeEvent({ agentName: "scout-1" }));
			store.insert(makeEvent({ agentName: "builder-2" }));
			store.close();

			await feedCommand(["--agent", "builder-1", "--json"]);
			const out = output();

			const parsed = JSON.parse(out.trim()) as { events: Record<string, unknown>[] };
			expect(parsed.events).toHaveLength(1);
			expect(parsed.events[0]?.agentName).toBe("builder-1");
		});

		test("filters to multiple agents", async () => {
			const dbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(dbPath);
			store.insert(makeEvent({ agentName: "builder-1" }));
			store.insert(makeEvent({ agentName: "scout-1" }));
			store.insert(makeEvent({ agentName: "builder-2" }));
			store.close();

			await feedCommand(["--agent", "builder-1", "--agent", "scout-1", "--json"]);
			const out = output();

			const parsed = JSON.parse(out.trim()) as { events: Record<string, unknown>[] };
			expect(parsed.events).toHaveLength(2);
			const agents = parsed.events.map((e) => e.agentName);
			expect(agents).toContain("builder-1");
			expect(agents).toContain("scout-1");
			expect(agents).not.toContain("builder-2");
		});
	});

	// === --run filter ===

	describe("--run filter", () => {
		test("filters events by run ID", async () => {
			const dbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(dbPath);
			store.insert(makeEvent({ runId: "run-001", agentName: "builder-1" }));
			store.insert(makeEvent({ runId: "run-002", agentName: "builder-2" }));
			store.insert(makeEvent({ runId: "run-001", agentName: "scout-1" }));
			store.close();

			await feedCommand(["--run", "run-001", "--json"]);
			const out = output();

			const parsed = JSON.parse(out.trim()) as { events: Record<string, unknown>[] };
			expect(parsed.events).toHaveLength(2);
			for (const event of parsed.events) {
				expect(event.runId).toBe("run-001");
			}
		});
	});

	// === --limit flag ===

	describe("--limit flag", () => {
		test("limits the number of events returned", async () => {
			const dbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(dbPath);
			for (let i = 0; i < 100; i++) {
				store.insert(makeEvent({ agentName: "builder-1" }));
			}
			store.close();

			await feedCommand(["--json", "--limit", "10"]);
			const out = output();

			const parsed = JSON.parse(out.trim()) as { events: unknown[] };
			expect(parsed.events).toHaveLength(10);
		});

		test("default limit is 50", async () => {
			const dbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(dbPath);
			for (let i = 0; i < 100; i++) {
				store.insert(makeEvent({ agentName: "builder-1" }));
			}
			store.close();

			await feedCommand(["--json"]);
			const out = output();

			const parsed = JSON.parse(out.trim()) as { events: unknown[] };
			expect(parsed.events).toHaveLength(50);
		});
	});

	// === --since flag ===

	describe("--since flag", () => {
		test("--since filters events after a timestamp", async () => {
			const dbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(dbPath);
			store.insert(makeEvent({ agentName: "builder-1" }));
			store.close();

			// A future timestamp should return no events
			await feedCommand(["--json", "--since", "2099-01-01T00:00:00Z"]);
			const out = output();

			const parsed = JSON.parse(out.trim()) as { events: unknown[] };
			expect(parsed.events).toEqual([]);
		});

		test("--since with past timestamp returns all events", async () => {
			const dbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(dbPath);
			store.insert(makeEvent({ agentName: "builder-1" }));
			store.insert(makeEvent({ agentName: "builder-2" }));
			store.close();

			await feedCommand(["--json", "--since", "2020-01-01T00:00:00Z"]);
			const out = output();

			const parsed = JSON.parse(out.trim()) as { events: unknown[] };
			expect(parsed.events).toHaveLength(2);
		});

		test("default since is 5 minutes ago", async () => {
			const dbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(dbPath);
			// Insert event with current timestamp
			store.insert(makeEvent({ agentName: "builder-1" }));
			store.close();

			// Without --since, should get recent events
			await feedCommand(["--json"]);
			const out = output();

			const parsed = JSON.parse(out.trim()) as { events: unknown[] };
			expect(parsed.events).toHaveLength(1);
		});
	});

	// === Event types coverage ===

	describe("event types coverage", () => {
		test("all event types have compact labels", async () => {
			const dbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(dbPath);
			const eventTypes = [
				"tool_start",
				"tool_end",
				"session_start",
				"session_end",
				"mail_sent",
				"mail_received",
				"spawn",
				"error",
				"custom",
				"turn_start",
				"turn_end",
				"progress",
				"result",
			] as const;
			for (const eventType of eventTypes) {
				store.insert(
					makeEvent({
						agentName: "builder-1",
						eventType,
						level: eventType === "error" ? "error" : "info",
					}),
				);
			}
			store.close();

			await feedCommand([]);
			const out = output();

			// Verify all compact labels appear
			expect(out).toContain("TOOL+");
			expect(out).toContain("TOOL-");
			expect(out).toContain("SESS+");
			expect(out).toContain("SESS-");
			expect(out).toContain("MAIL>");
			expect(out).toContain("MAIL<");
			expect(out).toContain("SPAWN");
			expect(out).toContain("ERROR");
			expect(out).toContain("CUSTM");
			expect(out).toContain("TURN+");
			expect(out).toContain("TURN-");
			expect(out).toContain("PROG ");
			expect(out).toContain("RSULT");
		});
	});

	// === Edge cases ===

	describe("edge cases", () => {
		test("events are ordered chronologically", async () => {
			const dbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(dbPath);
			store.insert(makeEvent({ agentName: "builder-1", eventType: "session_start" }));
			store.insert(makeEvent({ agentName: "scout-1", eventType: "tool_start" }));
			store.insert(makeEvent({ agentName: "builder-1", eventType: "session_end" }));
			store.close();

			await feedCommand(["--json"]);
			const out = output();

			const parsed = JSON.parse(out.trim()) as { events: Record<string, unknown>[] };
			expect(parsed.events).toHaveLength(3);
			expect(parsed.events[0]?.eventType).toBe("session_start");
			expect(parsed.events[1]?.eventType).toBe("tool_start");
			expect(parsed.events[2]?.eventType).toBe("session_end");
		});

		test("handles event with all null optional fields", async () => {
			const dbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(dbPath);
			store.insert(
				makeEvent({
					agentName: "builder-1",
					eventType: "session_start",
					runId: null,
					sessionId: null,
					toolName: null,
					toolArgs: null,
					toolDurationMs: null,
					data: null,
				}),
			);
			store.close();

			// Should not throw
			await feedCommand([]);
			const out = output();

			expect(out).toContain("SESS+");
			expect(out).toContain("builder-1");
		});

		test("long data values are truncated in output", async () => {
			const dbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(dbPath);
			const longValue = "x".repeat(200);
			store.insert(
				makeEvent({
					agentName: "builder-1",
					eventType: "custom",
					toolName: null,
					data: JSON.stringify({ message: longValue }),
				}),
			);
			store.close();

			await feedCommand([]);
			const out = output();

			// The full 200-char value should not appear
			expect(out).not.toContain(longValue);
			// But a truncated version with "…" should
			expect(out).toContain("…");
		});

		test("agent color assignment is stable", async () => {
			const dbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(dbPath);
			store.insert(makeEvent({ agentName: "builder-1" }));
			store.insert(makeEvent({ agentName: "scout-1" }));
			store.insert(makeEvent({ agentName: "builder-1" }));
			store.close();

			await feedCommand([]);
			const out = output();

			// Both builder-1 events should appear
			expect(out).toContain("builder-1");
			// scout-1 should appear
			expect(out).toContain("scout-1");
		});
	});
});

describe("pollFeedTick", () => {
	test("returns same lastSeenId when no new events", () => {
		const queryFn = (): StoredEvent[] => [];
		const colorMap = new Map<string, ColorFn>();

		const result = pollFeedTick(42, queryFn, colorMap, true);
		expect(result).toBe(42);
	});

	test("returns max id when new events are found", () => {
		const events: StoredEvent[] = [
			{
				id: 50,
				runId: "run-1",
				agentName: "builder-1",
				sessionId: "s1",
				eventType: "tool_start",
				toolName: "Bash",
				toolArgs: null,
				toolDurationMs: null,
				level: "info",
				data: null,
				createdAt: new Date().toISOString(),
			},
			{
				id: 51,
				runId: "run-1",
				agentName: "builder-1",
				sessionId: "s1",
				eventType: "tool_end",
				toolName: "Bash",
				toolArgs: null,
				toolDurationMs: 100,
				level: "info",
				data: null,
				createdAt: new Date().toISOString(),
			},
		];

		const queryFn = (): StoredEvent[] => events;
		const colorMap = new Map<string, ColorFn>();

		// Capture stdout to avoid test noise
		const origWrite = process.stdout.write;
		const captured: string[] = [];
		process.stdout.write = ((chunk: string) => {
			captured.push(chunk);
			return true;
		}) as typeof process.stdout.write;

		try {
			const result = pollFeedTick(40, queryFn, colorMap, true);
			expect(result).toBe(51);
			// Should have produced JSON output
			expect(captured.length).toBeGreaterThan(0);
		} finally {
			process.stdout.write = origWrite;
		}
	});

	test("filters events to those with id > lastSeenId", () => {
		const events: StoredEvent[] = [
			{
				id: 5,
				runId: "run-1",
				agentName: "builder-1",
				sessionId: "s1",
				eventType: "tool_start",
				toolName: "Read",
				toolArgs: null,
				toolDurationMs: null,
				level: "info",
				data: null,
				createdAt: new Date().toISOString(),
			},
			{
				id: 10,
				runId: "run-1",
				agentName: "builder-1",
				sessionId: "s1",
				eventType: "tool_end",
				toolName: "Read",
				toolArgs: null,
				toolDurationMs: 50,
				level: "info",
				data: null,
				createdAt: new Date().toISOString(),
			},
		];

		const queryFn = (): StoredEvent[] => events;
		const colorMap = new Map<string, ColorFn>();

		// With lastSeenId = 5, only event with id=10 should pass
		const origWrite = process.stdout.write;
		const captured: string[] = [];
		process.stdout.write = ((chunk: string) => {
			captured.push(chunk);
			return true;
		}) as typeof process.stdout.write;

		try {
			const result = pollFeedTick(5, queryFn, colorMap, true);
			expect(result).toBe(10);
			// Only 1 event should be emitted (the one with id > 5)
			// Each JSON event is output on its own line
			const jsonOutputs = captured.filter((c) => c.includes("tool_end"));
			expect(jsonOutputs).toHaveLength(1);
		} finally {
			process.stdout.write = origWrite;
		}
	});
});

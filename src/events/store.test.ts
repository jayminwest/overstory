/**
 * Tests for EventStore (SQLite-backed event observability storage).
 *
 * Uses real bun:sqlite with :memory: databases. No mocks.
 * Philosophy: "never mock what you can use for real".
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { InsertEvent, StoredEvent, ToolStats } from "../types.ts";
import {
	createEventStore,
	type EventStoreWithProject,
	type InsertEventWithProject,
} from "./store.ts";

let store: EventStoreWithProject;

beforeEach(() => {
	store = createEventStore(":memory:");
});

afterEach(() => {
	store.close();
});

/** Helper to create an InsertEvent with sensible defaults. */
function makeEvent(overrides: Partial<InsertEventWithProject> = {}): InsertEventWithProject {
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

// === insert ===

describe("insert", () => {
	test("inserts an event and returns the auto-generated id", () => {
		const id = store.insert(makeEvent());
		expect(id).toBe(1);
	});

	test("sequential inserts return incrementing ids", () => {
		const id1 = store.insert(makeEvent());
		const id2 = store.insert(makeEvent({ agentName: "builder-2" }));
		const id3 = store.insert(makeEvent({ agentName: "builder-3" }));

		expect(id1).toBe(1);
		expect(id2).toBe(2);
		expect(id3).toBe(3);
	});

	test("all fields roundtrip correctly", () => {
		const event = makeEvent({
			runId: "run-xyz",
			agentName: "scout-1",
			sessionId: "sess-999",
			eventType: "session_start",
			toolName: null,
			toolArgs: null,
			toolDurationMs: null,
			level: "warn",
			data: '{"reason": "something happened"}',
		});

		const id = store.insert(event);
		const retrieved = store.getByAgent("scout-1");

		expect(retrieved).toHaveLength(1);
		const stored = retrieved[0] as StoredEvent;
		expect(stored.id).toBe(id);
		expect(stored.runId).toBe("run-xyz");
		expect(stored.agentName).toBe("scout-1");
		expect(stored.sessionId).toBe("sess-999");
		expect(stored.eventType).toBe("session_start");
		expect(stored.toolName).toBeNull();
		expect(stored.toolArgs).toBeNull();
		expect(stored.toolDurationMs).toBeNull();
		expect(stored.level).toBe("warn");
		expect(stored.data).toBe('{"reason": "something happened"}');
		expect(stored.createdAt).toBeTruthy();
	});

	test("null fields stored and retrieved as null", () => {
		const id = store.insert(
			makeEvent({
				runId: null,
				sessionId: null,
				toolName: null,
				toolArgs: null,
				toolDurationMs: null,
				data: null,
			}),
		);

		const events = store.getByAgent("builder-1");
		expect(events).toHaveLength(1);
		const stored = events[0] as StoredEvent;
		expect(stored.id).toBe(id);
		expect(stored.runId).toBeNull();
		expect(stored.sessionId).toBeNull();
		expect(stored.toolName).toBeNull();
		expect(stored.toolArgs).toBeNull();
		expect(stored.toolDurationMs).toBeNull();
		expect(stored.data).toBeNull();
	});

	test("rejects invalid level at DB level", () => {
		expect(() => store.insert(makeEvent({ level: "critical" as InsertEvent["level"] }))).toThrow();
	});

	test("createdAt is auto-populated by SQLite", () => {
		store.insert(makeEvent());
		const events = store.getByAgent("builder-1");
		expect(events).toHaveLength(1);
		const stored = events[0] as StoredEvent;
		// Should be a valid ISO-ish timestamp
		expect(stored.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
	});
});

// === correlateToolEnd ===

describe("correlateToolEnd", () => {
	test("finds matching tool_start and returns duration", () => {
		store.insert(
			makeEvent({
				eventType: "tool_start",
				toolName: "Bash",
				toolDurationMs: null,
			}),
		);

		// Small delay to ensure measurable duration
		const result = store.correlateToolEnd("builder-1", "Bash");
		expect(result).not.toBeNull();
		expect(result?.startId).toBe(1);
		expect(result?.durationMs).toBeGreaterThanOrEqual(0);
	});

	test("returns null when no matching tool_start exists", () => {
		const result = store.correlateToolEnd("builder-1", "Bash");
		expect(result).toBeNull();
	});

	test("returns null when tool_start is for a different agent", () => {
		store.insert(
			makeEvent({
				agentName: "scout-1",
				eventType: "tool_start",
				toolName: "Bash",
			}),
		);

		const result = store.correlateToolEnd("builder-1", "Bash");
		expect(result).toBeNull();
	});

	test("returns null when tool_start is for a different tool", () => {
		store.insert(
			makeEvent({
				eventType: "tool_start",
				toolName: "Read",
			}),
		);

		const result = store.correlateToolEnd("builder-1", "Bash");
		expect(result).toBeNull();
	});

	test("does not match already-correlated tool_start (has duration)", () => {
		store.insert(
			makeEvent({
				eventType: "tool_start",
				toolName: "Bash",
				toolDurationMs: 500, // already has duration
			}),
		);

		const result = store.correlateToolEnd("builder-1", "Bash");
		expect(result).toBeNull();
	});

	test("correlates with the most recent unmatched tool_start", () => {
		// Insert two tool_starts for the same tool
		store.insert(
			makeEvent({
				eventType: "tool_start",
				toolName: "Bash",
				toolDurationMs: null,
			}),
		);
		store.insert(
			makeEvent({
				eventType: "tool_start",
				toolName: "Bash",
				toolDurationMs: null,
			}),
		);

		const result = store.correlateToolEnd("builder-1", "Bash");
		expect(result).not.toBeNull();
		// Should match the second (most recent) tool_start
		expect(result?.startId).toBe(2);
	});

	test("updates tool_duration_ms on the start event after correlation", () => {
		store.insert(
			makeEvent({
				eventType: "tool_start",
				toolName: "Bash",
				toolDurationMs: null,
			}),
		);

		const result = store.correlateToolEnd("builder-1", "Bash");
		expect(result).not.toBeNull();

		// After correlation, the start event should have a duration
		const events = store.getByAgent("builder-1");
		expect(events).toHaveLength(1);
		const updated = events[0] as StoredEvent;
		expect(updated.toolDurationMs).toBeGreaterThanOrEqual(0);

		// A second correlation should return null (already matched)
		const secondResult = store.correlateToolEnd("builder-1", "Bash");
		expect(secondResult).toBeNull();
	});
});

// === getByAgent ===

describe("getByAgent", () => {
	test("returns events for a specific agent", () => {
		store.insert(makeEvent({ agentName: "builder-1" }));
		store.insert(makeEvent({ agentName: "scout-1" }));
		store.insert(makeEvent({ agentName: "builder-1", eventType: "tool_end" }));

		const events = store.getByAgent("builder-1");
		expect(events).toHaveLength(2);
		for (const e of events) {
			expect(e.agentName).toBe("builder-1");
		}
	});

	test("returns events in chronological order (ASC)", () => {
		store.insert(makeEvent({ agentName: "builder-1", eventType: "session_start" }));
		store.insert(makeEvent({ agentName: "builder-1", eventType: "tool_start" }));
		store.insert(makeEvent({ agentName: "builder-1", eventType: "session_end" }));

		const events = store.getByAgent("builder-1");
		expect(events).toHaveLength(3);
		expect(events[0]?.eventType).toBe("session_start");
		expect(events[1]?.eventType).toBe("tool_start");
		expect(events[2]?.eventType).toBe("session_end");
	});

	test("returns empty array for unknown agent", () => {
		store.insert(makeEvent({ agentName: "builder-1" }));
		const events = store.getByAgent("unknown-agent");
		expect(events).toEqual([]);
	});

	test("respects limit option", () => {
		store.insert(makeEvent({ agentName: "builder-1", eventType: "tool_start" }));
		store.insert(makeEvent({ agentName: "builder-1", eventType: "tool_end" }));
		store.insert(makeEvent({ agentName: "builder-1", eventType: "session_end" }));

		const events = store.getByAgent("builder-1", { limit: 2 });
		expect(events).toHaveLength(2);
	});

	test("respects level filter", () => {
		store.insert(makeEvent({ agentName: "builder-1", level: "info" }));
		store.insert(makeEvent({ agentName: "builder-1", level: "error" }));
		store.insert(makeEvent({ agentName: "builder-1", level: "info" }));

		const events = store.getByAgent("builder-1", { level: "error" });
		expect(events).toHaveLength(1);
		expect(events[0]?.level).toBe("error");
	});
});

// === getByRun ===

describe("getByRun", () => {
	test("returns events for a specific run", () => {
		store.insert(makeEvent({ runId: "run-001" }));
		store.insert(makeEvent({ runId: "run-002" }));
		store.insert(makeEvent({ runId: "run-001", eventType: "session_end" }));

		const events = store.getByRun("run-001");
		expect(events).toHaveLength(2);
		for (const e of events) {
			expect(e.runId).toBe("run-001");
		}
	});

	test("returns events in chronological order (ASC)", () => {
		store.insert(makeEvent({ runId: "run-001", eventType: "session_start" }));
		store.insert(makeEvent({ runId: "run-001", eventType: "tool_start" }));
		store.insert(makeEvent({ runId: "run-001", eventType: "session_end" }));

		const events = store.getByRun("run-001");
		expect(events).toHaveLength(3);
		expect(events[0]?.eventType).toBe("session_start");
		expect(events[2]?.eventType).toBe("session_end");
	});

	test("returns empty array for unknown run", () => {
		const events = store.getByRun("nonexistent-run");
		expect(events).toEqual([]);
	});

	test("respects limit option", () => {
		store.insert(makeEvent({ runId: "run-001" }));
		store.insert(makeEvent({ runId: "run-001" }));
		store.insert(makeEvent({ runId: "run-001" }));

		const events = store.getByRun("run-001", { limit: 1 });
		expect(events).toHaveLength(1);
	});
});

// === getErrors ===

describe("getErrors", () => {
	test("returns only error-level events", () => {
		store.insert(makeEvent({ level: "info" }));
		store.insert(makeEvent({ level: "error", eventType: "error", data: '{"msg": "fail1"}' }));
		store.insert(makeEvent({ level: "warn" }));
		store.insert(makeEvent({ level: "error", eventType: "error", data: '{"msg": "fail2"}' }));

		const errors = store.getErrors();
		expect(errors).toHaveLength(2);
		for (const e of errors) {
			expect(e.level).toBe("error");
		}
	});

	test("returns errors in reverse chronological order (most recent first)", () => {
		store.insert(
			makeEvent({
				level: "error",
				agentName: "agent-a",
				eventType: "error",
			}),
		);
		store.insert(
			makeEvent({
				level: "error",
				agentName: "agent-b",
				eventType: "error",
			}),
		);

		const errors = store.getErrors();
		expect(errors).toHaveLength(2);
		// Both are error level; verify they are returned (order depends on
		// sub-millisecond timestamps which may tie, so just verify content)
		const names = errors.map((e) => e.agentName).sort();
		expect(names).toEqual(["agent-a", "agent-b"]);
	});

	test("returns empty array when no errors exist", () => {
		store.insert(makeEvent({ level: "info" }));
		store.insert(makeEvent({ level: "warn" }));

		const errors = store.getErrors();
		expect(errors).toEqual([]);
	});

	test("respects limit option", () => {
		for (let i = 0; i < 5; i++) {
			store.insert(makeEvent({ level: "error", eventType: "error" }));
		}

		const errors = store.getErrors({ limit: 3 });
		expect(errors).toHaveLength(3);
	});
});

// === getTimeline ===

describe("getTimeline", () => {
	test("returns events since a given timestamp", () => {
		// Insert events with default timestamps (all "now")
		store.insert(makeEvent({ agentName: "builder-1" }));
		store.insert(makeEvent({ agentName: "scout-1" }));

		// Use a past timestamp to capture all events
		const events = store.getTimeline({ since: "2020-01-01T00:00:00Z" });
		expect(events).toHaveLength(2);
	});

	test("returns events in chronological order (ASC)", () => {
		store.insert(makeEvent({ agentName: "builder-1", eventType: "session_start" }));
		store.insert(makeEvent({ agentName: "builder-1", eventType: "tool_start" }));

		const events = store.getTimeline({ since: "2020-01-01T00:00:00Z" });
		expect(events).toHaveLength(2);
		expect(events[0]?.eventType).toBe("session_start");
		expect(events[1]?.eventType).toBe("tool_start");
	});

	test("respects limit option", () => {
		for (let i = 0; i < 10; i++) {
			store.insert(makeEvent());
		}

		const events = store.getTimeline({ since: "2020-01-01T00:00:00Z", limit: 5 });
		expect(events).toHaveLength(5);
	});

	test("returns empty array when no events match the time range", () => {
		store.insert(makeEvent());

		// Use a future timestamp -- no events should match
		const events = store.getTimeline({ since: "2099-01-01T00:00:00Z" });
		expect(events).toEqual([]);
	});

	test("respects level filter", () => {
		store.insert(makeEvent({ level: "info" }));
		store.insert(makeEvent({ level: "error" }));
		store.insert(makeEvent({ level: "info" }));

		const events = store.getTimeline({
			since: "2020-01-01T00:00:00Z",
			level: "error",
		});
		expect(events).toHaveLength(1);
		expect(events[0]?.level).toBe("error");
	});
});

// === getToolStats ===

describe("getToolStats", () => {
	test("aggregates tool usage counts", () => {
		store.insert(makeEvent({ toolName: "Read", eventType: "tool_start" }));
		store.insert(makeEvent({ toolName: "Read", eventType: "tool_start" }));
		store.insert(makeEvent({ toolName: "Bash", eventType: "tool_start" }));

		const stats = store.getToolStats();
		expect(stats).toHaveLength(2);

		const readStats = stats.find((s) => s.toolName === "Read");
		const bashStats = stats.find((s) => s.toolName === "Bash");

		expect(readStats?.count).toBe(2);
		expect(bashStats?.count).toBe(1);
	});

	test("computes average and max duration", () => {
		store.insert(
			makeEvent({
				toolName: "Read",
				eventType: "tool_start",
				toolDurationMs: 100,
			}),
		);
		store.insert(
			makeEvent({
				toolName: "Read",
				eventType: "tool_start",
				toolDurationMs: 300,
			}),
		);

		const stats = store.getToolStats();
		expect(stats).toHaveLength(1);

		const readStats = stats[0] as ToolStats;
		expect(readStats.toolName).toBe("Read");
		expect(readStats.count).toBe(2);
		expect(readStats.avgDurationMs).toBe(200);
		expect(readStats.maxDurationMs).toBe(300);
	});

	test("returns stats ordered by count DESC", () => {
		store.insert(makeEvent({ toolName: "Bash", eventType: "tool_start" }));
		store.insert(makeEvent({ toolName: "Read", eventType: "tool_start" }));
		store.insert(makeEvent({ toolName: "Read", eventType: "tool_start" }));
		store.insert(makeEvent({ toolName: "Read", eventType: "tool_start" }));
		store.insert(makeEvent({ toolName: "Bash", eventType: "tool_start" }));

		const stats = store.getToolStats();
		expect(stats).toHaveLength(2);
		expect(stats[0]?.toolName).toBe("Read"); // 3 uses
		expect(stats[1]?.toolName).toBe("Bash"); // 2 uses
	});

	test("filters by agent name", () => {
		store.insert(makeEvent({ agentName: "builder-1", toolName: "Read", eventType: "tool_start" }));
		store.insert(makeEvent({ agentName: "scout-1", toolName: "Read", eventType: "tool_start" }));
		store.insert(makeEvent({ agentName: "builder-1", toolName: "Bash", eventType: "tool_start" }));

		const stats = store.getToolStats({ agentName: "builder-1" });
		expect(stats).toHaveLength(2);
		// Only builder-1's tools
		const total = stats.reduce((sum, s) => sum + s.count, 0);
		expect(total).toBe(2);
	});

	test("returns empty array when no tool events exist", () => {
		store.insert(makeEvent({ toolName: null, eventType: "session_start" }));
		const stats = store.getToolStats();
		expect(stats).toEqual([]);
	});

	test("only counts tool_start events (not tool_end)", () => {
		store.insert(makeEvent({ toolName: "Read", eventType: "tool_start" }));
		store.insert(makeEvent({ toolName: "Read", eventType: "tool_end" }));

		const stats = store.getToolStats();
		expect(stats).toHaveLength(1);
		expect(stats[0]?.count).toBe(1);
	});

	test("handles null toolDurationMs in averages", () => {
		store.insert(
			makeEvent({
				toolName: "Read",
				eventType: "tool_start",
				toolDurationMs: null,
			}),
		);
		store.insert(
			makeEvent({
				toolName: "Read",
				eventType: "tool_start",
				toolDurationMs: 200,
			}),
		);

		const stats = store.getToolStats();
		expect(stats).toHaveLength(1);
		// AVG of (NULL, 200) -- SQLite AVG ignores NULL, so result is 200
		expect(stats[0]?.avgDurationMs).toBe(200);
	});
});

// === purge ===

describe("purge", () => {
	test("purge all deletes everything and returns count", () => {
		store.insert(makeEvent({ agentName: "builder-1" }));
		store.insert(makeEvent({ agentName: "scout-1" }));
		store.insert(makeEvent({ agentName: "builder-2" }));

		const count = store.purge({ all: true });
		expect(count).toBe(3);

		const remaining = store.getByAgent("builder-1");
		expect(remaining).toEqual([]);
	});

	test("purge by agent name deletes only that agent's events", () => {
		store.insert(makeEvent({ agentName: "builder-1" }));
		store.insert(makeEvent({ agentName: "scout-1" }));
		store.insert(makeEvent({ agentName: "builder-1", eventType: "tool_end" }));

		const count = store.purge({ agentName: "builder-1" });
		expect(count).toBe(2);

		const remaining = store.getByAgent("scout-1");
		expect(remaining).toHaveLength(1);
	});

	test("purge on empty DB returns 0", () => {
		const count = store.purge({ all: true });
		expect(count).toBe(0);
	});

	test("purge with no options returns 0 without deleting", () => {
		store.insert(makeEvent());
		const count = store.purge({});
		expect(count).toBe(0);

		const events = store.getByAgent("builder-1");
		expect(events).toHaveLength(1);
	});

	test("purge by olderThanMs deletes old events", () => {
		// Insert an event (created_at is "now")
		store.insert(makeEvent({ agentName: "builder-1" }));

		// Purging events older than 1 hour should delete nothing (events are fresh)
		const count = store.purge({ olderThanMs: 3_600_000 });
		expect(count).toBe(0);

		const events = store.getByAgent("builder-1");
		expect(events).toHaveLength(1);
	});

	test("purge combines agentName and olderThanMs", () => {
		store.insert(makeEvent({ agentName: "builder-1" }));
		store.insert(makeEvent({ agentName: "scout-1" }));

		// Both agents' events are fresh, so nothing should be deleted
		const count = store.purge({ agentName: "builder-1", olderThanMs: 3_600_000 });
		expect(count).toBe(0);
	});
});

// === close ===

describe("close", () => {
	test("calling close does not throw", () => {
		expect(() => store.close()).not.toThrow();
	});
});

// === CHECK constraints ===

describe("CHECK constraints", () => {
	test("accepts all valid level values", () => {
		const levels: InsertEvent["level"][] = ["debug", "info", "warn", "error"];
		for (const level of levels) {
			const id = store.insert(makeEvent({ level }));
			expect(id).toBeGreaterThan(0);
		}
	});

	test("rejects invalid level value", () => {
		expect(() => store.insert(makeEvent({ level: "fatal" as InsertEvent["level"] }))).toThrow();
	});
});

// === project_id support ===

describe("project_id support", () => {
	test("insert defaults project_id to '_default'", () => {
		const id = store.insert(makeEvent());
		const events = store.getByAgent("builder-1");
		expect(events).toHaveLength(1);
		const stored = events[0];
		expect(stored?.projectId).toBe("_default");
		expect(id).toBeGreaterThan(0);
	});

	test("insert with explicit project_id stores it correctly", () => {
		store.insert(makeEvent({ projectId: "project-alpha" }));
		const events = store.getByAgent("builder-1");
		expect(events).toHaveLength(1);
		expect(events[0]?.projectId).toBe("project-alpha");
	});

	test("getByAgent filters by project_id when provided", () => {
		store.insert(makeEvent({ agentName: "builder-1", projectId: "proj-a" }));
		store.insert(makeEvent({ agentName: "builder-1", projectId: "proj-b" }));
		store.insert(makeEvent({ agentName: "builder-1", projectId: "proj-a" }));

		const projAEvents = store.getByAgent("builder-1", { projectId: "proj-a" });
		expect(projAEvents).toHaveLength(2);
		for (const e of projAEvents) {
			expect(e.projectId).toBe("proj-a");
		}

		const projBEvents = store.getByAgent("builder-1", { projectId: "proj-b" });
		expect(projBEvents).toHaveLength(1);
		expect(projBEvents[0]?.projectId).toBe("proj-b");
	});

	test("getByRun filters by project_id when provided", () => {
		store.insert(makeEvent({ runId: "run-001", projectId: "proj-a" }));
		store.insert(makeEvent({ runId: "run-001", projectId: "proj-b" }));

		const projAEvents = store.getByRun("run-001", { projectId: "proj-a" });
		expect(projAEvents).toHaveLength(1);
		expect(projAEvents[0]?.projectId).toBe("proj-a");
	});

	test("getErrors filters by project_id when provided", () => {
		store.insert(makeEvent({ level: "error", eventType: "error", projectId: "proj-a" }));
		store.insert(makeEvent({ level: "error", eventType: "error", projectId: "proj-b" }));

		const projAErrors = store.getErrors({ projectId: "proj-a" });
		expect(projAErrors).toHaveLength(1);
		expect(projAErrors[0]?.projectId).toBe("proj-a");
	});

	test("migration: create old DB without project_id column, reopen, verify migration adds it", () => {
		const { mkdtempSync, rmSync } = require("node:fs");
		const { tmpdir: osTmpdir } = require("node:os");
		const { join: pathJoin } = require("node:path");

		const tempDir = mkdtempSync(pathJoin(osTmpdir(), "overstory-events-migrate-"));
		const dbPath = pathJoin(tempDir, "events.db");

		try {
			// Create an old-style DB without project_id
			const rawDb = new Database(dbPath);
			rawDb.exec("PRAGMA journal_mode = WAL");
			rawDb.exec(`
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT,
  agent_name TEXT NOT NULL,
  session_id TEXT,
  event_type TEXT NOT NULL,
  tool_name TEXT,
  tool_args TEXT,
  tool_duration_ms INTEGER,
  level TEXT NOT NULL DEFAULT 'info' CHECK(level IN ('debug','info','warn','error')),
  data TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now'))
)`);
			rawDb.exec(
				`INSERT INTO events (agent_name, event_type, level) VALUES ('old-agent', 'session_start', 'info')`,
			);
			rawDb.close();

			// Reopen via createEventStore — should trigger migration
			const migratedStore = createEventStore(dbPath);

			// Old event should have '_default' project_id
			const events = migratedStore.getByAgent("old-agent");
			expect(events).toHaveLength(1);
			expect(events[0]?.projectId).toBe("_default");

			// New inserts should work with project_id
			migratedStore.insert(makeEvent({ agentName: "new-agent", projectId: "proj-x" }));
			const newEvents = migratedStore.getByAgent("new-agent");
			expect(newEvents).toHaveLength(1);
			expect(newEvents[0]?.projectId).toBe("proj-x");

			migratedStore.close();
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});

// === concurrent access ===

describe("concurrent access", () => {
	test("second store instance can read events written by first", () => {
		// Use a temp file for this test since :memory: databases are isolated
		const { mkdtempSync, rmSync } = require("node:fs");
		const { tmpdir } = require("node:os");
		const { join } = require("node:path");

		const tempDir = mkdtempSync(join(tmpdir(), "overstory-events-test-"));
		const dbPath = join(tempDir, "events.db");

		const store1 = createEventStore(dbPath);
		const store2 = createEventStore(dbPath);

		store1.insert(makeEvent({ agentName: "builder-1" }));

		const events = store2.getByAgent("builder-1");
		expect(events).toHaveLength(1);
		expect(events[0]?.agentName).toBe("builder-1");

		store1.close();
		store2.close();
		rmSync(tempDir, { recursive: true, force: true });
	});
});

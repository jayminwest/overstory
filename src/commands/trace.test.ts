/**
 * Tests for `overstory trace` command.
 *
 * Uses real bun:sqlite (temp files) to test the trace command end-to-end.
 * Captures process.stdout.write to verify output formatting.
 *
 * Real implementations used for: filesystem (temp dirs), SQLite (EventStore,
 * SessionStore). No mocks needed -- all dependencies are cheap and local.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ValidationError } from "../errors.ts";
import { createEventStore } from "../events/store.ts";
import { createSessionStore } from "../sessions/store.ts";
import type { InsertEvent } from "../types.ts";
import { traceCommand } from "./trace.ts";

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

describe("traceCommand", () => {
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
		tempDir = await mkdtemp(join(tmpdir(), "trace-test-"));
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
		await rm(tempDir, { recursive: true, force: true });
	});

	function output(): string {
		return chunks.join("");
	}

	// === Help flag ===

	describe("help flag", () => {
		test("--help shows help text", async () => {
			await traceCommand(["--help"]);
			const out = output();

			expect(out).toContain("overstory trace");
			expect(out).toContain("<target>");
			expect(out).toContain("--json");
			expect(out).toContain("--since");
			expect(out).toContain("--until");
			expect(out).toContain("--limit");
		});

		test("-h shows help text", async () => {
			await traceCommand(["-h"]);
			const out = output();

			expect(out).toContain("overstory trace");
		});
	});

	// === Argument parsing ===

	describe("argument parsing", () => {
		test("missing target throws ValidationError", async () => {
			await expect(traceCommand([])).rejects.toThrow(ValidationError);
		});

		test("missing target error mentions usage", async () => {
			try {
				await traceCommand([]);
				expect.unreachable("should have thrown");
			} catch (err) {
				expect(err).toBeInstanceOf(ValidationError);
				expect((err as ValidationError).message).toContain("Missing target");
			}
		});

		test("only flags with no target throws ValidationError", async () => {
			await expect(traceCommand(["--json"])).rejects.toThrow(ValidationError);
		});

		test("--limit with non-numeric value throws ValidationError", async () => {
			await expect(traceCommand(["builder-1", "--limit", "abc"])).rejects.toThrow(ValidationError);
		});

		test("--limit with zero throws ValidationError", async () => {
			await expect(traceCommand(["builder-1", "--limit", "0"])).rejects.toThrow(ValidationError);
		});

		test("--limit with negative value throws ValidationError", async () => {
			await expect(traceCommand(["builder-1", "--limit", "-5"])).rejects.toThrow(ValidationError);
		});

		test("--since with invalid timestamp throws ValidationError", async () => {
			await expect(traceCommand(["builder-1", "--since", "not-a-date"])).rejects.toThrow(
				ValidationError,
			);
		});

		test("--until with invalid timestamp throws ValidationError", async () => {
			await expect(traceCommand(["builder-1", "--until", "not-a-date"])).rejects.toThrow(
				ValidationError,
			);
		});

		test("target is extracted correctly when flags come first", async () => {
			// Create events.db with an event so the command runs to completion
			const dbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(dbPath);
			store.insert(makeEvent({ agentName: "my-agent" }));
			store.close();

			await traceCommand(["--json", "--limit", "50", "my-agent"]);
			const out = output();
			const parsed = JSON.parse(out.trim()) as unknown[];
			expect(parsed).toHaveLength(1);
		});

		test("target is extracted correctly when flags come after", async () => {
			const dbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(dbPath);
			store.insert(makeEvent({ agentName: "my-agent" }));
			store.close();

			await traceCommand(["my-agent", "--json", "--limit", "50"]);
			const out = output();
			const parsed = JSON.parse(out.trim()) as unknown[];
			expect(parsed).toHaveLength(1);
		});
	});

	// === Missing events.db (graceful handling) ===

	describe("missing events.db", () => {
		test("text mode outputs friendly message when no events.db exists", async () => {
			await traceCommand(["builder-1"]);
			const out = output();

			expect(out).toBe("No events data yet.\n");
		});

		test("JSON mode outputs empty array when no events.db exists", async () => {
			await traceCommand(["builder-1", "--json"]);
			const out = output();

			expect(out).toBe("[]\n");
		});
	});

	// === JSON output mode ===

	describe("JSON output mode", () => {
		test("outputs valid JSON array with events", async () => {
			const dbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(dbPath);
			store.insert(makeEvent({ agentName: "builder-1", eventType: "session_start" }));
			store.insert(makeEvent({ agentName: "builder-1", eventType: "tool_start" }));
			store.insert(makeEvent({ agentName: "builder-1", eventType: "session_end" }));
			store.close();

			await traceCommand(["builder-1", "--json"]);
			const out = output();

			const parsed = JSON.parse(out.trim()) as unknown[];
			expect(parsed).toHaveLength(3);
			expect(Array.isArray(parsed)).toBe(true);
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

			await traceCommand(["builder-1", "--json"]);
			const out = output();

			const parsed = JSON.parse(out.trim()) as Record<string, unknown>[];
			expect(parsed).toHaveLength(1);
			const event = parsed[0];
			expect(event).toBeDefined();
			expect(event?.agentName).toBe("builder-1");
			expect(event?.eventType).toBe("tool_start");
			expect(event?.toolName).toBe("Bash");
			expect(event?.level).toBe("info");
			expect(event?.createdAt).toBeTruthy();
		});

		test("JSON output returns empty array when no events match agent", async () => {
			const dbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(dbPath);
			store.insert(makeEvent({ agentName: "other-agent" }));
			store.close();

			await traceCommand(["builder-1", "--json"]);
			const out = output();

			const parsed = JSON.parse(out.trim()) as unknown[];
			expect(parsed).toEqual([]);
		});
	});

	// === Timeline output format ===

	describe("timeline output", () => {
		test("shows header with agent name", async () => {
			const dbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(dbPath);
			store.insert(makeEvent({ agentName: "builder-1" }));
			store.close();

			await traceCommand(["builder-1"]);
			const out = output();

			expect(out).toContain("Timeline for builder-1");
		});

		test("shows event count", async () => {
			const dbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(dbPath);
			store.insert(makeEvent({ agentName: "builder-1", eventType: "session_start" }));
			store.insert(makeEvent({ agentName: "builder-1", eventType: "tool_start" }));
			store.insert(makeEvent({ agentName: "builder-1", eventType: "session_end" }));
			store.close();

			await traceCommand(["builder-1"]);
			const out = output();

			expect(out).toContain("3 events");
		});

		test("shows singular event count", async () => {
			const dbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(dbPath);
			store.insert(makeEvent({ agentName: "builder-1" }));
			store.close();

			await traceCommand(["builder-1"]);
			const out = output();

			expect(out).toContain("1 event");
			// Should NOT say "1 events"
			expect(out).not.toMatch(/1 events/);
		});

		test("no events shows 'No events found' message", async () => {
			const dbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(dbPath);
			// Create the DB but don't insert anything for builder-1
			store.insert(makeEvent({ agentName: "other-agent" }));
			store.close();

			await traceCommand(["builder-1"]);
			const out = output();

			expect(out).toContain("No events found");
		});

		test("shows separator line", async () => {
			const dbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(dbPath);
			store.insert(makeEvent({ agentName: "builder-1" }));
			store.close();

			await traceCommand(["builder-1"]);
			const out = output();

			expect(out).toContain("=".repeat(70));
		});

		test("event type labels are shown", async () => {
			const dbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(dbPath);
			store.insert(makeEvent({ agentName: "builder-1", eventType: "session_start" }));
			store.insert(makeEvent({ agentName: "builder-1", eventType: "tool_start" }));
			store.insert(makeEvent({ agentName: "builder-1", eventType: "error", level: "error" }));
			store.close();

			await traceCommand(["builder-1"]);
			const out = output();

			expect(out).toContain("SESSION  +");
			expect(out).toContain("TOOL START");
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

			await traceCommand(["builder-1"]);
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

			await traceCommand(["builder-1"]);
			const out = output();

			expect(out).toContain("duration=42ms");
		});

		test("custom data fields are shown in detail", async () => {
			const dbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(dbPath);
			store.insert(
				makeEvent({
					agentName: "builder-1",
					eventType: "custom",
					toolName: null,
					data: '{"reason":"testing","count":5}',
				}),
			);
			store.close();

			await traceCommand(["builder-1"]);
			const out = output();

			expect(out).toContain("reason=testing");
			expect(out).toContain("count=5");
		});

		test("date separator appears in timeline", async () => {
			const dbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(dbPath);
			store.insert(makeEvent({ agentName: "builder-1" }));
			store.close();

			await traceCommand(["builder-1"]);
			const out = output();

			// Should contain a date separator with --- prefix
			expect(out).toMatch(/---\s+\d{4}-\d{2}-\d{2}\s+---/);
		});
	});

	// === --limit flag ===

	describe("--limit flag", () => {
		test("limits the number of events returned", async () => {
			const dbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(dbPath);
			for (let i = 0; i < 10; i++) {
				store.insert(makeEvent({ agentName: "builder-1" }));
			}
			store.close();

			await traceCommand(["builder-1", "--json", "--limit", "3"]);
			const out = output();

			const parsed = JSON.parse(out.trim()) as unknown[];
			expect(parsed).toHaveLength(3);
		});

		test("default limit is 100", async () => {
			const dbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(dbPath);
			for (let i = 0; i < 120; i++) {
				store.insert(makeEvent({ agentName: "builder-1" }));
			}
			store.close();

			await traceCommand(["builder-1", "--json"]);
			const out = output();

			const parsed = JSON.parse(out.trim()) as unknown[];
			expect(parsed).toHaveLength(100);
		});
	});

	// === --since and --until flags ===

	describe("--since and --until flags", () => {
		test("--since filters events after a timestamp", async () => {
			const dbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(dbPath);

			// Insert events -- all get "now" timestamps from SQLite
			store.insert(makeEvent({ agentName: "builder-1" }));
			store.close();

			// A future timestamp should return no events
			await traceCommand(["builder-1", "--json", "--since", "2099-01-01T00:00:00Z"]);
			const out = output();

			const parsed = JSON.parse(out.trim()) as unknown[];
			expect(parsed).toEqual([]);
		});

		test("--since with past timestamp returns all events", async () => {
			const dbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(dbPath);
			store.insert(makeEvent({ agentName: "builder-1" }));
			store.insert(makeEvent({ agentName: "builder-1" }));
			store.close();

			await traceCommand(["builder-1", "--json", "--since", "2020-01-01T00:00:00Z"]);
			const out = output();

			const parsed = JSON.parse(out.trim()) as unknown[];
			expect(parsed).toHaveLength(2);
		});

		test("--until with past timestamp returns no events", async () => {
			const dbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(dbPath);
			store.insert(makeEvent({ agentName: "builder-1" }));
			store.close();

			await traceCommand(["builder-1", "--json", "--until", "2000-01-01T00:00:00Z"]);
			const out = output();

			const parsed = JSON.parse(out.trim()) as unknown[];
			expect(parsed).toEqual([]);
		});

		test("--since causes absolute timestamps in text mode", async () => {
			const dbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(dbPath);
			store.insert(makeEvent({ agentName: "builder-1" }));
			store.close();

			await traceCommand(["builder-1", "--since", "2020-01-01T00:00:00Z"]);
			const out = output();

			// Absolute timestamps show HH:MM:SS format
			expect(out).toMatch(/\d{2}:\d{2}:\d{2}/);
		});

		test("valid --since timestamp is accepted", async () => {
			const dbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(dbPath);
			store.insert(makeEvent({ agentName: "builder-1" }));
			store.close();

			// Should not throw
			await traceCommand(["builder-1", "--json", "--since", "2024-06-15T12:00:00Z"]);
			const out = output();
			// Should be valid JSON
			JSON.parse(out.trim());
		});
	});

	// === Target resolution ===

	describe("target resolution", () => {
		test("agent name is used as-is when not a bead ID pattern", async () => {
			const dbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(dbPath);
			store.insert(makeEvent({ agentName: "my-custom-agent" }));
			store.close();

			await traceCommand(["my-custom-agent", "--json"]);
			const out = output();

			const parsed = JSON.parse(out.trim()) as Record<string, unknown>[];
			expect(parsed).toHaveLength(1);
			expect(parsed[0]?.agentName).toBe("my-custom-agent");
		});

		test("bead ID pattern is detected and resolved to agent name via SessionStore", async () => {
			// Create a session that maps bead ID to agent name
			const sessDbPath = join(tempDir, ".overstory", "sessions.db");
			const sessionStore = createSessionStore(sessDbPath);
			sessionStore.upsert({
				id: "sess-001",
				agentName: "builder-for-task",
				capability: "builder",
				worktreePath: "/tmp/wt",
				branchName: "feat/task",
				beadId: "overstory-rj1k",
				tmuxSession: "tmux-001",
				state: "completed",
				pid: null,
				parentAgent: null,
				depth: 0,
				runId: null,
				startedAt: new Date().toISOString(),
				lastActivity: new Date().toISOString(),
				escalationLevel: 0,
				stalledSince: null,
			});
			sessionStore.close();

			// Create events for the agent name that the bead resolves to
			const eventsDbPath = join(tempDir, ".overstory", "events.db");
			const eventStore = createEventStore(eventsDbPath);
			eventStore.insert(makeEvent({ agentName: "builder-for-task" }));
			eventStore.close();

			await traceCommand(["overstory-rj1k", "--json"]);
			const out = output();

			const parsed = JSON.parse(out.trim()) as Record<string, unknown>[];
			expect(parsed).toHaveLength(1);
			expect(parsed[0]?.agentName).toBe("builder-for-task");
		});

		test("unresolved bead ID falls back to using bead ID as agent name", async () => {
			// Create sessions.db but with no matching bead
			const sessDbPath = join(tempDir, ".overstory", "sessions.db");
			const sessionStore = createSessionStore(sessDbPath);
			sessionStore.close();

			// Create events.db (empty for this bead)
			const eventsDbPath = join(tempDir, ".overstory", "events.db");
			const eventStore = createEventStore(eventsDbPath);
			eventStore.close();

			await traceCommand(["myproj-abc1", "--json"]);
			const out = output();

			const parsed = JSON.parse(out.trim()) as unknown[];
			expect(parsed).toEqual([]);
		});

		test("short agent names without bead pattern are not resolved as bead IDs", async () => {
			const dbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(dbPath);
			store.insert(makeEvent({ agentName: "scout" }));
			store.close();

			// "scout" does not match bead pattern word-alphanumeric
			await traceCommand(["scout", "--json"]);
			const out = output();

			const parsed = JSON.parse(out.trim()) as Record<string, unknown>[];
			expect(parsed).toHaveLength(1);
			expect(parsed[0]?.agentName).toBe("scout");
		});
	});

	// === Event filtering edge cases ===

	describe("edge cases", () => {
		test("only returns events for the specified agent", async () => {
			const dbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(dbPath);
			store.insert(makeEvent({ agentName: "builder-1" }));
			store.insert(makeEvent({ agentName: "builder-2" }));
			store.insert(makeEvent({ agentName: "builder-1" }));
			store.insert(makeEvent({ agentName: "scout-1" }));
			store.close();

			await traceCommand(["builder-1", "--json"]);
			const out = output();

			const parsed = JSON.parse(out.trim()) as Record<string, unknown>[];
			expect(parsed).toHaveLength(2);
			for (const event of parsed) {
				expect(event.agentName).toBe("builder-1");
			}
		});

		test("all event types have labeled output", async () => {
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

			await traceCommand(["builder-1"]);
			const out = output();

			// Verify all expected labels appear
			expect(out).toContain("TOOL START");
			expect(out).toContain("TOOL END");
			expect(out).toContain("SESSION  +");
			expect(out).toContain("SESSION  -");
			expect(out).toContain("MAIL SENT");
			expect(out).toContain("MAIL RECV");
			expect(out).toContain("SPAWN");
			expect(out).toContain("ERROR");
			expect(out).toContain("CUSTOM");
		});

		test("long data values are truncated", async () => {
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

			await traceCommand(["builder-1"]);
			const out = output();

			// The full 200-char value should not appear
			expect(out).not.toContain(longValue);
			// But a truncated version with "..." should
			expect(out).toContain("...");
		});

		test("non-JSON data is shown raw if short", async () => {
			const dbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(dbPath);
			store.insert(
				makeEvent({
					agentName: "builder-1",
					eventType: "custom",
					toolName: null,
					data: "simple text data",
				}),
			);
			store.close();

			await traceCommand(["builder-1"]);
			const out = output();

			expect(out).toContain("simple text data");
		});

		test("events are ordered chronologically", async () => {
			const dbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(dbPath);
			store.insert(makeEvent({ agentName: "builder-1", eventType: "session_start" }));
			store.insert(makeEvent({ agentName: "builder-1", eventType: "tool_start" }));
			store.insert(makeEvent({ agentName: "builder-1", eventType: "session_end" }));
			store.close();

			await traceCommand(["builder-1", "--json"]);
			const out = output();

			const parsed = JSON.parse(out.trim()) as Record<string, unknown>[];
			expect(parsed).toHaveLength(3);
			expect(parsed[0]?.eventType).toBe("session_start");
			expect(parsed[1]?.eventType).toBe("tool_start");
			expect(parsed[2]?.eventType).toBe("session_end");
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
			await traceCommand(["builder-1"]);
			const out = output();

			expect(out).toContain("Timeline for builder-1");
			expect(out).toContain("1 event");
		});
	});
});

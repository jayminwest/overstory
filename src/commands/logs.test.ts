import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ValidationError } from "../errors.ts";
import { cleanupTempDir } from "../test-helpers.ts";
import type { LogEvent } from "../types.ts";
import {
	buildLogDetail,
	discoverLogFiles,
	filterEvents,
	logsCommand,
	parseLogFile,
	pollLogTick,
} from "./logs.ts";

/**
 * Test helper: capture stdout during command execution.
 * Since logsCommand writes to process.stdout.write, we temporarily replace it.
 */
async function captureStdout(fn: () => Promise<void>): Promise<string> {
	let output = "";
	const originalWrite = process.stdout.write;

	process.stdout.write = ((chunk: string) => {
		output += chunk;
		return true;
	}) as typeof process.stdout.write;

	try {
		await fn();
	} finally {
		process.stdout.write = originalWrite;
	}

	return output;
}

describe("logsCommand", () => {
	let tmpDir: string;
	let originalCwd: string;

	beforeEach(async () => {
		// Create a temp directory for each test
		tmpDir = join(
			tmpdir(),
			`overstory-logs-test-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
		);
		await mkdir(tmpDir, { recursive: true });

		// Save original cwd and change to tmpDir so loadConfig finds our test config
		originalCwd = process.cwd();
		process.chdir(tmpDir);
	});

	afterEach(async () => {
		// Restore cwd
		process.chdir(originalCwd);

		// Clean up temp directory
		try {
			await cleanupTempDir(tmpDir);
		} catch {
			// Ignore cleanup errors
		}
	});

	/**
	 * Helper: create a minimal config.yaml in tmpDir.
	 */
	async function createConfig(): Promise<void> {
		const overstoryDir = join(tmpDir, ".overstory");
		await mkdir(overstoryDir, { recursive: true });

		const configContent = `project:
  name: test-project
  root: ${tmpDir}
  canonicalBranch: main
`;

		await writeFile(join(overstoryDir, "config.yaml"), configContent, "utf-8");
	}

	/**
	 * Helper: create an events.ndjson file for a given agent and session.
	 */
	async function createLogFile(
		agentName: string,
		sessionTimestamp: string,
		events: LogEvent[],
	): Promise<void> {
		const logsDir = join(tmpDir, ".overstory", "logs", agentName, sessionTimestamp);
		await mkdir(logsDir, { recursive: true });

		const ndjson = events.map((e) => JSON.stringify(e)).join("\n");
		await writeFile(join(logsDir, "events.ndjson"), ndjson, "utf-8");
	}

	test("shows help text", async () => {
		await createConfig();

		const output = await captureStdout(async () => {
			await logsCommand(["--help"]);
		});

		expect(output).toContain("logs");
		expect(output).toContain("--agent");
		expect(output).toContain("--level");
		expect(output).toContain("--since");
	});

	test("no logs directory returns gracefully", async () => {
		await createConfig();
		// Do NOT create logs directory

		const output = await captureStdout(async () => {
			await logsCommand([]);
		});

		expect(output).toContain("No log files found");
	});

	test("lists all entries across agents", async () => {
		await createConfig();

		const eventsAgentA: LogEvent[] = [
			{
				timestamp: "2026-01-01T10:00:00.000Z",
				level: "info",
				event: "tool.start",
				agentName: "agent-a",
				data: { toolName: "Bash" },
			},
		];

		const eventsAgentB: LogEvent[] = [
			{
				timestamp: "2026-01-02T11:00:00.000Z",
				level: "error",
				event: "spawn.failed",
				agentName: "agent-b",
				data: { errorMessage: "worktree exists" },
			},
		];

		await createLogFile("agent-a", "2026-01-01T00-00-00-000Z", eventsAgentA);
		await createLogFile("agent-b", "2026-01-02T00-00-00-000Z", eventsAgentB);

		const output = await captureStdout(async () => {
			await logsCommand([]);
		});

		expect(output).toContain("tool.start");
		expect(output).toContain("agent-a");
		expect(output).toContain("spawn.failed");
		expect(output).toContain("agent-b");
		expect(output).toContain("2 entries");
	});

	test("filters by agent", async () => {
		await createConfig();

		const eventsAgentA: LogEvent[] = [
			{
				timestamp: "2026-01-01T10:00:00.000Z",
				level: "info",
				event: "tool.start",
				agentName: "agent-a",
				data: {},
			},
		];

		const eventsAgentB: LogEvent[] = [
			{
				timestamp: "2026-01-02T11:00:00.000Z",
				level: "info",
				event: "worker.done",
				agentName: "agent-b",
				data: {},
			},
		];

		await createLogFile("agent-a", "2026-01-01T00-00-00-000Z", eventsAgentA);
		await createLogFile("agent-b", "2026-01-02T00-00-00-000Z", eventsAgentB);

		const output = await captureStdout(async () => {
			await logsCommand(["--agent", "agent-a"]);
		});

		expect(output).toContain("tool.start");
		expect(output).toContain("agent-a");
		expect(output).not.toContain("worker.done");
		expect(output).not.toContain("agent-b");
	});

	test("filters by level", async () => {
		await createConfig();

		const events: LogEvent[] = [
			{
				timestamp: "2026-01-01T10:00:00.000Z",
				level: "info",
				event: "info.event",
				agentName: "agent-a",
				data: {},
			},
			{
				timestamp: "2026-01-01T10:01:00.000Z",
				level: "error",
				event: "error.event",
				agentName: "agent-a",
				data: {},
			},
			{
				timestamp: "2026-01-01T10:02:00.000Z",
				level: "warn",
				event: "warn.event",
				agentName: "agent-a",
				data: {},
			},
		];

		await createLogFile("agent-a", "2026-01-01T00-00-00-000Z", events);

		const output = await captureStdout(async () => {
			await logsCommand(["--level", "error"]);
		});

		expect(output).toContain("error.event");
		expect(output).not.toContain("info.event");
		expect(output).not.toContain("warn.event");
		expect(output).toContain("1 entry");
	});

	test("respects --limit", async () => {
		await createConfig();

		const events: LogEvent[] = [];
		for (let i = 0; i < 10; i++) {
			events.push({
				timestamp: `2026-01-01T10:${i.toString().padStart(2, "0")}:00.000Z`,
				level: "info",
				event: `event-${i}`,
				agentName: "agent-a",
				data: {},
			});
		}

		await createLogFile("agent-a", "2026-01-01T00-00-00-000Z", events);

		const output = await captureStdout(async () => {
			await logsCommand(["--limit", "3"]);
		});

		// Should show the 3 most recent entries (event-7, event-8, event-9)
		expect(output).toContain("3 entries");
		expect(output).toContain("event-7");
		expect(output).toContain("event-8");
		expect(output).toContain("event-9");
		expect(output).not.toContain("event-0");
		expect(output).not.toContain("event-6");
	});

	test("JSON output", async () => {
		await createConfig();

		const events: LogEvent[] = [
			{
				timestamp: "2026-01-01T10:00:00.000Z",
				level: "info",
				event: "tool.start",
				agentName: "agent-a",
				data: { toolName: "Bash" },
			},
			{
				timestamp: "2026-01-02T11:00:00.000Z",
				level: "error",
				event: "spawn.failed",
				agentName: "agent-b",
				data: { errorMessage: "worktree exists" },
			},
		];

		await createLogFile("agent-a", "2026-01-01T00-00-00-000Z", [events[0] as LogEvent]);
		await createLogFile("agent-b", "2026-01-02T00-00-00-000Z", [events[1] as LogEvent]);

		const output = await captureStdout(async () => {
			await logsCommand(["--json"]);
		});

		// Parse JSON output
		const parsed = JSON.parse(output.trim()) as { entries: LogEvent[] };
		expect(Array.isArray(parsed.entries)).toBe(true);

		expect(parsed.entries).toHaveLength(2);
		expect(parsed.entries[0]?.event).toBe("tool.start");
		expect(parsed.entries[1]?.event).toBe("spawn.failed");
	});

	test("filters by --since with ISO timestamp", async () => {
		await createConfig();

		const events: LogEvent[] = [
			{
				timestamp: "2026-01-01T10:00:00.000Z",
				level: "info",
				event: "event-10:00",
				agentName: "agent-a",
				data: {},
			},
			{
				timestamp: "2026-01-01T11:00:00.000Z",
				level: "info",
				event: "event-11:00",
				agentName: "agent-a",
				data: {},
			},
			{
				timestamp: "2026-01-01T12:00:00.000Z",
				level: "info",
				event: "event-12:00",
				agentName: "agent-a",
				data: {},
			},
		];

		await createLogFile("agent-a", "2026-01-01T00-00-00-000Z", events);

		const output = await captureStdout(async () => {
			await logsCommand(["--since", "2026-01-01T11:00:00.000Z"]);
		});

		expect(output).toContain("event-11:00");
		expect(output).toContain("event-12:00");
		expect(output).not.toContain("event-10:00");
		expect(output).toContain("2 entries");
	});

	test("invalid level throws ValidationError", async () => {
		await createConfig();

		await expect(
			captureStdout(async () => {
				await logsCommand(["--level", "critical"]);
			}),
		).rejects.toThrow(ValidationError);
	});

	test("invalid limit throws ValidationError", async () => {
		await createConfig();

		await expect(
			captureStdout(async () => {
				await logsCommand(["--limit", "abc"]);
			}),
		).rejects.toThrow(ValidationError);
	});

	test("handles malformed NDJSON lines gracefully", async () => {
		await createConfig();

		const logsDir = join(tmpDir, ".overstory", "logs", "agent-a", "2026-01-01T00-00-00-000Z");
		await mkdir(logsDir, { recursive: true });

		// Write mixed valid and invalid NDJSON lines
		const mixedContent = `{"timestamp":"2026-01-01T10:00:00.000Z","level":"info","event":"valid-event-1","agentName":"agent-a","data":{}}
this is not json
{"timestamp":"2026-01-01T10:01:00.000Z","level":"info","event":"valid-event-2","agentName":"agent-a","data":{}}
{"incomplete": "object"
{"timestamp":"2026-01-01T10:02:00.000Z","level":"info","event":"valid-event-3","agentName":"agent-a","data":{}}
`;

		await writeFile(join(logsDir, "events.ndjson"), mixedContent, "utf-8");

		const output = await captureStdout(async () => {
			await logsCommand([]);
		});

		// Should show the 3 valid events, silently skip the malformed lines
		expect(output).toContain("valid-event-1");
		expect(output).toContain("valid-event-2");
		expect(output).toContain("valid-event-3");
		expect(output).toContain("3 entries");
		expect(output).not.toContain("this is not json");
	});
});

// parseRelativeTime tests moved to src/utils/time.test.ts

describe("buildLogDetail", () => {
	test("builds key=value pairs from data fields", () => {
		const event: LogEvent = {
			timestamp: "2026-01-01T00:00:00Z",
			level: "info",
			event: "test",
			agentName: "a",
			data: { toolName: "Bash", file: "index.ts" },
		};
		const result = buildLogDetail(event);
		expect(result).toContain("toolName=Bash");
		expect(result).toContain("file=index.ts");
	});

	test("truncates values longer than 80 characters", () => {
		const longValue = "x".repeat(100);
		const event: LogEvent = {
			timestamp: "2026-01-01T00:00:00Z",
			level: "info",
			event: "test",
			agentName: "a",
			data: { message: longValue },
		};
		const result = buildLogDetail(event);
		expect(result).not.toContain(longValue);
		expect(result).toContain("...");
		// 77 chars + "..." = 80
		expect(result).toContain("x".repeat(77));
	});

	test("skips null and undefined values", () => {
		const event: LogEvent = {
			timestamp: "2026-01-01T00:00:00Z",
			level: "info",
			event: "test",
			agentName: "a",
			data: { present: "yes", missing: null, also: undefined },
		};
		const result = buildLogDetail(event);
		expect(result).toContain("present=yes");
		expect(result).not.toContain("missing");
		expect(result).not.toContain("also");
	});

	test("returns empty string for empty data", () => {
		const event: LogEvent = {
			timestamp: "2026-01-01T00:00:00Z",
			level: "info",
			event: "test",
			agentName: "a",
			data: {},
		};
		expect(buildLogDetail(event)).toBe("");
	});

	test("stringifies non-string values as JSON", () => {
		const event: LogEvent = {
			timestamp: "2026-01-01T00:00:00Z",
			level: "info",
			event: "test",
			agentName: "a",
			data: { count: 42, active: true },
		};
		const result = buildLogDetail(event);
		expect(result).toContain("count=42");
		expect(result).toContain("active=true");
	});
});

describe("discoverLogFiles", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = join(
			tmpdir(),
			`overstory-discover-test-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
		);
		await mkdir(tmpDir, { recursive: true });
	});

	afterEach(async () => {
		await cleanupTempDir(tmpDir);
	});

	test("discovers log files in proper agent/session structure", async () => {
		// Create agent-a/session-1/events.ndjson
		const dir1 = join(tmpDir, "agent-a", "2026-01-01T00-00-00");
		await mkdir(dir1, { recursive: true });
		await writeFile(join(dir1, "events.ndjson"), "{}");

		// Create agent-b/session-2/events.ndjson
		const dir2 = join(tmpDir, "agent-b", "2026-01-02T00-00-00");
		await mkdir(dir2, { recursive: true });
		await writeFile(join(dir2, "events.ndjson"), "{}");

		const result = await discoverLogFiles(tmpDir);
		expect(result).toHaveLength(2);
		expect(result[0]?.agentName).toBe("agent-a");
		expect(result[1]?.agentName).toBe("agent-b");
	});

	test("filters by agent name when provided", async () => {
		const dir1 = join(tmpDir, "agent-a", "2026-01-01T00-00-00");
		await mkdir(dir1, { recursive: true });
		await writeFile(join(dir1, "events.ndjson"), "{}");

		const dir2 = join(tmpDir, "agent-b", "2026-01-02T00-00-00");
		await mkdir(dir2, { recursive: true });
		await writeFile(join(dir2, "events.ndjson"), "{}");

		const result = await discoverLogFiles(tmpDir, "agent-a");
		expect(result).toHaveLength(1);
		expect(result[0]?.agentName).toBe("agent-a");
	});

	test("returns empty array for nonexistent directory", async () => {
		const result = await discoverLogFiles(join(tmpDir, "nonexistent"));
		expect(result).toEqual([]);
	});

	test("sorts by session timestamp", async () => {
		const dir1 = join(tmpDir, "agent-a", "2026-01-02T00-00-00");
		await mkdir(dir1, { recursive: true });
		await writeFile(join(dir1, "events.ndjson"), "{}");

		const dir2 = join(tmpDir, "agent-a", "2026-01-01T00-00-00");
		await mkdir(dir2, { recursive: true });
		await writeFile(join(dir2, "events.ndjson"), "{}");

		const result = await discoverLogFiles(tmpDir);
		expect(result[0]?.sessionTimestamp).toBe("2026-01-01T00-00-00");
		expect(result[1]?.sessionTimestamp).toBe("2026-01-02T00-00-00");
	});
});

describe("parseLogFile", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = join(
			tmpdir(),
			`overstory-parse-test-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
		);
		await mkdir(tmpDir, { recursive: true });
	});

	afterEach(async () => {
		await cleanupTempDir(tmpDir);
	});

	test("parses valid NDJSON lines", async () => {
		const filePath = join(tmpDir, "events.ndjson");
		const lines = [
			JSON.stringify({
				timestamp: "2026-01-01T10:00:00Z",
				event: "tool.start",
				level: "info",
				agentName: "a",
				data: {},
			}),
			JSON.stringify({
				timestamp: "2026-01-01T10:01:00Z",
				event: "tool.end",
				level: "info",
				agentName: "a",
				data: {},
			}),
		];
		await writeFile(filePath, lines.join("\n"));

		const events = await parseLogFile(filePath);
		expect(events).toHaveLength(2);
		expect(events[0]?.event).toBe("tool.start");
		expect(events[1]?.event).toBe("tool.end");
	});

	test("skips malformed JSON lines silently", async () => {
		const filePath = join(tmpDir, "events.ndjson");
		const content = [
			JSON.stringify({
				timestamp: "2026-01-01T10:00:00Z",
				event: "valid",
				level: "info",
				agentName: "a",
				data: {},
			}),
			"not valid json",
			'{"incomplete": true',
			JSON.stringify({
				timestamp: "2026-01-01T10:02:00Z",
				event: "also-valid",
				level: "info",
				agentName: "a",
				data: {},
			}),
		].join("\n");
		await writeFile(filePath, content);

		const events = await parseLogFile(filePath);
		expect(events).toHaveLength(2);
		expect(events[0]?.event).toBe("valid");
		expect(events[1]?.event).toBe("also-valid");
	});

	test("returns empty array for nonexistent file", async () => {
		const events = await parseLogFile(join(tmpDir, "nonexistent.ndjson"));
		expect(events).toEqual([]);
	});

	test("skips objects missing required fields", async () => {
		const filePath = join(tmpDir, "events.ndjson");
		const content = [
			JSON.stringify({ timestamp: "2026-01-01T00:00:00Z" }), // missing "event"
			JSON.stringify({ event: "test" }), // missing "timestamp"
			JSON.stringify({
				timestamp: "2026-01-01T00:00:00Z",
				event: "good",
				level: "info",
				agentName: "a",
				data: {},
			}),
		].join("\n");
		await writeFile(filePath, content);

		const events = await parseLogFile(filePath);
		expect(events).toHaveLength(1);
		expect(events[0]?.event).toBe("good");
	});
});

describe("filterEvents", () => {
	const baseEvents: LogEvent[] = [
		{
			timestamp: "2026-01-01T10:00:00.000Z",
			level: "info",
			event: "e1",
			agentName: "a",
			data: {},
		},
		{
			timestamp: "2026-01-01T11:00:00.000Z",
			level: "error",
			event: "e2",
			agentName: "a",
			data: {},
		},
		{
			timestamp: "2026-01-01T12:00:00.000Z",
			level: "warn",
			event: "e3",
			agentName: "a",
			data: {},
		},
		{
			timestamp: "2026-01-01T13:00:00.000Z",
			level: "debug",
			event: "e4",
			agentName: "a",
			data: {},
		},
	];

	test("filters by level", () => {
		const result = filterEvents(baseEvents, { level: "error" });
		expect(result).toHaveLength(1);
		expect(result[0]?.event).toBe("e2");
	});

	test("filters by since", () => {
		const since = new Date("2026-01-01T11:30:00.000Z");
		const result = filterEvents(baseEvents, { since });
		expect(result).toHaveLength(2);
		expect(result[0]?.event).toBe("e3");
		expect(result[1]?.event).toBe("e4");
	});

	test("filters by until", () => {
		const until = new Date("2026-01-01T11:30:00.000Z");
		const result = filterEvents(baseEvents, { until });
		expect(result).toHaveLength(2);
		expect(result[0]?.event).toBe("e1");
		expect(result[1]?.event).toBe("e2");
	});

	test("combines level + since + until", () => {
		const result = filterEvents(baseEvents, {
			level: "info",
			since: new Date("2026-01-01T09:00:00.000Z"),
			until: new Date("2026-01-01T10:30:00.000Z"),
		});
		expect(result).toHaveLength(1);
		expect(result[0]?.event).toBe("e1");
	});

	test("returns all events with no filters", () => {
		const result = filterEvents(baseEvents, {});
		expect(result).toHaveLength(4);
	});
});

describe("pollLogTick", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = join(
			tmpdir(),
			`overstory-poll-test-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
		);
		await mkdir(tmpDir, { recursive: true });
	});

	afterEach(async () => {
		await cleanupTempDir(tmpDir);
	});

	test("returns 0 for empty files", async () => {
		const filePath = join(tmpDir, "events.ndjson");
		await writeFile(filePath, "");

		const lastKnownSizes = new Map<string, number>();
		const count = await pollLogTick([{ path: filePath }], lastKnownSizes, {});
		expect(count).toBe(0);
	});

	test("returns count of new events from file with new lines", async () => {
		const filePath = join(tmpDir, "events.ndjson");
		const line1 = JSON.stringify({
			timestamp: "2026-01-01T10:00:00Z",
			event: "e1",
			level: "info",
			agentName: "a",
			data: {},
		});
		const line2 = JSON.stringify({
			timestamp: "2026-01-01T10:01:00Z",
			event: "e2",
			level: "info",
			agentName: "a",
			data: {},
		});
		await writeFile(filePath, `${line1}\n${line2}\n`);

		const lastKnownSizes = new Map<string, number>();
		// Capture stdout to prevent test noise
		const origWrite = process.stdout.write;
		process.stdout.write = (() => true) as typeof process.stdout.write;
		try {
			const count = await pollLogTick([{ path: filePath }], lastKnownSizes, {});
			expect(count).toBe(2);
			// lastKnownSizes should be updated
			expect(lastKnownSizes.get(filePath)).toBeGreaterThan(0);
		} finally {
			process.stdout.write = origWrite;
		}
	});

	test("returns 0 when no new data since last position", async () => {
		const filePath = join(tmpDir, "events.ndjson");
		const line = JSON.stringify({
			timestamp: "2026-01-01T10:00:00Z",
			event: "e1",
			level: "info",
			agentName: "a",
			data: {},
		});
		await writeFile(filePath, `${line}\n`);

		const lastKnownSizes = new Map<string, number>();
		const origWrite = process.stdout.write;
		process.stdout.write = (() => true) as typeof process.stdout.write;
		try {
			// First tick reads everything
			await pollLogTick([{ path: filePath }], lastKnownSizes, {});
			// Second tick should find nothing new
			const count = await pollLogTick([{ path: filePath }], lastKnownSizes, {});
			expect(count).toBe(0);
		} finally {
			process.stdout.write = origWrite;
		}
	});

	test("applies level filter", async () => {
		const filePath = join(tmpDir, "events.ndjson");
		const line1 = JSON.stringify({
			timestamp: "2026-01-01T10:00:00Z",
			event: "e1",
			level: "info",
			agentName: "a",
			data: {},
		});
		const line2 = JSON.stringify({
			timestamp: "2026-01-01T10:01:00Z",
			event: "e2",
			level: "error",
			agentName: "a",
			data: {},
		});
		await writeFile(filePath, `${line1}\n${line2}\n`);

		const lastKnownSizes = new Map<string, number>();
		const origWrite = process.stdout.write;
		process.stdout.write = (() => true) as typeof process.stdout.write;
		try {
			const count = await pollLogTick([{ path: filePath }], lastKnownSizes, {
				level: "error",
			});
			expect(count).toBe(1);
		} finally {
			process.stdout.write = origWrite;
		}
	});
});

/**
 * Tests for the NDJSON event tailer (src/events/tailer.ts).
 *
 * Uses real filesystem (temp directories via mkdtemp) and real EventStore
 * (bun:sqlite in-memory or temp file) per the project's "never mock what you
 * can use for real" philosophy.
 *
 * The tailer uses setTimeout-based polling, which is exercised by letting
 * timers fire naturally in async tests rather than using fake timers.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTempDir } from "../test-helpers.ts";
import type { EventStore } from "../types.ts";
import { createEventStore } from "./store.ts";
import type { TailerHandle, TailerOptions } from "./tailer.ts";
import { findLatestStdoutLog, startEventTailer } from "./tailer.ts";

// === Helpers ===

/** Create a temp directory to use as a fake .overstory/ root. */
async function createTempDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), "overstory-tailer-test-"));
}

/**
 * Create a fake agent log directory structure:
 *   <overstoryDir>/logs/<agentName>/<timestamp>/stdout.log
 * Returns the path to stdout.log.
 */
async function createAgentLogDir(
	overstoryDir: string,
	agentName: string,
	timestamp = "2026-03-05T14-52-26-089Z",
): Promise<string> {
	const logDir = join(overstoryDir, "logs", agentName, timestamp);
	await mkdir(logDir, { recursive: true });
	const logPath = join(logDir, "stdout.log");
	// Create an empty file so Bun.file().exists() returns true.
	await writeFile(logPath, "");
	return logPath;
}

/** Wait at most maxMs for a condition to become true, polling every pollMs. */
async function waitFor(
	condition: () => boolean | Promise<boolean>,
	maxMs = 3000,
	pollMs = 50,
): Promise<void> {
	const deadline = Date.now() + maxMs;
	while (Date.now() < deadline) {
		if (await condition()) return;
		await new Promise((resolve) => setTimeout(resolve, pollMs));
	}
	throw new Error(`waitFor timed out after ${maxMs}ms`);
}

// === Tests ===

describe("findLatestStdoutLog", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await createTempDir();
	});

	afterEach(async () => {
		await cleanupTempDir(tmpDir);
	});

	test("returns null when agent log directory does not exist", async () => {
		const result = await findLatestStdoutLog(tmpDir, "no-such-agent");
		expect(result).toBeNull();
	});

	test("returns null when agent log directory is empty", async () => {
		const agentLogsDir = join(tmpDir, "logs", "my-agent");
		await mkdir(agentLogsDir, { recursive: true });
		const result = await findLatestStdoutLog(tmpDir, "my-agent");
		expect(result).toBeNull();
	});

	test("returns null when latest dir has no stdout.log", async () => {
		const logDir = join(tmpDir, "logs", "my-agent", "2026-03-05T14-52-26-089Z");
		await mkdir(logDir, { recursive: true });
		// Directory exists but no stdout.log inside.
		const result = await findLatestStdoutLog(tmpDir, "my-agent");
		expect(result).toBeNull();
	});

	test("returns path to stdout.log in the only session directory", async () => {
		const logPath = await createAgentLogDir(tmpDir, "my-agent");
		const result = await findLatestStdoutLog(tmpDir, "my-agent");
		expect(result).toBe(logPath);
	});

	test("returns the lexicographically latest session directory", async () => {
		// Create three session dirs — the last in sorted order should win.
		await createAgentLogDir(tmpDir, "my-agent", "2026-03-04T10-00-00-000Z");
		await createAgentLogDir(tmpDir, "my-agent", "2026-03-05T08-00-00-000Z");
		const latest = await createAgentLogDir(tmpDir, "my-agent", "2026-03-05T14-52-26-089Z");
		const result = await findLatestStdoutLog(tmpDir, "my-agent");
		expect(result).toBe(latest);
	});
});

describe("startEventTailer", () => {
	let tmpDir: string;
	let eventStore: EventStore;
	let eventsDbPath: string;

	beforeEach(async () => {
		tmpDir = await createTempDir();
		eventsDbPath = join(tmpDir, "events.db");
		eventStore = createEventStore(eventsDbPath);
	});

	afterEach(async () => {
		eventStore.close();
		await cleanupTempDir(tmpDir);
	});

	test("stop() is idempotent — calling twice does not throw", async () => {
		const logPath = await createAgentLogDir(tmpDir, "agent-a");
		const handle = startEventTailer({
			stdoutLogPath: logPath,
			agentName: "agent-a",
			runId: null,
			eventsDbPath,
			_eventStore: eventStore,
		});
		handle.stop();
		handle.stop(); // Should not throw.
	});

	test("handle exposes agentName and logPath", async () => {
		const logPath = await createAgentLogDir(tmpDir, "agent-b");
		const handle = startEventTailer({
			stdoutLogPath: logPath,
			agentName: "agent-b",
			runId: null,
			eventsDbPath,
			_eventStore: eventStore,
		});
		try {
			expect(handle.agentName).toBe("agent-b");
			expect(handle.logPath).toBe(logPath);
		} finally {
			handle.stop();
		}
	});

	test("parses NDJSON lines and writes events to EventStore", async () => {
		const logPath = await createAgentLogDir(tmpDir, "agent-c");

		// Write some NDJSON events to the log file.
		const lines = `${[
			JSON.stringify({ type: "turn_start", timestamp: new Date().toISOString() }),
			JSON.stringify({
				type: "tool_start",
				tool: "Read",
				timestamp: new Date().toISOString(),
			}),
			JSON.stringify({
				type: "tool_end",
				tool: "Read",
				duration_ms: 42,
				timestamp: new Date().toISOString(),
			}),
			JSON.stringify({ type: "turn_end", timestamp: new Date().toISOString() }),
		].join("\n")}\n`;

		await writeFile(logPath, lines);

		const handle = startEventTailer({
			stdoutLogPath: logPath,
			agentName: "agent-c",
			runId: "run-1",
			eventsDbPath,
			pollIntervalMs: 50,
			_eventStore: eventStore,
		});

		try {
			// Wait until all 4 events appear in the store.
			await waitFor(() => {
				const events = eventStore.getByAgent("agent-c");
				return events.length >= 4;
			});

			const events = eventStore.getByAgent("agent-c");
			const types = events.map((e) => e.eventType);
			expect(types).toContain("turn_start");
			expect(types).toContain("tool_start");
			expect(types).toContain("tool_end");
			expect(types).toContain("turn_end");

			// Verify tool_end carries duration_ms.
			const toolEnd = events.find((e) => e.eventType === "tool_end");
			expect(toolEnd?.toolDurationMs).toBe(42);

			// Verify tool_start carries toolName.
			const toolStart = events.find((e) => e.eventType === "tool_start");
			expect(toolStart?.toolName).toBe("Read");

			// Verify runId propagation.
			for (const event of events) {
				expect(event.runId).toBe("run-1");
				expect(event.agentName).toBe("agent-c");
			}
		} finally {
			handle.stop();
		}
	});

	test("tails new content appended after tailer starts", async () => {
		const logPath = await createAgentLogDir(tmpDir, "agent-d");

		// Start with an empty file.
		const handle = startEventTailer({
			stdoutLogPath: logPath,
			agentName: "agent-d",
			runId: null,
			eventsDbPath,
			pollIntervalMs: 50,
			_eventStore: eventStore,
		});

		try {
			// Append a first event.
			const event1 = `${JSON.stringify({ type: "turn_start", timestamp: new Date().toISOString() })}\n`;
			await writeFile(logPath, event1);

			await waitFor(() => eventStore.getByAgent("agent-d").length >= 1);
			expect(eventStore.getByAgent("agent-d")).toHaveLength(1);

			// Append a second event to the same file (simulate ongoing output).
			const event2 = `${JSON.stringify({ type: "turn_end", timestamp: new Date().toISOString() })}\n`;
			// BunFile.size updates on disk; we must append to get new bytes.
			const existing = await Bun.file(logPath).text();
			await writeFile(logPath, existing + event2);

			await waitFor(() => eventStore.getByAgent("agent-d").length >= 2);
			expect(eventStore.getByAgent("agent-d")).toHaveLength(2);
		} finally {
			handle.stop();
		}
	});

	test("silently skips malformed (non-JSON) lines", async () => {
		const logPath = await createAgentLogDir(tmpDir, "agent-e");

		const content = `${[
			"not json at all",
			JSON.stringify({ type: "result", timestamp: new Date().toISOString() }),
			"{incomplete",
		].join("\n")}\n`;

		await writeFile(logPath, content);

		const handle = startEventTailer({
			stdoutLogPath: logPath,
			agentName: "agent-e",
			runId: null,
			eventsDbPath,
			pollIntervalMs: 50,
			_eventStore: eventStore,
		});

		try {
			// Only the valid JSON line should appear.
			await waitFor(() => eventStore.getByAgent("agent-e").length >= 1);
			const events = eventStore.getByAgent("agent-e");
			expect(events).toHaveLength(1);
			expect(events[0]?.eventType).toBe("result");
		} finally {
			handle.stop();
		}
	});

	test("maps error events to error level", async () => {
		const logPath = await createAgentLogDir(tmpDir, "agent-f");

		const content = `${JSON.stringify({ type: "error", message: "boom", timestamp: new Date().toISOString() })}\n`;
		await writeFile(logPath, content);

		const handle = startEventTailer({
			stdoutLogPath: logPath,
			agentName: "agent-f",
			runId: null,
			eventsDbPath,
			pollIntervalMs: 50,
			_eventStore: eventStore,
		});

		try {
			await waitFor(() => eventStore.getByAgent("agent-f").length >= 1);
			const events = eventStore.getByAgent("agent-f");
			expect(events[0]?.level).toBe("error");
			expect(events[0]?.eventType).toBe("error");
		} finally {
			handle.stop();
		}
	});

	test("unknown event types map to 'custom'", async () => {
		const logPath = await createAgentLogDir(tmpDir, "agent-g");

		const content = `${JSON.stringify({ type: "some_future_type", timestamp: new Date().toISOString() })}\n`;
		await writeFile(logPath, content);

		const handle = startEventTailer({
			stdoutLogPath: logPath,
			agentName: "agent-g",
			runId: null,
			eventsDbPath,
			pollIntervalMs: 50,
			_eventStore: eventStore,
		});

		try {
			await waitFor(() => eventStore.getByAgent("agent-g").length >= 1);
			const events = eventStore.getByAgent("agent-g");
			expect(events[0]?.eventType).toBe("custom");
		} finally {
			handle.stop();
		}
	});

	test("does not crash when log file does not exist yet", async () => {
		// Non-existent log path — tailer should silently poll without errors.
		const logPath = join(tmpDir, "logs", "agent-h", "2026-03-05T00-00-00-000Z", "stdout.log");

		const handle = startEventTailer({
			stdoutLogPath: logPath,
			agentName: "agent-h",
			runId: null,
			eventsDbPath,
			pollIntervalMs: 50,
			_eventStore: eventStore,
		});

		// Wait a couple poll cycles to ensure no crash.
		await new Promise((resolve) => setTimeout(resolve, 150));
		handle.stop();

		// No events should have been written.
		expect(eventStore.getByAgent("agent-h")).toHaveLength(0);
	});
});

describe("daemon tailer integration", () => {
	/**
	 * Verify that the daemon wires tailer start/stop correctly using DI.
	 * This test exercises the daemon's tailer management logic with injected
	 * mocks rather than actual polling — the tailer behaviour itself is tested
	 * above in the startEventTailer suite.
	 */
	test("daemon starts a tailer for headless sessions and stops it when completed", async () => {
		const tmpDir = await createTempDir();
		const overstoryDir = join(tmpDir, ".overstory");
		await mkdir(overstoryDir, { recursive: true });

		// Create a minimal log structure so findLatestStdoutLog succeeds.
		const agentName = "headless-agent";
		const logPath = await createAgentLogDir(overstoryDir, agentName);

		// Use a registry we control.
		const registry = new Map<string, { agentName: string; logPath: string; stop: () => void }>();
		const stopped: string[] = [];

		const tailerFactory = (opts: {
			stdoutLogPath: string;
			agentName: string;
			runId: string | null;
			eventsDbPath: string;
		}) => {
			const handle = {
				agentName: opts.agentName,
				logPath: opts.stdoutLogPath,
				stop: () => {
					stopped.push(opts.agentName);
					registry.delete(opts.agentName);
				},
			};
			return handle;
		};

		// Write a headless session.
		const { createSessionStore } = await import("../sessions/store.ts");
		const sessionStore = createSessionStore(join(overstoryDir, "sessions.db"));
		sessionStore.upsert({
			id: "sess-1",
			agentName,
			capability: "builder",
			worktreePath: tmpDir,
			branchName: "test-branch",
			taskId: "task-1",
			tmuxSession: "", // headless
			state: "working",
			pid: process.pid,
			parentAgent: null,
			depth: 0,
			runId: null,
			startedAt: new Date().toISOString(),
			lastActivity: new Date().toISOString(),
			escalationLevel: 0,
			stalledSince: null,
			transcriptPath: null,
			runtime: "claude",
			rateLimitedSince: null,
		});
		sessionStore.close();

		const { runDaemonTick } = await import("../watchdog/daemon.ts");

		// First tick: should start a tailer for the headless session.
		await runDaemonTick({
			root: tmpDir,
			staleThresholdMs: 300_000,
			zombieThresholdMs: 600_000,
			_tmux: { isSessionAlive: async () => false, killSession: async () => {} },
			_triage: async () => "extend",
			_nudge: async () => ({ delivered: false }),
			_eventStore: null,
			_recordFailure: async () => {},
			_tailerRegistry: registry as unknown as Map<string, TailerHandle>,
			_tailerFactory: tailerFactory as unknown as (opts: TailerOptions) => TailerHandle,
			_findLatestStdoutLog: async () => logPath,
		});

		expect(registry.has(agentName)).toBe(true);
		expect(stopped).toHaveLength(0);

		// Mark session as completed.
		const store2 = createSessionStore(join(overstoryDir, "sessions.db"));
		store2.updateState(agentName, "completed");
		store2.close();

		// Second tick: completed session is skipped, tailer should be stopped.
		await runDaemonTick({
			root: tmpDir,
			staleThresholdMs: 300_000,
			zombieThresholdMs: 600_000,
			_tmux: { isSessionAlive: async () => false, killSession: async () => {} },
			_triage: async () => "extend",
			_nudge: async () => ({ delivered: false }),
			_eventStore: null,
			_recordFailure: async () => {},
			_tailerRegistry: registry as unknown as Map<string, TailerHandle>,
			_tailerFactory: tailerFactory as unknown as (opts: TailerOptions) => TailerHandle,
			_findLatestStdoutLog: async () => logPath,
		});

		expect(stopped).toContain(agentName);
		expect(registry.has(agentName)).toBe(false);

		await cleanupTempDir(tmpDir);
	});
});

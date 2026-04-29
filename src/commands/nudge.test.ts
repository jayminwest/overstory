import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventStore } from "../events/store.ts";
import { removeConnection, setConnection } from "../runtimes/connections.ts";
import type { NudgeableConnection, NudgeResult } from "../runtimes/headless-connection.ts";
import { createSessionStore } from "../sessions/store.ts";
import { cleanupTempDir } from "../test-helpers.ts";
import type { AgentSession, StoredEvent } from "../types.ts";

/**
 * Tests for the nudge command's debounce and session lookup logic.
 *
 * We test the pure/file-based functions directly rather than the full
 * nudgeCommand (which requires real tmux sessions). Tmux interaction
 * is tested via E2E.
 */

let tempDir: string;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), "nudge-test-"));
});

afterEach(async () => {
	await cleanupTempDir(tempDir);
});

/**
 * Helper to write sessions to SessionStore (sessions.db) for testing.
 */
function writeSessionsToStore(projectRoot: string, sessions: AgentSession[]): void {
	const dir = join(projectRoot, ".overstory");
	mkdirSync(dir, { recursive: true });
	const dbPath = join(dir, "sessions.db");
	const store = createSessionStore(dbPath);
	for (const session of sessions) {
		store.upsert(session);
	}
	store.close();
}

function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
	return {
		id: "session-123-test-agent",
		agentName: "test-agent",
		capability: "builder",
		worktreePath: "/tmp/wt",
		branchName: "overstory/test-agent/task-1",
		taskId: "task-1",
		tmuxSession: "overstory-test-agent",
		state: "working",
		pid: 12345,
		parentAgent: null,
		depth: 0,
		runId: null,
		startedAt: new Date().toISOString(),
		lastActivity: new Date().toISOString(),
		escalationLevel: 0,
		stalledSince: null,
		transcriptPath: null,
		...overrides,
	};
}

describe("nudgeAgent", () => {
	// We dynamically import to avoid circular issues
	async function importNudge() {
		return await import("./nudge.ts");
	}

	test("returns error when no active session exists", async () => {
		writeSessionsToStore(tempDir, []);
		const { nudgeAgent } = await importNudge();
		const result = await nudgeAgent(tempDir, "nonexistent-agent");
		expect(result.delivered).toBe(false);
		expect(result.reason).toContain("No active session");
	});

	test("returns error when agent is zombie", async () => {
		writeSessionsToStore(tempDir, [makeSession({ state: "zombie" })]);
		const { nudgeAgent } = await importNudge();
		const result = await nudgeAgent(tempDir, "test-agent");
		expect(result.delivered).toBe(false);
		expect(result.reason).toContain("No active session");
	});

	test("returns error when agent is completed", async () => {
		writeSessionsToStore(tempDir, [makeSession({ state: "completed" })]);
		const { nudgeAgent } = await importNudge();
		const result = await nudgeAgent(tempDir, "test-agent");
		expect(result.delivered).toBe(false);
		expect(result.reason).toContain("No active session");
	});

	test("finds active agent in working state", async () => {
		writeSessionsToStore(tempDir, [makeSession({ state: "working" })]);
		const { nudgeAgent } = await importNudge();
		// This will fail on sendKeys (no real tmux) but should get past session lookup
		const result = await nudgeAgent(tempDir, "test-agent");
		// Will fail because tmux session doesn't exist, but we validated session lookup works
		expect(result.delivered).toBe(false);
		expect(result.reason).toContain("not alive");
	});

	test("finds active agent in booting state", async () => {
		writeSessionsToStore(tempDir, [makeSession({ state: "booting" })]);
		const { nudgeAgent } = await importNudge();
		const result = await nudgeAgent(tempDir, "test-agent");
		expect(result.delivered).toBe(false);
		expect(result.reason).toContain("not alive");
	});

	test("handles missing sessions.db gracefully", async () => {
		// Create .overstory dir but no sessions.db — SessionStore will be created empty
		mkdirSync(join(tempDir, ".overstory"), { recursive: true });
		const { nudgeAgent } = await importNudge();
		const result = await nudgeAgent(tempDir, "test-agent");
		expect(result.delivered).toBe(false);
		expect(result.reason).toContain("No active session");
	});

	test("resolves orchestrator from orchestrator-tmux.json fallback", async () => {
		// No sessions.db, but orchestrator-tmux.json exists
		const { mkdir } = await import("node:fs/promises");
		await mkdir(join(tempDir, ".overstory"), { recursive: true });
		await Bun.write(
			join(tempDir, ".overstory", "orchestrator-tmux.json"),
			`${JSON.stringify({ tmuxSession: "my-session", registeredAt: new Date().toISOString() }, null, "\t")}\n`,
		);

		const { nudgeAgent } = await importNudge();
		const result = await nudgeAgent(tempDir, "orchestrator");
		// Will fail at tmux alive check (no real tmux), but should get past resolution
		expect(result.delivered).toBe(false);
		expect(result.reason).toContain("not alive");
	});

	test("returns error when orchestrator has no tmux registration", async () => {
		const { mkdir } = await import("node:fs/promises");
		await mkdir(join(tempDir, ".overstory"), { recursive: true });
		// No orchestrator-tmux.json and no sessions.db entry
		const { nudgeAgent } = await importNudge();
		const result = await nudgeAgent(tempDir, "orchestrator");
		expect(result.delivered).toBe(false);
		expect(result.reason).toContain("No active session");
	});

	test("prefers sessions.db over orchestrator-tmux.json for orchestrator", async () => {
		// If orchestrator somehow appears in sessions.db, use that
		writeSessionsToStore(tempDir, [
			makeSession({
				agentName: "orchestrator",
				tmuxSession: "overstory-orchestrator",
				state: "working",
			}),
		]);
		await Bun.write(
			join(tempDir, ".overstory", "orchestrator-tmux.json"),
			`${JSON.stringify({ tmuxSession: "fallback-session" }, null, "\t")}\n`,
		);

		const { nudgeAgent } = await importNudge();
		const result = await nudgeAgent(tempDir, "orchestrator");
		// Should use sessions.db entry, fail at tmux alive check
		expect(result.delivered).toBe(false);
		expect(result.reason).toContain("overstory-orchestrator");
	});

	test("records nudge event to EventStore after delivery attempt", async () => {
		// Agent exists in SessionStore but tmux is not alive — nudge fails
		// but the event should still be recorded
		writeSessionsToStore(tempDir, [makeSession({ state: "working" })]);

		const { nudgeAgent } = await importNudge();
		const result = await nudgeAgent(tempDir, "test-agent");
		// Nudge fails because tmux session is not alive
		expect(result.delivered).toBe(false);

		// Verify event was recorded to events.db
		const eventsDbPath = join(tempDir, ".overstory", "events.db");
		const store = createEventStore(eventsDbPath);
		try {
			const events: StoredEvent[] = store.getTimeline({
				since: "2000-01-01T00:00:00Z",
			});
			const nudgeEvent = events.find((e) => {
				if (!e.data) return false;
				const data = JSON.parse(e.data) as Record<string, unknown>;
				return data.type === "nudge";
			});
			expect(nudgeEvent).toBeDefined();
			expect(nudgeEvent?.eventType).toBe("custom");
			expect(nudgeEvent?.level).toBe("info");
			expect(nudgeEvent?.agentName).toBe("test-agent");

			const data = JSON.parse(nudgeEvent?.data ?? "{}") as Record<string, unknown>;
			expect(data.delivered).toBe(false);
			expect(data.from).toBe("orchestrator");
		} finally {
			store.close();
		}
	});

	test("nudge event includes run_id when current-run.txt exists", async () => {
		writeSessionsToStore(tempDir, [makeSession({ state: "working" })]);

		// Write a current-run.txt
		const runId = "run-test-123";
		await Bun.write(join(tempDir, ".overstory", "current-run.txt"), runId);

		const { nudgeAgent } = await importNudge();
		await nudgeAgent(tempDir, "test-agent");

		const eventsDbPath = join(tempDir, ".overstory", "events.db");
		const store = createEventStore(eventsDbPath);
		try {
			const events: StoredEvent[] = store.getTimeline({
				since: "2000-01-01T00:00:00Z",
			});
			const nudgeEvent = events.find((e) => {
				if (!e.data) return false;
				const data = JSON.parse(e.data) as Record<string, unknown>;
				return data.type === "nudge";
			});
			expect(nudgeEvent).toBeDefined();
			expect(nudgeEvent?.runId).toBe(runId);
		} finally {
			store.close();
		}
	});
});

describe("nudgeAgent with headless connection", () => {
	async function importNudge() {
		return await import("./nudge.ts");
	}

	/** Build a NudgeableConnection stub that records calls. */
	function makeNudgeableConn(
		result: NudgeResult = { status: "Queued" },
		onNudge?: (text: string) => void,
	): NudgeableConnection {
		return {
			sendPrompt: async () => {},
			followUp: async () => {},
			abort: async () => {},
			getState: async () => ({ status: "idle" as const }),
			close: () => {},
			nudge: async (text: string) => {
				if (onNudge) onNudge(text);
				return result;
			},
		};
	}

	afterEach(() => {
		removeConnection("headless-test-agent");
	});

	test("routes nudge through connection.nudge() when connection exists", async () => {
		let capturedText = "";
		setConnection(
			"headless-test-agent",
			makeNudgeableConn({ status: "Queued" }, (t) => {
				capturedText = t;
			}),
		);

		const { nudgeAgent } = await importNudge();
		const result = await nudgeAgent(tempDir, "headless-test-agent", "ping", true);

		expect(result.delivered).toBe(true);
		expect(result.queued).toBe(true);
		expect(capturedText).toBe("ping");
	});

	test("queued=false when connection returns Delivered", async () => {
		setConnection("headless-test-agent", makeNudgeableConn({ status: "Delivered" }));

		const { nudgeAgent } = await importNudge();
		const result = await nudgeAgent(tempDir, "headless-test-agent", "ping", true);

		expect(result.delivered).toBe(true);
		expect(result.queued).toBe(false);
	});

	test("falls back to tmux path when connection has no nudge() method", async () => {
		// Register a plain RuntimeConnection (no nudge method)
		setConnection("headless-test-agent", {
			sendPrompt: async () => {},
			followUp: async () => {},
			abort: async () => {},
			getState: async () => ({ status: "idle" as const }),
			close: () => {},
		});
		// Also add a sessions.db entry so resolveTargetSession can find something
		writeSessionsToStore(tempDir, [makeSession({ agentName: "headless-test-agent" })]);

		const { nudgeAgent } = await importNudge();
		const result = await nudgeAgent(tempDir, "headless-test-agent");
		// Falls through to tmux — tmux session not alive
		expect(result.delivered).toBe(false);
		expect(result.reason).toContain("not alive");
		// No queued field when tmux path runs
		expect(result.queued).toBeUndefined();
	});

	test("debounce applies to headless nudges", async () => {
		let nudgeCount = 0;
		setConnection(
			"headless-test-agent",
			makeNudgeableConn({ status: "Queued" }, () => {
				nudgeCount++;
			}),
		);

		const { nudgeAgent } = await importNudge();
		// First nudge — forced to bypass debounce and prime the state
		await nudgeAgent(tempDir, "headless-test-agent", "first", true);
		// Second nudge immediately — should be debounced (within 500ms window)
		const second = await nudgeAgent(tempDir, "headless-test-agent", "second");

		expect(nudgeCount).toBe(1);
		expect(second.delivered).toBe(false);
		expect(second.reason).toContain("Debounced");
	});

	test("records nudge event for headless delivery", async () => {
		setConnection("headless-test-agent", makeNudgeableConn({ status: "Queued" }));

		const { nudgeAgent } = await importNudge();
		await nudgeAgent(tempDir, "headless-test-agent", "event test", true);

		const eventsDbPath = join(tempDir, ".overstory", "events.db");
		const store = createEventStore(eventsDbPath);
		try {
			const events: StoredEvent[] = store.getTimeline({ since: "2000-01-01T00:00:00Z" });
			const nudgeEvent = events.find((e) => {
				if (!e.data) return false;
				const data = JSON.parse(e.data) as Record<string, unknown>;
				return data.type === "nudge";
			});
			expect(nudgeEvent).toBeDefined();
			expect(nudgeEvent?.agentName).toBe("headless-test-agent");
			const data = JSON.parse(nudgeEvent?.data ?? "{}") as Record<string, unknown>;
			expect(data.delivered).toBe(true);
		} finally {
			store.close();
		}
	});

	test("tmux path: send-keys path invoked for agent with no connection", async () => {
		writeSessionsToStore(tempDir, [makeSession({ state: "working" })]);

		const { nudgeAgent } = await importNudge();
		const result = await nudgeAgent(tempDir, "test-agent");
		// No connection registered → tmux path → tmux session not alive
		expect(result.delivered).toBe(false);
		expect(result.reason).toContain("not alive");
		expect(result.queued).toBeUndefined();
	});
});

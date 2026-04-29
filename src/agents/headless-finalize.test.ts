import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeSync, existsSync, mkdirSync } from "node:fs";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventStore } from "../events/store.ts";
import { createSessionStore } from "../sessions/store.ts";
import { cleanupTempDir } from "../test-helpers.ts";
import type { AgentSession } from "../types.ts";
import { finalizeHeadlessSession } from "./headless-finalize.ts";
import { agentFifoPath, createAgentFifo } from "./headless-stdin.ts";

/**
 * Tests for finalizeHeadlessSession (overstory-267e).
 *
 * Headless agents skip the per-turn `ov log session-end` Stop hook because
 * overstory-e24b deploys only PreToolUse security guards. Without
 * finalizeHeadlessSession, SessionStore stays at 'working' indefinitely after
 * a clean exit. These tests cover the SessionStore transition, session_end
 * event emission, FIFO reaping, lead auto-nudge, and idempotency.
 */

function buildSession(overrides: Partial<AgentSession>): AgentSession {
	return {
		id: `session-${Date.now()}`,
		agentName: "test-agent",
		capability: "builder",
		worktreePath: "/tmp/wt",
		branchName: "overstory/test/agent",
		taskId: "task-1",
		tmuxSession: "",
		state: "working",
		pid: 99999,
		parentAgent: null,
		depth: 0,
		runId: "run-1",
		startedAt: new Date().toISOString(),
		lastActivity: new Date().toISOString(),
		escalationLevel: 0,
		stalledSince: null,
		transcriptPath: null,
		...overrides,
	};
}

describe("finalizeHeadlessSession", () => {
	let tempDir: string;
	let overstoryDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "headless-finalize-"));
		overstoryDir = join(tempDir, ".overstory");
		await mkdir(overstoryDir, { recursive: true });
	});

	afterEach(async () => {
		await cleanupTempDir(tempDir);
	});

	test("transitions a working headless agent to completed", async () => {
		const dbPath = join(overstoryDir, "sessions.db");
		const store = createSessionStore(dbPath);
		store.upsert(buildSession({ agentName: "builder-1", capability: "builder" }));
		store.close();

		await finalizeHeadlessSession(overstoryDir, "builder-1");

		const readStore = createSessionStore(dbPath);
		const session = readStore.getByName("builder-1");
		readStore.close();

		expect(session?.state).toBe("completed");
	});

	test("transitions a lead agent to completed (overrides per-turn persistent exception)", async () => {
		// In tmux mode the per-turn Stop hook keeps leads at 'working'. For headless
		// agents the only session-end signal is process death, so leads MUST be
		// transitioned on exit.
		const dbPath = join(overstoryDir, "sessions.db");
		const store = createSessionStore(dbPath);
		store.upsert(buildSession({ agentName: "lead-1", capability: "lead" }));
		store.close();

		await finalizeHeadlessSession(overstoryDir, "lead-1");

		const readStore = createSessionStore(dbPath);
		const session = readStore.getByName("lead-1");
		readStore.close();

		expect(session?.state).toBe("completed");
	});

	test("transitions a coordinator on real exit (overrides per-turn persistent exception)", async () => {
		const dbPath = join(overstoryDir, "sessions.db");
		const store = createSessionStore(dbPath);
		store.upsert(buildSession({ agentName: "coordinator", capability: "coordinator" }));
		store.close();

		await finalizeHeadlessSession(overstoryDir, "coordinator");

		const readStore = createSessionStore(dbPath);
		const session = readStore.getByName("coordinator");
		readStore.close();

		expect(session?.state).toBe("completed");
	});

	test("writes a session_end event to events.db", async () => {
		const sessionsDb = join(overstoryDir, "sessions.db");
		const eventsDb = join(overstoryDir, "events.db");

		const store = createSessionStore(sessionsDb);
		store.upsert(buildSession({ agentName: "builder-2" }));
		store.close();

		await finalizeHeadlessSession(overstoryDir, "builder-2");

		const eventStore = createEventStore(eventsDb);
		const events = eventStore.getByAgent("builder-2");
		eventStore.close();

		const sessionEnd = events.find((e) => e.eventType === "session_end");
		expect(sessionEnd).toBeDefined();
		expect(sessionEnd?.data).toContain("headless-exit-watcher");
	});

	test("writes a pending-nudge marker when finalizing a lead", async () => {
		const dbPath = join(overstoryDir, "sessions.db");
		const store = createSessionStore(dbPath);
		store.upsert(buildSession({ agentName: "lead-finished", capability: "lead" }));
		store.close();

		await finalizeHeadlessSession(overstoryDir, "lead-finished");

		const markerPath = join(overstoryDir, "pending-nudges", "coordinator.json");
		const markerFile = Bun.file(markerPath);
		expect(await markerFile.exists()).toBe(true);

		const marker = JSON.parse(await markerFile.text()) as Record<string, unknown>;
		expect(marker.from).toBe("lead-finished");
		expect(marker.reason).toBe("lead_completed");
	});

	test("does NOT write a pending-nudge marker for non-lead agents", async () => {
		const dbPath = join(overstoryDir, "sessions.db");
		const store = createSessionStore(dbPath);
		store.upsert(buildSession({ agentName: "builder-3", capability: "builder" }));
		store.close();

		await finalizeHeadlessSession(overstoryDir, "builder-3");

		const markerPath = join(overstoryDir, "pending-nudges", "coordinator.json");
		expect(existsSync(markerPath)).toBe(false);
	});

	test("removes the agent's stdin FIFO", async () => {
		const dbPath = join(overstoryDir, "sessions.db");
		const store = createSessionStore(dbPath);
		store.upsert(buildSession({ agentName: "fifo-agent" }));
		store.close();

		// Create a real FIFO so the unlink path is exercised
		mkdirSync(join(overstoryDir, "agents", "fifo-agent"), { recursive: true });
		const fd = createAgentFifo(overstoryDir, "fifo-agent");
		// Close the fd we just opened — finalize is allowed to unlink an open FIFO
		try {
			closeSync(fd);
		} catch {
			// already closed
		}

		const fifoPath = agentFifoPath(overstoryDir, "fifo-agent");
		expect(existsSync(fifoPath)).toBe(true);

		await finalizeHeadlessSession(overstoryDir, "fifo-agent");

		expect(existsSync(fifoPath)).toBe(false);
	});

	test("is idempotent — a second call on a completed session is a no-op", async () => {
		const dbPath = join(overstoryDir, "sessions.db");
		const store = createSessionStore(dbPath);
		store.upsert(buildSession({ agentName: "idem-agent", capability: "lead" }));
		store.close();

		await finalizeHeadlessSession(overstoryDir, "idem-agent");
		await finalizeHeadlessSession(overstoryDir, "idem-agent");

		const eventStore = createEventStore(join(overstoryDir, "events.db"));
		const events = eventStore.getByAgent("idem-agent");
		eventStore.close();

		// Only one session_end event should be written. The second call sees
		// state === "completed" and skips the event insertion.
		const sessionEnds = events.filter((e) => e.eventType === "session_end");
		expect(sessionEnds.length).toBe(1);
	});

	test("does not throw when the agent has no SessionStore record", async () => {
		// Calling finalize on an unknown agent must be safe — the watcher might
		// race with cleanup or be invoked after a stale session was purged.
		await expect(finalizeHeadlessSession(overstoryDir, "ghost")).resolves.toBeUndefined();
	});
});

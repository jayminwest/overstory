/**
 * Integration tests for the watchdog daemon tick loop.
 *
 * Uses real filesystem (temp directories via mkdtemp) and real SessionStore
 * (bun:sqlite) for session persistence, plus real health evaluation logic.
 *
 * Only tmux operations (isSessionAlive, killSession), triage, and nudge are
 * mocked via dependency injection (_tmux, _triage, _nudge params) because:
 * - Real tmux interferes with developer sessions and is fragile in CI.
 * - Real triage spawns Claude CLI which has cost and latency.
 * - Real nudge requires active tmux sessions.
 *
 * Does NOT use mock.module() — it leaks across test files. See mulch record
 * mx-56558b for background.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventStore } from "../events/store.ts";
import { createSessionStore } from "../sessions/store.ts";
import type { AgentSession, HealthCheck, StoredEvent } from "../types.ts";
import { buildCompletionMessage, runDaemonTick } from "./daemon.ts";

// === Test constants ===

const THRESHOLDS = {
	staleThresholdMs: 30_000,
	zombieThresholdMs: 120_000,
};

// === Helpers ===

/** Create a temp directory with .overstory/ subdirectory, ready for sessions.db. */
async function createTempRoot(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "overstory-daemon-test-"));
	await mkdir(join(dir, ".overstory"), { recursive: true });
	return dir;
}

/** Write sessions to the SessionStore (sessions.db) at the given root. */
function writeSessionsToStore(root: string, sessions: AgentSession[]): void {
	const dbPath = join(root, ".overstory", "sessions.db");
	const store = createSessionStore(dbPath);
	for (const session of sessions) {
		store.upsert(session);
	}
	store.close();
}

/** Read sessions from the SessionStore (sessions.db) at the given root. */
function readSessionsFromStore(root: string): AgentSession[] {
	const dbPath = join(root, ".overstory", "sessions.db");
	const store = createSessionStore(dbPath);
	const sessions = store.getAll();
	store.close();
	return sessions;
}

/** Build a test AgentSession with sensible defaults. */
function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
	return {
		id: "session-test",
		agentName: "test-agent",
		capability: "builder",
		worktreePath: "/tmp/test",
		branchName: "overstory/test-agent/test-task",
		beadId: "test-task",
		tmuxSession: "overstory-test-agent",
		state: "working",
		pid: process.pid, // Use our own PID so isProcessRunning returns true
		parentAgent: null,
		depth: 0,
		runId: null,
		escalationLevel: 0,
		stalledSince: null,
		startedAt: new Date().toISOString(),
		lastActivity: new Date().toISOString(),
		...overrides,
	};
}

/** Create a fake _tmux dependency where all sessions are alive. */
function tmuxAllAlive(): {
	isSessionAlive: (name: string) => Promise<boolean>;
	killSession: (name: string) => Promise<void>;
} {
	return {
		isSessionAlive: async () => true,
		killSession: async () => {},
	};
}

/** Create a fake _tmux dependency where all sessions are dead. */
function tmuxAllDead(): {
	isSessionAlive: (name: string) => Promise<boolean>;
	killSession: (name: string) => Promise<void>;
} {
	return {
		isSessionAlive: async () => false,
		killSession: async () => {},
	};
}

/**
 * Create a fake _tmux dependency with per-session liveness control.
 * Also tracks killSession calls for assertions.
 */
function tmuxWithLiveness(aliveMap: Record<string, boolean>): {
	isSessionAlive: (name: string) => Promise<boolean>;
	killSession: (name: string) => Promise<void>;
	killed: string[];
} {
	const killed: string[] = [];
	return {
		isSessionAlive: async (name: string) => aliveMap[name] ?? false,
		killSession: async (name: string) => {
			killed.push(name);
		},
		killed,
	};
}

/** Create a fake _triage that always returns the given verdict. */
function triageAlways(
	verdict: "retry" | "terminate" | "extend",
): (options: {
	agentName: string;
	root: string;
	lastActivity: string;
}) => Promise<"retry" | "terminate" | "extend"> {
	return async () => verdict;
}

/** Create a fake _nudge that tracks calls and always succeeds. */
function nudgeTracker(): {
	nudge: (
		projectRoot: string,
		agentName: string,
		message: string,
		force: boolean,
	) => Promise<{ delivered: boolean; reason?: string }>;
	calls: Array<{ agentName: string; message: string }>;
} {
	const calls: Array<{ agentName: string; message: string }> = [];
	return {
		nudge: async (_projectRoot: string, agentName: string, message: string, _force: boolean) => {
			calls.push({ agentName, message });
			return { delivered: true };
		},
		calls,
	};
}

// === Tests ===

let tempRoot: string;

beforeEach(async () => {
	tempRoot = await createTempRoot();
});

afterEach(async () => {
	await rm(tempRoot, { recursive: true, force: true });
});

describe("daemon tick", () => {
	// --- Test 1: tick with no sessions file ---

	test("tick with no sessions is a graceful no-op", async () => {
		// No sessions in the store — daemon should not crash
		const checks: HealthCheck[] = [];

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			onHealthCheck: (c) => checks.push(c),
			_tmux: tmuxAllAlive(),
			_triage: triageAlways("extend"),
		});

		// No health checks should have been produced (no sessions to check)
		expect(checks).toHaveLength(0);
	});

	// --- Test 2: tick with healthy sessions ---

	test("tick with healthy sessions produces no state changes", async () => {
		const session = makeSession({
			state: "working",
			lastActivity: new Date().toISOString(),
		});

		writeSessionsToStore(tempRoot, [session]);

		const checks: HealthCheck[] = [];

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			onHealthCheck: (c) => checks.push(c),
			_tmux: tmuxAllAlive(),
			_triage: triageAlways("extend"),
		});

		expect(checks).toHaveLength(1);
		const check = checks[0];
		expect(check).toBeDefined();
		expect(check?.state).toBe("working");
		expect(check?.action).toBe("none");

		// Session state should be unchanged because state didn't change.
		const reloaded = readSessionsFromStore(tempRoot);
		expect(reloaded).toHaveLength(1);
		expect(reloaded[0]?.state).toBe("working");
	});

	// --- Test 3: tick with dead tmux -> zombie transition ---

	test("tick with dead tmux transitions session to zombie and fires terminate", async () => {
		const session = makeSession({
			agentName: "dead-agent",
			tmuxSession: "overstory-dead-agent",
			state: "working",
			lastActivity: new Date().toISOString(),
		});

		writeSessionsToStore(tempRoot, [session]);

		const tmuxMock = tmuxWithLiveness({ "overstory-dead-agent": false });
		const checks: HealthCheck[] = [];

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			onHealthCheck: (c) => checks.push(c),
			_tmux: tmuxMock,
			_triage: triageAlways("extend"),
		});

		// Health check should detect zombie with terminate action
		expect(checks).toHaveLength(1);
		expect(checks[0]?.state).toBe("zombie");
		expect(checks[0]?.action).toBe("terminate");

		// tmux is dead so killSession should NOT be called (only kills if tmuxAlive)
		expect(tmuxMock.killed).toHaveLength(0);

		// Session state should be persisted as zombie
		const reloaded = readSessionsFromStore(tempRoot);
		expect(reloaded).toHaveLength(1);
		expect(reloaded[0]?.state).toBe("zombie");
	});

	test("tick with alive tmux but zombie-old activity calls killSession", async () => {
		// tmux IS alive but time-based zombie threshold is exceeded,
		// causing a terminate action — killSession SHOULD be called.
		const oldActivity = new Date(Date.now() - 200_000).toISOString();
		const session = makeSession({
			agentName: "zombie-agent",
			tmuxSession: "overstory-zombie-agent",
			state: "working",
			lastActivity: oldActivity,
		});

		writeSessionsToStore(tempRoot, [session]);

		const tmuxMock = tmuxWithLiveness({ "overstory-zombie-agent": true });
		const checks: HealthCheck[] = [];

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			onHealthCheck: (c) => checks.push(c),
			_tmux: tmuxMock,
			_triage: triageAlways("extend"),
		});

		expect(checks).toHaveLength(1);
		expect(checks[0]?.action).toBe("terminate");

		// tmux was alive, so killSession SHOULD have been called
		expect(tmuxMock.killed).toContain("overstory-zombie-agent");

		// Session persisted as zombie
		const reloaded = readSessionsFromStore(tempRoot);
		expect(reloaded[0]?.state).toBe("zombie");
	});

	// --- Test 4: progressive nudging for stalled agents ---

	test("first stalled tick sets stalledSince and stays at level 0 (warn)", async () => {
		const staleActivity = new Date(Date.now() - 60_000).toISOString();
		const session = makeSession({
			agentName: "stalled-agent",
			tmuxSession: "overstory-stalled-agent",
			state: "working",
			lastActivity: staleActivity,
		});

		writeSessionsToStore(tempRoot, [session]);

		const tmuxMock = tmuxWithLiveness({ "overstory-stalled-agent": true });
		const checks: HealthCheck[] = [];
		const nudgeMock = nudgeTracker();

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			nudgeIntervalMs: 60_000,
			onHealthCheck: (c) => checks.push(c),
			_tmux: tmuxMock,
			_triage: triageAlways("extend"),
			_nudge: nudgeMock.nudge,
		});

		expect(checks).toHaveLength(1);
		expect(checks[0]?.action).toBe("escalate");

		// No kill at level 0
		expect(tmuxMock.killed).toHaveLength(0);

		// No nudge at level 0 (warn only)
		expect(nudgeMock.calls).toHaveLength(0);

		// Session should be stalled with stalledSince set and escalationLevel 0
		const reloaded = readSessionsFromStore(tempRoot);
		expect(reloaded[0]?.state).toBe("stalled");
		expect(reloaded[0]?.escalationLevel).toBe(0);
		expect(reloaded[0]?.stalledSince).not.toBeNull();
	});

	test("stalled agent at level 1 sends nudge", async () => {
		const staleActivity = new Date(Date.now() - 60_000).toISOString();
		// Pre-set stalledSince to > nudgeIntervalMs ago so level advances to 1
		const stalledSince = new Date(Date.now() - 70_000).toISOString();
		const session = makeSession({
			agentName: "stalled-agent",
			tmuxSession: "overstory-stalled-agent",
			state: "stalled",
			lastActivity: staleActivity,
			escalationLevel: 0,
			stalledSince,
		});

		writeSessionsToStore(tempRoot, [session]);

		const tmuxMock = tmuxWithLiveness({ "overstory-stalled-agent": true });
		const nudgeMock = nudgeTracker();

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			nudgeIntervalMs: 60_000,
			_tmux: tmuxMock,
			_triage: triageAlways("extend"),
			_nudge: nudgeMock.nudge,
		});

		// Level should advance to 1 and nudge should be sent
		const reloaded = readSessionsFromStore(tempRoot);
		expect(reloaded[0]?.escalationLevel).toBe(1);
		expect(nudgeMock.calls).toHaveLength(1);
		expect(nudgeMock.calls[0]?.agentName).toBe("stalled-agent");
		expect(nudgeMock.calls[0]?.message).toContain("WATCHDOG");

		// No kill
		expect(tmuxMock.killed).toHaveLength(0);
	});

	test("stalled agent at level 2 calls triage when tier1Enabled", async () => {
		const staleActivity = new Date(Date.now() - 60_000).toISOString();
		// Pre-set stalledSince to > 2*nudgeIntervalMs ago so level advances to 2
		const stalledSince = new Date(Date.now() - 130_000).toISOString();
		const session = makeSession({
			agentName: "stalled-agent",
			tmuxSession: "overstory-stalled-agent",
			state: "stalled",
			lastActivity: staleActivity,
			escalationLevel: 1,
			stalledSince,
		});

		writeSessionsToStore(tempRoot, [session]);

		const tmuxMock = tmuxWithLiveness({ "overstory-stalled-agent": true });
		let triageCalled = false;

		const triageMock = async (opts: {
			agentName: string;
			root: string;
			lastActivity: string;
		}): Promise<"retry" | "terminate" | "extend"> => {
			triageCalled = true;
			expect(opts.agentName).toBe("stalled-agent");
			return "terminate";
		};

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			nudgeIntervalMs: 60_000,
			tier1Enabled: true,
			_tmux: tmuxMock,
			_triage: triageMock,
			_nudge: nudgeTracker().nudge,
		});

		expect(triageCalled).toBe(true);

		// Triage returned terminate — session should be zombie
		expect(tmuxMock.killed).toContain("overstory-stalled-agent");
		const reloaded = readSessionsFromStore(tempRoot);
		expect(reloaded[0]?.state).toBe("zombie");
	});

	test("stalled agent at level 2 skips triage when tier1Enabled is false", async () => {
		const staleActivity = new Date(Date.now() - 60_000).toISOString();
		const stalledSince = new Date(Date.now() - 130_000).toISOString();
		const session = makeSession({
			agentName: "stalled-agent",
			tmuxSession: "overstory-stalled-agent",
			state: "stalled",
			lastActivity: staleActivity,
			escalationLevel: 1,
			stalledSince,
		});

		writeSessionsToStore(tempRoot, [session]);

		const tmuxMock = tmuxWithLiveness({ "overstory-stalled-agent": true });
		let triageCalled = false;

		const triageMock = async (): Promise<"retry" | "terminate" | "extend"> => {
			triageCalled = true;
			return "terminate";
		};

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			nudgeIntervalMs: 60_000,
			tier1Enabled: false, // Triage disabled
			_tmux: tmuxMock,
			_triage: triageMock,
			_nudge: nudgeTracker().nudge,
		});

		// Triage should NOT have been called
		expect(triageCalled).toBe(false);

		// No kill — level 2 with tier1 disabled just skips
		expect(tmuxMock.killed).toHaveLength(0);

		// Session stays stalled at level 2
		const reloaded = readSessionsFromStore(tempRoot);
		expect(reloaded[0]?.state).toBe("stalled");
		expect(reloaded[0]?.escalationLevel).toBe(2);
	});

	test("stalled agent at level 3 is terminated", async () => {
		const staleActivity = new Date(Date.now() - 60_000).toISOString();
		// Pre-set stalledSince to > 3*nudgeIntervalMs ago so level advances to 3
		const stalledSince = new Date(Date.now() - 200_000).toISOString();
		const session = makeSession({
			agentName: "doomed-agent",
			tmuxSession: "overstory-doomed-agent",
			state: "stalled",
			lastActivity: staleActivity,
			escalationLevel: 2,
			stalledSince,
		});

		writeSessionsToStore(tempRoot, [session]);

		const tmuxMock = tmuxWithLiveness({ "overstory-doomed-agent": true });

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			nudgeIntervalMs: 60_000,
			_tmux: tmuxMock,
			_triage: triageAlways("extend"),
			_nudge: nudgeTracker().nudge,
		});

		// Level 3 = terminate
		expect(tmuxMock.killed).toContain("overstory-doomed-agent");

		const reloaded = readSessionsFromStore(tempRoot);
		expect(reloaded[0]?.state).toBe("zombie");
		// Escalation is reset after termination
		expect(reloaded[0]?.escalationLevel).toBe(0);
		expect(reloaded[0]?.stalledSince).toBeNull();
	});

	test("triage retry sends nudge with recovery message", async () => {
		const staleActivity = new Date(Date.now() - 60_000).toISOString();
		const stalledSince = new Date(Date.now() - 130_000).toISOString();
		const session = makeSession({
			agentName: "retry-agent",
			tmuxSession: "overstory-retry-agent",
			state: "stalled",
			lastActivity: staleActivity,
			escalationLevel: 1,
			stalledSince,
		});

		writeSessionsToStore(tempRoot, [session]);

		const tmuxMock = tmuxWithLiveness({ "overstory-retry-agent": true });
		const nudgeMock = nudgeTracker();

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			nudgeIntervalMs: 60_000,
			tier1Enabled: true,
			_tmux: tmuxMock,
			_triage: triageAlways("retry"),
			_nudge: nudgeMock.nudge,
		});

		// Triage returned "retry" — nudge should be sent with recovery message
		expect(nudgeMock.calls).toHaveLength(1);
		expect(nudgeMock.calls[0]?.message).toContain("recovery");

		// No kill
		expect(tmuxMock.killed).toHaveLength(0);

		// Session stays stalled
		const reloaded = readSessionsFromStore(tempRoot);
		expect(reloaded[0]?.state).toBe("stalled");
	});

	test("agent recovery resets escalation tracking", async () => {
		// Agent was stalled but now has recent activity
		const session = makeSession({
			agentName: "recovered-agent",
			tmuxSession: "overstory-recovered-agent",
			state: "working",
			lastActivity: new Date().toISOString(), // Recent activity
			escalationLevel: 2,
			stalledSince: new Date(Date.now() - 130_000).toISOString(),
		});

		writeSessionsToStore(tempRoot, [session]);

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			_tmux: tmuxAllAlive(),
			_triage: triageAlways("extend"),
			_nudge: nudgeTracker().nudge,
		});

		// Health check should return action: "none" for recovered agent
		// Escalation tracking should be reset
		const reloaded = readSessionsFromStore(tempRoot);
		expect(reloaded[0]?.state).toBe("working");
		expect(reloaded[0]?.escalationLevel).toBe(0);
		expect(reloaded[0]?.stalledSince).toBeNull();
	});

	// --- Test 5: session persistence round-trip ---

	test("session persistence round-trip: load, modify, save, reload", async () => {
		const sessions: AgentSession[] = [
			makeSession({
				id: "session-1",
				agentName: "agent-alpha",
				tmuxSession: "overstory-agent-alpha",
				state: "working",
				lastActivity: new Date().toISOString(),
			}),
			makeSession({
				id: "session-2",
				agentName: "agent-beta",
				tmuxSession: "overstory-agent-beta",
				state: "working",
				// Make beta's tmux dead so it transitions to zombie
				lastActivity: new Date().toISOString(),
			}),
			makeSession({
				id: "session-3",
				agentName: "agent-gamma",
				tmuxSession: "overstory-agent-gamma",
				state: "completed",
				lastActivity: new Date().toISOString(),
			}),
		];

		writeSessionsToStore(tempRoot, sessions);

		const tmuxMock = tmuxWithLiveness({
			"overstory-agent-alpha": true,
			"overstory-agent-beta": false, // Dead — should become zombie
			"overstory-agent-gamma": true, // Doesn't matter — completed is skipped
		});

		const checks: HealthCheck[] = [];

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			onHealthCheck: (c) => checks.push(c),
			_tmux: tmuxMock,
			_triage: triageAlways("extend"),
		});

		// Completed sessions are skipped — only 2 health checks
		expect(checks).toHaveLength(2);

		// Reload and verify persistence
		const reloaded = readSessionsFromStore(tempRoot);
		expect(reloaded).toHaveLength(3);

		const alpha = reloaded.find((s) => s.agentName === "agent-alpha");
		const beta = reloaded.find((s) => s.agentName === "agent-beta");
		const gamma = reloaded.find((s) => s.agentName === "agent-gamma");

		expect(alpha).toBeDefined();
		expect(beta).toBeDefined();
		expect(gamma).toBeDefined();

		// Alpha: tmux alive + recent activity — stays working
		expect(alpha?.state).toBe("working");

		// Beta: tmux dead — zombie (ZFC rule 1)
		expect(beta?.state).toBe("zombie");

		// Gamma: completed — unchanged (skipped by daemon)
		expect(gamma?.state).toBe("completed");
	});

	test("session persistence: state unchanged when nothing changes", async () => {
		const session = makeSession({
			state: "working",
			lastActivity: new Date().toISOString(),
		});

		writeSessionsToStore(tempRoot, [session]);

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			_tmux: tmuxAllAlive(),
			_triage: triageAlways("extend"),
		});

		// Session state should remain unchanged since nothing triggered a transition
		const reloaded = readSessionsFromStore(tempRoot);
		expect(reloaded).toHaveLength(1);
		expect(reloaded[0]?.state).toBe("working");
	});

	// --- Edge cases ---

	test("completed sessions are skipped entirely", async () => {
		const session = makeSession({ state: "completed" });

		writeSessionsToStore(tempRoot, [session]);

		const checks: HealthCheck[] = [];

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			onHealthCheck: (c) => checks.push(c),
			_tmux: tmuxAllDead(), // Would be zombie if not skipped
			_triage: triageAlways("extend"),
		});

		// No health checks emitted for completed sessions
		expect(checks).toHaveLength(0);

		// State unchanged
		const reloaded = readSessionsFromStore(tempRoot);
		expect(reloaded[0]?.state).toBe("completed");
	});

	test("multiple sessions with mixed states are all processed", async () => {
		const now = Date.now();
		const sessions: AgentSession[] = [
			makeSession({
				id: "s1",
				agentName: "healthy",
				tmuxSession: "overstory-healthy",
				state: "working",
				lastActivity: new Date(now).toISOString(),
			}),
			makeSession({
				id: "s2",
				agentName: "dying",
				tmuxSession: "overstory-dying",
				state: "working",
				lastActivity: new Date(now).toISOString(),
			}),
			makeSession({
				id: "s3",
				agentName: "stale",
				tmuxSession: "overstory-stale",
				state: "working",
				lastActivity: new Date(now - 60_000).toISOString(),
			}),
			makeSession({
				id: "s4",
				agentName: "done",
				tmuxSession: "overstory-done",
				state: "completed",
			}),
		];

		writeSessionsToStore(tempRoot, sessions);

		const tmuxMock = tmuxWithLiveness({
			"overstory-healthy": true,
			"overstory-dying": false,
			"overstory-stale": true,
			"overstory-done": false,
		});

		const checks: HealthCheck[] = [];

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			onHealthCheck: (c) => checks.push(c),
			_tmux: tmuxMock,
			_triage: triageAlways("extend"),
			_nudge: nudgeTracker().nudge,
		});

		// 3 non-completed sessions processed
		expect(checks).toHaveLength(3);

		const reloaded = readSessionsFromStore(tempRoot);

		const healthy = reloaded.find((s) => s.agentName === "healthy");
		const dying = reloaded.find((s) => s.agentName === "dying");
		const stale = reloaded.find((s) => s.agentName === "stale");
		const done = reloaded.find((s) => s.agentName === "done");

		expect(healthy?.state).toBe("working");
		expect(dying?.state).toBe("zombie");
		expect(stale?.state).toBe("stalled");
		expect(done?.state).toBe("completed");
	});

	test("empty sessions array is a no-op", async () => {
		writeSessionsToStore(tempRoot, []);

		const checks: HealthCheck[] = [];

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			onHealthCheck: (c) => checks.push(c),
			_tmux: tmuxAllAlive(),
			_triage: triageAlways("extend"),
		});

		expect(checks).toHaveLength(0);
	});

	test("booting session with recent activity transitions to working", async () => {
		const session = makeSession({
			state: "booting",
			lastActivity: new Date().toISOString(),
		});

		writeSessionsToStore(tempRoot, [session]);

		const checks: HealthCheck[] = [];

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			onHealthCheck: (c) => checks.push(c),
			_tmux: tmuxAllAlive(),
			_triage: triageAlways("extend"),
		});

		expect(checks).toHaveLength(1);
		expect(checks[0]?.state).toBe("working");

		const reloaded = readSessionsFromStore(tempRoot);
		expect(reloaded[0]?.state).toBe("working");
	});

	// --- Backward compatibility ---

	test("sessions with default escalation fields are processed correctly", async () => {
		// Write a session with default (zero) escalation fields
		const session = makeSession({
			id: "session-old",
			agentName: "old-agent",
			worktreePath: "/tmp/test",
			branchName: "overstory/old-agent/task",
			beadId: "task",
			tmuxSession: "overstory-old-agent",
			state: "working",
			pid: process.pid,
			escalationLevel: 0,
			stalledSince: null,
		});

		writeSessionsToStore(tempRoot, [session]);

		const checks: HealthCheck[] = [];

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			onHealthCheck: (c) => checks.push(c),
			_tmux: tmuxAllAlive(),
			_triage: triageAlways("extend"),
		});

		// Should process without errors
		expect(checks).toHaveLength(1);
		expect(checks[0]?.state).toBe("working");
	});
});

// === Event recording tests ===

describe("daemon event recording", () => {
	/** Open the events.db in the temp root and return all events. */
	function readEvents(root: string): StoredEvent[] {
		const dbPath = join(root, ".overstory", "events.db");
		const store = createEventStore(dbPath);
		try {
			// Get all events (no agent filter — use a broad timeline)
			return store.getTimeline({ since: "2000-01-01T00:00:00Z" });
		} finally {
			store.close();
		}
	}

	test("escalation level 0 (warn) records event with type=escalation", async () => {
		const staleActivity = new Date(Date.now() - 60_000).toISOString();
		const session = makeSession({
			agentName: "stalled-agent",
			tmuxSession: "overstory-stalled-agent",
			state: "working",
			lastActivity: staleActivity,
		});

		writeSessionsToStore(tempRoot, [session]);

		// Create EventStore and inject it
		const eventsDbPath = join(tempRoot, ".overstory", "events.db");
		const eventStore = createEventStore(eventsDbPath);

		try {
			await runDaemonTick({
				root: tempRoot,
				...THRESHOLDS,
				nudgeIntervalMs: 60_000,
				_tmux: tmuxWithLiveness({ "overstory-stalled-agent": true }),
				_triage: triageAlways("extend"),
				_nudge: nudgeTracker().nudge,
				_eventStore: eventStore,
			});
		} finally {
			eventStore.close();
		}

		const events = readEvents(tempRoot);
		expect(events.length).toBeGreaterThanOrEqual(1);

		const warnEvent = events.find((e) => {
			if (!e.data) return false;
			const data = JSON.parse(e.data) as Record<string, unknown>;
			return data.type === "escalation" && data.escalationLevel === 0;
		});
		expect(warnEvent).toBeDefined();
		expect(warnEvent?.eventType).toBe("custom");
		expect(warnEvent?.level).toBe("warn");
		expect(warnEvent?.agentName).toBe("stalled-agent");
	});

	test("escalation level 1 (nudge) records event with delivered status", async () => {
		const staleActivity = new Date(Date.now() - 60_000).toISOString();
		const stalledSince = new Date(Date.now() - 70_000).toISOString();
		const session = makeSession({
			agentName: "stalled-agent",
			tmuxSession: "overstory-stalled-agent",
			state: "stalled",
			lastActivity: staleActivity,
			escalationLevel: 0,
			stalledSince,
		});

		writeSessionsToStore(tempRoot, [session]);

		const eventsDbPath = join(tempRoot, ".overstory", "events.db");
		const eventStore = createEventStore(eventsDbPath);
		const nudgeMock = nudgeTracker();

		try {
			await runDaemonTick({
				root: tempRoot,
				...THRESHOLDS,
				nudgeIntervalMs: 60_000,
				_tmux: tmuxWithLiveness({ "overstory-stalled-agent": true }),
				_triage: triageAlways("extend"),
				_nudge: nudgeMock.nudge,
				_eventStore: eventStore,
			});
		} finally {
			eventStore.close();
		}

		const events = readEvents(tempRoot);
		const nudgeEvent = events.find((e) => {
			if (!e.data) return false;
			const data = JSON.parse(e.data) as Record<string, unknown>;
			return data.type === "nudge" && data.escalationLevel === 1;
		});
		expect(nudgeEvent).toBeDefined();
		expect(nudgeEvent?.eventType).toBe("custom");
		expect(nudgeEvent?.level).toBe("warn");

		const nudgeData = JSON.parse(nudgeEvent?.data ?? "{}") as Record<string, unknown>;
		expect(nudgeData.delivered).toBe(true);
	});

	test("escalation level 2 (triage) records event with verdict", async () => {
		const staleActivity = new Date(Date.now() - 60_000).toISOString();
		const stalledSince = new Date(Date.now() - 130_000).toISOString();
		const session = makeSession({
			agentName: "stalled-agent",
			tmuxSession: "overstory-stalled-agent",
			state: "stalled",
			lastActivity: staleActivity,
			escalationLevel: 1,
			stalledSince,
		});

		writeSessionsToStore(tempRoot, [session]);

		const eventsDbPath = join(tempRoot, ".overstory", "events.db");
		const eventStore = createEventStore(eventsDbPath);

		try {
			await runDaemonTick({
				root: tempRoot,
				...THRESHOLDS,
				nudgeIntervalMs: 60_000,
				tier1Enabled: true,
				_tmux: tmuxWithLiveness({ "overstory-stalled-agent": true }),
				_triage: triageAlways("extend"),
				_nudge: nudgeTracker().nudge,
				_eventStore: eventStore,
			});
		} finally {
			eventStore.close();
		}

		const events = readEvents(tempRoot);
		const triageEvent = events.find((e) => {
			if (!e.data) return false;
			const data = JSON.parse(e.data) as Record<string, unknown>;
			return data.type === "triage" && data.escalationLevel === 2;
		});
		expect(triageEvent).toBeDefined();
		expect(triageEvent?.eventType).toBe("custom");
		expect(triageEvent?.level).toBe("warn");

		const triageData = JSON.parse(triageEvent?.data ?? "{}") as Record<string, unknown>;
		expect(triageData.verdict).toBe("extend");
	});

	test("escalation level 3 (terminate) records event with level=error", async () => {
		const staleActivity = new Date(Date.now() - 60_000).toISOString();
		const stalledSince = new Date(Date.now() - 200_000).toISOString();
		const session = makeSession({
			agentName: "doomed-agent",
			tmuxSession: "overstory-doomed-agent",
			state: "stalled",
			lastActivity: staleActivity,
			escalationLevel: 2,
			stalledSince,
		});

		writeSessionsToStore(tempRoot, [session]);

		const eventsDbPath = join(tempRoot, ".overstory", "events.db");
		const eventStore = createEventStore(eventsDbPath);

		try {
			await runDaemonTick({
				root: tempRoot,
				...THRESHOLDS,
				nudgeIntervalMs: 60_000,
				_tmux: tmuxWithLiveness({ "overstory-doomed-agent": true }),
				_triage: triageAlways("extend"),
				_nudge: nudgeTracker().nudge,
				_eventStore: eventStore,
			});
		} finally {
			eventStore.close();
		}

		const events = readEvents(tempRoot);
		const terminateEvent = events.find((e) => {
			if (!e.data) return false;
			const data = JSON.parse(e.data) as Record<string, unknown>;
			return data.type === "escalation" && data.escalationLevel === 3;
		});
		expect(terminateEvent).toBeDefined();
		expect(terminateEvent?.eventType).toBe("custom");
		expect(terminateEvent?.level).toBe("error");

		const terminateData = JSON.parse(terminateEvent?.data ?? "{}") as Record<string, unknown>;
		expect(terminateData.action).toBe("terminate");
	});

	test("run_id is included in events when current-run.txt exists", async () => {
		const staleActivity = new Date(Date.now() - 60_000).toISOString();
		const session = makeSession({
			agentName: "stalled-agent",
			tmuxSession: "overstory-stalled-agent",
			state: "working",
			lastActivity: staleActivity,
		});

		writeSessionsToStore(tempRoot, [session]);

		// Write a current-run.txt
		const runId = "run-2026-02-13T10-00-00-000Z";
		await Bun.write(join(tempRoot, ".overstory", "current-run.txt"), runId);

		const eventsDbPath = join(tempRoot, ".overstory", "events.db");
		const eventStore = createEventStore(eventsDbPath);

		try {
			await runDaemonTick({
				root: tempRoot,
				...THRESHOLDS,
				nudgeIntervalMs: 60_000,
				_tmux: tmuxWithLiveness({ "overstory-stalled-agent": true }),
				_triage: triageAlways("extend"),
				_nudge: nudgeTracker().nudge,
				_eventStore: eventStore,
			});
		} finally {
			eventStore.close();
		}

		const events = readEvents(tempRoot);
		expect(events.length).toBeGreaterThanOrEqual(1);
		const event = events[0];
		expect(event?.runId).toBe(runId);
	});

	test("daemon continues normally when _eventStore is null", async () => {
		const staleActivity = new Date(Date.now() - 60_000).toISOString();
		const session = makeSession({
			agentName: "stalled-agent",
			tmuxSession: "overstory-stalled-agent",
			state: "working",
			lastActivity: staleActivity,
		});

		writeSessionsToStore(tempRoot, [session]);

		const checks: HealthCheck[] = [];

		// Inject null EventStore — daemon should still work fine
		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			nudgeIntervalMs: 60_000,
			onHealthCheck: (c) => checks.push(c),
			_tmux: tmuxWithLiveness({ "overstory-stalled-agent": true }),
			_triage: triageAlways("extend"),
			_nudge: nudgeTracker().nudge,
			_eventStore: null,
		});

		// Daemon should still produce health checks even without EventStore
		expect(checks).toHaveLength(1);
		expect(checks[0]?.action).toBe("escalate");
	});
});

// === Mulch failure recording tests ===

describe("daemon mulch failure recording", () => {
	let tempRoot: string;

	beforeEach(async () => {
		tempRoot = await createTempRoot();
	});

	afterEach(async () => {
		await rm(tempRoot, { recursive: true, force: true });
	});

	/** Track calls to the recordFailure mock. */
	interface FailureRecord {
		root: string;
		session: AgentSession;
		reason: string;
		tier: 0 | 1;
		triageSuggestion?: string;
	}

	function failureTracker(): {
		calls: FailureRecord[];
		recordFailure: (
			root: string,
			session: AgentSession,
			reason: string,
			tier: 0 | 1,
			triageSuggestion?: string,
		) => Promise<void>;
	} {
		const calls: FailureRecord[] = [];
		return {
			calls,
			async recordFailure(root, session, reason, tier, triageSuggestion) {
				calls.push({ root, session, reason, tier, triageSuggestion });
			},
		};
	}

	test("Tier 0: recordFailure called when action=terminate (process death)", async () => {
		const session = makeSession({
			agentName: "dying-agent",
			capability: "builder",
			beadId: "task-123",
			tmuxSession: "overstory-dying-agent",
			state: "working",
			lastActivity: new Date().toISOString(),
		});

		writeSessionsToStore(tempRoot, [session]);

		const tmuxMock = tmuxWithLiveness({ "overstory-dying-agent": false });
		const failureMock = failureTracker();

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			_tmux: tmuxMock,
			_triage: triageAlways("extend"),
			_nudge: nudgeTracker().nudge,
			_recordFailure: failureMock.recordFailure,
		});

		// recordFailure should be called with Tier 0
		expect(failureMock.calls).toHaveLength(1);
		expect(failureMock.calls[0]?.tier).toBe(0);
		expect(failureMock.calls[0]?.session.agentName).toBe("dying-agent");
		expect(failureMock.calls[0]?.session.capability).toBe("builder");
		expect(failureMock.calls[0]?.session.beadId).toBe("task-123");
		// Reason should be either the reconciliationNote or default "Process terminated"
		expect(failureMock.calls[0]?.reason).toBeDefined();
	});

	test("Tier 1: recordFailure called when triage returns terminate", async () => {
		const staleActivity = new Date(Date.now() - 60_000).toISOString();
		const stalledSince = new Date(Date.now() - 130_000).toISOString();
		const session = makeSession({
			agentName: "triaged-agent",
			capability: "scout",
			beadId: "task-456",
			tmuxSession: "overstory-triaged-agent",
			state: "stalled",
			lastActivity: staleActivity,
			escalationLevel: 1,
			stalledSince,
		});

		writeSessionsToStore(tempRoot, [session]);

		const tmuxMock = tmuxWithLiveness({ "overstory-triaged-agent": true });
		const failureMock = failureTracker();

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			nudgeIntervalMs: 60_000,
			tier1Enabled: true,
			_tmux: tmuxMock,
			_triage: triageAlways("terminate"),
			_nudge: nudgeTracker().nudge,
			_recordFailure: failureMock.recordFailure,
		});

		// recordFailure should be called with Tier 1 and triage verdict
		expect(failureMock.calls).toHaveLength(1);
		expect(failureMock.calls[0]?.tier).toBe(1);
		expect(failureMock.calls[0]?.session.agentName).toBe("triaged-agent");
		expect(failureMock.calls[0]?.session.capability).toBe("scout");
		expect(failureMock.calls[0]?.session.beadId).toBe("task-456");
		expect(failureMock.calls[0]?.triageSuggestion).toBe("terminate");
		expect(failureMock.calls[0]?.reason).toContain("AI triage");
	});

	test("recordFailure not called when triage returns retry", async () => {
		const staleActivity = new Date(Date.now() - 60_000).toISOString();
		const stalledSince = new Date(Date.now() - 130_000).toISOString();
		const session = makeSession({
			agentName: "retry-agent",
			tmuxSession: "overstory-retry-agent",
			state: "stalled",
			lastActivity: staleActivity,
			escalationLevel: 1,
			stalledSince,
		});

		writeSessionsToStore(tempRoot, [session]);

		const tmuxMock = tmuxWithLiveness({ "overstory-retry-agent": true });
		const failureMock = failureTracker();

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			nudgeIntervalMs: 60_000,
			tier1Enabled: true,
			_tmux: tmuxMock,
			_triage: triageAlways("retry"),
			_nudge: nudgeTracker().nudge,
			_recordFailure: failureMock.recordFailure,
		});

		// recordFailure should NOT be called for retry verdict
		expect(failureMock.calls).toHaveLength(0);
	});

	test("recordFailure not called when triage returns extend", async () => {
		const staleActivity = new Date(Date.now() - 60_000).toISOString();
		const stalledSince = new Date(Date.now() - 130_000).toISOString();
		const session = makeSession({
			agentName: "extend-agent",
			tmuxSession: "overstory-extend-agent",
			state: "stalled",
			lastActivity: staleActivity,
			escalationLevel: 1,
			stalledSince,
		});

		writeSessionsToStore(tempRoot, [session]);

		const tmuxMock = tmuxWithLiveness({ "overstory-extend-agent": true });
		const failureMock = failureTracker();

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			nudgeIntervalMs: 60_000,
			tier1Enabled: true,
			_tmux: tmuxMock,
			_triage: triageAlways("extend"),
			_nudge: nudgeTracker().nudge,
			_recordFailure: failureMock.recordFailure,
		});

		// recordFailure should NOT be called for extend verdict
		expect(failureMock.calls).toHaveLength(0);
	});

	test("recordFailure includes evidenceBead when beadId is present", async () => {
		const session = makeSession({
			agentName: "beaded-agent",
			capability: "builder",
			beadId: "task-789",
			tmuxSession: "overstory-beaded-agent",
			state: "working",
			lastActivity: new Date().toISOString(),
		});

		writeSessionsToStore(tempRoot, [session]);

		const tmuxMock = tmuxWithLiveness({ "overstory-beaded-agent": false });
		const failureMock = failureTracker();

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			_tmux: tmuxMock,
			_triage: triageAlways("extend"),
			_nudge: nudgeTracker().nudge,
			_recordFailure: failureMock.recordFailure,
		});

		expect(failureMock.calls).toHaveLength(1);
		expect(failureMock.calls[0]?.session.beadId).toBe("task-789");
	});

	test("Tier 0: recordFailure at escalation level 3+ (progressive termination)", async () => {
		const staleActivity = new Date(Date.now() - 60_000).toISOString();
		const stalledSince = new Date(Date.now() - 200_000).toISOString();
		const session = makeSession({
			agentName: "doomed-agent",
			capability: "builder",
			beadId: "task-999",
			tmuxSession: "overstory-doomed-agent",
			state: "stalled",
			lastActivity: staleActivity,
			escalationLevel: 2,
			stalledSince,
		});

		writeSessionsToStore(tempRoot, [session]);

		const tmuxMock = tmuxWithLiveness({ "overstory-doomed-agent": true });
		const failureMock = failureTracker();

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			nudgeIntervalMs: 60_000,
			_tmux: tmuxMock,
			_triage: triageAlways("extend"),
			_nudge: nudgeTracker().nudge,
			_recordFailure: failureMock.recordFailure,
		});

		// recordFailure should be called with Tier 0 for progressive escalation
		expect(failureMock.calls).toHaveLength(1);
		expect(failureMock.calls[0]?.tier).toBe(0);
		expect(failureMock.calls[0]?.session.agentName).toBe("doomed-agent");
		expect(failureMock.calls[0]?.reason).toContain("Progressive escalation");
	});
});

// === Run completion detection tests ===

describe("run completion detection", () => {
	const runId = "run-2026-02-18T15-00-00-000Z";

	test("nudges coordinator when all workers completed", async () => {
		const sessions = [
			makeSession({
				id: "s1",
				agentName: "builder-one",
				capability: "builder",
				tmuxSession: "overstory-agent-fake-builder-one",
				state: "completed",
				runId,
				lastActivity: new Date().toISOString(),
			}),
			makeSession({
				id: "s2",
				agentName: "builder-two",
				capability: "builder",
				tmuxSession: "overstory-agent-fake-builder-two",
				state: "completed",
				runId,
				lastActivity: new Date().toISOString(),
			}),
			makeSession({
				id: "s3",
				agentName: "coordinator",
				capability: "coordinator",
				tmuxSession: "overstory-agent-fake-coordinator",
				state: "working",
				runId,
				lastActivity: new Date().toISOString(),
			}),
		];

		writeSessionsToStore(tempRoot, sessions);
		await Bun.write(join(tempRoot, ".overstory", "current-run.txt"), runId);

		const nudgeMock = nudgeTracker();

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			_tmux: tmuxAllAlive(),
			_triage: triageAlways("extend"),
			_nudge: nudgeMock.nudge,
			_eventStore: null,
		});

		// Filter to only run-completion nudges targeting the coordinator
		const coordinatorNudges = nudgeMock.calls.filter(
			(c) => c.agentName === "coordinator" && c.message.includes("WATCHDOG"),
		);
		expect(coordinatorNudges).toHaveLength(1);
		// The test creates builders, so the message should be builder-specific
		expect(coordinatorNudges[0]?.message).toContain("builder");
		expect(coordinatorNudges[0]?.message).toContain("merge/cleanup");
	});

	test("does not nudge when some workers still active", async () => {
		const sessions = [
			makeSession({
				id: "s1",
				agentName: "builder-one",
				capability: "builder",
				tmuxSession: "overstory-agent-fake-builder-one",
				state: "completed",
				runId,
				lastActivity: new Date().toISOString(),
			}),
			makeSession({
				id: "s2",
				agentName: "builder-two",
				capability: "builder",
				tmuxSession: "overstory-agent-fake-builder-two",
				state: "working",
				runId,
				lastActivity: new Date().toISOString(),
			}),
		];

		writeSessionsToStore(tempRoot, sessions);
		await Bun.write(join(tempRoot, ".overstory", "current-run.txt"), runId);

		const nudgeMock = nudgeTracker();

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			_tmux: tmuxAllAlive(),
			_triage: triageAlways("extend"),
			_nudge: nudgeMock.nudge,
			_eventStore: null,
		});

		const coordinatorNudges = nudgeMock.calls.filter(
			(c) => c.agentName === "coordinator" && c.message.includes("worker"),
		);
		expect(coordinatorNudges).toHaveLength(0);
	});

	test("does not nudge when already notified (dedup marker)", async () => {
		const sessions = [
			makeSession({
				id: "s1",
				agentName: "builder-one",
				capability: "builder",
				tmuxSession: "overstory-agent-fake-builder-one",
				state: "completed",
				runId,
				lastActivity: new Date().toISOString(),
			}),
			makeSession({
				id: "s2",
				agentName: "builder-two",
				capability: "builder",
				tmuxSession: "overstory-agent-fake-builder-two",
				state: "completed",
				runId,
				lastActivity: new Date().toISOString(),
			}),
		];

		writeSessionsToStore(tempRoot, sessions);
		await Bun.write(join(tempRoot, ".overstory", "current-run.txt"), runId);
		// Pre-write dedup marker
		await Bun.write(join(tempRoot, ".overstory", "run-complete-notified.txt"), runId);

		const nudgeMock = nudgeTracker();

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			_tmux: tmuxAllAlive(),
			_triage: triageAlways("extend"),
			_nudge: nudgeMock.nudge,
			_eventStore: null,
		});

		const coordinatorNudges = nudgeMock.calls.filter(
			(c) => c.agentName === "coordinator" && c.message.includes("worker"),
		);
		expect(coordinatorNudges).toHaveLength(0);
	});

	test("skips completion check when no run ID", async () => {
		const sessions = [
			makeSession({
				id: "s1",
				agentName: "builder-one",
				capability: "builder",
				tmuxSession: "overstory-agent-fake-builder-one",
				state: "completed",
				runId,
				lastActivity: new Date().toISOString(),
			}),
			makeSession({
				id: "s2",
				agentName: "builder-two",
				capability: "builder",
				tmuxSession: "overstory-agent-fake-builder-two",
				state: "completed",
				runId,
				lastActivity: new Date().toISOString(),
			}),
		];

		writeSessionsToStore(tempRoot, sessions);
		// Do NOT write current-run.txt

		const nudgeMock = nudgeTracker();

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			_tmux: tmuxAllAlive(),
			_triage: triageAlways("extend"),
			_nudge: nudgeMock.nudge,
			_eventStore: null,
		});

		const coordinatorNudges = nudgeMock.calls.filter(
			(c) => c.agentName === "coordinator" && c.message.includes("worker"),
		);
		expect(coordinatorNudges).toHaveLength(0);
	});

	test("ignores coordinator and monitor sessions for completion check", async () => {
		const sessions = [
			makeSession({
				id: "s1",
				agentName: "coordinator",
				capability: "coordinator",
				tmuxSession: "overstory-agent-fake-coordinator",
				state: "working",
				runId,
				lastActivity: new Date().toISOString(),
			}),
			makeSession({
				id: "s2",
				agentName: "monitor",
				capability: "monitor",
				tmuxSession: "overstory-agent-fake-monitor",
				state: "working",
				runId,
				lastActivity: new Date().toISOString(),
			}),
			makeSession({
				id: "s3",
				agentName: "builder-one",
				capability: "builder",
				tmuxSession: "overstory-agent-fake-builder-one",
				state: "completed",
				runId,
				lastActivity: new Date().toISOString(),
			}),
			makeSession({
				id: "s4",
				agentName: "builder-two",
				capability: "builder",
				tmuxSession: "overstory-agent-fake-builder-two",
				state: "completed",
				runId,
				lastActivity: new Date().toISOString(),
			}),
		];

		writeSessionsToStore(tempRoot, sessions);
		await Bun.write(join(tempRoot, ".overstory", "current-run.txt"), runId);

		const nudgeMock = nudgeTracker();

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			_tmux: tmuxAllAlive(),
			_triage: triageAlways("extend"),
			_nudge: nudgeMock.nudge,
			_eventStore: null,
		});

		// Nudge IS sent because coordinator/monitor are excluded from worker count
		const coordinatorNudges = nudgeMock.calls.filter(
			(c) => c.agentName === "coordinator" && c.message.includes("WATCHDOG"),
		);
		expect(coordinatorNudges).toHaveLength(1);
		// The test creates builders, so the message should be builder-specific
		expect(coordinatorNudges[0]?.message).toContain("builder");
		expect(coordinatorNudges[0]?.message).toContain("merge/cleanup");
	});

	test("does not nudge when no worker sessions in run", async () => {
		const sessions = [
			makeSession({
				id: "s1",
				agentName: "coordinator",
				capability: "coordinator",
				tmuxSession: "overstory-agent-fake-coordinator",
				state: "working",
				runId,
				lastActivity: new Date().toISOString(),
			}),
			makeSession({
				id: "s2",
				agentName: "monitor",
				capability: "monitor",
				tmuxSession: "overstory-agent-fake-monitor",
				state: "working",
				runId,
				lastActivity: new Date().toISOString(),
			}),
		];

		writeSessionsToStore(tempRoot, sessions);
		await Bun.write(join(tempRoot, ".overstory", "current-run.txt"), runId);

		const nudgeMock = nudgeTracker();

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			_tmux: tmuxAllAlive(),
			_triage: triageAlways("extend"),
			_nudge: nudgeMock.nudge,
			_eventStore: null,
		});

		const coordinatorNudges = nudgeMock.calls.filter(
			(c) => c.agentName === "coordinator" && c.message.includes("worker"),
		);
		expect(coordinatorNudges).toHaveLength(0);
	});

	test("records run_complete event when all workers done", async () => {
		const sessions = [
			makeSession({
				id: "s1",
				agentName: "builder-one",
				capability: "builder",
				tmuxSession: "overstory-agent-fake-builder-one",
				state: "completed",
				runId,
				lastActivity: new Date().toISOString(),
			}),
			makeSession({
				id: "s2",
				agentName: "builder-two",
				capability: "builder",
				tmuxSession: "overstory-agent-fake-builder-two",
				state: "completed",
				runId,
				lastActivity: new Date().toISOString(),
			}),
		];

		writeSessionsToStore(tempRoot, sessions);
		await Bun.write(join(tempRoot, ".overstory", "current-run.txt"), runId);

		const eventsDbPath = join(tempRoot, ".overstory", "events.db");
		const eventStore = createEventStore(eventsDbPath);

		try {
			await runDaemonTick({
				root: tempRoot,
				...THRESHOLDS,
				_tmux: tmuxAllAlive(),
				_triage: triageAlways("extend"),
				_nudge: nudgeTracker().nudge,
				_eventStore: eventStore,
			});
		} finally {
			eventStore.close();
		}

		// Read events back
		const store = createEventStore(eventsDbPath);
		try {
			const events = store.getTimeline({ since: "2000-01-01T00:00:00Z" });
			const runCompleteEvent = events.find((e) => {
				if (!e.data) return false;
				const data = JSON.parse(e.data) as Record<string, unknown>;
				return data.type === "run_complete";
			});
			expect(runCompleteEvent).toBeDefined();
			expect(runCompleteEvent?.level).toBe("info");
			expect(runCompleteEvent?.agentName).toBe("watchdog");
		} finally {
			store.close();
		}
	});

	test("writes dedup marker after nudging", async () => {
		const sessions = [
			makeSession({
				id: "s1",
				agentName: "builder-one",
				capability: "builder",
				tmuxSession: "overstory-agent-fake-builder-one",
				state: "completed",
				runId,
				lastActivity: new Date().toISOString(),
			}),
			makeSession({
				id: "s2",
				agentName: "builder-two",
				capability: "builder",
				tmuxSession: "overstory-agent-fake-builder-two",
				state: "completed",
				runId,
				lastActivity: new Date().toISOString(),
			}),
		];

		writeSessionsToStore(tempRoot, sessions);
		await Bun.write(join(tempRoot, ".overstory", "current-run.txt"), runId);

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			_tmux: tmuxAllAlive(),
			_triage: triageAlways("extend"),
			_nudge: nudgeTracker().nudge,
			_eventStore: null,
		});

		// Verify dedup marker was written
		const markerFile = Bun.file(join(tempRoot, ".overstory", "run-complete-notified.txt"));
		expect(await markerFile.exists()).toBe(true);
		const markerContent = await markerFile.text();
		expect(markerContent.trim()).toBe(runId);
	});

	test("scout-only completion sends phase-appropriate message", async () => {
		const sessions = [
			makeSession({
				id: "s1",
				agentName: "scout-one",
				capability: "scout",
				tmuxSession: "overstory-agent-fake-scout-one",
				state: "completed",
				runId,
				lastActivity: new Date().toISOString(),
			}),
			makeSession({
				id: "s2",
				agentName: "scout-two",
				capability: "scout",
				tmuxSession: "overstory-agent-fake-scout-two",
				state: "completed",
				runId,
				lastActivity: new Date().toISOString(),
			}),
		];

		writeSessionsToStore(tempRoot, sessions);
		await Bun.write(join(tempRoot, ".overstory", "current-run.txt"), runId);

		const nudgeMock = nudgeTracker();

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			_tmux: tmuxAllAlive(),
			_triage: triageAlways("extend"),
			_nudge: nudgeMock.nudge,
			_eventStore: null,
		});

		const coordinatorNudges = nudgeMock.calls.filter(
			(c) => c.agentName === "coordinator" && c.message.includes("WATCHDOG"),
		);
		expect(coordinatorNudges).toHaveLength(1);
		expect(coordinatorNudges[0]?.message).toContain("scout");
		expect(coordinatorNudges[0]?.message).toContain("next phase");
		// Must NOT say "merge/cleanup" for scouts
		expect(coordinatorNudges[0]?.message).not.toContain("merge/cleanup");
	});

	test("mixed capabilities send generic message with breakdown", async () => {
		const sessions = [
			makeSession({
				id: "s1",
				agentName: "scout-one",
				capability: "scout",
				tmuxSession: "overstory-agent-fake-scout-one",
				state: "completed",
				runId,
				lastActivity: new Date().toISOString(),
			}),
			makeSession({
				id: "s2",
				agentName: "builder-one",
				capability: "builder",
				tmuxSession: "overstory-agent-fake-builder-one",
				state: "completed",
				runId,
				lastActivity: new Date().toISOString(),
			}),
		];

		writeSessionsToStore(tempRoot, sessions);
		await Bun.write(join(tempRoot, ".overstory", "current-run.txt"), runId);

		const nudgeMock = nudgeTracker();

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			_tmux: tmuxAllAlive(),
			_triage: triageAlways("extend"),
			_nudge: nudgeMock.nudge,
			_eventStore: null,
		});

		const coordinatorNudges = nudgeMock.calls.filter(
			(c) => c.agentName === "coordinator" && c.message.includes("WATCHDOG"),
		);
		expect(coordinatorNudges).toHaveLength(1);
		expect(coordinatorNudges[0]?.message).toContain("(builder, scout)");
		expect(coordinatorNudges[0]?.message).toContain("next steps");
	});

	test("reviewer-only completion sends review-specific message", async () => {
		const sessions = [
			makeSession({
				id: "s1",
				agentName: "reviewer-one",
				capability: "reviewer",
				tmuxSession: "overstory-agent-fake-reviewer-one",
				state: "completed",
				runId,
				lastActivity: new Date().toISOString(),
			}),
		];

		writeSessionsToStore(tempRoot, sessions);
		await Bun.write(join(tempRoot, ".overstory", "current-run.txt"), runId);

		const nudgeMock = nudgeTracker();

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			_tmux: tmuxAllAlive(),
			_triage: triageAlways("extend"),
			_nudge: nudgeMock.nudge,
			_eventStore: null,
		});

		const coordinatorNudges = nudgeMock.calls.filter(
			(c) => c.agentName === "coordinator" && c.message.includes("WATCHDOG"),
		);
		expect(coordinatorNudges).toHaveLength(1);
		expect(coordinatorNudges[0]?.message).toContain("reviewer");
		expect(coordinatorNudges[0]?.message).toContain("Reviews done");
	});

	test("run_complete event includes capabilities and phase fields", async () => {
		const sessions = [
			makeSession({
				id: "s1",
				agentName: "builder-one",
				capability: "builder",
				tmuxSession: "overstory-agent-fake-builder-one",
				state: "completed",
				runId,
				lastActivity: new Date().toISOString(),
			}),
		];

		writeSessionsToStore(tempRoot, sessions);
		await Bun.write(join(tempRoot, ".overstory", "current-run.txt"), runId);

		const eventsDbPath = join(tempRoot, ".overstory", "events.db");
		const eventStore = createEventStore(eventsDbPath);

		try {
			await runDaemonTick({
				root: tempRoot,
				...THRESHOLDS,
				_tmux: tmuxAllAlive(),
				_triage: triageAlways("extend"),
				_nudge: nudgeTracker().nudge,
				_eventStore: eventStore,
			});
		} finally {
			eventStore.close();
		}

		const store = createEventStore(eventsDbPath);
		try {
			const events = store.getTimeline({ since: "2000-01-01T00:00:00Z" });
			const runCompleteEvent = events.find((e) => {
				if (!e.data) return false;
				const data = JSON.parse(e.data) as Record<string, unknown>;
				return data.type === "run_complete";
			});
			expect(runCompleteEvent).toBeDefined();
			const data = JSON.parse(runCompleteEvent?.data ?? "{}") as Record<string, unknown>;
			expect(data.capabilities).toEqual(["builder"]);
			expect(data.phase).toBe("builder");
		} finally {
			store.close();
		}
	});
});

// === buildCompletionMessage unit tests ===

describe("buildCompletionMessage", () => {
	const testRunId = "run-test-123";

	test("all scouts → contains 'scout' and 'Ready for next phase'", () => {
		const sessions = [
			makeSession({ capability: "scout", agentName: "scout-1" }),
			makeSession({ capability: "scout", agentName: "scout-2" }),
		];
		const msg = buildCompletionMessage(sessions, testRunId);
		expect(msg).toContain("scout");
		expect(msg).toContain("Ready for next phase");
		expect(msg).not.toContain("merge/cleanup");
	});

	test("all builders → contains 'builder' and 'Ready for merge/cleanup'", () => {
		const sessions = [
			makeSession({ capability: "builder", agentName: "builder-1" }),
			makeSession({ capability: "builder", agentName: "builder-2" }),
		];
		const msg = buildCompletionMessage(sessions, testRunId);
		expect(msg).toContain("builder");
		expect(msg).toContain("Ready for merge/cleanup");
	});

	test("all reviewers → contains 'reviewer' and 'Reviews done'", () => {
		const sessions = [makeSession({ capability: "reviewer", agentName: "reviewer-1" })];
		const msg = buildCompletionMessage(sessions, testRunId);
		expect(msg).toContain("reviewer");
		expect(msg).toContain("Reviews done");
	});

	test("all leads → contains 'lead' and 'Ready for merge/cleanup'", () => {
		const sessions = [makeSession({ capability: "lead", agentName: "lead-1" })];
		const msg = buildCompletionMessage(sessions, testRunId);
		expect(msg).toContain("lead");
		expect(msg).toContain("Ready for merge/cleanup");
	});

	test("all mergers → contains 'merger' and 'Merges done'", () => {
		const sessions = [makeSession({ capability: "merger", agentName: "merger-1" })];
		const msg = buildCompletionMessage(sessions, testRunId);
		expect(msg).toContain("merger");
		expect(msg).toContain("Merges done");
	});

	test("mixed capabilities → contains breakdown and 'Ready for next steps'", () => {
		const sessions = [
			makeSession({ capability: "scout", agentName: "scout-1" }),
			makeSession({ capability: "builder", agentName: "builder-1" }),
		];
		const msg = buildCompletionMessage(sessions, testRunId);
		expect(msg).toContain("(builder, scout)");
		expect(msg).toContain("Ready for next steps");
	});

	test("message includes the run ID", () => {
		const sessions = [makeSession({ capability: "builder", agentName: "builder-1" })];
		const msg = buildCompletionMessage(sessions, testRunId);
		expect(msg).toContain(testRunId);
	});

	test("message includes the worker count", () => {
		const sessions = [
			makeSession({ capability: "scout", agentName: "scout-1" }),
			makeSession({ capability: "scout", agentName: "scout-2" }),
			makeSession({ capability: "scout", agentName: "scout-3" }),
		];
		const msg = buildCompletionMessage(sessions, testRunId);
		expect(msg).toContain("3");
	});
});

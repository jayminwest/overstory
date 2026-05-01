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
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventStore } from "../events/store.ts";
import { createMailStore } from "../mail/store.ts";
import { createRunStore, createSessionStore } from "../sessions/store.ts";
import { cleanupTempDir } from "../test-helpers.ts";
import type { AgentSession, HealthCheck, StoredEvent, WorkerDiedPayload } from "../types.ts";
import {
	buildCompletionMessage,
	type RunIdWarnState,
	runDaemonTick,
	startDaemon,
} from "./daemon.ts";

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

/**
 * Mark a run as active: write current-run.txt AND insert a row in the runs
 * table (sessions.db). The watchdog now validates the id against the runs
 * table before running the run-completion check (overstory-87bf), so tests
 * must seed both surfaces to mirror production reality.
 */
async function setActiveRun(root: string, runId: string): Promise<void> {
	await Bun.write(join(root, ".overstory", "current-run.txt"), runId);
	const runStore = createRunStore(join(root, ".overstory", "sessions.db"));
	try {
		runStore.createRun({
			id: runId,
			startedAt: new Date().toISOString(),
			coordinatorSessionId: null,
			status: "active",
		});
	} catch {
		// Row may already exist (re-seeding within one test) — non-fatal.
	} finally {
		runStore.close();
	}
}

/** Build a fresh, isolated RunIdWarnState for tests (overstory-87bf). */
function freshRunIdWarnState(): RunIdWarnState {
	return { missingFileWarned: false, unknownIds: new Set() };
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
		taskId: "test-task",
		tmuxSession: "overstory-test-agent",
		state: "working",
		pid: process.pid, // Use our own PID so isProcessRunning returns true
		parentAgent: null,
		depth: 0,
		runId: null,
		escalationLevel: 0,
		stalledSince: null,
		transcriptPath: null,
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
	await cleanupTempDir(tempRoot);
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

	test("first tick with stalled agent sets stalledSince and stays at level 0 (warn)", async () => {
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

	// Regression tests for overstory-74ce: killAgent() must never call
	// tmux.killSession("") for headless agents — an empty `-t` argument is
	// prefix-matched and would wildcard-kill the entire overstory tmux server.

	test("spawn-per-turn agent at level 3 termination does NOT call tmux.killSession", async () => {
		const nudgeIntervalMs = 60_000;
		const stalledSince = new Date(Date.now() - 4 * nudgeIntervalMs).toISOString();
		const staleActivity = new Date(Date.now() - THRESHOLDS.staleThresholdMs * 2).toISOString();

		// Spawn-per-turn worker between turns: tmuxSession === "" AND pid === null.
		// Before the fix, killAgent fell through to tmux.killSession("") which
		// prefix-matches every session in the overstory tmux server.
		const session = makeSession({
			agentName: "spawn-per-turn-doomed",
			tmuxSession: "",
			pid: null,
			state: "stalled",
			lastActivity: staleActivity,
			escalationLevel: 2,
			stalledSince,
		});

		writeSessionsToStore(tempRoot, [session]);

		// No tmux sessions registered — emulates production where the spawn-per-turn
		// agent has no named session.
		const tmuxMock = tmuxWithLiveness({});

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			nudgeIntervalMs,
			tier1Enabled: false,
			_tmux: tmuxMock,
			_triage: triageAlways("extend"),
			_nudge: nudgeTracker().nudge,
			_eventStore: null,
			_recordFailure: async () => {},
			_getConnection: () => undefined,
			_removeConnection: () => {},
			_tailerRegistry: new Map(),
			_findLatestStdoutLog: async () => null,
		});

		// Critical assertion: no wildcard kill attempt. tmuxMock.killed must be empty.
		expect(tmuxMock.killed).toHaveLength(0);

		// The session is still transitioned to zombie — termination semantics are preserved,
		// just without the wildcard tmux kill.
		const reloaded = readSessionsFromStore(tempRoot);
		expect(reloaded[0]?.state).toBe("zombie");
		expect(reloaded[0]?.escalationLevel).toBe(0);
		expect(reloaded[0]?.stalledSince).toBeNull();
	});

	test("long-lived headless agent at level 3 termination kills pid tree, not tmux", async () => {
		const nudgeIntervalMs = 60_000;
		const stalledSince = new Date(Date.now() - 4 * nudgeIntervalMs).toISOString();
		const staleActivity = new Date(Date.now() - THRESHOLDS.staleThresholdMs * 2).toISOString();

		// Long-lived headless capability (e.g. coordinator/orchestrator/monitor):
		// tmuxSession === "" AND pid !== null. The PID tree should be killed; tmux
		// must not be touched.
		const session = makeSession({
			agentName: "headless-long-lived-doomed",
			tmuxSession: "",
			pid: process.pid, // alive PID — health eval won't short-circuit to direct terminate
			state: "stalled",
			lastActivity: staleActivity,
			escalationLevel: 2,
			stalledSince,
		});

		writeSessionsToStore(tempRoot, [session]);

		const killedPids: number[] = [];
		const procMock = {
			isAlive: (pid: number) => {
				try {
					process.kill(pid, 0);
					return true;
				} catch {
					return false;
				}
			},
			killTree: async (pid: number) => {
				killedPids.push(pid);
			},
		};

		const tmuxMock = tmuxWithLiveness({});

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			nudgeIntervalMs,
			tier1Enabled: false,
			_tmux: tmuxMock,
			_triage: triageAlways("extend"),
			_nudge: nudgeTracker().nudge,
			_process: procMock,
			_eventStore: null,
			_recordFailure: async () => {},
			_getConnection: () => undefined,
			_removeConnection: () => {},
			_tailerRegistry: new Map(),
			_findLatestStdoutLog: async () => null,
		});

		// PID tree was killed; tmux.killSession was never called.
		expect(killedPids).toContain(process.pid);
		expect(tmuxMock.killed).toHaveLength(0);

		const reloaded = readSessionsFromStore(tempRoot);
		expect(reloaded[0]?.state).toBe("zombie");
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
			taskId: "task",
			tmuxSession: "overstory-old-agent",
			state: "working",
			pid: process.pid,
			escalationLevel: 0,
			stalledSince: null,
			transcriptPath: null,
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

	test("triage fallback event includes triageFailed: true when _triage returns TriageResult with fallback", async () => {
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
				_triage: async () => ({
					verdict: "extend" as const,
					fallback: true,
					reason: "Claude unavailable",
				}),
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

		const triageData = JSON.parse(triageEvent?.data ?? "{}") as Record<string, unknown>;
		expect(triageData.verdict).toBe("extend");
		expect(triageData.triageFailed).toBe(true);
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
		await setActiveRun(tempRoot, runId);

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
		await cleanupTempDir(tempRoot);
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
			taskId: "task-123",
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
		expect(failureMock.calls[0]?.session.taskId).toBe("task-123");
		// Reason should be either the reconciliationNote or default "Process terminated"
		expect(failureMock.calls[0]?.reason).toBeDefined();
	});

	test("Tier 1: recordFailure called when triage returns terminate", async () => {
		const staleActivity = new Date(Date.now() - 60_000).toISOString();
		const stalledSince = new Date(Date.now() - 130_000).toISOString();
		const session = makeSession({
			agentName: "triaged-agent",
			capability: "scout",
			taskId: "task-456",
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
		expect(failureMock.calls[0]?.session.taskId).toBe("task-456");
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

	test("recordFailure includes evidenceBead when taskId is present", async () => {
		const session = makeSession({
			agentName: "beaded-agent",
			capability: "builder",
			taskId: "task-789",
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
		expect(failureMock.calls[0]?.session.taskId).toBe("task-789");
	});

	test("Tier 0: recordFailure called at escalation level 3+ (progressive termination)", async () => {
		const staleActivity = new Date(Date.now() - 60_000).toISOString();
		const stalledSince = new Date(Date.now() - 200_000).toISOString();
		const session = makeSession({
			agentName: "doomed-agent",
			capability: "builder",
			taskId: "task-999",
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
		await setActiveRun(tempRoot, runId);

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
		expect(coordinatorNudges[0]?.message).toContain("Awaiting lead verification");
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
		await setActiveRun(tempRoot, runId);

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
		await setActiveRun(tempRoot, runId);
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
		await setActiveRun(tempRoot, runId);

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
		expect(coordinatorNudges[0]?.message).toContain("Awaiting lead verification");
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
		await setActiveRun(tempRoot, runId);

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
		await setActiveRun(tempRoot, runId);

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
		await setActiveRun(tempRoot, runId);

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
		await setActiveRun(tempRoot, runId);

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
		await setActiveRun(tempRoot, runId);

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
		await setActiveRun(tempRoot, runId);

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
		await setActiveRun(tempRoot, runId);

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

	// overstory-e130: a run that mixes `completed` and `zombie` workers must
	// still notify the coordinator. Before the fix, the every-completed predicate
	// stranded the coordinator forever whenever the watchdog killed any worker.
	test("nudges coordinator when workers are a mix of completed and zombie", async () => {
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
				state: "zombie",
				runId,
				lastActivity: new Date().toISOString(),
			}),
		];

		writeSessionsToStore(tempRoot, sessions);
		await setActiveRun(tempRoot, runId);

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
		expect(coordinatorNudges[0]?.message).toContain("have terminated");
		expect(coordinatorNudges[0]?.message).toContain("(1 completed, 1 zombie)");
	});

	test("nudges coordinator when every worker is zombie", async () => {
		const sessions = [
			makeSession({
				id: "s1",
				agentName: "builder-one",
				capability: "builder",
				tmuxSession: "overstory-agent-fake-builder-one",
				state: "zombie",
				runId,
				lastActivity: new Date().toISOString(),
			}),
			makeSession({
				id: "s2",
				agentName: "builder-two",
				capability: "builder",
				tmuxSession: "overstory-agent-fake-builder-two",
				state: "zombie",
				runId,
				lastActivity: new Date().toISOString(),
			}),
		];

		writeSessionsToStore(tempRoot, sessions);
		await setActiveRun(tempRoot, runId);

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
		expect(coordinatorNudges[0]?.message).toContain("(0 completed, 2 zombie)");
	});

	test("does not nudge when a working worker remains alongside a zombie", async () => {
		const sessions = [
			makeSession({
				id: "s1",
				agentName: "builder-one",
				capability: "builder",
				tmuxSession: "overstory-agent-fake-builder-one",
				state: "zombie",
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
		await setActiveRun(tempRoot, runId);

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
		expect(coordinatorNudges).toHaveLength(0);
	});

	test("run_complete event with zombies records zombieAgents and warn level", async () => {
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
				state: "zombie",
				runId,
				lastActivity: new Date().toISOString(),
			}),
		];

		writeSessionsToStore(tempRoot, sessions);
		await setActiveRun(tempRoot, runId);

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
			expect(runCompleteEvent?.level).toBe("warn");
			const data = JSON.parse(runCompleteEvent?.data ?? "{}") as Record<string, unknown>;
			expect(data.completedAgents).toEqual(["builder-one"]);
			expect(data.zombieAgents).toEqual(["builder-two"]);
			expect(data.workerCount).toBe(2);
		} finally {
			store.close();
		}
	});

	test("missing current-run.txt: warns once, skips run-completion check (overstory-87bf)", async () => {
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
		// Deliberately do NOT call setActiveRun — current-run.txt absent.

		const nudgeMock = nudgeTracker();
		const warnState = freshRunIdWarnState();

		const stderrWrites: string[] = [];
		const originalStderrWrite = process.stderr.write.bind(process.stderr);
		process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
			stderrWrites.push(typeof chunk === "string" ? chunk : String(chunk));
			return originalStderrWrite(chunk as string, ...(rest as []));
		}) as typeof process.stderr.write;

		try {
			await runDaemonTick({
				root: tempRoot,
				...THRESHOLDS,
				_tmux: tmuxAllAlive(),
				_triage: triageAlways("extend"),
				_nudge: nudgeMock.nudge,
				_eventStore: null,
				_runIdWarnState: warnState,
			});

			// Tick again to confirm the warning dedupes for the same cause.
			await runDaemonTick({
				root: tempRoot,
				...THRESHOLDS,
				_tmux: tmuxAllAlive(),
				_triage: triageAlways("extend"),
				_nudge: nudgeMock.nudge,
				_eventStore: null,
				_runIdWarnState: warnState,
			});
		} finally {
			process.stderr.write = originalStderrWrite;
		}

		// Run-completion skip is observable: no coordinator nudge was sent.
		const coordinatorNudges = nudgeMock.calls.filter(
			(c) => c.agentName === "coordinator" && c.message.includes("WATCHDOG"),
		);
		expect(coordinatorNudges).toHaveLength(0);

		// Warning logged exactly once across the two ticks.
		expect(warnState.missingFileWarned).toBe(true);
		const missingWarnings = stderrWrites.filter((w) =>
			w.includes("[WATCHDOG] current-run.txt missing"),
		);
		expect(missingWarnings).toHaveLength(1);
	});

	test("stale current-run.txt id (no row in runs table): warns once per id, skips check (overstory-87bf)", async () => {
		const staleId = "run-stale-2026-01-01T00-00-00-000Z";
		const sessions = [
			makeSession({
				id: "s1",
				agentName: "builder-one",
				capability: "builder",
				tmuxSession: "overstory-agent-fake-builder-one",
				state: "completed",
				runId: staleId,
				lastActivity: new Date().toISOString(),
			}),
			makeSession({
				id: "s2",
				agentName: "builder-two",
				capability: "builder",
				tmuxSession: "overstory-agent-fake-builder-two",
				state: "completed",
				runId: staleId,
				lastActivity: new Date().toISOString(),
			}),
		];

		writeSessionsToStore(tempRoot, sessions);
		// Write current-run.txt but DO NOT seed the runs table — the lookup
		// will return null, exercising the stale-id branch.
		await Bun.write(join(tempRoot, ".overstory", "current-run.txt"), staleId);

		const nudgeMock = nudgeTracker();
		const warnState = freshRunIdWarnState();

		const stderrWrites: string[] = [];
		const originalStderrWrite = process.stderr.write.bind(process.stderr);
		process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
			stderrWrites.push(typeof chunk === "string" ? chunk : String(chunk));
			return originalStderrWrite(chunk as string, ...(rest as []));
		}) as typeof process.stderr.write;

		try {
			await runDaemonTick({
				root: tempRoot,
				...THRESHOLDS,
				_tmux: tmuxAllAlive(),
				_triage: triageAlways("extend"),
				_nudge: nudgeMock.nudge,
				_eventStore: null,
				_runIdWarnState: warnState,
			});

			await runDaemonTick({
				root: tempRoot,
				...THRESHOLDS,
				_tmux: tmuxAllAlive(),
				_triage: triageAlways("extend"),
				_nudge: nudgeMock.nudge,
				_eventStore: null,
				_runIdWarnState: warnState,
			});
		} finally {
			process.stderr.write = originalStderrWrite;
		}

		// Run-completion skip is observable: no coordinator nudge.
		const coordinatorNudges = nudgeMock.calls.filter(
			(c) => c.agentName === "coordinator" && c.message.includes("WATCHDOG"),
		);
		expect(coordinatorNudges).toHaveLength(0);

		// Stale-id was recorded once, missing-file path was NOT triggered.
		expect(warnState.unknownIds.has(staleId)).toBe(true);
		expect(warnState.missingFileWarned).toBe(false);
		const staleWarnings = stderrWrites.filter((w) =>
			w.includes(`points to unknown run "${staleId}"`),
		);
		expect(staleWarnings).toHaveLength(1);
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

	test("all builders → contains 'builder' and 'Awaiting lead verification' (not merge authorization)", () => {
		const sessions = [
			makeSession({ capability: "builder", agentName: "builder-1" }),
			makeSession({ capability: "builder", agentName: "builder-2" }),
		];
		const msg = buildCompletionMessage(sessions, testRunId);
		expect(msg).toContain("builder");
		expect(msg).toContain("Awaiting lead verification");
		expect(msg).not.toContain("merge/cleanup");
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

	// overstory-e130: zombie workers must surface in the message so the coordinator
	// reads "have terminated (...)" instead of being misled into "have completed".
	test("mix of completed and zombie workers → 'have terminated' with completed/zombie qualifier", () => {
		const sessions = [
			makeSession({ capability: "builder", agentName: "builder-1", state: "completed" }),
			makeSession({ capability: "builder", agentName: "builder-2", state: "zombie" }),
			makeSession({ capability: "builder", agentName: "builder-3", state: "completed" }),
		];
		const msg = buildCompletionMessage(sessions, testRunId);
		expect(msg).toContain("have terminated");
		expect(msg).toContain("(2 completed, 1 zombie)");
		expect(msg).not.toContain("have completed");
		// Capability-specific suffix is preserved
		expect(msg).toContain("Awaiting lead verification");
	});

	test("all-zombie batch → '(0 completed, N zombie)' qualifier", () => {
		const sessions = [
			makeSession({ capability: "scout", agentName: "scout-1", state: "zombie" }),
			makeSession({ capability: "scout", agentName: "scout-2", state: "zombie" }),
		];
		const msg = buildCompletionMessage(sessions, testRunId);
		expect(msg).toContain("have terminated");
		expect(msg).toContain("(0 completed, 2 zombie)");
		expect(msg).toContain("Ready for next phase");
	});

	test("mixed-capability batch with zombies includes both qualifier and capability breakdown", () => {
		const sessions = [
			makeSession({ capability: "scout", agentName: "scout-1", state: "completed" }),
			makeSession({ capability: "builder", agentName: "builder-1", state: "zombie" }),
		];
		const msg = buildCompletionMessage(sessions, testRunId);
		expect(msg).toContain("have terminated");
		expect(msg).toContain("(1 completed, 1 zombie)");
		expect(msg).toContain("(builder, scout)");
		expect(msg).toContain("Ready for next steps");
	});

	test("all-completed batch keeps existing 'have completed' phrasing (no zombie qualifier)", () => {
		const sessions = [
			makeSession({ capability: "builder", agentName: "builder-1", state: "completed" }),
			makeSession({ capability: "builder", agentName: "builder-2", state: "completed" }),
		];
		const msg = buildCompletionMessage(sessions, testRunId);
		expect(msg).toContain("have completed");
		expect(msg).not.toContain("have terminated");
		expect(msg).not.toContain("zombie");
	});
});

// === Bug fix tests: headless agent kill blast radius + stale detection ===

describe("headless agent kill blast radius fix (Bug 1)", () => {
	/**
	 * Track PID kill calls without spawning real processes.
	 * Also surfaces killTree calls so tests can assert on them.
	 */
	function processTracker(): {
		isAlive: (pid: number) => boolean;
		killTree: (pid: number) => Promise<void>;
		killed: number[];
	} {
		const killed: number[] = [];
		return {
			isAlive: (pid: number) => {
				try {
					process.kill(pid, 0);
					return true;
				} catch {
					return false;
				}
			},
			killTree: async (pid: number) => {
				killed.push(pid);
			},
			killed,
		};
	}

	test("headless agent at escalation level 3 kills PID, not tmux session", async () => {
		const nudgeIntervalMs = 60_000;
		// stalledSince is 4 intervals ago — expectedLevel = floor(4) = 4, clamped to MAX (3)
		const stalledSince = new Date(Date.now() - 4 * nudgeIntervalMs).toISOString();
		const staleActivity = new Date(Date.now() - THRESHOLDS.staleThresholdMs * 2).toISOString();

		const session = makeSession({
			agentName: "headless-stalled",
			tmuxSession: "", // headless
			pid: process.pid, // alive PID — ZFC won't trigger direct terminate
			state: "stalled",
			lastActivity: staleActivity,
			escalationLevel: 2,
			stalledSince,
		});

		writeSessionsToStore(tempRoot, [session]);

		const proc = processTracker();
		// tmux mock: isSessionAlive("") returns true — simulates prefix-match bug scenario
		const tmuxMock = tmuxWithLiveness({ "": true });

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			nudgeIntervalMs,
			tier1Enabled: false,
			_tmux: tmuxMock,
			_triage: triageAlways("extend"),
			_process: proc,
			_eventStore: null,
			_recordFailure: async () => {},
			_getConnection: () => undefined,
			_removeConnection: () => {},
			_tailerRegistry: new Map(),
			_findLatestStdoutLog: async () => null,
		});

		// PID was killed via killTree, NOT via tmux killSession("")
		expect(proc.killed).toContain(process.pid);
		expect(tmuxMock.killed).not.toContain("");
	});

	test("headless agent direct terminate kills PID, not tmux", async () => {
		// PID 999999 is virtually guaranteed not to exist — health check sees it as dead
		const deadPid = 999999;
		const session = makeSession({
			agentName: "headless-dead-pid",
			tmuxSession: "", // headless
			pid: deadPid,
			state: "working",
			lastActivity: new Date().toISOString(),
		});

		writeSessionsToStore(tempRoot, [session]);

		const proc = processTracker();
		// tmux mock: isSessionAlive("") returns true — would kill everything without the fix
		const tmuxMock = tmuxWithLiveness({ "": true });

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			_tmux: tmuxMock,
			_triage: triageAlways("extend"),
			_process: proc,
			_eventStore: null,
			_recordFailure: async () => {},
			_getConnection: () => undefined,
			_removeConnection: () => {},
			_tailerRegistry: new Map(),
			_findLatestStdoutLog: async () => null,
		});

		// Should have attempted PID kill, NOT tmux killSession("")
		expect(proc.killed).toContain(deadPid);
		expect(tmuxMock.killed).not.toContain("");
	});

	test("triage terminate on headless agent kills PID, not tmux", async () => {
		const nudgeIntervalMs = 60_000;
		// stalledSince is 2.5 intervals ago — expectedLevel = floor(2.5) = 2 → triage fires
		const stalledSince = new Date(Date.now() - 2.5 * nudgeIntervalMs).toISOString();
		const staleActivity = new Date(Date.now() - THRESHOLDS.staleThresholdMs * 2).toISOString();

		const session = makeSession({
			agentName: "headless-triage-terminate",
			tmuxSession: "", // headless
			pid: process.pid, // alive
			state: "stalled",
			lastActivity: staleActivity,
			escalationLevel: 1,
			stalledSince,
		});

		writeSessionsToStore(tempRoot, [session]);

		const proc = processTracker();
		const tmuxMock = tmuxWithLiveness({ "": true });

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			nudgeIntervalMs,
			tier1Enabled: true,
			_tmux: tmuxMock,
			_triage: triageAlways("terminate"), // AI triage says terminate
			_nudge: nudgeTracker().nudge,
			_process: proc,
			_eventStore: null,
			_recordFailure: async () => {},
			_getConnection: () => undefined,
			_removeConnection: () => {},
			_tailerRegistry: new Map(),
			_findLatestStdoutLog: async () => null,
		});

		// Should have killed the PID, not the tmux session
		expect(proc.killed).toContain(process.pid);
		expect(tmuxMock.killed).not.toContain("");
	});
});

describe("headless agent stale detection via events.db (Bug 2)", () => {
	test("headless agent with recent events in events.db is not flagged stale", async () => {
		const staleActivity = new Date(Date.now() - THRESHOLDS.staleThresholdMs * 2).toISOString();

		const session = makeSession({
			agentName: "headless-active",
			tmuxSession: "", // headless
			pid: process.pid, // alive
			state: "working",
			lastActivity: staleActivity, // stale — would trigger escalate without event fallback
		});

		writeSessionsToStore(tempRoot, [session]);

		const eventsDbPath = join(tempRoot, ".overstory", "events.db");
		const eventStore = createEventStore(eventsDbPath);

		try {
			// Insert a recent event for this agent (within the stale threshold window)
			eventStore.insert({
				runId: null,
				agentName: "headless-active",
				sessionId: null,
				eventType: "tool_end",
				toolName: "Read",
				toolArgs: null,
				toolDurationMs: 100,
				level: "info",
				data: null,
			});

			const checks: HealthCheck[] = [];

			await runDaemonTick({
				root: tempRoot,
				...THRESHOLDS,
				onHealthCheck: (c) => checks.push(c),
				_tmux: tmuxAllAlive(),
				_triage: triageAlways("extend"),
				_process: { isAlive: () => true, killTree: async () => {} },
				_eventStore: eventStore,
				_recordFailure: async () => {},
				_getConnection: () => undefined,
				_removeConnection: () => {},
				_tailerRegistry: new Map(),
				_findLatestStdoutLog: async () => null,
			});

			// Recent events found — lastActivity was refreshed, agent is NOT stalled
			expect(checks).toHaveLength(1);
			expect(checks[0]?.action).toBe("none");
			expect(checks[0]?.state).toBe("working");

			const reloaded = readSessionsFromStore(tempRoot);
			expect(reloaded[0]?.state).toBe("working");
		} finally {
			eventStore.close();
		}
	});

	test("headless agent with no recent events IS flagged stale", async () => {
		const staleActivity = new Date(Date.now() - THRESHOLDS.staleThresholdMs * 2).toISOString();

		const session = makeSession({
			agentName: "headless-silent",
			tmuxSession: "", // headless
			pid: process.pid, // alive
			state: "working",
			lastActivity: staleActivity, // stale
		});

		writeSessionsToStore(tempRoot, [session]);

		const eventsDbPath = join(tempRoot, ".overstory", "events.db");
		const eventStore = createEventStore(eventsDbPath);

		try {
			// No events inserted for this agent — event fallback finds nothing

			const checks: HealthCheck[] = [];

			await runDaemonTick({
				root: tempRoot,
				...THRESHOLDS,
				onHealthCheck: (c) => checks.push(c),
				_tmux: tmuxAllAlive(),
				_triage: triageAlways("extend"),
				_process: { isAlive: () => true, killTree: async () => {} },
				_eventStore: eventStore,
				_recordFailure: async () => {},
				_getConnection: () => undefined,
				_removeConnection: () => {},
				_tailerRegistry: new Map(),
				_findLatestStdoutLog: async () => null,
			});

			// No recent events — lastActivity stays stale, agent IS flagged stalled
			expect(checks).toHaveLength(1);
			expect(checks[0]?.action).toBe("escalate");
		} finally {
			eventStore.close();
		}
	});

	test("spawn-per-turn worker (pid=null) is NOT flagged zombie when actively emitting events (overstory-7a34)", async () => {
		// Repro: ov sling --capability lead → freshly slung headless lead has
		// tmuxSession='' AND pid=null (no persistent process between turns).
		// Previously the daemon's event-based liveness fallback was gated by
		// `pid !== null`, so spawn-per-turn workers' lastActivity was never
		// refreshed from events.db and they would flip to stalled / zombie
		// despite ov feed showing live tool activity.
		const staleActivity = new Date(Date.now() - THRESHOLDS.staleThresholdMs * 2).toISOString();

		const session = makeSession({
			agentName: "spawn-per-turn-lead",
			capability: "lead",
			tmuxSession: "", // headless
			pid: null, // spawn-per-turn: no persistent process between turns
			state: "working",
			lastActivity: staleActivity, // stale — would flip without event fallback
		});

		writeSessionsToStore(tempRoot, [session]);

		const eventsDbPath = join(tempRoot, ".overstory", "events.db");
		const eventStore = createEventStore(eventsDbPath);

		try {
			// Insert a recent tool event for this agent (matches ov feed activity)
			eventStore.insert({
				runId: null,
				agentName: "spawn-per-turn-lead",
				sessionId: null,
				eventType: "tool_end",
				toolName: "Edit",
				toolArgs: null,
				toolDurationMs: 50,
				level: "info",
				data: null,
			});

			const checks: HealthCheck[] = [];

			await runDaemonTick({
				root: tempRoot,
				...THRESHOLDS,
				onHealthCheck: (c) => checks.push(c),
				_tmux: tmuxAllAlive(),
				_triage: triageAlways("extend"),
				_process: { isAlive: () => true, killTree: async () => {} },
				_eventStore: eventStore,
				_recordFailure: async () => {},
				_getConnection: () => undefined,
				_removeConnection: () => {},
				_tailerRegistry: new Map(),
				_findLatestStdoutLog: async () => null,
			});

			// lastActivity refreshed from events.db → spawn-per-turn evaluation
			// path keeps the agent in working, NOT zombie.
			expect(checks).toHaveLength(1);
			expect(checks[0]?.action).toBe("none");
			expect(checks[0]?.state).toBe("working");

			const reloaded = readSessionsFromStore(tempRoot);
			expect(reloaded[0]?.state).toBe("working");
		} finally {
			eventStore.close();
		}
	});
});

// ============================================================
// startDaemon() shutdown cleanup
// ============================================================

describe("startDaemon() stop() cleans up tailer registry", () => {
	let tempRoot: string;

	beforeEach(async () => {
		tempRoot = await createTempRoot();
	});

	afterEach(async () => {
		await cleanupTempDir(tempRoot);
	});

	test("stop() calls handle.stop() on all registry entries and empties the map", async () => {
		// Build a fake tailer registry with two entries.
		const stopped: Record<string, boolean> = { tailer1: false, tailer2: false };

		const registry = new Map<string, { agentName: string; logPath: string; stop(): void }>([
			[
				"agent-one",
				{
					agentName: "agent-one",
					logPath: "/fake/one/stdout.log",
					stop: () => {
						stopped.tailer1 = true;
					},
				},
			],
			[
				"agent-two",
				{
					agentName: "agent-two",
					logPath: "/fake/two/stdout.log",
					stop: () => {
						stopped.tailer2 = true;
					},
				},
			],
		]);

		// Use a long interval so the periodic tick never fires during this test.
		const daemon = startDaemon({
			root: tempRoot,
			intervalMs: 60_000,
			...THRESHOLDS,
			_tmux: { isSessionAlive: async () => false, killSession: async () => {} },
			_nudge: async () => ({ delivered: false }),
			_process: { isAlive: () => false, killTree: async () => {} },
			_triage: async () => "extend",
			_recordFailure: async () => {},
			_getConnection: () => undefined,
			_removeConnection: () => {},
			_eventStore: null,
			_mailStore: null,
			_tailerRegistry: registry,
			_tailerFactory: () => ({ agentName: "", logPath: "", stop: () => {} }),
			_findLatestStdoutLog: async () => null,
		});

		// Allow the first (immediate) tick to settle.
		await new Promise<void>((resolve) => setTimeout(resolve, 20));

		daemon.stop();

		expect(stopped.tailer1).toBe(true);
		expect(stopped.tailer2).toBe(true);
		expect(registry.size).toBe(0);
	});
});

// ============================================================
// RPC getState() timeout removes stale connection
// ============================================================

describe("RPC getState() timeout removes stale connection", () => {
	test("_removeConnection is called when getState() rejects", async () => {
		const session = makeSession({
			agentName: "rpc-agent",
			tmuxSession: "", // headless
			pid: process.pid, // alive
			state: "working",
			lastActivity: new Date().toISOString(),
		});

		writeSessionsToStore(tempRoot, [session]);

		const removedNames: string[] = [];

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			_tmux: { isSessionAlive: async () => false, killSession: async () => {} },
			_triage: triageAlways("extend"),
			_process: { isAlive: () => true, killTree: async () => {} },
			_eventStore: null,
			_recordFailure: async () => {},
			_getConnection: (name: string) => {
				if (name !== "rpc-agent") return undefined;
				return {
					getState: () => Promise.reject(new Error("connection error")),
					sendPrompt: async () => {},
					followUp: async () => {},
					abort: async () => {},
					close: () => {},
				};
			},
			_removeConnection: (name: string) => {
				removedNames.push(name);
			},
			_tailerRegistry: new Map(),
			_findLatestStdoutLog: async () => null,
			_mailStore: null,
		});

		expect(removedNames).toContain("rpc-agent");
	});
});

// ============================================================
// Triage concurrency limit (_maxTriagePerTick)
// ============================================================

describe("triage concurrency limit (_maxTriagePerTick)", () => {
	test("only _maxTriagePerTick triage calls happen when multiple sessions need level-2 escalation", async () => {
		const staleActivity = new Date(Date.now() - 60_000).toISOString();
		const stalledSince = new Date(Date.now() - 130_000).toISOString();

		// 4 sessions all at escalation level 2
		const sessions: AgentSession[] = [
			makeSession({
				id: "s-1",
				agentName: "agent-1",
				tmuxSession: "ov-agent-1",
				state: "stalled",
				lastActivity: staleActivity,
				escalationLevel: 2,
				stalledSince,
			}),
			makeSession({
				id: "s-2",
				agentName: "agent-2",
				tmuxSession: "ov-agent-2",
				state: "stalled",
				lastActivity: staleActivity,
				escalationLevel: 2,
				stalledSince,
			}),
			makeSession({
				id: "s-3",
				agentName: "agent-3",
				tmuxSession: "ov-agent-3",
				state: "stalled",
				lastActivity: staleActivity,
				escalationLevel: 2,
				stalledSince,
			}),
			makeSession({
				id: "s-4",
				agentName: "agent-4",
				tmuxSession: "ov-agent-4",
				state: "stalled",
				lastActivity: staleActivity,
				escalationLevel: 2,
				stalledSince,
			}),
		];

		writeSessionsToStore(tempRoot, sessions);

		let triageCallCount = 0;
		const triageMock = async (_opts: { agentName: string; root: string; lastActivity: string }) => {
			triageCallCount++;
			return "extend" as const;
		};

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			nudgeIntervalMs: 60_000,
			tier1Enabled: true,
			_maxTriagePerTick: 2,
			_tmux: tmuxWithLiveness({
				"ov-agent-1": true,
				"ov-agent-2": true,
				"ov-agent-3": true,
				"ov-agent-4": true,
			}),
			_triage: triageMock,
			_nudge: nudgeTracker().nudge,
			_eventStore: null,
			_recordFailure: async () => {},
			_getConnection: () => undefined,
			_removeConnection: () => {},
			_tailerRegistry: new Map(),
			_findLatestStdoutLog: async () => null,
			_mailStore: null,
		});

		// Only 2 of the 4 sessions should have triggered triage
		expect(triageCallCount).toBe(2);
	});
});

// ============================================================
// RuntimeConnection-aware kill and liveness (overstory-32cd)
// ============================================================

describe("killAgent uses RuntimeConnection.abort() when available", () => {
	const deadPid = 999999;

	function connProcessTracker(): {
		isAlive: (pid: number) => boolean;
		killTree: (pid: number) => Promise<void>;
		killed: number[];
	} {
		const killed: number[] = [];
		return {
			isAlive: (pid: number) => {
				try {
					process.kill(pid, 0);
					return true;
				} catch {
					return false;
				}
			},
			killTree: async (pid: number) => {
				killed.push(pid);
			},
			killed,
		};
	}

	// Test A: killAgent uses connection.abort() when a connection is registered
	test("Test A: abort() called for ZFC-terminated headless agent with registered connection", async () => {
		const session = makeSession({
			agentName: "headless-conn-agent",
			tmuxSession: "", // headless
			pid: deadPid, // dead PID → ZFC fires (pidAlive=false)
			state: "working",
			lastActivity: new Date().toISOString(),
		});

		writeSessionsToStore(tempRoot, [session]);

		let abortCount = 0;
		const removedNames: string[] = [];
		const proc = connProcessTracker();
		const tmuxMock = tmuxWithLiveness({ "": true });

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			_tmux: tmuxMock,
			_triage: triageAlways("extend"),
			_process: proc,
			_eventStore: null,
			_recordFailure: async () => {},
			_getConnection: (name: string) => {
				if (name !== "headless-conn-agent") return undefined;
				return {
					getState: async () => ({ status: "working" as const }),
					sendPrompt: async () => {},
					followUp: async () => {},
					abort: async () => {
						abortCount++;
					},
					close: () => {},
				};
			},
			_removeConnection: (name: string) => {
				removedNames.push(name);
			},
			_tailerRegistry: new Map(),
			_findLatestStdoutLog: async () => null,
			_mailStore: null,
		});

		// abort() called exactly once
		expect(abortCount).toBe(1);
		// killTree NOT called (abort succeeded)
		expect(proc.killed).toHaveLength(0);
		// removeConnection called for the agent
		expect(removedNames).toContain("headless-conn-agent");
	});

	// Test B: killAgent falls back to killTree when conn.abort() throws
	test("Test B: killTree called as fallback when abort() throws", async () => {
		const session = makeSession({
			agentName: "headless-abort-fail",
			tmuxSession: "",
			pid: deadPid,
			state: "working",
			lastActivity: new Date().toISOString(),
		});

		writeSessionsToStore(tempRoot, [session]);

		let abortCalled = false;
		const removedNames: string[] = [];
		const proc = connProcessTracker();
		const tmuxMock = tmuxWithLiveness({ "": true });

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			_tmux: tmuxMock,
			_triage: triageAlways("extend"),
			_process: proc,
			_eventStore: null,
			_recordFailure: async () => {},
			_getConnection: (name: string) => {
				if (name !== "headless-abort-fail") return undefined;
				return {
					getState: async () => ({ status: "working" as const }),
					sendPrompt: async () => {},
					followUp: async () => {},
					abort: async () => {
						abortCalled = true;
						throw new Error("process already dead");
					},
					close: () => {},
				};
			},
			_removeConnection: (name: string) => {
				removedNames.push(name);
			},
			_tailerRegistry: new Map(),
			_findLatestStdoutLog: async () => null,
			_mailStore: null,
		});

		// abort() was attempted
		expect(abortCalled).toBe(true);
		// killTree called as defense-in-depth fallback
		expect(proc.killed).toContain(deadPid);
		// removeConnection still called (before fallback)
		expect(removedNames).toContain("headless-abort-fail");
	});

	// Test C: killAgent uses conn.abort() for triage-terminate path (level 2 → terminate)
	test("Test C: abort() called in triage-terminate path (level 2 → terminate verdict)", async () => {
		const nudgeIntervalMs = 60_000;
		// stalledSince 2.5 intervals ago → expectedLevel = floor(2.5) = 2 → triage fires
		const stalledSince = new Date(Date.now() - 2.5 * nudgeIntervalMs).toISOString();
		// staleActivity: 2x staleThreshold (60s) — stale but not zombie, so escalate fires
		const staleActivity = new Date(Date.now() - THRESHOLDS.staleThresholdMs * 2).toISOString();

		const session = makeSession({
			agentName: "headless-triage-conn",
			tmuxSession: "",
			pid: process.pid, // alive — ZFC won't fire; escalation path triggers triage
			state: "stalled",
			lastActivity: staleActivity,
			escalationLevel: 1,
			stalledSince,
		});

		writeSessionsToStore(tempRoot, [session]);

		let abortCount = 0;
		const removedNames: string[] = [];
		const proc = connProcessTracker();
		const tmuxMock = tmuxWithLiveness({ "": true });

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			nudgeIntervalMs,
			tier1Enabled: true,
			_tmux: tmuxMock,
			_triage: triageAlways("terminate"),
			_nudge: nudgeTracker().nudge,
			_process: proc,
			_eventStore: null,
			_recordFailure: async () => {},
			// getState returns "error" so lastActivity is NOT refreshed — stale condition preserved
			_getConnection: (name: string) => {
				if (name !== "headless-triage-conn") return undefined;
				return {
					getState: async () => ({ status: "error" as const }),
					sendPrompt: async () => {},
					followUp: async () => {},
					abort: async () => {
						abortCount++;
					},
					close: () => {},
				};
			},
			_removeConnection: (name: string) => {
				removedNames.push(name);
			},
			_tailerRegistry: new Map(),
			_findLatestStdoutLog: async () => null,
			_mailStore: null,
		});

		// abort() called via triage-terminate → killAgent path
		expect(abortCount).toBe(1);
		// killTree NOT called (abort succeeded)
		expect(proc.killed).toHaveLength(0);
		// tmux killSession NOT called (headless path only)
		expect(tmuxMock.killed).toHaveLength(0);
	});

	// Test D: integration — watchdog terminates a hung headless agent without touching tmux
	test("Test D: conn.abort() called, tmux.killSession and killTree NEVER called, state → zombie", async () => {
		const session = makeSession({
			agentName: "headless-zombie-conn",
			tmuxSession: "",
			pid: deadPid, // dead PID → ZFC fires
			state: "working",
			lastActivity: new Date(Date.now() - THRESHOLDS.zombieThresholdMs * 2).toISOString(),
		});

		writeSessionsToStore(tempRoot, [session]);

		let abortCount = 0;
		const proc = connProcessTracker();
		const tmuxMock = tmuxWithLiveness({ "": true });

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			_tmux: tmuxMock,
			_triage: triageAlways("extend"),
			_process: proc,
			_eventStore: null,
			_recordFailure: async () => {},
			_getConnection: (name: string) => {
				if (name !== "headless-zombie-conn") return undefined;
				return {
					getState: async () => ({ status: "working" as const }),
					sendPrompt: async () => {},
					followUp: async () => {},
					abort: async () => {
						abortCount++;
					},
					close: () => {},
				};
			},
			_removeConnection: () => {},
			_tailerRegistry: new Map(),
			_findLatestStdoutLog: async () => null,
			_mailStore: null,
		});

		// abort() called
		expect(abortCount).toBe(1);
		// tmux.killSession NEVER called
		expect(tmuxMock.killed).toHaveLength(0);
		// killTree NEVER called (abort succeeded)
		expect(proc.killed).toHaveLength(0);
		// Agent state transitioned to zombie
		const reloaded = readSessionsFromStore(tempRoot);
		expect(reloaded[0]?.state).toBe("zombie");
	});

	// Test E: liveness — getState() returning error status drives the agent toward zombie
	test("Test E: getState()=error + dead PID → tmuxAlive=false, state=zombie, terminate, abort called", async () => {
		const session = makeSession({
			agentName: "headless-error-conn",
			tmuxSession: "",
			pid: deadPid, // dead → ZFC fires: pidAlive=false
			state: "working",
			lastActivity: new Date().toISOString(), // fresh — time-based won't fire; ZFC does
		});

		writeSessionsToStore(tempRoot, [session]);

		let abortCount = 0;
		const proc = connProcessTracker();
		const checks: HealthCheck[] = [];
		const tmuxMock = tmuxWithLiveness({ "": true });

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			onHealthCheck: (c) => checks.push(c),
			_tmux: tmuxMock,
			_triage: triageAlways("extend"),
			_process: proc,
			_eventStore: null,
			_recordFailure: async () => {},
			_getConnection: (name: string) => {
				if (name !== "headless-error-conn") return undefined;
				return {
					getState: async () => ({ status: "error" as const }),
					sendPrompt: async () => {},
					followUp: async () => {},
					abort: async () => {
						abortCount++;
					},
					close: () => {},
				};
			},
			_removeConnection: () => {},
			_tailerRegistry: new Map(),
			_findLatestStdoutLog: async () => null,
			_mailStore: null,
		});

		// Health check produced
		expect(checks).toHaveLength(1);
		// tmuxAlive=false because getState returned "error"
		expect(checks[0]?.tmuxAlive).toBe(false);
		// ZFC fires (pidAlive=false for dead PID) → zombie/terminate
		expect(checks[0]?.state).toBe("zombie");
		expect(checks[0]?.action).toBe("terminate");
		// abort() called via killAgent
		expect(abortCount).toBe(1);
		// killTree NOT called (abort succeeded)
		expect(proc.killed).toHaveLength(0);
	});

	// Test F: connection.getState() rejection drops the connection and falls back to tmux
	test("Test F: getState() rejection → removeConnection called, tmux liveness used as fallback", async () => {
		const session = makeSession({
			agentName: "headless-reject-conn",
			tmuxSession: "",
			pid: process.pid, // alive
			state: "working",
			lastActivity: new Date().toISOString(), // fresh — no stale
		});

		writeSessionsToStore(tempRoot, [session]);

		const removedNames: string[] = [];
		const checks: HealthCheck[] = [];
		// tmux returns alive — used as fallback when getState rejects
		const tmuxMock = tmuxWithLiveness({ "": true });

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			onHealthCheck: (c) => checks.push(c),
			_tmux: tmuxMock,
			_triage: triageAlways("extend"),
			_process: { isAlive: () => true, killTree: async () => {} },
			_eventStore: null,
			_recordFailure: async () => {},
			_getConnection: (name: string) => {
				if (name !== "headless-reject-conn") return undefined;
				return {
					getState: () => Promise.reject(new Error("connection error")),
					sendPrompt: async () => {},
					followUp: async () => {},
					abort: async () => {},
					close: () => {},
				};
			},
			_removeConnection: (name: string) => {
				removedNames.push(name);
			},
			_tailerRegistry: new Map(),
			_findLatestStdoutLog: async () => null,
			_mailStore: null,
		});

		// removeConnection called (connection dropped after rejection)
		expect(removedNames).toContain("headless-reject-conn");
		// Agent is healthy (alive PID, fresh lastActivity, tmux fallback returns alive)
		expect(checks).toHaveLength(1);
		expect(checks[0]?.action).toBe("none");
	});
});

// ============================================================
// worker_died notification (overstory-c111)
// ============================================================

describe("worker_died parent notification", () => {
	let tempRoot: string;

	beforeEach(async () => {
		tempRoot = await createTempRoot();
	});

	afterEach(async () => {
		await cleanupTempDir(tempRoot);
	});

	test("terminate path sends worker_died mail to parentAgent on first zombify", async () => {
		const session = makeSession({
			agentName: "dead-builder",
			capability: "builder",
			parentAgent: "lead-1",
			tmuxSession: "overstory-dead-builder",
			state: "working",
			lastActivity: new Date().toISOString(),
		});

		writeSessionsToStore(tempRoot, [session]);

		const mailDb = join(tempRoot, ".overstory", "mail.db");
		const mailStore = createMailStore(mailDb);

		try {
			await runDaemonTick({
				root: tempRoot,
				...THRESHOLDS,
				_tmux: tmuxWithLiveness({ "overstory-dead-builder": false }),
				_triage: triageAlways("extend"),
				_recordFailure: async () => {},
				_mailStore: mailStore,
			});

			const inbox = mailStore.getUnread("lead-1");
			expect(inbox).toHaveLength(1);
			const msg = inbox[0];
			expect(msg).toBeDefined();
			if (!msg) return;
			expect(msg.type).toBe("worker_died");
			expect(msg.from).toBe("dead-builder");
			expect(msg.to).toBe("lead-1");
			expect(msg.priority).toBe("high");
			expect(msg.payload).not.toBeNull();
			const payload = JSON.parse(msg.payload ?? "{}") as WorkerDiedPayload;
			expect(payload.agentName).toBe("dead-builder");
			expect(payload.capability).toBe("builder");
			expect(payload.terminatedBy).toBe("tier0");
			expect(payload.reason).toBeTruthy();
		} finally {
			mailStore.close();
		}
	});

	test("orphan agent (parentAgent=null) receives no notification", async () => {
		const session = makeSession({
			agentName: "orphan-agent",
			parentAgent: null,
			tmuxSession: "overstory-orphan-agent",
			state: "working",
			lastActivity: new Date().toISOString(),
		});

		writeSessionsToStore(tempRoot, [session]);

		const mailDb = join(tempRoot, ".overstory", "mail.db");
		const mailStore = createMailStore(mailDb);

		try {
			await runDaemonTick({
				root: tempRoot,
				...THRESHOLDS,
				_tmux: tmuxWithLiveness({ "overstory-orphan-agent": false }),
				_triage: triageAlways("extend"),
				_recordFailure: async () => {},
				_mailStore: mailStore,
			});

			expect(mailStore.getAll({ type: "worker_died" })).toHaveLength(0);
		} finally {
			mailStore.close();
		}
	});

	test("re-tick on already-zombie session does not send a second worker_died", async () => {
		// Subsequent ticks see the session already in `zombie`. The state matrix
		// rejects zombie → zombie transitions, so notify is gated on `outcome.ok`.
		const session = makeSession({
			agentName: "re-zombie-agent",
			parentAgent: "lead-2",
			tmuxSession: "overstory-re-zombie-agent",
			state: "working",
			lastActivity: new Date().toISOString(),
		});

		writeSessionsToStore(tempRoot, [session]);

		const mailDb = join(tempRoot, ".overstory", "mail.db");
		const mailStore = createMailStore(mailDb);

		try {
			const tickOpts = {
				root: tempRoot,
				...THRESHOLDS,
				_tmux: tmuxWithLiveness({ "overstory-re-zombie-agent": false }),
				_triage: triageAlways("extend"),
				_recordFailure: async () => {},
				_mailStore: mailStore,
			};
			await runDaemonTick(tickOpts);
			await runDaemonTick(tickOpts);
			await runDaemonTick(tickOpts);

			expect(mailStore.getAll({ to: "lead-2", type: "worker_died" })).toHaveLength(1);
		} finally {
			mailStore.close();
		}
	});

	test("notifyParentOnDeath=false suppresses the synthetic mail", async () => {
		const session = makeSession({
			agentName: "opt-out-agent",
			parentAgent: "lead-3",
			tmuxSession: "overstory-opt-out-agent",
			state: "working",
			lastActivity: new Date().toISOString(),
		});

		writeSessionsToStore(tempRoot, [session]);

		const mailDb = join(tempRoot, ".overstory", "mail.db");
		const mailStore = createMailStore(mailDb);

		try {
			await runDaemonTick({
				root: tempRoot,
				...THRESHOLDS,
				notifyParentOnDeath: false,
				_tmux: tmuxWithLiveness({ "overstory-opt-out-agent": false }),
				_triage: triageAlways("extend"),
				_recordFailure: async () => {},
				_mailStore: mailStore,
			});

			expect(mailStore.getAll({ type: "worker_died" })).toHaveLength(0);
			// State should still transition normally
			const reloaded = readSessionsFromStore(tempRoot);
			expect(reloaded[0]?.state).toBe("zombie");
		} finally {
			mailStore.close();
		}
	});

	test("escalation-level-3 terminate also notifies parent with tier0 reason", async () => {
		// Stalled agent with alive tmux: progressive escalation drives it to level 3
		// terminate. The notify path runs through the escalation branch, not the
		// `check.action === "terminate"` branch.
		const stalledSince = new Date(Date.now() - 4 * 60_000).toISOString();
		const lastActivity = new Date(Date.now() - 60_000).toISOString();
		const session = makeSession({
			agentName: "escalated-agent",
			parentAgent: "coordinator",
			tmuxSession: "overstory-escalated-agent",
			state: "working",
			lastActivity,
			stalledSince,
			escalationLevel: 3,
		});

		writeSessionsToStore(tempRoot, [session]);

		const mailDb = join(tempRoot, ".overstory", "mail.db");
		const mailStore = createMailStore(mailDb);

		try {
			await runDaemonTick({
				root: tempRoot,
				...THRESHOLDS,
				nudgeIntervalMs: 60_000,
				_tmux: tmuxWithLiveness({ "overstory-escalated-agent": true }),
				_triage: triageAlways("extend"),
				_nudge: async () => ({ delivered: true }),
				_recordFailure: async () => {},
				_mailStore: mailStore,
			});

			const inbox = mailStore.getUnread("coordinator");
			expect(inbox).toHaveLength(1);
			const msg = inbox[0];
			if (!msg) return;
			expect(msg.type).toBe("worker_died");
			const payload = JSON.parse(msg.payload ?? "{}") as WorkerDiedPayload;
			expect(payload.terminatedBy).toBe("tier0");
			expect(payload.reason).toContain("Progressive escalation");
		} finally {
			mailStore.close();
		}
	});

	test("tier1 triage terminate sets terminatedBy=tier1 in payload", async () => {
		// stalledSince must produce expectedLevel==2 from nudgeIntervalMs=60_000:
		// floor(stalledMs / 60_000) === 2 requires 2*60_000 <= stalledMs < 3*60_000.
		const stalledSince = new Date(Date.now() - 150_000).toISOString();
		const lastActivity = new Date(Date.now() - 60_000).toISOString();
		const session = makeSession({
			agentName: "triaged-agent",
			parentAgent: "lead-triage",
			tmuxSession: "overstory-triaged-agent",
			state: "working",
			lastActivity,
			stalledSince,
			escalationLevel: 2,
		});

		writeSessionsToStore(tempRoot, [session]);

		const mailDb = join(tempRoot, ".overstory", "mail.db");
		const mailStore = createMailStore(mailDb);

		try {
			await runDaemonTick({
				root: tempRoot,
				...THRESHOLDS,
				nudgeIntervalMs: 60_000,
				tier1Enabled: true,
				_tmux: tmuxWithLiveness({ "overstory-triaged-agent": true }),
				_triage: triageAlways("terminate"),
				_nudge: async () => ({ delivered: true }),
				_recordFailure: async () => {},
				_mailStore: mailStore,
			});

			const inbox = mailStore.getUnread("lead-triage");
			expect(inbox).toHaveLength(1);
			const msg = inbox[0];
			if (!msg) return;
			expect(msg.type).toBe("worker_died");
			const payload = JSON.parse(msg.payload ?? "{}") as WorkerDiedPayload;
			expect(payload.terminatedBy).toBe("tier1");
			expect(payload.reason).toContain("AI triage");
		} finally {
			mailStore.close();
		}
	});
});

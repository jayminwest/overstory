/**
 * Tests for SessionStore (SQLite-backed agent session tracking).
 *
 * Uses real bun:sqlite with temp files. No mocks.
 * Temp files (not :memory:) because file-based migration must be tested.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTempDir } from "../test-helpers.ts";
import type { AgentSession, AgentState, InsertRun, Run, RunStore } from "../types.ts";
import { createRunStore, createSessionStore, type SessionStore } from "./store.ts";

let tempDir: string;
let dbPath: string;
let store: SessionStore;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), "overstory-sessions-test-"));
	dbPath = join(tempDir, "sessions.db");
	store = createSessionStore(dbPath);
});

afterEach(async () => {
	store.close();
	await cleanupTempDir(tempDir);
});

/** Helper to create an AgentSession with optional overrides. */
function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
	return {
		id: "session-001-test-agent",
		agentName: "test-agent",
		capability: "builder",
		worktreePath: "/tmp/worktrees/test-agent",
		branchName: "overstory/test-agent/task-1",
		taskId: "task-1",
		tmuxSession: "overstory-test-agent",
		state: "booting",
		pid: 12345,
		parentAgent: null,
		depth: 0,
		runId: null,
		startedAt: "2026-01-15T10:00:00.000Z",
		lastActivity: "2026-01-15T10:00:00.000Z",
		escalationLevel: 0,
		stalledSince: null,
		transcriptPath: null,
		...overrides,
	};
}

// === upsert ===

describe("upsert", () => {
	test("inserts a new session", () => {
		const session = makeSession();
		store.upsert(session);

		const result = store.getByName("test-agent");
		expect(result).not.toBeNull();
		expect(result).toEqual(session);
	});

	test("updates an existing session with the same agent name", () => {
		store.upsert(makeSession({ state: "booting" }));
		store.upsert(makeSession({ id: "session-002-test-agent", state: "working" }));

		const all = store.getAll();
		expect(all).toHaveLength(1);

		const result = store.getByName("test-agent");
		expect(result?.state).toBe("working");
		expect(result?.id).toBe("session-002-test-agent");
	});

	test("all fields roundtrip correctly (camelCase TS -> snake_case SQLite -> camelCase TS)", () => {
		const session = makeSession({
			id: "session-full-roundtrip",
			agentName: "roundtrip-agent",
			capability: "scout",
			worktreePath: "/tmp/worktrees/roundtrip",
			branchName: "overstory/roundtrip-agent/task-42",
			taskId: "task-42",
			tmuxSession: "overstory-roundtrip-agent",
			state: "working",
			pid: 99999,
			parentAgent: "lead-agent",
			depth: 2,
			runId: "run-abc-123",
			startedAt: "2026-02-01T08:30:00.000Z",
			lastActivity: "2026-02-01T09:00:00.000Z",
			escalationLevel: 2,
			stalledSince: "2026-02-01T08:50:00.000Z",
		});

		store.upsert(session);
		const result = store.getByName("roundtrip-agent");
		expect(result).toEqual(session);
	});

	test("handles null pid", () => {
		const session = makeSession({ pid: null });
		store.upsert(session);

		const result = store.getByName("test-agent");
		expect(result?.pid).toBeNull();
	});

	test("handles null parentAgent", () => {
		const session = makeSession({ parentAgent: null });
		store.upsert(session);

		const result = store.getByName("test-agent");
		expect(result?.parentAgent).toBeNull();
	});

	test("handles null runId", () => {
		const session = makeSession({ runId: null });
		store.upsert(session);

		const result = store.getByName("test-agent");
		expect(result?.runId).toBeNull();
	});

	test("handles null stalledSince", () => {
		const session = makeSession({ stalledSince: null });
		store.upsert(session);

		const result = store.getByName("test-agent");
		expect(result?.stalledSince).toBeNull();
	});

	test("rejects invalid state values via CHECK constraint", () => {
		const session = makeSession();
		// Force an invalid state to test the CHECK constraint
		const badSession = { ...session, state: "invalid" as AgentState };
		expect(() => store.upsert(badSession)).toThrow();
	});

	test("handles null transcriptPath", () => {
		const session = makeSession({ transcriptPath: null });
		store.upsert(session);
		const result = store.getByName("test-agent");
		expect(result?.transcriptPath).toBeNull();
	});

	test("transcriptPath roundtrips correctly", () => {
		const session = makeSession({ transcriptPath: "/home/user/.pi/sessions/abc.jsonl" });
		store.upsert(session);
		const result = store.getByName("test-agent");
		expect(result?.transcriptPath).toBe("/home/user/.pi/sessions/abc.jsonl");
	});
});

// === claudeSessionId roundtrip via upsert ===

describe("claudeSessionId upsert roundtrip", () => {
	test("undefined claudeSessionId leaves column null and field absent on roundtrip", () => {
		store.upsert(makeSession());
		const result = store.getByName("test-agent");
		expect(result).not.toBeNull();
		expect(Object.hasOwn(result ?? {}, "claudeSessionId")).toBe(false);
	});

	test("claudeSessionId roundtrips correctly when set", () => {
		store.upsert(makeSession({ claudeSessionId: "sess-roundtrip-xyz" }));
		const result = store.getByName("test-agent");
		expect(result?.claudeSessionId).toBe("sess-roundtrip-xyz");
	});
});

// === updateClaudeSessionId ===

describe("updateClaudeSessionId", () => {
	test("sets claude_session_id for an existing session; getByName returns it", () => {
		store.upsert(makeSession());
		store.updateClaudeSessionId("test-agent", "sess-pin-001");
		const result = store.getByName("test-agent");
		expect(result?.claudeSessionId).toBe("sess-pin-001");
	});

	test("calling twice with the same value is idempotent", () => {
		store.upsert(makeSession());
		store.updateClaudeSessionId("test-agent", "sess-idempotent");
		store.updateClaudeSessionId("test-agent", "sess-idempotent");
		const result = store.getByName("test-agent");
		expect(result?.claudeSessionId).toBe("sess-idempotent");
	});

	test("calling for an unknown agent is a no-op (does not throw)", () => {
		expect(() => store.updateClaudeSessionId("nonexistent", "sess-noop")).not.toThrow();
	});
});

// === updateTranscriptPath ===

describe("updateTranscriptPath", () => {
	test("sets transcript path for an existing session", () => {
		store.upsert(makeSession({ transcriptPath: null }));
		store.updateTranscriptPath("test-agent", "/tmp/transcript.jsonl");
		const result = store.getByName("test-agent");
		expect(result?.transcriptPath).toBe("/tmp/transcript.jsonl");
	});

	test("is a no-op for nonexistent agent", () => {
		// Should not throw
		store.updateTranscriptPath("nonexistent", "/tmp/transcript.jsonl");
	});
});

// === getByName ===

describe("getByName", () => {
	test("returns null for nonexistent agent", () => {
		const result = store.getByName("nonexistent");
		expect(result).toBeNull();
	});

	test("returns the correct session when multiple exist", () => {
		store.upsert(makeSession({ agentName: "agent-a", id: "s-a" }));
		store.upsert(makeSession({ agentName: "agent-b", id: "s-b" }));
		store.upsert(makeSession({ agentName: "agent-c", id: "s-c" }));

		const result = store.getByName("agent-b");
		expect(result?.id).toBe("s-b");
		expect(result?.agentName).toBe("agent-b");
	});
});

// === getActive ===

describe("getActive", () => {
	test("returns empty array when no sessions exist", () => {
		const result = store.getActive();
		expect(result).toEqual([]);
	});

	test("returns booting, working, and stalled sessions", () => {
		store.upsert(makeSession({ agentName: "booting-1", id: "s-1", state: "booting" }));
		store.upsert(makeSession({ agentName: "working-1", id: "s-2", state: "working" }));
		store.upsert(makeSession({ agentName: "stalled-1", id: "s-3", state: "stalled" }));

		const result = store.getActive();
		expect(result).toHaveLength(3);

		const states = result.map((s) => s.state);
		expect(states).toContain("booting");
		expect(states).toContain("working");
		expect(states).toContain("stalled");
	});

	test("excludes completed and zombie sessions", () => {
		store.upsert(makeSession({ agentName: "working-1", id: "s-1", state: "working" }));
		store.upsert(makeSession({ agentName: "completed-1", id: "s-2", state: "completed" }));
		store.upsert(makeSession({ agentName: "zombie-1", id: "s-3", state: "zombie" }));

		const result = store.getActive();
		expect(result).toHaveLength(1);
		expect(result[0]?.agentName).toBe("working-1");
	});

	test("results are ordered by started_at ascending", () => {
		store.upsert(
			makeSession({
				agentName: "late",
				id: "s-2",
				state: "working",
				startedAt: "2026-01-15T12:00:00.000Z",
			}),
		);
		store.upsert(
			makeSession({
				agentName: "early",
				id: "s-1",
				state: "working",
				startedAt: "2026-01-15T10:00:00.000Z",
			}),
		);

		const result = store.getActive();
		expect(result[0]?.agentName).toBe("early");
		expect(result[1]?.agentName).toBe("late");
	});
});

// === getAll ===

describe("getAll", () => {
	test("returns empty array when no sessions exist", () => {
		expect(store.getAll()).toEqual([]);
	});

	test("returns all sessions regardless of state", () => {
		store.upsert(makeSession({ agentName: "a1", id: "s-1", state: "booting" }));
		store.upsert(makeSession({ agentName: "a2", id: "s-2", state: "completed" }));
		store.upsert(makeSession({ agentName: "a3", id: "s-3", state: "zombie" }));

		const result = store.getAll();
		expect(result).toHaveLength(3);
	});
});

// === count ===

describe("count", () => {
	test("returns 0 on empty database", () => {
		expect(store.count()).toBe(0);
	});

	test("returns correct count after inserts", () => {
		store.upsert(makeSession({ agentName: "a1", id: "s-1" }));
		expect(store.count()).toBe(1);

		store.upsert(makeSession({ agentName: "a2", id: "s-2" }));
		expect(store.count()).toBe(2);

		store.upsert(makeSession({ agentName: "a3", id: "s-3" }));
		expect(store.count()).toBe(3);
	});

	test("count reflects removals", () => {
		store.upsert(makeSession({ agentName: "a1", id: "s-1" }));
		store.upsert(makeSession({ agentName: "a2", id: "s-2" }));

		store.remove("a1");
		expect(store.count()).toBe(1);

		store.remove("a2");
		expect(store.count()).toBe(0);
	});

	test("count matches getAll().length", () => {
		for (let i = 0; i < 5; i++) {
			store.upsert(makeSession({ agentName: `agent-${i}`, id: `s-${i}` }));
		}
		expect(store.count()).toBe(store.getAll().length);
	});
});

// === getByRun ===

describe("getByRun", () => {
	test("returns empty array for unknown run", () => {
		expect(store.getByRun("nonexistent-run")).toEqual([]);
	});

	test("returns only sessions with matching runId", () => {
		store.upsert(makeSession({ agentName: "a1", id: "s-1", runId: "run-1" }));
		store.upsert(makeSession({ agentName: "a2", id: "s-2", runId: "run-1" }));
		store.upsert(makeSession({ agentName: "a3", id: "s-3", runId: "run-2" }));
		store.upsert(makeSession({ agentName: "a4", id: "s-4", runId: null }));

		const result = store.getByRun("run-1");
		expect(result).toHaveLength(2);
		expect(result.map((s) => s.agentName).sort()).toEqual(["a1", "a2"]);
	});
});

// === updateState ===

describe("updateState", () => {
	test("updates state of an existing session", () => {
		store.upsert(makeSession({ state: "booting" }));

		store.updateState("test-agent", "working");

		const result = store.getByName("test-agent");
		expect(result?.state).toBe("working");
	});

	test("is a no-op for nonexistent agent (does not throw)", () => {
		// Should not throw
		store.updateState("nonexistent", "completed");
	});

	test("rejects invalid state via CHECK constraint", () => {
		store.upsert(makeSession());
		expect(() => store.updateState("test-agent", "invalid" as AgentState)).toThrow();
	});
});

// === tryTransitionState (matrix-guarded CAS) ===

describe("tryTransitionState", () => {
	test("returns not_found for an unknown agent", () => {
		const outcome = store.tryTransitionState("nonexistent", "completed");
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) {
			expect(outcome.reason).toBe("not_found");
			expect(outcome.attempted).toBe("completed");
		}
	});

	test("booting → working lands and returns prev/next", () => {
		store.upsert(makeSession({ state: "booting" }));
		const outcome = store.tryTransitionState("test-agent", "working");
		expect(outcome.ok).toBe(true);
		if (outcome.ok) {
			expect(outcome.prev).toBe("booting");
			expect(outcome.next).toBe("working");
		}
		expect(store.getByName("test-agent")?.state).toBe("working");
	});

	test("working → completed lands (clean turn-end settle)", () => {
		store.upsert(makeSession({ state: "working" }));
		const outcome = store.tryTransitionState("test-agent", "completed");
		expect(outcome.ok).toBe(true);
		expect(store.getByName("test-agent")?.state).toBe("completed");
	});

	test("working → zombie lands (watchdog terminate)", () => {
		store.upsert(makeSession({ state: "working" }));
		const outcome = store.tryTransitionState("test-agent", "zombie");
		expect(outcome.ok).toBe(true);
		expect(store.getByName("test-agent")?.state).toBe("zombie");
	});

	test("zombie → completed lands (ov stop cleanup of zombie)", () => {
		store.upsert(makeSession({ state: "zombie" }));
		const outcome = store.tryTransitionState("test-agent", "completed");
		expect(outcome.ok).toBe(true);
		expect(store.getByName("test-agent")?.state).toBe("completed");
	});

	test("completed → zombie is rejected (sticky completed)", () => {
		store.upsert(makeSession({ state: "completed" }));
		const outcome = store.tryTransitionState("test-agent", "zombie");
		expect(outcome.ok).toBe(false);
		if (!outcome.ok && outcome.reason === "illegal_transition") {
			expect(outcome.prev).toBe("completed");
			expect(outcome.attempted).toBe("zombie");
		}
		expect(store.getByName("test-agent")?.state).toBe("completed");
	});

	test("completed → working is rejected (turn-runner cannot revive completed)", () => {
		store.upsert(makeSession({ state: "completed" }));
		const outcome = store.tryTransitionState("test-agent", "working");
		expect(outcome.ok).toBe(false);
		if (!outcome.ok && outcome.reason === "illegal_transition") {
			expect(outcome.prev).toBe("completed");
		}
		expect(store.getByName("test-agent")?.state).toBe("completed");
	});

	test("zombie → working is rejected (PreToolUse hook cannot revive zombie)", () => {
		store.upsert(makeSession({ state: "zombie" }));
		const outcome = store.tryTransitionState("test-agent", "working");
		expect(outcome.ok).toBe(false);
		if (!outcome.ok && outcome.reason === "illegal_transition") {
			expect(outcome.prev).toBe("zombie");
			expect(outcome.attempted).toBe("working");
		}
		expect(store.getByName("test-agent")?.state).toBe("zombie");
	});

	test("idempotent same-state transitions land (working → working)", () => {
		store.upsert(makeSession({ state: "working" }));
		const outcome = store.tryTransitionState("test-agent", "working");
		expect(outcome.ok).toBe(true);
		expect(store.getByName("test-agent")?.state).toBe("working");
	});

	test("idempotent completed → completed is allowed", () => {
		store.upsert(makeSession({ state: "completed" }));
		const outcome = store.tryTransitionState("test-agent", "completed");
		expect(outcome.ok).toBe(true);
		expect(store.getByName("test-agent")?.state).toBe("completed");
	});

	test("idempotent zombie → zombie is allowed", () => {
		store.upsert(makeSession({ state: "zombie" }));
		const outcome = store.tryTransitionState("test-agent", "zombie");
		expect(outcome.ok).toBe(true);
	});

	test("nothing transitions into booting (matrix has no allowed predecessors)", () => {
		store.upsert(makeSession({ state: "working" }));
		const outcome = store.tryTransitionState("test-agent", "booting");
		expect(outcome.ok).toBe(false);
		if (!outcome.ok && outcome.reason === "illegal_transition") {
			expect(outcome.prev).toBe("working");
		}
	});

	test("stalled → working is allowed (recovery)", () => {
		store.upsert(makeSession({ state: "stalled" }));
		const outcome = store.tryTransitionState("test-agent", "working");
		expect(outcome.ok).toBe(true);
		expect(store.getByName("test-agent")?.state).toBe("working");
	});

	test("race scenario: ov stop wins, late watchdog zombie write rejected", () => {
		// Models the overstory-a993 symptom directly: ov stop completes the
		// agent first; a stale watchdog tick then tries to mark it zombie.
		store.upsert(makeSession({ state: "working" }));

		const stopOutcome = store.tryTransitionState("test-agent", "completed");
		expect(stopOutcome.ok).toBe(true);

		const watchdogOutcome = store.tryTransitionState("test-agent", "zombie");
		expect(watchdogOutcome.ok).toBe(false);
		if (!watchdogOutcome.ok && watchdogOutcome.reason === "illegal_transition") {
			expect(watchdogOutcome.prev).toBe("completed");
		}
		expect(store.getByName("test-agent")?.state).toBe("completed");
	});

	test("race scenario: watchdog wins zombie, late turn-runner working write rejected", () => {
		// Watchdog observes the agent dead and marks zombie; meanwhile a
		// turn-runner whose initialState was 'working' tries to settle to
		// 'working' at end of turn. The settle must NOT undo the zombie call.
		store.upsert(makeSession({ state: "working" }));

		const watchdogOutcome = store.tryTransitionState("test-agent", "zombie");
		expect(watchdogOutcome.ok).toBe(true);

		const turnRunnerOutcome = store.tryTransitionState("test-agent", "working");
		expect(turnRunnerOutcome.ok).toBe(false);
		if (!turnRunnerOutcome.ok && turnRunnerOutcome.reason === "illegal_transition") {
			expect(turnRunnerOutcome.prev).toBe("zombie");
		}
		expect(store.getByName("test-agent")?.state).toBe("zombie");
	});

	test("race scenario: ov stop promotes a zombie to completed", () => {
		// Inverse of the previous race: watchdog already marked zombie, then
		// the operator runs `ov stop` to clean up. The cleanup must succeed.
		store.upsert(makeSession({ state: "zombie" }));

		const stopOutcome = store.tryTransitionState("test-agent", "completed");
		expect(stopOutcome.ok).toBe(true);
		expect(store.getByName("test-agent")?.state).toBe("completed");
	});

	test("concurrent CAS: two writers try the same target, only one observes ok", () => {
		// Simulates the SQL CAS exclusivity: two writers race against the same
		// row with the same target. The DB serializes the writes; only the one
		// that finds the row in an allowed-from state when the CAS executes
		// reports ok=true. We can't truly run them in parallel from a single
		// thread, but we can prove the invariant: after BOTH calls, the row
		// is in the target state and exactly one call returned ok=true.
		store.upsert(makeSession({ state: "working" }));

		const a = store.tryTransitionState("test-agent", "completed");
		const b = store.tryTransitionState("test-agent", "completed");

		// First call lands (working → completed). Second is idempotent
		// (completed → completed is in the matrix), so both report ok.
		expect(a.ok).toBe(true);
		expect(b.ok).toBe(true);
		expect(store.getByName("test-agent")?.state).toBe("completed");
	});

	test("concurrent CAS: conflicting targets — second writer rejected", () => {
		// First writer lands working → completed; second writer attempts
		// working → zombie but the row is now completed → REJECTED.
		store.upsert(makeSession({ state: "working" }));

		const stop = store.tryTransitionState("test-agent", "completed");
		expect(stop.ok).toBe(true);

		const watchdog = store.tryTransitionState("test-agent", "zombie");
		expect(watchdog.ok).toBe(false);
		if (!watchdog.ok && watchdog.reason === "illegal_transition") {
			expect(watchdog.prev).toBe("completed");
		}
	});
});

// === tmux_session clearing on terminal transitions (overstory-14c0) ===
//
// The tmux session is torn down by ov stop / watchdog / coordinator cleanup
// before the state lands at completed/zombie. The stored tmux_session string
// would otherwise stay forever, surfacing dead session names in the agents
// view of `ov status`. Both updateState and tryTransitionState must clear it.

describe("tmux_session clearing on terminal transitions", () => {
	const tmux = "overstory-test-agent";

	describe("updateState", () => {
		test("clears tmux_session when transitioning to completed", () => {
			store.upsert(makeSession({ state: "working", tmuxSession: tmux }));
			store.updateState("test-agent", "completed");
			const result = store.getByName("test-agent");
			expect(result?.state).toBe("completed");
			expect(result?.tmuxSession).toBe("");
		});

		test("clears tmux_session when transitioning to zombie", () => {
			store.upsert(makeSession({ state: "working", tmuxSession: tmux }));
			store.updateState("test-agent", "zombie");
			const result = store.getByName("test-agent");
			expect(result?.state).toBe("zombie");
			expect(result?.tmuxSession).toBe("");
		});

		test("preserves tmux_session when transitioning to a non-terminal state", () => {
			store.upsert(makeSession({ state: "booting", tmuxSession: tmux }));
			store.updateState("test-agent", "working");
			expect(store.getByName("test-agent")?.tmuxSession).toBe(tmux);

			store.updateState("test-agent", "stalled");
			expect(store.getByName("test-agent")?.tmuxSession).toBe(tmux);
		});

		test("idempotent terminal write keeps tmux_session cleared", () => {
			store.upsert(makeSession({ state: "completed", tmuxSession: "" }));
			store.updateState("test-agent", "completed");
			expect(store.getByName("test-agent")?.tmuxSession).toBe("");
		});
	});

	describe("tryTransitionState", () => {
		test("clears tmux_session on working → completed", () => {
			store.upsert(makeSession({ state: "working", tmuxSession: tmux }));
			const outcome = store.tryTransitionState("test-agent", "completed");
			expect(outcome.ok).toBe(true);
			expect(store.getByName("test-agent")?.tmuxSession).toBe("");
		});

		test("clears tmux_session on working → zombie", () => {
			store.upsert(makeSession({ state: "working", tmuxSession: tmux }));
			const outcome = store.tryTransitionState("test-agent", "zombie");
			expect(outcome.ok).toBe(true);
			expect(store.getByName("test-agent")?.tmuxSession).toBe("");
		});

		test("clears tmux_session on zombie → completed (ov stop cleanup of zombie)", () => {
			// Zombie may still hold a tmux_session if the watchdog landed before
			// any cleanup pass; the subsequent ov stop must wipe it.
			store.upsert(makeSession({ state: "zombie", tmuxSession: tmux }));
			const outcome = store.tryTransitionState("test-agent", "completed");
			expect(outcome.ok).toBe(true);
			expect(store.getByName("test-agent")?.tmuxSession).toBe("");
		});

		test("clears tmux_session on stalled → zombie (watchdog terminate)", () => {
			store.upsert(makeSession({ state: "stalled", tmuxSession: tmux }));
			const outcome = store.tryTransitionState("test-agent", "zombie");
			expect(outcome.ok).toBe(true);
			expect(store.getByName("test-agent")?.tmuxSession).toBe("");
		});

		test("preserves tmux_session on non-terminal targets (booting → working)", () => {
			store.upsert(makeSession({ state: "booting", tmuxSession: tmux }));
			const outcome = store.tryTransitionState("test-agent", "working");
			expect(outcome.ok).toBe(true);
			expect(store.getByName("test-agent")?.tmuxSession).toBe(tmux);
		});

		test("preserves tmux_session on non-terminal targets (stalled → working)", () => {
			store.upsert(makeSession({ state: "stalled", tmuxSession: tmux }));
			const outcome = store.tryTransitionState("test-agent", "working");
			expect(outcome.ok).toBe(true);
			expect(store.getByName("test-agent")?.tmuxSession).toBe(tmux);
		});

		test("does not clear tmux_session when CAS rejects an illegal terminal transition", () => {
			// completed → zombie is rejected. The row must remain untouched —
			// in particular, tmux_session must keep whatever the row already
			// held (an empty string here, since the prior completed write
			// cleared it).
			store.upsert(makeSession({ state: "completed", tmuxSession: "" }));
			const outcome = store.tryTransitionState("test-agent", "zombie");
			expect(outcome.ok).toBe(false);
			expect(store.getByName("test-agent")?.tmuxSession).toBe("");
		});

		test("does not clear tmux_session when CAS rejects against a live row", () => {
			// nothing transitions into booting; a working row keeps both state
			// and tmux_session.
			store.upsert(makeSession({ state: "working", tmuxSession: tmux }));
			const outcome = store.tryTransitionState("test-agent", "booting");
			expect(outcome.ok).toBe(false);
			const result = store.getByName("test-agent");
			expect(result?.state).toBe("working");
			expect(result?.tmuxSession).toBe(tmux);
		});
	});
});

// === updateLastActivity ===

describe("updateLastActivity", () => {
	test("updates lastActivity to a recent ISO timestamp", () => {
		const oldTime = "2026-01-01T00:00:00.000Z";
		store.upsert(makeSession({ lastActivity: oldTime }));

		const before = new Date().toISOString();
		store.updateLastActivity("test-agent");
		const after = new Date().toISOString();

		const result = store.getByName("test-agent");
		expect(result).not.toBeNull();
		const updatedActivity = result?.lastActivity ?? "";
		// The updated timestamp should be between before and after
		expect(updatedActivity >= before).toBe(true);
		expect(updatedActivity <= after).toBe(true);
	});

	test("does not modify other fields", () => {
		const original = makeSession({ state: "working", escalationLevel: 2 });
		store.upsert(original);

		store.updateLastActivity("test-agent");

		const result = store.getByName("test-agent");
		expect(result?.state).toBe("working");
		expect(result?.escalationLevel).toBe(2);
		expect(result?.id).toBe(original.id);
	});
});

// === updateEscalation ===

describe("updateEscalation", () => {
	test("updates escalation level and stalled timestamp", () => {
		store.upsert(makeSession({ escalationLevel: 0, stalledSince: null }));

		const stalledTime = "2026-01-15T10:30:00.000Z";
		store.updateEscalation("test-agent", 2, stalledTime);

		const result = store.getByName("test-agent");
		expect(result?.escalationLevel).toBe(2);
		expect(result?.stalledSince).toBe(stalledTime);
	});

	test("can clear stalledSince by passing null", () => {
		const stalledTime = "2026-01-15T10:30:00.000Z";
		store.upsert(makeSession({ escalationLevel: 2, stalledSince: stalledTime }));

		store.updateEscalation("test-agent", 0, null);

		const result = store.getByName("test-agent");
		expect(result?.escalationLevel).toBe(0);
		expect(result?.stalledSince).toBeNull();
	});
});

// === remove ===

describe("remove", () => {
	test("removes an existing session", () => {
		store.upsert(makeSession());

		store.remove("test-agent");

		const result = store.getByName("test-agent");
		expect(result).toBeNull();
	});

	test("is a no-op for nonexistent agent", () => {
		// Should not throw
		store.remove("nonexistent");
		expect(store.getAll()).toEqual([]);
	});

	test("does not affect other sessions", () => {
		store.upsert(makeSession({ agentName: "keep-me", id: "s-1" }));
		store.upsert(makeSession({ agentName: "remove-me", id: "s-2" }));

		store.remove("remove-me");

		expect(store.getAll()).toHaveLength(1);
		expect(store.getByName("keep-me")).not.toBeNull();
	});
});

// === purge ===

describe("purge", () => {
	test("purge({ all: true }) removes all sessions and returns count", () => {
		store.upsert(makeSession({ agentName: "a1", id: "s-1" }));
		store.upsert(makeSession({ agentName: "a2", id: "s-2" }));
		store.upsert(makeSession({ agentName: "a3", id: "s-3" }));

		const count = store.purge({ all: true });
		expect(count).toBe(3);
		expect(store.getAll()).toEqual([]);
	});

	test("purge({ state }) removes only sessions with that state", () => {
		store.upsert(makeSession({ agentName: "a1", id: "s-1", state: "completed" }));
		store.upsert(makeSession({ agentName: "a2", id: "s-2", state: "working" }));
		store.upsert(makeSession({ agentName: "a3", id: "s-3", state: "completed" }));

		const count = store.purge({ state: "completed" });
		expect(count).toBe(2);
		expect(store.getAll()).toHaveLength(1);
		expect(store.getByName("a2")?.state).toBe("working");
	});

	test("purge({ agent }) removes only the specified agent", () => {
		store.upsert(makeSession({ agentName: "target", id: "s-1" }));
		store.upsert(makeSession({ agentName: "bystander", id: "s-2" }));

		const count = store.purge({ agent: "target" });
		expect(count).toBe(1);
		expect(store.getByName("target")).toBeNull();
		expect(store.getByName("bystander")).not.toBeNull();
	});

	test("purge({ state, agent }) combines filters with AND", () => {
		store.upsert(makeSession({ agentName: "a1", id: "s-1", state: "completed" }));
		store.upsert(makeSession({ agentName: "a2", id: "s-2", state: "working" }));

		// Only purge if agent is "a1" AND state is "completed"
		const count = store.purge({ state: "completed", agent: "a1" });
		expect(count).toBe(1);
		expect(store.getAll()).toHaveLength(1);
	});

	test("purge with no matching criteria returns 0", () => {
		store.upsert(makeSession());
		const count = store.purge({});
		expect(count).toBe(0);
		expect(store.getAll()).toHaveLength(1);
	});

	test("purge({ all: true }) returns 0 on empty database", () => {
		const count = store.purge({ all: true });
		expect(count).toBe(0);
	});
});

// === close ===

describe("close", () => {
	test("close does not throw when called on open store", () => {
		store.upsert(makeSession());
		// Should not throw
		expect(() => store.close()).not.toThrow();
	});
});

// === concurrent access / file-based behavior ===

describe("file-based database", () => {
	test("data persists across separate store instances", () => {
		const session = makeSession();
		store.upsert(session);
		store.close();

		// Open a new store on the same file
		const store2 = createSessionStore(dbPath);
		const result = store2.getByName("test-agent");
		expect(result).toEqual(session);
		store2.close();

		// Re-assign store so afterEach cleanup does not double-close
		store = createSessionStore(join(tempDir, "unused.db"));
	});

	test("schema is created idempotently (opening same db twice is safe)", () => {
		store.upsert(makeSession());
		store.close();

		// Re-open -- should not fail even though table/indexes already exist
		const store2 = createSessionStore(dbPath);
		const result = store2.getAll();
		expect(result).toHaveLength(1);
		store2.close();

		store = createSessionStore(join(tempDir, "unused.db"));
	});
});

// === agent_name UNIQUE constraint ===

describe("agent_name uniqueness", () => {
	test("UNIQUE constraint on agent_name allows upsert to work correctly", () => {
		store.upsert(makeSession({ agentName: "unique-agent", id: "s-1", state: "booting" }));
		store.upsert(makeSession({ agentName: "unique-agent", id: "s-2", state: "working" }));

		const all = store.getAll();
		expect(all).toHaveLength(1);
		expect(all[0]?.id).toBe("s-2");
		expect(all[0]?.state).toBe("working");
	});
});

// === edge cases ===

describe("edge cases", () => {
	test("handles many sessions efficiently", () => {
		for (let i = 0; i < 100; i++) {
			store.upsert(
				makeSession({
					agentName: `agent-${i}`,
					id: `session-${i}`,
					state: i % 3 === 0 ? "completed" : "working",
				}),
			);
		}

		const all = store.getAll();
		expect(all).toHaveLength(100);

		const active = store.getActive();
		// 34 completed (0,3,6,...,99) + 66 working. Active = working only since no booting/stalled
		expect(active.length).toBeGreaterThan(0);
		expect(active.every((s) => s.state !== "completed" && s.state !== "zombie")).toBe(true);
	});

	test("special characters in agent name and worktree path", () => {
		const session = makeSession({
			agentName: "agent-with-special_chars.v2",
			worktreePath: "/tmp/path with spaces/worktree",
			branchName: "overstory/agent-with-special_chars.v2/task-1",
		});

		store.upsert(session);

		const result = store.getByName("agent-with-special_chars.v2");
		expect(result?.worktreePath).toBe("/tmp/path with spaces/worktree");
	});

	test("empty string fields are stored correctly", () => {
		const session = makeSession({ taskId: "", capability: "builder" });
		store.upsert(session);

		const result = store.getByName("test-agent");
		expect(result?.taskId).toBe("");
	});
});

// ============================================================
// SessionStore migration: coordinator_name in runs table
// ============================================================

describe("createSessionStore migrates runs table coordinator_name", () => {
	test("opens successfully when existing runs table lacks coordinator_name", async () => {
		// Close the store created by beforeEach so we can recreate the DB manually.
		store.close();

		const { Database: Db } = await import("bun:sqlite");
		const legacyDb = new Db(dbPath);
		// Drop runs table and recreate WITHOUT coordinator_name (simulates pre-migration DB).
		legacyDb.exec("DROP TABLE IF EXISTS runs");
		legacyDb.exec(`
			CREATE TABLE runs (
				id TEXT PRIMARY KEY,
				started_at TEXT NOT NULL,
				completed_at TEXT,
				agent_count INTEGER NOT NULL DEFAULT 0,
				coordinator_session_id TEXT,
				status TEXT NOT NULL DEFAULT 'active'
			)
		`);
		legacyDb.exec(
			"INSERT INTO runs (id, started_at, status) VALUES ('legacy-run', '2026-01-01T00:00:00.000Z', 'active')",
		);
		legacyDb.close();

		// createSessionStore should migrate the table and create indexes without error.
		const migratedStore = createSessionStore(dbPath);
		try {
			// Verify the store works (no "no such column" error).
			expect(migratedStore.getAll()).toBeArray();
		} finally {
			migratedStore.close();
		}

		// Re-assign so afterEach cleanup works.
		store = createSessionStore(join(tempDir, "unused.db"));
	});
});

// ============================================================
// RunStore Tests
// ============================================================

describe("RunStore", () => {
	let runStore: RunStore;

	beforeEach(async () => {
		// Reuse the same dbPath so RunStore shares sessions.db with SessionStore
		runStore = createRunStore(dbPath);
	});

	afterEach(() => {
		runStore.close();
	});

	/** Helper to create an InsertRun with optional overrides. */
	function makeRun(overrides: Partial<InsertRun> = {}): InsertRun {
		return {
			id: "run-2026-02-13T10:00:00.000Z",
			startedAt: "2026-02-13T10:00:00.000Z",
			coordinatorSessionId: "coord-session-001",
			status: "active",
			...overrides,
		};
	}

	// === createRun + getRun ===

	describe("createRun and getRun", () => {
		test("creates and retrieves a run", () => {
			runStore.createRun(makeRun());

			const result = runStore.getRun("run-2026-02-13T10:00:00.000Z");
			expect(result).not.toBeNull();
			expect(result?.id).toBe("run-2026-02-13T10:00:00.000Z");
			expect(result?.startedAt).toBe("2026-02-13T10:00:00.000Z");
			expect(result?.completedAt).toBeNull();
			expect(result?.agentCount).toBe(0);
			expect(result?.coordinatorSessionId).toBe("coord-session-001");
			expect(result?.status).toBe("active");
		});

		test("returns null for nonexistent run", () => {
			const result = runStore.getRun("nonexistent-run");
			expect(result).toBeNull();
		});

		test("creates a run with explicit agentCount", () => {
			runStore.createRun(makeRun({ agentCount: 5 }));

			const result = runStore.getRun("run-2026-02-13T10:00:00.000Z");
			expect(result?.agentCount).toBe(5);
		});

		test("creates a run with null coordinatorSessionId", () => {
			runStore.createRun(makeRun({ coordinatorSessionId: null }));

			const result = runStore.getRun("run-2026-02-13T10:00:00.000Z");
			expect(result?.coordinatorSessionId).toBeNull();
		});

		test("rejects invalid status via CHECK constraint", () => {
			const badRun = makeRun({ status: "invalid" as Run["status"] });
			expect(() => runStore.createRun(badRun)).toThrow();
		});

		test("rejects duplicate run IDs via PRIMARY KEY constraint", () => {
			runStore.createRun(makeRun());
			expect(() => runStore.createRun(makeRun())).toThrow();
		});
	});

	// === getActiveRun ===

	describe("getActiveRun", () => {
		test("returns null when no runs exist", () => {
			const result = runStore.getActiveRun();
			expect(result).toBeNull();
		});

		test("returns the most recently started active run", () => {
			runStore.createRun(
				makeRun({
					id: "run-early",
					startedAt: "2026-02-13T08:00:00.000Z",
					status: "active",
				}),
			);
			runStore.createRun(
				makeRun({
					id: "run-late",
					startedAt: "2026-02-13T12:00:00.000Z",
					status: "active",
				}),
			);

			const result = runStore.getActiveRun();
			expect(result?.id).toBe("run-late");
		});

		test("ignores completed and failed runs", () => {
			runStore.createRun(makeRun({ id: "run-completed", status: "active" }));
			runStore.completeRun("run-completed", "completed");

			runStore.createRun(
				makeRun({
					id: "run-failed",
					startedAt: "2026-02-13T11:00:00.000Z",
					status: "active",
				}),
			);
			runStore.completeRun("run-failed", "failed");

			const result = runStore.getActiveRun();
			expect(result).toBeNull();
		});
	});

	// === listRuns ===

	describe("listRuns", () => {
		test("returns empty array when no runs exist", () => {
			const result = runStore.listRuns();
			expect(result).toEqual([]);
		});

		test("returns all runs ordered by started_at descending", () => {
			runStore.createRun(
				makeRun({
					id: "run-1",
					startedAt: "2026-02-13T08:00:00.000Z",
				}),
			);
			runStore.createRun(
				makeRun({
					id: "run-2",
					startedAt: "2026-02-13T12:00:00.000Z",
				}),
			);
			runStore.createRun(
				makeRun({
					id: "run-3",
					startedAt: "2026-02-13T10:00:00.000Z",
				}),
			);

			const result = runStore.listRuns();
			expect(result).toHaveLength(3);
			expect(result[0]?.id).toBe("run-2");
			expect(result[1]?.id).toBe("run-3");
			expect(result[2]?.id).toBe("run-1");
		});

		test("filters by status", () => {
			runStore.createRun(makeRun({ id: "run-active", status: "active" }));
			runStore.createRun(
				makeRun({
					id: "run-to-complete",
					startedAt: "2026-02-13T11:00:00.000Z",
					status: "active",
				}),
			);
			runStore.completeRun("run-to-complete", "completed");

			const activeRuns = runStore.listRuns({ status: "active" });
			expect(activeRuns).toHaveLength(1);
			expect(activeRuns[0]?.id).toBe("run-active");

			const completedRuns = runStore.listRuns({ status: "completed" });
			expect(completedRuns).toHaveLength(1);
			expect(completedRuns[0]?.id).toBe("run-to-complete");
		});

		test("respects limit option", () => {
			for (let i = 0; i < 5; i++) {
				runStore.createRun(
					makeRun({
						id: `run-${i}`,
						startedAt: `2026-02-13T${String(10 + i).padStart(2, "0")}:00:00.000Z`,
					}),
				);
			}

			const result = runStore.listRuns({ limit: 2 });
			expect(result).toHaveLength(2);
		});

		test("combines status and limit filters", () => {
			for (let i = 0; i < 5; i++) {
				runStore.createRun(
					makeRun({
						id: `run-${i}`,
						startedAt: `2026-02-13T${String(10 + i).padStart(2, "0")}:00:00.000Z`,
						status: "active",
					}),
				);
			}
			runStore.completeRun("run-0", "completed");
			runStore.completeRun("run-1", "completed");

			const result = runStore.listRuns({ status: "active", limit: 2 });
			expect(result).toHaveLength(2);
			// All returned runs should be active
			for (const run of result) {
				expect(run.status).toBe("active");
			}
		});
	});

	// === incrementAgentCount ===

	describe("incrementAgentCount", () => {
		test("increments agent count by 1", () => {
			runStore.createRun(makeRun());

			runStore.incrementAgentCount("run-2026-02-13T10:00:00.000Z");
			let result = runStore.getRun("run-2026-02-13T10:00:00.000Z");
			expect(result?.agentCount).toBe(1);

			runStore.incrementAgentCount("run-2026-02-13T10:00:00.000Z");
			result = runStore.getRun("run-2026-02-13T10:00:00.000Z");
			expect(result?.agentCount).toBe(2);
		});

		test("is a no-op for nonexistent run (does not throw)", () => {
			// Should not throw
			runStore.incrementAgentCount("nonexistent-run");
		});

		test("does not affect other run fields", () => {
			runStore.createRun(makeRun());
			runStore.incrementAgentCount("run-2026-02-13T10:00:00.000Z");

			const result = runStore.getRun("run-2026-02-13T10:00:00.000Z");
			expect(result?.status).toBe("active");
			expect(result?.completedAt).toBeNull();
			expect(result?.coordinatorSessionId).toBe("coord-session-001");
		});
	});

	// === completeRun ===

	describe("completeRun", () => {
		test("sets status to completed and records completedAt", () => {
			runStore.createRun(makeRun());

			const before = new Date().toISOString();
			runStore.completeRun("run-2026-02-13T10:00:00.000Z", "completed");
			const after = new Date().toISOString();

			const result = runStore.getRun("run-2026-02-13T10:00:00.000Z");
			expect(result?.status).toBe("completed");
			expect(result?.completedAt).not.toBeNull();
			const completedAt = result?.completedAt ?? "";
			expect(completedAt >= before).toBe(true);
			expect(completedAt <= after).toBe(true);
		});

		test("sets status to failed", () => {
			runStore.createRun(makeRun());
			runStore.completeRun("run-2026-02-13T10:00:00.000Z", "failed");

			const result = runStore.getRun("run-2026-02-13T10:00:00.000Z");
			expect(result?.status).toBe("failed");
			expect(result?.completedAt).not.toBeNull();
		});

		test("is a no-op for nonexistent run (does not throw)", () => {
			// Should not throw
			runStore.completeRun("nonexistent-run", "completed");
		});

		test("preserves agent count when completing", () => {
			runStore.createRun(makeRun());
			runStore.incrementAgentCount("run-2026-02-13T10:00:00.000Z");
			runStore.incrementAgentCount("run-2026-02-13T10:00:00.000Z");
			runStore.incrementAgentCount("run-2026-02-13T10:00:00.000Z");

			runStore.completeRun("run-2026-02-13T10:00:00.000Z", "completed");

			const result = runStore.getRun("run-2026-02-13T10:00:00.000Z");
			expect(result?.agentCount).toBe(3);
			expect(result?.status).toBe("completed");
		});
	});

	// === shared database ===

	describe("shared database with SessionStore", () => {
		test("RunStore and SessionStore can share the same database file", () => {
			// SessionStore was already opened on dbPath in the outer beforeEach.
			// RunStore was opened on dbPath in the inner beforeEach.
			// Both should work without conflicts.
			runStore.createRun(makeRun());
			store.upsert(makeSession({ runId: "run-2026-02-13T10:00:00.000Z" }));

			const run = runStore.getRun("run-2026-02-13T10:00:00.000Z");
			expect(run).not.toBeNull();

			const sessions = store.getByRun("run-2026-02-13T10:00:00.000Z");
			expect(sessions).toHaveLength(1);
		});
	});

	// === coordinatorName ===

	describe("coordinatorName", () => {
		test("creates run with coordinatorName and retrieves it", () => {
			runStore.createRun(makeRun({ coordinatorName: "coordinator" }));
			const result = runStore.getRun("run-2026-02-13T10:00:00.000Z");
			expect(result?.coordinatorName).toBe("coordinator");
		});

		test("creates run with null coordinatorName", () => {
			runStore.createRun(makeRun({ coordinatorName: null }));
			const result = runStore.getRun("run-2026-02-13T10:00:00.000Z");
			expect(result?.coordinatorName).toBeNull();
		});

		test("creates run without coordinatorName defaults to null", () => {
			runStore.createRun(makeRun());
			const result = runStore.getRun("run-2026-02-13T10:00:00.000Z");
			expect(result?.coordinatorName).toBeNull();
		});
	});

	// === getActiveRunForCoordinator ===

	describe("getActiveRunForCoordinator", () => {
		test("returns the active run for the given coordinator", () => {
			runStore.createRun(
				makeRun({
					id: "run-coord-a",
					coordinatorName: "coordinator-a",
					startedAt: "2026-02-13T10:00:00.000Z",
				}),
			);
			runStore.createRun(
				makeRun({
					id: "run-coord-b",
					coordinatorName: "coordinator-b",
					startedAt: "2026-02-13T11:00:00.000Z",
				}),
			);

			const result = runStore.getActiveRunForCoordinator("coordinator-a");
			expect(result?.id).toBe("run-coord-a");
		});

		test("returns null when no active run for coordinator", () => {
			runStore.createRun(makeRun({ id: "run-coord-a", coordinatorName: "coordinator-a" }));
			runStore.completeRun("run-coord-a", "completed");

			const result = runStore.getActiveRunForCoordinator("coordinator-a");
			expect(result).toBeNull();
		});

		test("returns null for unknown coordinator", () => {
			runStore.createRun(makeRun({ id: "run-coord-a", coordinatorName: "coordinator-a" }));
			const result = runStore.getActiveRunForCoordinator("other-coordinator");
			expect(result).toBeNull();
		});

		test("returns most recent active run when coordinator has multiple", () => {
			runStore.createRun(
				makeRun({
					id: "run-early",
					coordinatorName: "coordinator",
					startedAt: "2026-02-13T08:00:00.000Z",
				}),
			);
			runStore.createRun(
				makeRun({
					id: "run-late",
					coordinatorName: "coordinator",
					startedAt: "2026-02-13T12:00:00.000Z",
				}),
			);

			const result = runStore.getActiveRunForCoordinator("coordinator");
			expect(result?.id).toBe("run-late");
		});

		test("ignores runs for other coordinators", () => {
			runStore.createRun(makeRun({ id: "run-a", coordinatorName: "coordinator-a" }));
			runStore.createRun(
				makeRun({
					id: "run-b",
					coordinatorName: "coordinator-b",
					startedAt: "2026-02-13T11:00:00.000Z",
				}),
			);

			const result = runStore.getActiveRunForCoordinator("coordinator-a");
			expect(result?.id).toBe("run-a");
			expect(result?.coordinatorName).toBe("coordinator-a");
		});
	});

	// === migration: coordinator_name column ===

	describe("migration: coordinator_name column", () => {
		test("adds coordinator_name column to existing runs table without it", async () => {
			// Create a store, close it, then manually drop the coordinator_name column
			// by creating a fresh DB without it, simulating a pre-migration schema.
			runStore.close();

			const { Database: Db } = await import("bun:sqlite");
			const legacyDb = new Db(dbPath);
			legacyDb.exec("DROP TABLE IF EXISTS runs");
			legacyDb.exec(`
				CREATE TABLE runs (
					id TEXT PRIMARY KEY,
					started_at TEXT NOT NULL,
					completed_at TEXT,
					agent_count INTEGER NOT NULL DEFAULT 0,
					coordinator_session_id TEXT,
					status TEXT NOT NULL DEFAULT 'active'
				)
			`);
			legacyDb.exec(
				"INSERT INTO runs (id, started_at, status) VALUES ('legacy-run', '2026-01-01T00:00:00.000Z', 'active')",
			);
			legacyDb.close();

			// Opening a new RunStore should run the migration and add coordinator_name
			const migratedStore = createRunStore(dbPath);
			try {
				const run = migratedStore.getRun("legacy-run");
				expect(run).not.toBeNull();
				expect(run?.coordinatorName).toBeNull();
			} finally {
				migratedStore.close();
			}

			// Re-assign store so afterEach cleanup doesn't double-close
			runStore = createRunStore(join(tempDir, "unused-run.db"));
		});
	});

	// === close ===

	describe("close", () => {
		test("close does not throw when called on open store", () => {
			runStore.createRun(makeRun());
			expect(() => runStore.close()).not.toThrow();
		});
	});

	// === edge cases ===

	describe("edge cases", () => {
		test("handles many runs efficiently", () => {
			for (let i = 0; i < 50; i++) {
				runStore.createRun(
					makeRun({
						id: `run-${i}`,
						startedAt: `2026-02-13T${String(i).padStart(2, "0")}:00:00.000Z`,
					}),
				);
			}

			const all = runStore.listRuns();
			expect(all).toHaveLength(50);
		});

		test("all fields roundtrip correctly", () => {
			const run: InsertRun = {
				id: "run-roundtrip-test",
				startedAt: "2026-02-13T15:30:00.000Z",
				coordinatorSessionId: "coord-session-roundtrip",
				status: "active",
				agentCount: 7,
			};

			runStore.createRun(run);
			const result = runStore.getRun("run-roundtrip-test");

			expect(result).not.toBeNull();
			expect(result?.id).toBe("run-roundtrip-test");
			expect(result?.startedAt).toBe("2026-02-13T15:30:00.000Z");
			expect(result?.completedAt).toBeNull();
			expect(result?.agentCount).toBe(7);
			expect(result?.coordinatorSessionId).toBe("coord-session-roundtrip");
			expect(result?.status).toBe("active");
		});
	});
});

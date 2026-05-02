import { describe, expect, test } from "bun:test";
import type { AgentSession } from "../types.ts";
import { evaluateHealth, isProcessRunning, transitionState } from "./health.ts";

/**
 * Tests for the ZFC-based health evaluation and state machine.
 *
 * evaluateHealth is a pure function that takes session state + tmux liveness +
 * thresholds and returns a HealthCheck. No mocks needed for the core logic.
 *
 * isProcessRunning uses process.kill(pid, 0) which is safe to test with real PIDs:
 * the current process PID (alive) and a known-dead PID (not alive).
 *
 * Note: evaluateHealth calls isProcessRunning internally. For tests that need
 * to control pid liveness independently of the actual OS process table, we set
 * session.pid to known-alive (current process) or known-dead PIDs.
 */

const THRESHOLDS = { staleMs: 30_000, zombieMs: 120_000 };

/** PID that is guaranteed to be alive during tests: our own process. */
const ALIVE_PID = process.pid;

/**
 * PID that is very likely dead. PID 2147483647 (max 32-bit signed int) is
 * almost never in use. If by some miracle it is, the test still works because
 * we use it only for the "pid dead" path and the test validates behavior, not
 * the exact PID value.
 */
const DEAD_PID = 2147483647;

function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
	return {
		id: "session-test",
		agentName: "test-agent",
		capability: "builder",
		worktreePath: "/tmp/test",
		branchName: "overstory/test-agent/test-task",
		taskId: "test-task",
		tmuxSession: "overstory-test-agent",
		state: "booting",
		pid: ALIVE_PID,
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

// === isProcessRunning ===

describe("isProcessRunning", () => {
	test("returns true for the current process PID", () => {
		expect(isProcessRunning(process.pid)).toBe(true);
	});

	test("returns false for a PID that does not exist", () => {
		// PID 2147483647 is max 32-bit signed — extremely unlikely to be alive
		expect(isProcessRunning(DEAD_PID)).toBe(false);
	});
});

// === evaluateHealth ===

describe("evaluateHealth", () => {
	// --- ZFC Rule 1: tmux dead → zombie (observable state wins) ---

	test("ZFC: tmux dead + sessions.json says working → zombie with reconciliation note", () => {
		const session = makeSession({ state: "working" });
		const check = evaluateHealth(session, false, THRESHOLDS);

		expect(check.state).toBe("zombie");
		expect(check.action).toBe("terminate");
		expect(check.tmuxAlive).toBe(false);
		expect(check.processAlive).toBe(false);
		expect(check.reconciliationNote).toContain("ZFC");
		expect(check.reconciliationNote).toContain("tmux dead");
		expect(check.reconciliationNote).toContain('"working"');
	});

	test("ZFC: tmux dead + sessions.json says booting → zombie with reconciliation note", () => {
		const session = makeSession({ state: "booting" });
		const check = evaluateHealth(session, false, THRESHOLDS);

		expect(check.state).toBe("zombie");
		expect(check.action).toBe("terminate");
		expect(check.reconciliationNote).toContain("ZFC");
		expect(check.reconciliationNote).toContain('"booting"');
	});

	test("ZFC: tmux dead + sessions.json says stalled → zombie (no reconciliation note for already-degraded)", () => {
		const session = makeSession({ state: "stalled" });
		const check = evaluateHealth(session, false, THRESHOLDS);

		expect(check.state).toBe("zombie");
		expect(check.action).toBe("terminate");
		// No reconciliation note for stalled → zombie (expected progression)
		expect(check.reconciliationNote).toBeNull();
	});

	// --- ZFC Rule 1 fallback: tmux dead + stale lastActivity → completed ---

	test("ZFC fallback: tmux dead + stale lastActivity (working) → complete (missed signal)", () => {
		const staleActivity = new Date(Date.now() - 60_000).toISOString();
		const session = makeSession({ state: "working", lastActivity: staleActivity });
		const check = evaluateHealth(session, false, THRESHOLDS);

		expect(check.state).toBe("completed");
		expect(check.action).toBe("complete");
		expect(check.tmuxAlive).toBe(false);
		expect(check.processAlive).toBe(false);
		expect(check.reconciliationNote).toContain("missed session-end signal");
	});

	test("ZFC fallback: tmux dead + stale lastActivity (stalled) → complete (missed signal)", () => {
		const staleActivity = new Date(Date.now() - 90_000).toISOString();
		const session = makeSession({ state: "stalled", lastActivity: staleActivity });
		const check = evaluateHealth(session, false, THRESHOLDS);

		expect(check.state).toBe("completed");
		expect(check.action).toBe("complete");
	});

	test("ZFC: tmux dead + recent lastActivity → still zombie (true crash)", () => {
		const recentActivity = new Date(Date.now() - 1_000).toISOString();
		const session = makeSession({ state: "working", lastActivity: recentActivity });
		const check = evaluateHealth(session, false, THRESHOLDS);

		expect(check.state).toBe("zombie");
		expect(check.action).toBe("terminate");
	});

	test("ZFC fallback (headless): pid dead + stale lastActivity → complete", () => {
		const staleActivity = new Date(Date.now() - 60_000).toISOString();
		const session = makeSession({
			state: "working",
			tmuxSession: "",
			pid: DEAD_PID,
			lastActivity: staleActivity,
		});
		const check = evaluateHealth(session, false, THRESHOLDS);

		expect(check.state).toBe("completed");
		expect(check.action).toBe("complete");
		expect(check.reconciliationNote).toContain("missed session-end signal");
	});

	test("ZFC (headless): pid dead + recent lastActivity → still zombie", () => {
		const recentActivity = new Date(Date.now() - 1_000).toISOString();
		const session = makeSession({
			state: "working",
			tmuxSession: "",
			pid: DEAD_PID,
			lastActivity: recentActivity,
		});
		const check = evaluateHealth(session, false, THRESHOLDS);

		expect(check.state).toBe("zombie");
		expect(check.action).toBe("terminate");
	});

	// --- ZFC Rule 2: tmux alive + sessions.json says zombie → investigate ---

	test("ZFC: tmux alive + sessions.json says zombie → investigate (don't auto-kill)", () => {
		const session = makeSession({ state: "zombie", pid: ALIVE_PID });
		const check = evaluateHealth(session, true, THRESHOLDS);

		expect(check.state).toBe("zombie");
		expect(check.action).toBe("investigate");
		expect(check.processAlive).toBe(true);
		expect(check.reconciliationNote).toContain("ZFC");
		expect(check.reconciliationNote).toContain("investigation needed");
		expect(check.reconciliationNote).toContain("don't auto-kill");
	});

	// --- ZFC Rule 3: pid dead + tmux alive → zombie ---

	test("ZFC: pid dead + tmux alive → zombie (agent process exited, shell survived)", () => {
		const session = makeSession({ state: "working", pid: DEAD_PID });
		const check = evaluateHealth(session, true, THRESHOLDS);

		expect(check.state).toBe("zombie");
		expect(check.action).toBe("terminate");
		expect(check.processAlive).toBe(false);
		expect(check.pidAlive).toBe(false);
		expect(check.tmuxAlive).toBe(true);
		expect(check.reconciliationNote).toContain("ZFC");
		expect(check.reconciliationNote).toContain("pid");
		expect(check.reconciliationNote).toContain("shell survived");
	});

	// --- pid null (unavailable) ---

	test("pid null does not trigger pid-based zombie detection", () => {
		const session = makeSession({ state: "working", pid: null });
		const check = evaluateHealth(session, true, THRESHOLDS);

		expect(check.state).toBe("working");
		expect(check.action).toBe("none");
		expect(check.pidAlive).toBeNull();
	});

	// --- Time-based checks (both tmux and pid alive) ---

	test("activity older than zombieMs → zombie", () => {
		const oldActivity = new Date(Date.now() - 200_000).toISOString();
		const session = makeSession({ state: "working", lastActivity: oldActivity });
		const check = evaluateHealth(session, true, THRESHOLDS);

		expect(check.state).toBe("zombie");
		expect(check.action).toBe("terminate");
		expect(check.reconciliationNote).toBeNull();
	});

	test("activity older than staleMs → stalled", () => {
		const staleActivity = new Date(Date.now() - 60_000).toISOString();
		const session = makeSession({ state: "working", lastActivity: staleActivity });
		const check = evaluateHealth(session, true, THRESHOLDS);

		expect(check.state).toBe("stalled");
		expect(check.action).toBe("escalate");
		expect(check.reconciliationNote).toBeNull();
	});

	// --- Normal state transitions ---

	test("booting with recent activity → transitions to working", () => {
		const recentActivity = new Date(Date.now() - 5_000).toISOString();
		const session = makeSession({ state: "booting", lastActivity: recentActivity });
		const check = evaluateHealth(session, true, THRESHOLDS);

		expect(check.state).toBe("working");
		expect(check.action).toBe("none");
		expect(check.reconciliationNote).toBeNull();
	});

	test("working with recent activity → stays working", () => {
		const recentActivity = new Date(Date.now() - 5_000).toISOString();
		const session = makeSession({ state: "working", lastActivity: recentActivity });
		const check = evaluateHealth(session, true, THRESHOLDS);

		expect(check.state).toBe("working");
		expect(check.action).toBe("none");
	});

	test("booting with stale activity → stalled", () => {
		const staleActivity = new Date(Date.now() - 60_000).toISOString();
		const session = makeSession({ state: "booting", lastActivity: staleActivity });
		const check = evaluateHealth(session, true, THRESHOLDS);

		expect(check.state).toBe("stalled");
		expect(check.action).toBe("escalate");
	});

	// --- Persistent capabilities (coordinator, orchestrator, monitor) ---

	test("persistent capability: coordinator with stale activity → still working, no escalation", () => {
		const staleActivity = new Date(Date.now() - 60_000).toISOString();
		const session = makeSession({
			capability: "coordinator",
			state: "working",
			lastActivity: staleActivity,
		});
		const check = evaluateHealth(session, true, THRESHOLDS);

		expect(check.state).toBe("working");
		expect(check.action).toBe("none");
	});

	test("persistent capability: coordinator with zombie-level staleness → still working", () => {
		const oldActivity = new Date(Date.now() - 200_000).toISOString();
		const session = makeSession({
			capability: "coordinator",
			state: "working",
			lastActivity: oldActivity,
		});
		const check = evaluateHealth(session, true, THRESHOLDS);

		expect(check.state).toBe("working");
		expect(check.action).toBe("none");
	});

	test("persistent capability: monitor with stale activity → still working", () => {
		const staleActivity = new Date(Date.now() - 60_000).toISOString();
		const session = makeSession({
			capability: "monitor",
			state: "working",
			lastActivity: staleActivity,
		});
		const check = evaluateHealth(session, true, THRESHOLDS);

		expect(check.state).toBe("working");
		expect(check.action).toBe("none");
	});

	test("persistent capability: orchestrator with stale activity → still working", () => {
		const staleActivity = new Date(Date.now() - 60_000).toISOString();
		const session = makeSession({
			agentName: "orchestrator",
			capability: "orchestrator",
			state: "working",
			lastActivity: staleActivity,
		});
		const check = evaluateHealth(session, true, THRESHOLDS);

		expect(check.state).toBe("working");
		expect(check.action).toBe("none");
	});

	test("persistent capability: coordinator booting → transitions to working", () => {
		const session = makeSession({
			capability: "coordinator",
			state: "booting",
		});
		const check = evaluateHealth(session, true, THRESHOLDS);

		expect(check.state).toBe("working");
		expect(check.action).toBe("none");
	});

	test("persistent capability: coordinator previously stalled → resets to working", () => {
		const staleActivity = new Date(Date.now() - 60_000).toISOString();
		const session = makeSession({
			capability: "coordinator",
			state: "stalled",
			lastActivity: staleActivity,
		});
		const check = evaluateHealth(session, true, THRESHOLDS);

		expect(check.state).toBe("working");
		expect(check.action).toBe("none");
		expect(check.reconciliationNote).toContain("Persistent capability");
	});

	test("persistent capability: coordinator with tmux dead → still zombie (ZFC Rule 1 applies)", () => {
		const session = makeSession({
			capability: "coordinator",
			state: "working",
		});
		const check = evaluateHealth(session, false, THRESHOLDS);

		expect(check.state).toBe("zombie");
		expect(check.action).toBe("terminate");
	});

	test("persistent capability: coordinator with pid dead → still zombie (ZFC Rule 3 applies)", () => {
		const session = makeSession({
			capability: "coordinator",
			state: "working",
			pid: DEAD_PID,
		});
		const check = evaluateHealth(session, true, THRESHOLDS);

		expect(check.state).toBe("zombie");
		expect(check.action).toBe("terminate");
	});

	// --- Completed agents ---

	test("completed agents skip monitoring", () => {
		const session = makeSession({ state: "completed" });
		const check = evaluateHealth(session, true, THRESHOLDS);

		expect(check.state).toBe("completed");
		expect(check.action).toBe("none");
		expect(check.reconciliationNote).toBeNull();
	});

	// --- pidAlive field is populated ---

	test("pidAlive reflects actual process state for alive PID", () => {
		const session = makeSession({ pid: ALIVE_PID, state: "working" });
		const check = evaluateHealth(session, true, THRESHOLDS);

		expect(check.pidAlive).toBe(true);
	});

	test("pidAlive reflects actual process state for dead PID", () => {
		// Use dead pid but also tmux dead to avoid pid-zombie path intercepting
		const session = makeSession({ pid: DEAD_PID, state: "working" });
		const check = evaluateHealth(session, false, THRESHOLDS);

		// tmux dead takes priority, so state is zombie via ZFC Rule 1
		expect(check.state).toBe("zombie");
		expect(check.pidAlive).toBe(false);
	});
});

// === Headless agents (tmuxSession === '', PID-based lifecycle) ===

describe("headless agents (tmuxSession empty, PID-based lifecycle)", () => {
	// Headless agents always have tmuxAlive=false passed by the caller (no tmux).
	// PID is the primary liveness signal.

	test("headless agent with alive PID → working (NOT zombie)", () => {
		const session = makeSession({ tmuxSession: "", pid: ALIVE_PID, state: "working" });
		const check = evaluateHealth(session, false, THRESHOLDS);

		expect(check.state).toBe("working");
		expect(check.action).toBe("none");
		expect(check.processAlive).toBe(true);
		expect(check.pidAlive).toBe(true);
		// tmuxAlive is always false for headless
		expect(check.tmuxAlive).toBe(false);
	});

	test("headless agent with dead PID → zombie, terminate", () => {
		const session = makeSession({ tmuxSession: "", pid: DEAD_PID, state: "working" });
		const check = evaluateHealth(session, false, THRESHOLDS);

		expect(check.state).toBe("zombie");
		expect(check.action).toBe("terminate");
		expect(check.processAlive).toBe(false);
		expect(check.pidAlive).toBe(false);
		expect(check.reconciliationNote).toContain("ZFC");
		expect(check.reconciliationNote).toContain("headless");
		expect(check.reconciliationNote).toContain("dead");
	});

	test("headless agent with alive PID + state=zombie → investigate (don't auto-kill)", () => {
		const session = makeSession({ tmuxSession: "", pid: ALIVE_PID, state: "zombie" });
		const check = evaluateHealth(session, false, THRESHOLDS);

		expect(check.state).toBe("zombie");
		expect(check.action).toBe("investigate");
		expect(check.processAlive).toBe(true);
		expect(check.reconciliationNote).toContain("ZFC");
		expect(check.reconciliationNote).toContain("don't auto-kill");
	});

	test("headless booting agent with alive PID → transitions to working", () => {
		const session = makeSession({ tmuxSession: "", pid: ALIVE_PID, state: "booting" });
		const check = evaluateHealth(session, false, THRESHOLDS);

		expect(check.state).toBe("working");
		expect(check.action).toBe("none");
	});

	test("headless agent with stale activity → stalled", () => {
		const staleActivity = new Date(Date.now() - 60_000).toISOString();
		const session = makeSession({
			tmuxSession: "",
			pid: ALIVE_PID,
			state: "working",
			lastActivity: staleActivity,
		});
		const check = evaluateHealth(session, false, THRESHOLDS);

		expect(check.state).toBe("stalled");
		expect(check.action).toBe("escalate");
	});

	test("headless agent with zombie-level staleness → zombie", () => {
		const oldActivity = new Date(Date.now() - 200_000).toISOString();
		const session = makeSession({
			tmuxSession: "",
			pid: ALIVE_PID,
			state: "working",
			lastActivity: oldActivity,
		});
		const check = evaluateHealth(session, false, THRESHOLDS);

		expect(check.state).toBe("zombie");
		expect(check.action).toBe("terminate");
	});

	test("headless persistent capability (coordinator) with stale activity → still working", () => {
		const staleActivity = new Date(Date.now() - 60_000).toISOString();
		const session = makeSession({
			tmuxSession: "",
			pid: ALIVE_PID,
			capability: "coordinator",
			state: "working",
			lastActivity: staleActivity,
		});
		const check = evaluateHealth(session, false, THRESHOLDS);

		expect(check.state).toBe("working");
		expect(check.action).toBe("none");
	});

	test("headless completed agent → skips monitoring", () => {
		const session = makeSession({ tmuxSession: "", pid: ALIVE_PID, state: "completed" });
		const check = evaluateHealth(session, false, THRESHOLDS);

		expect(check.state).toBe("completed");
		expect(check.action).toBe("none");
	});
});

// === Spawn-per-turn workers (tmuxSession === '' && pid === null) ===

describe("spawn-per-turn workers (overstory-7a34)", () => {
	// Spawn-per-turn workers (builder/scout/reviewer/lead/merger under the
	// headless default) have no persistent process between turns. The previous
	// "headless" branch only matched pid !== null, so these sessions fell into
	// the TUI/tmux path where tmuxAlive=false → ZFC Rule 1 → zombie within
	// seconds of sling, despite being actively executing tools (overstory-7a34).

	test("freshly slung spawn-per-turn lead (booting, no pid, no tmux) → between_turns (overstory-3087)", () => {
		// Spec change: spawn-per-turn workers report `between_turns` instead
		// of `working` for the healthy classification, including the booting
		// → healthy transition. The turn-runner authoritatively writes
		// `in_turn` once the first parser event of a turn arrives.
		const session = makeSession({
			tmuxSession: "",
			pid: null,
			capability: "lead",
			state: "booting",
			lastActivity: new Date().toISOString(),
		});
		const check = evaluateHealth(session, false, THRESHOLDS);

		expect(check.state).toBe("between_turns");
		expect(check.action).toBe("none");
		expect(check.reconciliationNote).toBeNull();
	});

	test("legacy spawn-per-turn worker still at 'working' is reported as between_turns (overstory-3087)", () => {
		// A row that predates the substate split (state=working) gets
		// reclassified to `between_turns` by the watchdog's healthy-state
		// reporter. transitionState then promotes the row forward (working
		// and between_turns share rank 1 in STATE_ORDER, so the actual
		// promotion happens via tryTransitionState elsewhere — here we just
		// verify the check itself reports the new substate).
		const session = makeSession({
			tmuxSession: "",
			pid: null,
			capability: "builder",
			state: "working",
			lastActivity: new Date(Date.now() - 5_000).toISOString(),
		});
		const check = evaluateHealth(session, false, THRESHOLDS);

		expect(check.state).toBe("between_turns");
		expect(check.action).toBe("none");
	});

	test("spawn-per-turn worker between turns (recent activity) → between_turns, NOT zombie (overstory-3087)", () => {
		// Repro of overstory-7a34: ov sling --capability lead any-task; within
		// ~30s ov dashboard previously showed state='zombie' while ov feed
		// showed live tool calls. The healthy classification now lands
		// between_turns; the test still verifies that recent activity does
		// not trigger zombie classification.
		const session = makeSession({
			tmuxSession: "",
			pid: null,
			capability: "lead",
			state: "working",
			lastActivity: new Date().toISOString(),
		});
		const check = evaluateHealth(session, false, THRESHOLDS);

		expect(check.state).toBe("between_turns");
		expect(check.action).toBe("none");
	});

	test("spawn-per-turn worker with stale activity → stalled", () => {
		const session = makeSession({
			tmuxSession: "",
			pid: null,
			capability: "builder",
			state: "working",
			lastActivity: new Date(Date.now() - 60_000).toISOString(),
		});
		const check = evaluateHealth(session, false, THRESHOLDS);

		expect(check.state).toBe("stalled");
		expect(check.action).toBe("escalate");
	});

	test("spawn-per-turn worker with zombie-level staleness → zombie, terminate", () => {
		const session = makeSession({
			tmuxSession: "",
			pid: null,
			capability: "builder",
			state: "working",
			lastActivity: new Date(Date.now() - 200_000).toISOString(),
		});
		const check = evaluateHealth(session, false, THRESHOLDS);

		expect(check.state).toBe("zombie");
		expect(check.action).toBe("terminate");
	});

	test("spawn-per-turn worker that already completed → skips monitoring", () => {
		const session = makeSession({
			tmuxSession: "",
			pid: null,
			capability: "builder",
			state: "completed",
		});
		const check = evaluateHealth(session, false, THRESHOLDS);

		expect(check.state).toBe("completed");
		expect(check.action).toBe("none");
	});

	test("preserves in_turn for healthy spawn-per-turn worker (overstory-3087)", () => {
		// A spawn-per-turn worker the turn-runner has marked in_turn must
		// have its state preserved by the health evaluation when activity is
		// recent — otherwise the watchdog would stomp the substate back to
		// `working` and the UI would lose the distinction between mid-turn
		// and idling.
		const session = makeSession({
			tmuxSession: "",
			pid: null,
			capability: "builder",
			state: "in_turn",
			lastActivity: new Date().toISOString(),
		});
		const check = evaluateHealth(session, false, THRESHOLDS);

		expect(check.state).toBe("in_turn");
		expect(check.action).toBe("none");
	});

	test("preserves between_turns for healthy spawn-per-turn worker (overstory-3087)", () => {
		const session = makeSession({
			tmuxSession: "",
			pid: null,
			capability: "builder",
			state: "between_turns",
			lastActivity: new Date().toISOString(),
		});
		const check = evaluateHealth(session, false, THRESHOLDS);

		expect(check.state).toBe("between_turns");
		expect(check.action).toBe("none");
	});

	test("escalates an in_turn worker with stale activity to stalled (overstory-3087)", () => {
		const session = makeSession({
			tmuxSession: "",
			pid: null,
			capability: "builder",
			state: "in_turn",
			lastActivity: new Date(Date.now() - 60_000).toISOString(),
		});
		const check = evaluateHealth(session, false, THRESHOLDS);

		expect(check.state).toBe("stalled");
		expect(check.action).toBe("escalate");
	});
});

// === transitionState ===

describe("transitionState", () => {
	test("advances from booting to working", () => {
		const check = {
			state: "working" as const,
			agentName: "a",
			timestamp: "",
			tmuxAlive: true,
			pidAlive: true as boolean | null,
			lastActivity: "",
			processAlive: true,
			action: "none" as const,
			reconciliationNote: null,
		};
		expect(transitionState("booting", check)).toBe("working");
	});

	test("advances from working to stalled", () => {
		const check = {
			state: "stalled" as const,
			agentName: "a",
			timestamp: "",
			tmuxAlive: true,
			pidAlive: true as boolean | null,
			lastActivity: "",
			processAlive: true,
			action: "escalate" as const,
			reconciliationNote: null,
		};
		expect(transitionState("working", check)).toBe("stalled");
	});

	test("never regresses from stalled to working", () => {
		const check = {
			state: "working" as const,
			agentName: "a",
			timestamp: "",
			tmuxAlive: true,
			pidAlive: true as boolean | null,
			lastActivity: "",
			processAlive: true,
			action: "none" as const,
			reconciliationNote: null,
		};
		expect(transitionState("stalled", check)).toBe("stalled");
	});

	test("never regresses from zombie to booting", () => {
		const check = {
			state: "booting" as const,
			agentName: "a",
			timestamp: "",
			tmuxAlive: true,
			pidAlive: true as boolean | null,
			lastActivity: "",
			processAlive: true,
			action: "none" as const,
			reconciliationNote: null,
		};
		expect(transitionState("zombie", check)).toBe("zombie");
	});

	test("same state stays the same", () => {
		const check = {
			state: "working" as const,
			agentName: "a",
			timestamp: "",
			tmuxAlive: true,
			pidAlive: true as boolean | null,
			lastActivity: "",
			processAlive: true,
			action: "none" as const,
			reconciliationNote: null,
		};
		expect(transitionState("working", check)).toBe("working");
	});

	// --- ZFC: investigate holds state ---

	test("ZFC: investigate action holds current state (does not advance)", () => {
		const check = {
			state: "zombie" as const,
			agentName: "a",
			timestamp: "",
			tmuxAlive: true,
			pidAlive: true as boolean | null,
			lastActivity: "",
			processAlive: true,
			action: "investigate" as const,
			reconciliationNote: "ZFC: tmux alive but sessions.json says zombie",
		};
		// Even though check.state is zombie (order 4) and current is zombie (order 4),
		// investigate should hold — not advance
		expect(transitionState("zombie", check)).toBe("zombie");
	});

	test("ZFC: investigate prevents forward transition", () => {
		const check = {
			state: "zombie" as const,
			agentName: "a",
			timestamp: "",
			tmuxAlive: true,
			pidAlive: true as boolean | null,
			lastActivity: "",
			processAlive: true,
			action: "investigate" as const,
			reconciliationNote: "ZFC conflict",
		};
		// If something were at "working" and check says zombie with investigate,
		// the state should NOT advance
		expect(transitionState("working", check)).toBe("working");
	});

	// --- in_turn / between_turns coexist with working at the active rank (overstory-3087) ---

	test("preserves in_turn when watchdog reports a healthy 'working' check", () => {
		// The watchdog's healthy-classification check returns state=working;
		// since in_turn shares rank 1 with working, transitionState must not
		// advance and the spawn-per-turn substate the turn-runner wrote stays.
		const check = {
			state: "working" as const,
			agentName: "a",
			timestamp: "",
			tmuxAlive: true,
			pidAlive: true as boolean | null,
			lastActivity: "",
			processAlive: true,
			action: "none" as const,
			reconciliationNote: null,
		};
		expect(transitionState("in_turn", check)).toBe("in_turn");
	});

	test("preserves between_turns when watchdog reports a healthy 'working' check", () => {
		const check = {
			state: "working" as const,
			agentName: "a",
			timestamp: "",
			tmuxAlive: true,
			pidAlive: true as boolean | null,
			lastActivity: "",
			processAlive: true,
			action: "none" as const,
			reconciliationNote: null,
		};
		expect(transitionState("between_turns", check)).toBe("between_turns");
	});

	test("advances in_turn → stalled when the watchdog escalates", () => {
		const check = {
			state: "stalled" as const,
			agentName: "a",
			timestamp: "",
			tmuxAlive: true,
			pidAlive: true as boolean | null,
			lastActivity: "",
			processAlive: true,
			action: "escalate" as const,
			reconciliationNote: null,
		};
		expect(transitionState("in_turn", check)).toBe("stalled");
	});

	test("advances between_turns → zombie when the watchdog terminates", () => {
		const check = {
			state: "zombie" as const,
			agentName: "a",
			timestamp: "",
			tmuxAlive: false,
			pidAlive: false as boolean | null,
			lastActivity: "",
			processAlive: false,
			action: "terminate" as const,
			reconciliationNote: null,
		};
		expect(transitionState("between_turns", check)).toBe("zombie");
	});
});

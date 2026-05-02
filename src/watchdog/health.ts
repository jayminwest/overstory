/**
 * Health check state machine and evaluation logic for agent monitoring.
 *
 * ZFC Principle (Zero Failure Crash)
 * ==================================
 * Observable state is the source of truth, not recorded state.
 *
 * Signal priority (highest to lowest):
 *   1. tmux session liveness  — Is the tmux session actually running?
 *   2. Process liveness (pid) — Is the Claude Code process still alive?
 *   3. Recorded state         — What does sessions.json claim?
 *
 * When signals conflict, always trust what you can observe:
 *   - tmux dead + sessions.json says "working" → mark zombie immediately.
 *     The recorded state is stale; the process is gone.
 *   - tmux alive + sessions.json says "zombie" → investigate, don't auto-kill.
 *     Something marked it zombie but the process recovered or was misclassified.
 *   - pid dead + tmux alive → the pane's shell survived but the agent process
 *     exited. Treat as zombie (the agent is not doing work).
 *   - pid alive + tmux dead → should not happen (tmux owns the pid), but if it
 *     does, trust tmux (the session is gone).
 *
 * Headless agents (tmuxSession === ''):
 *   Headless agents have no tmux session. For these, PID is the PRIMARY liveness
 *   signal. The tmuxAlive parameter is meaningless and ignored. ZFC rules are
 *   applied using PID liveness instead of tmux liveness.
 *
 * The rationale: sessions.json is updated asynchronously by hooks and can become
 * stale if the agent crashes between hook invocations. tmux and the OS process
 * table are always up-to-date because they reflect real kernel state.
 */

import { isPersistentCapability } from "../agents/capabilities.ts";
import type { AgentSession, AgentState, HealthCheck } from "../types.ts";

/**
 * Numeric ordering for forward-only state transitions.
 *
 * `in_turn` and `between_turns` share the `working` rank (1) because, from
 * the watchdog's perspective, all three are "agent is alive and active" —
 * they only differ in whether the spawn-per-turn worker is currently
 * mid-execution or idling between mail batches (overstory-3087). Same rank
 * means a healthy-classification check (`check.state === "working"`) will
 * not stomp on the more specific in_turn/between_turns states the
 * turn-runner has already written.
 */
const STATE_ORDER: Record<AgentState, number> = {
	booting: 0,
	working: 1,
	in_turn: 1,
	between_turns: 1,
	completed: 2,
	stalled: 3,
	zombie: 4,
};

/**
 * Check whether a process with the given PID is still running.
 *
 * Uses signal 0 which does not kill the process — it only checks
 * whether it exists and we have permission to signal it.
 *
 * @param pid - The process ID to check
 * @returns true if the process exists, false otherwise
 */
export function isProcessRunning(pid: number): boolean {
	try {
		// Signal 0 doesn't kill the process — just checks if it exists
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * Detect whether a session is a long-lived headless agent.
 *
 * Long-lived headless agents (coordinator, orchestrator, monitor, sapling, etc.)
 * have no tmux session (tmuxSession === '') but do have a persistent process —
 * so `session.pid` is non-null and PID is the primary liveness signal.
 */
function isHeadlessSession(session: AgentSession): boolean {
	return session.tmuxSession === "" && session.pid !== null;
}

/**
 * Detect whether a session is a spawn-per-turn worker between turns.
 *
 * Spawn-per-turn workers (task-scoped capabilities under the new headless
 * default — builder/scout/reviewer/lead/merger) have no tmux session AND no
 * persistent process: `tmuxSession === ''` and `session.pid === null` from
 * sling onward. The per-turn claude PID lives in
 * `.overstory/agents/<name>/turn.pid` only while a turn is in flight.
 *
 * "No process" is the normal state between turns, so neither tmux liveness nor
 * pid liveness can be used as a death signal — only `lastActivity` recency
 * (refreshed by the turn-runner on every event and by the watchdog from
 * events.db) can. (overstory-7a34)
 */
export function isSpawnPerTurnSession(session: AgentSession): boolean {
	return session.tmuxSession === "" && session.pid === null;
}

/**
 * Evaluate time-based health (persistent capability exemptions, stale, zombie thresholds,
 * booting→working transition). Called after liveness is confirmed for both TUI and headless paths.
 *
 * Assumes that by the time this is called:
 * - The agent is not completed
 * - The agent is not in a liveness-based zombie state
 * - The agent is not in a zombie state that needs investigation
 */
function evaluateTimeBased(
	session: AgentSession,
	base: Pick<HealthCheck, "agentName" | "timestamp" | "tmuxAlive" | "pidAlive" | "lastActivity">,
	elapsedMs: number,
	thresholds: { staleMs: number; zombieMs: number },
): HealthCheck {
	// Persistent capabilities (coordinator, monitor) are expected to have long idle
	// periods waiting for mail/events. Skip time-based stale/zombie detection for
	// them — only tmux/pid liveness matters (checked above).
	if (isPersistentCapability(session.capability)) {
		// Transition booting → working if we reach here (process alive)
		const state = session.state === "booting" ? "working" : session.state;
		return {
			...base,
			processAlive: true,
			state: state === "stalled" ? "working" : state,
			action: "none",
			reconciliationNote:
				session.state === "stalled"
					? `Persistent capability "${session.capability}" exempted from stale detection — resetting to working`
					: null,
		};
	}

	// lastActivity older than zombieMs → zombie
	if (elapsedMs > thresholds.zombieMs) {
		return {
			...base,
			processAlive: true,
			state: "zombie",
			action: "terminate",
			reconciliationNote: null,
		};
	}

	// lastActivity older than staleMs → stalled
	if (elapsedMs > thresholds.staleMs) {
		return {
			...base,
			processAlive: true,
			state: "stalled",
			action: "escalate",
			reconciliationNote: null,
		};
	}

	// Spawn-per-turn workers (overstory-3087): healthy classification reports
	// `between_turns` instead of `working`, including the booting → healthy
	// transition. The turn-runner authoritatively writes `in_turn` /
	// `between_turns` while a turn is alive; in_turn is preserved here when
	// already set so a watchdog tick mid-turn does not overwrite it.
	const isSpawnPerTurn = isSpawnPerTurnSession(session);

	// booting → transition to the healthy state once there's recent activity.
	if (session.state === "booting") {
		return {
			...base,
			processAlive: true,
			state: isSpawnPerTurn ? "between_turns" : "working",
			action: "none",
			reconciliationNote: null,
		};
	}

	// Default: healthy active state. For spawn-per-turn workers report the
	// existing in_turn/between_turns substate; for tmux/long-lived agents
	// report `working`. The turn-runner is authoritative for in_turn ↔
	// between_turns transitions, so the watchdog must not stomp the more
	// specific state — same rank in STATE_ORDER ensures `transitionState`
	// also leaves the row alone.
	let healthyState: AgentState;
	if (session.state === "in_turn" || session.state === "between_turns") {
		healthyState = session.state;
	} else if (isSpawnPerTurn) {
		healthyState = "between_turns";
	} else {
		healthyState = "working";
	}
	return {
		...base,
		processAlive: true,
		state: healthyState,
		action: "none",
		reconciliationNote: null,
	};
}

/**
 * Evaluate the health of an agent session.
 *
 * Implements the ZFC principle: observable state (tmux liveness, pid liveness)
 * takes priority over recorded state (sessions.json fields).
 *
 * Decision logic (in priority order):
 *
 * 1. Completed agents skip monitoring entirely.
 * 2. Spawn-per-turn workers (tmuxSession === '' && pid === null): no
 *    persistent process between turns — fall straight through to time-based
 *    checks driven by lastActivity. PID/tmux liveness are meaningless here.
 * 3. Headless agents with persistent process (tmuxSession === '' && pid !== null):
 *    PID is primary liveness signal.
 *    - pid dead → zombie, terminate.
 *    - pid alive + state zombie → investigate.
 *    - pid alive → fall through to time-based checks.
 * 4. tmux dead → zombie, terminate (regardless of what sessions.json says).
 * 5. tmux alive + sessions.json says zombie → investigate (don't auto-kill).
 *    Something external marked this zombie, but the process is still running.
 * 6. pid dead + tmux alive → zombie, terminate. The agent process exited but
 *    the tmux pane shell survived. The agent is not doing work.
 * 7. lastActivity older than zombieMs → zombie, terminate.
 * 8. lastActivity older than staleMs → stalled, escalate.
 * 9. booting with recent activity → working.
 * 10. Otherwise → working, healthy.
 *
 * @param session - The agent session to evaluate
 * @param tmuxAlive - Whether the agent's tmux session is still running
 *                    (ignored for headless agents where tmuxSession === '')
 * @param thresholds - Staleness and zombie time thresholds in milliseconds
 * @returns A HealthCheck describing the agent's current state and recommended action
 */
export function evaluateHealth(
	session: AgentSession,
	tmuxAlive: boolean,
	thresholds: { staleMs: number; zombieMs: number },
): HealthCheck {
	const now = new Date();
	const lastActivityTime = new Date(session.lastActivity).getTime();
	const elapsedMs = now.getTime() - lastActivityTime;

	// Check pid liveness as secondary signal (null if pid unavailable)
	const pidAlive = session.pid !== null ? isProcessRunning(session.pid) : null;

	// Headless agents have no tmux session; tmuxAlive is always false for them.
	const effectiveTmuxAlive = isHeadlessSession(session) ? false : tmuxAlive;

	const base: Pick<
		HealthCheck,
		"agentName" | "timestamp" | "tmuxAlive" | "pidAlive" | "lastActivity"
	> = {
		agentName: session.agentName,
		timestamp: now.toISOString(),
		tmuxAlive: effectiveTmuxAlive,
		pidAlive,
		lastActivity: session.lastActivity,
	};

	// Completed agents don't need health monitoring
	if (session.state === "completed") {
		return {
			...base,
			processAlive: effectiveTmuxAlive,
			state: "completed",
			action: "none",
			reconciliationNote: null,
		};
	}

	// === Spawn-per-turn path: no persistent process between turns ===
	// For these workers (overstory-7a34) `session.pid` is null by design and
	// there is no tmux session. Liveness signals reduce to lastActivity
	// recency: the turn-runner updates it on every parser event during a
	// turn, and the watchdog refreshes it from events.db between turns. PID
	// and tmux checks would always say "dead" and false-positive every fresh
	// agent as zombie within seconds of sling.
	if (isSpawnPerTurnSession(session)) {
		return evaluateTimeBased(session, base, elapsedMs, thresholds);
	}

	// === Headless path: PID is the primary liveness signal ===
	if (isHeadlessSession(session)) {
		// pid dead: zombie OR completed-with-missed-signal.
		// Distinguish by lastActivity age — recent activity means the agent
		// crashed mid-work (true zombie); stale activity means it likely
		// finished naturally and only the session-end hook didn't deliver
		// (treat as completed). (overstory-e74b)
		if (pidAlive === false) {
			if (
				elapsedMs > thresholds.staleMs &&
				(session.state === "working" || session.state === "booting" || session.state === "stalled")
			) {
				return {
					...base,
					processAlive: false,
					state: "completed",
					action: "complete",
					reconciliationNote: `ZFC: headless pid ${session.pid} dead + stale lastActivity (${Math.round(elapsedMs / 1000)}s ago) — assumed completed (missed session-end signal)`,
				};
			}
			return {
				...base,
				processAlive: false,
				state: "zombie",
				action: "terminate",
				reconciliationNote: `ZFC: headless agent pid ${session.pid} dead — marking zombie`,
			};
		}

		// pid alive + state zombie → investigate (equivalent to ZFC Rule 2 for headless)
		if (session.state === "zombie") {
			return {
				...base,
				processAlive: true,
				state: "zombie",
				action: "investigate",
				reconciliationNote:
					"ZFC: headless pid alive but sessions.json says zombie — investigation needed (don't auto-kill)",
			};
		}

		// pid alive → fall through to time-based checks
		return evaluateTimeBased(session, base, elapsedMs, thresholds);
	}

	// === TUI/tmux path ===

	// ZFC Rule 1: tmux dead → zombie OR completed-with-missed-signal.
	// Distinguish by lastActivity age — recent activity means the agent
	// crashed mid-work (true zombie); stale activity means it likely
	// finished naturally and only the session-end hook didn't deliver
	// (treat as completed). (overstory-e74b)
	if (!tmuxAlive) {
		if (
			elapsedMs > thresholds.staleMs &&
			(session.state === "working" || session.state === "booting" || session.state === "stalled")
		) {
			return {
				...base,
				processAlive: false,
				state: "completed",
				action: "complete",
				reconciliationNote: `ZFC: tmux dead + stale lastActivity (${Math.round(elapsedMs / 1000)}s ago) — assumed completed (missed session-end signal)`,
			};
		}

		const note =
			session.state === "working" || session.state === "booting"
				? `ZFC: tmux dead but sessions.json says "${session.state}" — marking zombie (observable state wins)`
				: null;

		return {
			...base,
			processAlive: false,
			state: "zombie",
			action: "terminate",
			reconciliationNote: note,
		};
	}

	// ZFC Rule 2: tmux alive but sessions.json says zombie → investigate.
	// Something marked it zombie but the process is still running. Don't auto-kill;
	// a human or higher-tier agent should decide.
	if (session.state === "zombie") {
		return {
			...base,
			processAlive: true,
			state: "zombie",
			action: "investigate",
			reconciliationNote:
				"ZFC: tmux alive but sessions.json says zombie — investigation needed (don't auto-kill)",
		};
	}

	// ZFC Rule 3: pid dead but tmux alive → the agent process exited but the
	// tmux pane shell survived. The agent is not doing work.
	if (pidAlive === false) {
		return {
			...base,
			processAlive: false,
			state: "zombie",
			action: "terminate",
			reconciliationNote: `ZFC: pid ${session.pid} dead but tmux alive — agent process exited, shell survived`,
		};
	}

	// Time-based checks (both tmux and pid confirmed alive, or pid unavailable)
	return evaluateTimeBased(session, base, elapsedMs, thresholds);
}

/**
 * Compute the next agent state based on a health check.
 *
 * State transitions are strictly forward-only using the ordering:
 *   booting(0) → working(1) → stalled(2) → zombie(3)
 *
 * A state can only advance forward, never move backwards.
 * For example, a zombie can never become working again.
 *
 * Exception (ZFC): When the health check action is "investigate", the state
 * is NOT advanced. This allows a human or higher-tier agent to review the
 * conflicting signals before making a state change.
 *
 * @param currentState - The agent's current state
 * @param check - The latest health check result
 * @returns The new state (always >= currentState in ordering)
 */
export function transitionState(currentState: AgentState, check: HealthCheck): AgentState {
	// ZFC: investigate means signals conflict — hold state until reviewed
	if (check.action === "investigate") {
		return currentState;
	}

	// `complete` is a terminal classification triggered when observable state
	// proves the agent finished naturally (missed session-end signal —
	// overstory-e74b). It bypasses the forward-only STATE_ORDER guard because
	// `completed` (order 2) sits before `stalled` (order 3) and would
	// otherwise be blocked from advancing the recorded state. The matrix in
	// SessionStore.tryTransitionState still gates the actual write.
	if (check.action === "complete") {
		return check.state;
	}

	const currentOrder = STATE_ORDER[currentState];
	const checkOrder = STATE_ORDER[check.state];

	// Only move forward — never regress
	if (checkOrder > currentOrder) {
		return check.state;
	}

	return currentState;
}

/**
 * Tier 0 mechanical process monitoring daemon.
 *
 * Runs on a configurable interval, checking the health of all active agent
 * sessions. Implements progressive nudging for stalled agents instead of
 * immediately escalating to AI triage:
 *
 *   Level 0 (warn):      Log warning via onHealthCheck callback, no direct action
 *   Level 1 (nudge):     Send tmux nudge via nudgeAgent()
 *   Level 2 (escalate):  Invoke Tier 1 AI triage (if tier1Enabled), else skip
 *   Level 3 (terminate): Kill tmux session
 *
 * Phase 4 tier numbering:
 *   Tier 0 = Mechanical daemon (this file)
 *   Tier 1 = Triage agent (triage.ts)
 *   Tier 2 = Monitor agent (not yet implemented)
 *   Tier 3 = Supervisor monitors (per-project)
 *
 * ZFC Principle: Observable state (tmux alive, pid alive) is the source of
 * truth. See health.ts for the full ZFC documentation.
 */

import { join } from "node:path";
import { isPersistentCapability } from "../agents/capabilities.ts";
import { nudgeAgent } from "../commands/nudge.ts";
import { createEventStore } from "../events/store.ts";
import {
	findLatestStdoutLog,
	startEventTailer,
	type TailerHandle,
	type TailerOptions,
} from "../events/tailer.ts";
import { createMailStore, type MailStore } from "../mail/store.ts";
import { createMulchClient } from "../mulch/client.ts";
import { getConnection, removeConnection } from "../runtimes/connections.ts";
import type { RuntimeConnection } from "../runtimes/types.ts";
import { openSessionStore } from "../sessions/compat.ts";
import { createRunStore } from "../sessions/store.ts";
import type {
	AgentSession,
	EventStore,
	HealthCheck,
	RunStore,
	WorkerDiedPayload,
} from "../types.ts";
import { isProcessAlive, isSessionAlive, killProcessTree, killSession } from "../worktree/tmux.ts";
import { evaluateHealth, transitionState } from "./health.ts";
import { type TriageResult, triageAgent } from "./triage.ts";

/** Maximum escalation level (terminate). */
const MAX_ESCALATION_LEVEL = 3;

/**
 * Module-level registry of active event tailers for headless agents.
 * Maps agentName → TailerHandle. Persists across daemon ticks so tailers
 * survive between tick invocations. Overridable via DaemonOptions._tailerRegistry.
 */
const _defaultTailerRegistry: Map<string, TailerHandle> = new Map();

/**
 * Per-cause dedup state for `current-run.txt` defensive-read warnings
 * (overstory-87bf). The watchdog reads `.overstory/current-run.txt` once per
 * tick to gate run-completion checks; if the file is missing/empty/unreadable
 * or points to an id with no row in the runs table, the check would silently
 * skip every tick. We log one warning per cause and then continue skipping
 * silently, so an operator can see the run-completion path is wedged without
 * drowning in repeated lines.
 *
 * Module-level by design: warnings should dedupe across ticks within one
 * watchdog process. Overridable via DaemonOptions._runIdWarnState in tests.
 */
export interface RunIdWarnState {
	missingFileWarned: boolean;
	unknownIds: Set<string>;
}

const _defaultRunIdWarnState: RunIdWarnState = {
	missingFileWarned: false,
	unknownIds: new Set(),
};

/**
 * Record an agent failure to mulch for future reference.
 * Fire-and-forget: never throws, logs errors internally if mulch fails.
 *
 * @param root - Project root directory
 * @param session - The agent session that failed
 * @param reason - Human-readable failure reason
 * @param tier - Which watchdog tier detected the failure (0 or 1)
 * @param triageSuggestion - Optional triage verdict from Tier 1 AI analysis
 */
async function recordFailure(
	root: string,
	session: AgentSession,
	reason: string,
	tier: 0 | 1,
	triageSuggestion?: string,
): Promise<void> {
	try {
		const mulch = createMulchClient(root);
		const tierLabel = tier === 0 ? "Tier 0 (process death)" : "Tier 1 (AI triage)";
		const description = [
			`Agent: ${session.agentName}`,
			`Capability: ${session.capability}`,
			`Failure reason: ${reason}`,
			triageSuggestion ? `Triage suggestion: ${triageSuggestion}` : null,
			`Detected by: ${tierLabel}`,
		]
			.filter((line) => line !== null)
			.join("\n");

		await mulch.record("agents", {
			type: "failure",
			description,
			tags: ["watchdog", "auto-recorded"],
			evidenceBead: session.taskId || undefined,
		});
	} catch {
		// Fire-and-forget: recording failures must not break the watchdog
	}
}

/**
 * Read the current run ID from current-run.txt, or null if no active run.
 * Async because it uses Bun.file().
 */
async function readCurrentRunId(overstoryDir: string): Promise<string | null> {
	const path = join(overstoryDir, "current-run.txt");
	const file = Bun.file(path);
	if (!(await file.exists())) {
		return null;
	}
	try {
		const text = await file.text();
		const trimmed = text.trim();
		return trimmed.length > 0 ? trimmed : null;
	} catch {
		return null;
	}
}

/**
 * Resolve the active run id for run-completion checks, defensively
 * (overstory-87bf). Returns the id only when `current-run.txt` is readable
 * AND points to a row in the runs table. On either failure mode, logs one
 * warning per cause via `warnState` and returns null so the caller can skip
 * the check silently on subsequent ticks.
 *
 * Intentionally narrow: the broader `readCurrentRunId` is unchanged and still
 * powers event-recording paths where a stale id is acceptable as a label.
 */
async function resolveRunIdForCompletionCheck(
	overstoryDir: string,
	runStore: RunStore | null,
	warnState: RunIdWarnState,
): Promise<string | null> {
	const runId = await readCurrentRunId(overstoryDir);
	if (runId === null) {
		if (!warnState.missingFileWarned) {
			warnState.missingFileWarned = true;
			process.stderr.write(
				"[WATCHDOG] current-run.txt missing — run-completion checks disabled until restart\n",
			);
		}
		return null;
	}
	if (runStore === null) {
		// RunStore unavailable (rare — sessions.db open failed). Trust the file
		// and let the downstream nudge path proceed; this is no worse than the
		// pre-87bf behavior.
		return runId;
	}
	let run: ReturnType<RunStore["getRun"]>;
	try {
		run = runStore.getRun(runId);
	} catch {
		// Treat lookup errors as "unknown" — same defensive posture as a missing row.
		run = null;
	}
	if (run === null) {
		if (!warnState.unknownIds.has(runId)) {
			warnState.unknownIds.add(runId);
			process.stderr.write(
				`[WATCHDOG] current-run.txt points to unknown run "${runId}" — run-completion checks disabled until restart\n`,
			);
		}
		return null;
	}
	return runId;
}

/**
 * Fire-and-forget: record an event to EventStore. Never throws.
 */
function recordEvent(
	eventStore: EventStore | null,
	event: {
		runId: string | null;
		agentName: string;
		eventType: "custom" | "mail_sent";
		level: "debug" | "info" | "warn" | "error";
		data: Record<string, unknown>;
	},
): void {
	if (!eventStore) return;
	try {
		eventStore.insert({
			runId: event.runId,
			agentName: event.agentName,
			sessionId: null,
			eventType: event.eventType,
			toolName: null,
			toolArgs: null,
			toolDurationMs: null,
			level: event.level,
			data: JSON.stringify(event.data),
		});
	} catch {
		// Fire-and-forget: event recording must never break the daemon
	}
}

/**
 * Build a phase-aware completion message based on the capabilities of terminal workers.
 *
 * "Terminal" includes both `completed` (clean exit) and `zombie` (watchdog-killed)
 * — see overstory-e130 for why a zombie counts as run-terminal. Single-capability
 * batches get targeted messages (e.g. scouts → "Ready for next phase"), while
 * mixed-capability batches get a generic summary with a breakdown. When any worker
 * died, the verb changes from "have completed" to "have terminated" and the message
 * carries a "(N completed, M zombie)" qualifier so the coordinator does not mistake
 * a partial failure for a clean batch.
 */
export function buildCompletionMessage(
	workerSessions: readonly AgentSession[],
	runId: string,
): string {
	const capabilities = new Set(workerSessions.map((s) => s.capability));
	const count = workerSessions.length;
	const zombieCount = workerSessions.filter((s) => s.state === "zombie").length;
	const completedCount = count - zombieCount;
	const verb = zombieCount > 0 ? "have terminated" : "have completed";
	const qualifier = zombieCount > 0 ? ` (${completedCount} completed, ${zombieCount} zombie)` : "";

	if (capabilities.size === 1) {
		if (capabilities.has("scout")) {
			return `[WATCHDOG] All ${count} scout(s) in run ${runId} ${verb}${qualifier}. Ready for next phase.`;
		}
		if (capabilities.has("builder")) {
			return `[WATCHDOG] All ${count} builder(s) in run ${runId} ${verb}${qualifier}. Awaiting lead verification.`;
		}
		if (capabilities.has("reviewer")) {
			return `[WATCHDOG] All ${count} reviewer(s) in run ${runId} ${verb}${qualifier}. Reviews done.`;
		}
		if (capabilities.has("lead")) {
			return `[WATCHDOG] All ${count} lead(s) in run ${runId} ${verb}${qualifier}. Ready for merge/cleanup.`;
		}
		if (capabilities.has("merger")) {
			return `[WATCHDOG] All ${count} merger(s) in run ${runId} ${verb}${qualifier}. Merges done.`;
		}
	}

	const breakdown = Array.from(capabilities).sort().join(", ");
	return `[WATCHDOG] All ${count} worker(s) in run ${runId} ${verb}${qualifier} (${breakdown}). Ready for next steps.`;
}

/**
 * Check if every worker session for the active run has reached a terminal state
 * (`completed` or `zombie`), and if so, nudge the coordinator. Fire-and-forget:
 * never throws.
 *
 * Zombie counts as terminal (overstory-e130): a watchdog-killed worker is not
 * coming back, so excluding it would strand the coordinator on a run that mixes
 * clean exits with kills.
 *
 * Deduplication: uses a marker file (run-complete-notified.txt) to prevent
 * repeated nudges for the same run ID.
 */
async function checkRunCompletion(ctx: {
	store: { getByRun: (runId: string) => AgentSession[] };
	runId: string;
	overstoryDir: string;
	root: string;
	nudge: (
		projectRoot: string,
		agentName: string,
		message: string,
		force: boolean,
	) => Promise<{ delivered: boolean; reason?: string }>;
	eventStore: EventStore | null;
}): Promise<void> {
	const { store, runId, overstoryDir, root, nudge, eventStore } = ctx;

	const runSessions = store.getByRun(runId);
	const workerSessions = runSessions.filter((s) => !isPersistentCapability(s.capability));

	if (workerSessions.length === 0) {
		return;
	}

	// `completed` = clean exit, `zombie` = watchdog-killed. Both are terminal
	// for run-completion: a zombie is not coming back, so blocking on it would
	// strand the coordinator forever (overstory-e130).
	const allTerminal = workerSessions.every((s) => s.state === "completed" || s.state === "zombie");
	if (!allTerminal) {
		return;
	}

	// Dedup: check marker file
	const markerPath = join(overstoryDir, "run-complete-notified.txt");
	try {
		const file = Bun.file(markerPath);
		if (await file.exists()) {
			const existing = await file.text();
			if (existing.trim() === runId) {
				return; // Already notified
			}
		}
	} catch {
		// Read failure is non-fatal — proceed with nudge
	}

	// Nudge the coordinator
	const message = buildCompletionMessage(workerSessions, runId);
	try {
		await nudge(root, "coordinator", message, true);
	} catch {
		// Nudge delivery failure is non-fatal
	}

	// Record the event
	const capabilitiesArr = Array.from(new Set(workerSessions.map((s) => s.capability))).sort();
	const phase = capabilitiesArr.length === 1 ? capabilitiesArr[0] : "mixed";
	const completedAgents = workerSessions
		.filter((s) => s.state === "completed")
		.map((s) => s.agentName);
	const zombieAgents = workerSessions.filter((s) => s.state === "zombie").map((s) => s.agentName);
	recordEvent(eventStore, {
		runId,
		agentName: "watchdog",
		eventType: "custom",
		level: zombieAgents.length > 0 ? "warn" : "info",
		data: {
			type: "run_complete",
			workerCount: workerSessions.length,
			completedAgents,
			zombieAgents,
			capabilities: capabilitiesArr,
			phase,
		},
	});

	// Write dedup marker
	try {
		await Bun.write(markerPath, runId);
	} catch {
		// Marker write failure is non-fatal
	}
}

/** Options shared between startDaemon and runDaemonTick. */
export interface DaemonOptions {
	root: string;
	staleThresholdMs: number;
	zombieThresholdMs: number;
	nudgeIntervalMs?: number;
	tier1Enabled?: boolean;
	/**
	 * When true (default), the watchdog sends a synthetic `worker_died` mail to
	 * `session.parentAgent` the first time it transitions a session to `zombie`
	 * (overstory-c111). Without this, the parent — typically a lead waiting for
	 * `worker_done` — blocks indefinitely on mail that will never arrive.
	 */
	notifyParentOnDeath?: boolean;
	onHealthCheck?: (check: HealthCheck) => void;
	/** Dependency injection for testing. Uses real implementations when omitted. */
	_tmux?: {
		isSessionAlive: (name: string) => Promise<boolean>;
		killSession: (name: string) => Promise<void>;
	};
	/** Dependency injection for testing. Uses real triageAgent when omitted. */
	_triage?: (options: {
		agentName: string;
		root: string;
		lastActivity: string;
	}) => Promise<TriageResult | "retry" | "terminate" | "extend">;
	/** Max triage calls per daemon tick (prevents runaway AI usage). Default: 3. */
	_maxTriagePerTick?: number;
	/** Dependency injection for testing. Uses real nudgeAgent when omitted. */
	_nudge?: (
		projectRoot: string,
		agentName: string,
		message: string,
		force: boolean,
	) => Promise<{ delivered: boolean; reason?: string }>;
	/** Dependency injection for testing. Uses real isProcessAlive/killProcessTree when omitted. */
	_process?: {
		isAlive: (pid: number) => boolean;
		killTree: (pid: number) => Promise<void>;
	};
	/** Dependency injection for testing. Overrides EventStore creation. */
	_eventStore?: EventStore | null;
	/** Dependency injection for testing. Uses real recordFailure when omitted. */
	_recordFailure?: (
		root: string,
		session: AgentSession,
		reason: string,
		tier: 0 | 1,
		triageSuggestion?: string,
	) => Promise<void>;
	/** Dependency injection for testing. Uses real getConnection when omitted. */
	_getConnection?: (name: string) => RuntimeConnection | undefined;
	/** Dependency injection for testing. Uses real removeConnection when omitted. */
	_removeConnection?: (name: string) => void;
	/** Dependency injection for testing. Uses _defaultTailerRegistry when omitted. */
	_tailerRegistry?: Map<string, TailerHandle>;
	/** Dependency injection for testing. Uses startEventTailer when omitted. */
	_tailerFactory?: (opts: TailerOptions) => TailerHandle;
	/** Dependency injection for testing. Uses findLatestStdoutLog when omitted. */
	_findLatestStdoutLog?: (overstoryDir: string, agentName: string) => Promise<string | null>;
	/** Dependency injection for testing. Overrides MailStore creation for decision gate detection. */
	_mailStore?: MailStore | null;
	/**
	 * Dependency injection for testing. Overrides the module-level run-id warning
	 * state so each test starts with a clean dedup slate (overstory-87bf).
	 */
	_runIdWarnState?: RunIdWarnState;
	/**
	 * Dependency injection for testing. Overrides RunStore creation. When `null`
	 * is passed explicitly, run-id validation is skipped (file presence still
	 * gates the warning). When omitted, a real RunStore is opened against
	 * `.overstory/sessions.db`.
	 */
	_runStore?: RunStore | null;
}

/**
 * Start the watchdog daemon that periodically monitors agent health.
 *
 * On each tick:
 * 1. Loads sessions from SessionStore (sessions.db)
 * 2. For each session (including zombies — ZFC requires re-checking observable
 *    state), checks tmux liveness and evaluates health
 * 3. For "terminate" actions: kills tmux session immediately
 * 4. For "investigate" actions: surfaces via onHealthCheck, no auto-kill
 * 5. For "escalate" actions: applies progressive nudging based on escalationLevel
 * 6. Persists updated session states back to SessionStore
 *
 * @param options.root - Project root directory (contains .overstory/)
 * @param options.intervalMs - Polling interval in milliseconds
 * @param options.staleThresholdMs - Time after which an agent is considered stale
 * @param options.zombieThresholdMs - Time after which an agent is considered a zombie
 * @param options.nudgeIntervalMs - Time between progressive nudge stage transitions (default 60000)
 * @param options.tier1Enabled - Whether Tier 1 AI triage is enabled (default false)
 * @param options.onHealthCheck - Optional callback for each health check result
 * @returns An object with a `stop` function to halt the daemon
 */
export function startDaemon(options: DaemonOptions & { intervalMs: number }): { stop: () => void } {
	const { intervalMs } = options;
	const tailerRegistry = options._tailerRegistry ?? _defaultTailerRegistry;

	// Run the first tick immediately, then on interval
	runDaemonTick(options).catch(() => {
		// Swallow errors in the first tick — daemon must not crash
	});

	const interval = setInterval(() => {
		runDaemonTick(options).catch(() => {
			// Swallow errors in periodic ticks — daemon must not crash
		});
	}, intervalMs);

	return {
		stop(): void {
			clearInterval(interval);
			for (const [name, handle] of tailerRegistry) {
				handle.stop();
				tailerRegistry.delete(name);
			}
		},
	};
}

/**
 * Kill an agent using the appropriate method based on whether it is headless or TUI.
 *
 * Prefers runtime-agnostic `conn.abort()` when a RuntimeConnection is registered.
 * If abort() succeeds, returns immediately — no PID/tmux kill needed.
 * If abort() throws (e.g. process already exited), falls through to the
 * defense-in-depth path below.
 *
 * Branching after abort:
 *   - tmuxSession === "" (headless): never call tmux.killSession — an empty `-t`
 *     prefix-matches every session in the tmux server, wildcard-killing the entire
 *     overstory swarm (overstory-74ce). Branch by pid:
 *       - pid !== null  → kill the process tree (long-lived headless capability).
 *       - pid === null  → no-op (spawn-per-turn agent between turns; the in-flight
 *         process, if any, was already handled by the abort/connection path).
 *   - tmuxSession !== "" (TUI): kill the named tmux session, but only when
 *     `tmuxAlive` to avoid spurious "session not found" errors.
 */
async function killAgent(ctx: {
	session: AgentSession;
	tmuxAlive: boolean;
	tmux: { killSession: (name: string) => Promise<void> };
	process: { killTree: (pid: number) => Promise<void> };
	getConnection: (name: string) => RuntimeConnection | undefined;
	removeConnection: (name: string) => void;
}): Promise<void> {
	const { session, tmuxAlive, tmux, process: proc, getConnection, removeConnection } = ctx;

	// Prefer runtime-agnostic abort() when a connection is registered.
	const conn = getConnection(session.agentName);
	if (conn) {
		let aborted = false;
		try {
			await conn.abort();
			aborted = true;
		} catch {
			// abort() failure — fall through to defense-in-depth path
		}
		removeConnection(session.agentName);
		if (aborted) {
			return;
		}
		// abort() threw — fall through to PID/tmux kill below as defense-in-depth
	}

	// Headless agents (no tmux session) must never reach tmux.killSession.
	// An empty `-t` argument is prefix-matched and would kill every overstory
	// tmux session in the server (overstory-74ce).
	if (session.tmuxSession === "") {
		if (session.pid !== null) {
			try {
				await proc.killTree(session.pid);
			} catch {
				// Already exited — not an error
			}
		}
		// pid === null: spawn-per-turn agent between turns. Any in-flight process
		// was handled by abort/connection above. No-op — next dispatch will spawn fresh.
		return;
	}

	// Named tmux session path (TUI agents).
	if (tmuxAlive) {
		try {
			await tmux.killSession(session.tmuxSession);
		} catch {
			// Session may have died between check and kill — not an error
		}
	}
}

/**
 * Send a synthetic `worker_died` mail to the parent of a watchdog-terminated
 * session (overstory-c111). Fire-and-forget: never throws.
 *
 * Called only when `tryTransitionState(..., "zombie")` returns `ok: true`, so
 * the state-machine's idempotence dedupes us — a subsequent watchdog tick that
 * tries to re-zombify a session sees `illegal_transition` and skips notify.
 */
function notifyParentOfDeath(ctx: {
	session: AgentSession;
	mailStore: MailStore | null;
	reason: string;
	tier: 0 | 1;
	eventStore: EventStore | null;
	runId: string | null;
}): void {
	const { session, mailStore, reason, tier, eventStore, runId } = ctx;
	if (mailStore === null) return;
	if (session.parentAgent === null) return;

	const payload: WorkerDiedPayload = {
		agentName: session.agentName,
		capability: session.capability,
		taskId: session.taskId,
		reason,
		lastActivity: session.lastActivity,
		terminatedBy: tier === 0 ? "tier0" : "tier1",
	};

	try {
		mailStore.insert({
			id: "",
			from: session.agentName,
			to: session.parentAgent,
			subject: `[WATCHDOG] worker_died: ${session.agentName}`,
			body:
				`Worker "${session.agentName}" (${session.capability}) on task ${session.taskId} ` +
				`was terminated by the watchdog. Reason: ${reason}. ` +
				`Last activity: ${session.lastActivity}. ` +
				`Decide whether to retry the work, escalate, or report the failure upstream.`,
			type: "worker_died",
			priority: "high",
			threadId: null,
			payload: JSON.stringify(payload),
		});
	} catch {
		// Mail-send failure must never crash the watchdog.
		return;
	}

	recordEvent(eventStore, {
		runId,
		agentName: session.agentName,
		eventType: "mail_sent",
		level: "warn",
		data: {
			type: "worker_died",
			parent: session.parentAgent,
			reason,
			tier,
		},
	});
}

/**
 * Run a single daemon tick. Exported for testing — allows direct invocation
 * of the monitoring logic without starting the interval-based daemon loop.
 *
 * @param options - Same options as startDaemon (minus intervalMs)
 */
export async function runDaemonTick(options: DaemonOptions): Promise<void> {
	const {
		root,
		staleThresholdMs,
		zombieThresholdMs,
		nudgeIntervalMs = 60_000,
		tier1Enabled = false,
		notifyParentOnDeath = true,
		onHealthCheck,
	} = options;
	const tmux = options._tmux ?? { isSessionAlive, killSession };
	const proc = options._process ?? { isAlive: isProcessAlive, killTree: killProcessTree };
	const triage = options._triage ?? triageAgent;
	const nudge = options._nudge ?? nudgeAgent;
	const recordFailureFn = options._recordFailure ?? recordFailure;
	const getConn = options._getConnection ?? getConnection;
	const removeConn = options._removeConnection ?? removeConnection;
	const tailerRegistry = options._tailerRegistry ?? _defaultTailerRegistry;
	const tailerFactory = options._tailerFactory ?? startEventTailer;
	const findStdoutLog = options._findLatestStdoutLog ?? findLatestStdoutLog;
	const maxTriagePerTick = options._maxTriagePerTick ?? 3;
	const triageCount = { value: 0 };
	const runIdWarnState = options._runIdWarnState ?? _defaultRunIdWarnState;

	const overstoryDir = join(root, ".overstory");
	const { store } = openSessionStore(overstoryDir);

	// Open RunStore for run-id validation (overstory-87bf). Sharing sessions.db
	// is intentional — same file, WAL mode covers concurrent reads.
	let runStore: RunStore | null = null;
	let ownRunStore = false;
	if (options._runStore !== undefined) {
		runStore = options._runStore;
	} else {
		try {
			runStore = createRunStore(join(overstoryDir, "sessions.db"));
			ownRunStore = true;
		} catch {
			// RunStore creation failure is non-fatal — id validation is then skipped.
		}
	}

	// Open MailStore for decision gate detection (fire-and-forget: non-fatal if unavailable)
	let mailStore: MailStore | null = null;
	let ownMailStore = false;
	if (options._mailStore !== undefined) {
		mailStore = options._mailStore;
	} else {
		try {
			mailStore = createMailStore(join(overstoryDir, "mail.db"));
			ownMailStore = true;
		} catch {
			// MailStore creation failure is non-fatal — decision gate detection will be skipped
		}
	}

	// Open EventStore for recording daemon events (fire-and-forget)
	let eventStore: EventStore | null = null;
	let runId: string | null = null;
	const useInjectedEventStore = options._eventStore !== undefined;
	if (useInjectedEventStore) {
		eventStore = options._eventStore ?? null;
	} else {
		try {
			const eventsDbPath = join(overstoryDir, "events.db");
			eventStore = createEventStore(eventsDbPath);
		} catch {
			// EventStore creation failure is non-fatal for the daemon
		}
	}
	try {
		runId = await readCurrentRunId(overstoryDir);
	} catch {
		// Reading run ID failure is non-fatal
	}

	try {
		const thresholds = {
			staleMs: staleThresholdMs,
			zombieMs: zombieThresholdMs,
		};

		const sessions = store.getAll();

		// Track active headless agents to clean up stale tailers after the loop.
		const activeHeadlessAgents = new Set<string>();
		const eventsDbPath = join(overstoryDir, "events.db");
		const sessionsDbPath = join(overstoryDir, "sessions.db");

		for (const session of sessions) {
			// Skip completed sessions — they are terminal and don't need monitoring
			if (session.state === "completed") {
				continue;
			}

			// ZFC: Don't skip zombies. Re-check tmux liveness on every tick.
			// A zombie with a live tmux session needs investigation, not silence.

			// Event tailer management: start a background NDJSON tailer for each
			// active headless agent that doesn't already have one running.
			// Tailers persist between ticks (module-level registry) so events are
			// continuously written to events.db while the agent is working.
			//
			// Both long-lived headless (pid !== null) and spawn-per-turn workers
			// (pid === null, overstory-7a34) emit stream-json to stdout.log, so
			// either pattern needs a tailer.
			if (session.tmuxSession === "") {
				activeHeadlessAgents.add(session.agentName);
				if (!tailerRegistry.has(session.agentName)) {
					// Discover the latest stdout.log for this agent and start tailing.
					const logPath = await findStdoutLog(overstoryDir, session.agentName);
					if (logPath) {
						const handle = tailerFactory({
							stdoutLogPath: logPath,
							agentName: session.agentName,
							runId,
							eventsDbPath,
							sessionsDbPath,
						});
						tailerRegistry.set(session.agentName, handle);
					}
				}
			}

			// === Liveness check ===
			// Prefer RuntimeConnection.getState() when a connection is registered. Fall
			// back to tmux liveness when no connection exists. For headless agents without
			// a connection, use event-based activity detection to refresh lastActivity.
			const conn = getConn(session.agentName);
			let tmuxAlive: boolean;

			if (conn) {
				try {
					const state = await Promise.race([
						conn.getState(),
						new Promise<never>((_, reject) =>
							setTimeout(() => reject(new Error("getState timed out")), 5000),
						),
					]);
					// Map ConnectionState → liveness:
					//   idle | working → alive (running)
					//   error          → not alive (exited)
					if (state.status === "idle" || state.status === "working") {
						tmuxAlive = true;
						store.updateLastActivity(session.agentName);
						session.lastActivity = new Date().toISOString();
					} else {
						tmuxAlive = false;
					}
				} catch {
					// getState() failed/timed out — drop stale connection, fall back to tmux
					removeConn(session.agentName);
					tmuxAlive = await tmux.isSessionAlive(session.tmuxSession);
				}
			} else {
				tmuxAlive = await tmux.isSessionAlive(session.tmuxSession);

				// Headless agents without a registered connection: event-based
				// activity detection to avoid false-positive stale. Covers both
				// long-lived headless (e.g. after a process restart) and
				// spawn-per-turn workers between turns where lastActivity is
				// the only liveness signal (overstory-7a34).
				if (session.tmuxSession === "" && eventStore) {
					try {
						const recentEvents = eventStore.getByAgent(session.agentName, {
							since: new Date(Date.now() - staleThresholdMs).toISOString(),
							limit: 1,
						});
						if (recentEvents.length > 0) {
							store.updateLastActivity(session.agentName);
							session.lastActivity = new Date().toISOString();
						}
					} catch {
						// Non-fatal: event store query failure should not affect monitoring
					}
				}
			}
			const check = evaluateHealth(session, tmuxAlive, thresholds);

			// Snapshot the pre-tick state so the worker_died notify path can
			// dedupe across re-ticks (overstory-c111). Subsequent `tryTransitionState`
			// calls below mutate session.state, and the matrix allows the idempotent
			// `zombie → zombie` self-transition — both would erase the dedup signal.
			const stateBeforeTick = session.state;

			// Transition state forward only (investigate action holds state).
			// `transitionState` computes the watchdog's preferred target;
			// `tryTransitionState` is the matrix-guarded CAS — `completed → *`
			// is rejected here so a properly-completed agent cannot be
			// reclassified as zombie by a late watchdog tick (overstory-a993).
			const newState = transitionState(session.state, check);
			if (newState !== session.state) {
				const outcome = store.tryTransitionState(session.agentName, newState);
				if (outcome.ok) {
					session.state = newState;
				} else if (outcome.reason === "illegal_transition") {
					// Resync local mirror — another writer settled state durably.
					session.state = outcome.prev;
				}
			}

			if (onHealthCheck) {
				onHealthCheck(check);
			}

			if (check.action === "terminate") {
				// Record the failure via mulch (Tier 0 detection)
				const reason = check.reconciliationNote ?? "Process terminated";
				await recordFailureFn(root, session, reason, 0);

				// Kill the agent: prefer conn.abort(), fall back to PID/tmux
				await killAgent({
					session,
					tmuxAlive,
					tmux,
					process: proc,
					getConnection: getConn,
					removeConnection: removeConn,
				});
				// Matrix-guarded: rejected when state is `completed` so a clean
				// `ov stop` cannot be silently downgraded to zombie by a late
				// watchdog termination (overstory-a993).
				const outcome = store.tryTransitionState(session.agentName, "zombie");
				// Reset escalation tracking on terminal state
				store.updateEscalation(session.agentName, 0, null);
				if (outcome.ok) {
					session.state = "zombie";
					// First-time zombify: notify parent so it doesn't block on
					// missing `worker_done` mail (overstory-c111). Dedup uses the
					// pre-tick snapshot because the matrix allows the idempotent
					// zombie → zombie transition (both `outcome.ok` and the earlier
					// transitionState call would otherwise mask re-ticks).
					if (notifyParentOnDeath && stateBeforeTick !== "zombie") {
						notifyParentOfDeath({
							session,
							mailStore,
							reason,
							tier: 0,
							eventStore,
							runId,
						});
					}
				} else if (outcome.reason === "illegal_transition") {
					session.state = outcome.prev;
				}
				session.escalationLevel = 0;
				session.stalledSince = null;
			} else if (check.action === "investigate") {
				// ZFC: tmux alive but SessionStore says zombie.
				// Log the conflict but do NOT auto-kill.
				// The onHealthCheck callback surfaces this to the operator.
				// No state change — keep zombie until a human or higher-tier agent decides.
			} else if (check.action === "complete") {
				// ZFC fallback: tmux/pid is gone AND lastActivity is stale —
				// the agent looks like it finished naturally and only the
				// session-end hook missed (overstory-e74b). Mark completed
				// without killing (process is already gone) and without
				// notifying parents of death (this is not a crash).
				const outcome = store.tryTransitionState(session.agentName, "completed");
				if (outcome.ok) {
					session.state = "completed";
				} else if (outcome.reason === "illegal_transition") {
					session.state = outcome.prev;
				}
				store.updateEscalation(session.agentName, 0, null);
				session.escalationLevel = 0;
				session.stalledSince = null;
			} else if (check.action === "escalate") {
				// Decision gate check: if the agent sent a decision_gate message, it is
				// intentionally paused waiting for a human decision — not a stall.
				// Skip watchdog escalation and clear any accumulated stall state.
				if (mailStore !== null) {
					const recentMail = mailStore.getAll({ from: session.agentName, limit: 20 });
					const hasPendingDecisionGate = recentMail.some((m) => m.type === "decision_gate");
					if (hasPendingDecisionGate) {
						if (session.stalledSince !== null) {
							store.updateEscalation(session.agentName, 0, null);
							session.stalledSince = null;
							session.escalationLevel = 0;
						}
						continue;
					}
				}

				// Progressive nudging: increment escalation level based on elapsed time
				// instead of immediately delegating to AI triage.

				// Initialize stalledSince on first escalation detection
				if (session.stalledSince === null) {
					session.stalledSince = new Date().toISOString();
					session.escalationLevel = 0;
					store.updateEscalation(session.agentName, 0, session.stalledSince);
				}

				// Check if enough time has passed to advance to the next escalation level
				const stalledMs = Date.now() - new Date(session.stalledSince).getTime();
				const expectedLevel = Math.min(
					Math.floor(stalledMs / nudgeIntervalMs),
					MAX_ESCALATION_LEVEL,
				);

				if (expectedLevel > session.escalationLevel) {
					session.escalationLevel = expectedLevel;
					store.updateEscalation(session.agentName, expectedLevel, session.stalledSince);
				}

				// Execute the action for the current escalation level
				const actionResult = await executeEscalationAction({
					session,
					root,
					tmuxAlive,
					tier1Enabled,
					tmux,
					process: proc,
					triage,
					nudge,
					eventStore,
					runId,
					recordFailure: recordFailureFn,
					triageCount,
					maxTriagePerTick,
					getConnection: getConn,
					removeConnection: removeConn,
				});

				if (actionResult.terminated) {
					// Matrix-guarded: completed → zombie is rejected (overstory-a993).
					const outcome = store.tryTransitionState(session.agentName, "zombie");
					store.updateEscalation(session.agentName, 0, null);
					if (outcome.ok) {
						session.state = "zombie";
						// First-time zombify: notify parent so it doesn't block on
						// missing `worker_done` mail (overstory-c111). Dedup via
						// the pre-tick snapshot — see the terminate branch above.
						if (notifyParentOnDeath && stateBeforeTick !== "zombie") {
							notifyParentOfDeath({
								session,
								mailStore,
								reason: actionResult.deathReason ?? "Watchdog escalation terminated agent",
								tier: actionResult.deathTier ?? 0,
								eventStore,
								runId,
							});
						}
					} else if (outcome.reason === "illegal_transition") {
						session.state = outcome.prev;
					}
					session.escalationLevel = 0;
					session.stalledSince = null;
				}
			} else if (check.action === "none" && session.stalledSince !== null) {
				// Agent recovered — reset escalation tracking
				store.updateEscalation(session.agentName, 0, null);
				session.stalledSince = null;
				session.escalationLevel = 0;
			}
		}

		// === Tailer cleanup ===
		// Stop tailers for any headless agent that is no longer in the active set
		// (i.e. completed, removed from store, or was never a headless agent).
		for (const [name, handle] of tailerRegistry) {
			if (!activeHeadlessAgents.has(name)) {
				handle.stop();
				tailerRegistry.delete(name);
			}
		}

		// === Run-level completion detection ===
		// After monitoring individual sessions, check if the entire run is done.
		// Re-resolve the run id defensively (overstory-87bf): a missing
		// current-run.txt or a stale id (no row in runs table) skips the check
		// and emits one warning per cause for the lifetime of this watchdog.
		const validatedRunId = await resolveRunIdForCompletionCheck(
			overstoryDir,
			runStore,
			runIdWarnState,
		);
		if (validatedRunId) {
			await checkRunCompletion({
				store,
				runId: validatedRunId,
				overstoryDir,
				root,
				nudge,
				eventStore,
			});
		}
	} finally {
		store.close();
		// Close MailStore only if we created it (not injected)
		if (mailStore && ownMailStore) {
			try {
				mailStore.close();
			} catch {
				// Non-fatal
			}
		}
		// Close EventStore only if we created it (not injected)
		if (eventStore && !useInjectedEventStore) {
			try {
				eventStore.close();
			} catch {
				// Non-fatal
			}
		}
		// Close RunStore only if we created it (not injected)
		if (runStore && ownRunStore) {
			try {
				runStore.close();
			} catch {
				// Non-fatal
			}
		}
	}
}

/**
 * Execute the escalation action corresponding to the agent's current escalation level.
 *
 * Level 0 (warn):      No direct action — onHealthCheck callback already fired above.
 * Level 1 (nudge):     Send a tmux nudge to the agent.
 * Level 2 (escalate):  Invoke Tier 1 AI triage (if tier1Enabled; skip otherwise).
 * Level 3 (terminate): Kill the tmux session.
 *
 * @returns Object indicating whether the agent was terminated or state changed.
 */
async function executeEscalationAction(ctx: {
	session: AgentSession;
	root: string;
	tmuxAlive: boolean;
	tier1Enabled: boolean;
	tmux: {
		isSessionAlive: (name: string) => Promise<boolean>;
		killSession: (name: string) => Promise<void>;
	};
	process: {
		killTree: (pid: number) => Promise<void>;
	};
	triage: (options: {
		agentName: string;
		root: string;
		lastActivity: string;
	}) => Promise<TriageResult | "retry" | "terminate" | "extend">;
	/** Shared counter across escalation calls in a single tick — enforces maxTriagePerTick. */
	triageCount: { value: number };
	/** Maximum number of triage calls allowed in one daemon tick. Default: 3. */
	maxTriagePerTick: number;
	nudge: (
		projectRoot: string,
		agentName: string,
		message: string,
		force: boolean,
	) => Promise<{ delivered: boolean; reason?: string }>;
	eventStore: EventStore | null;
	runId: string | null;
	recordFailure: (
		root: string,
		session: AgentSession,
		reason: string,
		tier: 0 | 1,
		triageSuggestion?: string,
	) => Promise<void>;
	getConnection: (name: string) => RuntimeConnection | undefined;
	removeConnection: (name: string) => void;
}): Promise<{
	terminated: boolean;
	stateChanged: boolean;
	/** Reason and tier of the termination (only set when `terminated` is true). */
	deathReason?: string;
	deathTier?: 0 | 1;
}> {
	const {
		session,
		root,
		tmuxAlive,
		tier1Enabled,
		tmux,
		process: proc,
		triage,
		nudge,
		eventStore,
		runId,
		recordFailure,
		triageCount,
		maxTriagePerTick,
		getConnection: getConn,
		removeConnection: removeConn,
	} = ctx;

	switch (session.escalationLevel) {
		case 0: {
			// Level 0: warn — onHealthCheck callback already fired, no direct action
			recordEvent(eventStore, {
				runId,
				agentName: session.agentName,
				eventType: "custom",
				level: "warn",
				data: { type: "escalation", escalationLevel: 0, action: "warn" },
			});
			return { terminated: false, stateChanged: false };
		}

		case 1: {
			// Level 1: nudge — send a tmux nudge to the agent
			let delivered = false;
			try {
				const result = await nudge(
					root,
					session.agentName,
					`[WATCHDOG] Agent "${session.agentName}" appears stalled. Please check your current task and report status.`,
					true, // force — skip debounce for watchdog nudges
				);
				delivered = result.delivered;
			} catch {
				// Nudge delivery failure is non-fatal for the watchdog
			}
			recordEvent(eventStore, {
				runId,
				agentName: session.agentName,
				eventType: "custom",
				level: "warn",
				data: { type: "nudge", escalationLevel: 1, delivered },
			});
			return { terminated: false, stateChanged: false };
		}

		case 2: {
			// Level 2: escalate — invoke Tier 1 AI triage if enabled
			if (!tier1Enabled) {
				// Tier 1 disabled — skip triage, progressive nudging continues to level 3
				return { terminated: false, stateChanged: false };
			}

			// Concurrency guard: limit triage calls per tick to avoid runaway AI usage
			if (triageCount.value >= maxTriagePerTick) {
				return { terminated: false, stateChanged: false };
			}
			triageCount.value++;

			const raw = await triage({
				agentName: session.agentName,
				root,
				lastActivity: session.lastActivity,
			});
			// Normalize: accept bare string (backward compat) or TriageResult
			const result: TriageResult =
				typeof raw === "string" ? { verdict: raw, fallback: false } : raw;

			recordEvent(eventStore, {
				runId,
				agentName: session.agentName,
				eventType: "custom",
				level: "warn",
				data: {
					type: "triage",
					escalationLevel: 2,
					verdict: result.verdict,
					triageFailed: result.fallback,
				},
			});

			if (result.verdict === "terminate") {
				// Record the failure via mulch (Tier 1 AI triage)
				const triageReason = "AI triage classified as terminal failure";
				await recordFailure(root, session, triageReason, 1, result.verdict);

				await killAgent({
					session,
					tmuxAlive,
					tmux,
					process: proc,
					getConnection: getConn,
					removeConnection: removeConn,
				});
				return {
					terminated: true,
					stateChanged: true,
					deathReason: triageReason,
					deathTier: 1,
				};
			}

			if (result.verdict === "retry") {
				// Send a nudge with a recovery message
				try {
					await nudge(
						root,
						session.agentName,
						"[WATCHDOG] Triage suggests recovery is possible. " +
							"Please retry your current operation or check for errors.",
						true, // force — skip debounce
					);
				} catch {
					// Nudge delivery failure is non-fatal
				}
			}

			// "retry" (after nudge) and "extend" leave the session running
			return { terminated: false, stateChanged: false };
		}

		default: {
			// Level 3+: terminate — kill the tmux session
			recordEvent(eventStore, {
				runId,
				agentName: session.agentName,
				eventType: "custom",
				level: "error",
				data: { type: "escalation", escalationLevel: 3, action: "terminate" },
			});

			// Record the failure via mulch (Tier 0: progressive escalation to terminal level)
			const escalationReason = "Progressive escalation reached terminal level";
			await recordFailure(root, session, escalationReason, 0);

			await killAgent({
				session,
				tmuxAlive,
				tmux,
				process: proc,
				getConnection: getConn,
				removeConnection: removeConn,
			});
			return {
				terminated: true,
				stateChanged: true,
				deathReason: escalationReason,
				deathTier: 0,
			};
		}
	}
}

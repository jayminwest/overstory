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
import { nudgeAgent } from "../commands/nudge.ts";
import { createEventStore } from "../events/store.ts";
import {
	findLatestStdoutLog,
	startEventTailer,
	type TailerHandle,
	type TailerOptions,
} from "../events/tailer.ts";
import { createMailClient } from "../mail/client.ts";
import { createMailStore } from "../mail/store.ts";
import { createMulchClient } from "../mulch/client.ts";
import { getConnection, removeConnection } from "../runtimes/connections.ts";
import { getRuntime } from "../runtimes/registry.ts";
import type { RateLimitState, RuntimeConnection } from "../runtimes/types.ts";
import { openSessionStore } from "../sessions/compat.ts";
import type { AgentSession, EventStore, HealthCheck, OverstoryConfig } from "../types.ts";
import {
	capturePaneContent,
	isProcessAlive,
	isSessionAlive,
	killProcessTree,
	killSession,
} from "../worktree/tmux.ts";
import { evaluateHealth, transitionState } from "./health.ts";
import { swapRuntime } from "./swap.ts";
import { triageAgent } from "./triage.ts";

/** Maximum escalation level (terminate). */
const MAX_ESCALATION_LEVEL = 3;

/**
 * Persistent agent capabilities that are excluded from run-level completion checks.
 * These agents are long-running and should not count toward "all workers done".
 */
const PERSISTENT_CAPABILITIES = new Set(["coordinator", "monitor"]);

/**
 * Module-level registry of active event tailers for headless agents.
 * Maps agentName → TailerHandle. Persists across daemon ticks so tailers
 * survive between tick invocations. Overridable via DaemonOptions._tailerRegistry.
 */
const _defaultTailerRegistry: Map<string, TailerHandle> = new Map();

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
 * Build a phase-aware completion message based on the capabilities of completed workers.
 *
 * Single-capability batches get targeted messages (e.g. scouts → "Ready for next phase"),
 * while mixed-capability batches get a generic summary with a breakdown.
 */
export function buildCompletionMessage(
	workerSessions: readonly AgentSession[],
	runId: string,
): string {
	const capabilities = new Set(workerSessions.map((s) => s.capability));
	const count = workerSessions.length;

	if (capabilities.size === 1) {
		if (capabilities.has("scout")) {
			return `[WATCHDOG] All ${count} scout(s) in run ${runId} have completed. Ready for next phase.`;
		}
		if (capabilities.has("builder")) {
			return `[WATCHDOG] All ${count} builder(s) in run ${runId} have completed. Awaiting lead verification.`;
		}
		if (capabilities.has("reviewer")) {
			return `[WATCHDOG] All ${count} reviewer(s) in run ${runId} have completed. Reviews done.`;
		}
		if (capabilities.has("lead")) {
			return `[WATCHDOG] All ${count} lead(s) in run ${runId} have completed. Ready for merge/cleanup.`;
		}
		if (capabilities.has("merger")) {
			return `[WATCHDOG] All ${count} merger(s) in run ${runId} have completed. Merges done.`;
		}
	}

	const breakdown = Array.from(capabilities).sort().join(", ");
	return `[WATCHDOG] All ${count} worker(s) in run ${runId} have completed (${breakdown}). Ready for next steps.`;
}

/**
 * Check if all worker sessions for the active run have completed, and if so,
 * nudge the coordinator. Fire-and-forget: never throws.
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
	const workerSessions = runSessions.filter((s) => !PERSISTENT_CAPABILITIES.has(s.capability));

	if (workerSessions.length === 0) {
		return;
	}

	const allCompleted = workerSessions.every((s) => s.state === "completed");
	if (!allCompleted) {
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
	recordEvent(eventStore, {
		runId,
		agentName: "watchdog",
		eventType: "custom",
		level: "info",
		data: {
			type: "run_complete",
			workerCount: workerSessions.length,
			completedAgents: workerSessions.map((s) => s.agentName),
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
	/** Full config for rate limit detection and runtime resolution. */
	config?: OverstoryConfig;
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
	}) => Promise<"retry" | "terminate" | "extend">;
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
	/** Dependency injection for testing. Uses real capturePaneContent when omitted. */
	_capturePaneContent?: (name: string, lines?: number) => Promise<string | null>;
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
		},
	};
}

/**
 * Kill an agent using the appropriate method based on whether it is headless or TUI.
 *
 * Headless agents (tmuxSession === "" && pid !== null) are killed via PID process tree.
 * TUI agents are killed via their named tmux session (only if tmuxAlive).
 *
 * This prevents the blast-radius bug where killSession("") with tmux prefix matching
 * would kill ALL tmux sessions when a headless agent is terminated.
 */
async function killAgent(ctx: {
	session: AgentSession;
	tmuxAlive: boolean;
	tmux: { killSession: (name: string) => Promise<void> };
	process: { killTree: (pid: number) => Promise<void> };
}): Promise<void> {
	const { session, tmuxAlive, tmux, process: proc } = ctx;
	const isHeadless = session.tmuxSession === "" && session.pid !== null;
	if (isHeadless && session.pid !== null) {
		try {
			await proc.killTree(session.pid);
		} catch {
			// Already exited — not an error
		}
	} else if (tmuxAlive) {
		try {
			await tmux.killSession(session.tmuxSession);
		} catch {
			// Session may have died between check and kill — not an error
		}
	}
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
	const capturePane = options._capturePaneContent ?? capturePaneContent;
	const rateLimitConfig = options.config?.rateLimit;

	const overstoryDir = join(root, ".overstory");
	const { store } = openSessionStore(overstoryDir);

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
			if (session.tmuxSession === "" && session.pid !== null) {
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
						});
						tailerRegistry.set(session.agentName, handle);
					}
				}
			}

			// RPC health check: for headless agents with an active connection,
			// call getState() to refresh lastActivity before evaluateHealth().
			// This prevents false-positive stale/zombie classification for agents
			// that are actively working but haven't updated lastActivity via hooks.
			//
			// For non-RPC headless agents, fall back to event-based activity detection:
			// if events.db has a recent event from this agent within the stale window,
			// the agent is considered active and lastActivity is refreshed.
			if (session.tmuxSession === "" && session.pid !== null) {
				const conn = getConn(session.agentName);
				if (conn) {
					try {
						const state = await Promise.race([
							conn.getState(),
							new Promise<never>((_, reject) =>
								setTimeout(() => reject(new Error("getState timed out")), 5000),
							),
						]);
						if (state.status === "idle" || state.status === "working") {
							store.updateLastActivity(session.agentName);
							// Refresh the session object so evaluateHealth sees updated lastActivity
							session.lastActivity = new Date().toISOString();
						}
					} catch {
						// getState() failed or timed out — remove stale connection
						removeConn(session.agentName);
					}
				} else if (eventStore) {
					// No RPC connection — check events.db for recent activity
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

			const tmuxAlive = await tmux.isSessionAlive(session.tmuxSession);

			// Rate limit detection: capture pane content and check via runtime adapter
			let rateLimitState: RateLimitState | undefined;
			if (tmuxAlive && session.tmuxSession !== "" && rateLimitConfig?.enabled) {
				try {
					const runtime = getRuntime(session.runtime, options.config, session.capability);
					if (runtime.detectRateLimit) {
						const paneContent = await capturePane(session.tmuxSession);
						if (paneContent) {
							rateLimitState = runtime.detectRateLimit(paneContent);
						}
					}
				} catch {
					// Runtime resolution or pane capture failure is non-fatal
				}

				// Track rate limit state transitions in session store
				if (rateLimitState?.limited && session.rateLimitedSince === null) {
					// Newly rate-limited — record timestamp and notify
					const now = new Date().toISOString();
					store.updateRateLimitedSince(session.agentName, now);
					session.rateLimitedSince = now;

					recordEvent(eventStore, {
						runId,
						agentName: session.agentName,
						eventType: "custom",
						level: "warn",
						data: {
							type: "rate_limited",
							runtime: session.runtime,
							message: rateLimitState.message,
							resumesAt: rateLimitState.resumesAt?.toISOString() ?? null,
						},
					});

					// Notify coordinator if configured
					if (rateLimitConfig.notifyCoordinator) {
						try {
							const mailDbPath = join(overstoryDir, "mail.db");
							const mailStore = createMailStore(mailDbPath);
							const mailClient = createMailClient(mailStore);
							mailClient.sendProtocol({
								from: "watchdog",
								to: "coordinator",
								subject: `Rate limited: ${session.agentName}`,
								body: `Agent ${session.agentName} (${session.runtime}) hit rate limit. ${rateLimitState.message}`,
								type: "rate_limited",
								priority: "high",
								payload: {
									agentName: session.agentName,
									runtime: session.runtime,
									resumesAt: rateLimitState.resumesAt?.toISOString() ?? null,
									message: rateLimitState.message,
								},
							});
							mailStore.close();
						} catch {
							// Mail send failure is non-fatal
						}
					}

					// Swap to alternate runtime if configured
					if (rateLimitConfig.behavior === "swap" && rateLimitConfig.swapRuntime) {
						const swapPaneContent = await capturePane(session.tmuxSession, 500);
						const result = await swapRuntime({
							root,
							session,
							targetRuntimeName: rateLimitConfig.swapRuntime,
							config: options.config as OverstoryConfig,
							paneContext: swapPaneContent,
						});
						if (result.success) {
							recordEvent(eventStore, {
								runId,
								agentName: session.agentName,
								eventType: "custom",
								level: "info",
								data: {
									type: "rate_limit_swap",
									from: session.runtime,
									to: result.newRuntime,
								},
							});
							continue;
						}
					}
				} else if (!rateLimitState?.limited && session.rateLimitedSince !== null) {
					// Rate limit lifted — clear tracking
					store.updateRateLimitedSince(session.agentName, null);
					session.rateLimitedSince = null;

					recordEvent(eventStore, {
						runId,
						agentName: session.agentName,
						eventType: "custom",
						level: "info",
						data: { type: "rate_limit_cleared", runtime: session.runtime },
					});
				}
			}

			const check = evaluateHealth(session, tmuxAlive, thresholds, rateLimitState);

			// Transition state forward only (investigate action holds state)
			const newState = transitionState(session.state, check);
			if (newState !== session.state) {
				store.updateState(session.agentName, newState);
				session.state = newState;
			}

			if (onHealthCheck) {
				onHealthCheck(check);
			}

			if (check.action === "terminate") {
				// Record the failure via mulch (Tier 0 detection)
				const reason = check.reconciliationNote ?? "Process terminated";
				await recordFailureFn(root, session, reason, 0);

				// Kill the agent: headless agents are killed via PID, TUI agents via tmux
				await killAgent({ session, tmuxAlive, tmux, process: proc });
				store.updateState(session.agentName, "zombie");
				// Reset escalation tracking on terminal state
				store.updateEscalation(session.agentName, 0, null);
				session.state = "zombie";
				session.escalationLevel = 0;
				session.stalledSince = null;
			} else if (check.action === "investigate") {
				// ZFC: tmux alive but SessionStore says zombie.
				// Log the conflict but do NOT auto-kill.
				// The onHealthCheck callback surfaces this to the operator.
				// No state change — keep zombie until a human or higher-tier agent decides.
			} else if (check.action === "escalate") {
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
				});

				if (actionResult.terminated) {
					store.updateState(session.agentName, "zombie");
					store.updateEscalation(session.agentName, 0, null);
					session.state = "zombie";
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
		if (runId) {
			await checkRunCompletion({
				store,
				runId,
				overstoryDir,
				root,
				nudge,
				eventStore,
			});
		}
	} finally {
		store.close();
		// Close EventStore only if we created it (not injected)
		if (eventStore && !useInjectedEventStore) {
			try {
				eventStore.close();
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
	}) => Promise<"retry" | "terminate" | "extend">;
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
}): Promise<{ terminated: boolean; stateChanged: boolean }> {
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

			const verdict = await triage({
				agentName: session.agentName,
				root,
				lastActivity: session.lastActivity,
			});

			recordEvent(eventStore, {
				runId,
				agentName: session.agentName,
				eventType: "custom",
				level: "warn",
				data: { type: "triage", escalationLevel: 2, verdict },
			});

			if (verdict === "terminate") {
				// Record the failure via mulch (Tier 1 AI triage)
				await recordFailure(root, session, "AI triage classified as terminal failure", 1, verdict);

				await killAgent({ session, tmuxAlive, tmux, process: proc });
				return { terminated: true, stateChanged: true };
			}

			if (verdict === "retry") {
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
			await recordFailure(root, session, "Progressive escalation reached terminal level", 0);

			await killAgent({ session, tmuxAlive, tmux, process: proc });
			return { terminated: true, stateChanged: true };
		}
	}
}

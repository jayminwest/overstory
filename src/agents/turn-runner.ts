/**
 * Per-turn engine for headless Claude Code agents (spawn-per-turn model).
 *
 * Owns a single agent turn end-to-end:
 *   - acquires per-agent serialization (in-process mutex + cross-process lease)
 *   - re-reads SessionStore under the lock so the prior `claudeSessionId` is fresh
 *   - spawns claude via the runtime's `buildDirectSpawn` (with `--resume` when available)
 *   - writes the user turn to a real stdin pipe and closes it (claude sees EOF)
 *   - drains `runtime.parseEvents` and tees events into events.db
 *   - captures the new session id via the parser's `onSessionId` hook
 *   - snapshots mail.db before spawn and detects the agent's capability-specific
 *     terminal mail (`worker_done` for builder/scout/reviewer/lead;
 *     `merged`/`merge_failed` for merger)
 *   - applies state-transition rules (booting → working, completed when done)
 *   - handles abort signals with SIGTERM → SIGKILL escalation
 *   - releases the lock on every exit path
 *
 * This module does NOT decide WHEN to run a turn. The mail injector and nudge
 * command call `runTurn(opts)` when they have a user turn to deliver.
 */

import { Database } from "bun:sqlite";
import { appendFileSync, existsSync } from "node:fs";
import { mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { AgentError } from "../errors.ts";
import { createEventStore } from "../events/store.ts";
import { filterToolArgs } from "../events/tool-filter.ts";
import { createMailStore, type MailStore } from "../mail/store.ts";
import type { AgentEvent, AgentRuntime, DirectSpawnOpts } from "../runtimes/types.ts";
import { createSessionStore } from "../sessions/store.ts";
import type {
	AgentState,
	EventStore,
	EventType,
	ResolvedModel,
	WorkerDiedPayload,
} from "../types.ts";
import { terminalMailTypesFor } from "./capabilities.ts";
import { detectMailPollPattern } from "./mail-poll-detect.ts";
import { acquireTurnLock } from "./turn-lock.ts";

/** Subprocess shape required by `runTurn`. Compatible with `Bun.spawn`. */
export interface TurnSubprocess {
	readonly pid: number;
	readonly stdin: {
		write(data: string | Uint8Array): number | Promise<number> | unknown;
		end?(): void | Promise<void> | unknown;
		flush?(): unknown;
	};
	readonly stdout: ReadableStream<Uint8Array>;
	readonly exited: Promise<number | null>;
	kill(signal?: number | string): void;
}

/** Spawn function signature. Production passes `Bun.spawn` cast to this type. */
export type TurnSpawnFn = (
	cmd: string[],
	options: {
		cwd: string;
		env: Record<string, string>;
		stdin: "pipe";
		stdout: "pipe";
		stderr: "pipe" | "ignore" | number;
	},
) => TurnSubprocess;

/** Severity of an internal runner diagnostic. `error` indicates a contract violation. */
export type RunnerLogLevel = "warn" | "error";

/**
 * Internal runner diagnostic sink. Replaces the swallowed `catch {}` blocks
 * around SessionStore writes and turn.pid I/O so that future failures are
 * visible (overstory-4af3). Test injection point.
 */
export type RunnerLogger = (level: RunnerLogLevel, message: string, err?: unknown) => void;

export interface RunTurnOpts {
	agentName: string;
	/**
	 * Worker capability driving terminal-mail detection (builder/scout/reviewer/
	 * merger/lead). The runner uses {@link terminalMailTypesFor} to decide which
	 * mail types signal completion for this agent.
	 */
	capability: string;
	overstoryDir: string;
	worktreePath: string;
	projectRoot: string;
	taskId: string;
	/** Pre-encoded stream-json envelope (from `encodeUserTurn`). Empty string is a no-op. */
	userTurnNdjson: string;
	runtime: AgentRuntime;
	resolvedModel: ResolvedModel;
	runId: string | null;
	mailDbPath: string;
	eventsDbPath: string;
	sessionsDbPath: string;
	/** Test injection: spawn function. Defaults to `Bun.spawn`. */
	_spawnFn?: TurnSpawnFn;
	/** Test injection: time source. */
	_now?: () => Date;
	/**
	 * Test injection: pre-opened MailStore for the parent-notify path.
	 * Production opens `mailDbPath` briefly inside the helper and closes it; tests
	 * pass a shared in-memory store so they can read what was inserted without
	 * reopening the DB file.
	 */
	_mailStore?: MailStore;
	/**
	 * Test injection: runner diagnostic sink. When omitted, warnings append to
	 * `<turnLogDir>/runner.log` and mirror to `process.stderr` with a
	 * `[turn-runner:<level>] <agent>:` prefix.
	 */
	_logWarning?: RunnerLogger;
	/** Operator-driven kill (e.g. `ov stop`). */
	abortSignal?: AbortSignal;
	/** Time between SIGTERM and SIGKILL on abort. Default 2000ms. */
	sigkillDelayMs?: number;
	/**
	 * Mid-stream stall watchdog: max time (ms) between parser events before the
	 * runner aborts the turn via SIGTERM (escalates to SIGKILL after
	 * `sigkillDelayMs`). Resets on every event from the runtime parser. Default
	 * 600000ms (10 minutes) — generous enough to span long tool calls while
	 * still bounding hung-claude turns (overstory-ddb3).
	 *
	 * Set to `0` to disable (test injection / explicit opt-out only).
	 */
	eventStallTimeoutMs?: number;
	/**
	 * Throttle (ms) for refreshing `session.lastActivity` while events stream
	 * from the parser loop. Default `2000` (every 2s). The watchdog at
	 * `src/watchdog/health.ts:242-243` documents its design as: "the
	 * turn-runner updates [lastActivity] on every parser event during a turn,
	 * and the watchdog refreshes it from events.db between turns" — so the
	 * runner must drive lastActivity itself or a long turn looks stalled and
	 * gets zombified mid-flight (overstory-8e61).
	 *
	 * Set to `0` to refresh on every event (test injection / explicit opt-out).
	 */
	lastActivityRefreshIntervalMs?: number;
	/**
	 * Test injection: invoked each time the parser loop fires a mid-turn
	 * `lastActivity` refresh (after the throttle gate, before/after the
	 * SessionStore write). Used by tests to count refresh attempts directly
	 * rather than inferring from observable timestamps (overstory-8e61).
	 */
	_onLastActivityRefresh?: () => void;
}

export interface TurnResult {
	/** Process exit code. `null` when aborted before exit. */
	exitCode: number | null;
	/** True iff the parser observed a `result` event with `isError: false`. */
	cleanResult: boolean;
	/** Session id captured from this turn's stream-json (may differ from prior). */
	newSessionId: string | null;
	/** True iff a prior session id was requested and the new one differs. */
	resumeMismatch: boolean;
	/**
	 * True iff a capability-specific terminal mail from the agent appeared
	 * during the turn (`worker_done` for builder/scout/reviewer/lead,
	 * `merged`/`merge_failed` for merger).
	 */
	terminalMailObserved: boolean;
	/** Wall-clock turn duration in milliseconds. */
	durationMs: number;
	/** AgentState read from SessionStore at the start of the turn. */
	initialState: AgentState;
	/** AgentState computed by the transition rules and persisted on exit. */
	finalState: AgentState;
	/**
	 * True iff the per-event stall watchdog fired during the turn — the runner
	 * sent SIGTERM/SIGKILL because no parser event arrived for
	 * `eventStallTimeoutMs` (overstory-ddb3). Treated like `aborted` for
	 * finalState purposes (`zombie`).
	 */
	stallAborted: boolean;
	/**
	 * True iff claude exited cleanly (`cleanResult` true) without sending the
	 * capability-specific terminal mail (overstory-6071). Contract violation:
	 * the agent finished its turn but failed to signal completion. Logged at
	 * `error` level via the runner diagnostic sink and recorded here for
	 * caller-visible auditing.
	 */
	terminalMailMissing: boolean;
}

const defaultSpawnFn: TurnSpawnFn = (cmd, options) =>
	Bun.spawn(cmd, options) as unknown as TurnSubprocess;

function mapAgentEventType(type: string): EventType {
	switch (type) {
		case "tool_use":
			return "tool_start";
		case "tool_result":
			return "tool_end";
		case "status":
			return "session_start";
		case "result":
			return "result";
		case "error":
			return "error";
		case "assistant_message":
			return "progress";
		default:
			return "custom";
	}
}

function recordAgentEvent(
	eventStore: EventStore,
	agentName: string,
	runId: string | null,
	sessionId: string | null,
	event: AgentEvent,
): void {
	const eventType = mapAgentEventType(event.type);
	let dataStr: string | null;
	try {
		dataStr = JSON.stringify(event);
	} catch {
		dataStr = null;
	}

	if (event.type === "tool_use") {
		const toolName = typeof event.name === "string" ? event.name : null;
		const toolInput =
			typeof event.input === "object" && event.input !== null
				? (event.input as Record<string, unknown>)
				: {};
		const filtered = toolName ? filterToolArgs(toolName, toolInput) : null;
		eventStore.insert({
			runId,
			agentName,
			sessionId,
			eventType,
			toolName,
			toolArgs: filtered ? JSON.stringify(filtered.args) : null,
			toolDurationMs: null,
			level: "info",
			data: dataStr,
		});
		return;
	}

	if (event.type === "result") {
		eventStore.insert({
			runId,
			agentName,
			sessionId,
			eventType,
			toolName: null,
			toolArgs: null,
			toolDurationMs: typeof event.durationMs === "number" ? Math.round(event.durationMs) : null,
			level: event.isError === true ? "error" : "info",
			data: dataStr,
		});
		return;
	}

	eventStore.insert({
		runId,
		agentName,
		sessionId,
		eventType,
		toolName: null,
		toolArgs: null,
		toolDurationMs: null,
		level: event.type === "error" ? "error" : "info",
		data: dataStr,
	});
}

function checkTerminalMailSince(
	mailDbPath: string,
	agentName: string,
	capability: string,
	sinceTs: string,
): boolean {
	const types = terminalMailTypesFor(capability);
	if (types.length === 0) return false;

	let db: Database;
	try {
		db = new Database(mailDbPath);
	} catch {
		return false;
	}
	try {
		db.exec("PRAGMA busy_timeout = 5000");
		const placeholders = types.map((_, i) => `$t${i}`).join(",");
		const sql = `SELECT 1 AS c FROM messages WHERE from_agent = $a AND type IN (${placeholders}) AND created_at > $ts LIMIT 1`;
		const stmt = db.prepare<{ c: number }, Record<string, string>>(sql);
		const params: Record<string, string> = { $a: agentName, $ts: sinceTs };
		types.forEach((t, i) => {
			params[`$t${i}`] = t;
		});
		const row = stmt.get(params);
		return row !== null;
	} catch {
		return false;
	} finally {
		try {
			db.close();
		} catch {
			// best-effort
		}
	}
}

/**
 * Latest `created_at` timestamp of a terminal mail (`worker_done`/`result` for
 * task-scoped workers; `merged`/`merge_failed` for merger) sent by `agentName`.
 *
 * Returns `null` when the agent has no prior terminal mail or the mail DB is
 * unavailable. The runner uses this as the snapshot baseline for the new turn:
 * any terminal mail with `created_at > snapshot` is attributable to the spawn
 * we are about to start. Querying the actual prior timestamp eliminates the
 * misattribution window that `now()` opened — a prior-turn `worker_done` that
 * lands between baseline capture and spawn would have falsely tripped the
 * "terminal mail observed" check (overstory-088b C1).
 */
function latestTerminalMailTs(
	mailDbPath: string,
	agentName: string,
	capability: string,
): string | null {
	const types = terminalMailTypesFor(capability);
	if (types.length === 0) return null;

	let db: Database;
	try {
		db = new Database(mailDbPath);
	} catch {
		return null;
	}
	try {
		db.exec("PRAGMA busy_timeout = 5000");
		const placeholders = types.map((_, i) => `$t${i}`).join(",");
		const sql = `SELECT MAX(created_at) AS ts FROM messages WHERE from_agent = $a AND type IN (${placeholders})`;
		const stmt = db.prepare<{ ts: string | null }, Record<string, string>>(sql);
		const params: Record<string, string> = { $a: agentName };
		types.forEach((t, i) => {
			params[`$t${i}`] = t;
		});
		const row = stmt.get(params);
		return row?.ts ?? null;
	} catch {
		return null;
	} finally {
		try {
			db.close();
		} catch {
			// best-effort
		}
	}
}

/**
 * Send a synthetic `worker_died` mail to the parent of a session whose turn
 * ended without the capability's terminal mail. Mirrors the watchdog's
 * `notifyParentOfDeath` (overstory-c111) but for in-band runner detection:
 *
 * - **Aborted / stalled** (zombie): operator `ov stop` or the parser-stall
 *   watchdog killed the subprocess. The agent never got a chance to send
 *   `worker_done`/`merged` (overstory-c772).
 * - **terminalMailMissing**: claude exited cleanly but never sent the terminal
 *   mail — the silent-no-op path (overstory-4159).
 *
 * Without this, the lead waits forever for a terminal mail that will never
 * arrive. The watchdog's pre-tick state-snapshot dedup (mx-b0e54b) means a
 * later watchdog tick on the now-zombie session will see `stateBeforeTick ===
 * "zombie"` and skip its own notify, so we won't double-fire.
 *
 * Fire-and-forget: every failure surfaces through `runnerLog` and never
 * propagates. Mail-send must not break the turn.
 */
function notifyParentOfRunnerDeath(ctx: {
	mailStore: MailStore | null;
	mailDbPath: string;
	parentAgent: string;
	agentName: string;
	capability: string;
	taskId: string;
	reason: string;
	lastActivity: string;
	runnerLog: RunnerLogger;
}): void {
	const {
		mailStore,
		mailDbPath,
		parentAgent,
		agentName,
		capability,
		taskId,
		reason,
		lastActivity,
		runnerLog,
	} = ctx;

	const payload: WorkerDiedPayload = {
		agentName,
		capability,
		taskId,
		reason,
		lastActivity,
		terminatedBy: "runner",
	};
	const subject = `[RUNNER] worker_died: ${agentName}`;
	const body =
		`Worker "${agentName}" (${capability}) on task ${taskId} ended without ` +
		`sending its terminal mail. Reason: ${reason}. Last activity: ${lastActivity}. ` +
		`Decide whether to retry the work, escalate, or report the failure upstream.`;

	let store: MailStore | null = mailStore;
	let owned = false;
	if (store === null) {
		try {
			store = createMailStore(mailDbPath);
			owned = true;
		} catch (err) {
			runnerLog("warn", "failed to open mail store for parent notify", err);
			return;
		}
	}
	try {
		store.insert({
			id: "",
			from: agentName,
			to: parentAgent,
			subject,
			body,
			type: "worker_died",
			priority: "high",
			threadId: null,
			payload: JSON.stringify(payload),
		});
	} catch (err) {
		runnerLog("warn", "failed to send worker_died mail to parent", err);
	} finally {
		if (owned) {
			try {
				store.close();
			} catch {
				// best-effort
			}
		}
	}
}

/**
 * Guarded state transition for the turn runner. Uses the SessionStore CAS
 * (`tryTransitionState`) so a concurrent writer — `ov stop` writing
 * `completed`, watchdog writing `zombie` — cannot be silently overwritten
 * by the turn-runner's "settle to working/completed/zombie" at end of turn.
 *
 * Returns true when the transition landed. Rejected transitions are not
 * fatal: the SQL CAS preserves whatever the conflicting writer set, which
 * is the correct outcome for this race (overstory-a993).
 *
 * `onError` fires on database/IO failure. `onRejected` fires when the CAS
 * rejected the transition (the row exists but was in a state that disallowed
 * the move). Both are diagnostic-only — the caller need not recover.
 */
function updateSessionState(
	sessionsDbPath: string,
	agentName: string,
	state: AgentState,
	onError?: (err: unknown) => void,
	onRejected?: (prev: AgentState, attempted: AgentState) => void,
): boolean {
	try {
		const store = createSessionStore(sessionsDbPath);
		try {
			const outcome = store.tryTransitionState(agentName, state);
			if (!outcome.ok) {
				if (outcome.reason === "illegal_transition") {
					onRejected?.(outcome.prev, outcome.attempted);
				}
				return false;
			}
		} finally {
			store.close();
		}
		return true;
	} catch (err) {
		onError?.(err);
		return false;
	}
}

function updateSessionLastActivity(
	sessionsDbPath: string,
	agentName: string,
	onError?: (err: unknown) => void,
): boolean {
	try {
		const store = createSessionStore(sessionsDbPath);
		try {
			store.updateLastActivity(agentName);
		} finally {
			store.close();
		}
		return true;
	} catch (err) {
		onError?.(err);
		return false;
	}
}

function updateSessionClaudeId(
	sessionsDbPath: string,
	agentName: string,
	sessionId: string,
	onError?: (err: unknown) => void,
): boolean {
	try {
		const store = createSessionStore(sessionsDbPath);
		try {
			store.updateClaudeSessionId(agentName, sessionId);
		} finally {
			store.close();
		}
		return true;
	} catch (err) {
		onError?.(err);
		return false;
	}
}

/**
 * Build the default runner diagnostic sink. Appends to `<turnLogDir>/runner.log`
 * (synchronous, safe inside async functions) and mirrors to `process.stderr`
 * with a `[turn-runner:<level>] <agent>:` prefix. Failures in the sink itself
 * are swallowed — diagnostics must never break the turn.
 */
function defaultRunnerLogger(agentName: string, runnerLogPath: string | null): RunnerLogger {
	return (level, message, err) => {
		const ts = new Date().toISOString();
		const detail =
			err instanceof Error
				? `: ${err.message}`
				: err !== undefined && err !== null
					? `: ${String(err)}`
					: "";
		const line = `${ts} [${level}] ${message}${detail}\n`;
		if (runnerLogPath) {
			try {
				appendFileSync(runnerLogPath, line);
			} catch {
				// best-effort; the stderr mirror still surfaces the warning
			}
		}
		try {
			process.stderr.write(`[turn-runner:${level}] ${agentName}: ${message}${detail}\n`);
		} catch {
			// nothing to do if stderr is unwritable
		}
	};
}

async function teeStreamToWriter(
	stream: ReadableStream<Uint8Array> | null | undefined,
	writer: { write(data: Uint8Array): unknown; end(): unknown },
): Promise<void> {
	const awaitMaybe = async (value: unknown): Promise<void> => {
		if (value && typeof (value as Promise<unknown>).then === "function") {
			await value;
		}
	};

	if (!stream || typeof stream.getReader !== "function") {
		try {
			await awaitMaybe(writer.end());
		} catch {
			// ignore
		}
		return;
	}
	const reader = stream.getReader();
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (value && value.byteLength > 0) {
				try {
					await awaitMaybe(writer.write(value));
				} catch {
					// best-effort; do not block the parser on log file writes
				}
			}
		}
	} catch {
		// ignore stream errors
	} finally {
		try {
			reader.releaseLock();
		} catch {
			// ignore
		}
		try {
			await awaitMaybe(writer.end());
		} catch {
			// ignore
		}
	}
}

/**
 * Spawn one turn for an agent and drive it to completion.
 *
 * Always releases the per-agent lock, including on thrown errors.
 */
export async function runTurn(opts: RunTurnOpts): Promise<TurnResult> {
	const {
		agentName,
		capability,
		overstoryDir,
		worktreePath,
		projectRoot,
		taskId,
		userTurnNdjson,
		runtime,
		resolvedModel,
		runId,
		mailDbPath,
		eventsDbPath,
		sessionsDbPath,
	} = opts;

	if (!runtime.buildDirectSpawn) {
		throw new AgentError(
			`Runtime "${runtime.id}" does not support buildDirectSpawn; cannot use spawn-per-turn`,
			{ agentName },
		);
	}
	if (!runtime.parseEvents) {
		throw new AgentError(
			`Runtime "${runtime.id}" does not support parseEvents; cannot use spawn-per-turn`,
			{ agentName },
		);
	}

	const spawnFn = opts._spawnFn ?? defaultSpawnFn;
	const now = opts._now ?? (() => new Date());
	const sigkillDelayMs = opts.sigkillDelayMs ?? 2000;

	// Pre-lock peek so the empty-input path can short-circuit without
	// paying the lock cost or transitioning state.
	let preInitialState: AgentState = "booting";
	try {
		const preStore = createSessionStore(sessionsDbPath);
		try {
			const session = preStore.getByName(agentName);
			if (session) preInitialState = session.state;
		} finally {
			preStore.close();
		}
	} catch {
		// non-fatal — fall back to "booting"
	}

	if (userTurnNdjson === "") {
		return {
			exitCode: null,
			cleanResult: false,
			newSessionId: null,
			resumeMismatch: false,
			terminalMailObserved: false,
			durationMs: 0,
			initialState: preInitialState,
			finalState: preInitialState,
			stallAborted: false,
			terminalMailMissing: false,
		};
	}

	const lock = await acquireTurnLock({ agentName, overstoryDir });
	const startedAtMs = now().getTime();
	let initialState: AgentState = preInitialState;
	let priorSessionId: string | null = null;
	let parentAgent: string | null = null;
	let sessionLastActivity: string | null = null;
	let turnPidPath: string | null = null;
	// Per-turn diagnostic sink. Bound after the turn log dir is created;
	// pre-creation failures (rare — only the lock-held SessionStore re-read)
	// remain silent because the file path doesn't exist yet.
	let runnerLog: RunnerLogger = opts._logWarning ?? defaultRunnerLogger(agentName, null);

	try {
		// Re-read session under the lock — the value passed to the caller may be
		// stale if another process just updated it.
		try {
			const store = createSessionStore(sessionsDbPath);
			try {
				const session = store.getByName(agentName);
				if (session) {
					initialState = session.state;
					priorSessionId = session.claudeSessionId ?? null;
					parentAgent = session.parentAgent ?? null;
					sessionLastActivity = session.lastActivity ?? null;
				}
			} finally {
				store.close();
			}
		} catch {
			// non-fatal — fall back to pre-lock peek
		}

		const directEnv: Record<string, string> = {
			...runtime.buildEnv(resolvedModel),
			OVERSTORY_AGENT_NAME: agentName,
			OVERSTORY_WORKTREE_PATH: worktreePath,
			OVERSTORY_TASK_ID: taskId,
			OVERSTORY_PROJECT_ROOT: projectRoot,
		};
		const spawnEnv: Record<string, string> = {
			...(process.env as Record<string, string>),
			...directEnv,
		};

		const directOpts: DirectSpawnOpts = {
			cwd: worktreePath,
			env: directEnv,
			...(resolvedModel.isExplicitOverride ? { model: resolvedModel.model } : {}),
			instructionPath: runtime.instructionPath,
			resumeSessionId: priorSessionId,
		};
		const argv = runtime.buildDirectSpawn(directOpts);

		const logTimestamp = now().toISOString().replace(/[:.]/g, "-");
		const turnLogDir = join(overstoryDir, "logs", agentName, logTimestamp);
		await mkdir(turnLogDir, { recursive: true });
		const stderrPath = join(turnLogDir, "stderr.log");
		const stderrWriter = Bun.file(stderrPath).writer();

		// Bind the runner-diagnostic sink now that the per-turn log dir exists.
		// Subsequent silent-failure paths (SessionStore writes, turn.pid I/O)
		// route through `runnerLog` so future leaks/contract violations are
		// diagnosable (overstory-4af3).
		const runnerLogPath = join(turnLogDir, "runner.log");
		runnerLog = opts._logWarning ?? defaultRunnerLogger(agentName, runnerLogPath);

		// Per-agent state dir (shared with applied-records.json, identity.yaml).
		// Holds turn.pid while a turn is in flight so other processes (`ov stop`,
		// watchdog) can find and signal the live claude PID.
		const agentStateDir = join(overstoryDir, "agents", agentName);
		await mkdir(agentStateDir, { recursive: true });
		turnPidPath = join(agentStateDir, "turn.pid");

		// Snapshot the terminal-mail baseline at the latest prior terminal mail
		// (`worker_done`/`result` for task workers, `merged`/`merge_failed` for
		// merger). Querying the actual prior timestamp — rather than wall-clock
		// `now()` — closes the misattribution window where a prior turn's
		// terminal mail lands between baseline capture and spawn (overstory-088b
		// C1). Falls back to epoch when no prior terminal mail exists, so the
		// first terminal mail of the agent's lifetime is attributed to this turn.
		const snapshotTs =
			latestTerminalMailTs(mailDbPath, agentName, capability) ?? new Date(0).toISOString();

		// Spawn. Failures here propagate after the finally below releases the lock.
		let proc: TurnSubprocess;
		try {
			proc = spawnFn(argv, {
				cwd: worktreePath,
				env: spawnEnv,
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			});
		} catch (err) {
			try {
				await stderrWriter.end();
			} catch {
				// ignore
			}
			throw err;
		}

		// Publish the live claude PID so other processes (`ov stop`, watchdog) can
		// find and signal it. turn.pid is the cross-process kill primitive for
		// headless task-scoped agents — without it, `ov stop` reads null and
		// silently degrades (overstory-62a6). Treat write failure as a contract
		// violation (symmetric with the cleanup-side assertion that turn.pid must
		// not survive the runner): SIGKILL the just-spawned subprocess and abort
		// the turn so the operator sees the failure instead of a half-broken
		// agent that cannot be killed.
		try {
			await Bun.write(turnPidPath, `${proc.pid}\n`);
		} catch (err) {
			runnerLog(
				"error",
				`failed to write turn.pid at ${turnPidPath} — kill primitive unavailable, aborting turn`,
				err,
			);
			try {
				proc.kill("SIGKILL");
			} catch {
				// process may have already exited
			}
			try {
				await stderrWriter.end();
			} catch {
				// ignore
			}
			throw new AgentError(
				`failed to write turn.pid at ${turnPidPath}: ${err instanceof Error ? err.message : String(err)}`,
				{ agentName, ...(err instanceof Error ? { cause: err } : {}) },
			);
		}

		// Tee stderr stream into the per-turn stderr.log without blocking the parser.
		const stderrStream = (proc as unknown as { stderr?: ReadableStream<Uint8Array> | null }).stderr;
		const stderrTeePromise = teeStreamToWriter(stderrStream, {
			write: (data) => stderrWriter.write(data),
			end: () => stderrWriter.end(),
		});

		// Write the user turn and close stdin so claude sees EOF.
		try {
			const writeRes = proc.stdin.write(userTurnNdjson);
			if (writeRes && typeof (writeRes as Promise<unknown>).then === "function") {
				await writeRes;
			}
			if (typeof proc.stdin.end === "function") {
				const endRes = proc.stdin.end();
				if (endRes && typeof (endRes as Promise<unknown>).then === "function") {
					await endRes;
				}
			}
		} catch (err) {
			try {
				proc.kill();
			} catch {
				// ignore
			}
			throw err;
		}

		// Abort wiring — SIGTERM, then SIGKILL after sigkillDelayMs.
		let aborted = false;
		let sigkillTimer: ReturnType<typeof setTimeout> | null = null;
		const onAbort = (): void => {
			if (aborted) return;
			aborted = true;
			try {
				proc.kill("SIGTERM");
			} catch {
				// process may have already exited
			}
			sigkillTimer = setTimeout(() => {
				try {
					proc.kill("SIGKILL");
				} catch {
					// ignore
				}
			}, sigkillDelayMs);
			(sigkillTimer as { unref?: () => void }).unref?.();
		};
		if (opts.abortSignal) {
			if (opts.abortSignal.aborted) {
				onAbort();
			} else {
				opts.abortSignal.addEventListener("abort", onAbort, { once: true });
			}
		}

		// Drain parser, capture session id, tee events into events.db.
		const eventStore = createEventStore(eventsDbPath);
		let newSessionId: string | null = null;
		let cleanResult = false;
		let observedAnyEvent = false;
		// True iff this turn fired the "first parser event" transition into
		// `in_turn`. Replaces the legacy `bootedToWorking` flag; the trigger
		// now fires from booting OR between_turns OR working (legacy migration)
		// so a resumed spawn-per-turn agent flips back to `in_turn` at the
		// start of every batch (overstory-3087).
		let transitionedToInTurn = false;

		// Stall watchdog (overstory-ddb3): if no parser event arrives for
		// `eventStallTimeoutMs`, abort the turn via SIGTERM/SIGKILL. Otherwise a
		// hung claude (Anthropic API stall, deadlock) hangs the runner forever.
		const eventStallTimeoutMs = opts.eventStallTimeoutMs ?? 600_000;
		let stallAborted = false;
		let stallTimer: ReturnType<typeof setTimeout> | null = null;
		let stallSigkillTimer: ReturnType<typeof setTimeout> | null = null;
		const clearStallTimer = (): void => {
			if (stallTimer) {
				clearTimeout(stallTimer);
				stallTimer = null;
			}
		};
		const armStallTimer = (): void => {
			if (eventStallTimeoutMs <= 0) return;
			clearStallTimer();
			stallTimer = setTimeout(() => {
				if (aborted || stallAborted) return;
				stallAborted = true;
				runnerLog(
					"error",
					`parser stalled: no event for ${eventStallTimeoutMs}ms — aborting via SIGTERM`,
				);
				try {
					proc.kill("SIGTERM");
				} catch {
					// process may have already exited
				}
				stallSigkillTimer = setTimeout(() => {
					try {
						proc.kill("SIGKILL");
					} catch {
						// ignore
					}
				}, sigkillDelayMs);
				(stallSigkillTimer as { unref?: () => void }).unref?.();
			}, eventStallTimeoutMs);
			(stallTimer as { unref?: () => void }).unref?.();
		};

		// `AgentRuntime.parseEvents` is declared as a 1-param method, but the Claude
		// adapter accepts an `onSessionId` hook. Widen the call site so we can pass
		// the hook without depending on adapter-specific types.
		type ParseEventsWithOpts = (
			stream: ReadableStream<Uint8Array>,
			opts?: { onSessionId?: (sid: string) => void },
		) => AsyncIterable<AgentEvent>;
		const parseEvents = runtime.parseEvents as unknown as ParseEventsWithOpts;

		// Arm before iteration so a process that never emits also gets caught.
		armStallTimer();

		try {
			const parser = parseEvents(proc.stdout, {
				onSessionId: (sid: string) => {
					newSessionId = sid;
					updateSessionClaudeId(sessionsDbPath, agentName, sid, (err) =>
						runnerLog("warn", "failed to persist claudeSessionId", err),
					);
					// Resume mismatch (overstory-088b C2): the runtime returned a
					// different session id than the one we asked it to resume.
					// `--resume` is best-effort — claude can decide to start a fresh
					// session if it cannot rehydrate the requested one. Surface a
					// structured warning event so observability mirrors the runner
					// diagnostic and downstream tooling can detect the mismatch.
					if (priorSessionId !== null && sid !== priorSessionId) {
						try {
							eventStore.insert({
								runId,
								agentName,
								sessionId: sid,
								eventType: "custom",
								toolName: null,
								toolArgs: null,
								toolDurationMs: null,
								level: "warn",
								data: JSON.stringify({
									type: "resume_mismatch",
									requestedSessionId: priorSessionId,
									observedSessionId: sid,
								}),
							});
						} catch {
							// non-fatal — observability must not break the turn
						}
						runnerLog(
							"warn",
							`resume mismatch: requested ${priorSessionId} but runtime returned ${sid}`,
						);
					}
				},
			});

			// Mid-turn `lastActivity` refresh (overstory-8e61). The watchdog at
			// `src/watchdog/health.ts:242-243` documents that the runner advances
			// lastActivity per parser event; without this the row stayed at
			// `startedAt` for the whole turn and long turns got zombified live.
			const lastActivityRefreshIntervalMs = opts.lastActivityRefreshIntervalMs ?? 2000;
			let lastActivityRefreshMs = 0; // first event always refreshes

			for await (const event of parser) {
				armStallTimer();
				observedAnyEvent = true;

				// Keep `session.lastActivity` advancing while events flow so the
				// watchdog does not zombify a live agent mid-turn — see
				// `src/watchdog/health.ts:242-243` and overstory-8e61.
				const nowMs = now().getTime();
				if (nowMs - lastActivityRefreshMs >= lastActivityRefreshIntervalMs) {
					lastActivityRefreshMs = nowMs;
					updateSessionLastActivity(sessionsDbPath, agentName, (err) =>
						runnerLog("warn", "failed to refresh lastActivity mid-turn", err),
					);
					opts._onLastActivityRefresh?.();
				}

				// First parser event of a turn → settle into `in_turn`. Allowed
				// predecessors are `booting` (initial dispatch), `between_turns`
				// (next mail batch on a healthy worker), or already-`in_turn`
				// (idempotent — covers the case where a prior turn somehow left
				// the row at in_turn). Legacy `working` rows are intentionally
				// not in the matrix predecessor set (overstory-3087): spawn-
				// per-turn workers should not flow through `working`, so the
				// matrix keeps the substate path disjoint and a stale `working`
				// row is left alone rather than silently coerced.
				if (
					!transitionedToInTurn &&
					(initialState === "booting" || initialState === "between_turns")
				) {
					transitionedToInTurn = true;
					updateSessionState(
						sessionsDbPath,
						agentName,
						"in_turn",
						(err) => runnerLog("warn", `failed to transition ${initialState} → in_turn`, err),
						(prev, attempted) =>
							runnerLog(
								"warn",
								`${initialState} → in_turn rejected: state is now ${prev} (attempted ${attempted})`,
							),
					);
				}

				if (event.type === "result") {
					cleanResult = event.isError !== true;
				}

				// Defense-in-depth (overstory-c92c): detect Bash mail-poll patterns
				// the lead.md prompt forbids (overstory-fa84). Warn-only — emit a
				// custom event before the original tool_use so observability tools
				// see the warning ahead of the offending call. Wrapped in try/catch
				// so detection failure cannot break the turn.
				if (event.type === "tool_use" && event.name === "Bash") {
					try {
						const input =
							typeof event.input === "object" && event.input !== null
								? (event.input as Record<string, unknown>)
								: null;
						const command = input?.command;
						const detection = detectMailPollPattern(command);
						if (detection.matched) {
							const cmdStr = typeof command === "string" ? command : "";
							const truncated = cmdStr.length > 200 ? `${cmdStr.slice(0, 200)}…` : cmdStr;
							runnerLog(
								"warn",
								`detected mail-poll pattern in Bash command (${detection.reason}): ${truncated}`,
							);
							try {
								eventStore.insert({
									runId,
									agentName,
									sessionId: newSessionId,
									eventType: "custom",
									toolName: null,
									toolArgs: null,
									toolDurationMs: null,
									level: "warn",
									data: JSON.stringify({
										type: "mail_poll_detected",
										reason: detection.reason,
										command: cmdStr,
									}),
								});
							} catch (insertErr) {
								runnerLog("warn", "failed to insert mail_poll_detected event", insertErr);
							}
						}
					} catch (detectErr) {
						runnerLog("warn", "mail-poll detector threw", detectErr);
					}
				}

				try {
					recordAgentEvent(eventStore, agentName, runId, newSessionId, event);
				} catch {
					// non-fatal — observability must not break the turn
				}
			}
		} catch (err) {
			// Parser iteration threw (malformed stream-json, decoder error, etc.).
			// The subprocess is still running and would orphan past lock.release()
			// if we just propagated the error (overstory-088b C3). Send SIGKILL so
			// it cannot keep producing output or holding resources, then rethrow
			// for the outer finally to clean up turn.pid and release the lock.
			runnerLog("error", "parser iteration threw — killing subprocess to avoid orphan", err);
			try {
				proc.kill("SIGKILL");
			} catch {
				// process may have already exited
			}
			throw err;
		} finally {
			clearStallTimer();
			if (stallSigkillTimer) {
				clearTimeout(stallSigkillTimer);
				stallSigkillTimer = null;
			}
			try {
				eventStore.close();
			} catch {
				// ignore
			}
		}

		let exitCode: number | null;
		try {
			exitCode = await proc.exited;
		} catch (err) {
			runnerLog("warn", "proc.exited rejected", err);
			exitCode = null;
		}
		if (sigkillTimer) {
			clearTimeout(sigkillTimer);
			sigkillTimer = null;
		}
		if (opts.abortSignal && !opts.abortSignal.aborted) {
			opts.abortSignal.removeEventListener("abort", onAbort);
		}
		if (aborted || stallAborted) {
			exitCode = null;
		}

		// Wait for stderr drain so the log file isn't truncated mid-write.
		try {
			await stderrTeePromise;
		} catch {
			// best-effort
		}

		const terminalMailObserved = checkTerminalMailSince(
			mailDbPath,
			agentName,
			capability,
			snapshotTs,
		);

		const resumeMismatch =
			priorSessionId !== null && newSessionId !== null && newSessionId !== priorSessionId;

		// Contract violation (overstory-6071): claude exited cleanly (saw a
		// `result` event with isError:false) but never sent the capability's
		// terminal mail. Pre-fix this fell through to `working` and stayed
		// there forever — the process is gone but the session looks alive.
		// Surface loudly via the runner diagnostic sink and settle to
		// `completed` so operators don't see a zombie-but-labeled-working row.
		const terminalMailMissing = cleanResult && !terminalMailObserved && !aborted && !stallAborted;
		if (terminalMailMissing) {
			const expected = terminalMailTypesFor(capability).join("|") || "<none>";
			runnerLog(
				"error",
				`agent exited cleanly without sending terminal mail (expected ${expected}); marking completed and surfacing contract violation`,
			);
		}

		let finalState: AgentState;
		if (aborted || stallAborted) {
			finalState = "zombie";
		} else if (cleanResult && terminalMailObserved) {
			finalState = "completed";
		} else if (terminalMailMissing) {
			finalState = "completed";
		} else if (observedAnyEvent || transitionedToInTurn) {
			// Turn produced events but did not complete — settle to
			// `between_turns`, NOT `working`, so the UI can distinguish a
			// spawn-per-turn worker waiting for its next mail batch from one
			// mid-execution. The watchdog will flip the row back to `in_turn`
			// on the next batch when the parser fires its first event
			// (overstory-3087).
			finalState = "between_turns";
		} else {
			finalState = initialState;
		}

		if (finalState !== initialState) {
			updateSessionState(
				sessionsDbPath,
				agentName,
				finalState,
				(err) => runnerLog("warn", `failed to transition state to ${finalState}`, err),
				(prev, attempted) =>
					runnerLog(
						"warn",
						`turn-end transition ${initialState} → ${attempted} rejected: state is now ${prev}`,
					),
			);
		}

		// In-band parent notification (overstory-4159, overstory-c772). When the
		// turn ends without the capability's terminal mail — either because the
		// runner zombified (abort/stall) or claude exited cleanly without sending
		// `worker_done` — synthesize a `worker_died` mail to the parent so the
		// lead does not block forever waiting for a signal that will never come.
		// The watchdog's pre-tick state-snapshot dedup (mx-b0e54b) ensures a
		// later watchdog pass on the now-zombie session does not re-fire.
		const shouldNotifyParent =
			parentAgent !== null && (finalState === "zombie" || terminalMailMissing);
		if (shouldNotifyParent && parentAgent !== null) {
			const reason = aborted
				? "Aborted by operator (SIGTERM)"
				: stallAborted
					? "Parser stalled (no events within timeout)"
					: terminalMailMissing
						? `Clean exit without terminal mail (expected ${terminalMailTypesFor(capability).join("|") || "<none>"})`
						: "Turn ended without terminal mail";
			notifyParentOfRunnerDeath({
				mailStore: opts._mailStore ?? null,
				mailDbPath,
				parentAgent,
				agentName,
				capability,
				taskId,
				reason,
				lastActivity: sessionLastActivity ?? new Date(startedAtMs).toISOString(),
				runnerLog,
			});
		}

		// `lastActivity` advancing past `startedAt` is a turn-cleanup contract
		// invariant — silent failure here was the smoking gun in overstory-4af3.
		const lastActivityOk = updateSessionLastActivity(sessionsDbPath, agentName, (err) =>
			runnerLog("warn", "failed to update lastActivity", err),
		);
		if (!lastActivityOk) {
			runnerLog(
				"error",
				"lastActivity stayed at startedAt — session.lastActivity is unreliable for this turn",
			);
		}

		const durationMs = now().getTime() - startedAtMs;

		return {
			exitCode,
			cleanResult,
			newSessionId,
			resumeMismatch,
			terminalMailObserved,
			durationMs,
			initialState,
			finalState,
			stallAborted,
			terminalMailMissing,
		};
	} finally {
		// PID-file cleanup so a follow-up turn never sees a stale PID (covers
		// thrown errors as well as the happy path). ENOENT is expected on the
		// "spawn never happened" path; any other error is a contract violation
		// because turn.pid is the cross-process kill primitive (overstory-2cf9).
		if (turnPidPath) {
			try {
				await unlink(turnPidPath);
			} catch (err) {
				const code = (err as NodeJS.ErrnoException | undefined)?.code;
				if (code !== "ENOENT") {
					runnerLog("error", `failed to unlink turn.pid at ${turnPidPath}`, err);
				}
			}
			// Contract assertion: turn.pid must NOT survive the runner. A
			// surviving file means a follow-up `ov stop` or watchdog will target
			// a stale PID. Surface the violation loudly (overstory-4af3).
			try {
				if (existsSync(turnPidPath)) {
					runnerLog(
						"error",
						`turn.pid still exists at ${turnPidPath} after cleanup — kill primitive will target stale PID`,
					);
				}
			} catch {
				// existsSync should not throw, but keep diagnostics defensive
			}
		}
		lock.release();
	}
}

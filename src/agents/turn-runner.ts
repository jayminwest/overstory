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
 *
 * Phase 1 plumbing contract: `DirectSpawnOpts.resumeSessionId` is added by the
 * sibling phase1-plumbing-builder. Until that lands, we extend the type
 * locally so this module compiles. Runtimes that don't yet read the field
 * silently ignore it (structural typing).
 */

import { Database } from "bun:sqlite";
import { appendFileSync, existsSync } from "node:fs";
import { mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { AgentError } from "../errors.ts";
import { createEventStore } from "../events/store.ts";
import { filterToolArgs } from "../events/tool-filter.ts";
import type { AgentEvent, AgentRuntime, DirectSpawnOpts } from "../runtimes/types.ts";
import { createSessionStore } from "../sessions/store.ts";
import type { AgentState, EventStore, EventType, ResolvedModel } from "../types.ts";
import { terminalMailTypesFor } from "./capabilities.ts";
import { acquireTurnLock } from "./turn-lock.ts";

/** TODO(phase1): remove once `resumeSessionId` lives in `DirectSpawnOpts`. */
type DirectSpawnOptsWithResume = DirectSpawnOpts & {
	resumeSessionId?: string | null;
};

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
	 * Test injection: runner diagnostic sink. When omitted, warnings append to
	 * `<turnLogDir>/runner.log` and mirror to `process.stderr` with a
	 * `[turn-runner:<level>] <agent>:` prefix.
	 */
	_logWarning?: RunnerLogger;
	/** Operator-driven kill (e.g. `ov stop`). */
	abortSignal?: AbortSignal;
	/** Time between SIGTERM and SIGKILL on abort. Default 2000ms. */
	sigkillDelayMs?: number;
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
		};
	}

	const lock = await acquireTurnLock({ agentName, overstoryDir });
	const startedAtMs = now().getTime();
	let initialState: AgentState = preInitialState;
	let priorSessionId: string | null = null;
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

		// Phase 1 contract: pass resumeSessionId so the runtime can emit `--resume`.
		const directOpts: DirectSpawnOptsWithResume = {
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

		// Snapshot worker_done baseline. Use wall-clock now so any worker_done
		// mail created during the turn is attributable to this run.
		const snapshotTs = now().toISOString();

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
		// find and signal it. Best-effort: failure is non-fatal, the turn still
		// runs — operators just lose the cross-process kill primitive for this turn.
		try {
			await Bun.write(turnPidPath, `${proc.pid}\n`);
		} catch (err) {
			runnerLog("warn", "failed to write turn.pid", err);
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
		let bootedToWorking = false;

		// `AgentRuntime.parseEvents` is declared as a 1-param method, but the Claude
		// adapter accepts an `onSessionId` hook. Widen the call site so we can pass
		// the hook without depending on adapter-specific types.
		type ParseEventsWithOpts = (
			stream: ReadableStream<Uint8Array>,
			opts?: { onSessionId?: (sid: string) => void },
		) => AsyncIterable<AgentEvent>;
		const parseEvents = runtime.parseEvents as unknown as ParseEventsWithOpts;

		try {
			const parser = parseEvents(proc.stdout, {
				onSessionId: (sid: string) => {
					newSessionId = sid;
					updateSessionClaudeId(sessionsDbPath, agentName, sid, (err) =>
						runnerLog("warn", "failed to persist claudeSessionId", err),
					);
				},
			});

			for await (const event of parser) {
				observedAnyEvent = true;

				if (!bootedToWorking && initialState === "booting") {
					bootedToWorking = true;
					updateSessionState(
						sessionsDbPath,
						agentName,
						"working",
						(err) => runnerLog("warn", "failed to transition booting → working", err),
						(prev, attempted) =>
							runnerLog(
								"warn",
								`booting → working rejected: state is now ${prev} (attempted ${attempted})`,
							),
					);
				}

				if (event.type === "result") {
					cleanResult = event.isError !== true;
				}

				try {
					recordAgentEvent(eventStore, agentName, runId, newSessionId, event);
				} catch {
					// non-fatal — observability must not break the turn
				}
			}
		} finally {
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
		if (aborted) {
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

		let finalState: AgentState;
		if (aborted) {
			finalState = "zombie";
		} else if (cleanResult && terminalMailObserved) {
			finalState = "completed";
		} else if (observedAnyEvent || bootedToWorking) {
			finalState = "working";
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

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventStore } from "../events/store.ts";
import { createMailClient } from "../mail/client.ts";
import { createMailStore } from "../mail/store.ts";
import { ClaudeRuntime } from "../runtimes/claude.ts";
import type { AgentRuntime, DirectSpawnOpts } from "../runtimes/types.ts";
import { createSessionStore } from "../sessions/store.ts";
import type { AgentSession, ResolvedModel } from "../types.ts";
import { _resetInProcessLocks, readTurnLock } from "./turn-lock.ts";
import {
	type RunnerLogger,
	runTurn,
	type TurnSpawnFn,
	type TurnSubprocess,
} from "./turn-runner.ts";

// ---------- fake subprocess plumbing ----------

interface FakeProc extends TurnSubprocess {
	_writes: string[];
	_killSignals: Array<string | number | undefined>;
	_killed: boolean;
	_pushLine(line: string): void;
	_closeStdout(): void;
	_exit(code: number | null): void;
	_setStderr(stream: ReadableStream<Uint8Array> | null): void;
	stderr?: ReadableStream<Uint8Array> | null;
}

let fakeProcCounter = 1000;

function makeFakeProc(): FakeProc {
	let stdoutController!: ReadableStreamDefaultController<Uint8Array>;
	const stdout = new ReadableStream<Uint8Array>({
		start(c) {
			stdoutController = c;
		},
	});
	let stdoutClosed = false;
	const closeStdout = (): void => {
		if (stdoutClosed) return;
		stdoutClosed = true;
		try {
			stdoutController.close();
		} catch {
			// already closed
		}
	};

	const writes: string[] = [];

	let resolveExited!: (code: number | null) => void;
	const exited = new Promise<number | null>((resolve) => {
		resolveExited = resolve;
	});
	let exitedDone = false;
	const finishExit = (code: number | null): void => {
		if (exitedDone) return;
		exitedDone = true;
		resolveExited(code);
	};

	const killSignals: Array<string | number | undefined> = [];
	let killed = false;

	const proc: FakeProc = {
		pid: fakeProcCounter++,
		stdin: {
			write(data: string | Uint8Array): number {
				const s = typeof data === "string" ? data : new TextDecoder().decode(data);
				writes.push(s);
				return s.length;
			},
			end(): void {
				// no-op for fakes; production Bun.spawn closes the pipe.
			},
		},
		stdout,
		exited,
		kill(signal?: string | number): void {
			killSignals.push(signal);
			if (killed) return;
			killed = true;
			closeStdout();
			finishExit(null);
		},
		_writes: writes,
		_killSignals: killSignals,
		_killed: false,
		_pushLine(line: string): void {
			if (stdoutClosed) return;
			stdoutController.enqueue(new TextEncoder().encode(`${line}\n`));
		},
		_closeStdout: closeStdout,
		_exit(code: number | null): void {
			closeStdout();
			finishExit(code);
		},
		_setStderr(stream: ReadableStream<Uint8Array> | null): void {
			proc.stderr = stream;
		},
		stderr: null,
	};
	Object.defineProperty(proc, "_killed", {
		get: () => killed,
	});
	return proc;
}

function emitFakeTurn(
	proc: FakeProc,
	opts: { sessionId?: string; isError?: boolean; durationMs?: number },
): void {
	const sessionId = opts.sessionId ?? "session-test";
	proc._pushLine(
		JSON.stringify({
			type: "system",
			subtype: "init",
			session_id: sessionId,
			model: "claude-test",
		}),
	);
	proc._pushLine(
		JSON.stringify({
			type: "result",
			subtype: "success",
			session_id: sessionId,
			result: "done",
			is_error: opts.isError ?? false,
			duration_ms: opts.durationMs ?? 50,
			num_turns: 1,
		}),
	);
}

// ---------- runtime spy ----------

function makeSpyRuntime(): {
	runtime: AgentRuntime;
	spawnCalls: Array<DirectSpawnOpts & { resumeSessionId?: string | null }>;
} {
	const calls: Array<DirectSpawnOpts & { resumeSessionId?: string | null }> = [];
	const base = new ClaudeRuntime();
	const original = base.buildDirectSpawn.bind(base);
	// Patch the instance to capture each call's opts (including the future
	// resumeSessionId field that turn-runner threads through).
	(base as unknown as { buildDirectSpawn: typeof original }).buildDirectSpawn = (
		opts: DirectSpawnOpts,
	) => {
		calls.push({ ...(opts as DirectSpawnOpts & { resumeSessionId?: string | null }) });
		return original(opts);
	};
	return { runtime: base, spawnCalls: calls };
}

// ---------- session bootstrap ----------

function seedSession(
	sessionsDbPath: string,
	overrides: Partial<AgentSession> & Pick<AgentSession, "agentName">,
): void {
	const store = createSessionStore(sessionsDbPath);
	try {
		const now = new Date().toISOString();
		store.upsert({
			id: `session-${overrides.agentName}`,
			agentName: overrides.agentName,
			capability: overrides.capability ?? "builder",
			worktreePath: overrides.worktreePath ?? "/tmp/worktree",
			branchName: overrides.branchName ?? "branch",
			taskId: overrides.taskId ?? "task-test",
			tmuxSession: overrides.tmuxSession ?? "",
			state: overrides.state ?? "booting",
			pid: overrides.pid ?? null,
			parentAgent: overrides.parentAgent ?? null,
			depth: overrides.depth ?? 0,
			runId: overrides.runId ?? null,
			startedAt: overrides.startedAt ?? now,
			lastActivity: overrides.lastActivity ?? now,
			escalationLevel: overrides.escalationLevel ?? 0,
			stalledSince: overrides.stalledSince ?? null,
			transcriptPath: overrides.transcriptPath ?? null,
			...(overrides.promptVersion !== undefined ? { promptVersion: overrides.promptVersion } : {}),
			...(overrides.claudeSessionId !== undefined
				? { claudeSessionId: overrides.claudeSessionId }
				: {}),
		});
	} finally {
		store.close();
	}
}

function readSession(sessionsDbPath: string, agentName: string): AgentSession | null {
	const store = createSessionStore(sessionsDbPath);
	try {
		return store.getByName(agentName);
	} finally {
		store.close();
	}
}

// ---------- shared fixture context ----------

/**
 * Silent diagnostic sink for tests that don't assert on logs. Suppresses the
 * `[turn-runner:error]` stderr mirror so contract-violation messages
 * (overstory-6071) — which are expected for many tests that drive a clean
 * exit without seeding terminal mail — don't pollute the test runner output.
 */
const silentLogger: RunnerLogger = () => {};

interface Ctx {
	overstoryDir: string;
	worktreePath: string;
	projectRoot: string;
	mailDbPath: string;
	eventsDbPath: string;
	sessionsDbPath: string;
}

const RESOLVED_MODEL: ResolvedModel = { model: "sonnet", env: {}, isExplicitOverride: false };

function makeRunOpts(
	ctx: Ctx,
	agentName: string,
	overrides: {
		runtime: AgentRuntime;
		userTurnNdjson?: string;
		_spawnFn?: TurnSpawnFn;
		abortSignal?: AbortSignal;
		sigkillDelayMs?: number;
		runId?: string | null;
		capability?: string;
		_logWarning?: RunnerLogger;
	},
): Parameters<typeof runTurn>[0] {
	return {
		agentName,
		capability: overrides.capability ?? "builder",
		overstoryDir: ctx.overstoryDir,
		worktreePath: ctx.worktreePath,
		projectRoot: ctx.projectRoot,
		taskId: "task-test",
		userTurnNdjson:
			overrides.userTurnNdjson ??
			`${JSON.stringify({
				type: "user",
				message: { role: "user", content: [{ type: "text", text: "hello" }] },
			})}\n`,
		runtime: overrides.runtime,
		resolvedModel: RESOLVED_MODEL,
		runId: overrides.runId ?? null,
		mailDbPath: ctx.mailDbPath,
		eventsDbPath: ctx.eventsDbPath,
		sessionsDbPath: ctx.sessionsDbPath,
		...(overrides._spawnFn !== undefined ? { _spawnFn: overrides._spawnFn } : {}),
		...(overrides.abortSignal !== undefined ? { abortSignal: overrides.abortSignal } : {}),
		...(overrides.sigkillDelayMs !== undefined ? { sigkillDelayMs: overrides.sigkillDelayMs } : {}),
		_logWarning: overrides._logWarning ?? silentLogger,
	};
}

function turnPidPathFor(ctx: Ctx, agentName: string): string {
	return join(ctx.overstoryDir, "agents", agentName, "turn.pid");
}

// ---------- tests ----------

describe("runTurn", () => {
	let ctx: Ctx;

	beforeEach(async () => {
		const overstoryDir = await mkdtemp(join(tmpdir(), "overstory-turnrunner-test-"));
		ctx = {
			overstoryDir,
			worktreePath: overstoryDir, // arbitrary; spawn is faked
			projectRoot: overstoryDir,
			mailDbPath: join(overstoryDir, "mail.db"),
			eventsDbPath: join(overstoryDir, "events.db"),
			sessionsDbPath: join(overstoryDir, "sessions.db"),
		};
		_resetInProcessLocks();
	});

	afterEach(async () => {
		_resetInProcessLocks();
		await rm(ctx.overstoryDir, { recursive: true, force: true });
	});

	test("empty userTurnNdjson is a no-op: no spawn, no state transition", async () => {
		seedSession(ctx.sessionsDbPath, { agentName: "noop", state: "working" });
		const { runtime } = makeSpyRuntime();
		let spawnCount = 0;
		const spawnFn: TurnSpawnFn = () => {
			spawnCount++;
			return makeFakeProc();
		};

		const result = await runTurn(
			makeRunOpts(ctx, "noop", { runtime, userTurnNdjson: "", _spawnFn: spawnFn }),
		);

		expect(spawnCount).toBe(0);
		expect(result.exitCode).toBeNull();
		expect(result.cleanResult).toBe(false);
		expect(result.terminalMailObserved).toBe(false);
		expect(result.durationMs).toBe(0);
		expect(result.initialState).toBe("working");
		expect(result.finalState).toBe("working");

		// Session state must remain untouched.
		const after = readSession(ctx.sessionsDbPath, "noop");
		expect(after?.state).toBe("working");
	});

	test("happy path: spawn, drain events, capture session id, contract violation surfaces as completed", async () => {
		seedSession(ctx.sessionsDbPath, { agentName: "alpha", state: "booting" });
		const { runtime, spawnCalls } = makeSpyRuntime();

		const fake = makeFakeProc();
		const spawnFn: TurnSpawnFn = () => {
			emitFakeTurn(fake, { sessionId: "claude-sess-A", isError: false });
			fake._exit(0);
			return fake;
		};

		// Suppress the contract-violation error log (overstory-6071) so it
		// doesn't leak to test stderr; assertions below still cover the case.
		const logger: RunnerLogger = () => {};
		const result = await runTurn(
			makeRunOpts(ctx, "alpha", { runtime, _spawnFn: spawnFn, _logWarning: logger }),
		);

		expect(result.exitCode).toBe(0);
		expect(result.cleanResult).toBe(true);
		expect(result.newSessionId).toBe("claude-sess-A");
		expect(result.resumeMismatch).toBe(false);
		expect(result.terminalMailObserved).toBe(false);
		// initial=booting, clean exit but no terminal mail → contract violation,
		// settles to `completed` (overstory-6071).
		expect(result.initialState).toBe("booting");
		expect(result.terminalMailMissing).toBe(true);
		expect(result.finalState).toBe("completed");

		const after = readSession(ctx.sessionsDbPath, "alpha");
		expect(after?.state).toBe("completed");
		expect(after?.claudeSessionId).toBe("claude-sess-A");

		// resumeSessionId on first turn is null (no prior id stored).
		expect(spawnCalls.length).toBe(1);
		expect(spawnCalls[0]?.resumeSessionId ?? null).toBeNull();
	});

	test("re-reads claudeSessionId under the lock — caller view may be stale", async () => {
		seedSession(ctx.sessionsDbPath, {
			agentName: "stale",
			state: "working",
			claudeSessionId: "old-id",
		});

		// External update BEFORE the runTurn call. runTurn must read this value
		// when it acquires the lock, not the older one any caller might be holding.
		const updateStore = createSessionStore(ctx.sessionsDbPath);
		try {
			updateStore.updateClaudeSessionId("stale", "fresh-id");
		} finally {
			updateStore.close();
		}

		const { runtime, spawnCalls } = makeSpyRuntime();
		const fake = makeFakeProc();
		const spawnFn: TurnSpawnFn = () => {
			emitFakeTurn(fake, { sessionId: "fresh-id" }); // same id back; no mismatch
			fake._exit(0);
			return fake;
		};

		const result = await runTurn(makeRunOpts(ctx, "stale", { runtime, _spawnFn: spawnFn }));

		expect(spawnCalls[0]?.resumeSessionId).toBe("fresh-id");
		expect(result.resumeMismatch).toBe(false);
	});

	test("resumeMismatch fires when stream-json emits a different session id", async () => {
		seedSession(ctx.sessionsDbPath, {
			agentName: "mismatch",
			state: "working",
			claudeSessionId: "want-resume",
		});
		const { runtime } = makeSpyRuntime();

		const fake = makeFakeProc();
		const spawnFn: TurnSpawnFn = () => {
			emitFakeTurn(fake, { sessionId: "actually-new" });
			fake._exit(0);
			return fake;
		};

		const result = await runTurn(makeRunOpts(ctx, "mismatch", { runtime, _spawnFn: spawnFn }));

		expect(result.newSessionId).toBe("actually-new");
		expect(result.resumeMismatch).toBe(true);

		// SessionStore overwritten with the observed value.
		const after = readSession(ctx.sessionsDbPath, "mismatch");
		expect(after?.claudeSessionId).toBe("actually-new");

		// overstory-088b C2: a structured warn event lands in events.db so
		// observability mirrors the runner diagnostic. Carries both the requested
		// and observed session ids in the data payload.
		const eventStore = createEventStore(ctx.eventsDbPath);
		try {
			const events = eventStore.getByAgent("mismatch");
			const mismatchEvent = events.find((e) => {
				if (e.eventType !== "custom" || e.level !== "warn" || !e.data) return false;
				try {
					const parsed = JSON.parse(e.data) as { type?: string };
					return parsed.type === "resume_mismatch";
				} catch {
					return false;
				}
			});
			expect(mismatchEvent).toBeDefined();
			const payload = JSON.parse(mismatchEvent?.data ?? "{}") as {
				type: string;
				requestedSessionId: string;
				observedSessionId: string;
			};
			expect(payload.requestedSessionId).toBe("want-resume");
			expect(payload.observedSessionId).toBe("actually-new");
		} finally {
			eventStore.close();
		}
	});

	test("resume match (sid === priorSessionId) does NOT emit a mismatch event", async () => {
		seedSession(ctx.sessionsDbPath, {
			agentName: "match",
			state: "working",
			claudeSessionId: "same-id",
		});
		const { runtime } = makeSpyRuntime();

		const fake = makeFakeProc();
		const spawnFn: TurnSpawnFn = () => {
			emitFakeTurn(fake, { sessionId: "same-id" });
			fake._exit(0);
			return fake;
		};

		const result = await runTurn(makeRunOpts(ctx, "match", { runtime, _spawnFn: spawnFn }));
		expect(result.resumeMismatch).toBe(false);

		const eventStore = createEventStore(ctx.eventsDbPath);
		try {
			const events = eventStore.getByAgent("match");
			const mismatchEvent = events.find((e) => e.data?.includes("resume_mismatch") ?? false);
			expect(mismatchEvent).toBeUndefined();
		} finally {
			eventStore.close();
		}
	});

	test("terminalMailObserved + clean exit → completed state", async () => {
		seedSession(ctx.sessionsDbPath, { agentName: "wd", state: "working" });
		const { runtime } = makeSpyRuntime();

		// Pre-seed: a worker_done from a PRIOR turn (well in the past). Must not
		// confuse this turn's snapshot.
		const mailStore = createMailStore(ctx.mailDbPath);
		try {
			const client = createMailClient(mailStore);
			client.sendProtocol({
				from: "wd",
				to: "lead",
				subject: "Worker done: prior",
				body: "old",
				type: "worker_done",
				priority: "normal",
				payload: {
					taskId: "old",
					branch: "old",
					exitCode: 0,
					filesModified: [],
				},
			});
		} finally {
			mailStore.close();
		}

		// Simulate fresh worker_done sent during the spawn.
		const fake = makeFakeProc();
		const spawnFn: TurnSpawnFn = () => {
			(async () => {
				// Wait long enough for snapshot timestamp to be < this insert.
				await Bun.sleep(20);
				const s = createMailStore(ctx.mailDbPath);
				try {
					const c = createMailClient(s);
					c.sendProtocol({
						from: "wd",
						to: "lead",
						subject: "Worker done: this turn",
						body: "new",
						type: "worker_done",
						priority: "normal",
						payload: {
							taskId: "this-turn",
							branch: "branch",
							exitCode: 0,
							filesModified: [],
						},
					});
				} finally {
					s.close();
				}
				emitFakeTurn(fake, { sessionId: "wd-session" });
				fake._exit(0);
			})();
			return fake;
		};

		const result = await runTurn(makeRunOpts(ctx, "wd", { runtime, _spawnFn: spawnFn }));

		expect(result.terminalMailObserved).toBe(true);
		expect(result.cleanResult).toBe(true);
		expect(result.finalState).toBe("completed");

		const after = readSession(ctx.sessionsDbPath, "wd");
		expect(after?.state).toBe("completed");
	});

	test("clean exit but no worker_done → contract violation, completed + error log (overstory-6071)", async () => {
		// Pre-fix: claude exiting cleanly without sending the capability's
		// terminal mail left the session at `working` forever — the process is
		// gone but the row looks alive. Now the runner logs an error and
		// settles to `completed` so operators see something terminal.
		seedSession(ctx.sessionsDbPath, { agentName: "idle", state: "working" });
		const { runtime } = makeSpyRuntime();
		const fake = makeFakeProc();
		const spawnFn: TurnSpawnFn = () => {
			emitFakeTurn(fake, { sessionId: "idle-session", isError: false });
			fake._exit(0);
			return fake;
		};

		const errors: Array<{ level: string; message: string }> = [];
		const logger: RunnerLogger = (level, message) => {
			errors.push({ level, message });
		};

		const result = await runTurn(
			makeRunOpts(ctx, "idle", { runtime, _spawnFn: spawnFn, _logWarning: logger }),
		);

		expect(result.cleanResult).toBe(true);
		expect(result.terminalMailObserved).toBe(false);
		expect(result.terminalMailMissing).toBe(true);
		expect(result.finalState).toBe("completed");

		// Contract violation must surface via the runner diagnostic sink.
		const violation = errors.find(
			(e) => e.level === "error" && e.message.includes("without sending terminal mail"),
		);
		expect(violation).toBeDefined();

		const after = readSession(ctx.sessionsDbPath, "idle");
		expect(after?.state).toBe("completed");
	});

	test("merger: merged mail counts as terminal → completed", async () => {
		seedSession(ctx.sessionsDbPath, {
			agentName: "mg",
			capability: "merger",
			state: "working",
		});
		const { runtime } = makeSpyRuntime();

		const fake = makeFakeProc();
		const spawnFn: TurnSpawnFn = () => {
			(async () => {
				await Bun.sleep(20);
				const s = createMailStore(ctx.mailDbPath);
				try {
					createMailClient(s).sendProtocol({
						from: "mg",
						to: "lead",
						subject: "Merged: feature/foo",
						body: "ok",
						type: "merged",
						priority: "normal",
						payload: { branch: "feature/foo", taskId: "t-mg", tier: "clean-merge" },
					});
				} finally {
					s.close();
				}
				emitFakeTurn(fake, { sessionId: "mg-session" });
				fake._exit(0);
			})();
			return fake;
		};

		const result = await runTurn(
			makeRunOpts(ctx, "mg", { runtime, _spawnFn: spawnFn, capability: "merger" }),
		);

		expect(result.terminalMailObserved).toBe(true);
		expect(result.finalState).toBe("completed");
	});

	test("merger: merge_failed mail also counts as terminal → completed", async () => {
		seedSession(ctx.sessionsDbPath, {
			agentName: "mgf",
			capability: "merger",
			state: "working",
		});
		const { runtime } = makeSpyRuntime();

		const fake = makeFakeProc();
		const spawnFn: TurnSpawnFn = () => {
			(async () => {
				await Bun.sleep(20);
				const s = createMailStore(ctx.mailDbPath);
				try {
					createMailClient(s).sendProtocol({
						from: "mgf",
						to: "lead",
						subject: "Merge failed: feature/bar",
						body: "conflict",
						type: "merge_failed",
						priority: "high",
						payload: {
							branch: "feature/bar",
							taskId: "t-mgf",
							conflictFiles: ["src/foo.ts"],
							errorMessage: "conflict",
						},
					});
				} finally {
					s.close();
				}
				emitFakeTurn(fake, { sessionId: "mgf-session" });
				fake._exit(0);
			})();
			return fake;
		};

		const result = await runTurn(
			makeRunOpts(ctx, "mgf", { runtime, _spawnFn: spawnFn, capability: "merger" }),
		);

		expect(result.terminalMailObserved).toBe(true);
		expect(result.finalState).toBe("completed");
	});

	test("scout: --type result mail counts as terminal → completed (overstory-1a4c)", async () => {
		// Regression for overstory-1a4c: workers frequently send `--type result`
		// instead of `--type worker_done` because both are valid mail types and
		// the agent prompts described `result` as a completion signal in some
		// examples. Pre-fix, this left sessions stuck in `working` until the
		// watchdog flipped them to `zombie`. The runner now accepts `result` as
		// a terminal type for builder/scout/reviewer/lead.
		seedSession(ctx.sessionsDbPath, {
			agentName: "scout-result",
			capability: "scout",
			state: "working",
		});
		const { runtime } = makeSpyRuntime();

		const fake = makeFakeProc();
		const spawnFn: TurnSpawnFn = () => {
			(async () => {
				await Bun.sleep(20);
				const s = createMailStore(ctx.mailDbPath);
				try {
					createMailClient(s).send({
						from: "scout-result",
						to: "coordinator",
						subject: "Spec ready: overstory-4670",
						body: "Spec written.",
						type: "result",
						priority: "normal",
					});
				} finally {
					s.close();
				}
				emitFakeTurn(fake, { sessionId: "scout-result-session" });
				fake._exit(0);
			})();
			return fake;
		};

		const result = await runTurn(
			makeRunOpts(ctx, "scout-result", { runtime, _spawnFn: spawnFn, capability: "scout" }),
		);

		expect(result.terminalMailObserved).toBe(true);
		expect(result.cleanResult).toBe(true);
		expect(result.finalState).toBe("completed");
	});

	test("merger: worker_done is NOT terminal for merger → contract violation, completed", async () => {
		// Mergers must send `merged` or `merge_failed`. A `worker_done` from a
		// merger doesn't count as terminal, so this is the same contract
		// violation as overstory-6071: clean exit, no terminal mail. Pre-fix
		// this stuck at `working`; now it settles to `completed` with a loud
		// error log.
		seedSession(ctx.sessionsDbPath, {
			agentName: "mg-wd",
			capability: "merger",
			state: "working",
		});
		const { runtime } = makeSpyRuntime();

		const fake = makeFakeProc();
		const spawnFn: TurnSpawnFn = () => {
			(async () => {
				await Bun.sleep(20);
				const s = createMailStore(ctx.mailDbPath);
				try {
					createMailClient(s).sendProtocol({
						from: "mg-wd",
						to: "lead",
						subject: "Worker done (wrong type for merger)",
						body: "x",
						type: "worker_done",
						priority: "normal",
						payload: { taskId: "t", branch: "b", exitCode: 0, filesModified: [] },
					});
				} finally {
					s.close();
				}
				emitFakeTurn(fake, { sessionId: "mg-wd-session" });
				fake._exit(0);
			})();
			return fake;
		};

		const logger: RunnerLogger = () => {};
		const result = await runTurn(
			makeRunOpts(ctx, "mg-wd", {
				runtime,
				_spawnFn: spawnFn,
				capability: "merger",
				_logWarning: logger,
			}),
		);

		expect(result.terminalMailObserved).toBe(false);
		expect(result.terminalMailMissing).toBe(true);
		expect(result.finalState).toBe("completed");
	});

	test("stall watchdog: no parser events for eventStallTimeoutMs → SIGTERM, zombie (overstory-ddb3)", async () => {
		// Pre-fix: a hung claude (alive but stalled — Anthropic API hang,
		// deadlock) would block the parser drain forever because the for-await
		// loop only exits on stdout close. The runner now arms a per-event
		// stall watchdog that resets on every event; on timeout it kills the
		// process via the existing SIGTERM/SIGKILL escalation.
		seedSession(ctx.sessionsDbPath, { agentName: "stalled", state: "working" });
		const { runtime } = makeSpyRuntime();

		const fake = makeFakeProc();
		const spawnFn: TurnSpawnFn = () => {
			// Emit nothing: simulate claude alive but stalled. The stall
			// watchdog must fire and kill the process.
			return fake;
		};

		const errors: Array<{ level: string; message: string }> = [];
		const logger: RunnerLogger = (level, message) => {
			errors.push({ level, message });
		};

		const result = await runTurn({
			...makeRunOpts(ctx, "stalled", {
				runtime,
				_spawnFn: spawnFn,
				_logWarning: logger,
			}),
			eventStallTimeoutMs: 50,
			sigkillDelayMs: 25,
		});

		expect(fake._killSignals[0]).toBe("SIGTERM");
		expect(result.stallAborted).toBe(true);
		expect(result.exitCode).toBeNull();
		expect(result.finalState).toBe("zombie");

		const stallLog = errors.find(
			(e) => e.level === "error" && e.message.includes("parser stalled"),
		);
		expect(stallLog).toBeDefined();

		const after = readSession(ctx.sessionsDbPath, "stalled");
		expect(after?.state).toBe("zombie");
	});

	test("stall watchdog: events reset the timer — live turns are not killed (overstory-ddb3)", async () => {
		// Per-event reset: a turn whose events keep arriving must not be
		// aborted by the stall watchdog. We give a generous 500ms stall
		// budget and emit several events each separated by ~50ms; the
		// cumulative runtime exceeds the budget, but no inter-event gap
		// does, so a properly resetting timer never fires.
		seedSession(ctx.sessionsDbPath, { agentName: "live", state: "working" });
		const { runtime } = makeSpyRuntime();

		const fake = makeFakeProc();
		const spawnFn: TurnSpawnFn = () => {
			(async () => {
				const sessionId = "live-session";
				fake._pushLine(
					JSON.stringify({
						type: "system",
						subtype: "init",
						session_id: sessionId,
						model: "claude-test",
					}),
				);
				for (let i = 0; i < 6; i++) {
					await Bun.sleep(50);
					fake._pushLine(
						JSON.stringify({
							type: "assistant",
							message: {
								role: "assistant",
								content: [{ type: "text", text: `chunk ${i}` }],
							},
							session_id: sessionId,
						}),
					);
				}
				emitFakeTurn(fake, { sessionId });
				fake._exit(0);
			})();
			return fake;
		};

		const logger: RunnerLogger = () => {};
		const result = await runTurn({
			...makeRunOpts(ctx, "live", {
				runtime,
				_spawnFn: spawnFn,
				_logWarning: logger,
			}),
			eventStallTimeoutMs: 500,
			sigkillDelayMs: 25,
		});

		expect(result.stallAborted).toBe(false);
		expect(result.exitCode).toBe(0);
		expect(result.cleanResult).toBe(true);
		// Sanity: turn ran longer than the stall budget would allow if the
		// timer didn't reset on each event (6 × 50ms = 300ms minimum).
		expect(result.durationMs).toBeGreaterThanOrEqual(250);
	});

	test("abortSignal triggers SIGTERM, finalState becomes zombie", async () => {
		seedSession(ctx.sessionsDbPath, { agentName: "to-kill", state: "working" });
		const { runtime } = makeSpyRuntime();

		const fake = makeFakeProc();
		const ac = new AbortController();
		const spawnFn: TurnSpawnFn = () => {
			// Emit init but never close — the abort path is what ends this turn.
			fake._pushLine(
				JSON.stringify({
					type: "system",
					subtype: "init",
					session_id: "abort-test",
				}),
			);
			return fake;
		};

		const runPromise = runTurn(
			makeRunOpts(ctx, "to-kill", {
				runtime,
				_spawnFn: spawnFn,
				abortSignal: ac.signal,
				sigkillDelayMs: 25,
			}),
		);

		// Give the parser a chance to consume the init event.
		await Bun.sleep(60);
		ac.abort();
		const result = await runPromise;

		expect(fake._killSignals[0]).toBe("SIGTERM");
		expect(result.exitCode).toBeNull();
		expect(result.finalState).toBe("zombie");

		const after = readSession(ctx.sessionsDbPath, "to-kill");
		expect(after?.state).toBe("zombie");
	});

	// --- Parent-notify paths (overstory-4159, overstory-c772) ---
	//
	// When a turn ends without the capability's terminal mail, the runner emits
	// a synthetic worker_died mail to the parent so the lead does not block on
	// a signal that will never arrive. Three trigger paths:
	//   1. abort (operator or external abortSignal) → finalState=zombie
	//   2. parser stall → finalState=zombie
	//   3. clean exit without terminal mail (terminalMailMissing) → completed

	test("abort path: emits worker_died to parent with terminatedBy='runner' (overstory-c772)", async () => {
		seedSession(ctx.sessionsDbPath, {
			agentName: "child-abort",
			state: "working",
			parentAgent: "lead-x",
			taskId: "task-c772",
		});
		const { runtime } = makeSpyRuntime();
		const fake = makeFakeProc();
		const ac = new AbortController();
		const spawnFn: TurnSpawnFn = () => {
			fake._pushLine(JSON.stringify({ type: "system", subtype: "init", session_id: "abort-mail" }));
			return fake;
		};

		const sharedMail = createMailStore(ctx.mailDbPath);
		try {
			const runPromise = runTurn({
				...makeRunOpts(ctx, "child-abort", {
					runtime,
					_spawnFn: spawnFn,
					abortSignal: ac.signal,
					sigkillDelayMs: 25,
				}),
				_mailStore: sharedMail,
			});
			await Bun.sleep(60);
			ac.abort();
			const result = await runPromise;
			expect(result.finalState).toBe("zombie");

			const inbox = sharedMail.getAll({ to: "lead-x", type: "worker_died" });
			expect(inbox.length).toBe(1);
			const msg = inbox[0];
			expect(msg?.from).toBe("child-abort");
			expect(msg?.priority).toBe("high");
			expect(msg?.subject).toContain("worker_died");
			expect(msg?.subject).toContain("child-abort");
			const payload = JSON.parse(msg?.payload ?? "{}") as {
				terminatedBy?: string;
				reason?: string;
				agentName?: string;
				taskId?: string;
				capability?: string;
			};
			expect(payload.terminatedBy).toBe("runner");
			expect(payload.agentName).toBe("child-abort");
			// taskId in the mail mirrors the runner's opts.taskId for this turn;
			// the test rig's makeRunOpts seeds this as "task-test".
			expect(payload.taskId).toBe("task-test");
			expect(payload.capability).toBe("builder");
			expect(payload.reason).toContain("Aborted");
		} finally {
			sharedMail.close();
		}
	});

	test("stall path: emits worker_died to parent (overstory-c772)", async () => {
		seedSession(ctx.sessionsDbPath, {
			agentName: "child-stall",
			state: "working",
			parentAgent: "lead-y",
			taskId: "task-c772-b",
		});
		const { runtime } = makeSpyRuntime();
		const fake = makeFakeProc();
		const spawnFn: TurnSpawnFn = () => {
			// Emit nothing — stall watchdog must fire and abort.
			return fake;
		};

		const sharedMail = createMailStore(ctx.mailDbPath);
		try {
			const result = await runTurn({
				...makeRunOpts(ctx, "child-stall", {
					runtime,
					_spawnFn: spawnFn,
				}),
				_mailStore: sharedMail,
				eventStallTimeoutMs: 50,
				sigkillDelayMs: 25,
			});
			expect(result.stallAborted).toBe(true);
			expect(result.finalState).toBe("zombie");

			const inbox = sharedMail.getAll({ to: "lead-y", type: "worker_died" });
			expect(inbox.length).toBe(1);
			const payload = JSON.parse(inbox[0]?.payload ?? "{}") as {
				terminatedBy?: string;
				reason?: string;
			};
			expect(payload.terminatedBy).toBe("runner");
			expect(payload.reason).toContain("stalled");
		} finally {
			sharedMail.close();
		}
	});

	test("terminalMailMissing: emits worker_died to parent (overstory-4159)", async () => {
		// Silent-no-op: claude exits cleanly but never sends worker_done. The
		// lead would otherwise block forever waiting for a terminal mail.
		seedSession(ctx.sessionsDbPath, {
			agentName: "child-noop",
			state: "working",
			parentAgent: "lead-z",
			taskId: "task-4159",
		});
		const { runtime } = makeSpyRuntime();
		const fake = makeFakeProc();
		const spawnFn: TurnSpawnFn = () => {
			emitFakeTurn(fake, { sessionId: "noop-session", isError: false });
			fake._exit(0);
			return fake;
		};

		const sharedMail = createMailStore(ctx.mailDbPath);
		try {
			const result = await runTurn({
				...makeRunOpts(ctx, "child-noop", {
					runtime,
					_spawnFn: spawnFn,
				}),
				_mailStore: sharedMail,
			});
			expect(result.cleanResult).toBe(true);
			expect(result.terminalMailMissing).toBe(true);
			expect(result.finalState).toBe("completed");

			const inbox = sharedMail.getAll({ to: "lead-z", type: "worker_died" });
			expect(inbox.length).toBe(1);
			const payload = JSON.parse(inbox[0]?.payload ?? "{}") as {
				terminatedBy?: string;
				reason?: string;
				agentName?: string;
			};
			expect(payload.terminatedBy).toBe("runner");
			expect(payload.agentName).toBe("child-noop");
			expect(payload.reason).toContain("Clean exit without terminal mail");
		} finally {
			sharedMail.close();
		}
	});

	test("no parentAgent: skips worker_died mail (orchestrator-spawned worker)", async () => {
		// Orchestrator-spawned workers have parentAgent=null; there is nobody to
		// notify. The runner must not fabricate a recipient.
		seedSession(ctx.sessionsDbPath, {
			agentName: "orphan-noop",
			state: "working",
			parentAgent: null,
			taskId: "task-orphan",
		});
		const { runtime } = makeSpyRuntime();
		const fake = makeFakeProc();
		const spawnFn: TurnSpawnFn = () => {
			emitFakeTurn(fake, { sessionId: "orphan-session" });
			fake._exit(0);
			return fake;
		};

		const sharedMail = createMailStore(ctx.mailDbPath);
		try {
			const result = await runTurn({
				...makeRunOpts(ctx, "orphan-noop", { runtime, _spawnFn: spawnFn }),
				_mailStore: sharedMail,
			});
			expect(result.terminalMailMissing).toBe(true);
			const all = sharedMail.getAll({ type: "worker_died" });
			expect(all.length).toBe(0);
		} finally {
			sharedMail.close();
		}
	});

	test("happy path: terminal mail observed → no worker_died emitted (no double-signal)", async () => {
		seedSession(ctx.sessionsDbPath, {
			agentName: "child-ok",
			state: "working",
			parentAgent: "lead-ok",
			taskId: "task-happy",
		});
		const { runtime } = makeSpyRuntime();
		const fake = makeFakeProc();
		const spawnFn: TurnSpawnFn = () => {
			(async () => {
				await Bun.sleep(15);
				const s = createMailStore(ctx.mailDbPath);
				try {
					createMailClient(s).sendProtocol({
						from: "child-ok",
						to: "lead-ok",
						subject: "Worker done",
						body: "ok",
						type: "worker_done",
						priority: "normal",
						payload: {
							taskId: "task-happy",
							branch: "branch",
							exitCode: 0,
							filesModified: [],
						},
					});
				} finally {
					s.close();
				}
				emitFakeTurn(fake, { sessionId: "ok-session" });
				fake._exit(0);
			})();
			return fake;
		};

		const sharedMail = createMailStore(ctx.mailDbPath);
		try {
			const result = await runTurn({
				...makeRunOpts(ctx, "child-ok", { runtime, _spawnFn: spawnFn }),
				_mailStore: sharedMail,
			});
			expect(result.terminalMailObserved).toBe(true);
			expect(result.terminalMailMissing).toBe(false);
			expect(result.finalState).toBe("completed");

			// Inbox should have the agent's own worker_done, but NO worker_died.
			const died = sharedMail.getAll({ to: "lead-ok", type: "worker_died" });
			expect(died.length).toBe(0);
		} finally {
			sharedMail.close();
		}
	});

	test("two concurrent runTurn calls for the same agent serialize", async () => {
		seedSession(ctx.sessionsDbPath, { agentName: "serial", state: "working" });
		const { runtime } = makeSpyRuntime();

		const windows: Array<{ id: number; phase: "start" | "end"; ts: number }> = [];
		let spawnId = 0;
		const spawnFn: TurnSpawnFn = () => {
			const id = ++spawnId;
			windows.push({ id, phase: "start", ts: Date.now() });
			const fake = makeFakeProc();
			(async () => {
				// Hold the spawn open briefly to widen the overlap window.
				await Bun.sleep(80);
				emitFakeTurn(fake, { sessionId: `s-${id}` });
				fake._exit(0);
				windows.push({ id, phase: "end", ts: Date.now() });
			})();
			return fake;
		};

		const a = runTurn(makeRunOpts(ctx, "serial", { runtime, _spawnFn: spawnFn }));
		const b = runTurn(makeRunOpts(ctx, "serial", { runtime, _spawnFn: spawnFn }));
		await Promise.all([a, b]);

		// Sort by timestamp; verify the second start follows the first end.
		const ordered = [...windows].sort((x, y) => x.ts - y.ts);
		expect(ordered.length).toBe(4);
		expect(ordered[0]?.phase).toBe("start");
		expect(ordered[1]?.phase).toBe("end");
		expect(ordered[1]?.id).toBe(ordered[0]?.id);
		expect(ordered[2]?.phase).toBe("start");
		expect(ordered[2]?.id).not.toBe(ordered[0]?.id);
	});

	test("spawn throws — lock is released and error propagates", async () => {
		seedSession(ctx.sessionsDbPath, { agentName: "fails", state: "booting" });
		const { runtime } = makeSpyRuntime();
		const failingSpawn: TurnSpawnFn = () => {
			throw new Error("ENOENT: claude binary missing");
		};

		await expect(
			runTurn(makeRunOpts(ctx, "fails", { runtime, _spawnFn: failingSpawn })),
		).rejects.toThrow(/binary missing/);

		// Cross-process lock state must be cleared so a follow-up turn can run.
		const state = readTurnLock(ctx.overstoryDir, "fails");
		expect(state.heldByPid).toBeNull();

		// Session state must NOT have transitioned (no events were observed).
		const after = readSession(ctx.sessionsDbPath, "fails");
		expect(after?.state).toBe("booting");
	});

	test("subsequent turn passes the prior session id to runtime.buildDirectSpawn", async () => {
		seedSession(ctx.sessionsDbPath, { agentName: "two-turns", state: "working" });
		const { runtime, spawnCalls } = makeSpyRuntime();

		// Turn 1: claude assigns session id "sid-1".
		const t1Fake = makeFakeProc();
		const t1Spawn: TurnSpawnFn = () => {
			emitFakeTurn(t1Fake, { sessionId: "sid-1" });
			t1Fake._exit(0);
			return t1Fake;
		};
		await runTurn(makeRunOpts(ctx, "two-turns", { runtime, _spawnFn: t1Spawn }));

		// Turn 2: must read sid-1 back from SessionStore and pass it as resumeSessionId.
		const t2Fake = makeFakeProc();
		const t2Spawn: TurnSpawnFn = () => {
			emitFakeTurn(t2Fake, { sessionId: "sid-1" });
			t2Fake._exit(0);
			return t2Fake;
		};
		await runTurn(makeRunOpts(ctx, "two-turns", { runtime, _spawnFn: t2Spawn }));

		expect(spawnCalls.length).toBe(2);
		expect(spawnCalls[0]?.resumeSessionId ?? null).toBeNull();
		expect(spawnCalls[1]?.resumeSessionId).toBe("sid-1");
	});

	test("user turn payload is written to spawned stdin", async () => {
		seedSession(ctx.sessionsDbPath, { agentName: "stdin-test", state: "working" });
		const { runtime } = makeSpyRuntime();

		const payload = `${JSON.stringify({
			type: "user",
			message: { role: "user", content: [{ type: "text", text: "ping" }] },
		})}\n`;

		const fake = makeFakeProc();
		const spawnFn: TurnSpawnFn = () => {
			emitFakeTurn(fake, { sessionId: "stdin-sess" });
			fake._exit(0);
			return fake;
		};

		await runTurn(
			makeRunOpts(ctx, "stdin-test", {
				runtime,
				_spawnFn: spawnFn,
				userTurnNdjson: payload,
			}),
		);

		expect(fake._writes.length).toBe(1);
		expect(fake._writes[0]).toBe(payload);
	});

	test("does not spawn when the runtime lacks buildDirectSpawn", async () => {
		seedSession(ctx.sessionsDbPath, { agentName: "no-build", state: "booting" });
		const incomplete: AgentRuntime = {
			id: "incomplete",
			stability: "experimental",
			instructionPath: "AGENTS.md",
			buildSpawnCommand: () => "",
			buildPrintCommand: () => [],
			deployConfig: async () => {},
			detectReady: () => ({ phase: "ready" }),
			parseTranscript: async () => null,
			getTranscriptDir: () => null,
			buildEnv: () => ({}),
			// buildDirectSpawn intentionally omitted
			parseEvents: async function* () {
				yield* [];
			},
		};

		await expect(runTurn(makeRunOpts(ctx, "no-build", { runtime: incomplete }))).rejects.toThrow(
			/buildDirectSpawn/,
		);
	});

	// ---------- cleanup-invariant tests (overstory-4af3) ----------
	//
	// The runner publishes turn.pid for cross-process abort and updates
	// lastActivity at the end of every turn. Both must hold even when the
	// inner SessionStore writes silently fail. These tests pin the cleanup
	// contract so future regressions surface immediately.

	test("happy path: turn.pid is removed and lastActivity advances past startedAt", async () => {
		const startedAt = new Date(Date.now() - 60_000).toISOString();
		seedSession(ctx.sessionsDbPath, {
			agentName: "cleanup-ok",
			state: "working",
			startedAt,
			lastActivity: startedAt,
		});
		const { runtime } = makeSpyRuntime();
		const fake = makeFakeProc();
		const spawnFn: TurnSpawnFn = () => {
			emitFakeTurn(fake, { sessionId: "cleanup-ok-session" });
			fake._exit(0);
			return fake;
		};

		const result = await runTurn(makeRunOpts(ctx, "cleanup-ok", { runtime, _spawnFn: spawnFn }));

		expect(result.exitCode).toBe(0);

		const turnPidPath = turnPidPathFor(ctx, "cleanup-ok");
		expect(existsSync(turnPidPath)).toBe(false);

		const after = readSession(ctx.sessionsDbPath, "cleanup-ok");
		expect(after?.lastActivity).not.toBe(startedAt);
		expect(new Date(after?.lastActivity ?? 0).getTime()).toBeGreaterThan(
			new Date(startedAt).getTime(),
		);
	});

	test("spawn throws: turn.pid is never written and finally cleanup is a no-op", async () => {
		seedSession(ctx.sessionsDbPath, { agentName: "spawn-fail", state: "booting" });
		const { runtime } = makeSpyRuntime();
		const failingSpawn: TurnSpawnFn = () => {
			throw new Error("ENOENT: claude binary missing");
		};

		await expect(
			runTurn(makeRunOpts(ctx, "spawn-fail", { runtime, _spawnFn: failingSpawn })),
		).rejects.toThrow(/binary missing/);

		expect(existsSync(turnPidPathFor(ctx, "spawn-fail"))).toBe(false);
	});

	test("parser throws: outer finally still runs and removes turn.pid", async () => {
		seedSession(ctx.sessionsDbPath, { agentName: "parser-fail", state: "working" });

		// Custom runtime whose parseEvents returns an async iterable that
		// rejects on first read — mirrors a stream-json parse error mid-turn.
		const base = new ClaudeRuntime();
		const failingIterable: AsyncIterable<never> = {
			[Symbol.asyncIterator](): AsyncIterator<never> {
				return {
					next(): Promise<IteratorResult<never>> {
						return Promise.reject(new Error("synthetic stream-json parse error"));
					},
				};
			},
		};
		const broken: AgentRuntime = {
			...base,
			id: base.id,
			stability: base.stability,
			instructionPath: base.instructionPath,
			buildSpawnCommand: base.buildSpawnCommand.bind(base),
			buildPrintCommand: base.buildPrintCommand.bind(base),
			deployConfig: base.deployConfig.bind(base),
			detectReady: base.detectReady.bind(base),
			parseTranscript: base.parseTranscript.bind(base),
			getTranscriptDir: base.getTranscriptDir.bind(base),
			buildEnv: base.buildEnv.bind(base),
			buildDirectSpawn: base.buildDirectSpawn.bind(base),
			parseEvents: (() => failingIterable) as unknown as AgentRuntime["parseEvents"],
		};

		const fake = makeFakeProc();
		const spawnFn: TurnSpawnFn = () => {
			// Don't auto-exit: simulate a still-live subprocess so we can verify
			// the C3 kill path actually fires before the lock is released. If we
			// pre-exited the fake here, kill() would still record but the test
			// wouldn't distinguish the runner-driven kill from no-op cleanup.
			return fake;
		};

		await expect(
			runTurn(makeRunOpts(ctx, "parser-fail", { runtime: broken, _spawnFn: spawnFn })),
		).rejects.toThrow(/synthetic stream-json/);

		// overstory-088b C3: parser throw must kill the live subprocess to avoid
		// orphaning past lock.release. SIGKILL is correct here — we are on a
		// non-recoverable error path and must guarantee the process dies.
		expect(fake._killSignals).toContain("SIGKILL");
		expect(fake._killed).toBe(true);

		// Cleanup contract holds even on thrown parser.
		expect(existsSync(turnPidPathFor(ctx, "parser-fail"))).toBe(false);
	});

	test("turn.pid write failure SIGKILLs subprocess and aborts the turn (overstory-62a6)", async () => {
		seedSession(ctx.sessionsDbPath, { agentName: "pid-write-fail", state: "working" });
		const { runtime } = makeSpyRuntime();

		// Pre-create turn.pid as a DIRECTORY so `Bun.write(turnPidPath, ...)` fails
		// with EISDIR. This mirrors any real failure mode (read-only fs, permissions,
		// disk full) where the kill primitive becomes unavailable.
		const { mkdir } = await import("node:fs/promises");
		const turnPidPath = turnPidPathFor(ctx, "pid-write-fail");
		await mkdir(turnPidPath, { recursive: true });

		const fake = makeFakeProc();
		const spawnFn: TurnSpawnFn = () => fake;

		const events: Array<{ level: string; message: string }> = [];
		const logger: RunnerLogger = (level, message) => {
			events.push({ level, message });
		};

		await expect(
			runTurn(
				makeRunOpts(ctx, "pid-write-fail", { runtime, _spawnFn: spawnFn, _logWarning: logger }),
			),
		).rejects.toThrow(/failed to write turn\.pid/);

		// The kill primitive is unavailable, so the only safe way to avoid a
		// silently un-killable agent is to SIGKILL the subprocess here.
		expect(fake._killSignals).toContain("SIGKILL");
		expect(fake._killed).toBe(true);

		// Surfaces at error level (not warn) so the failure isn't silent.
		expect(
			events.some((e) => e.level === "error" && e.message.includes("failed to write turn.pid")),
		).toBe(true);
	});

	test("silent SessionStore failure surfaces as a runner warning", async () => {
		seedSession(ctx.sessionsDbPath, { agentName: "ss-fail", state: "working" });
		const { runtime } = makeSpyRuntime();

		const fake = makeFakeProc();
		const spawnFn: TurnSpawnFn = () => {
			emitFakeTurn(fake, { sessionId: "ss-fail-session" });
			fake._exit(0);
			return fake;
		};

		const warnings: Array<{ level: string; message: string }> = [];
		const logger: RunnerLogger = (level, message) => {
			warnings.push({ level, message });
		};

		// Point sessionsDbPath at a path that exists as a DIRECTORY so every
		// SessionStore open in the runner throws. The runner must keep going
		// (cleanup contract) AND surface the failure via the logger.
		const badSessionsPath = ctx.overstoryDir; // directory, not a db file
		const opts = {
			...makeRunOpts(ctx, "ss-fail", { runtime, _spawnFn: spawnFn, _logWarning: logger }),
			sessionsDbPath: badSessionsPath,
		};

		await runTurn(opts);

		// The lastActivity update silently failed (it's a directory, not a db),
		// which is exactly the scenario that masked overstory-4af3. The runner
		// must report the contract violation via _logWarning at error level.
		const errors = warnings.filter((w) => w.level === "error");
		expect(errors.some((w) => w.message.includes("lastActivity stayed at startedAt"))).toBe(true);

		// turn.pid must still be cleaned up regardless.
		expect(existsSync(turnPidPathFor(ctx, "ss-fail"))).toBe(false);
	});

	// ---------- mid-turn lastActivity refresh (overstory-8e61) ----------
	//
	// The watchdog's design (src/watchdog/health.ts:242-243) documents that the
	// runner advances `session.lastActivity` per parser event during a turn.
	// Without that, a long-running turn looks stalled to the watchdog and the
	// agent gets zombified mid-flight. These tests pin the per-event refresh
	// behavior added inside the parser loop.

	test("mid-turn refresh: lastActivity advances when interval=0 forces per-event refresh", async () => {
		const startedAt = new Date(Date.now() - 60_000).toISOString();
		seedSession(ctx.sessionsDbPath, {
			agentName: "midturn-A",
			state: "working",
			startedAt,
			lastActivity: startedAt,
		});
		const { runtime } = makeSpyRuntime();
		const fake = makeFakeProc();
		const spawnFn: TurnSpawnFn = () => {
			emitFakeTurn(fake, { sessionId: "midturn-A-session" });
			fake._exit(0);
			return fake;
		};

		await runTurn({
			...makeRunOpts(ctx, "midturn-A", { runtime, _spawnFn: spawnFn }),
			lastActivityRefreshIntervalMs: 0,
		});

		const after = readSession(ctx.sessionsDbPath, "midturn-A");
		expect(after?.lastActivity).not.toBe(startedAt);
		expect(new Date(after?.lastActivity ?? 0).getTime()).toBeGreaterThan(
			new Date(startedAt).getTime(),
		);
	});

	test("mid-turn refresh: throttle gates updates by simulated time", async () => {
		seedSession(ctx.sessionsDbPath, { agentName: "midturn-B", state: "working" });
		const { runtime } = makeSpyRuntime();

		// Controlled sim clock. `_now` is invoked many times during a turn (for
		// startedAtMs, log timestamps, durationMs) — only the in-loop calls
		// matter for the throttle. We advance simTime synchronously between
		// pushes and yield to the parser between each push so the runner reads
		// the simTime we set just prior. simTime starts well above the throttle
		// interval so the first event fires (initial lastActivityRefreshMs=0).
		let simTime = 5000;
		const _now = (): Date => new Date(simTime);

		let refreshes = 0;
		const _onLastActivityRefresh = (): void => {
			refreshes++;
		};

		const fake = makeFakeProc();
		const spawnFn: TurnSpawnFn = () => {
			(async () => {
				const sessionId = "midturn-B-session";
				// Use `system` lines because the claude parser does not batch
				// them — every system line yields exactly one status event,
				// driving one runner-loop iteration each. Assistant text would
				// coalesce inside a flush window and defeat the per-event count.
				const stamps = [5000, 5500, 6000, 6500, 7000, 7500];
				for (let i = 0; i < stamps.length; i++) {
					simTime = stamps[i] ?? 0;
					fake._pushLine(
						JSON.stringify({
							type: "system",
							subtype: i === 0 ? "init" : "progress",
							session_id: sessionId,
						}),
					);
					// Yield so the for-await loop body runs to completion against
					// the simTime value we just set.
					await Bun.sleep(20);
				}
				// Trailing result at the same simTime as the last chunk; with a
				// 1000ms throttle and last refresh at simTime=7000, this event
				// at simTime=7500 (delta=500) does not fire.
				fake._pushLine(
					JSON.stringify({
						type: "result",
						subtype: "success",
						session_id: sessionId,
						result: "done",
						is_error: false,
						duration_ms: 50,
						num_turns: 1,
					}),
				);
				await Bun.sleep(20);
				fake._exit(0);
			})();
			return fake;
		};

		await runTurn({
			...makeRunOpts(ctx, "midturn-B", { runtime, _spawnFn: spawnFn }),
			lastActivityRefreshIntervalMs: 1000,
			_now,
			_onLastActivityRefresh,
		});

		// Stamps 5000, 6000, 7000 fire (gap >= 1000). Stamps 5500, 6500, 7500
		// are throttled (gap = 500). The trailing result event at 7500 also
		// throttles. Total expected = 3.
		expect(refreshes).toBe(3);
	});

	test("mid-turn refresh: parser throw still leaves lastActivity advanced (overstory-8e61)", async () => {
		// The end-of-turn `updateSessionLastActivity` (around turn-runner.ts:1112)
		// does NOT fire when the parser iteration throws — the catch path
		// rethrows before reaching the cleanup write. The mid-turn refresh
		// covers this gap so a parser-error turn still leaves lastActivity
		// fresh, mirroring the documented design at src/watchdog/health.ts:242-243.
		const startedAt = new Date(Date.now() - 60_000).toISOString();
		seedSession(ctx.sessionsDbPath, {
			agentName: "midturn-C",
			state: "working",
			startedAt,
			lastActivity: startedAt,
		});

		// Custom runtime: yield two valid events, then throw on the next read.
		// Mirrors a malformed stream-json line arriving after some good events.
		const base = new ClaudeRuntime();
		let yielded = 0;
		const yieldThenThrow: AsyncIterable<unknown> = {
			[Symbol.asyncIterator]() {
				return {
					next(): Promise<IteratorResult<unknown>> {
						if (yielded++ < 2) {
							return Promise.resolve({
								value: {
									type: "assistant_message",
									timestamp: new Date().toISOString(),
								},
								done: false,
							});
						}
						return Promise.reject(new Error("synthetic stream-json parse error"));
					},
				};
			},
		};
		const broken: AgentRuntime = {
			...base,
			id: base.id,
			stability: base.stability,
			instructionPath: base.instructionPath,
			buildSpawnCommand: base.buildSpawnCommand.bind(base),
			buildPrintCommand: base.buildPrintCommand.bind(base),
			deployConfig: base.deployConfig.bind(base),
			detectReady: base.detectReady.bind(base),
			parseTranscript: base.parseTranscript.bind(base),
			getTranscriptDir: base.getTranscriptDir.bind(base),
			buildEnv: base.buildEnv.bind(base),
			buildDirectSpawn: base.buildDirectSpawn.bind(base),
			parseEvents: (() => yieldThenThrow) as unknown as AgentRuntime["parseEvents"],
		};

		const fake = makeFakeProc();
		const spawnFn: TurnSpawnFn = () => fake;

		let refreshes = 0;
		await expect(
			runTurn({
				...makeRunOpts(ctx, "midturn-C", { runtime: broken, _spawnFn: spawnFn }),
				lastActivityRefreshIntervalMs: 0,
				_onLastActivityRefresh: () => {
					refreshes++;
				},
			}),
		).rejects.toThrow(/synthetic stream-json/);

		// Mid-turn refresh fired for at least one of the two pre-throw events.
		expect(refreshes).toBeGreaterThanOrEqual(1);

		// And the persisted lastActivity reflects the mid-turn write — the
		// end-of-turn write at line ~1112 was skipped by the parser-throw path.
		const after = readSession(ctx.sessionsDbPath, "midturn-C");
		expect(after?.lastActivity).not.toBe(startedAt);
		expect(new Date(after?.lastActivity ?? 0).getTime()).toBeGreaterThan(
			new Date(startedAt).getTime(),
		);
	});
});

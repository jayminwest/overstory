import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMailClient } from "../mail/client.ts";
import { createMailStore } from "../mail/store.ts";
import { ClaudeRuntime } from "../runtimes/claude.ts";
import type { AgentRuntime, DirectSpawnOpts } from "../runtimes/types.ts";
import { createSessionStore } from "../sessions/store.ts";
import type { AgentSession, ResolvedModel } from "../types.ts";
import { _resetInProcessLocks, readTurnLock } from "./turn-lock.ts";
import { runTurn, type TurnSpawnFn, type TurnSubprocess } from "./turn-runner.ts";

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
	},
): Parameters<typeof runTurn>[0] {
	return {
		agentName,
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
	};
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
		expect(result.workerDoneObserved).toBe(false);
		expect(result.durationMs).toBe(0);
		expect(result.initialState).toBe("working");
		expect(result.finalState).toBe("working");

		// Session state must remain untouched.
		const after = readSession(ctx.sessionsDbPath, "noop");
		expect(after?.state).toBe("working");
	});

	test("happy path: spawn, drain events, capture session id, transition booting → working", async () => {
		seedSession(ctx.sessionsDbPath, { agentName: "alpha", state: "booting" });
		const { runtime, spawnCalls } = makeSpyRuntime();

		const fake = makeFakeProc();
		const spawnFn: TurnSpawnFn = () => {
			emitFakeTurn(fake, { sessionId: "claude-sess-A", isError: false });
			fake._exit(0);
			return fake;
		};

		const result = await runTurn(makeRunOpts(ctx, "alpha", { runtime, _spawnFn: spawnFn }));

		expect(result.exitCode).toBe(0);
		expect(result.cleanResult).toBe(true);
		expect(result.newSessionId).toBe("claude-sess-A");
		expect(result.resumeMismatch).toBe(false);
		expect(result.workerDoneObserved).toBe(false);
		// initial=booting, no worker_done → working (idle) finalState
		expect(result.initialState).toBe("booting");
		expect(result.finalState).toBe("working");

		const after = readSession(ctx.sessionsDbPath, "alpha");
		expect(after?.state).toBe("working");
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
	});

	test("workerDoneObserved + clean exit → completed state", async () => {
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

		expect(result.workerDoneObserved).toBe(true);
		expect(result.cleanResult).toBe(true);
		expect(result.finalState).toBe("completed");

		const after = readSession(ctx.sessionsDbPath, "wd");
		expect(after?.state).toBe("completed");
	});

	test("clean exit but no worker_done → stays working", async () => {
		seedSession(ctx.sessionsDbPath, { agentName: "idle", state: "working" });
		const { runtime } = makeSpyRuntime();
		const fake = makeFakeProc();
		const spawnFn: TurnSpawnFn = () => {
			emitFakeTurn(fake, { sessionId: "idle-session", isError: false });
			fake._exit(0);
			return fake;
		};

		const result = await runTurn(makeRunOpts(ctx, "idle", { runtime, _spawnFn: spawnFn }));

		expect(result.cleanResult).toBe(true);
		expect(result.workerDoneObserved).toBe(false);
		expect(result.finalState).toBe("working");
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
});

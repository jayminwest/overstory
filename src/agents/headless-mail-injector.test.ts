import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMailClient } from "../mail/client.ts";
import { createMailStore } from "../mail/store.ts";
import {
	_runTurnRunnerTick,
	type InjectionWriteResult,
	startMailInjectionLoop,
	startTurnRunnerMailLoop,
	type TurnRunnerOptsFactory,
} from "./headless-mail-injector.ts";
import type { RunTurnOpts, TurnResult } from "./turn-runner.ts";

describe("startMailInjectionLoop", () => {
	let tempDir: string;
	let mailDbPath: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "overstory-injector-test-"));
		mailDbPath = join(tempDir, "mail.db");
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	function makeWriter(received: string[], result: InjectionWriteResult = "delivered") {
		return (data: string | Uint8Array): InjectionWriteResult => {
			received.push(typeof data === "string" ? data : new TextDecoder().decode(data));
			return result;
		};
	}

	test("delivers unread mail via writer fn as stream-json user turn", async () => {
		const received: string[] = [];

		const store = createMailStore(mailDbPath);
		const client = createMailClient(store);
		client.send({
			from: "coordinator",
			to: "test-agent",
			subject: "Dispatch: test-task",
			body: "Begin working on test-task.",
			type: "dispatch",
			priority: "normal",
		});
		store.close();

		const stop = startMailInjectionLoop("test-agent", makeWriter(received), mailDbPath, 100);
		await new Promise((resolve) => setTimeout(resolve, 250));
		stop();

		expect(received.length).toBeGreaterThan(0);
		const firstMessage = received[0];
		expect(firstMessage).toBeDefined();
		const parsed = JSON.parse(firstMessage?.trimEnd() ?? "");
		expect(parsed.type).toBe("user");
		expect(parsed.message.role).toBe("user");
		const text: string = parsed.message.content[0].text;
		expect(text).toContain("Dispatch: test-task");
		expect(text).toContain("Begin working on test-task.");
	});

	test("batches multiple pending messages into one user turn", async () => {
		const received: string[] = [];

		const store = createMailStore(mailDbPath);
		const client = createMailClient(store);
		client.send({
			from: "lead",
			to: "test-agent",
			subject: "Task A",
			body: "Work on A.",
			type: "dispatch",
			priority: "normal",
		});
		client.send({
			from: "orchestrator",
			to: "test-agent",
			subject: "Task B",
			body: "Work on B.",
			type: "status",
			priority: "low",
		});
		store.close();

		const stop = startMailInjectionLoop("test-agent", makeWriter(received), mailDbPath, 100);
		await new Promise((resolve) => setTimeout(resolve, 250));
		stop();

		expect(received.length).toBeGreaterThanOrEqual(1);
		const batchedText = received[0] ?? "";
		expect(batchedText).toContain("Task A");
		expect(batchedText).toContain("Task B");
	});

	test("does not invoke writer when no unread mail", async () => {
		const received: string[] = [];

		const stop = startMailInjectionLoop("test-agent", makeWriter(received), mailDbPath, 100);
		await new Promise((resolve) => setTimeout(resolve, 250));
		stop();

		expect(received.length).toBe(0);
	});

	test("marks messages as read after successful delivery", async () => {
		const writer = (_data: string | Uint8Array): InjectionWriteResult => "delivered";

		const store = createMailStore(mailDbPath);
		const client = createMailClient(store);
		client.send({
			from: "coordinator",
			to: "reader-agent",
			subject: "Once",
			body: "Deliver once only.",
			type: "dispatch",
			priority: "normal",
		});
		store.close();

		const stop = startMailInjectionLoop("reader-agent", writer, mailDbPath, 100);
		await new Promise((resolve) => setTimeout(resolve, 350));
		stop();

		const checkStore = createMailStore(mailDbPath);
		try {
			const remaining = checkStore.getUnread("reader-agent");
			expect(remaining.length).toBe(0);
		} finally {
			checkStore.close();
		}
	});

	test("leaves messages unread when writer reports no-reader", async () => {
		const writer = (_data: string | Uint8Array): InjectionWriteResult => "no-reader";

		const store = createMailStore(mailDbPath);
		const client = createMailClient(store);
		client.send({
			from: "coordinator",
			to: "absent-agent",
			subject: "Wait",
			body: "Hold for revive.",
			type: "dispatch",
			priority: "normal",
		});
		store.close();

		const stop = startMailInjectionLoop("absent-agent", writer, mailDbPath, 100);
		await new Promise((resolve) => setTimeout(resolve, 250));
		stop();

		const checkStore = createMailStore(mailDbPath);
		try {
			const remaining = checkStore.getUnread("absent-agent");
			expect(remaining.length).toBe(1);
		} finally {
			checkStore.close();
		}
	});

	test("auto-stops the loop after writer reports no-reader", async () => {
		let invocations = 0;
		const writer = (_data: string | Uint8Array): InjectionWriteResult => {
			invocations++;
			return "no-reader";
		};

		const store = createMailStore(mailDbPath);
		const client = createMailClient(store);
		client.send({
			from: "coordinator",
			to: "stopped-agent",
			subject: "X",
			body: "y",
			type: "dispatch",
			priority: "normal",
		});
		store.close();

		const stop = startMailInjectionLoop("stopped-agent", writer, mailDbPath, 100);
		await new Promise((resolve) => setTimeout(resolve, 500));
		stop();

		// The loop should have invoked the writer exactly once before
		// auto-stopping; further ticks must not fire it again.
		expect(invocations).toBe(1);
	});

	test("returns a cleanup function that stops the loop", async () => {
		let writeCount = 0;
		const writer = (_data: string | Uint8Array): InjectionWriteResult => {
			writeCount++;
			return "delivered";
		};

		const store = createMailStore(mailDbPath);
		const client = createMailClient(store);
		client.send({
			from: "coordinator",
			to: "stop-test-agent",
			subject: "Stop test",
			body: "This should be delivered.",
			type: "dispatch",
			priority: "normal",
		});
		store.close();

		const stop = startMailInjectionLoop("stop-test-agent", writer, mailDbPath, 100);
		await new Promise((resolve) => setTimeout(resolve, 150));
		stop();

		const countAfterStop = writeCount;
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(writeCount).toBe(countAfterStop);
	});
});

describe("startTurnRunnerMailLoop", () => {
	let tempDir: string;
	let mailDbPath: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "overstory-turnrunner-test-"));
		mailDbPath = join(tempDir, "mail.db");
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	function makeRunTurnStub(result: Partial<TurnResult> = {}): {
		runTurn: (opts: RunTurnOpts) => Promise<TurnResult>;
		calls: RunTurnOpts[];
	} {
		const calls: RunTurnOpts[] = [];
		const filled: TurnResult = {
			exitCode: 0,
			cleanResult: true,
			newSessionId: null,
			resumeMismatch: false,
			workerDoneObserved: false,
			durationMs: 1,
			initialState: "booting",
			finalState: "working",
			...result,
		};
		return {
			calls,
			runTurn: async (opts) => {
				calls.push(opts);
				return filled;
			},
		};
	}

	function fakeOptsFactory(agentName: string): TurnRunnerOptsFactory {
		return (userTurnNdjson: string): RunTurnOpts =>
			({
				agentName,
				overstoryDir: tempDir,
				worktreePath: tempDir,
				projectRoot: tempDir,
				taskId: "task-x",
				userTurnNdjson,
				// `runtime` and `resolvedModel` are placeholders — the stub never calls them.
				runtime: { id: "claude" } as unknown as RunTurnOpts["runtime"],
				resolvedModel: { model: "test", isExplicitOverride: false },
				runId: null,
				mailDbPath,
				eventsDbPath: join(tempDir, "events.db"),
				sessionsDbPath: join(tempDir, "sessions.db"),
			}) satisfies RunTurnOpts;
	}

	test("invokes runTurn with batched user turn and marks messages read on success", async () => {
		const store = createMailStore(mailDbPath);
		const client = createMailClient(store);
		client.send({
			from: "lead",
			to: "build-agent",
			subject: "Task A",
			body: "Work on A.",
			type: "dispatch",
			priority: "normal",
		});
		client.send({
			from: "lead",
			to: "build-agent",
			subject: "Task B",
			body: "Work on B.",
			type: "status",
			priority: "low",
		});
		store.close();

		const stub = makeRunTurnStub();
		const result = await _runTurnRunnerTick(
			"build-agent",
			fakeOptsFactory("build-agent"),
			stub.runTurn,
			mailDbPath,
		);
		expect(result.kind).toBe("delivered");
		expect(stub.calls.length).toBe(1);
		const opts = stub.calls[0];
		expect(opts).toBeDefined();
		const parsed = JSON.parse(opts?.userTurnNdjson?.trimEnd() ?? "");
		expect(parsed.type).toBe("user");
		const text: string = parsed.message.content[0].text;
		expect(text).toContain("Task A");
		expect(text).toContain("Task B");

		const checkStore = createMailStore(mailDbPath);
		try {
			expect(checkStore.getUnread("build-agent").length).toBe(0);
		} finally {
			checkStore.close();
		}
	});

	test("does not mark messages read when runTurn exits non-zero", async () => {
		const store = createMailStore(mailDbPath);
		const client = createMailClient(store);
		client.send({
			from: "lead",
			to: "fail-agent",
			subject: "Try again",
			body: "Should not be marked read.",
			type: "dispatch",
			priority: "normal",
		});
		store.close();

		const stub = makeRunTurnStub({ exitCode: 1, cleanResult: false });
		const result = await _runTurnRunnerTick(
			"fail-agent",
			fakeOptsFactory("fail-agent"),
			stub.runTurn,
			mailDbPath,
		);
		expect(result.kind).toBe("delivered");
		const checkStore = createMailStore(mailDbPath);
		try {
			expect(checkStore.getUnread("fail-agent").length).toBe(1);
		} finally {
			checkStore.close();
		}
	});

	test("does not mark messages read when runTurn throws", async () => {
		const store = createMailStore(mailDbPath);
		const client = createMailClient(store);
		client.send({
			from: "lead",
			to: "throw-agent",
			subject: "Boom",
			body: "Throw inside runTurn.",
			type: "dispatch",
			priority: "normal",
		});
		store.close();

		const result = await _runTurnRunnerTick(
			"throw-agent",
			fakeOptsFactory("throw-agent"),
			async () => {
				throw new Error("simulated spawn failure");
			},
			mailDbPath,
		);
		expect(result.kind).toBe("error");
		if (result.kind === "error") {
			expect(result.error).toBeInstanceOf(Error);
		}

		const checkStore = createMailStore(mailDbPath);
		try {
			expect(checkStore.getUnread("throw-agent").length).toBe(1);
		} finally {
			checkStore.close();
		}
	});

	test("idle tick when no unread mail does not invoke runTurn", async () => {
		const stub = makeRunTurnStub();
		const result = await _runTurnRunnerTick(
			"empty-agent",
			fakeOptsFactory("empty-agent"),
			stub.runTurn,
			mailDbPath,
		);
		expect(result.kind).toBe("idle");
		expect(stub.calls.length).toBe(0);
	});

	test("loop returns a stop function that prevents further runTurn invocations", async () => {
		const store = createMailStore(mailDbPath);
		const client = createMailClient(store);
		client.send({
			from: "lead",
			to: "loop-agent",
			subject: "Stop test",
			body: "Should be delivered once at most.",
			type: "dispatch",
			priority: "normal",
		});
		store.close();

		const stub = makeRunTurnStub();
		const stop = startTurnRunnerMailLoop(
			"loop-agent",
			fakeOptsFactory("loop-agent"),
			stub.runTurn,
			mailDbPath,
			60,
		);

		await new Promise((r) => setTimeout(r, 250));
		stop();
		const callsAfterStop = stub.calls.length;
		await new Promise((r) => setTimeout(r, 200));

		expect(stub.calls.length).toBe(callsAfterStop);
		// Should have been invoked at most once (mark-read + idle on subsequent tick).
		expect(callsAfterStop).toBeLessThanOrEqual(1);
		expect(callsAfterStop).toBeGreaterThan(0);
	});

	test("re-entrancy guard: second tick while first is in flight is a no-op", async () => {
		const store = createMailStore(mailDbPath);
		const client = createMailClient(store);
		client.send({
			from: "lead",
			to: "concurrency-agent",
			subject: "First",
			body: "First batch",
			type: "dispatch",
			priority: "normal",
		});
		store.close();

		// Block the first runTurn until we explicitly resolve it. While in flight,
		// any subsequent tick must short-circuit (the loop's in-flight guard).
		let resolveFirst!: () => void;
		const firstPromise = new Promise<void>((resolve) => {
			resolveFirst = resolve;
		});

		let calls = 0;
		const slowRun = async (_opts: RunTurnOpts): Promise<TurnResult> => {
			calls++;
			await firstPromise;
			return {
				exitCode: 0,
				cleanResult: true,
				newSessionId: null,
				resumeMismatch: false,
				workerDoneObserved: false,
				durationMs: 0,
				initialState: "booting",
				finalState: "working",
			};
		};

		const stop = startTurnRunnerMailLoop(
			"concurrency-agent",
			fakeOptsFactory("concurrency-agent"),
			slowRun,
			mailDbPath,
			30,
		);

		// Allow several ticks to fire while the first runTurn is still pending.
		await new Promise((r) => setTimeout(r, 150));
		expect(calls).toBe(1);

		resolveFirst();
		await new Promise((r) => setTimeout(r, 80));
		stop();

		// At most one extra retry tick after the first turn resolved (with the
		// only message already marked read). Allow ≤2 to keep the assertion
		// resilient to scheduler timing on slower CI runners.
		expect(calls).toBeLessThanOrEqual(2);
	});
});

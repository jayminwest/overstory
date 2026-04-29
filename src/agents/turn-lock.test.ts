import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	_resetInProcessLocks,
	acquireTurnLock,
	readTurnLock,
	turnLockDbPath,
} from "./turn-lock.ts";

describe("turn-lock", () => {
	let overstoryDir: string;

	beforeEach(async () => {
		overstoryDir = await mkdtemp(join(tmpdir(), "overstory-turnlock-test-"));
		_resetInProcessLocks();
	});

	afterEach(async () => {
		_resetInProcessLocks();
		await rm(overstoryDir, { recursive: true, force: true });
	});

	test("turnLockDbPath joins overstory dir + turn-locks.db", () => {
		expect(turnLockDbPath("/tmp/overstory")).toBe("/tmp/overstory/turn-locks.db");
	});

	test("acquire creates the row and records holder pid", async () => {
		const handle = await acquireTurnLock({ agentName: "alpha", overstoryDir });
		try {
			const state = readTurnLock(overstoryDir, "alpha");
			expect(state.heldByPid).toBe(process.pid);
			expect(state.acquiredAt).toBeTruthy();
		} finally {
			handle.release();
		}
	});

	test("release clears the row and is idempotent", async () => {
		const handle = await acquireTurnLock({ agentName: "alpha", overstoryDir });
		handle.release();
		// Calling release a second time must not throw.
		handle.release();
		const state = readTurnLock(overstoryDir, "alpha");
		expect(state.heldByPid).toBeNull();
		expect(state.acquiredAt).toBeNull();
	});

	test("two acquires for the same agent serialize via in-process queue", async () => {
		// Track entry/exit windows via timestamps. The second call must start
		// AFTER the first releases, never overlap.
		const events: Array<{ id: number; phase: "enter" | "exit"; ts: number }> = [];

		const work = async (id: number, holdMs: number): Promise<void> => {
			const handle = await acquireTurnLock({ agentName: "shared", overstoryDir });
			events.push({ id, phase: "enter", ts: Date.now() });
			await Bun.sleep(holdMs);
			events.push({ id, phase: "exit", ts: Date.now() });
			handle.release();
		};

		await Promise.all([work(1, 100), work(2, 50)]);

		// Sort events by timestamp; verify each acquire's enter follows the
		// previous holder's exit.
		const ordered = [...events].sort((a, b) => a.ts - b.ts);
		expect(ordered.length).toBe(4);
		expect(ordered[0]?.phase).toBe("enter");
		expect(ordered[1]?.phase).toBe("exit");
		expect(ordered[1]?.id).toBe(ordered[0]?.id);
		expect(ordered[2]?.phase).toBe("enter");
		expect(ordered[3]?.phase).toBe("exit");
		expect(ordered[3]?.id).toBe(ordered[2]?.id);
	});

	test("acquires for different agents proceed concurrently", async () => {
		// Both calls should overlap because the in-process map is keyed per agent.
		let active = 0;
		let maxActive = 0;
		const work = async (name: string): Promise<void> => {
			const handle = await acquireTurnLock({ agentName: name, overstoryDir });
			active++;
			maxActive = Math.max(maxActive, active);
			await Bun.sleep(80);
			active--;
			handle.release();
		};

		await Promise.all([work("alpha"), work("beta"), work("gamma")]);
		expect(maxActive).toBeGreaterThan(1);
	});

	test("stale lock (dead pid) is taken over by next acquirer", async () => {
		// Inject _isProcessAlive that says the recorded holder is gone.
		const handle = await acquireTurnLock({
			agentName: "stale",
			overstoryDir,
			ownerPid: 99999, // pretend we are this dead pid
			_isProcessAlive: () => true, // claim alive to plant the lock
		});
		// Don't call release() — we want the row to look orphaned.

		// Reset in-process locks so the next call is not blocked by the queue
		// from the same Bun process. Cross-process is what we are exercising.
		_resetInProcessLocks();

		const stolen = await acquireTurnLock({
			agentName: "stale",
			overstoryDir,
			ownerPid: 12345,
			_isProcessAlive: () => false, // prior holder reported dead
		});
		try {
			const state = readTurnLock(overstoryDir, "stale");
			expect(state.heldByPid).toBe(12345);
		} finally {
			stolen.release();
			// release() of the original handle would still be safe because the
			// row pid no longer matches its ownerPid (99999).
			handle.release();
		}
	});

	test("acquire times out when the lock is held by a live foreign pid", async () => {
		// Plant a lock owned by a different live pid (we say always-alive).
		const planted = await acquireTurnLock({
			agentName: "blocked",
			overstoryDir,
			ownerPid: 77777,
			_isProcessAlive: () => true,
		});
		// Intentionally do NOT release planted — keep the row active.

		_resetInProcessLocks();

		const start = Date.now();
		await expect(
			acquireTurnLock({
				agentName: "blocked",
				overstoryDir,
				ownerPid: 88888,
				_isProcessAlive: () => true,
				timeoutMs: 200,
				pollMs: 25,
			}),
		).rejects.toThrow(/timed out/);
		const elapsed = Date.now() - start;
		expect(elapsed).toBeGreaterThanOrEqual(150);

		planted.release();
	});

	test("re-acquire by the same owner pid is allowed (re-entrant by pid)", async () => {
		// First acquire records pid X. A subsequent acquire by the same pid
		// (after in-process queue clears) should succeed without timing out
		// even if the row still names X — this models recovery from a crashed
		// in-process holder where the SQLite row was never released.
		const first = await acquireTurnLock({
			agentName: "reentry",
			overstoryDir,
			ownerPid: 4242,
		});
		// Simulate an in-process crash that lost the in-process tail.
		_resetInProcessLocks();

		const second = await acquireTurnLock({
			agentName: "reentry",
			overstoryDir,
			ownerPid: 4242,
			timeoutMs: 500,
		});
		try {
			const state = readTurnLock(overstoryDir, "reentry");
			expect(state.heldByPid).toBe(4242);
		} finally {
			second.release();
			first.release();
		}
	});
});

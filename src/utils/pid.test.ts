import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTempDir } from "../test-helpers.ts";
import { acquirePidLock, readPidFile, removePidFile, writePidFile } from "./pid.ts";

let tempDir: string;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), "ov-pid-test-"));
});

afterEach(async () => {
	await cleanupTempDir(tempDir);
});

describe("readPidFile", () => {
	test("returns pid from valid file", async () => {
		const pidPath = join(tempDir, "test.pid");
		await Bun.write(pidPath, "12345\n");
		const pid = await readPidFile(pidPath);
		expect(pid).toBe(12345);
	});

	test("returns null for nonexistent file", async () => {
		const pid = await readPidFile(join(tempDir, "missing.pid"));
		expect(pid).toBeNull();
	});

	test("returns null for non-numeric content", async () => {
		const pidPath = join(tempDir, "bad.pid");
		await Bun.write(pidPath, "not-a-number\n");
		const pid = await readPidFile(pidPath);
		expect(pid).toBeNull();
	});

	test("returns null for negative pid", async () => {
		const pidPath = join(tempDir, "neg.pid");
		await Bun.write(pidPath, "-1\n");
		const pid = await readPidFile(pidPath);
		expect(pid).toBeNull();
	});
});

describe("writePidFile", () => {
	test("roundtrip write then read", async () => {
		const pidPath = join(tempDir, "roundtrip.pid");
		await writePidFile(pidPath, 42);
		const pid = await readPidFile(pidPath);
		expect(pid).toBe(42);
	});
});

describe("removePidFile", () => {
	test("removes existing file", async () => {
		const pidPath = join(tempDir, "remove.pid");
		await Bun.write(pidPath, "99\n");
		expect(await Bun.file(pidPath).exists()).toBe(true);
		await removePidFile(pidPath);
		expect(await Bun.file(pidPath).exists()).toBe(false);
	});

	test("does not throw for nonexistent file", async () => {
		await removePidFile(join(tempDir, "nope.pid"));
		// No throw = pass
	});
});

describe("acquirePidLock", () => {
	const alwaysAlive = (_pid: number) => true;
	const alwaysDead = (_pid: number) => false;

	test("acquires when no lock file exists", async () => {
		const pidPath = join(tempDir, "lock.pid");
		const result = await acquirePidLock(pidPath, 1234, alwaysAlive);
		expect(result.acquired).toBe(true);
		expect(await readPidFile(pidPath)).toBe(1234);
	});

	test("creates parent directory if missing", async () => {
		const pidPath = join(tempDir, "nested", "deeper", "lock.pid");
		const result = await acquirePidLock(pidPath, 555, alwaysAlive);
		expect(result.acquired).toBe(true);
		expect(await readPidFile(pidPath)).toBe(555);
	});

	test("refuses when a live foreign PID owns the lock", async () => {
		const pidPath = join(tempDir, "lock.pid");
		await Bun.write(pidPath, "9999\n");
		const result = await acquirePidLock(pidPath, 1234, alwaysAlive);
		expect(result.acquired).toBe(false);
		if (!result.acquired) {
			expect(result.existingPid).toBe(9999);
		}
		// File untouched.
		expect(await readPidFile(pidPath)).toBe(9999);
	});

	test("idempotent when file already contains caller's own PID", async () => {
		const pidPath = join(tempDir, "lock.pid");
		await Bun.write(pidPath, "1234\n");
		// alwaysAlive would say 1234 is alive, but acquirePidLock should detect
		// own-PID first and accept.
		const result = await acquirePidLock(pidPath, 1234, alwaysAlive);
		expect(result.acquired).toBe(true);
		expect(await readPidFile(pidPath)).toBe(1234);
	});

	test("reclaims stale lock with dead PID", async () => {
		const pidPath = join(tempDir, "lock.pid");
		await Bun.write(pidPath, "9999\n");
		const result = await acquirePidLock(pidPath, 1234, alwaysDead);
		expect(result.acquired).toBe(true);
		expect(await readPidFile(pidPath)).toBe(1234);
	});

	test("reclaims unreadable/corrupted lock file", async () => {
		const pidPath = join(tempDir, "lock.pid");
		await Bun.write(pidPath, "garbage-not-a-pid\n");
		const result = await acquirePidLock(pidPath, 1234, alwaysAlive);
		expect(result.acquired).toBe(true);
		expect(await readPidFile(pidPath)).toBe(1234);
	});

	test("two simultaneous acquirers — only one wins", async () => {
		const pidPath = join(tempDir, "lock.pid");
		const [a, b] = await Promise.all([
			acquirePidLock(pidPath, 1111, alwaysAlive),
			acquirePidLock(pidPath, 2222, alwaysAlive),
		]);
		const winners = [a, b].filter((r) => r.acquired);
		const losers = [a, b].filter((r) => !r.acquired);
		expect(winners.length).toBe(1);
		expect(losers.length).toBe(1);
		const loser = losers[0];
		if (loser && !loser.acquired) {
			expect([1111, 2222]).toContain(loser.existingPid);
		}
	});

	test("two simultaneous acquirers — file content matches the winner", async () => {
		const pidPath = join(tempDir, "lock.pid");
		const [a, b] = await Promise.all([
			acquirePidLock(pidPath, 1111, alwaysAlive),
			acquirePidLock(pidPath, 2222, alwaysAlive),
		]);
		const fileContent = await readPidFile(pidPath);
		const winnerPid = a.acquired ? 1111 : b.acquired ? 2222 : -1;
		expect(fileContent).toBe(winnerPid);
	});
});

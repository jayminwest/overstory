import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTempDir } from "../test-helpers.ts";
import { readPidFile, removePidFile, writePidFile } from "./pid.ts";

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

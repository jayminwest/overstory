import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MergeError } from "../errors.ts";
import { acquireMergeLock, mergeLockPath, sanitizeBranchForFilename } from "./lock.ts";

describe("sanitizeBranchForFilename", () => {
	test("replaces forward slashes with dashes", () => {
		expect(sanitizeBranchForFilename("feature/foo")).toBe("feature-foo");
		expect(sanitizeBranchForFilename("a/b/c")).toBe("a-b-c");
	});

	test("replaces backslashes and colons", () => {
		expect(sanitizeBranchForFilename("feature\\bar")).toBe("feature-bar");
		expect(sanitizeBranchForFilename("ns:branch")).toBe("ns-branch");
	});

	test("leaves simple branch names alone", () => {
		expect(sanitizeBranchForFilename("main")).toBe("main");
		expect(sanitizeBranchForFilename("develop_2")).toBe("develop_2");
	});
});

describe("mergeLockPath", () => {
	test("composes path under .overstory/ with sanitized branch", () => {
		expect(mergeLockPath("/tmp/.overstory", "feature/x")).toBe(
			"/tmp/.overstory/merge-feature-x.lock",
		);
	});
});

describe("acquireMergeLock", () => {
	let overstoryDir: string;

	beforeEach(async () => {
		overstoryDir = await mkdtemp(join(tmpdir(), "ov-merge-lock-"));
		await mkdir(overstoryDir, { recursive: true });
	});

	afterEach(async () => {
		await rm(overstoryDir, { recursive: true, force: true });
	});

	test("creates a lock file and returns a handle that removes it on release", () => {
		const handle = acquireMergeLock(overstoryDir, "main");
		expect(existsSync(handle.path)).toBe(true);

		const payload = JSON.parse(readFileSync(handle.path, "utf8"));
		expect(payload.pid).toBe(process.pid);
		expect(payload.targetBranch).toBe("main");
		expect(typeof payload.acquiredAt).toBe("string");

		handle.release();
		expect(existsSync(handle.path)).toBe(false);
	});

	test("release() is idempotent", () => {
		const handle = acquireMergeLock(overstoryDir, "main");
		handle.release();
		handle.release(); // should not throw
		expect(existsSync(handle.path)).toBe(false);
	});

	test("throws MergeError when lock is held by a live process", () => {
		// Use this test process's own PID — it is guaranteed live.
		const path = mergeLockPath(overstoryDir, "main");
		writeFileSync(
			path,
			JSON.stringify({
				pid: process.pid,
				acquiredAt: new Date().toISOString(),
				targetBranch: "main",
			}),
		);

		try {
			acquireMergeLock(overstoryDir, "main");
			expect(true).toBe(false); // should not reach
		} catch (err: unknown) {
			expect(err).toBeInstanceOf(MergeError);
			const msg = (err as MergeError).message;
			expect(msg).toContain("Another ov merge is already running");
			expect(msg).toContain(`pid ${process.pid}`);
			expect(msg).toContain("main");
		}

		// Lock file is still on disk — we did not steal it.
		expect(existsSync(path)).toBe(true);
	});

	test("steals a stale lock whose PID is not alive", () => {
		const path = mergeLockPath(overstoryDir, "main");
		// PID 2147483647 is INT_MAX — extremely unlikely to be in use.
		writeFileSync(
			path,
			JSON.stringify({
				pid: 2147483647,
				acquiredAt: new Date(Date.now() - 60_000).toISOString(),
				targetBranch: "main",
			}),
		);

		const handle = acquireMergeLock(overstoryDir, "main");
		const payload = JSON.parse(readFileSync(handle.path, "utf8"));
		expect(payload.pid).toBe(process.pid);
		handle.release();
	});

	test("steals an unparseable lock file", () => {
		const path = mergeLockPath(overstoryDir, "main");
		writeFileSync(path, "not json");

		const handle = acquireMergeLock(overstoryDir, "main");
		const payload = JSON.parse(readFileSync(handle.path, "utf8"));
		expect(payload.pid).toBe(process.pid);
		handle.release();
	});

	test("locks on different target branches are independent", () => {
		const a = acquireMergeLock(overstoryDir, "main");
		const b = acquireMergeLock(overstoryDir, "develop");
		expect(existsSync(a.path)).toBe(true);
		expect(existsSync(b.path)).toBe(true);
		expect(a.path).not.toBe(b.path);
		a.release();
		b.release();
	});

	test("error message includes path so operator can manually clear", () => {
		const path = mergeLockPath(overstoryDir, "main");
		writeFileSync(
			path,
			JSON.stringify({
				pid: process.pid,
				acquiredAt: new Date().toISOString(),
				targetBranch: "main",
			}),
		);

		try {
			acquireMergeLock(overstoryDir, "main");
			expect(true).toBe(false);
		} catch (err: unknown) {
			expect((err as MergeError).message).toContain(path);
		}
	});
});

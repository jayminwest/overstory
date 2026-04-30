/**
 * Tests for ensureUiBuild auto-build helper.
 *
 * Real filesystem (temp dirs + utimesSync) drives the freshness comparison;
 * the runner is always stubbed so we never invoke a real bun install/build.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureUiBuild, type RunnerResult } from "./build.ts";

interface RunnerCall {
	cmd: string[];
	cwd: string;
}

function makeRunner(results: RunnerResult[]): {
	runner: (cmd: string[], cwd: string) => Promise<RunnerResult>;
	calls: RunnerCall[];
} {
	const calls: RunnerCall[] = [];
	let i = 0;
	return {
		calls,
		runner: async (cmd, cwd) => {
			calls.push({ cmd, cwd });
			const r = results[i] ?? { exitCode: 0, stderr: "" };
			i += 1;
			return r;
		},
	};
}

function setupUiDir(root: string): { uiDir: string } {
	const uiDir = join(root, "ui");
	mkdirSync(join(uiDir, "src"), { recursive: true });
	writeFileSync(join(uiDir, "src", "main.ts"), 'console.log("hi")');
	writeFileSync(join(uiDir, "index.html"), "<html></html>");
	writeFileSync(join(uiDir, "package.json"), '{"name":"ui"}');
	return { uiDir };
}

describe("ensureUiBuild", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "overstory-ui-build-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	test("triggers build when dist/index.html is missing", async () => {
		const { uiDir } = setupUiDir(tempDir);
		// Pretend node_modules already exists so we skip install.
		mkdirSync(join(uiDir, "node_modules"));

		const { runner, calls } = makeRunner([{ exitCode: 0, stderr: "" }]);
		await ensureUiBuild({ uiDir, _runner: runner, log: () => {} });

		expect(calls.length).toBe(1);
		expect(calls[0]?.cmd).toEqual(["bun", "run", "build"]);
		expect(calls[0]?.cwd).toBe(uiDir);
	});

	test("triggers build when source mtime is newer than dist mtime", async () => {
		const { uiDir } = setupUiDir(tempDir);
		mkdirSync(join(uiDir, "node_modules"));
		mkdirSync(join(uiDir, "dist"));
		writeFileSync(join(uiDir, "dist", "index.html"), "<html>old</html>");

		// Make dist older, src newer (definite mtime separation).
		const past = new Date(Date.now() - 60_000);
		const future = new Date(Date.now() + 60_000);
		utimesSync(join(uiDir, "dist", "index.html"), past, past);
		utimesSync(join(uiDir, "src", "main.ts"), future, future);

		const { runner, calls } = makeRunner([{ exitCode: 0, stderr: "" }]);
		await ensureUiBuild({ uiDir, _runner: runner, log: () => {} });

		expect(calls.length).toBe(1);
		expect(calls[0]?.cmd).toEqual(["bun", "run", "build"]);
	});

	test("skips build when dist is newer than every source file", async () => {
		const { uiDir } = setupUiDir(tempDir);
		mkdirSync(join(uiDir, "node_modules"));
		mkdirSync(join(uiDir, "dist"));
		writeFileSync(join(uiDir, "dist", "index.html"), "<html>fresh</html>");

		// All sources older than dist.
		const past = new Date(Date.now() - 60_000);
		utimesSync(join(uiDir, "src", "main.ts"), past, past);
		utimesSync(join(uiDir, "index.html"), past, past);
		utimesSync(join(uiDir, "package.json"), past, past);
		// Dist is "now" — already the newest.

		const { runner, calls } = makeRunner([]);
		await ensureUiBuild({ uiDir, _runner: runner, log: () => {} });

		expect(calls.length).toBe(0);
	});

	test("runs install only when node_modules is missing", async () => {
		const { uiDir } = setupUiDir(tempDir);
		// node_modules deliberately missing.

		const { runner, calls } = makeRunner([
			{ exitCode: 0, stderr: "" }, // install
			{ exitCode: 0, stderr: "" }, // build
		]);
		await ensureUiBuild({ uiDir, _runner: runner, log: () => {} });

		expect(calls.length).toBe(2);
		expect(calls[0]?.cmd).toEqual(["bun", "install"]);
		expect(calls[0]?.cwd).toBe(uiDir);
		expect(calls[1]?.cmd).toEqual(["bun", "run", "build"]);
	});

	test("does NOT run install when node_modules exists", async () => {
		const { uiDir } = setupUiDir(tempDir);
		mkdirSync(join(uiDir, "node_modules"));

		const { runner, calls } = makeRunner([{ exitCode: 0, stderr: "" }]);
		await ensureUiBuild({ uiDir, _runner: runner, log: () => {} });

		expect(calls.length).toBe(1);
		expect(calls[0]?.cmd).toEqual(["bun", "run", "build"]);
	});

	test("throws on non-zero install exit; error includes stderr", async () => {
		const { uiDir } = setupUiDir(tempDir);

		const { runner } = makeRunner([{ exitCode: 1, stderr: "lockfile out of date" }]);

		await expect(ensureUiBuild({ uiDir, _runner: runner, log: () => {} })).rejects.toThrow(
			/lockfile out of date/,
		);
	});

	test("throws on non-zero build exit; error includes stderr", async () => {
		const { uiDir } = setupUiDir(tempDir);
		mkdirSync(join(uiDir, "node_modules"));

		const { runner } = makeRunner([{ exitCode: 2, stderr: "type error in main.ts" }]);

		await expect(ensureUiBuild({ uiDir, _runner: runner, log: () => {} })).rejects.toThrow(
			/type error in main\.ts/,
		);
	});

	test("logs progress messages on build path", async () => {
		const { uiDir } = setupUiDir(tempDir);
		// node_modules missing → install + build → 3 log lines (install, build, built).
		const messages: string[] = [];
		const { runner } = makeRunner([
			{ exitCode: 0, stderr: "" },
			{ exitCode: 0, stderr: "" },
		]);
		await ensureUiBuild({ uiDir, _runner: runner, log: (m) => messages.push(m) });

		expect(messages).toEqual(["Installing UI dependencies…", "Building UI…", "UI built"]);
	});

	test("no-ops when ui/src is absent (production-install case)", async () => {
		// No setupUiDir() — tempDir has no ui/ at all, mirroring a fresh `ov init`
		// in a project that doesn't carry a UI workspace (overstory-916d).
		const uiDir = join(tempDir, "ui");

		const messages: string[] = [];
		const { runner, calls } = makeRunner([]);
		await ensureUiBuild({ uiDir, _runner: runner, log: (m) => messages.push(m) });

		// Neither install nor build runs, and no progress messages are emitted.
		expect(calls.length).toBe(0);
		expect(messages.length).toBe(0);
	});

	test("walks ui/src/ recursively and triggers on nested-file mtime", async () => {
		const { uiDir } = setupUiDir(tempDir);
		mkdirSync(join(uiDir, "node_modules"));
		mkdirSync(join(uiDir, "src", "components"), { recursive: true });
		writeFileSync(join(uiDir, "src", "components", "App.tsx"), "export default null;");
		mkdirSync(join(uiDir, "dist"));
		writeFileSync(join(uiDir, "dist", "index.html"), "<html>old</html>");

		// dist older than the nested file.
		const past = new Date(Date.now() - 60_000);
		const future = new Date(Date.now() + 60_000);
		utimesSync(join(uiDir, "dist", "index.html"), past, past);
		utimesSync(join(uiDir, "src", "main.ts"), past, past);
		utimesSync(join(uiDir, "src", "components", "App.tsx"), future, future);

		const { runner, calls } = makeRunner([{ exitCode: 0, stderr: "" }]);
		await ensureUiBuild({ uiDir, _runner: runner, log: () => {} });

		expect(calls.length).toBe(1);
	});
});

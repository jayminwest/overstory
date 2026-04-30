import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTempDir } from "../test-helpers.ts";
import type { HealthCheck } from "../types.ts";
import { formatCheck, watchCommand } from "./watch.ts";

/**
 * Tests for `overstory watch` command.
 *
 * IMPORTANT: We CANNOT test the actual daemon loop (it would hang the test).
 * Focus on:
 * - Help output (safe, returns immediately)
 * - Background mode: already-running detection
 * - Background mode: stale PID cleanup
 *
 * We do NOT test:
 * - Foreground mode (blocks forever with await new Promise(() => {}))
 * - Actual health check loop behavior
 */

describe("watchCommand", () => {
	let chunks: string[];
	let stderrChunks: string[];
	let originalWrite: typeof process.stdout.write;
	let originalStderrWrite: typeof process.stderr.write;
	let tempDir: string;
	let originalCwd: string;

	beforeEach(async () => {
		// Spy on stdout
		chunks = [];
		originalWrite = process.stdout.write;
		process.stdout.write = ((chunk: string) => {
			chunks.push(chunk);
			return true;
		}) as typeof process.stdout.write;

		// Spy on stderr
		stderrChunks = [];
		originalStderrWrite = process.stderr.write;
		process.stderr.write = ((chunk: string) => {
			stderrChunks.push(chunk);
			return true;
		}) as typeof process.stderr.write;

		process.exitCode = 0;

		// Create temp dir with .overstory/config.yaml structure
		tempDir = await mkdtemp(join(tmpdir(), "watch-test-"));
		const overstoryDir = join(tempDir, ".overstory");
		await Bun.write(
			join(overstoryDir, "config.yaml"),
			`project:\n  name: test\n  root: ${tempDir}\n  canonicalBranch: main\n`,
		);

		// Change to temp dir so loadConfig() works
		originalCwd = process.cwd();
		process.chdir(tempDir);
	});

	afterEach(async () => {
		process.stdout.write = originalWrite;
		process.stderr.write = originalStderrWrite;
		// Unconditionally clear to 0 rather than restoring a captured "original" that
		// could itself have been polluted by a parallel test file in the same bun
		// process. `watchCommand` sets `process.exitCode = 1` as a side effect, so
		// without this clear the 1 can leak all the way to bun test's shutdown and
		// turn a fully-green run into exit 1.
		process.exitCode = 0;
		process.chdir(originalCwd);
		await cleanupTempDir(tempDir);
	});

	function output(): string {
		return chunks.join("");
	}

	function stderr(): string {
		return stderrChunks.join("");
	}

	test("--help flag shows help text with key info", async () => {
		await watchCommand(["--help"]);
		const out = output();

		expect(out).toContain("watch");
		expect(out).toContain("--interval");
		expect(out).toContain("--background");
		expect(out).toContain("--kill-others");
		expect(out).toContain("Tier 0");
	});

	test("-h flag shows help text", async () => {
		await watchCommand(["-h"]);
		const out = output();

		expect(out).toContain("watch");
		expect(out).toContain("Tier 0");
	});

	test("background mode: already running detection", async () => {
		// Write a PID file with a running process (use our own PID)
		const pidFilePath = join(tempDir, ".overstory", "watchdog.pid");
		await Bun.write(pidFilePath, `${process.pid}\n`);

		// Try to start in background mode — should fail with "already running"
		await watchCommand(["--background"]);

		const err = stderr();
		expect(err).toContain("already running");
		expect(err).toContain(`${process.pid}`);
		expect(process.exitCode).toBe(1);
	});

	test("foreground mode: refuses when a live foreign PID owns the lock", async () => {
		// Spawn a long-running child to act as the "foreign live process". Its
		// PID will not match our own, so acquirePidLock should refuse rather
		// than treat the existing PID as idempotent self-ownership. The
		// foreground path used to overwrite this file unconditionally — the
		// overstory-8ef6 fix forces it to refuse.
		const sleeper = Bun.spawn(["sleep", "30"], {
			stdout: "ignore",
			stderr: "ignore",
		});
		try {
			const pidFilePath = join(tempDir, ".overstory", "watchdog.pid");
			await Bun.write(pidFilePath, `${sleeper.pid}\n`);

			// --json for structured output. No --background, so this exercises
			// the foreground exclusion path. A correctly contested lock returns
			// immediately (exit 1) without starting the daemon loop.
			await watchCommand(["--json"]);

			const out = output();
			const jsonLine = out
				.split("\n")
				.map((l) => l.trim())
				.find((l) => l.startsWith("{"));
			expect(jsonLine).toBeDefined();
			if (jsonLine) {
				const parsed = JSON.parse(jsonLine);
				expect(parsed.running).toBe(true);
				expect(parsed.pid).toBe(sleeper.pid);
				expect(parsed.error).toContain("already running");
			}
			expect(process.exitCode).toBe(1);

			// PID file untouched — still the foreign owner's PID.
			const fileContent = await Bun.file(pidFilePath).text();
			expect(fileContent.trim()).toBe(`${sleeper.pid}`);
		} finally {
			sleeper.kill("SIGTERM");
			await sleeper.exited.catch(() => {});
		}
	});

	test("background mode: stale PID cleanup", async () => {
		// Write a PID file with a non-running process (999999 is very unlikely to exist)
		const pidFilePath = join(tempDir, ".overstory", "watchdog.pid");
		await Bun.write(pidFilePath, "999999\n");

		// Verify the stale PID file exists before the test
		const fileBeforeExists = await Bun.file(pidFilePath).exists();
		expect(fileBeforeExists).toBe(true);

		// Try to start in background mode
		// This will clean up the stale PID file, then attempt to spawn.
		// The spawn will fail because there's no real overstory binary in test env,
		// but the important part is that the stale PID file gets removed.
		try {
			await watchCommand(["--background"]);
		} catch {
			// Expected to fail when trying to spawn — that's OK
		}

		// The stale PID file should have been removed during the check
		// (Even if the spawn itself failed, the cleanup happens before spawn)
		// Actually, looking at the code: if existingPid is not null but not running,
		// it removes the PID file. Then it tries to spawn. So the file should be gone
		// OR replaced with a new PID.

		// Let's check: the file should either not exist, OR contain a different PID
		const fileAfterExists = await Bun.file(pidFilePath).exists();
		if (fileAfterExists) {
			const content = await Bun.file(pidFilePath).text();
			expect(content.trim()).not.toBe("999999");
		}
		// If it doesn't exist, that's also valid (spawn failed before writing new PID)
	});
});

describe("formatCheck", () => {
	function makeCheck(overrides: Partial<HealthCheck>): HealthCheck {
		return {
			agentName: "test-agent",
			timestamp: new Date().toISOString(),
			processAlive: true,
			tmuxAlive: true,
			pidAlive: true,
			lastActivity: new Date().toISOString(),
			state: "working",
			action: "none",
			reconciliationNote: null,
			...overrides,
		};
	}

	test("terminate action uses x icon", () => {
		const result = formatCheck(makeCheck({ action: "terminate" }));
		expect(result).toMatch(/^x /);
	});

	test("escalate action uses ! icon", () => {
		const result = formatCheck(makeCheck({ action: "escalate" }));
		expect(result).toMatch(/^! /);
	});

	test("investigate action uses > icon", () => {
		const result = formatCheck(makeCheck({ action: "investigate" }));
		expect(result).toMatch(/^> /);
	});

	test("pidAlive true shows up", () => {
		const result = formatCheck(makeCheck({ pidAlive: true }));
		expect(result).toContain("pid=up");
	});

	test("pidAlive false shows down", () => {
		const result = formatCheck(makeCheck({ pidAlive: false }));
		expect(result).toContain("pid=down");
	});

	test("pidAlive null shows n/a", () => {
		const result = formatCheck(makeCheck({ pidAlive: null }));
		expect(result).toContain("pid=n/a");
	});

	test("includes reconciliation note when present", () => {
		const result = formatCheck(makeCheck({ reconciliationNote: "stale session" }));
		expect(result).toContain("[stale session]");
	});

	test("no reconciliation note brackets when null", () => {
		const result = formatCheck(makeCheck({ reconciliationNote: null }));
		expect(result).not.toContain("[");
	});

	test("includes agent name and state", () => {
		const result = formatCheck(makeCheck({ agentName: "builder-1", state: "stalled" }));
		expect(result).toContain("builder-1");
		expect(result).toContain("stalled");
	});
});

// PID and bin utility tests moved to src/utils/pid.test.ts and src/utils/bin.test.ts

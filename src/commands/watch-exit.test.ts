import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionStore } from "../sessions/store.ts";
import { cleanupTempDir } from "../test-helpers.ts";
import type { AgentSession } from "../types.ts";
import { isProcessAlive, runWatchExit } from "./watch-exit.ts";

/**
 * Tests for the `__watch-exit` command (overstory-267e).
 *
 * The watcher polls a PID until the process dies, then runs
 * finalizeHeadlessSession. Tests focus on the polling + finalization handoff.
 */

function buildSession(overrides: Partial<AgentSession>): AgentSession {
	return {
		id: `session-${Date.now()}`,
		agentName: "watch-test",
		capability: "builder",
		worktreePath: "/tmp/wt",
		branchName: "overstory/test/agent",
		taskId: "task-1",
		tmuxSession: "",
		state: "working",
		pid: 12345,
		parentAgent: null,
		depth: 0,
		runId: "run-1",
		startedAt: new Date().toISOString(),
		lastActivity: new Date().toISOString(),
		escalationLevel: 0,
		stalledSince: null,
		transcriptPath: null,
		...overrides,
	};
}

describe("isProcessAlive", () => {
	test("returns true for the current process", () => {
		expect(isProcessAlive(process.pid)).toBe(true);
	});

	test("returns false for a PID that cannot exist", () => {
		// PID 0 is not a real process; kill(0, 0) returns ESRCH on macOS/Linux.
		// Some kernels treat it specially (process group), so use a sentinel that's
		// guaranteed to be unused: a very large 32-bit value.
		expect(isProcessAlive(0x7fffffff)).toBe(false);
	});
});

describe("runWatchExit", () => {
	let tempDir: string;
	let overstoryDir: string;
	let originalCwd: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "watch-exit-"));
		overstoryDir = join(tempDir, ".overstory");
		await mkdir(overstoryDir, { recursive: true });
		await Bun.write(
			join(overstoryDir, "config.yaml"),
			`project:\n  name: test\n  root: ${tempDir}\n  canonicalBranch: main\n`,
		);
		originalCwd = process.cwd();
		process.chdir(tempDir);
	});

	afterEach(async () => {
		process.chdir(originalCwd);
		await cleanupTempDir(tempDir);
	});

	test("returns immediately and finalizes when the PID is already dead", async () => {
		const dbPath = join(overstoryDir, "sessions.db");
		const store = createSessionStore(dbPath);
		store.upsert(buildSession({ agentName: "already-dead" }));
		store.close();

		// Use a guaranteed-dead PID
		const start = Date.now();
		await runWatchExit({
			pid: 0x7fffffff,
			agent: "already-dead",
			pollMs: 100,
		});
		const elapsed = Date.now() - start;

		// Should not have polled — finalize runs on the first iteration.
		expect(elapsed).toBeLessThan(500);

		const readStore = createSessionStore(dbPath);
		const session = readStore.getByName("already-dead");
		readStore.close();
		expect(session?.state).toBe("completed");
	});

	test("waits for the process to die, then finalizes", async () => {
		const dbPath = join(overstoryDir, "sessions.db");
		const store = createSessionStore(dbPath);
		store.upsert(buildSession({ agentName: "spawned-child" }));
		store.close();

		// Spawn a short-lived child that exits in ~250ms.
		const child = Bun.spawn(["sh", "-c", "sleep 0.25"], {
			stdout: "ignore",
			stderr: "ignore",
		});
		const childPid = child.pid;

		const watcher = runWatchExit({
			pid: childPid,
			agent: "spawned-child",
			pollMs: 100,
		});

		await child.exited;
		await watcher;

		const readStore = createSessionStore(dbPath);
		const session = readStore.getByName("spawned-child");
		readStore.close();

		expect(session?.state).toBe("completed");
	});
});

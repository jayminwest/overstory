/**
 * Tests for overstory stop command.
 *
 * Uses real temp directories and real git repos for file I/O and config loading.
 * Tmux and worktree operations are injected via the StopDeps DI interface instead of
 * mock.module() to avoid the process-global mock leak issue
 * (see mulch record mx-56558b).
 *
 * WHY DI instead of mock.module: mock.module() in bun:test is process-global
 * and leaks across test files. The DI approach (same pattern as coordinator.ts)
 * ensures mocks are scoped to each test invocation.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { AgentError, ValidationError } from "../errors.ts";
import { openSessionStore } from "../sessions/compat.ts";
import { cleanupTempDir, createTempGitRepo } from "../test-helpers.ts";
import type { AgentSession } from "../types.ts";
import { type StopDeps, stopCommand } from "./stop.ts";

// --- Fake Git (for branch deletion) ---

interface GitCallTracker {
	deleteBranch: Array<{ repoRoot: string; branch: string }>;
}

function makeFakeGit(shouldSucceed = true): {
	git: NonNullable<StopDeps["_git"]>;
	calls: GitCallTracker;
} {
	const calls: GitCallTracker = { deleteBranch: [] };
	const git: NonNullable<StopDeps["_git"]> = {
		deleteBranch: async (repoRoot: string, branch: string): Promise<boolean> => {
			calls.deleteBranch.push({ repoRoot, branch });
			return shouldSucceed;
		},
	};
	return { git, calls };
}

// --- Fake Process (for headless agents) ---

/** Track calls to fake process for assertions. */
interface ProcessCallTracker {
	isAlive: Array<{ pid: number; result: boolean }>;
	killTree: Array<{ pid: number }>;
}

/** Build a fake process DI object with configurable PID liveness. */
function makeFakeProcess(pidAliveMap: Record<number, boolean> = {}): {
	proc: NonNullable<StopDeps["_process"]>;
	calls: ProcessCallTracker;
} {
	const calls: ProcessCallTracker = {
		isAlive: [],
		killTree: [],
	};

	const proc: NonNullable<StopDeps["_process"]> = {
		isAlive: (pid: number): boolean => {
			const alive = pidAliveMap[pid] ?? false;
			calls.isAlive.push({ pid, result: alive });
			return alive;
		},
		killTree: async (pid: number): Promise<void> => {
			calls.killTree.push({ pid });
		},
	};

	return { proc, calls };
}

// --- Fake Tmux ---

/** Track calls to fake tmux for assertions. */
interface TmuxCallTracker {
	isSessionAlive: Array<{ name: string; result: boolean }>;
	killSession: Array<{ name: string }>;
}

/** Build a fake tmux DI object with configurable session liveness. */
function makeFakeTmux(sessionAliveMap: Record<string, boolean> = {}): {
	tmux: NonNullable<StopDeps["_tmux"]>;
	calls: TmuxCallTracker;
} {
	const calls: TmuxCallTracker = {
		isSessionAlive: [],
		killSession: [],
	};

	const tmux: NonNullable<StopDeps["_tmux"]> = {
		isSessionAlive: async (name: string): Promise<boolean> => {
			const alive = sessionAliveMap[name] ?? false;
			calls.isSessionAlive.push({ name, result: alive });
			return alive;
		},
		killSession: async (name: string): Promise<void> => {
			calls.killSession.push({ name });
		},
	};

	return { tmux, calls };
}

// --- Fake Worktree ---

/** Track calls to fake worktree for assertions. */
interface WorktreeCallTracker {
	remove: Array<{
		repoRoot: string;
		path: string;
		options?: { force?: boolean; forceBranch?: boolean };
	}>;
}

/** Build a fake worktree DI object with configurable success/failure. */
function makeFakeWorktree(shouldFail = false): {
	worktree: NonNullable<StopDeps["_worktree"]>;
	calls: WorktreeCallTracker;
} {
	const calls: WorktreeCallTracker = { remove: [] };

	const worktree: NonNullable<StopDeps["_worktree"]> = {
		remove: async (
			repoRoot: string,
			path: string,
			options?: { force?: boolean; forceBranch?: boolean },
		): Promise<void> => {
			calls.remove.push({ repoRoot, path, options });
			if (shouldFail) {
				throw new Error("worktree removal failed");
			}
		},
	};

	return { worktree, calls };
}

// --- Test Setup ---

let tempDir: string;
let overstoryDir: string;
const originalCwd = process.cwd();

/** Save sessions to the SessionStore (sessions.db) for test setup. */
function saveSessionsToDb(sessions: AgentSession[]): void {
	const { store } = openSessionStore(overstoryDir);
	try {
		for (const session of sessions) {
			store.upsert(session);
		}
	} finally {
		store.close();
	}
}

beforeEach(async () => {
	process.chdir(originalCwd);

	tempDir = await realpath(await createTempGitRepo());
	overstoryDir = join(tempDir, ".overstory");
	await mkdir(overstoryDir, { recursive: true });

	// Write a minimal config.yaml so loadConfig succeeds
	await Bun.write(
		join(overstoryDir, "config.yaml"),
		["project:", "  name: test-project", `  root: ${tempDir}`, "  canonicalBranch: main"].join(
			"\n",
		),
	);

	// Override cwd so stop commands find our temp project
	process.chdir(tempDir);
});

afterEach(async () => {
	process.chdir(originalCwd);
	await cleanupTempDir(tempDir);
});

// --- Helpers ---

function makeAgentSession(overrides: Partial<AgentSession> = {}): AgentSession {
	return {
		id: `session-${Date.now()}-my-builder`,
		agentName: "my-builder",
		capability: "builder",
		runtime: "claude",
		worktreePath: join(tempDir, ".overstory", "worktrees", "my-builder"),
		branchName: "overstory/my-builder/bead-123",
		taskId: "bead-123",
		tmuxSession: "overstory-test-project-my-builder",
		state: "working",
		pid: 99999,
		parentAgent: null,
		depth: 2,
		runId: null,
		startedAt: new Date().toISOString(),
		lastActivity: new Date().toISOString(),
		escalationLevel: 0,
		stalledSince: null,
		rateLimitedSince: null,
		transcriptPath: null,
		...overrides,
	};
}

/** Capture stdout.write output during a function call. */
async function captureStdout(fn: () => Promise<void>): Promise<string> {
	const chunks: string[] = [];
	const originalWrite = process.stdout.write;
	process.stdout.write = ((chunk: string) => {
		chunks.push(chunk);
		return true;
	}) as typeof process.stdout.write;
	try {
		await fn();
	} finally {
		process.stdout.write = originalWrite;
	}
	return chunks.join("");
}

/** Capture stderr.write output during a function call. */
async function captureStderr(fn: () => Promise<void>): Promise<{ stderr: string; stdout: string }> {
	const stderrChunks: string[] = [];
	const stdoutChunks: string[] = [];
	const origStderr = process.stderr.write;
	const origStdout = process.stdout.write;
	process.stderr.write = ((chunk: string) => {
		stderrChunks.push(chunk);
		return true;
	}) as typeof process.stderr.write;
	process.stdout.write = ((chunk: string) => {
		stdoutChunks.push(chunk);
		return true;
	}) as typeof process.stdout.write;
	try {
		await fn();
	} finally {
		process.stderr.write = origStderr;
		process.stdout.write = origStdout;
	}
	return { stderr: stderrChunks.join(""), stdout: stdoutChunks.join("") };
}

/** Build default deps with fake tmux, worktree, and git. */
function makeDeps(
	sessionAliveMap: Record<string, boolean> = {},
	worktreeConfig?: { shouldFail?: boolean },
	gitConfig?: { shouldSucceed?: boolean },
): {
	deps: StopDeps;
	tmuxCalls: TmuxCallTracker;
	worktreeCalls: WorktreeCallTracker;
	gitCalls: GitCallTracker;
} {
	const { tmux, calls: tmuxCalls } = makeFakeTmux(sessionAliveMap);
	const { worktree, calls: worktreeCalls } = makeFakeWorktree(worktreeConfig?.shouldFail);
	const { git, calls: gitCalls } = makeFakeGit(gitConfig?.shouldSucceed ?? true);
	return {
		deps: { _tmux: tmux, _worktree: worktree, _git: git },
		tmuxCalls,
		worktreeCalls,
		gitCalls,
	};
}

// --- Tests ---

describe("stopCommand validation", () => {
	test("throws ValidationError when agent name is empty string", async () => {
		const { deps } = makeDeps();
		await expect(stopCommand("", {}, deps)).rejects.toThrow(ValidationError);
	});

	test("throws AgentError when agent not found", async () => {
		const { deps } = makeDeps();
		await expect(stopCommand("nonexistent-agent", {}, deps)).rejects.toThrow(AgentError);
	});

	test("throws AgentError when agent is already completed (without --clean-worktree)", async () => {
		const session = makeAgentSession({ state: "completed" });
		saveSessionsToDb([session]);

		const { deps } = makeDeps();
		await expect(stopCommand("my-builder", {}, deps)).rejects.toThrow(AgentError);
		await expect(stopCommand("my-builder", {}, deps)).rejects.toThrow(/already completed/);
		await expect(stopCommand("my-builder", {}, deps)).rejects.toThrow(/--clean-worktree/);
	});

	test("succeeds when agent is zombie (cleanup, no error)", async () => {
		const session = makeAgentSession({ state: "zombie" });
		saveSessionsToDb([session]);

		const { deps } = makeDeps({ [session.tmuxSession]: false });
		const output = await captureStdout(() => stopCommand("my-builder", {}, deps));

		expect(output).toContain("Agent stopped");
		expect(output).toContain("Zombie agent cleaned up");

		const { store } = openSessionStore(overstoryDir);
		const updated = store.getByName("my-builder");
		store.close();
		expect(updated?.state).toBe("completed");
	});
});

describe("stopCommand zombie cleanup", () => {
	test("zombie + --clean-worktree removes worktree", async () => {
		const session = makeAgentSession({ state: "zombie" });
		saveSessionsToDb([session]);

		const { deps, worktreeCalls } = makeDeps({ [session.tmuxSession]: false });
		const output = await captureStdout(() =>
			stopCommand("my-builder", { cleanWorktree: true }, deps),
		);

		expect(output).toContain("Agent stopped");
		expect(output).toContain("Zombie agent cleaned up");
		expect(output).toContain(`Worktree removed: ${session.worktreePath}`);
		expect(worktreeCalls.remove).toHaveLength(1);

		const { store } = openSessionStore(overstoryDir);
		const updated = store.getByName("my-builder");
		store.close();
		expect(updated?.state).toBe("completed");
	});

	test("zombie + --json includes wasZombie: true", async () => {
		const session = makeAgentSession({ state: "zombie" });
		saveSessionsToDb([session]);

		const { deps } = makeDeps({ [session.tmuxSession]: false });
		const output = await captureStdout(() => stopCommand("my-builder", { json: true }, deps));

		const parsed = JSON.parse(output.trim()) as Record<string, unknown>;
		expect(parsed.success).toBe(true);
		expect(parsed.stopped).toBe(true);
		expect(parsed.wasZombie).toBe(true);
		expect(parsed.agentName).toBe("my-builder");

		const { store } = openSessionStore(overstoryDir);
		const updated = store.getByName("my-builder");
		store.close();
		expect(updated?.state).toBe("completed");
	});
});

describe("stopCommand completed agent cleanup", () => {
	test("completed + --clean-worktree removes worktree and branch", async () => {
		const session = makeAgentSession({ state: "completed" });
		saveSessionsToDb([session]);

		const { deps, tmuxCalls, worktreeCalls, gitCalls } = makeDeps();
		const output = await captureStdout(() =>
			stopCommand("my-builder", { cleanWorktree: true }, deps),
		);

		expect(output).toContain("Agent stopped");
		expect(output).toContain("already completed");
		expect(output).toContain(`Worktree removed`);
		expect(output).toContain(`Branch deleted`);

		// No kill operations
		expect(tmuxCalls.isSessionAlive).toHaveLength(0);
		expect(tmuxCalls.killSession).toHaveLength(0);

		// Worktree removed
		expect(worktreeCalls.remove).toHaveLength(1);

		// Branch deleted
		expect(gitCalls.deleteBranch).toHaveLength(1);
		expect(gitCalls.deleteBranch[0]?.branch).toBe(session.branchName);
	});

	test("completed + --clean-worktree + --json includes wasCompleted: true", async () => {
		const session = makeAgentSession({ state: "completed" });
		saveSessionsToDb([session]);

		const { deps } = makeDeps();
		const output = await captureStdout(() =>
			stopCommand("my-builder", { cleanWorktree: true, json: true }, deps),
		);

		const parsed = JSON.parse(output.trim()) as Record<string, unknown>;
		expect(parsed.success).toBe(true);
		expect(parsed.stopped).toBe(true);
		expect(parsed.wasCompleted).toBe(true);
		expect(parsed.tmuxKilled).toBe(false);
		expect(parsed.pidKilled).toBe(false);
		expect(parsed.worktreeRemoved).toBe(true);
		expect(parsed.branchDeleted).toBe(true);
	});

	test("branch deletion failure is non-fatal for completed agent", async () => {
		const session = makeAgentSession({ state: "completed" });
		saveSessionsToDb([session]);

		const { deps } = makeDeps({}, {}, { shouldSucceed: false });
		// Should not throw even if branch deletion fails
		const output = await captureStdout(() =>
			stopCommand("my-builder", { cleanWorktree: true }, deps),
		);
		expect(output).toContain("Agent stopped");
	});
});

describe("stopCommand stop behavior", () => {
	test("stops a working agent (kills tmux, marks completed)", async () => {
		const session = makeAgentSession({ state: "working" });
		saveSessionsToDb([session]);

		const { deps, tmuxCalls } = makeDeps({ [session.tmuxSession]: true });
		const output = await captureStdout(() => stopCommand("my-builder", {}, deps));

		expect(output).toContain("Agent stopped");
		expect(output).toContain("my-builder");
		expect(output).toContain(`Tmux session killed: ${session.tmuxSession}`);
		expect(tmuxCalls.killSession).toHaveLength(1);
		expect(tmuxCalls.killSession[0]?.name).toBe(session.tmuxSession);

		// Verify state was updated in DB
		const { store } = openSessionStore(overstoryDir);
		const updated = store.getByName("my-builder");
		store.close();
		expect(updated?.state).toBe("completed");
	});

	test("stops a booting agent", async () => {
		const session = makeAgentSession({ state: "booting" });
		saveSessionsToDb([session]);

		const { deps, tmuxCalls } = makeDeps({ [session.tmuxSession]: true });
		await stopCommand("my-builder", {}, deps);

		expect(tmuxCalls.killSession).toHaveLength(1);
		const { store } = openSessionStore(overstoryDir);
		const updated = store.getByName("my-builder");
		store.close();
		expect(updated?.state).toBe("completed");
	});

	test("stops a stalled agent", async () => {
		const session = makeAgentSession({ state: "stalled" });
		saveSessionsToDb([session]);

		const { deps, tmuxCalls } = makeDeps({ [session.tmuxSession]: true });
		await stopCommand("my-builder", {}, deps);

		expect(tmuxCalls.killSession).toHaveLength(1);
		const { store } = openSessionStore(overstoryDir);
		const updated = store.getByName("my-builder");
		store.close();
		expect(updated?.state).toBe("completed");
	});

	test("handles already-dead tmux session gracefully (skips kill)", async () => {
		const session = makeAgentSession({ state: "working" });
		saveSessionsToDb([session]);

		// tmux session is NOT alive
		const { deps, tmuxCalls } = makeDeps({ [session.tmuxSession]: false });
		const output = await captureStdout(() => stopCommand("my-builder", {}, deps));

		expect(output).toContain("Tmux session was already dead");
		expect(tmuxCalls.killSession).toHaveLength(0);

		// Session should still be marked completed
		const { store } = openSessionStore(overstoryDir);
		const updated = store.getByName("my-builder");
		store.close();
		expect(updated?.state).toBe("completed");
	});
});

describe("stopCommand --json output", () => {
	test("--json outputs correct JSON shape", async () => {
		const session = makeAgentSession({ state: "working" });
		saveSessionsToDb([session]);

		const { deps } = makeDeps({ [session.tmuxSession]: true });
		const output = await captureStdout(() => stopCommand("my-builder", { json: true }, deps));

		const parsed = JSON.parse(output.trim()) as Record<string, unknown>;
		expect(parsed.success).toBe(true);
		expect(parsed.command).toBe("stop");
		expect(parsed.stopped).toBe(true);
		expect(parsed.agentName).toBe("my-builder");
		expect(parsed.sessionId).toBe(session.id);
		expect(parsed.capability).toBe("builder");
		expect(parsed.tmuxKilled).toBe(true);
		expect(parsed.worktreeRemoved).toBe(false);
		expect(parsed.force).toBe(false);
	});

	test("--force flag is passed through to JSON output", async () => {
		const session = makeAgentSession({ state: "working" });
		saveSessionsToDb([session]);

		const { deps } = makeDeps({ [session.tmuxSession]: true });
		const output = await captureStdout(() =>
			stopCommand("my-builder", { json: true, force: true }, deps),
		);

		const parsed = JSON.parse(output.trim()) as Record<string, unknown>;
		expect(parsed.force).toBe(true);
	});
});

describe("stopCommand --clean-worktree", () => {
	test("--clean-worktree removes worktree after stopping", async () => {
		const session = makeAgentSession({ state: "working" });
		saveSessionsToDb([session]);

		const { deps, worktreeCalls } = makeDeps({ [session.tmuxSession]: true });
		const output = await captureStdout(() =>
			stopCommand("my-builder", { cleanWorktree: true }, deps),
		);

		expect(output).toContain(`Worktree removed: ${session.worktreePath}`);
		expect(worktreeCalls.remove).toHaveLength(1);
		expect(worktreeCalls.remove[0]?.path).toBe(session.worktreePath);
	});

	test("--clean-worktree with --force passes force to removeWorktree (forceBranch is always false)", async () => {
		const session = makeAgentSession({ state: "working" });
		saveSessionsToDb([session]);

		const { deps, worktreeCalls } = makeDeps({ [session.tmuxSession]: true });
		await captureStdout(() =>
			stopCommand("my-builder", { cleanWorktree: true, force: true }, deps),
		);

		expect(worktreeCalls.remove).toHaveLength(1);
		expect(worktreeCalls.remove[0]?.options?.force).toBe(true);
		// forceBranch is always false because branch deletion is handled separately via git branch -D
		expect(worktreeCalls.remove[0]?.options?.forceBranch).toBe(false);
	});

	test("--clean-worktree also deletes the branch", async () => {
		const session = makeAgentSession({ state: "working" });
		saveSessionsToDb([session]);

		const { deps, gitCalls } = makeDeps({ [session.tmuxSession]: true });
		const output = await captureStdout(() =>
			stopCommand("my-builder", { cleanWorktree: true }, deps),
		);

		expect(gitCalls.deleteBranch).toHaveLength(1);
		expect(gitCalls.deleteBranch[0]?.branch).toBe(session.branchName);
		expect(output).toContain("Branch deleted");
	});

	test("branch deletion failure is non-fatal (agent still stopped)", async () => {
		const session = makeAgentSession({ state: "working" });
		saveSessionsToDb([session]);

		const { deps } = makeDeps({ [session.tmuxSession]: true }, {}, { shouldSucceed: false });
		const output = await captureStdout(() =>
			stopCommand("my-builder", { cleanWorktree: true }, deps),
		);
		expect(output).toContain("Agent stopped");
		const { store } = openSessionStore(overstoryDir);
		const updated = store.getByName("my-builder");
		store.close();
		expect(updated?.state).toBe("completed");
	});

	test("--clean-worktree failure is non-fatal (agent still stopped, warning on stdout)", async () => {
		const session = makeAgentSession({ state: "working" });
		saveSessionsToDb([session]);

		const { deps } = makeDeps({ [session.tmuxSession]: true }, { shouldFail: true });
		const { stdout } = await captureStderr(() =>
			stopCommand("my-builder", { cleanWorktree: true }, deps),
		);

		// Agent was still stopped
		expect(stdout).toContain("Agent stopped");
		expect(stdout).toContain("my-builder");
		// Warning written to stdout (via printWarning)
		expect(stdout).toContain("Failed to remove worktree");

		// Session is marked completed despite worktree failure
		const { store } = openSessionStore(overstoryDir);
		const updated = store.getByName("my-builder");
		store.close();
		expect(updated?.state).toBe("completed");
	});

	test("--clean-worktree with --json reflects worktreeRemoved=false on failure", async () => {
		const session = makeAgentSession({ state: "working" });
		saveSessionsToDb([session]);

		const { deps } = makeDeps({ [session.tmuxSession]: true }, { shouldFail: true });
		const { stdout } = await captureStderr(() =>
			stopCommand("my-builder", { cleanWorktree: true, json: true }, deps),
		);

		const parsed = JSON.parse(stdout.trim()) as Record<string, unknown>;
		expect(parsed.stopped).toBe(true);
		expect(parsed.worktreeRemoved).toBe(false);
	});
});

describe("stopCommand headless agents", () => {
	const HEADLESS_PID = 99999;

	function makeHeadlessSession(overrides: Partial<AgentSession> = {}): AgentSession {
		return makeAgentSession({
			tmuxSession: "",
			pid: HEADLESS_PID,
			...overrides,
		});
	}

	function makeHeadlessDeps(
		pidAliveMap: Record<number, boolean> = {},
		worktreeConfig?: { shouldFail?: boolean },
	): {
		deps: StopDeps;
		tmuxCalls: TmuxCallTracker;
		procCalls: ProcessCallTracker;
		worktreeCalls: WorktreeCallTracker;
		gitCalls: GitCallTracker;
	} {
		const { tmux, calls: tmuxCalls } = makeFakeTmux({});
		const { proc, calls: procCalls } = makeFakeProcess(pidAliveMap);
		const { worktree, calls: worktreeCalls } = makeFakeWorktree(worktreeConfig?.shouldFail);
		const { git, calls: gitCalls } = makeFakeGit();
		return {
			deps: { _tmux: tmux, _worktree: worktree, _process: proc, _git: git },
			tmuxCalls,
			procCalls,
			worktreeCalls,
			gitCalls,
		};
	}

	test("stops headless agent by killing process tree (no tmux interaction)", async () => {
		const session = makeHeadlessSession({ state: "working" });
		saveSessionsToDb([session]);

		const { deps, tmuxCalls, procCalls } = makeHeadlessDeps({ [HEADLESS_PID]: true });
		const output = await captureStdout(() => stopCommand("my-builder", {}, deps));

		// PID was killed
		expect(procCalls.killTree).toHaveLength(1);
		expect(procCalls.killTree[0]?.pid).toBe(HEADLESS_PID);
		// Tmux was NOT touched
		expect(tmuxCalls.isSessionAlive).toHaveLength(0);
		expect(tmuxCalls.killSession).toHaveLength(0);

		expect(output).toContain("Agent stopped");
		expect(output).toContain("Process tree killed");
		expect(output).toContain(String(HEADLESS_PID));

		const { store } = openSessionStore(overstoryDir);
		const updated = store.getByName("my-builder");
		store.close();
		expect(updated?.state).toBe("completed");
	});

	test("handles headless agent with already-dead PID gracefully", async () => {
		const session = makeHeadlessSession({ state: "working" });
		saveSessionsToDb([session]);

		// PID is NOT alive
		const { deps, procCalls } = makeHeadlessDeps({ [HEADLESS_PID]: false });
		const output = await captureStdout(() => stopCommand("my-builder", {}, deps));

		expect(procCalls.killTree).toHaveLength(0);
		expect(output).toContain("Agent stopped");
		expect(output).toContain("Process was already dead");

		const { store } = openSessionStore(overstoryDir);
		const updated = store.getByName("my-builder");
		store.close();
		expect(updated?.state).toBe("completed");
	});

	test("--json output includes pidKilled for headless agent", async () => {
		const session = makeHeadlessSession({ state: "working" });
		saveSessionsToDb([session]);

		const { deps } = makeHeadlessDeps({ [HEADLESS_PID]: true });
		const output = await captureStdout(() => stopCommand("my-builder", { json: true }, deps));

		const parsed = JSON.parse(output.trim()) as Record<string, unknown>;
		expect(parsed.success).toBe(true);
		expect(parsed.stopped).toBe(true);
		expect(parsed.pidKilled).toBe(true);
		expect(parsed.tmuxKilled).toBe(false);
		expect(parsed.agentName).toBe("my-builder");
	});

	test("--clean-worktree works for headless agent", async () => {
		const session = makeHeadlessSession({ state: "working" });
		saveSessionsToDb([session]);

		const { deps, worktreeCalls } = makeHeadlessDeps({ [HEADLESS_PID]: true });
		const output = await captureStdout(() =>
			stopCommand("my-builder", { cleanWorktree: true }, deps),
		);

		expect(output).toContain(`Worktree removed: ${session.worktreePath}`);
		expect(worktreeCalls.remove).toHaveLength(1);
	});
});

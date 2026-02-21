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
		[
			"project:",
			"  name: test-project",
			`  root: ${tempDir}`,
			"  canonicalBranch: main",
		].join("\n"),
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
		worktreePath: join(tempDir, ".overstory", "worktrees", "my-builder"),
		branchName: "overstory/my-builder/bead-123",
		beadId: "bead-123",
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

/** Build default deps with fake tmux and worktree. */
function makeDeps(
	sessionAliveMap: Record<string, boolean> = {},
	worktreeConfig?: { shouldFail?: boolean },
): {
	deps: StopDeps;
	tmuxCalls: TmuxCallTracker;
	worktreeCalls: WorktreeCallTracker;
} {
	const { tmux, calls: tmuxCalls } = makeFakeTmux(sessionAliveMap);
	const { worktree, calls: worktreeCalls } = makeFakeWorktree(worktreeConfig?.shouldFail);
	return { deps: { _tmux: tmux, _worktree: worktree }, tmuxCalls, worktreeCalls };
}

// --- Tests ---

describe("stopCommand help", () => {
	test("--help outputs help text", async () => {
		const output = await captureStdout(() => stopCommand(["--help"]));
		expect(output).toContain("overstory stop");
		expect(output).toContain("<agent-name>");
		expect(output).toContain("--force");
		expect(output).toContain("--clean-worktree");
		expect(output).toContain("--json");
	});

	test("-h outputs help text", async () => {
		const output = await captureStdout(() => stopCommand(["-h"]));
		expect(output).toContain("overstory stop");
		expect(output).toContain("<agent-name>");
	});
});

describe("stopCommand validation", () => {
	test("throws ValidationError when no agent name provided", async () => {
		const { deps } = makeDeps();
		await expect(stopCommand([], deps)).rejects.toThrow(ValidationError);
	});

	test("throws ValidationError when only flags are provided (no agent name)", async () => {
		const { deps } = makeDeps();
		await expect(stopCommand(["--json"], deps)).rejects.toThrow(ValidationError);
	});

	test("throws AgentError when agent not found", async () => {
		const { deps } = makeDeps();
		await expect(stopCommand(["nonexistent-agent"], deps)).rejects.toThrow(AgentError);
	});

	test("throws AgentError when agent is already completed", async () => {
		const session = makeAgentSession({ state: "completed" });
		saveSessionsToDb([session]);

		const { deps } = makeDeps();
		await expect(stopCommand(["my-builder"], deps)).rejects.toThrow(AgentError);
		await expect(stopCommand(["my-builder"], deps)).rejects.toThrow(/already completed/);
	});

	test("throws AgentError when agent is already zombie", async () => {
		const session = makeAgentSession({ state: "zombie" });
		saveSessionsToDb([session]);

		const { deps } = makeDeps();
		await expect(stopCommand(["my-builder"], deps)).rejects.toThrow(AgentError);
		await expect(stopCommand(["my-builder"], deps)).rejects.toThrow(/zombie/);
	});
});

describe("stopCommand stop behavior", () => {
	test("stops a working agent (kills tmux, marks completed)", async () => {
		const session = makeAgentSession({ state: "working" });
		saveSessionsToDb([session]);

		const { deps, tmuxCalls } = makeDeps({ [session.tmuxSession]: true });
		const output = await captureStdout(() => stopCommand(["my-builder"], deps));

		expect(output).toContain(`Agent "my-builder" stopped`);
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
		await stopCommand(["my-builder"], deps);

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
		await stopCommand(["my-builder"], deps);

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
		const output = await captureStdout(() => stopCommand(["my-builder"], deps));

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
		const output = await captureStdout(() => stopCommand(["my-builder", "--json"], deps));

		const parsed = JSON.parse(output.trim()) as Record<string, unknown>;
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
			stopCommand(["my-builder", "--json", "--force"], deps),
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
			stopCommand(["my-builder", "--clean-worktree"], deps),
		);

		expect(output).toContain(`Worktree removed: ${session.worktreePath}`);
		expect(worktreeCalls.remove).toHaveLength(1);
		expect(worktreeCalls.remove[0]?.path).toBe(session.worktreePath);
	});

	test("--clean-worktree with --force passes force flags to removeWorktree", async () => {
		const session = makeAgentSession({ state: "working" });
		saveSessionsToDb([session]);

		const { deps, worktreeCalls } = makeDeps({ [session.tmuxSession]: true });
		await captureStdout(() =>
			stopCommand(["my-builder", "--clean-worktree", "--force"], deps),
		);

		expect(worktreeCalls.remove).toHaveLength(1);
		expect(worktreeCalls.remove[0]?.options?.force).toBe(true);
		expect(worktreeCalls.remove[0]?.options?.forceBranch).toBe(true);
	});

	test("--clean-worktree failure is non-fatal (agent still stopped, warning on stderr)", async () => {
		const session = makeAgentSession({ state: "working" });
		saveSessionsToDb([session]);

		const { deps } = makeDeps({ [session.tmuxSession]: true }, { shouldFail: true });
		const { stderr, stdout } = await captureStderr(() =>
			stopCommand(["my-builder", "--clean-worktree"], deps),
		);

		// Agent was still stopped
		expect(stdout).toContain(`Agent "my-builder" stopped`);
		// Warning written to stderr
		expect(stderr).toContain("Warning: failed to remove worktree");

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
			stopCommand(["my-builder", "--clean-worktree", "--json"], deps),
		);

		const parsed = JSON.parse(stdout.trim()) as Record<string, unknown>;
		expect(parsed.stopped).toBe(true);
		expect(parsed.worktreeRemoved).toBe(false);
	});
});

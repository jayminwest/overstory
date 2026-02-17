import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionStore } from "../sessions/store.ts";
import type { OverstoryConfig } from "../types.ts";
import type { ConsistencyCheckDeps } from "./consistency.ts";
import { checkConsistency } from "./consistency.ts";

/**
 * Mock tmux functions using dependency injection instead of mock.module().
 * This avoids test isolation issues from module-level mocking.
 */
const mockListSessions = mock(() => Promise.resolve([] as Array<{ name: string; pid: number }>));
const mockIsProcessAlive = mock((_pid: number) => true);

/**
 * Create a minimal temp git repo for worktree tests.
 */
function createTempGitRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "overstory-test-"));
	const git = (args: string[]) => {
		const proc = Bun.spawnSync(["git", ...args], { cwd: dir, stdout: "ignore", stderr: "pipe" });
		if (proc.exitCode !== 0) {
			throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString()}`);
		}
	};

	git(["init"]);
	git(["config", "user.email", "test@test.com"]);
	git(["config", "user.name", "Test User"]);
	git(["config", "commit.gpgsign", "false"]);
	writeFileSync(join(dir, "README.md"), "# Test Repo\n");
	git(["add", "."]);
	git(["commit", "-m", "Initial commit"]);

	return dir;
}

/**
 * Create a git worktree at the given path.
 */
function createWorktree(repoRoot: string, worktreePath: string, branchName: string): void {
	const proc = Bun.spawnSync(["git", "worktree", "add", "-b", branchName, worktreePath, "HEAD"], {
		cwd: repoRoot,
		stdout: "ignore",
		stderr: "pipe",
	});
	if (proc.exitCode !== 0) {
		throw new Error(`Failed to create worktree: ${proc.stderr.toString()}`);
	}
}

describe("checkConsistency", () => {
	let repoRoot: string;
	let overstoryDir: string;
	let config: OverstoryConfig;
	let mockDeps: ConsistencyCheckDeps;

	beforeEach(() => {
		repoRoot = createTempGitRepo();
		overstoryDir = join(repoRoot, ".overstory");
		mkdirSync(overstoryDir, { recursive: true });
		mkdirSync(join(overstoryDir, "worktrees"), { recursive: true });

		config = {
			project: {
				name: "testproject",
				root: repoRoot,
				canonicalBranch: "main",
			},
			agents: {
				manifestPath: join(overstoryDir, "agent-manifest.json"),
				baseDir: join(repoRoot, "agents"),
				maxConcurrent: 5,
				staggerDelayMs: 100,
				maxDepth: 2,
			},
			worktrees: {
				baseDir: join(overstoryDir, "worktrees"),
			},
			beads: {
				enabled: false,
			},
			mulch: {
				enabled: false,
				domains: [],
				primeFormat: "markdown",
			},
			merge: {
				aiResolveEnabled: false,
				reimagineEnabled: false,
			},
			watchdog: {
				tier0Enabled: false,
				tier0IntervalMs: 30000,
				tier1Enabled: false,
				tier2Enabled: false,
				staleThresholdMs: 60000,
				zombieThresholdMs: 300000,
				nudgeIntervalMs: 30000,
			},
			models: {},
			logging: {
				verbose: false,
				redactSecrets: true,
			},
		};

		// Reset mocks and create deps object
		mockListSessions.mockReset();
		mockIsProcessAlive.mockReset();
		mockListSessions.mockResolvedValue([]);
		mockIsProcessAlive.mockReturnValue(true);

		mockDeps = {
			listSessions: mockListSessions,
			isProcessAlive: mockIsProcessAlive,
		};
	});

	afterEach(() => {
		if (existsSync(repoRoot)) {
			rmSync(repoRoot, { recursive: true, force: true });
		}
	});

	test("returns all pass when no sessions exist", async () => {
		const checks = await checkConsistency(config, overstoryDir, mockDeps);

		expect(checks.length).toBeGreaterThan(0);
		const passChecks = checks.filter((c) => c.status === "pass");
		expect(passChecks.length).toBeGreaterThan(0);

		const failChecks = checks.filter((c) => c.status === "fail");
		expect(failChecks.length).toBe(0);
	});

	test("detects orphaned worktrees", async () => {
		// Create a worktree but don't add it to SessionStore
		const worktreePath = join(overstoryDir, "worktrees", "orphan-agent");
		createWorktree(repoRoot, worktreePath, "overstory/orphan-agent/test-123");

		const checks = await checkConsistency(config, overstoryDir, mockDeps);

		const orphanCheck = checks.find((c) => c.name === "orphaned-worktrees");
		expect(orphanCheck).toBeDefined();
		expect(orphanCheck?.status).toBe("warn");
		expect(orphanCheck?.message).toContain("1 orphaned worktree");
		expect(orphanCheck?.details?.length).toBe(1);
		expect(orphanCheck?.fixable).toBe(true);
	});

	test("detects orphaned tmux sessions", async () => {
		// Mock a tmux session that isn't in SessionStore
		mockListSessions.mockResolvedValue([{ name: "overstory-testproject-orphan", pid: 9999 }]);

		const checks = await checkConsistency(config, overstoryDir, mockDeps);

		const orphanCheck = checks.find((c) => c.name === "orphaned-tmux");
		expect(orphanCheck).toBeDefined();
		expect(orphanCheck?.status).toBe("warn");
		expect(orphanCheck?.message).toContain("1 orphaned tmux session");
		expect(orphanCheck?.fixable).toBe(true);
	});

	test("ignores tmux sessions from other projects", async () => {
		// Mock tmux sessions from different projects
		mockListSessions.mockResolvedValue([
			{ name: "overstory-otherproject-agent1", pid: 9999 },
			{ name: "my-custom-session", pid: 8888 },
		]);

		const checks = await checkConsistency(config, overstoryDir, mockDeps);

		const orphanCheck = checks.find((c) => c.name === "orphaned-tmux");
		expect(orphanCheck).toBeDefined();
		expect(orphanCheck?.status).toBe("pass");
		expect(orphanCheck?.message).toContain("No orphaned tmux sessions");
	});

	test("detects dead PIDs in SessionStore", async () => {
		// Create a session with a PID that's marked as dead
		const dbPath = join(overstoryDir, "sessions.db");
		const store = createSessionStore(dbPath);

		store.upsert({
			id: "session-1",
			agentName: "dead-agent",
			capability: "builder",
			worktreePath: join(overstoryDir, "worktrees", "dead-agent"),
			branchName: "overstory/dead-agent/test-123",
			beadId: "test-123",
			tmuxSession: "overstory-testproject-dead-agent",
			state: "working",
			pid: 99999, // Non-existent PID
			parentAgent: null,
			depth: 0,
			runId: null,
			startedAt: new Date().toISOString(),
			lastActivity: new Date().toISOString(),
			escalationLevel: 0,
			stalledSince: null,
		});
		store.close();

		// Mock that this PID is not alive
		mockIsProcessAlive.mockReturnValue(false);

		const checks = await checkConsistency(config, overstoryDir, mockDeps);

		const deadPidCheck = checks.find((c) => c.name === "dead-pids");
		expect(deadPidCheck).toBeDefined();
		expect(deadPidCheck?.status).toBe("warn");
		expect(deadPidCheck?.message).toContain("1 session(s) with dead PIDs");
		expect(deadPidCheck?.fixable).toBe(true);
	});

	test("passes when all PIDs are alive", async () => {
		const dbPath = join(overstoryDir, "sessions.db");
		const store = createSessionStore(dbPath);

		store.upsert({
			id: "session-1",
			agentName: "live-agent",
			capability: "builder",
			worktreePath: join(overstoryDir, "worktrees", "live-agent"),
			branchName: "overstory/live-agent/test-123",
			beadId: "test-123",
			tmuxSession: "overstory-testproject-live-agent",
			state: "working",
			pid: 12345,
			parentAgent: null,
			depth: 0,
			runId: null,
			startedAt: new Date().toISOString(),
			lastActivity: new Date().toISOString(),
			escalationLevel: 0,
			stalledSince: null,
		});
		store.close();

		// Mock that this PID is alive
		mockIsProcessAlive.mockReturnValue(true);

		const checks = await checkConsistency(config, overstoryDir, mockDeps);

		const deadPidCheck = checks.find((c) => c.name === "dead-pids");
		expect(deadPidCheck).toBeDefined();
		expect(deadPidCheck?.status).toBe("pass");
	});

	test("detects missing worktrees for SessionStore entries", async () => {
		const dbPath = join(overstoryDir, "sessions.db");
		const store = createSessionStore(dbPath);

		const missingWorktreePath = join(overstoryDir, "worktrees", "missing-agent");
		store.upsert({
			id: "session-1",
			agentName: "missing-agent",
			capability: "builder",
			worktreePath: missingWorktreePath,
			branchName: "overstory/missing-agent/test-123",
			beadId: "test-123",
			tmuxSession: "overstory-testproject-missing-agent",
			state: "working",
			pid: null,
			parentAgent: null,
			depth: 0,
			runId: null,
			startedAt: new Date().toISOString(),
			lastActivity: new Date().toISOString(),
			escalationLevel: 0,
			stalledSince: null,
		});
		store.close();

		const checks = await checkConsistency(config, overstoryDir, mockDeps);

		const missingCheck = checks.find((c) => c.name === "missing-worktrees");
		expect(missingCheck).toBeDefined();
		expect(missingCheck?.status).toBe("warn");
		expect(missingCheck?.message).toContain("1 session(s) with missing worktrees");
		expect(missingCheck?.fixable).toBe(true);
	});

	test("detects missing tmux sessions for SessionStore entries", async () => {
		const dbPath = join(overstoryDir, "sessions.db");
		const store = createSessionStore(dbPath);

		const worktreePath = join(overstoryDir, "worktrees", "agent-without-tmux");
		createWorktree(repoRoot, worktreePath, "overstory/agent-without-tmux/test-123");

		store.upsert({
			id: "session-1",
			agentName: "agent-without-tmux",
			capability: "builder",
			worktreePath,
			branchName: "overstory/agent-without-tmux/test-123",
			beadId: "test-123",
			tmuxSession: "overstory-testproject-agent-without-tmux",
			state: "working",
			pid: null,
			parentAgent: null,
			depth: 0,
			runId: null,
			startedAt: new Date().toISOString(),
			lastActivity: new Date().toISOString(),
			escalationLevel: 0,
			stalledSince: null,
		});
		store.close();

		// Mock empty tmux sessions list
		mockListSessions.mockResolvedValue([]);

		const checks = await checkConsistency(config, overstoryDir, mockDeps);

		const missingCheck = checks.find((c) => c.name === "missing-tmux");
		expect(missingCheck).toBeDefined();
		expect(missingCheck?.status).toBe("warn");
		expect(missingCheck?.message).toContain("1 session(s) with missing tmux sessions");
		expect(missingCheck?.fixable).toBe(true);
	});

	test("passes when everything is consistent", async () => {
		const dbPath = join(overstoryDir, "sessions.db");
		const store = createSessionStore(dbPath);

		const worktreePath = join(overstoryDir, "worktrees", "consistent-agent");
		createWorktree(repoRoot, worktreePath, "overstory/consistent-agent/test-123");

		store.upsert({
			id: "session-1",
			agentName: "consistent-agent",
			capability: "builder",
			worktreePath,
			branchName: "overstory/consistent-agent/test-123",
			beadId: "test-123",
			tmuxSession: "overstory-testproject-consistent-agent",
			state: "working",
			pid: 12345,
			parentAgent: null,
			depth: 0,
			runId: null,
			startedAt: new Date().toISOString(),
			lastActivity: new Date().toISOString(),
			escalationLevel: 0,
			stalledSince: null,
		});
		store.close();

		// Mock matching tmux session
		mockListSessions.mockResolvedValue([
			{ name: "overstory-testproject-consistent-agent", pid: 12345 },
		]);

		// Mock PID as alive
		mockIsProcessAlive.mockReturnValue(true);

		const checks = await checkConsistency(config, overstoryDir, mockDeps);

		const warnOrFail = checks.filter((c) => c.status === "warn" || c.status === "fail");
		expect(warnOrFail.length).toBe(0);
	});

	test("handles tmux not installed gracefully", async () => {
		// Mock tmux listing to throw an error
		mockListSessions.mockRejectedValue(new Error("tmux: command not found"));

		const checks = await checkConsistency(config, overstoryDir, mockDeps);

		const tmuxCheck = checks.find((c) => c.name === "tmux-listing");
		expect(tmuxCheck).toBeDefined();
		expect(tmuxCheck?.status).toBe("warn");
		expect(tmuxCheck?.message).toContain("Failed to list tmux sessions");
	});

	test("fails early if git worktree list fails", async () => {
		// Use a non-existent repo root to trigger worktree listing failure
		const badConfig = { ...config, project: { ...config.project, root: "/nonexistent" } };

		const checks = await checkConsistency(badConfig, overstoryDir, mockDeps);

		expect(checks.length).toBe(1);
		expect(checks[0]?.name).toBe("worktree-listing");
		expect(checks[0]?.status).toBe("fail");
	});

	test("fails early if SessionStore cannot be opened", async () => {
		// Use a bad overstory directory path
		const badOverstoryDir = "/nonexistent/.overstory";

		const checks = await checkConsistency(config, badOverstoryDir, mockDeps);

		const storeCheck = checks.find((c) => c.name === "sessionstore-open");
		expect(storeCheck).toBeDefined();
		expect(storeCheck?.status).toBe("fail");
	});
});

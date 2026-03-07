import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripAnsi } from "../logging/color.ts";
import { createSessionStore } from "../sessions/store.ts";
import { cleanupTempDir, createTempGitRepo } from "../test-helpers.ts";
import type { AgentSession } from "../types.ts";
import {
	gatherStatus,
	invalidateStatusCache,
	printStatus,
	type StatusData,
	statusCommand,
	type VerboseAgentDetail,
} from "./status.ts";

/**
 * Tests for the --verbose flag in overstory status.
 *
 * printStatus is tested by capturing process.stdout.write output.
 * We spy on stdout.write because printStatus uses it directly.
 */

function makeAgent(overrides: Partial<AgentSession> = {}): AgentSession {
	return {
		id: "sess-001",
		agentName: "test-builder",
		capability: "builder",
		runtime: "claude",
		worktreePath: "/tmp/worktrees/test-builder",
		branchName: "overstory/test-builder/task-1",
		taskId: "task-1",
		tmuxSession: "overstory-test-builder",
		state: "working",
		pid: 12345,
		parentAgent: null,
		depth: 0,
		runId: null,
		startedAt: new Date(Date.now() - 60_000).toISOString(),
		lastActivity: new Date().toISOString(),
		escalationLevel: 0,
		stalledSince: null,
		rateLimitedSince: null,
		transcriptPath: null,
		...overrides,
	};
}

function makeStatusData(overrides: Partial<StatusData> = {}): StatusData {
	return {
		agents: [makeAgent()],
		worktrees: [],
		tmuxSessions: [{ name: "overstory-test-builder", pid: 12345 }],
		unreadMailCount: 0,
		mergeQueueCount: 0,
		recentMetricsCount: 0,
		...overrides,
	};
}

describe("printStatus", () => {
	let chunks: string[];
	let originalWrite: typeof process.stdout.write;

	beforeEach(() => {
		chunks = [];
		originalWrite = process.stdout.write;
		process.stdout.write = ((chunk: string) => {
			chunks.push(chunk);
			return true;
		}) as typeof process.stdout.write;
	});

	afterEach(() => {
		process.stdout.write = originalWrite;
	});

	function output(): string {
		return chunks.join("");
	}

	test("non-verbose: does not show worktree path or logs dir", () => {
		const data = makeStatusData();
		printStatus(data);
		const out = output();

		expect(out).toContain("test-builder");
		expect(out).toContain("[builder]");
		expect(out).not.toContain("Worktree:");
		expect(out).not.toContain("Logs:");
		expect(out).not.toContain("Mail sent:");
	});

	test("verbose: shows worktree path, logs dir, and mail timestamps", () => {
		const detail: VerboseAgentDetail = {
			worktreePath: "/tmp/worktrees/test-builder",
			logsDir: "/tmp/.overstory/logs/test-builder",
			lastMailSent: "2025-01-15T10:00:00.000Z",
			lastMailReceived: "2025-01-15T10:05:00.000Z",
			capability: "builder",
		};

		const data = makeStatusData({
			verboseDetails: { "test-builder": detail },
		});
		printStatus(data);
		const out = output();

		expect(out).toContain("Worktree: /tmp/worktrees/test-builder");
		expect(out).toContain("Logs:     /tmp/.overstory/logs/test-builder");
		expect(out).toContain("Mail sent: 2025-01-15T10:00:00.000Z");
		expect(out).toContain("received: 2025-01-15T10:05:00.000Z");
	});

	test("verbose: shows 'none' for null mail timestamps", () => {
		const detail: VerboseAgentDetail = {
			worktreePath: "/tmp/worktrees/test-builder",
			logsDir: "/tmp/.overstory/logs/test-builder",
			lastMailSent: null,
			lastMailReceived: null,
			capability: "builder",
		};

		const data = makeStatusData({
			verboseDetails: { "test-builder": detail },
		});
		printStatus(data);
		const out = output();

		expect(out).toContain("Mail sent: none");
		expect(out).toContain("received: none");
	});

	test("verbose: zombie agents do not get verbose detail", () => {
		const agent = makeAgent({ state: "zombie", agentName: "zombie-agent" });
		const detail: VerboseAgentDetail = {
			worktreePath: "/tmp/worktrees/zombie-agent",
			logsDir: "/tmp/.overstory/logs/zombie-agent",
			lastMailSent: null,
			lastMailReceived: null,
			capability: "builder",
		};

		const data = makeStatusData({
			agents: [agent],
			verboseDetails: { "zombie-agent": detail },
		});
		printStatus(data);
		const out = output();

		// Zombie agents are filtered from the active list
		expect(out).toContain("0 active");
		expect(out).not.toContain("Worktree:");
	});

	test("verbose with multiple agents: each gets its own detail", () => {
		const agent1 = makeAgent({ agentName: "builder-1", tmuxSession: "overstory-builder-1" });
		const agent2 = makeAgent({
			agentName: "scout-1",
			capability: "scout",
			tmuxSession: "overstory-scout-1",
		});

		const data = makeStatusData({
			agents: [agent1, agent2],
			tmuxSessions: [
				{ name: "overstory-builder-1", pid: 100 },
				{ name: "overstory-scout-1", pid: 200 },
			],
			verboseDetails: {
				"builder-1": {
					worktreePath: "/tmp/wt/builder-1",
					logsDir: "/tmp/logs/builder-1",
					lastMailSent: "2025-01-15T10:00:00.000Z",
					lastMailReceived: null,
					capability: "builder",
				},
				"scout-1": {
					worktreePath: "/tmp/wt/scout-1",
					logsDir: "/tmp/logs/scout-1",
					lastMailSent: null,
					lastMailReceived: "2025-01-15T11:00:00.000Z",
					capability: "scout",
				},
			},
		});
		printStatus(data);
		const out = output();

		expect(out).toContain("Worktree: /tmp/wt/builder-1");
		expect(out).toContain("Worktree: /tmp/wt/scout-1");
		expect(out).toContain("Logs:     /tmp/logs/builder-1");
		expect(out).toContain("Logs:     /tmp/logs/scout-1");
	});
});

describe("--verbose --json", () => {
	test("verboseDetails is included in StatusData when present", () => {
		const detail: VerboseAgentDetail = {
			worktreePath: "/tmp/wt/agent",
			logsDir: "/tmp/logs/agent",
			lastMailSent: "2025-01-15T10:00:00.000Z",
			lastMailReceived: null,
			capability: "builder",
		};

		const data: StatusData = {
			agents: [],
			worktrees: [],
			tmuxSessions: [],
			unreadMailCount: 0,
			mergeQueueCount: 0,
			recentMetricsCount: 0,
			verboseDetails: { agent: detail },
		};

		const json = JSON.parse(JSON.stringify(data)) as StatusData;
		expect(json.verboseDetails).toBeDefined();
		expect(json.verboseDetails?.agent?.worktreePath).toBe("/tmp/wt/agent");
		expect(json.verboseDetails?.agent?.lastMailSent).toBe("2025-01-15T10:00:00.000Z");
		expect(json.verboseDetails?.agent?.lastMailReceived).toBeNull();
	});

	test("verboseDetails is omitted from JSON when undefined", () => {
		const data: StatusData = {
			agents: [],
			worktrees: [],
			tmuxSessions: [],
			unreadMailCount: 0,
			mergeQueueCount: 0,
			recentMetricsCount: 0,
		};

		const json = JSON.stringify(data);
		expect(json).not.toContain("verboseDetails");
	});
});

describe("run scoping", () => {
	let chunks: string[];
	let originalWrite: typeof process.stdout.write;

	beforeEach(() => {
		chunks = [];
		originalWrite = process.stdout.write;
		process.stdout.write = ((chunk: string) => {
			chunks.push(chunk);
			return true;
		}) as typeof process.stdout.write;
	});

	afterEach(() => {
		process.stdout.write = originalWrite;
		invalidateStatusCache();
	});

	function output(): string {
		return chunks.join("");
	}

	test("printStatus shows run ID when currentRunId is set", () => {
		const data = makeStatusData({ currentRunId: "run-123" });
		printStatus(data);
		expect(stripAnsi(output())).toContain("Run: run-123");
	});

	test("printStatus does not show run line when currentRunId is undefined", () => {
		const data = makeStatusData();
		printStatus(data);
		expect(output()).not.toContain("Run:");
	});

	test("printStatus does not show run line when currentRunId is null", () => {
		const data = makeStatusData({ currentRunId: null });
		printStatus(data);
		expect(output()).not.toContain("Run:");
	});

	test("help text includes --all", async () => {
		const helpChunks: string[] = [];
		const origWrite = process.stdout.write;
		process.stdout.write = ((chunk: string) => {
			helpChunks.push(chunk);
			return true;
		}) as typeof process.stdout.write;

		try {
			await statusCommand(["--help"]);
		} finally {
			process.stdout.write = origWrite;
		}

		const out = helpChunks.join("");
		expect(out).toContain("--all");
	});

	test("gatherStatus includes null-runId sessions when run-scoped", async () => {
		// Use a real git repo so listWorktrees() doesn't throw
		const tempDir = await createTempGitRepo();
		const overstoryDir = join(tempDir, ".overstory");
		await mkdir(overstoryDir, { recursive: true });

		// Seed sessions.db with three sessions:
		//   coordinator: runId=null
		//   builder-1:   runId="run-001" (in-scope)
		//   builder-2:   runId="run-002" (out-of-scope)
		const store = createSessionStore(join(overstoryDir, "sessions.db"));
		const now = new Date().toISOString();
		for (const session of [
			makeAgent({
				agentName: "coordinator",
				capability: "coordinator",
				runId: null,
				tmuxSession: "overstory-fake-coordinator",
			}),
			makeAgent({
				id: "sess-002",
				agentName: "builder-1",
				capability: "builder",
				runId: "run-001",
				tmuxSession: "overstory-fake-builder-1",
			}),
			makeAgent({
				id: "sess-003",
				agentName: "builder-2",
				capability: "builder",
				runId: "run-002",
				tmuxSession: "overstory-fake-builder-2",
			}),
		] as AgentSession[]) {
			session.startedAt = now;
			session.lastActivity = now;
			store.upsert(session);
		}
		store.close();

		try {
			const result = await gatherStatus(tempDir, "orchestrator", false, "run-001");
			const names = result.agents.map((a) => a.agentName);

			// coordinator (null runId) must appear
			expect(names).toContain("coordinator");
			// in-scope builder must appear
			expect(names).toContain("builder-1");
			// out-of-scope builder must NOT appear
			expect(names).not.toContain("builder-2");
		} finally {
			await cleanupTempDir(tempDir);
		}
	});
});

describe("headless agent alive markers", () => {
	let chunks: string[];
	let originalWrite: typeof process.stdout.write;

	beforeEach(() => {
		chunks = [];
		originalWrite = process.stdout.write;
		process.stdout.write = ((chunk: string) => {
			chunks.push(chunk);
			return true;
		}) as typeof process.stdout.write;
	});

	afterEach(() => {
		process.stdout.write = originalWrite;
	});

	function output(): string {
		return chunks.join("");
	}

	test("printStatus shows green marker for headless agent with alive PID", () => {
		// Use own process PID — guaranteed alive
		const alivePid = process.pid;
		const agent = makeAgent({
			agentName: "headless-builder",
			tmuxSession: "", // headless: no tmux
			pid: alivePid,
			state: "working",
		});
		const data = makeStatusData({
			agents: [agent],
			tmuxSessions: [], // no tmux sessions
		});
		printStatus(data);
		const out = output();
		// Green marker is ">" — check it appears in the output
		expect(out).toContain("headless-builder");
		expect(out).toContain(">");
	});

	test("printStatus shows red marker for headless agent with dead PID", () => {
		const deadPid = 2_147_483_647; // max int, virtually guaranteed non-existent
		const agent = makeAgent({
			agentName: "dead-headless-builder",
			tmuxSession: "", // headless: no tmux
			pid: deadPid,
			state: "working",
		});
		const data = makeStatusData({
			agents: [agent],
			tmuxSessions: [],
		});
		printStatus(data);
		const out = output();
		expect(out).toContain("dead-headless-builder");
		expect(out).toContain("x");
	});

	test("printStatus uses tmux check (not PID) for tmux-based agents", () => {
		const agent = makeAgent({
			agentName: "tmux-builder",
			tmuxSession: "overstory-test-builder",
			pid: process.pid, // alive PID, but should use tmux check
			state: "working",
		});
		// tmuxSessions empty → tmux dead → red marker
		const data = makeStatusData({
			agents: [agent],
			tmuxSessions: [],
		});
		printStatus(data);
		const out = output();
		expect(out).toContain("x");
	});
});

describe("--watch deprecation", () => {
	test("help text marks --watch as deprecated", async () => {
		const chunks: string[] = [];
		const originalWrite = process.stdout.write;
		process.stdout.write = ((chunk: string) => {
			chunks.push(chunk);
			return true;
		}) as typeof process.stdout.write;

		try {
			await statusCommand(["--help"]);
		} finally {
			process.stdout.write = originalWrite;
		}

		const out = chunks.join("");
		expect(out).toContain("deprecated");
		expect(out).toContain("ov dashboard");
	});

	test("--watch writes deprecation notice to stderr", async () => {
		const stderrChunks: string[] = [];
		const originalStderr = process.stderr.write;
		process.stderr.write = ((chunk: string) => {
			stderrChunks.push(chunk);
			return true;
		}) as typeof process.stderr.write;

		// statusCommand with --watch will fail at loadConfig (no .overstory/)
		// but the deprecation notice is written before that. We just verify
		// the notice was emitted.
		const tmpDir = await mkdtemp(join(tmpdir(), "status-deprecation-"));
		const originalCwd = process.cwd();
		process.chdir(tmpDir);

		try {
			await statusCommand(["--watch"]);
		} catch {
			// Expected: loadConfig fails without .overstory/
		} finally {
			process.stderr.write = originalStderr;
			process.chdir(originalCwd);
			await cleanupTempDir(tmpDir);
		}

		const err = stderrChunks.join("");
		expect(err).toContain("--watch is deprecated");
		expect(err).toContain("ov dashboard");
	});
});

describe("gatherStatus reconciliation", () => {
	afterEach(() => {
		invalidateStatusCache();
	});

	test("booting agent with dead tmux becomes zombie", async () => {
		const tempDir = await createTempGitRepo();
		const overstoryDir = join(tempDir, ".overstory");
		await mkdir(overstoryDir, { recursive: true });

		const store = createSessionStore(join(overstoryDir, "sessions.db"));
		const now = new Date().toISOString();
		const session = makeAgent({
			agentName: "boot-builder",
			capability: "builder",
			state: "booting",
			tmuxSession: "overstory-boot-builder",
			runId: null,
		});
		session.startedAt = now;
		session.lastActivity = now;
		store.upsert(session);
		store.close();

		try {
			// No real tmux running, so getCachedTmuxSessions() returns empty array
			// evaluateHealth ZFC Rule 1: tmux dead → zombie
			const result = await gatherStatus(tempDir, "orchestrator", false, undefined);
			const agent = result.agents.find((a) => a.agentName === "boot-builder");
			expect(agent).toBeDefined();
			expect(agent?.state).toBe("zombie");
		} finally {
			await cleanupTempDir(tempDir);
		}
	});

	test("completed agents skip reconciliation", async () => {
		const tempDir = await createTempGitRepo();
		const overstoryDir = join(tempDir, ".overstory");
		await mkdir(overstoryDir, { recursive: true });

		const store = createSessionStore(join(overstoryDir, "sessions.db"));
		const now = new Date().toISOString();
		const session = makeAgent({
			agentName: "done-builder",
			capability: "builder",
			state: "completed",
			tmuxSession: "overstory-done-builder",
			runId: null,
		});
		session.startedAt = now;
		session.lastActivity = now;
		store.upsert(session);
		store.close();

		try {
			const result = await gatherStatus(tempDir, "orchestrator", false, undefined);
			const agent = result.agents.find((a) => a.agentName === "done-builder");
			expect(agent).toBeDefined();
			expect(agent?.state).toBe("completed");
		} finally {
			await cleanupTempDir(tempDir);
		}
	});

	test("working agent with dead tmux becomes zombie", async () => {
		const tempDir = await createTempGitRepo();
		const overstoryDir = join(tempDir, ".overstory");
		await mkdir(overstoryDir, { recursive: true });

		const store = createSessionStore(join(overstoryDir, "sessions.db"));
		const now = new Date().toISOString();
		const session = makeAgent({
			agentName: "working-builder",
			capability: "builder",
			state: "working",
			tmuxSession: "overstory-working-builder",
			runId: null,
		});
		session.startedAt = now;
		session.lastActivity = now;
		store.upsert(session);
		store.close();

		try {
			// No real tmux session → tmux dead → zombie via evaluateHealth ZFC Rule 1
			const result = await gatherStatus(tempDir, "orchestrator", false, undefined);
			const agent = result.agents.find((a) => a.agentName === "working-builder");
			expect(agent).toBeDefined();
			expect(agent?.state).toBe("zombie");
		} finally {
			await cleanupTempDir(tempDir);
		}
	});
});

describe("subprocess caching (invalidateStatusCache)", () => {
	afterEach(() => {
		invalidateStatusCache();
	});

	test("invalidateStatusCache is exported and callable", () => {
		// Should not throw
		invalidateStatusCache();
	});

	test("invalidateStatusCache resets cache so gatherStatus re-fetches on next call", async () => {
		const tempDir = await createTempGitRepo();
		const overstoryDir = join(tempDir, ".overstory");
		await mkdir(overstoryDir, { recursive: true });

		try {
			// First call populates the cache
			const result1 = await gatherStatus(tempDir, "orchestrator", false, undefined);
			// Invalidate cache
			invalidateStatusCache();
			// Second call must succeed (re-fetches, no stale cache issues)
			const result2 = await gatherStatus(tempDir, "orchestrator", false, undefined);
			// Both results should have the same structure
			expect(Array.isArray(result1.worktrees)).toBe(true);
			expect(Array.isArray(result2.worktrees)).toBe(true);
		} finally {
			await cleanupTempDir(tempDir);
		}
	});
});

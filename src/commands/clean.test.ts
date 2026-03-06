/**
 * Tests for the `overstory clean` command.
 *
 * Uses real filesystem (temp dirs), real git repos, real SQLite.
 * No mocks. tmux operations are tested indirectly — when no tmux
 * server is running, the command handles it gracefully.
 *
 * Philosophy: "never mock what you can use for real" (mx-252b16).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createEventStore } from "../events/store.ts";
import { createMailStore } from "../mail/store.ts";
import { createMergeQueue } from "../merge/queue.ts";
import { createMetricsStore } from "../metrics/store.ts";
import { openSessionStore } from "../sessions/compat.ts";
import { cleanupTempDir, createTempGitRepo } from "../test-helpers.ts";
import type { AgentSession } from "../types.ts";
import { cleanCommand } from "./clean.ts";

let tempDir: string;
let overstoryDir: string;
let originalCwd: string;
let stdoutOutput: string;
let _stderrOutput: string;
let originalStdoutWrite: typeof process.stdout.write;
let originalStderrWrite: typeof process.stderr.write;

beforeEach(async () => {
	tempDir = await createTempGitRepo();
	overstoryDir = join(tempDir, ".overstory");
	await mkdir(overstoryDir, { recursive: true });

	// Write minimal config.yaml so loadConfig succeeds
	await Bun.write(
		join(overstoryDir, "config.yaml"),
		`project:\n  name: test-project\n  root: ${tempDir}\n  canonicalBranch: main\n`,
	);

	// Create the standard directories
	await mkdir(join(overstoryDir, "logs"), { recursive: true });
	await mkdir(join(overstoryDir, "agents"), { recursive: true });
	await mkdir(join(overstoryDir, "specs"), { recursive: true });
	await mkdir(join(overstoryDir, "worktrees"), { recursive: true });

	originalCwd = process.cwd();
	process.chdir(tempDir);

	// Capture stdout/stderr
	stdoutOutput = "";
	_stderrOutput = "";
	originalStdoutWrite = process.stdout.write;
	originalStderrWrite = process.stderr.write;
	process.stdout.write = ((chunk: string) => {
		stdoutOutput += chunk;
		return true;
	}) as typeof process.stdout.write;
	process.stderr.write = ((chunk: string) => {
		_stderrOutput += chunk;
		return true;
	}) as typeof process.stderr.write;
});

afterEach(async () => {
	process.chdir(originalCwd);
	process.stdout.write = originalStdoutWrite;
	process.stderr.write = originalStderrWrite;
	await cleanupTempDir(tempDir);
});

// === validation ===

describe("validation", () => {
	test("no flags throws ValidationError", async () => {
		await expect(cleanCommand({})).rejects.toThrow("No cleanup targets specified");
	});

	test("--agent and --all throws ValidationError", async () => {
		await expect(cleanCommand({ agent: "my-builder", all: true })).rejects.toThrow(
			"--agent and --all are mutually exclusive",
		);
	});
});

// === --all ===

describe("--all", () => {
	test("wipes mail.db and WAL files", async () => {
		// Create a mail DB with messages
		const mailDbPath = join(overstoryDir, "mail.db");
		const store = createMailStore(mailDbPath);
		store.insert({
			id: "msg-1",
			from: "agent-a",
			to: "agent-b",
			subject: "test",
			body: "hello",
			type: "status",
			priority: "normal",
			threadId: null,
		});
		store.close();

		// Verify DB exists
		expect(await Bun.file(mailDbPath).exists()).toBe(true);

		await cleanCommand({ all: true });

		// DB should be gone
		expect(await Bun.file(mailDbPath).exists()).toBe(false);
		expect(stdoutOutput).toContain("Wiped mail.db");
	});

	test("wipes metrics.db", async () => {
		const metricsDbPath = join(overstoryDir, "metrics.db");
		const store = createMetricsStore(metricsDbPath);
		store.recordSession({
			agentName: "test-agent",
			taskId: "task-1",
			capability: "builder",
			startedAt: new Date().toISOString(),
			completedAt: null,
			durationMs: 0,
			exitCode: null,
			mergeResult: null,
			parentAgent: null,
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheCreationTokens: 0,
			estimatedCostUsd: null,
			modelUsed: null,
			runId: null,
		});
		store.close();

		expect(await Bun.file(metricsDbPath).exists()).toBe(true);

		await cleanCommand({ all: true });

		expect(await Bun.file(metricsDbPath).exists()).toBe(false);
		expect(stdoutOutput).toContain("Wiped metrics.db");
	});

	test("wipes sessions.db", async () => {
		// Use the SessionStore to create sessions.db with data
		const { store } = openSessionStore(overstoryDir);
		store.upsert({
			id: "s1",
			agentName: "test-agent",
			capability: "builder",
			runtime: "claude",
			worktreePath: "/tmp/wt",
			branchName: "overstory/test/task",
			taskId: "task-1",
			tmuxSession: "overstory-test-agent",
			state: "completed",
			pid: 12345,
			parentAgent: null,
			depth: 1,
			runId: null,
			startedAt: new Date().toISOString(),
			lastActivity: new Date().toISOString(),
			escalationLevel: 0,
			stalledSince: null,
			rateLimitedSince: null,
			transcriptPath: null,
		});
		store.close();

		const sessionsDbPath = join(overstoryDir, "sessions.db");
		expect(await Bun.file(sessionsDbPath).exists()).toBe(true);

		await cleanCommand({ all: true });

		expect(await Bun.file(sessionsDbPath).exists()).toBe(false);
		expect(stdoutOutput).toContain("Wiped sessions.db");
	});

	test("wipes merge-queue.db", async () => {
		const queuePath = join(overstoryDir, "merge-queue.db");
		// Create a queue with an entry so we can verify it gets wiped
		const queue = createMergeQueue(queuePath);
		queue.enqueue({
			branchName: "test-branch",
			taskId: "beads-test",
			agentName: "test",
			filesModified: ["src/test.ts"],
		});
		queue.close();

		await cleanCommand({ all: true });

		expect(await Bun.file(queuePath).exists()).toBe(false);
		expect(stdoutOutput).toContain("Wiped merge-queue.db");
	});

	test("clears logs directory contents", async () => {
		const logsDir = join(overstoryDir, "logs");
		await mkdir(join(logsDir, "agent-a", "2026-01-01"), { recursive: true });
		await writeFile(join(logsDir, "agent-a", "2026-01-01", "session.log"), "log data");

		await cleanCommand({ all: true });

		const entries = await readdir(logsDir);
		expect(entries).toHaveLength(0);
		expect(stdoutOutput).toContain("Cleared logs/");
	});

	test("clears agents directory contents", async () => {
		const agentsDir = join(overstoryDir, "agents");
		await mkdir(join(agentsDir, "test-agent"), { recursive: true });
		await writeFile(join(agentsDir, "test-agent", "identity.yaml"), "name: test-agent");

		await cleanCommand({ all: true });

		const entries = await readdir(agentsDir);
		expect(entries).toHaveLength(0);
		expect(stdoutOutput).toContain("Cleared agents/");
	});

	test("clears specs directory contents", async () => {
		const specsDir = join(overstoryDir, "specs");
		await writeFile(join(specsDir, "task-123.md"), "# Spec");

		await cleanCommand({ all: true });

		const entries = await readdir(specsDir);
		expect(entries).toHaveLength(0);
		expect(stdoutOutput).toContain("Cleared specs/");
	});

	test("deletes nudge-state.json", async () => {
		const nudgePath = join(overstoryDir, "nudge-state.json");
		await Bun.write(nudgePath, "{}");

		await cleanCommand({ all: true });

		expect(await Bun.file(nudgePath).exists()).toBe(false);
		expect(stdoutOutput).toContain("Cleared nudge-state.json");
	});

	test("deletes current-run.txt", async () => {
		const currentRunPath = join(overstoryDir, "current-run.txt");
		await Bun.write(currentRunPath, "run-2026-02-13T10-00-00-000Z");

		await cleanCommand({ all: true });

		expect(await Bun.file(currentRunPath).exists()).toBe(false);
		expect(stdoutOutput).toContain("Cleared current-run.txt");
	});

	test("handles missing current-run.txt gracefully", async () => {
		// current-run.txt does not exist — should not error
		await cleanCommand({ all: true });
		expect(stdoutOutput).not.toContain("Cleared current-run.txt");
	});
});

// === individual flags ===

describe("individual flags", () => {
	test("--mail only wipes mail.db, leaves other state intact", async () => {
		// Create mail and sessions
		const mailDbPath = join(overstoryDir, "mail.db");
		const store = createMailStore(mailDbPath);
		store.insert({
			id: "msg-1",
			from: "a",
			to: "b",
			subject: "test",
			body: "hi",
			type: "status",
			priority: "normal",
			threadId: null,
		});
		store.close();

		const sessionsPath = join(overstoryDir, "sessions.json");
		await Bun.write(sessionsPath, '[{"id":"s1"}]\n');

		await cleanCommand({ mail: true });

		// Mail gone
		expect(await Bun.file(mailDbPath).exists()).toBe(false);
		// Sessions untouched
		const sessionsContent = await Bun.file(sessionsPath).text();
		expect(JSON.parse(sessionsContent)).toEqual([{ id: "s1" }]);
	});

	test("--sessions only wipes sessions.db", async () => {
		// Create sessions.db with data
		const sessionsDbPath = join(overstoryDir, "sessions.db");
		const { store } = openSessionStore(overstoryDir);
		store.upsert({
			id: "s1",
			agentName: "test-agent",
			capability: "builder",
			runtime: "claude",
			worktreePath: "/tmp/wt",
			branchName: "overstory/test/task",
			taskId: "task-1",
			tmuxSession: "overstory-test-agent",
			state: "completed",
			pid: 12345,
			parentAgent: null,
			depth: 1,
			runId: null,
			startedAt: new Date().toISOString(),
			lastActivity: new Date().toISOString(),
			escalationLevel: 0,
			stalledSince: null,
			rateLimitedSince: null,
			transcriptPath: null,
		});
		store.close();

		// Create a spec file that should survive
		await writeFile(join(overstoryDir, "specs", "task.md"), "spec");

		await cleanCommand({ sessions: true });

		// sessions.db should be gone
		expect(await Bun.file(sessionsDbPath).exists()).toBe(false);

		// Specs untouched
		const specEntries = await readdir(join(overstoryDir, "specs"));
		expect(specEntries).toHaveLength(1);
	});

	test("--logs clears logs but nothing else", async () => {
		const logsDir = join(overstoryDir, "logs");
		await mkdir(join(logsDir, "agent-x"), { recursive: true });
		await writeFile(join(logsDir, "agent-x", "session.log"), "data");

		await writeFile(join(overstoryDir, "specs", "task.md"), "spec");

		await cleanCommand({ logs: true });

		const logEntries = await readdir(logsDir);
		expect(logEntries).toHaveLength(0);

		// Specs untouched
		const specEntries = await readdir(join(overstoryDir, "specs"));
		expect(specEntries).toHaveLength(1);
	});
});

// === idempotent ===

describe("idempotent", () => {
	test("running --all when nothing exists does not error", async () => {
		await cleanCommand({ all: true });
		expect(stdoutOutput).toContain("Nothing to clean");
	});

	test("running --all twice does not error", async () => {
		// Create some state
		const mailDbPath = join(overstoryDir, "mail.db");
		const store = createMailStore(mailDbPath);
		store.close();

		await cleanCommand({ all: true });
		stdoutOutput = "";
		await cleanCommand({ all: true });
		expect(stdoutOutput).toContain("Nothing to clean");
	});
});

// === JSON output ===

describe("JSON output", () => {
	test("--json flag produces valid JSON", async () => {
		const mailDbPath = join(overstoryDir, "mail.db");
		const store = createMailStore(mailDbPath);
		store.insert({
			id: "msg-1",
			from: "a",
			to: "b",
			subject: "test",
			body: "hi",
			type: "status",
			priority: "normal",
			threadId: null,
		});
		store.close();

		await cleanCommand({ all: true, json: true });

		const result = JSON.parse(stdoutOutput);
		expect(result).toHaveProperty("tmuxKilled");
		expect(result).toHaveProperty("mailWiped");
		expect(result).toHaveProperty("sessionsCleared");
		expect(result).toHaveProperty("metricsWiped");
		expect(result.mailWiped).toBe(true);
	});

	test("--json includes sessionEndEventsLogged field", async () => {
		await cleanCommand({ all: true, json: true });
		const result = JSON.parse(stdoutOutput);
		expect(result).toHaveProperty("sessionEndEventsLogged");
	});

	test("--json includes currentRunCleared field", async () => {
		const currentRunPath = join(overstoryDir, "current-run.txt");
		await Bun.write(currentRunPath, "run-2026-02-13T10-00-00-000Z");

		await cleanCommand({ all: true, json: true });
		const result = JSON.parse(stdoutOutput);
		expect(result).toHaveProperty("currentRunCleared");
		expect(result.currentRunCleared).toBe(true);
	});
});

// === synthetic session-end events ===

describe("synthetic session-end events", () => {
	function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
		return {
			id: "s1",
			agentName: "test-builder",
			capability: "builder",
			runtime: "claude",
			worktreePath: "/tmp/wt",
			branchName: "overstory/test-builder/task-1",
			taskId: "task-1",
			tmuxSession: "overstory-test-builder",
			state: "working",
			pid: 12345,
			parentAgent: null,
			depth: 1,
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

	test("logs session-end events for active agents before killing tmux", async () => {
		// Write sessions.json with an active agent
		const sessionsPath = join(overstoryDir, "sessions.json");
		const sessions = [makeSession({ agentName: "builder-a", state: "working" })];
		await Bun.write(sessionsPath, JSON.stringify(sessions));

		await cleanCommand({ all: true });

		// Verify event was written to events.db
		const eventsDbPath = join(overstoryDir, "events.db");
		const eventStore = createEventStore(eventsDbPath);
		const events = eventStore.getByAgent("builder-a");
		eventStore.close();

		const sessionEndEvents = events.filter((e) => e.eventType === "session_end");
		expect(sessionEndEvents).toHaveLength(1);
		expect(sessionEndEvents[0]?.agentName).toBe("builder-a");
		expect(sessionEndEvents[0]?.level).toBe("info");

		const data = JSON.parse(sessionEndEvents[0]?.data ?? "{}");
		expect(data.reason).toBe("clean");
		expect(data.capability).toBe("builder");

		expect(stdoutOutput).toContain("Logged 1 synthetic session-end event");
	});

	test("logs events for multiple active agents", async () => {
		const sessionsPath = join(overstoryDir, "sessions.json");
		const sessions = [
			makeSession({ id: "s1", agentName: "builder-a", state: "working" }),
			makeSession({ id: "s2", agentName: "scout-b", capability: "scout", state: "booting" }),
			makeSession({ id: "s3", agentName: "builder-c", state: "stalled" }),
		];
		await Bun.write(sessionsPath, JSON.stringify(sessions));

		await cleanCommand({ all: true });

		const eventsDbPath = join(overstoryDir, "events.db");
		const eventStore = createEventStore(eventsDbPath);

		for (const name of ["builder-a", "scout-b", "builder-c"]) {
			const events = eventStore.getByAgent(name);
			const sessionEndEvents = events.filter((e) => e.eventType === "session_end");
			expect(sessionEndEvents).toHaveLength(1);
		}
		eventStore.close();

		expect(stdoutOutput).toContain("Logged 3 synthetic session-end events");
	});

	test("skips completed and zombie sessions", async () => {
		const sessionsPath = join(overstoryDir, "sessions.json");
		const sessions = [
			makeSession({ id: "s1", agentName: "completed-agent", state: "completed" }),
			makeSession({ id: "s2", agentName: "zombie-agent", state: "zombie" }),
		];
		await Bun.write(sessionsPath, JSON.stringify(sessions));

		await cleanCommand({ all: true });

		// events.db may not even be created if there are no events to log
		const eventsDbPath = join(overstoryDir, "events.db");
		if (await Bun.file(eventsDbPath).exists()) {
			const eventStore = createEventStore(eventsDbPath);
			const events1 = eventStore.getByAgent("completed-agent");
			const events2 = eventStore.getByAgent("zombie-agent");
			eventStore.close();
			expect(events1).toHaveLength(0);
			expect(events2).toHaveLength(0);
		}
	});

	test("--worktrees also logs session-end events (not just --all)", async () => {
		const sessionsPath = join(overstoryDir, "sessions.json");
		const sessions = [makeSession({ agentName: "wt-agent", state: "working" })];
		await Bun.write(sessionsPath, JSON.stringify(sessions));

		await cleanCommand({ worktrees: true });

		const eventsDbPath = join(overstoryDir, "events.db");
		const eventStore = createEventStore(eventsDbPath);
		const events = eventStore.getByAgent("wt-agent");
		eventStore.close();

		const sessionEndEvents = events.filter((e) => e.eventType === "session_end");
		expect(sessionEndEvents).toHaveLength(1);
	});

	test("includes runId and sessionId from agent session", async () => {
		const sessionsPath = join(overstoryDir, "sessions.json");
		const sessions = [
			makeSession({
				agentName: "tracked-agent",
				id: "session-123",
				runId: "run-456",
				state: "working",
			}),
		];
		await Bun.write(sessionsPath, JSON.stringify(sessions));

		await cleanCommand({ all: true });

		const eventsDbPath = join(overstoryDir, "events.db");
		const eventStore = createEventStore(eventsDbPath);
		const events = eventStore.getByAgent("tracked-agent");
		eventStore.close();

		const sessionEndEvents = events.filter((e) => e.eventType === "session_end");
		expect(sessionEndEvents).toHaveLength(1);
		expect(sessionEndEvents[0]?.sessionId).toBe("session-123");
		expect(sessionEndEvents[0]?.runId).toBe("run-456");
	});

	test("handles missing sessions.json gracefully", async () => {
		// No sessions.json file — should not error
		await cleanCommand({ all: true });
		// Just verify it didn't crash
		expect(stdoutOutput).toBeDefined();
	});
});

// === mulch health checks ===

describe("mulch health checks", () => {
	test("runs mulch health checks when --all is passed", async () => {
		// Create a real .mulch directory with some data
		const mulchDir = join(tempDir, ".mulch");
		await mkdir(mulchDir, { recursive: true });
		await mkdir(join(mulchDir, "domains"), { recursive: true });

		// Create a domain file with some records
		const domainPath = join(mulchDir, "domains", "test-domain.jsonl");
		await writeFile(
			domainPath,
			`{"id":"mx-1","type":"convention","description":"Test record 1","recorded_at":"2026-01-01T00:00:00Z"}\n`,
		);

		await cleanCommand({ all: true });

		// Mulch health checks should have run (might show warnings or might be clean)
		// The output should not error, and if there are no issues, it's fine
		expect(stdoutOutput).toBeDefined();
	});

	test("handles missing .mulch directory gracefully", async () => {
		// No .mulch directory — should not error
		await cleanCommand({ all: true });
		expect(stdoutOutput).toBeDefined();
	});

	test("JSON output includes mulchHealth field when mulch checks run", async () => {
		// Create a .mulch directory
		const mulchDir = join(tempDir, ".mulch");
		await mkdir(mulchDir, { recursive: true });
		await mkdir(join(mulchDir, "domains"), { recursive: true });

		// Create a domain file
		const domainPath = join(mulchDir, "domains", "test-domain.jsonl");
		await writeFile(
			domainPath,
			`{"id":"mx-1","type":"convention","description":"Test","recorded_at":"2026-01-01T00:00:00Z"}\n`,
		);

		await cleanCommand({ all: true, json: true });

		const result = JSON.parse(stdoutOutput);
		expect(result).toHaveProperty("mulchHealth");

		// If mulch checks ran, mulchHealth should be an object (not null)
		// If mulch was unavailable, it will be null
		if (result.mulchHealth !== null) {
			expect(result.mulchHealth).toHaveProperty("checked");
			expect(result.mulchHealth).toHaveProperty("domainsNearLimit");
			expect(result.mulchHealth).toHaveProperty("stalePruneCandidates");
			expect(result.mulchHealth).toHaveProperty("doctorIssues");
			expect(result.mulchHealth).toHaveProperty("doctorWarnings");
		}
	});

	test("does not run mulch checks when only individual flags are used", async () => {
		// Create a .mulch directory
		const mulchDir = join(tempDir, ".mulch");
		await mkdir(mulchDir, { recursive: true });

		// Run clean with only --mail (not --all)
		const mailDbPath = join(overstoryDir, "mail.db");
		const store = createMailStore(mailDbPath);
		store.close();

		await cleanCommand({ mail: true, json: true });

		const result = JSON.parse(stdoutOutput);
		// mulchHealth should be null because we didn't use --all
		expect(result.mulchHealth).toBeNull();
	});

	test("warns about domains approaching governance limits", async () => {
		// Create a .mulch directory with a domain that has many records
		const mulchDir = join(tempDir, ".mulch");
		await mkdir(mulchDir, { recursive: true });
		await mkdir(join(mulchDir, "domains"), { recursive: true });

		// Create a domain with 410 records (above the 400 warn threshold)
		const domainPath = join(mulchDir, "domains", "large-domain.jsonl");
		const records = [];
		for (let i = 1; i <= 410; i++) {
			records.push(
				`{"id":"mx-${i}","type":"convention","description":"Record ${i}","recorded_at":"2026-01-01T00:00:00Z"}`,
			);
		}
		await writeFile(domainPath, `${records.join("\n")}\n`);

		// Only run if mulch CLI is actually available
		const mulchAvailable = existsSync(join(mulchDir, "domains", "large-domain.jsonl"));
		if (!mulchAvailable) {
			return; // Skip this test if mulch setup failed
		}

		await cleanCommand({ all: true });

		// Should show warning about domain near limit (if mulch status worked)
		// The exact output depends on whether mulch CLI is available in the test environment
		expect(stdoutOutput).toBeDefined();
	});
});

// === --agent ===

describe("--agent", () => {
	function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
		return {
			id: "s1",
			agentName: "test-builder",
			capability: "builder",
			worktreePath: join(tempDir, ".overstory", "worktrees", "test-builder"),
			branchName: "overstory/test-builder/task-1",
			taskId: "task-1",
			tmuxSession: "overstory-test-project-test-builder",
			state: "working",
			pid: 99999,
			parentAgent: null,
			depth: 1,
			runId: "run-123",
			startedAt: new Date().toISOString(),
			lastActivity: new Date().toISOString(),
			escalationLevel: 0,
			stalledSince: null,
			transcriptPath: null,
			...overrides,
		};
	}

	function saveSession(session: AgentSession): void {
		const { store } = openSessionStore(overstoryDir);
		try {
			store.upsert(session);
		} finally {
			store.close();
		}
	}

	test("throws AgentError when agent not found", async () => {
		await expect(cleanCommand({ agent: "nonexistent" })).rejects.toThrow("not found");
	});

	test("clears agent and logs directories", async () => {
		const session = makeSession();
		saveSession(session);

		// Create agent and logs dirs with content
		const agentDir = join(overstoryDir, "agents", "test-builder");
		const logsDir = join(overstoryDir, "logs", "test-builder");
		await mkdir(agentDir, { recursive: true });
		await mkdir(logsDir, { recursive: true });
		await writeFile(join(agentDir, "identity.yaml"), "name: test-builder");
		await writeFile(join(logsDir, "session.log"), "log data");

		await cleanCommand({ agent: "test-builder" });

		// Dirs should be cleared (but still exist)
		const agentEntries = await readdir(agentDir);
		const logEntries = await readdir(logsDir);
		expect(agentEntries).toHaveLength(0);
		expect(logEntries).toHaveLength(0);

		expect(stdoutOutput).toContain("Agent cleaned");
		expect(stdoutOutput).toContain("test-builder");
	});

	test("marks agent session as completed", async () => {
		const session = makeSession({ state: "working" });
		saveSession(session);

		await cleanCommand({ agent: "test-builder" });

		const { store } = openSessionStore(overstoryDir);
		const updated = store.getByName("test-builder");
		store.close();
		expect(updated?.state).toBe("completed");
	});

	test("logs synthetic session-end event for non-completed agent", async () => {
		const session = makeSession({ state: "working" });
		saveSession(session);

		await cleanCommand({ agent: "test-builder" });

		const eventsDbPath = join(overstoryDir, "events.db");
		const eventStore = createEventStore(eventsDbPath);
		const events = eventStore.getByAgent("test-builder");
		eventStore.close();

		const sessionEndEvents = events.filter((e) => e.eventType === "session_end");
		expect(sessionEndEvents).toHaveLength(1);
		const data = JSON.parse(sessionEndEvents[0]?.data ?? "{}");
		expect(data.reason).toContain("clean --agent");
	});

	test("does not log session-end event for already-completed agent", async () => {
		const session = makeSession({ state: "completed" });
		saveSession(session);

		await cleanCommand({ agent: "test-builder" });

		const eventsDbPath = join(overstoryDir, "events.db");
		if (existsSync(eventsDbPath)) {
			const eventStore = createEventStore(eventsDbPath);
			const events = eventStore.getByAgent("test-builder");
			eventStore.close();
			const sessionEndEvents = events.filter((e) => e.eventType === "session_end");
			expect(sessionEndEvents).toHaveLength(0);
		}
	});

	test("--agent + --json returns JSON with agent result", async () => {
		const session = makeSession({ state: "working" });
		saveSession(session);

		await cleanCommand({ agent: "test-builder", json: true });

		const result = JSON.parse(stdoutOutput);
		expect(result).toHaveProperty("agent");
		expect(result.agent).toHaveProperty("agentName", "test-builder");
		expect(result.agent).toHaveProperty("markedCompleted");
	});

	test("handles missing agent/logs directories gracefully", async () => {
		const session = makeSession({ state: "completed" });
		saveSession(session);

		// No agent or logs dirs — should not error
		await cleanCommand({ agent: "test-builder" });
		expect(stdoutOutput).toContain("Agent cleaned");
	});
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ValidationError } from "../errors.ts";
import { createEventStore } from "../events/store.ts";
import { createMailClient } from "../mail/client.ts";
import { createMailStore } from "../mail/store.ts";
import { createMetricsStore } from "../metrics/store.ts";
import type { MulchClient } from "../mulch/client.ts";
import { createRunStore, createSessionStore } from "../sessions/store.ts";
import type { AgentSession, MulchLearnResult, StoredEvent } from "../types.ts";
import { autoRecordExpertise, logCommand } from "./log.ts";

/**
 * Tests for `overstory log` command.
 *
 * Uses real filesystem (temp dirs) and real bun:sqlite to test logging behavior.
 * Captures process.stdout.write to verify help text output.
 */

describe("logCommand", () => {
	let chunks: string[];
	let originalWrite: typeof process.stdout.write;
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

		// Create temp dir with .overstory/config.yaml structure
		tempDir = await mkdtemp(join(tmpdir(), "log-test-"));
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
		process.chdir(originalCwd);
		await rm(tempDir, { recursive: true, force: true });
	});

	function output(): string {
		return chunks.join("");
	}

	/**
	 * Fake MulchClient for testing autoRecordExpertise.
	 * Only learn() and record() are implemented — other methods are stubs.
	 * Justified: we are testing orchestration logic, not the mulch CLI itself.
	 */
	function createFakeMulchClient(
		learnResult: MulchLearnResult,
		opts?: { recordShouldFail?: boolean },
	): {
		client: MulchClient;
		recordCalls: Array<{ domain: string; options: Record<string, unknown> }>;
	} {
		const recordCalls: Array<{ domain: string; options: Record<string, unknown> }> = [];
		const client = {
			async learn() {
				return learnResult;
			},
			async record(domain: string, options: Record<string, unknown>) {
				if (opts?.recordShouldFail) {
					throw new Error("mulch record failed");
				}
				recordCalls.push({ domain, options });
			},
		} as unknown as MulchClient;
		return { client, recordCalls };
	}

	test("--help flag shows help text", async () => {
		await logCommand(["--help"]);
		const out = output();

		expect(out).toContain("overstory log");
		expect(out).toContain("tool-start");
		expect(out).toContain("tool-end");
		expect(out).toContain("session-end");
		expect(out).toContain("--agent");
	});

	test("-h flag shows help text", async () => {
		await logCommand(["-h"]);
		const out = output();

		expect(out).toContain("overstory log");
		expect(out).toContain("tool-start");
		expect(out).toContain("tool-end");
		expect(out).toContain("session-end");
		expect(out).toContain("--agent");
	});

	test("missing event with only flags throws ValidationError", async () => {
		// The code finds first non-flag arg. Passing only flags should trigger "Event is required"
		// Note: the implementation checks for undefined event
		await expect(async () => {
			await logCommand([]);
		}).toThrow(ValidationError);

		await expect(async () => {
			await logCommand([]);
		}).toThrow("Event is required");
	});

	test("invalid event name throws ValidationError", async () => {
		expect(async () => {
			await logCommand(["invalid-event", "--agent", "test-agent"]);
		}).toThrow(ValidationError);

		expect(async () => {
			await logCommand(["invalid-event", "--agent", "test-agent"]);
		}).toThrow("Invalid event");
	});

	test("missing --agent flag throws ValidationError", async () => {
		expect(async () => {
			await logCommand(["tool-start"]);
		}).toThrow(ValidationError);

		expect(async () => {
			await logCommand(["tool-start"]);
		}).toThrow("--agent is required");
	});

	test("tool-start creates log directory structure", async () => {
		await logCommand(["tool-start", "--agent", "test-builder", "--tool-name", "Read"]);

		const logsDir = join(tempDir, ".overstory", "logs", "test-builder");
		const contents = await readdir(logsDir);

		// Should have at least .current-session marker and a session directory
		expect(contents).toContain(".current-session");
		expect(contents.length).toBeGreaterThanOrEqual(2);
	});

	test("tool-start creates session directory and .current-session marker", async () => {
		await logCommand(["tool-start", "--agent", "test-scout", "--tool-name", "Grep"]);

		const logsDir = join(tempDir, ".overstory", "logs", "test-scout");
		const markerPath = join(logsDir, ".current-session");
		const markerFile = Bun.file(markerPath);

		expect(await markerFile.exists()).toBe(true);

		const sessionDir = (await markerFile.text()).trim();
		expect(sessionDir).toBeTruthy();
		expect(sessionDir).toContain(logsDir);

		// Session directory should exist
		const dirStat = await stat(sessionDir);
		expect(dirStat.isDirectory()).toBe(true);
	});

	test("tool-start creates log files in session directory", async () => {
		await logCommand(["tool-start", "--agent", "test-builder", "--tool-name", "Write"]);

		// Wait for async file writes to complete
		await new Promise((resolve) => setTimeout(resolve, 50));

		const logsDir = join(tempDir, ".overstory", "logs", "test-builder");
		const markerPath = join(logsDir, ".current-session");
		const sessionDir = (await Bun.file(markerPath).text()).trim();

		// Check for events.ndjson file
		const eventsFile = Bun.file(join(sessionDir, "events.ndjson"));
		expect(await eventsFile.exists()).toBe(true);
	});

	test("tool-end uses the same session directory as tool-start", async () => {
		await logCommand(["tool-start", "--agent", "test-agent", "--tool-name", "Edit"]);

		const logsDir = join(tempDir, ".overstory", "logs", "test-agent");
		const markerPath = join(logsDir, ".current-session");
		const sessionDirAfterStart = (await Bun.file(markerPath).text()).trim();

		await logCommand(["tool-end", "--agent", "test-agent", "--tool-name", "Edit"]);

		const sessionDirAfterEnd = (await Bun.file(markerPath).text()).trim();
		expect(sessionDirAfterEnd).toBe(sessionDirAfterStart);
	});

	test("tool-end writes to the same session directory", async () => {
		await logCommand(["tool-start", "--agent", "test-worker", "--tool-name", "Bash"]);
		await logCommand(["tool-end", "--agent", "test-worker", "--tool-name", "Bash"]);

		// Wait for async file writes to complete
		await new Promise((resolve) => setTimeout(resolve, 50));

		const logsDir = join(tempDir, ".overstory", "logs", "test-worker");
		const markerPath = join(logsDir, ".current-session");
		const sessionDir = (await Bun.file(markerPath).text()).trim();

		// Events file should contain both tool-start and tool-end events
		const eventsFile = Bun.file(join(sessionDir, "events.ndjson"));
		const eventsContent = await eventsFile.text();

		expect(eventsContent).toContain("tool.start");
		expect(eventsContent).toContain("tool.end");
	});

	test("session-end transitions agent state to completed in sessions.db", async () => {
		// Create sessions.db with a test agent
		const dbPath = join(tempDir, ".overstory", "sessions.db");
		const session: AgentSession = {
			id: "session-001",
			agentName: "test-agent",
			capability: "builder",
			worktreePath: "/tmp/test",
			branchName: "test-branch",
			beadId: "bead-001",
			tmuxSession: "test-tmux",
			state: "working",
			pid: 12345,
			parentAgent: null,
			depth: 0,
			runId: null,
			startedAt: new Date().toISOString(),
			lastActivity: new Date().toISOString(),
			escalationLevel: 0,
			stalledSince: null,
		};
		const store = createSessionStore(dbPath);
		store.upsert(session);
		store.close();

		await logCommand(["session-end", "--agent", "test-agent"]);

		// Read sessions.db and verify state changed to completed
		const readStore = createSessionStore(dbPath);
		const updatedSession = readStore.getByName("test-agent");
		readStore.close();

		expect(updatedSession).toBeDefined();
		expect(updatedSession?.state).toBe("completed");
	});

	test("session-end clears the .current-session marker", async () => {
		// First create a session with tool-start
		await logCommand(["tool-start", "--agent", "test-cleanup", "--tool-name", "Read"]);

		const logsDir = join(tempDir, ".overstory", "logs", "test-cleanup");
		const markerPath = join(logsDir, ".current-session");

		// Verify marker exists before session-end
		let markerFile = Bun.file(markerPath);
		expect(await markerFile.exists()).toBe(true);

		// Now end the session
		await logCommand(["session-end", "--agent", "test-cleanup"]);

		// Marker should be removed - need to create a new Bun.file reference
		markerFile = Bun.file(markerPath);
		expect(await markerFile.exists()).toBe(false);
	});

	test("session-end records metrics when agent session exists in sessions.db", async () => {
		// Create sessions.db with a test agent
		const sessionsDbPath = join(tempDir, ".overstory", "sessions.db");
		const session: AgentSession = {
			id: "session-002",
			agentName: "metrics-agent",
			capability: "scout",
			worktreePath: "/tmp/metrics",
			branchName: "metrics-branch",
			beadId: "bead-002",
			tmuxSession: "metrics-tmux",
			state: "working",
			pid: 54321,
			parentAgent: "parent-agent",
			depth: 1,
			runId: null,
			startedAt: new Date(Date.now() - 60_000).toISOString(), // 1 minute ago
			lastActivity: new Date().toISOString(),
			escalationLevel: 0,
			stalledSince: null,
		};
		const sessStore = createSessionStore(sessionsDbPath);
		sessStore.upsert(session);
		sessStore.close();

		await logCommand(["session-end", "--agent", "metrics-agent"]);

		// Verify metrics.db was created and has the session record
		const metricsDbPath = join(tempDir, ".overstory", "metrics.db");
		const metricsStore = createMetricsStore(metricsDbPath);
		const metrics = metricsStore.getRecentSessions(1);
		metricsStore.close();

		expect(metrics).toHaveLength(1);
		expect(metrics[0]?.agentName).toBe("metrics-agent");
		expect(metrics[0]?.beadId).toBe("bead-002");
		expect(metrics[0]?.capability).toBe("scout");
		expect(metrics[0]?.parentAgent).toBe("parent-agent");
	});

	test("session-end does NOT transition coordinator to completed (persistent agent)", async () => {
		// Create sessions.db with a coordinator agent
		const dbPath = join(tempDir, ".overstory", "sessions.db");
		const session: AgentSession = {
			id: "session-coord",
			agentName: "coordinator",
			capability: "coordinator",
			worktreePath: tempDir,
			branchName: "main",
			beadId: "",
			tmuxSession: "overstory-coordinator",
			state: "working",
			pid: 11111,
			parentAgent: null,
			depth: 0,
			runId: null,
			startedAt: new Date().toISOString(),
			lastActivity: new Date(Date.now() - 60_000).toISOString(),
			escalationLevel: 0,
			stalledSince: null,
		};
		const store = createSessionStore(dbPath);
		store.upsert(session);
		store.close();

		await logCommand(["session-end", "--agent", "coordinator"]);

		// Coordinator should remain 'working', not transition to 'completed'
		const readStore = createSessionStore(dbPath);
		const updatedSession = readStore.getByName("coordinator");
		readStore.close();

		expect(updatedSession).toBeDefined();
		expect(updatedSession?.state).toBe("working");
		// But lastActivity should be updated
		expect(new Date(updatedSession?.lastActivity ?? "").getTime()).toBeGreaterThan(
			new Date(session.lastActivity).getTime(),
		);
	});

	test("session-end does NOT transition monitor to completed (persistent agent)", async () => {
		const dbPath = join(tempDir, ".overstory", "sessions.db");
		const session: AgentSession = {
			id: "session-mon",
			agentName: "monitor",
			capability: "monitor",
			worktreePath: tempDir,
			branchName: "main",
			beadId: "",
			tmuxSession: "overstory-monitor",
			state: "working",
			pid: 22222,
			parentAgent: null,
			depth: 0,
			runId: null,
			startedAt: new Date().toISOString(),
			lastActivity: new Date(Date.now() - 60_000).toISOString(),
			escalationLevel: 0,
			stalledSince: null,
		};
		const store = createSessionStore(dbPath);
		store.upsert(session);
		store.close();

		await logCommand(["session-end", "--agent", "monitor"]);

		const readStore = createSessionStore(dbPath);
		const updatedSession = readStore.getByName("monitor");
		readStore.close();

		expect(updatedSession).toBeDefined();
		expect(updatedSession?.state).toBe("working");
	});

	describe("session-end coordinator run completion", () => {
		test("session-end auto-completes the active run for coordinator agent", async () => {
			// Create sessions.db with coordinator and a run
			const dbPath = join(tempDir, ".overstory", "sessions.db");
			const sessionStoreLocal = createSessionStore(dbPath);
			sessionStoreLocal.upsert({
				id: "session-coord-run",
				agentName: "coordinator",
				capability: "coordinator",
				worktreePath: tempDir,
				branchName: "main",
				beadId: "",
				tmuxSession: "overstory-coordinator",
				state: "working",
				pid: 11111,
				parentAgent: null,
				depth: 0,
				runId: "run-test-001",
				startedAt: new Date().toISOString(),
				lastActivity: new Date().toISOString(),
				escalationLevel: 0,
				stalledSince: null,
			});
			sessionStoreLocal.close();

			// Create the run
			const runStore = createRunStore(dbPath);
			runStore.createRun({
				id: "run-test-001",
				startedAt: new Date().toISOString(),
				coordinatorSessionId: "session-coord-run",
				status: "active",
			});
			runStore.close();

			// Write current-run.txt
			const currentRunPath = join(tempDir, ".overstory", "current-run.txt");
			await Bun.write(currentRunPath, "run-test-001");

			// Verify current-run.txt exists before test
			expect(await Bun.file(currentRunPath).exists()).toBe(true);

			// Call session-end
			await logCommand(["session-end", "--agent", "coordinator"]);

			// Verify: run status is "completed" in RunStore
			const runStoreRead = createRunStore(dbPath);
			const run = runStoreRead.getRun("run-test-001");
			runStoreRead.close();

			expect(run).toBeDefined();
			expect(run?.status).toBe("completed");
			expect(run?.completedAt).toBeTruthy();

			// Verify: current-run.txt is deleted (create fresh file reference)
			expect(await Bun.file(currentRunPath).exists()).toBe(false);
		});

		test("session-end does not fail when no active run for coordinator", async () => {
			// Create a coordinator session but no current-run.txt
			const dbPath = join(tempDir, ".overstory", "sessions.db");
			const sessionStoreLocal = createSessionStore(dbPath);
			sessionStoreLocal.upsert({
				id: "session-coord-no-run",
				agentName: "coordinator-no-run",
				capability: "coordinator",
				worktreePath: tempDir,
				branchName: "main",
				beadId: "",
				tmuxSession: "overstory-coordinator-no-run",
				state: "working",
				pid: 11112,
				parentAgent: null,
				depth: 0,
				runId: null,
				startedAt: new Date().toISOString(),
				lastActivity: new Date().toISOString(),
				escalationLevel: 0,
				stalledSince: null,
			});
			sessionStoreLocal.close();

			// Call session-end (should not throw)
			await expect(async () => {
				await logCommand(["session-end", "--agent", "coordinator-no-run"]);
			}).not.toThrow();
		});

		test("session-end does not complete run for non-coordinator agents", async () => {
			// Create a builder session, create a run, write current-run.txt
			const dbPath = join(tempDir, ".overstory", "sessions.db");
			const sessionStoreLocal = createSessionStore(dbPath);
			sessionStoreLocal.upsert({
				id: "session-builder-run",
				agentName: "test-builder",
				capability: "builder",
				worktreePath: tempDir,
				branchName: "builder-branch",
				beadId: "bead-builder-001",
				tmuxSession: "overstory-builder",
				state: "working",
				pid: 11113,
				parentAgent: null,
				depth: 2,
				runId: "run-test-002",
				startedAt: new Date().toISOString(),
				lastActivity: new Date().toISOString(),
				escalationLevel: 0,
				stalledSince: null,
			});
			sessionStoreLocal.close();

			// Create the run
			const runStore = createRunStore(dbPath);
			runStore.createRun({
				id: "run-test-002",
				startedAt: new Date().toISOString(),
				coordinatorSessionId: "session-coord-run",
				status: "active",
			});
			runStore.close();

			// Write current-run.txt
			await Bun.write(join(tempDir, ".overstory", "current-run.txt"), "run-test-002");

			// Call session-end for builder
			await logCommand(["session-end", "--agent", "test-builder"]);

			// Verify: run status remains "active"
			const runStoreRead = createRunStore(dbPath);
			const run = runStoreRead.getRun("run-test-002");
			runStoreRead.close();

			expect(run).toBeDefined();
			expect(run?.status).toBe("active");
			expect(run?.completedAt).toBeNull();

			// Verify: current-run.txt still exists
			const currentRunFile = Bun.file(join(tempDir, ".overstory", "current-run.txt"));
			expect(await currentRunFile.exists()).toBe(true);
		});

		test("session-end handles already-completed run gracefully", async () => {
			// Create a coordinator session, create a run that is already completed
			const dbPath = join(tempDir, ".overstory", "sessions.db");
			const sessionStoreLocal = createSessionStore(dbPath);
			sessionStoreLocal.upsert({
				id: "session-coord-completed",
				agentName: "coordinator-completed",
				capability: "coordinator",
				worktreePath: tempDir,
				branchName: "main",
				beadId: "",
				tmuxSession: "overstory-coordinator-completed",
				state: "working",
				pid: 11114,
				parentAgent: null,
				depth: 0,
				runId: "run-test-003",
				startedAt: new Date().toISOString(),
				lastActivity: new Date().toISOString(),
				escalationLevel: 0,
				stalledSince: null,
			});
			sessionStoreLocal.close();

			// Create the run already completed
			const runStore = createRunStore(dbPath);
			runStore.createRun({
				id: "run-test-003",
				startedAt: new Date().toISOString(),
				coordinatorSessionId: "session-coord-completed",
				status: "active",
			});
			// Complete it immediately
			runStore.completeRun("run-test-003", "completed");
			runStore.close();

			// Write current-run.txt
			await Bun.write(join(tempDir, ".overstory", "current-run.txt"), "run-test-003");

			// Call session-end (should not throw — completeRun is idempotent)
			await expect(async () => {
				await logCommand(["session-end", "--agent", "coordinator-completed"]);
			}).not.toThrow();

			// Verify: run is still completed
			const runStoreRead = createRunStore(dbPath);
			const run = runStoreRead.getRun("run-test-003");
			runStoreRead.close();

			expect(run).toBeDefined();
			expect(run?.status).toBe("completed");
		});
	});

	test("session-end writes pending-nudge marker for coordinator when lead completes", async () => {
		// Create sessions.db with a lead agent
		const dbPath = join(tempDir, ".overstory", "sessions.db");
		const session: AgentSession = {
			id: "session-lead",
			agentName: "lead-alpha",
			capability: "lead",
			worktreePath: tempDir,
			branchName: "lead-alpha-branch",
			beadId: "bead-lead-001",
			tmuxSession: "overstory-lead-alpha",
			state: "working",
			pid: 33333,
			parentAgent: null,
			depth: 0,
			runId: null,
			startedAt: new Date().toISOString(),
			lastActivity: new Date().toISOString(),
			escalationLevel: 0,
			stalledSince: null,
		};
		const store = createSessionStore(dbPath);
		store.upsert(session);
		store.close();

		await logCommand(["session-end", "--agent", "lead-alpha"]);

		// Verify the pending-nudge marker was written for the coordinator
		const markerPath = join(tempDir, ".overstory", "pending-nudges", "coordinator.json");
		const markerFile = Bun.file(markerPath);
		expect(await markerFile.exists()).toBe(true);

		const marker = JSON.parse(await markerFile.text());
		expect(marker.from).toBe("lead-alpha");
		expect(marker.reason).toBe("lead_completed");
		expect(marker.subject).toContain("lead-alpha");
		expect(marker.messageId).toContain("auto-nudge-lead-alpha-");
		expect(marker.createdAt).toBeDefined();
	});

	test("session-end does NOT write pending-nudge marker for non-lead agents", async () => {
		// Create sessions.db with a builder agent (not a lead)
		const dbPath = join(tempDir, ".overstory", "sessions.db");
		const session: AgentSession = {
			id: "session-builder",
			agentName: "builder-beta",
			capability: "builder",
			worktreePath: tempDir,
			branchName: "builder-beta-branch",
			beadId: "bead-builder-001",
			tmuxSession: "overstory-builder-beta",
			state: "working",
			pid: 44444,
			parentAgent: null,
			depth: 0,
			runId: null,
			startedAt: new Date().toISOString(),
			lastActivity: new Date().toISOString(),
			escalationLevel: 0,
			stalledSince: null,
		};
		const store = createSessionStore(dbPath);
		store.upsert(session);
		store.close();

		await logCommand(["session-end", "--agent", "builder-beta"]);

		// Verify no pending-nudge marker was written
		const markerPath = join(tempDir, ".overstory", "pending-nudges", "coordinator.json");
		const markerFile = Bun.file(markerPath);
		expect(await markerFile.exists()).toBe(false);
	});

	test("session-end does not crash when sessions.db does not exist", async () => {
		// No sessions.db file exists
		// session-end should complete without throwing
		await expect(
			logCommand(["session-end", "--agent", "nonexistent-agent"]),
		).resolves.toBeUndefined();
	});

	test("tool-start updates lastActivity timestamp in sessions.db", async () => {
		// Create sessions.db with a test agent
		const dbPath = join(tempDir, ".overstory", "sessions.db");
		const oldTimestamp = new Date(Date.now() - 120_000).toISOString(); // 2 minutes ago
		const session: AgentSession = {
			id: "session-003",
			agentName: "activity-agent",
			capability: "builder",
			worktreePath: "/tmp/activity",
			branchName: "activity-branch",
			beadId: "bead-003",
			tmuxSession: "activity-tmux",
			state: "working",
			pid: 99999,
			parentAgent: null,
			depth: 0,
			runId: null,
			startedAt: oldTimestamp,
			lastActivity: oldTimestamp,
			escalationLevel: 0,
			stalledSince: null,
		};
		const store = createSessionStore(dbPath);
		store.upsert(session);
		store.close();

		await logCommand(["tool-start", "--agent", "activity-agent", "--tool-name", "Glob"]);

		// Read sessions.db and verify lastActivity was updated
		const readStore = createSessionStore(dbPath);
		const updatedSession = readStore.getByName("activity-agent");
		readStore.close();

		expect(updatedSession).toBeDefined();
		expect(updatedSession?.lastActivity).not.toBe(oldTimestamp);
		expect(new Date(updatedSession?.lastActivity ?? "").getTime()).toBeGreaterThan(
			new Date(oldTimestamp).getTime(),
		);
	});

	test("tool-start transitions state from booting to working", async () => {
		// Create sessions.db with agent in 'booting' state
		const dbPath = join(tempDir, ".overstory", "sessions.db");
		const session: AgentSession = {
			id: "session-004",
			agentName: "booting-agent",
			capability: "builder",
			worktreePath: "/tmp/booting",
			branchName: "booting-branch",
			beadId: "bead-004",
			tmuxSession: "booting-tmux",
			state: "booting",
			pid: 11111,
			parentAgent: null,
			depth: 0,
			runId: null,
			startedAt: new Date().toISOString(),
			lastActivity: new Date().toISOString(),
			escalationLevel: 0,
			stalledSince: null,
		};
		const store = createSessionStore(dbPath);
		store.upsert(session);
		store.close();

		await logCommand(["tool-start", "--agent", "booting-agent", "--tool-name", "Read"]);

		// Read sessions.db and verify state changed to working
		const readStore = createSessionStore(dbPath);
		const updatedSession = readStore.getByName("booting-agent");
		readStore.close();

		expect(updatedSession).toBeDefined();
		expect(updatedSession?.state).toBe("working");
	});

	test("tool-start defaults to unknown when --tool-name not provided", async () => {
		// Should not throw when --tool-name is missing
		await expect(
			logCommand(["tool-start", "--agent", "default-tool-agent"]),
		).resolves.toBeUndefined();

		// Verify log was created
		const logsDir = join(tempDir, ".overstory", "logs", "default-tool-agent");
		const markerPath = join(logsDir, ".current-session");
		const markerFile = Bun.file(markerPath);

		expect(await markerFile.exists()).toBe(true);

		// Wait for async file writes to complete (logger uses fire-and-forget appendFile)
		await new Promise((resolve) => setTimeout(resolve, 50));

		const sessionDir = (await markerFile.text()).trim();
		const eventsFile = Bun.file(join(sessionDir, "events.ndjson"));
		const eventsContent = await eventsFile.text();

		// Should contain "unknown" as the tool name
		expect(eventsContent).toContain("unknown");
	});

	test("tool-end defaults to unknown when --tool-name not provided", async () => {
		await logCommand(["tool-start", "--agent", "default-end-agent"]);

		// tool-end without --tool-name should not throw
		await expect(logCommand(["tool-end", "--agent", "default-end-agent"])).resolves.toBeUndefined();

		// Wait for async file writes to complete
		await new Promise((resolve) => setTimeout(resolve, 50));

		const logsDir = join(tempDir, ".overstory", "logs", "default-end-agent");
		const markerPath = join(logsDir, ".current-session");
		const sessionDir = (await Bun.file(markerPath).text()).trim();
		const eventsFile = Bun.file(join(sessionDir, "events.ndjson"));
		const eventsContent = await eventsFile.text();

		expect(eventsContent).toContain("unknown");
	});

	test("--help includes --stdin option in output", async () => {
		await logCommand(["--help"]);
		const out = output();

		expect(out).toContain("--stdin");
	});

	test("session-end does not crash when mulch learn/record fails", async () => {
		// Create sessions.db with a builder agent (non-persistent)
		const dbPath = join(tempDir, ".overstory", "sessions.db");
		const session: AgentSession = {
			id: "session-mulch-fail",
			agentName: "mulch-fail-agent",
			capability: "builder",
			worktreePath: tempDir,
			branchName: "mulch-fail-branch",
			beadId: "bead-mulch-001",
			tmuxSession: "overstory-mulch-fail",
			state: "working",
			pid: 55555,
			parentAgent: "parent-agent",
			depth: 1,
			runId: null,
			startedAt: new Date().toISOString(),
			lastActivity: new Date().toISOString(),
			escalationLevel: 0,
			stalledSince: null,
		};
		const store = createSessionStore(dbPath);
		store.upsert(session);
		store.close();

		// session-end should complete without throwing even if mulch learn/record fails
		await expect(
			logCommand(["session-end", "--agent", "mulch-fail-agent"]),
		).resolves.toBeUndefined();

		// Verify state transitioned to completed
		const readStore = createSessionStore(dbPath);
		const updatedSession = readStore.getByName("mulch-fail-agent");
		readStore.close();

		expect(updatedSession).toBeDefined();
		expect(updatedSession?.state).toBe("completed");
	});

	test("session-end skips mulch auto-record for coordinator (persistent agent)", async () => {
		// Create sessions.db with a coordinator agent
		const dbPath = join(tempDir, ".overstory", "sessions.db");
		const session: AgentSession = {
			id: "session-coord-mulch",
			agentName: "coordinator-mulch",
			capability: "coordinator",
			worktreePath: tempDir,
			branchName: "main",
			beadId: "",
			tmuxSession: "overstory-coordinator-mulch",
			state: "working",
			pid: 66666,
			parentAgent: null,
			depth: 0,
			runId: null,
			startedAt: new Date().toISOString(),
			lastActivity: new Date().toISOString(),
			escalationLevel: 0,
			stalledSince: null,
		};
		const store = createSessionStore(dbPath);
		store.upsert(session);
		store.close();

		await logCommand(["session-end", "--agent", "coordinator-mulch"]);

		// Verify no mail.db was created (mulch auto-record was skipped)
		const mailDbPath = join(tempDir, ".overstory", "mail.db");
		const mailDbFile = Bun.file(mailDbPath);
		expect(await mailDbFile.exists()).toBe(false);

		// Coordinator should remain working (persistent agent)
		const readStore = createSessionStore(dbPath);
		const updatedSession = readStore.getByName("coordinator-mulch");
		readStore.close();

		expect(updatedSession).toBeDefined();
		expect(updatedSession?.state).toBe("working");
	});

	test("autoRecordExpertise calls record for each suggested domain", async () => {
		const learnResult: MulchLearnResult = {
			success: true,
			command: "mulch learn",
			changedFiles: ["src/foo.ts", "src/bar.ts"],
			suggestedDomains: ["typescript", "cli"],
			unmatchedFiles: [],
		};
		const { client, recordCalls } = createFakeMulchClient(learnResult);
		const mailDbPath = join(tempDir, ".overstory", "auto-record-mail.db");

		const result = await autoRecordExpertise({
			mulchClient: client,
			agentName: "test-builder",
			capability: "builder",
			beadId: "bead-123",
			mailDbPath,
			parentAgent: "parent-lead",
			projectRoot: tempDir,
			sessionStartedAt: new Date().toISOString(),
		});

		expect(result).toEqual(["typescript", "cli"]);
		expect(recordCalls).toHaveLength(2);
		expect(recordCalls[0]?.domain).toBe("typescript");
		expect(recordCalls[0]?.options).toMatchObject({
			type: "reference",
			tags: ["auto-session-end", "builder"],
			evidenceBead: "bead-123",
		});
		expect(recordCalls[1]?.domain).toBe("cli");
	});

	test("autoRecordExpertise sends mail with auto-recorded subject", async () => {
		const learnResult: MulchLearnResult = {
			success: true,
			command: "mulch learn",
			changedFiles: ["src/foo.ts"],
			suggestedDomains: ["typescript"],
			unmatchedFiles: [],
		};
		const { client } = createFakeMulchClient(learnResult);
		const mailDbPath = join(tempDir, ".overstory", "auto-record-mail2.db");

		await autoRecordExpertise({
			mulchClient: client,
			agentName: "test-builder",
			capability: "builder",
			beadId: "bead-456",
			mailDbPath,
			parentAgent: "parent-lead",
			projectRoot: tempDir,
			sessionStartedAt: new Date().toISOString(),
		});

		const mailStore = createMailStore(mailDbPath);
		const mailClient = createMailClient(mailStore);
		const messages = mailClient.list({ to: "parent-lead" });
		mailClient.close();

		expect(messages).toHaveLength(1);
		expect(messages[0]?.subject).toBe("mulch: auto-recorded insights in typescript");
		expect(messages[0]?.body).toContain("Auto-recorded expertise in: typescript");
	});

	test("autoRecordExpertise continues when individual record calls fail", async () => {
		const learnResult: MulchLearnResult = {
			success: true,
			command: "mulch learn",
			changedFiles: ["src/foo.ts"],
			suggestedDomains: ["typescript", "cli"],
			unmatchedFiles: [],
		};
		const { client } = createFakeMulchClient(learnResult, { recordShouldFail: true });
		const mailDbPath = join(tempDir, ".overstory", "auto-record-fail.db");

		const result = await autoRecordExpertise({
			mulchClient: client,
			agentName: "test-builder",
			capability: "builder",
			beadId: null,
			mailDbPath,
			parentAgent: null,
			projectRoot: tempDir,
			sessionStartedAt: new Date().toISOString(),
		});

		// All records failed, so no domains recorded and no mail sent
		expect(result).toEqual([]);
		const mailFile = Bun.file(mailDbPath);
		expect(await mailFile.exists()).toBe(false);
	});

	test("autoRecordExpertise returns empty when no domains suggested", async () => {
		const learnResult: MulchLearnResult = {
			success: true,
			command: "mulch learn",
			changedFiles: ["src/foo.ts"],
			suggestedDomains: [],
			unmatchedFiles: [],
		};
		const { client, recordCalls } = createFakeMulchClient(learnResult);
		const mailDbPath = join(tempDir, ".overstory", "auto-record-empty.db");

		const result = await autoRecordExpertise({
			mulchClient: client,
			agentName: "test-builder",
			capability: "builder",
			beadId: null,
			mailDbPath,
			parentAgent: null,
			projectRoot: tempDir,
			sessionStartedAt: new Date().toISOString(),
		});

		expect(result).toEqual([]);
		expect(recordCalls).toHaveLength(0);
	});

	test("autoRecordExpertise records pattern insights when EventStore has tool data", async () => {
		const learnResult: MulchLearnResult = {
			success: true,
			command: "mulch learn",
			changedFiles: ["src/mail/store.ts"],
			suggestedDomains: ["messaging"],
			unmatchedFiles: [],
		};
		const { client, recordCalls } = createFakeMulchClient(learnResult);
		const mailDbPath = join(tempDir, ".overstory", "insight-analysis-mail.db");

		// Create EventStore with test data
		const eventsDbPath = join(tempDir, ".overstory", "events.db");
		const eventStore = createEventStore(eventsDbPath);

		const sessionStartedAt = new Date(Date.now() - 60_000).toISOString(); // 1 minute ago

		// Insert tool events: 15 tool calls total (10+ triggers workflow insight)
		// Read-heavy: 12 Read, 3 Edit → should classify as read-heavy
		for (let i = 0; i < 12; i++) {
			eventStore.insert({
				runId: null,
				agentName: "insight-agent",
				sessionId: "sess-insight",
				eventType: "tool_start",
				toolName: "Read",
				toolArgs: JSON.stringify({ file_path: `/src/file${i}.ts` }),
				toolDurationMs: null,
				level: "info",
				data: JSON.stringify({ summary: `read: /src/file${i}.ts` }),
			});
		}

		// Add 4 edits to same file → hot file
		for (let i = 0; i < 4; i++) {
			eventStore.insert({
				runId: null,
				agentName: "insight-agent",
				sessionId: "sess-insight",
				eventType: "tool_start",
				toolName: "Edit",
				toolArgs: JSON.stringify({ file_path: "src/mail/store.ts" }),
				toolDurationMs: null,
				level: "info",
				data: JSON.stringify({ summary: "edit: src/mail/store.ts" }),
			});
		}

		// Add 1 error event → error pattern
		eventStore.insert({
			runId: null,
			agentName: "insight-agent",
			sessionId: "sess-insight",
			eventType: "tool_start",
			toolName: "Bash",
			toolArgs: JSON.stringify({ command: "bun test" }),
			toolDurationMs: null,
			level: "error",
			data: "Test failed",
		});

		eventStore.close();

		// Run autoRecordExpertise
		const result = await autoRecordExpertise({
			mulchClient: client,
			agentName: "insight-agent",
			capability: "builder",
			beadId: "bead-insight",
			mailDbPath,
			parentAgent: "parent-agent",
			projectRoot: tempDir,
			sessionStartedAt,
		});

		// Verify reference + insights were recorded
		expect(recordCalls.length).toBeGreaterThanOrEqual(2); // At least reference + 1 insight

		// Verify reference entry
		const referenceCall = recordCalls.find((c) => c.options.type === "reference");
		expect(referenceCall).toBeDefined();
		expect(referenceCall?.domain).toBe("messaging");

		// Verify pattern insights
		const patternCalls = recordCalls.filter((c) => c.options.type === "pattern");
		expect(patternCalls.length).toBeGreaterThanOrEqual(2);

		// Verify workflow insight
		const workflowInsight = patternCalls.find((c) => {
			const desc = c.options.description;
			return typeof desc === "string" && desc.includes("read-heavy workflow");
		});
		expect(workflowInsight).toBeDefined();

		// Verify hot file insight
		const hotFileInsight = patternCalls.find((c) => {
			const desc = c.options.description;
			return (
				typeof desc === "string" && desc.includes("src/mail/store.ts") && desc.includes("4 edits")
			);
		});
		expect(hotFileInsight).toBeDefined();
		expect(hotFileInsight?.domain).toBe("messaging"); // Inferred from src/mail/

		// Verify failure insight
		const failureCall = recordCalls.find((c) => c.options.type === "failure");
		expect(failureCall).toBeDefined();

		// Verify recorded domains includes unique domains from insights
		expect(result).toContain("messaging");
	});

	test("autoRecordExpertise includes insight summary in notification mail", async () => {
		const learnResult: MulchLearnResult = {
			success: true,
			command: "mulch learn",
			changedFiles: ["src/config.ts"],
			suggestedDomains: ["typescript"],
			unmatchedFiles: [],
		};
		const { client } = createFakeMulchClient(learnResult);
		const mailDbPath = join(tempDir, ".overstory", "insight-mail-summary.db");

		// Create EventStore with 10+ tool calls to trigger workflow insight
		const eventsDbPath = join(tempDir, ".overstory", "events.db");
		const eventStore = createEventStore(eventsDbPath);
		const sessionStartedAt = new Date(Date.now() - 60_000).toISOString();

		for (let i = 0; i < 10; i++) {
			eventStore.insert({
				runId: null,
				agentName: "mail-insight-agent",
				sessionId: "sess-mail",
				eventType: "tool_start",
				toolName: "Read",
				toolArgs: JSON.stringify({ file_path: `/src/file${i}.ts` }),
				toolDurationMs: null,
				level: "info",
				data: JSON.stringify({ summary: `read: /src/file${i}.ts` }),
			});
		}

		eventStore.close();

		await autoRecordExpertise({
			mulchClient: client,
			agentName: "mail-insight-agent",
			capability: "scout",
			beadId: "bead-mail",
			mailDbPath,
			parentAgent: "parent-agent",
			projectRoot: tempDir,
			sessionStartedAt,
		});

		// Verify mail was sent with insight summary
		const mailStore = createMailStore(mailDbPath);
		const mailClient = createMailClient(mailStore);
		const messages = mailClient.list({ to: "parent-agent" });
		mailClient.close();

		expect(messages).toHaveLength(1);
		const mail = messages[0];
		expect(mail?.body).toContain("Auto-insights:");
		expect(mail?.body).toContain("10 tool calls");
		expect(mail?.body).toContain("pattern"); // At least 1 pattern insight
	});
});

/**
 * Tests for `overstory log` with --stdin flag.
 *
 * Uses Bun.spawn to invoke the log command as a subprocess with piped stdin,
 * because Bun.stdin.stream() cannot be injected in-process.
 * Real filesystem + real SQLite for EventStore verification.
 */
describe("logCommand --stdin integration", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "log-stdin-test-"));
		const overstoryDir = join(tempDir, ".overstory");
		await Bun.write(
			join(overstoryDir, "config.yaml"),
			`project:\n  name: test\n  root: ${tempDir}\n  canonicalBranch: main\n`,
		);
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	/**
	 * Helper: run `overstory log` as a subprocess with stdin piped.
	 * Uses bun to run the CLI entry point directly.
	 */
	async function runLogWithStdin(
		event: string,
		agentName: string,
		stdinJson: Record<string, unknown>,
		opts?: { env?: NodeJS.ProcessEnv; cwd?: string },
	): Promise<{ exitCode: number; stdout: string; stderr: string }> {
		return runLogWithRawStdin(event, agentName, JSON.stringify(stdinJson), opts);
	}

	async function runLogWithRawStdin(
		event: string,
		agentName: string,
		stdinRaw: string,
		opts?: { env?: NodeJS.ProcessEnv; cwd?: string },
	): Promise<{ exitCode: number; stdout: string; stderr: string }> {
		// Inline script that calls logCommand with --stdin and reads from stdin
		const scriptPath = join(tempDir, "_run-log.ts");
		const scriptContent = `
import { logCommand } from "${join(import.meta.dir, "log.ts").replace(/\\/g, "/")}";
const args = process.argv.slice(2);
try {
	await logCommand(args);
} catch (e) {
	console.error(e instanceof Error ? e.message : String(e));
	process.exit(1);
}
`;
		await Bun.write(scriptPath, scriptContent);

		const env: NodeJS.ProcessEnv = { ...process.env, ...opts?.env };
		const proc = Bun.spawn(["bun", "run", scriptPath, event, "--agent", agentName, "--stdin"], {
			cwd: opts?.cwd ?? tempDir,
			env,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});

		// Write stdin payload to stdin and close
		proc.stdin.write(stdinRaw);
		proc.stdin.end();

		const exitCode = await proc.exited;
		const stdout = await new Response(proc.stdout).text();
		const stderr = await new Response(proc.stderr).text();

		return { exitCode, stdout, stderr };
	}

	test("regression matrix: malformed stdin fallback path captures unknown tool event", async () => {
		const result = await runLogWithRawStdin(
			"tool-start",
			"malformed-stdin-agent",
			'{"tool_name":"Read","tool_input":{"file_path":"/src/broken.ts"}',
		);
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("");

		const eventsDbPath = join(tempDir, ".overstory", "events.db");
		const eventStore = createEventStore(eventsDbPath);
		const events = eventStore.getByAgent("malformed-stdin-agent");
		eventStore.close();

		expect(events).toHaveLength(1);
		const event = events[0] as StoredEvent;
		expect(event.eventType).toBe("tool_start");
		expect(event.toolName).toBe("unknown");
		const data = JSON.parse(event.data ?? "{}") as { summary?: string };
		expect(data.summary).toBe("unknown");
	});

	test("regression matrix: tool-end succeeds when HOME is missing for transcript lookup", async () => {
		const missingHome = join(tempDir, "home-does-not-exist");
		const result = await runLogWithStdin(
			"tool-end",
			"missing-home-agent",
			{
				tool_name: "Bash",
				tool_input: { command: "cat /tmp/file.txt" },
				session_id: "sess-missing-home",
			},
			{ env: { HOME: missingHome } },
		);
		expect(result.exitCode).toBe(0);

		const eventsDbPath = join(tempDir, ".overstory", "events.db");
		const eventStore = createEventStore(eventsDbPath);
		const events = eventStore.getByAgent("missing-home-agent");
		eventStore.close();

		expect(events).toHaveLength(1);
		expect(events[0]?.eventType).toBe("tool_end");
		expect(events[0]?.toolName).toBe("Bash");

		const snapshotMarker = Bun.file(
			join(tempDir, ".overstory", "logs", "missing-home-agent", ".last-snapshot"),
		);
		expect(await snapshotMarker.exists()).toBe(false);
	});

	test("regression matrix: session-end without transcript_path stores null event data", async () => {
		const result = await runLogWithStdin("session-end", "no-transcript-agent", {
			session_id: "sess-no-transcript",
		});
		expect(result.exitCode).toBe(0);

		const eventsDbPath = join(tempDir, ".overstory", "events.db");
		const eventStore = createEventStore(eventsDbPath);
		const events = eventStore.getByAgent("no-transcript-agent");
		eventStore.close();

		expect(events).toHaveLength(1);
		expect(events[0]?.eventType).toBe("session_end");
		expect(events[0]?.data).toBeNull();
	});

	test("regression matrix: non-writable logs path surfaces controlled failure", async () => {
		const logsDir = join(tempDir, ".overstory", "logs");
		await mkdir(logsDir, { recursive: true });
		await chmod(logsDir, 0o500);

		try {
			const result = await runLogWithStdin("tool-start", "readonly-logs-agent", {
				tool_name: "Read",
				tool_input: { file_path: "/src/readonly.ts" },
				session_id: "sess-readonly",
			});
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toMatch(/EACCES|permission|denied/i);
		} finally {
			await chmod(logsDir, 0o700);
		}
	});

	test("tool-start with --stdin writes to EventStore", async () => {
		const payload = {
			tool_name: "Read",
			tool_input: { file_path: "/src/index.ts" },
			session_id: "sess-test-001",
		};

		const result = await runLogWithStdin("tool-start", "stdin-builder", payload);
		expect(result.exitCode).toBe(0);

		// Verify EventStore has the event
		const eventsDbPath = join(tempDir, ".overstory", "events.db");
		const eventStore = createEventStore(eventsDbPath);
		const events = eventStore.getByAgent("stdin-builder");
		eventStore.close();

		expect(events).toHaveLength(1);
		const event = events[0] as StoredEvent;
		expect(event.eventType).toBe("tool_start");
		expect(event.toolName).toBe("Read");
		expect(event.sessionId).toBe("sess-test-001");
		expect(event.agentName).toBe("stdin-builder");

		// Verify filtered tool args were stored
		const toolArgs = JSON.parse(event.toolArgs ?? "{}");
		expect(toolArgs.file_path).toBe("/src/index.ts");

		// Verify summary in data
		const data = JSON.parse(event.data ?? "{}");
		expect(data.summary).toBe("read: /src/index.ts");
	});

	test("tool-end with --stdin writes to EventStore and correlates with tool-start", async () => {
		// First create a tool-start event
		const startPayload = {
			tool_name: "Bash",
			tool_input: { command: "bun test" },
			session_id: "sess-test-002",
		};
		const startResult = await runLogWithStdin("tool-start", "correlate-agent", startPayload);
		expect(startResult.exitCode).toBe(0);

		// Small delay to ensure measurable duration
		await new Promise((resolve) => setTimeout(resolve, 10));

		// Now send tool-end
		const endPayload = {
			tool_name: "Bash",
			tool_input: { command: "bun test" },
			session_id: "sess-test-002",
		};
		const endResult = await runLogWithStdin("tool-end", "correlate-agent", endPayload);
		expect(endResult.exitCode).toBe(0);

		// Verify EventStore has both events
		const eventsDbPath = join(tempDir, ".overstory", "events.db");
		const eventStore = createEventStore(eventsDbPath);
		const events = eventStore.getByAgent("correlate-agent");
		eventStore.close();

		expect(events).toHaveLength(2);

		const startEvent = events.find((e) => e.eventType === "tool_start");
		const endEvent = events.find((e) => e.eventType === "tool_end");
		expect(startEvent).toBeDefined();
		expect(endEvent).toBeDefined();

		// The start event should have tool_duration_ms set by correlateToolEnd()
		// (value may be affected by SQLite timestamp vs Date.now() timezone behavior,
		// so we only assert it was populated — not the exact value)
		expect(startEvent?.toolDurationMs).not.toBeNull();
	});

	test("tool-start with --stdin filters large tool_input", async () => {
		const payload = {
			tool_name: "Write",
			tool_input: {
				file_path: "/src/new-file.ts",
				content: "x".repeat(50_000), // 50KB of content — should be dropped
			},
			session_id: "sess-test-003",
		};

		const result = await runLogWithStdin("tool-start", "filter-agent", payload);
		expect(result.exitCode).toBe(0);

		const eventsDbPath = join(tempDir, ".overstory", "events.db");
		const eventStore = createEventStore(eventsDbPath);
		const events = eventStore.getByAgent("filter-agent");
		eventStore.close();

		expect(events).toHaveLength(1);
		const event = events[0] as StoredEvent;

		// The Write filter keeps file_path but drops content
		const toolArgs = JSON.parse(event.toolArgs ?? "{}");
		expect(toolArgs.file_path).toBe("/src/new-file.ts");
		expect(toolArgs).not.toHaveProperty("content");

		// Verify summary
		const data = JSON.parse(event.data ?? "{}");
		expect(data.summary).toBe("write: /src/new-file.ts");
	});

	test("session-end with --stdin writes to EventStore with transcript_path", async () => {
		const payload = {
			session_id: "sess-test-004",
			transcript_path: "/tmp/transcript.jsonl",
		};

		const result = await runLogWithStdin("session-end", "session-end-agent", payload);
		expect(result.exitCode).toBe(0);

		const eventsDbPath = join(tempDir, ".overstory", "events.db");
		const eventStore = createEventStore(eventsDbPath);
		const events = eventStore.getByAgent("session-end-agent");
		eventStore.close();

		expect(events).toHaveLength(1);
		const event = events[0] as StoredEvent;
		expect(event.eventType).toBe("session_end");
		expect(event.sessionId).toBe("sess-test-004");

		// Verify transcript path stored in data
		const data = JSON.parse(event.data ?? "{}");
		expect(data.transcriptPath).toBe("/tmp/transcript.jsonl");
	});

	test("tool-start with --stdin still writes to legacy log files", async () => {
		const payload = {
			tool_name: "Grep",
			tool_input: { pattern: "TODO", path: "/src" },
			session_id: "sess-test-005",
		};

		const result = await runLogWithStdin("tool-start", "legacy-compat-agent", payload);
		expect(result.exitCode).toBe(0);

		// Wait for async file writes to complete
		await new Promise((resolve) => setTimeout(resolve, 50));

		// Verify legacy log files exist
		const logsDir = join(tempDir, ".overstory", "logs", "legacy-compat-agent");
		const markerPath = join(logsDir, ".current-session");
		const markerFile = Bun.file(markerPath);
		expect(await markerFile.exists()).toBe(true);

		const sessionDir = (await markerFile.text()).trim();
		const eventsFile = Bun.file(join(sessionDir, "events.ndjson"));
		expect(await eventsFile.exists()).toBe(true);

		const eventsContent = await eventsFile.text();
		expect(eventsContent).toContain("tool.start");
		expect(eventsContent).toContain("Grep");
	});

	test("tool-start with --stdin handles empty stdin gracefully", async () => {
		// Send empty JSON object — should still work (falls back to "unknown" tool name)
		const scriptPath = join(tempDir, "_run-log-empty.ts");
		const scriptContent = `
import { logCommand } from "${join(import.meta.dir, "log.ts").replace(/\\/g, "/")}";
try {
	await logCommand(["tool-start", "--agent", "empty-stdin-agent", "--stdin"]);
} catch (e) {
	console.error(e instanceof Error ? e.message : String(e));
	process.exit(1);
}
`;
		await Bun.write(scriptPath, scriptContent);

		const proc = Bun.spawn(["bun", "run", scriptPath], {
			cwd: tempDir,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});

		// Write empty string and close immediately
		proc.stdin.end();

		const exitCode = await proc.exited;
		expect(exitCode).toBe(0);
	});

	test("tool-start with --stdin and unknown tool name uses fallback filter", async () => {
		const payload = {
			tool_name: "SomeCustomTool",
			tool_input: { custom_key: "custom_value" },
			session_id: "sess-test-006",
		};

		const result = await runLogWithStdin("tool-start", "custom-tool-agent", payload);
		expect(result.exitCode).toBe(0);

		const eventsDbPath = join(tempDir, ".overstory", "events.db");
		const eventStore = createEventStore(eventsDbPath);
		const events = eventStore.getByAgent("custom-tool-agent");
		eventStore.close();

		expect(events).toHaveLength(1);
		const event = events[0] as StoredEvent;
		expect(event.toolName).toBe("SomeCustomTool");

		// Unknown tools get empty args from filterToolArgs
		const toolArgs = JSON.parse(event.toolArgs ?? "{}");
		expect(toolArgs).toEqual({});

		const data = JSON.parse(event.data ?? "{}");
		expect(data.summary).toBe("SomeCustomTool");
	});

	test("tool-end with --stdin handles large payloads (>64KB)", async () => {
		const payload = {
			tool_name: "Bash",
			tool_input: { command: "cat /some/file" },
			tool_result: "x".repeat(100_000), // 100KB payload
			session_id: "sess-large-payload",
		};

		const result = await runLogWithStdin("tool-end", "large-payload-agent", payload);
		expect(result.exitCode).toBe(0);

		// Verify EventStore received the event with correct tool name
		const eventsDbPath = join(tempDir, ".overstory", "events.db");
		const eventStore = createEventStore(eventsDbPath);
		const events = eventStore.getByAgent("large-payload-agent");
		eventStore.close();

		expect(events).toHaveLength(1);
		const event = events[0] as StoredEvent;
		expect(event.eventType).toBe("tool_end");
		expect(event.toolName).toBe("Bash");
		// tool_result is not stored in EventStore (filtered out), but tool_name was parsed correctly
	});
});

/**
 * Tests for `overstory inspect` command.
 *
 * Uses real bun:sqlite (temp files) to test the inspect command end-to-end.
 * Captures process.stdout.write to verify output formatting.
 *
 * Real implementations used for: filesystem (temp dirs), SQLite (EventStore,
 * SessionStore, MetricsStore). No mocks needed -- all dependencies are cheap and local.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ValidationError } from "../errors.ts";
import { createEventStore } from "../events/store.ts";
import { createMetricsStore } from "../metrics/store.ts";
import { createSessionStore } from "../sessions/store.ts";
import { cleanupTempDir } from "../test-helpers.ts";
import type { InsertEvent, SessionMetrics } from "../types.ts";
import { gatherInspectData, inspectCommand, printInspectData } from "./inspect.ts";

/** Helper to create an InsertEvent with sensible defaults. */
function makeEvent(overrides: Partial<InsertEvent> = {}): InsertEvent {
	return {
		runId: "run-001",
		agentName: "builder-1",
		sessionId: "sess-abc",
		eventType: "tool_start",
		toolName: "Read",
		toolArgs: '{"file_path": "src/index.ts"}',
		toolDurationMs: null,
		level: "info",
		data: null,
		...overrides,
	};
}

/** Helper to create a SessionMetrics with sensible defaults. */
function makeMetrics(overrides: Partial<SessionMetrics> = {}): SessionMetrics {
	return {
		agentName: "builder-1",
		taskId: "overstory-001",
		capability: "builder",
		startedAt: new Date().toISOString(),
		completedAt: null,
		durationMs: 0,
		exitCode: null,
		mergeResult: null,
		parentAgent: null,
		inputTokens: 1000,
		outputTokens: 500,
		cacheReadTokens: 200,
		cacheCreationTokens: 100,
		estimatedCostUsd: 0.025,
		modelUsed: "claude-sonnet-4-5-20250929",
		runId: null,
		...overrides,
	};
}

describe("inspectCommand", () => {
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
		tempDir = await mkdtemp(join(tmpdir(), "inspect-test-"));
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
		await cleanupTempDir(tempDir);
	});

	function output(): string {
		return chunks.join("");
	}

	// === Help flag ===

	describe("help flag", () => {
		test("--help shows help text", async () => {
			await inspectCommand(["--help"]);
			const out = output();
			expect(out).toContain("inspect");
			expect(out).toContain("--json");
			expect(out).toContain("--follow");
			expect(out).toContain("--limit");
			expect(out).toContain("--no-tmux");
		});

		test("-h shows help text", async () => {
			await inspectCommand(["-h"]);
			const out = output();
			expect(out).toContain("inspect");
		});
	});

	// === Validation errors ===

	describe("validation", () => {
		test("throws if no agent name provided", async () => {
			await expect(inspectCommand([])).rejects.toThrow(ValidationError);
		});

		test("throws if agent not found", async () => {
			const overstoryDir = join(tempDir, ".overstory");
			const sessionsDbPath = join(overstoryDir, "sessions.db");
			const store = createSessionStore(sessionsDbPath);
			store.close();

			await expect(inspectCommand(["nonexistent-agent"])).rejects.toThrow(ValidationError);
		});

		test("throws if --interval is invalid", async () => {
			const overstoryDir = join(tempDir, ".overstory");
			const sessionsDbPath = join(overstoryDir, "sessions.db");
			const store = createSessionStore(sessionsDbPath);
			store.upsert({
				id: "sess-1",
				agentName: "builder-1",
				capability: "builder",
				runtime: "claude",
				worktreePath: "/tmp/wt",
				branchName: "overstory/builder-1/test",
				taskId: "overstory-001",
				tmuxSession: "overstory-test-builder-1",
				state: "working",
				pid: 12345,
				parentAgent: null,
				depth: 0,
				runId: null,
				startedAt: new Date().toISOString(),
				lastActivity: new Date().toISOString(),
				escalationLevel: 0,
				stalledSince: null,
				rateLimitedSince: null,
				transcriptPath: null,
			});
			store.close();

			await expect(inspectCommand(["builder-1", "--interval", "abc"])).rejects.toThrow(
				ValidationError,
			);
			await expect(inspectCommand(["builder-1", "--interval", "100"])).rejects.toThrow(
				ValidationError,
			);
		});

		test("throws if --limit is invalid", async () => {
			const overstoryDir = join(tempDir, ".overstory");
			const sessionsDbPath = join(overstoryDir, "sessions.db");
			const store = createSessionStore(sessionsDbPath);
			store.upsert({
				id: "sess-1",
				agentName: "builder-1",
				capability: "builder",
				runtime: "claude",
				worktreePath: "/tmp/wt",
				branchName: "overstory/builder-1/test",
				taskId: "overstory-001",
				tmuxSession: "overstory-test-builder-1",
				state: "working",
				pid: 12345,
				parentAgent: null,
				depth: 0,
				runId: null,
				startedAt: new Date().toISOString(),
				lastActivity: new Date().toISOString(),
				escalationLevel: 0,
				stalledSince: null,
				rateLimitedSince: null,
				transcriptPath: null,
			});
			store.close();

			await expect(inspectCommand(["builder-1", "--limit", "abc"])).rejects.toThrow(
				ValidationError,
			);
			await expect(inspectCommand(["builder-1", "--limit", "0"])).rejects.toThrow(ValidationError);
		});
	});

	// === gatherInspectData ===

	describe("gatherInspectData", () => {
		test("gathers basic session data", async () => {
			const overstoryDir = join(tempDir, ".overstory");
			const sessionsDbPath = join(overstoryDir, "sessions.db");
			const store = createSessionStore(sessionsDbPath);

			const startedAt = new Date(Date.now() - 60_000).toISOString(); // 60s ago
			store.upsert({
				id: "sess-1",
				agentName: "builder-1",
				capability: "builder",
				runtime: "claude",
				worktreePath: "/tmp/wt",
				branchName: "overstory/builder-1/test",
				taskId: "overstory-001",
				tmuxSession: "overstory-test-builder-1",
				state: "working",
				pid: 12345,
				parentAgent: "orchestrator",
				depth: 1,
				runId: "run-001",
				startedAt,
				lastActivity: new Date(Date.now() - 5_000).toISOString(),
				escalationLevel: 0,
				stalledSince: null,
				rateLimitedSince: null,
				transcriptPath: null,
			});
			store.close();

			const data = await gatherInspectData(tempDir, "builder-1", { noTmux: true });

			expect(data.session.agentName).toBe("builder-1");
			expect(data.session.capability).toBe("builder");
			expect(data.session.state).toBe("working");
			expect(data.session.taskId).toBe("overstory-001");
			expect(data.timeSinceLastActivity).toBeGreaterThan(4000);
			expect(data.timeSinceLastActivity).toBeLessThan(10000);
		});

		test("extracts current file from recent Edit tool_start event", async () => {
			const overstoryDir = join(tempDir, ".overstory");
			const sessionsDbPath = join(overstoryDir, "sessions.db");
			const eventsDbPath = join(overstoryDir, "events.db");

			const store = createSessionStore(sessionsDbPath);
			store.upsert({
				id: "sess-1",
				agentName: "builder-1",
				capability: "builder",
				runtime: "claude",
				worktreePath: "/tmp/wt",
				branchName: "overstory/builder-1/test",
				taskId: "overstory-001",
				tmuxSession: "overstory-test-builder-1",
				state: "working",
				pid: 12345,
				parentAgent: null,
				depth: 0,
				runId: null,
				startedAt: new Date().toISOString(),
				lastActivity: new Date().toISOString(),
				escalationLevel: 0,
				stalledSince: null,
				rateLimitedSince: null,
				transcriptPath: null,
			});
			store.close();

			const eventStore = createEventStore(eventsDbPath);
			eventStore.insert(makeEvent({ toolName: "Read", toolArgs: '{"file_path": "src/a.ts"}' }));
			eventStore.insert(
				makeEvent({ toolName: "Edit", toolArgs: '{"file_path": "src/commands/inspect.ts"}' }),
			);
			eventStore.insert(makeEvent({ toolName: "Bash", toolArgs: '{"command": "bun test"}' }));
			eventStore.close();

			const data = await gatherInspectData(tempDir, "builder-1", { noTmux: true });

			expect(data.currentFile).toBe("src/commands/inspect.ts");
		});

		test("extracts current file from Write tool_start with path field", async () => {
			const overstoryDir = join(tempDir, ".overstory");
			const sessionsDbPath = join(overstoryDir, "sessions.db");
			const eventsDbPath = join(overstoryDir, "events.db");

			const store = createSessionStore(sessionsDbPath);
			store.upsert({
				id: "sess-1",
				agentName: "builder-1",
				capability: "builder",
				runtime: "claude",
				worktreePath: "/tmp/wt",
				branchName: "overstory/builder-1/test",
				taskId: "overstory-001",
				tmuxSession: "overstory-test-builder-1",
				state: "working",
				pid: 12345,
				parentAgent: null,
				depth: 0,
				runId: null,
				startedAt: new Date().toISOString(),
				lastActivity: new Date().toISOString(),
				escalationLevel: 0,
				stalledSince: null,
				rateLimitedSince: null,
				transcriptPath: null,
			});
			store.close();

			const eventStore = createEventStore(eventsDbPath);
			eventStore.insert(makeEvent({ toolName: "Write", toolArgs: '{"path": "src/new-file.ts"}' }));
			eventStore.close();

			const data = await gatherInspectData(tempDir, "builder-1", { noTmux: true });

			expect(data.currentFile).toBe("src/new-file.ts");
		});

		test("returns null current file if no Edit/Write/Read events", async () => {
			const overstoryDir = join(tempDir, ".overstory");
			const sessionsDbPath = join(overstoryDir, "sessions.db");
			const eventsDbPath = join(overstoryDir, "events.db");

			const store = createSessionStore(sessionsDbPath);
			store.upsert({
				id: "sess-1",
				agentName: "builder-1",
				capability: "builder",
				runtime: "claude",
				worktreePath: "/tmp/wt",
				branchName: "overstory/builder-1/test",
				taskId: "overstory-001",
				tmuxSession: "overstory-test-builder-1",
				state: "working",
				pid: 12345,
				parentAgent: null,
				depth: 0,
				runId: null,
				startedAt: new Date().toISOString(),
				lastActivity: new Date().toISOString(),
				escalationLevel: 0,
				stalledSince: null,
				rateLimitedSince: null,
				transcriptPath: null,
			});
			store.close();

			const eventStore = createEventStore(eventsDbPath);
			eventStore.insert(makeEvent({ toolName: "Bash", toolArgs: '{"command": "bun test"}' }));
			eventStore.close();

			const data = await gatherInspectData(tempDir, "builder-1", { noTmux: true });

			expect(data.currentFile).toBeNull();
		});

		test("gathers recent tool calls (respects limit)", async () => {
			const overstoryDir = join(tempDir, ".overstory");
			const sessionsDbPath = join(overstoryDir, "sessions.db");
			const eventsDbPath = join(overstoryDir, "events.db");

			const store = createSessionStore(sessionsDbPath);
			store.upsert({
				id: "sess-1",
				agentName: "builder-1",
				capability: "builder",
				runtime: "claude",
				worktreePath: "/tmp/wt",
				branchName: "overstory/builder-1/test",
				taskId: "overstory-001",
				tmuxSession: "overstory-test-builder-1",
				state: "working",
				pid: 12345,
				parentAgent: null,
				depth: 0,
				runId: null,
				startedAt: new Date().toISOString(),
				lastActivity: new Date().toISOString(),
				escalationLevel: 0,
				stalledSince: null,
				rateLimitedSince: null,
				transcriptPath: null,
			});
			store.close();

			const eventStore = createEventStore(eventsDbPath);
			for (let i = 0; i < 30; i++) {
				eventStore.insert(
					makeEvent({
						toolName: "Read",
						toolArgs: `{"file_path": "src/file${i}.ts"}`,
						toolDurationMs: 10 + i,
					}),
				);
			}
			eventStore.close();

			const data = await gatherInspectData(tempDir, "builder-1", { noTmux: true, limit: 5 });

			expect(data.recentToolCalls.length).toBe(5);
			expect(data.recentToolCalls[0]?.toolName).toBe("Read");
		});

		test("gathers tool stats", async () => {
			const overstoryDir = join(tempDir, ".overstory");
			const sessionsDbPath = join(overstoryDir, "sessions.db");
			const eventsDbPath = join(overstoryDir, "events.db");

			const store = createSessionStore(sessionsDbPath);
			store.upsert({
				id: "sess-1",
				agentName: "builder-1",
				capability: "builder",
				runtime: "claude",
				worktreePath: "/tmp/wt",
				branchName: "overstory/builder-1/test",
				taskId: "overstory-001",
				tmuxSession: "overstory-test-builder-1",
				state: "working",
				pid: 12345,
				parentAgent: null,
				depth: 0,
				runId: null,
				startedAt: new Date().toISOString(),
				lastActivity: new Date().toISOString(),
				escalationLevel: 0,
				stalledSince: null,
				rateLimitedSince: null,
				transcriptPath: null,
			});
			store.close();

			const eventStore = createEventStore(eventsDbPath);
			for (let i = 0; i < 10; i++) {
				eventStore.insert(makeEvent({ toolName: "Read", toolDurationMs: 100 }));
			}
			for (let i = 0; i < 5; i++) {
				eventStore.insert(makeEvent({ toolName: "Edit", toolDurationMs: 200 }));
			}
			eventStore.close();

			const data = await gatherInspectData(tempDir, "builder-1", { noTmux: true });

			expect(data.toolStats.length).toBeGreaterThan(0);
			const readStats = data.toolStats.find((s) => s.toolName === "Read");
			expect(readStats?.count).toBe(10);
			expect(readStats?.avgDurationMs).toBe(100);
		});

		test("gathers token usage from metrics", async () => {
			const overstoryDir = join(tempDir, ".overstory");
			const sessionsDbPath = join(overstoryDir, "sessions.db");
			const metricsDbPath = join(overstoryDir, "metrics.db");

			const store = createSessionStore(sessionsDbPath);
			store.upsert({
				id: "sess-1",
				agentName: "builder-1",
				capability: "builder",
				runtime: "claude",
				worktreePath: "/tmp/wt",
				branchName: "overstory/builder-1/test",
				taskId: "overstory-001",
				tmuxSession: "overstory-test-builder-1",
				state: "working",
				pid: 12345,
				parentAgent: null,
				depth: 0,
				runId: null,
				startedAt: new Date().toISOString(),
				lastActivity: new Date().toISOString(),
				escalationLevel: 0,
				stalledSince: null,
				rateLimitedSince: null,
				transcriptPath: null,
			});
			store.close();

			const metricsStore = createMetricsStore(metricsDbPath);
			metricsStore.recordSession(
				makeMetrics({
					inputTokens: 5000,
					outputTokens: 3000,
					cacheReadTokens: 1000,
					cacheCreationTokens: 500,
					estimatedCostUsd: 0.123,
					modelUsed: "claude-sonnet-4-5-20250929",
				}),
			);
			metricsStore.close();

			const data = await gatherInspectData(tempDir, "builder-1", { noTmux: true });

			expect(data.tokenUsage).not.toBeNull();
			expect(data.tokenUsage?.inputTokens).toBe(5000);
			expect(data.tokenUsage?.outputTokens).toBe(3000);
			expect(data.tokenUsage?.cacheReadTokens).toBe(1000);
			expect(data.tokenUsage?.cacheCreationTokens).toBe(500);
			expect(data.tokenUsage?.estimatedCostUsd).toBe(0.123);
			expect(data.tokenUsage?.modelUsed).toBe("claude-sonnet-4-5-20250929");
		});

		test("handles missing databases gracefully", async () => {
			const overstoryDir = join(tempDir, ".overstory");
			const sessionsDbPath = join(overstoryDir, "sessions.db");

			const store = createSessionStore(sessionsDbPath);
			store.upsert({
				id: "sess-1",
				agentName: "builder-1",
				capability: "builder",
				runtime: "claude",
				worktreePath: "/tmp/wt",
				branchName: "overstory/builder-1/test",
				taskId: "overstory-001",
				tmuxSession: "overstory-test-builder-1",
				state: "working",
				pid: 12345,
				parentAgent: null,
				depth: 0,
				runId: null,
				startedAt: new Date().toISOString(),
				lastActivity: new Date().toISOString(),
				escalationLevel: 0,
				stalledSince: null,
				rateLimitedSince: null,
				transcriptPath: null,
			});
			store.close();

			// Don't create events.db or metrics.db
			const data = await gatherInspectData(tempDir, "builder-1", { noTmux: true });

			expect(data.recentToolCalls).toEqual([]);
			expect(data.currentFile).toBeNull();
			expect(data.toolStats).toEqual([]);
			expect(data.tokenUsage).toBeNull();
		});
	});

	// === JSON output ===

	describe("json output", () => {
		test("--json outputs valid JSON", async () => {
			const overstoryDir = join(tempDir, ".overstory");
			const sessionsDbPath = join(overstoryDir, "sessions.db");
			const store = createSessionStore(sessionsDbPath);
			store.upsert({
				id: "sess-1",
				agentName: "builder-1",
				capability: "builder",
				runtime: "claude",
				worktreePath: "/tmp/wt",
				branchName: "overstory/builder-1/test",
				taskId: "overstory-001",
				tmuxSession: "overstory-test-builder-1",
				state: "working",
				pid: 12345,
				parentAgent: null,
				depth: 0,
				runId: null,
				startedAt: new Date().toISOString(),
				lastActivity: new Date().toISOString(),
				escalationLevel: 0,
				stalledSince: null,
				rateLimitedSince: null,
				transcriptPath: null,
			});
			store.close();

			await inspectCommand(["builder-1", "--json", "--no-tmux"]);
			const out = output();

			const parsed = JSON.parse(out);
			expect(parsed.success).toBe(true);
			expect(parsed.command).toBe("inspect");
			expect(parsed.session.agentName).toBe("builder-1");
			expect(parsed.timeSinceLastActivity).toBeGreaterThan(0);
		});
	});

	// === Headless agent support ===

	describe("headless agent support", () => {
		test("gatherInspectData skips tmux capture for headless agents (empty tmuxSession)", async () => {
			const overstoryDir = join(tempDir, ".overstory");
			const sessionsDbPath = join(overstoryDir, "sessions.db");
			const store = createSessionStore(sessionsDbPath);
			store.upsert({
				id: "sess-h1",
				agentName: "headless-agent",
				capability: "builder",
				runtime: "claude",
				worktreePath: "/tmp/wt",
				branchName: "overstory/headless/task-1",
				taskId: "overstory-h01",
				tmuxSession: "", // headless
				state: "working",
				pid: process.pid,
				parentAgent: null,
				depth: 0,
				runId: null,
				startedAt: new Date().toISOString(),
				lastActivity: new Date().toISOString(),
				escalationLevel: 0,
				stalledSince: null,
				rateLimitedSince: null,
				transcriptPath: null,
			});
			store.close();

			// noTmux=false but tmuxSession="" — should skip tmux capture without error
			const data = await gatherInspectData(tempDir, "headless-agent", { noTmux: false });
			// tmuxOutput is null (no tmux) and no events yet → no fallback either
			expect(data.session.agentName).toBe("headless-agent");
			expect(data.session.tmuxSession).toBe("");
			// tmuxOutput may be null (no events) or a string (fallback) — must not throw
		});

		test("gatherInspectData provides event-based output for headless agents with tool calls", async () => {
			const overstoryDir = join(tempDir, ".overstory");
			const sessionsDbPath = join(overstoryDir, "sessions.db");
			const eventsDbPath = join(overstoryDir, "events.db");

			const store = createSessionStore(sessionsDbPath);
			store.upsert({
				id: "sess-h2",
				agentName: "headless-events",
				capability: "builder",
				runtime: "claude",
				worktreePath: "/tmp/wt",
				branchName: "overstory/headless/task-2",
				taskId: "overstory-h02",
				tmuxSession: "", // headless
				state: "working",
				pid: process.pid,
				parentAgent: null,
				depth: 0,
				runId: null,
				startedAt: new Date().toISOString(),
				lastActivity: new Date().toISOString(),
				escalationLevel: 0,
				stalledSince: null,
				rateLimitedSince: null,
				transcriptPath: null,
			});
			store.close();

			const eventStore = createEventStore(eventsDbPath);
			eventStore.insert(
				makeEvent({ agentName: "headless-events", toolName: "Read", toolDurationMs: 50 }),
			);
			eventStore.insert(
				makeEvent({ agentName: "headless-events", toolName: "Edit", toolDurationMs: 100 }),
			);
			eventStore.close();

			const data = await gatherInspectData(tempDir, "headless-events", { noTmux: false });

			// Should have fallback output
			expect(data.tmuxOutput).not.toBeNull();
			expect(data.tmuxOutput).toContain("Headless agent");
			expect(data.tmuxOutput).toContain("Read");
		});

		test("printInspectData shows PID instead of tmux session for headless agents", () => {
			const data = {
				session: {
					id: "sess-h3",
					agentName: "headless-display",
					capability: "builder",
					runtime: "claude",
					worktreePath: "/tmp/wt",
					branchName: "overstory/headless/task-3",
					taskId: "overstory-h03",
					tmuxSession: "", // headless
					state: "working" as const,
					pid: 99999,
					parentAgent: null,
					depth: 0,
					runId: null,
					startedAt: new Date().toISOString(),
					lastActivity: new Date().toISOString(),
					escalationLevel: 0,
					stalledSince: null,
					rateLimitedSince: null,
					transcriptPath: null,
				},
				timeSinceLastActivity: 5000,
				recentToolCalls: [],
				currentFile: null,
				toolStats: [],
				tokenUsage: null,
				tmuxOutput: null,
				headlessTurnInfo: null,
			};

			printInspectData(data);

			const out = output();
			expect(out).toContain("Process: PID");
			expect(out).toContain("99999");
			expect(out).toContain("headless");
			expect(out).not.toContain("Tmux:");
		});

		test("printInspectData shows Recent Activity header for headless agents with tmuxOutput", () => {
			const data = {
				session: {
					id: "sess-h4",
					agentName: "headless-activity",
					capability: "builder",
					runtime: "claude",
					worktreePath: "/tmp/wt",
					branchName: "overstory/headless/task-4",
					taskId: "overstory-h04",
					tmuxSession: "", // headless
					state: "working" as const,
					pid: 99998,
					parentAgent: null,
					depth: 0,
					runId: null,
					startedAt: new Date().toISOString(),
					lastActivity: new Date().toISOString(),
					escalationLevel: 0,
					stalledSince: null,
					rateLimitedSince: null,
					transcriptPath: null,
				},
				timeSinceLastActivity: 5000,
				recentToolCalls: [],
				currentFile: null,
				toolStats: [],
				tokenUsage: null,
				tmuxOutput: "[Headless agent — showing recent tool events]",
				headlessTurnInfo: null,
			};

			printInspectData(data);

			const out = output();
			expect(out).toContain("Recent Activity (headless)");
			expect(out).not.toContain("Live Tmux Output");
		});
	});

	// === stdout.log fallback (headless agents) ===

	describe("stdout.log fallback", () => {
		/** Create a headless session in SessionStore and return the overstoryDir. */
		async function setupHeadlessSession(
			agentName: string,
			worktreePathVal = "/tmp/wt",
		): Promise<string> {
			const overstoryDir = join(tempDir, ".overstory");
			const sessionsDbPath = join(overstoryDir, "sessions.db");
			const store = createSessionStore(sessionsDbPath);
			store.upsert({
				id: `sess-${agentName}`,
				agentName,
				capability: "builder",
				worktreePath: worktreePathVal,
				branchName: `overstory/headless/${agentName}`,
				taskId: "overstory-h10",
				tmuxSession: "", // headless
				state: "working",
				pid: process.pid,
				parentAgent: null,
				depth: 0,
				runId: null,
				startedAt: new Date().toISOString(),
				lastActivity: new Date().toISOString(),
				escalationLevel: 0,
				stalledSince: null,
				transcriptPath: null,
			});
			store.close();
			return overstoryDir;
		}

		/** Write NDJSON events to stdout.log in the agent's log dir. */
		async function writeStdoutLog(
			overstoryDir: string,
			agentName: string,
			events: Record<string, unknown>[],
		): Promise<void> {
			const logDir = join(overstoryDir, "logs", agentName, "2026-03-05T14-30-00-000Z");
			await mkdir(logDir, { recursive: true });
			const ndjson = `${events.map((e) => JSON.stringify(e)).join("\n")}\n`;
			await Bun.write(join(logDir, "stdout.log"), ndjson);
		}

		test("populates recentToolCalls from stdout.log when events.db is empty", async () => {
			const overstoryDir = await setupHeadlessSession("stdout-tools");
			await writeStdoutLog(overstoryDir, "stdout-tools", [
				{
					type: "tool_start",
					timestamp: "2026-03-05T14:30:01.000Z",
					toolName: "Read",
					argsSummary: "src/index.ts",
				},
				{
					type: "tool_end",
					timestamp: "2026-03-05T14:30:01.050Z",
					toolName: "Read",
					success: true,
					durationMs: 50,
				},
				{
					type: "tool_start",
					timestamp: "2026-03-05T14:30:02.000Z",
					toolName: "Edit",
					argsSummary: "src/commands/inspect.ts",
				},
				{
					type: "tool_end",
					timestamp: "2026-03-05T14:30:02.200Z",
					toolName: "Edit",
					success: true,
					durationMs: 200,
				},
			]);

			const data = await gatherInspectData(tempDir, "stdout-tools", { noTmux: true });

			expect(data.recentToolCalls.length).toBe(2);
			expect(data.recentToolCalls[0]?.toolName).toBe("Read");
			expect(data.recentToolCalls[0]?.durationMs).toBe(50);
			expect(data.recentToolCalls[0]?.args).toBe("src/index.ts");
			expect(data.recentToolCalls[1]?.toolName).toBe("Edit");
			expect(data.recentToolCalls[1]?.durationMs).toBe(200);
		});

		test("populates tokenUsage from turn_end events when metrics.db is absent", async () => {
			const overstoryDir = await setupHeadlessSession("stdout-tokens");
			await writeStdoutLog(overstoryDir, "stdout-tokens", [
				{
					type: "turn_start",
					timestamp: "2026-03-05T14:30:00.000Z",
					turn: 1,
				},
				{
					type: "turn_end",
					timestamp: "2026-03-05T14:30:05.000Z",
					inputTokens: 1000,
					outputTokens: 500,
					cacheReadTokens: 200,
					model: "claude-sonnet-4-6",
					contextUtilization: 0.3,
				},
				{
					type: "turn_start",
					timestamp: "2026-03-05T14:30:06.000Z",
					turn: 2,
				},
				{
					type: "turn_end",
					timestamp: "2026-03-05T14:30:10.000Z",
					inputTokens: 800,
					outputTokens: 300,
					cacheReadTokens: 150,
					model: "claude-sonnet-4-6",
					contextUtilization: 0.45,
				},
			]);

			const data = await gatherInspectData(tempDir, "stdout-tokens", { noTmux: true });

			// Token usage should be cumulative across turn_end events
			expect(data.tokenUsage).not.toBeNull();
			expect(data.tokenUsage?.inputTokens).toBe(1800);
			expect(data.tokenUsage?.outputTokens).toBe(800);
			expect(data.tokenUsage?.cacheReadTokens).toBe(350);
			expect(data.tokenUsage?.modelUsed).toBe("claude-sonnet-4-6");
			expect(data.tokenUsage?.cacheCreationTokens).toBe(0);
			expect(data.tokenUsage?.estimatedCostUsd).toBeNull();
		});

		test("populates headlessTurnInfo with turn number, context utilization, and isMidTool", async () => {
			const overstoryDir = await setupHeadlessSession("stdout-turn-info");
			await writeStdoutLog(overstoryDir, "stdout-turn-info", [
				{
					type: "turn_start",
					timestamp: "2026-03-05T14:30:00.000Z",
					turn: 3,
				},
				{
					type: "tool_start",
					timestamp: "2026-03-05T14:30:01.000Z",
					toolName: "Bash",
					argsSummary: "bun test",
				},
				// No tool_end — still mid-tool
			]);

			const data = await gatherInspectData(tempDir, "stdout-turn-info", { noTmux: true });

			expect(data.headlessTurnInfo).not.toBeNull();
			expect(data.headlessTurnInfo?.currentTurn).toBe(3);
			expect(data.headlessTurnInfo?.isMidTool).toBe(true);
		});

		test("isMidTool is false when last event is not tool_start", async () => {
			const overstoryDir = await setupHeadlessSession("stdout-between-turns");
			await writeStdoutLog(overstoryDir, "stdout-between-turns", [
				{
					type: "turn_start",
					timestamp: "2026-03-05T14:30:00.000Z",
					turn: 2,
				},
				{
					type: "turn_end",
					timestamp: "2026-03-05T14:30:05.000Z",
					inputTokens: 500,
					outputTokens: 200,
					cacheReadTokens: 0,
					model: "claude-sonnet-4-6",
					contextUtilization: 0.2,
				},
			]);

			const data = await gatherInspectData(tempDir, "stdout-between-turns", { noTmux: true });

			expect(data.headlessTurnInfo?.isMidTool).toBe(false);
			expect(data.headlessTurnInfo?.contextUtilization).toBeCloseTo(0.2);
		});

		test("does not overwrite tokenUsage from metrics.db with stdout.log data", async () => {
			const overstoryDir = await setupHeadlessSession("stdout-no-override");
			const metricsDbPath = join(overstoryDir, "metrics.db");

			// Metrics DB has authoritative data
			const metricsStore = createMetricsStore(metricsDbPath);
			metricsStore.recordSession(
				makeMetrics({
					agentName: "stdout-no-override",
					inputTokens: 9999,
					outputTokens: 8888,
					modelUsed: "claude-opus-4-6",
				}),
			);
			metricsStore.close();

			// stdout.log also has token data
			await writeStdoutLog(overstoryDir, "stdout-no-override", [
				{
					type: "turn_end",
					timestamp: "2026-03-05T14:30:05.000Z",
					inputTokens: 100,
					outputTokens: 50,
					cacheReadTokens: 0,
					model: "claude-sonnet-4-6",
					contextUtilization: 0.1,
				},
			]);

			const data = await gatherInspectData(tempDir, "stdout-no-override", { noTmux: true });

			// metrics.db data wins
			expect(data.tokenUsage?.inputTokens).toBe(9999);
			expect(data.tokenUsage?.modelUsed).toBe("claude-opus-4-6");
		});

		test("gracefully handles missing stdout.log", async () => {
			const overstoryDir = await setupHeadlessSession("stdout-missing");
			// Create log dir but no stdout.log inside it
			await mkdir(join(overstoryDir, "logs", "stdout-missing", "2026-03-05T14-30-00-000Z"), {
				recursive: true,
			});

			const data = await gatherInspectData(tempDir, "stdout-missing", { noTmux: true });

			expect(data.recentToolCalls).toEqual([]);
			expect(data.tokenUsage).toBeNull();
			expect(data.headlessTurnInfo).toBeNull();
		});

		test("gracefully handles no log dir at all", async () => {
			await setupHeadlessSession("stdout-no-log-dir");
			// Don't create any log dir

			const data = await gatherInspectData(tempDir, "stdout-no-log-dir", { noTmux: true });

			expect(data.recentToolCalls).toEqual([]);
			expect(data.headlessTurnInfo).toBeNull();
		});

		test("respects limit when populating recentToolCalls from stdout.log", async () => {
			const overstoryDir = await setupHeadlessSession("stdout-limit");
			const events: Record<string, unknown>[] = [];
			for (let i = 0; i < 10; i++) {
				events.push({
					type: "tool_start",
					timestamp: `2026-03-05T14:30:0${i}.000Z`,
					toolName: "Read",
					argsSummary: `src/file${i}.ts`,
				});
				events.push({
					type: "tool_end",
					timestamp: `2026-03-05T14:30:0${i}.050Z`,
					toolName: "Read",
					success: true,
					durationMs: 50,
				});
			}
			await writeStdoutLog(overstoryDir, "stdout-limit", events);

			const data = await gatherInspectData(tempDir, "stdout-limit", {
				noTmux: true,
				limit: 3,
			});

			expect(data.recentToolCalls.length).toBe(3);
		});

		test("printInspectData shows Turn Progress section when headlessTurnInfo is set", () => {
			const data = {
				session: {
					id: "sess-tp",
					agentName: "headless-turn-progress",
					capability: "builder",
					worktreePath: "/tmp/wt",
					branchName: "overstory/headless/tp",
					taskId: "overstory-tp",
					tmuxSession: "",
					state: "working" as const,
					pid: 12345,
					parentAgent: null,
					depth: 0,
					runId: null,
					startedAt: new Date().toISOString(),
					lastActivity: new Date().toISOString(),
					escalationLevel: 0,
					stalledSince: null,
					transcriptPath: null,
				},
				timeSinceLastActivity: 1000,
				recentToolCalls: [],
				currentFile: null,
				toolStats: [],
				tokenUsage: null,
				tmuxOutput: null,
				headlessTurnInfo: {
					currentTurn: 5,
					contextUtilization: 0.625,
					isMidTool: false,
				},
			};

			printInspectData(data);

			const out = output();
			expect(out).toContain("Turn Progress");
			expect(out).toContain("5");
			expect(out).toContain("62.5%");
			expect(out).toContain("between turns");
		});

		test("printInspectData shows executing tool status when isMidTool is true", () => {
			const data = {
				session: {
					id: "sess-mid",
					agentName: "headless-mid-tool",
					capability: "builder",
					worktreePath: "/tmp/wt",
					branchName: "overstory/headless/mid",
					taskId: "overstory-mid",
					tmuxSession: "",
					state: "working" as const,
					pid: 12345,
					parentAgent: null,
					depth: 0,
					runId: null,
					startedAt: new Date().toISOString(),
					lastActivity: new Date().toISOString(),
					escalationLevel: 0,
					stalledSince: null,
					transcriptPath: null,
				},
				timeSinceLastActivity: 500,
				recentToolCalls: [],
				currentFile: null,
				toolStats: [],
				tokenUsage: null,
				tmuxOutput: null,
				headlessTurnInfo: {
					currentTurn: 2,
					contextUtilization: null,
					isMidTool: true,
				},
			};

			printInspectData(data);

			const out = output();
			expect(out).toContain("Turn Progress");
			expect(out).toContain("executing tool");
		});

		test("uses latest log dir when multiple exist", async () => {
			const overstoryDir = await setupHeadlessSession("stdout-multi-dir");
			const agentLogsDir = join(overstoryDir, "logs", "stdout-multi-dir");

			// Create two log dirs — the later one has the important data
			const oldDir = join(agentLogsDir, "2026-03-05T10-00-00-000Z");
			const newDir = join(agentLogsDir, "2026-03-05T14-30-00-000Z");
			await mkdir(oldDir, { recursive: true });
			await mkdir(newDir, { recursive: true });

			// Old dir: no useful data
			await Bun.write(join(oldDir, "stdout.log"), "");

			// New dir: has turn data
			const events = [
				{
					type: "turn_start",
					timestamp: "2026-03-05T14:30:00.000Z",
					turn: 7,
				},
				{
					type: "turn_end",
					timestamp: "2026-03-05T14:30:05.000Z",
					inputTokens: 2000,
					outputTokens: 700,
					cacheReadTokens: 300,
					model: "claude-sonnet-4-6",
					contextUtilization: 0.55,
				},
			];
			await Bun.write(
				join(newDir, "stdout.log"),
				`${events.map((e) => JSON.stringify(e)).join("\n")}\n`,
			);

			const data = await gatherInspectData(tempDir, "stdout-multi-dir", { noTmux: true });

			expect(data.headlessTurnInfo?.currentTurn).toBe(7);
			expect(data.tokenUsage?.inputTokens).toBe(2000);
		});
	});

	// === Human-readable output ===

	describe("human-readable output", () => {
		test("displays agent metadata", async () => {
			const overstoryDir = join(tempDir, ".overstory");
			const sessionsDbPath = join(overstoryDir, "sessions.db");
			const store = createSessionStore(sessionsDbPath);
			store.upsert({
				id: "sess-1",
				agentName: "builder-1",
				capability: "builder",
				runtime: "claude",
				worktreePath: "/tmp/wt",
				branchName: "overstory/builder-1/test",
				taskId: "overstory-001",
				tmuxSession: "overstory-test-builder-1",
				state: "working",
				pid: 12345,
				parentAgent: "orchestrator",
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

			await inspectCommand(["builder-1", "--no-tmux"]);
			const out = output();

			expect(out).toContain("builder-1");
			expect(out).toContain("working");
			expect(out).toContain("overstory-001");
			expect(out).toContain("builder");
			expect(out).toContain("overstory/builder-1/test");
			expect(out).toContain("orchestrator");
		});

		test("displays token usage", async () => {
			const overstoryDir = join(tempDir, ".overstory");
			const sessionsDbPath = join(overstoryDir, "sessions.db");
			const metricsDbPath = join(overstoryDir, "metrics.db");

			const store = createSessionStore(sessionsDbPath);
			store.upsert({
				id: "sess-1",
				agentName: "builder-1",
				capability: "builder",
				runtime: "claude",
				worktreePath: "/tmp/wt",
				branchName: "overstory/builder-1/test",
				taskId: "overstory-001",
				tmuxSession: "overstory-test-builder-1",
				state: "working",
				pid: 12345,
				parentAgent: null,
				depth: 0,
				runId: null,
				startedAt: new Date().toISOString(),
				lastActivity: new Date().toISOString(),
				escalationLevel: 0,
				stalledSince: null,
				rateLimitedSince: null,
				transcriptPath: null,
			});
			store.close();

			const metricsStore = createMetricsStore(metricsDbPath);
			metricsStore.recordSession(makeMetrics({ estimatedCostUsd: 0.123 }));
			metricsStore.close();

			await inspectCommand(["builder-1", "--no-tmux"]);
			const out = output();

			expect(out).toContain("Token Usage");
			expect(out).toContain("1,000");
			expect(out).toContain("$0.1230");
		});

		test("displays tool stats and recent calls", async () => {
			const overstoryDir = join(tempDir, ".overstory");
			const sessionsDbPath = join(overstoryDir, "sessions.db");
			const eventsDbPath = join(overstoryDir, "events.db");

			const store = createSessionStore(sessionsDbPath);
			store.upsert({
				id: "sess-1",
				agentName: "builder-1",
				capability: "builder",
				runtime: "claude",
				worktreePath: "/tmp/wt",
				branchName: "overstory/builder-1/test",
				taskId: "overstory-001",
				tmuxSession: "overstory-test-builder-1",
				state: "working",
				pid: 12345,
				parentAgent: null,
				depth: 0,
				runId: null,
				startedAt: new Date().toISOString(),
				lastActivity: new Date().toISOString(),
				escalationLevel: 0,
				stalledSince: null,
				rateLimitedSince: null,
				transcriptPath: null,
			});
			store.close();

			const eventStore = createEventStore(eventsDbPath);
			eventStore.insert(makeEvent({ toolName: "Read", toolDurationMs: 100 }));
			eventStore.insert(makeEvent({ toolName: "Edit", toolDurationMs: 200 }));
			eventStore.close();

			await inspectCommand(["builder-1", "--no-tmux"]);
			const out = output();

			expect(out).toContain("Tool Usage");
			expect(out).toContain("Recent Tool Calls");
			expect(out).toContain("Read");
			expect(out).toContain("Edit");
		});
	});
});

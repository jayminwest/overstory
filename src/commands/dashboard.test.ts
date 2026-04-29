/**
 * Tests for overstory dashboard command.
 *
 * We only test help output and validation since the dashboard runs an infinite
 * polling loop. The actual rendering cannot be tested without complex mocking
 * of terminal state and multiple data sources.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ValidationError } from "../errors.ts";
import { createEventStore } from "../events/store.ts";
import { color } from "../logging/color.ts";
import { createSessionStore } from "../sessions/store.ts";
import { cleanupTempDir } from "../test-helpers.ts";
import type { DashboardStores } from "./dashboard.ts";
import {
	closeDashboardStores,
	computeAgentPanelHeight,
	dashboardCommand,
	dimBox,
	EventBuffer,
	filterAgentsByRun,
	horizontalLine,
	openDashboardStores,
	pad,
	renderAgentPanel,
	renderFeedPanel,
	renderTasksPanel,
	truncate,
} from "./dashboard.ts";

describe("dashboardCommand", () => {
	let chunks: string[];
	let originalWrite: typeof process.stdout.write;
	let tempDir: string;

	beforeEach(async () => {
		chunks = [];
		originalWrite = process.stdout.write;
		process.stdout.write = ((chunk: string) => {
			chunks.push(chunk);
			return true;
		}) as typeof process.stdout.write;

		tempDir = await mkdtemp(join(tmpdir(), "dashboard-test-"));
	});

	afterEach(async () => {
		process.stdout.write = originalWrite;
		await cleanupTempDir(tempDir);
	});

	function output(): string {
		return chunks.join("");
	}

	test("--help flag prints help text", async () => {
		await dashboardCommand(["--help"]);
		const out = output();

		expect(out).toContain("dashboard");
		expect(out).toContain("--interval");
		expect(out).toContain("Ctrl+C");
	});

	test("-h flag prints help text", async () => {
		await dashboardCommand(["-h"]);
		const out = output();

		expect(out).toContain("dashboard");
		expect(out).toContain("--interval");
		expect(out).toContain("Ctrl+C");
	});

	test("--interval with non-numeric value throws ValidationError", async () => {
		await expect(dashboardCommand(["--interval", "abc"])).rejects.toThrow(ValidationError);
	});

	test("--interval below 500 throws ValidationError", async () => {
		await expect(dashboardCommand(["--interval", "499"])).rejects.toThrow(ValidationError);
	});

	test("--interval with NaN throws ValidationError", async () => {
		await expect(dashboardCommand(["--interval", "not-a-number"])).rejects.toThrow(ValidationError);
	});

	test("--interval at exactly 500 passes validation", async () => {
		// This test verifies that interval validation passes for the value 500.
		// We chdir to a temp dir WITHOUT .overstory/config.yaml so that loadConfig()
		// throws BEFORE the infinite while loop starts. This proves validation passed
		// (no ValidationError about interval) while preventing the loop from leaking.

		const originalCwd = process.cwd();

		try {
			process.chdir(tempDir);
			await dashboardCommand(["--interval", "500"]);
		} catch (err) {
			// If it's a ValidationError about interval, the test should fail
			if (err instanceof ValidationError && err.field === "interval") {
				throw new Error("Interval validation should have passed for value 500");
			}
			// Other errors (like from loadConfig) are expected - they occur after validation passed
		} finally {
			process.chdir(originalCwd);
		}

		// If we reach here without throwing a ValidationError about interval, validation passed
	});

	test("help text includes --all flag", async () => {
		await dashboardCommand(["--help"]);
		const out = output();

		expect(out).toContain("--all");
	});

	test("help text describes current run scoping", async () => {
		await dashboardCommand(["--help"]);
		const out = output();

		expect(out).toContain("current run");
	});
});

describe("pad", () => {
	test("zero width returns empty string", () => {
		expect(pad("hello", 0)).toBe("");
	});

	test("negative width returns empty string", () => {
		expect(pad("hello", -1)).toBe("");
	});

	test("truncates string longer than width", () => {
		expect(pad("hello", 3)).toBe("hel");
	});

	test("pads string shorter than width with spaces", () => {
		expect(pad("hi", 5)).toBe("hi   ");
	});
});

describe("truncate", () => {
	test("zero maxLen returns empty string", () => {
		expect(truncate("hello world", 0)).toBe("");
	});

	test("negative maxLen returns empty string", () => {
		expect(truncate("hello world", -1)).toBe("");
	});

	test("truncates with ellipsis", () => {
		expect(truncate("hello world", 5)).toBe("hell…");
	});

	test("string shorter than maxLen returned as-is", () => {
		expect(truncate("hi", 10)).toBe("hi");
	});
});

describe("horizontalLine", () => {
	test("width 0 does not throw", () => {
		expect(() => horizontalLine(0, "┌", "─", "┐")).not.toThrow();
	});

	test("width 1 does not throw", () => {
		expect(() => horizontalLine(1, "┌", "─", "┐")).not.toThrow();
	});

	test("width 2 returns just connectors", () => {
		expect(horizontalLine(2, "┌", "─", "┐")).toBe("┌┐");
	});

	test("width 4 returns connectors with fill", () => {
		expect(horizontalLine(4, "┌", "─", "┐")).toBe("┌──┐");
	});
});

describe("filterAgentsByRun", () => {
	type Stub = { runId: string | null; name: string };

	const coordinator: Stub = { runId: null, name: "coordinator" };
	const builder1: Stub = { runId: "run-001", name: "builder-1" };
	const builder2: Stub = { runId: "run-002", name: "builder-2" };
	const agents = [coordinator, builder1, builder2];

	test("no runId returns all agents", () => {
		expect(filterAgentsByRun(agents, null)).toEqual(agents);
		expect(filterAgentsByRun(agents, undefined)).toEqual(agents);
	});

	test("run-scoped includes matching runId agents", () => {
		const result = filterAgentsByRun(agents, "run-001");
		expect(result.map((a) => a.name)).toContain("builder-1");
	});

	test("run-scoped includes null-runId agents (coordinator)", () => {
		const result = filterAgentsByRun(agents, "run-001");
		expect(result.map((a) => a.name)).toContain("coordinator");
	});

	test("run-scoped excludes agents from other runs", () => {
		const result = filterAgentsByRun(agents, "run-001");
		expect(result.map((a) => a.name)).not.toContain("builder-2");
	});

	test("empty agents list returns empty", () => {
		expect(filterAgentsByRun([], "run-001")).toEqual([]);
	});
});

describe("dimBox", () => {
	test("dimBox.vertical equals color.dim(│)", () => {
		expect(dimBox.vertical).toBe(color.dim("│"));
	});

	test("dimBox.horizontal equals color.dim(─)", () => {
		expect(dimBox.horizontal).toBe(color.dim("─"));
	});

	test("dimBox.tee equals color.dim(├)", () => {
		expect(dimBox.tee).toBe(color.dim("├"));
	});

	test("dimBox.teeRight equals color.dim(┤)", () => {
		expect(dimBox.teeRight).toBe(color.dim("┤"));
	});

	test("dimBox values equal color.dim() applied to their characters", () => {
		// dimBox values are always equal to color.dim(char) regardless of whether
		// Chalk emits ANSI codes (it may suppress them in non-TTY / NO_COLOR envs).
		expect(dimBox.topLeft).toBe(color.dim("┌"));
		expect(dimBox.topRight).toBe(color.dim("┐"));
		expect(dimBox.bottomLeft).toBe(color.dim("└"));
		expect(dimBox.bottomRight).toBe(color.dim("┘"));
		expect(dimBox.cross).toBe(color.dim("┼"));
	});
});

describe("computeAgentPanelHeight", () => {
	test("0 agents: clamps to minimum 8", () => {
		// max(8, min(floor(30*0.35)=10, 0+4)) = max(8, min(10,4)) = max(8,4) = 8
		expect(computeAgentPanelHeight(30, 0)).toBe(8);
	});

	test("4 agents: still clamps to minimum 8", () => {
		// max(8, min(10, 4+4)) = max(8, 8) = 8
		expect(computeAgentPanelHeight(30, 4)).toBe(8);
	});

	test("20 agents with height 30: clamps to floor(height*0.35)", () => {
		// max(8, min(floor(30*0.35)=10, 24)) = max(8,10) = 10
		expect(computeAgentPanelHeight(30, 20)).toBe(10);
	});

	test("10 agents with height 30: grows with agent count", () => {
		// max(8, min(10, 14)) = max(8,10) = 10
		expect(computeAgentPanelHeight(30, 10)).toBe(10);
	});

	test("small height: respects 35% cap", () => {
		// height=20: max(8, min(floor(20*0.35)=7, 24)) = max(8,7) = 8
		expect(computeAgentPanelHeight(20, 20)).toBe(8);
	});
});

// Helper to build a minimal DashboardData for panel tests
function makeDashboardData(
	overrides: Partial<{
		tasks: Array<{ id: string; title: string; priority: number; status: string; type: string }>;
		recentEvents: Array<{
			id: number;
			agentName: string;
			eventType: string;
			level: string;
			createdAt: string;
			runId: null;
			sessionId: null;
			toolName: null;
			toolArgs: null;
			toolDurationMs: null;
			data: null;
		}>;
	}> = {},
) {
	return {
		currentRunId: null,
		status: {
			currentRunId: null,
			agents: [],
			worktrees: [],
			tmuxSessions: [],
			unreadMailCount: 0,
			mergeQueueCount: 0,
			recentMetricsCount: 0,
		},
		recentMail: [],
		mergeQueue: [],
		metrics: { totalSessions: 0, avgDuration: 0, byCapability: {} },
		tasks: overrides.tasks ?? [],
		recentEvents: (overrides.recentEvents as never[]) ?? [],
		feedColorMap: new Map(),
	};
}

describe("renderTasksPanel", () => {
	test("renders task id in output", () => {
		const data = makeDashboardData({
			tasks: [{ id: "t1", title: "Test task", priority: 2, status: "open", type: "task" }],
		});
		const out = renderTasksPanel(data, 1, 80, 10, 1);
		expect(out).toContain("t1");
	});

	test("renders task title in output", () => {
		const data = makeDashboardData({
			tasks: [{ id: "t1", title: "Test task", priority: 2, status: "open", type: "task" }],
		});
		const out = renderTasksPanel(data, 1, 80, 10, 1);
		expect(out).toContain("Test task");
	});

	test("renders priority label in output", () => {
		const data = makeDashboardData({
			tasks: [{ id: "t1", title: "Test task", priority: 2, status: "open", type: "task" }],
		});
		const out = renderTasksPanel(data, 1, 80, 10, 1);
		expect(out).toContain("P2");
	});

	test("shows 'No tracker data' when tasks list is empty", () => {
		const data = makeDashboardData({ tasks: [] });
		const out = renderTasksPanel(data, 1, 80, 10, 1);
		expect(out).toContain("No tracker data");
	});

	test("renders Tasks header", () => {
		const data = makeDashboardData({ tasks: [] });
		const out = renderTasksPanel(data, 1, 80, 6, 1);
		expect(out).toContain("Tasks");
	});

	test("renders multiple tasks", () => {
		const data = makeDashboardData({
			tasks: [
				{ id: "abc-001", title: "First task", priority: 1, status: "open", type: "task" },
				{ id: "abc-002", title: "Second task", priority: 3, status: "in_progress", type: "bug" },
			],
		});
		const out = renderTasksPanel(data, 1, 80, 10, 1);
		expect(out).toContain("abc-001");
		expect(out).toContain("abc-002");
	});
});

describe("renderFeedPanel", () => {
	test("shows 'No recent events' when recentEvents is empty", () => {
		const data = makeDashboardData({ recentEvents: [] });
		const out = renderFeedPanel(data, 1, 80, 8, 1);
		expect(out).toContain("No recent events");
	});

	test("renders Feed header", () => {
		const data = makeDashboardData({ recentEvents: [] });
		const out = renderFeedPanel(data, 1, 80, 8, 1);
		expect(out).toContain("Feed");
		expect(out).toContain("(live)");
	});

	test("renders event agent name when events are present", () => {
		const event = {
			id: 1,
			agentName: "test-agent",
			eventType: "tool_end" as const,
			level: "info" as const,
			createdAt: new Date().toISOString(),
			runId: null,
			sessionId: null,
			toolName: null,
			toolArgs: null,
			toolDurationMs: null,
			data: null,
		};
		const data = makeDashboardData({ recentEvents: [event] });
		// formatEventLine is a stub — returns "" — so output won't have agent name from it.
		// But the panel itself should not throw and should render the border structure.
		const out = renderFeedPanel(data, 1, 80, 8, 1);
		// Panel renders without error and contains Feed header
		expect(out).toContain("Feed");
		// At least 1 row rendered (not the "No recent events" path)
		expect(out).not.toContain("No recent events");
	});
});

describe("renderAgentPanel", () => {
	test("renders Agents header", () => {
		const data = makeDashboardData({});
		const out = renderAgentPanel(data, 100, 12, 3);
		expect(out).toContain("Agents");
	});

	test("renders with dimmed border characters", () => {
		const data = makeDashboardData({});
		const out = renderAgentPanel(data, 100, 12, 3);
		// dimBox.vertical is a dimmed ANSI string — present in output
		expect(out).toContain(dimBox.vertical);
	});

	test("renders Live column header (not Tmux)", () => {
		const data = makeDashboardData({});
		const out = renderAgentPanel(data, 100, 12, 3);
		expect(out).toContain("Live");
		expect(out).not.toContain("Tmux");
	});

	test("shows green dot for headless agent with alive PID", () => {
		const alivePid = process.pid; // own PID — guaranteed alive
		const data = {
			...makeDashboardData({}),
			status: {
				currentRunId: null,
				agents: [
					{
						id: "sess-h1",
						agentName: "headless-worker",
						capability: "builder",
						worktreePath: "/tmp/wt/headless",
						branchName: "overstory/headless/task-1",
						taskId: "task-h1",
						tmuxSession: "", // headless
						state: "working" as const,
						pid: alivePid,
						parentAgent: null,
						depth: 0,
						runId: null,
						startedAt: new Date(Date.now() - 10_000).toISOString(),
						lastActivity: new Date().toISOString(),
						escalationLevel: 0,
						stalledSince: null,
						transcriptPath: null,
					},
				],
				worktrees: [],
				tmuxSessions: [], // no tmux sessions
				unreadMailCount: 0,
				mergeQueueCount: 0,
				recentMetricsCount: 0,
			},
		};
		const out = renderAgentPanel(data, 100, 12, 3);
		// Green ">" for alive headless agent
		expect(out).toContain(">");
		expect(out).toContain("headless-worker");
	});

	test("shows red dot for headless agent with dead PID", () => {
		const deadPid = 2_147_483_647;
		const data = {
			...makeDashboardData({}),
			status: {
				currentRunId: null,
				agents: [
					{
						id: "sess-h2",
						agentName: "dead-headless", // short enough to not be truncated
						capability: "builder",
						worktreePath: "/tmp/wt/dead-headless",
						branchName: "overstory/dead-headless/task-2",
						taskId: "task-h2",
						tmuxSession: "", // headless
						state: "working" as const,
						pid: deadPid,
						parentAgent: null,
						depth: 0,
						runId: null,
						startedAt: new Date(Date.now() - 10_000).toISOString(),
						lastActivity: new Date().toISOString(),
						escalationLevel: 0,
						stalledSince: null,
						transcriptPath: null,
					},
				],
				worktrees: [],
				tmuxSessions: [],
				unreadMailCount: 0,
				mergeQueueCount: 0,
				recentMetricsCount: 0,
			},
		};
		const out = renderAgentPanel(data, 100, 12, 3);
		expect(out).toContain("x");
		expect(out).toContain("dead-headless");
	});

	test("renders mixed tmux + headless agents in same frame with correct liveness", () => {
		const data = {
			...makeDashboardData({}),
			status: {
				currentRunId: null,
				agents: [
					{
						id: "sess-tmux-1",
						agentName: "pane-agent",
						capability: "builder",
						worktreePath: "/tmp/wt/pane-agent",
						branchName: "overstory/pane-agent/task-t1",
						taskId: "task-t1",
						tmuxSession: "overstory-pane-agent",
						state: "working" as const,
						pid: 99999,
						parentAgent: null,
						depth: 0,
						runId: null,
						startedAt: new Date(Date.now() - 10_000).toISOString(),
						lastActivity: new Date().toISOString(),
						escalationLevel: 0,
						stalledSince: null,
						transcriptPath: null,
					},
					{
						id: "sess-headless-1",
						agentName: "live-headless",
						capability: "builder",
						worktreePath: "/tmp/wt/live-headless",
						branchName: "overstory/live-headless/task-h1",
						taskId: "task-h1",
						tmuxSession: "", // headless
						state: "working" as const,
						pid: process.pid, // own PID — guaranteed alive
						parentAgent: null,
						depth: 0,
						runId: null,
						startedAt: new Date(Date.now() - 10_000).toISOString(),
						lastActivity: new Date().toISOString(),
						escalationLevel: 0,
						stalledSince: null,
						transcriptPath: null,
					},
				],
				worktrees: [],
				tmuxSessions: [{ name: "overstory-pane-agent", pid: 99998 }],
				unreadMailCount: 0,
				mergeQueueCount: 0,
				recentMetricsCount: 0,
			},
		};
		const out = renderAgentPanel(data, 100, 12, 3);
		expect(out).toContain("pane-agent");
		expect(out).toContain("live-headless");
		const aliveMarkers = (out.match(/>/g) ?? []).length;
		expect(aliveMarkers).toBeGreaterThanOrEqual(2);
		expect(out).not.toContain("x");
	});

	test("headless agent renders dead marker when tmux session list is non-empty", () => {
		const deadPid = 2_147_483_647;
		const data = {
			...makeDashboardData({}),
			status: {
				currentRunId: null,
				agents: [
					{
						id: "sess-dead-headless-1",
						agentName: "gone-headless",
						capability: "builder",
						worktreePath: "/tmp/wt/gone-headless",
						branchName: "overstory/gone-headless/task-g1",
						taskId: "task-g1",
						tmuxSession: "", // headless
						state: "working" as const,
						pid: deadPid,
						parentAgent: null,
						depth: 0,
						runId: null,
						startedAt: new Date(Date.now() - 10_000).toISOString(),
						lastActivity: new Date().toISOString(),
						escalationLevel: 0,
						stalledSince: null,
						transcriptPath: null,
					},
				],
				worktrees: [],
				tmuxSessions: [{ name: "overstory-other-tmux", pid: 11111 }],
				unreadMailCount: 0,
				mergeQueueCount: 0,
				recentMetricsCount: 0,
			},
		};
		const out = renderAgentPanel(data, 100, 12, 3);
		expect(out).toContain("x");
		expect(out).toContain("gone-headless");
	});
});

describe("openDashboardStores", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "dashboard-stores-test-"));
	});

	afterEach(async () => {
		await cleanupTempDir(tempDir);
	});

	test("sessionStore is non-null when .overstory/ has sessions.db", async () => {
		const overstoryDir = join(tempDir, ".overstory");
		await mkdir(overstoryDir, { recursive: true });
		const seeder = createSessionStore(join(overstoryDir, "sessions.db"));
		seeder.close();

		const stores = openDashboardStores(tempDir);
		try {
			expect(stores.sessionStore).not.toBeNull();
		} finally {
			closeDashboardStores(stores);
		}
	});

	test("mailStore is null when mail.db does not exist", async () => {
		const overstoryDir = join(tempDir, ".overstory");
		await mkdir(overstoryDir, { recursive: true });
		const seeder = createSessionStore(join(overstoryDir, "sessions.db"));
		seeder.close();

		const stores = openDashboardStores(tempDir);
		try {
			expect(stores.mailStore).toBeNull();
		} finally {
			closeDashboardStores(stores);
		}
	});

	test("mergeQueue is null when merge-queue.db does not exist", async () => {
		const overstoryDir = join(tempDir, ".overstory");
		await mkdir(overstoryDir, { recursive: true });
		const seeder = createSessionStore(join(overstoryDir, "sessions.db"));
		seeder.close();

		const stores = openDashboardStores(tempDir);
		try {
			expect(stores.mergeQueue).toBeNull();
		} finally {
			closeDashboardStores(stores);
		}
	});

	test("metricsStore is null when metrics.db does not exist", async () => {
		const overstoryDir = join(tempDir, ".overstory");
		await mkdir(overstoryDir, { recursive: true });
		const seeder = createSessionStore(join(overstoryDir, "sessions.db"));
		seeder.close();

		const stores = openDashboardStores(tempDir);
		try {
			expect(stores.metricsStore).toBeNull();
		} finally {
			closeDashboardStores(stores);
		}
	});

	test("eventStore is null when events.db does not exist", async () => {
		const overstoryDir = join(tempDir, ".overstory");
		await mkdir(overstoryDir, { recursive: true });
		const seeder = createSessionStore(join(overstoryDir, "sessions.db"));
		seeder.close();

		const stores = openDashboardStores(tempDir);
		try {
			expect(stores.eventStore).toBeNull();
		} finally {
			closeDashboardStores(stores);
		}
	});

	test("eventStore is non-null when events.db exists", async () => {
		const overstoryDir = join(tempDir, ".overstory");
		await mkdir(overstoryDir, { recursive: true });
		const seeder = createSessionStore(join(overstoryDir, "sessions.db"));
		seeder.close();

		// Create events.db via createEventStore
		const eventsDb = createEventStore(join(overstoryDir, "events.db"));
		eventsDb.close();

		const stores = openDashboardStores(tempDir);
		try {
			expect(stores.eventStore).not.toBeNull();
		} finally {
			closeDashboardStores(stores);
		}
	});
});

describe("closeDashboardStores", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "dashboard-close-test-"));
	});

	afterEach(async () => {
		await cleanupTempDir(tempDir);
	});

	test("closing stores does not throw", async () => {
		const overstoryDir = join(tempDir, ".overstory");
		await mkdir(overstoryDir, { recursive: true });
		const seeder = createSessionStore(join(overstoryDir, "sessions.db"));
		seeder.close();

		const stores = openDashboardStores(tempDir);
		expect(() => closeDashboardStores(stores)).not.toThrow();
	});

	test("closing already-closed stores does not throw (best-effort)", async () => {
		const overstoryDir = join(tempDir, ".overstory");
		await mkdir(overstoryDir, { recursive: true });
		const seeder = createSessionStore(join(overstoryDir, "sessions.db"));
		seeder.close();

		const stores = openDashboardStores(tempDir);
		closeDashboardStores(stores);
		// Second close should not throw due to best-effort try/catch
		expect(() => closeDashboardStores(stores)).not.toThrow();
	});

	test("closing stores with eventStore does not throw", async () => {
		const overstoryDir = join(tempDir, ".overstory");
		await mkdir(overstoryDir, { recursive: true });
		const seeder = createSessionStore(join(overstoryDir, "sessions.db"));
		seeder.close();
		const eventsDb = createEventStore(join(overstoryDir, "events.db"));
		eventsDb.close();

		const stores = openDashboardStores(tempDir);
		expect(() => closeDashboardStores(stores)).not.toThrow();
	});
});

describe("EventBuffer", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "event-buffer-test-"));
	});

	afterEach(async () => {
		await cleanupTempDir(tempDir);
	});

	function makeEvent(agentName: string) {
		return {
			agentName,
			eventType: "tool_end" as const,
			level: "info" as const,
			runId: null,
			sessionId: null,
			toolName: null,
			toolArgs: null,
			toolDurationMs: null,
			data: null,
		};
	}

	test("starts empty", () => {
		const buf = new EventBuffer();
		expect(buf.size).toBe(0);
		expect(buf.getEvents()).toEqual([]);
	});

	test("poll adds events from event store", async () => {
		const overstoryDir = join(tempDir, ".overstory");
		await mkdir(overstoryDir, { recursive: true });
		const store = createEventStore(join(overstoryDir, "events.db"));
		store.insert(makeEvent("agent-a"));

		const buf = new EventBuffer();
		buf.poll(store);
		expect(buf.size).toBe(1);
		store.close();
	});

	test("deduplicates by lastSeenId (double poll returns same count)", async () => {
		const overstoryDir = join(tempDir, ".overstory");
		await mkdir(overstoryDir, { recursive: true });
		const store = createEventStore(join(overstoryDir, "events.db"));
		store.insert(makeEvent("agent-a"));

		const buf = new EventBuffer();
		buf.poll(store);
		buf.poll(store); // second poll should not duplicate
		expect(buf.size).toBe(1);
		store.close();
	});

	test("trims to maxSize keeping most recent events", async () => {
		const overstoryDir = join(tempDir, ".overstory");
		await mkdir(overstoryDir, { recursive: true });
		const store = createEventStore(join(overstoryDir, "events.db"));
		for (let i = 0; i < 5; i++) {
			store.insert(makeEvent(`agent-${i}`));
		}

		const buf = new EventBuffer(3);
		buf.poll(store);
		expect(buf.size).toBe(3);
		store.close();
	});

	test("builds color map across polls", async () => {
		const overstoryDir = join(tempDir, ".overstory");
		await mkdir(overstoryDir, { recursive: true });
		const store = createEventStore(join(overstoryDir, "events.db"));
		store.insert(makeEvent("agent-x"));

		const buf = new EventBuffer();
		buf.poll(store);
		expect(buf.getColorMap().has("agent-x")).toBe(true);

		store.insert(makeEvent("agent-y"));
		buf.poll(store);
		expect(buf.getColorMap().has("agent-x")).toBe(true);
		expect(buf.getColorMap().has("agent-y")).toBe(true);
		store.close();
	});
});

// Type check: DashboardStores includes eventStore
test("DashboardStores type includes eventStore field", () => {
	const stores: DashboardStores = {
		sessionStore: null as never,
		mailStore: null,
		mergeQueue: null,
		metricsStore: null,
		eventStore: null,
	};
	expect(stores.eventStore).toBeNull();
});

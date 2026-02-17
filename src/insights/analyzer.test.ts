import { describe, expect, test } from "bun:test";
import type { StoredEvent, ToolStats } from "../types.ts";
import { analyzeSessionInsights, inferDomain } from "./analyzer.ts";

describe("inferDomain", () => {
	test("maps src/mail/ to messaging", () => {
		expect(inferDomain("src/mail/store.ts")).toBe("messaging");
	});

	test("maps src/commands/ to cli", () => {
		expect(inferDomain("src/commands/log.ts")).toBe("cli");
	});

	test("maps src/agents/ to agents", () => {
		expect(inferDomain("src/agents/manifest.ts")).toBe("agents");
	});

	test("maps agents/ to agents", () => {
		expect(inferDomain("agents/builder.md")).toBe("agents");
	});

	test("maps src/events/ to cli", () => {
		expect(inferDomain("src/events/store.ts")).toBe("cli");
	});

	test("maps src/logging/ to cli", () => {
		expect(inferDomain("src/logging/logger.ts")).toBe("cli");
	});

	test("maps src/metrics/ to cli", () => {
		expect(inferDomain("src/metrics/store.ts")).toBe("cli");
	});

	test("maps src/merge/ to architecture", () => {
		expect(inferDomain("src/merge/resolver.ts")).toBe("architecture");
	});

	test("maps src/worktree/ to architecture", () => {
		expect(inferDomain("src/worktree/manager.ts")).toBe("architecture");
	});

	test("maps *.test.ts to typescript", () => {
		expect(inferDomain("src/config.test.ts")).toBe("typescript");
	});

	test("maps other src/ files to typescript", () => {
		expect(inferDomain("src/config.ts")).toBe("typescript");
	});

	test("returns null for unrecognized paths", () => {
		expect(inferDomain("README.md")).toBe(null);
	});
});

describe("analyzeSessionInsights", () => {
	test("returns empty insights for empty events", () => {
		const result = analyzeSessionInsights({
			events: [],
			toolStats: [],
			agentName: "test-agent",
			capability: "builder",
			domains: ["typescript"],
		});

		expect(result.insights).toEqual([]);
		expect(result.toolProfile.topTools).toEqual([]);
		expect(result.toolProfile.totalToolCalls).toBe(0);
		expect(result.toolProfile.errorCount).toBe(0);
		expect(result.fileProfile.hotFiles).toEqual([]);
		expect(result.fileProfile.totalEdits).toBe(0);
	});

	test("builds correct tool profile from tool stats", () => {
		const toolStats: ToolStats[] = [
			{ toolName: "Read", count: 15, avgDurationMs: 50, maxDurationMs: 100 },
			{ toolName: "Edit", count: 8, avgDurationMs: 120, maxDurationMs: 200 },
			{ toolName: "Bash", count: 3, avgDurationMs: 500, maxDurationMs: 1000 },
		];

		const result = analyzeSessionInsights({
			events: [],
			toolStats,
			agentName: "test-agent",
			capability: "builder",
			domains: ["typescript"],
		});

		expect(result.toolProfile.totalToolCalls).toBe(26);
		expect(result.toolProfile.topTools).toHaveLength(3);
		expect(result.toolProfile.topTools[0]).toEqual({
			name: "Read",
			count: 15,
			avgMs: 50,
		});
		expect(result.toolProfile.topTools[1]).toEqual({
			name: "Edit",
			count: 8,
			avgMs: 120,
		});
	});

	test("detects hot files from edit events", () => {
		const events: StoredEvent[] = [
			{
				id: 1,
				runId: "run-1",
				agentName: "test-agent",
				sessionId: "session-1",
				eventType: "tool_start",
				toolName: "Edit",
				toolArgs: JSON.stringify({ file_path: "src/config.ts" }),
				toolDurationMs: null,
				level: "info",
				data: null,
				createdAt: "2024-01-01T10:00:00.000Z",
			},
			{
				id: 2,
				runId: "run-1",
				agentName: "test-agent",
				sessionId: "session-1",
				eventType: "tool_start",
				toolName: "Edit",
				toolArgs: JSON.stringify({ file_path: "src/config.ts" }),
				toolDurationMs: null,
				level: "info",
				data: null,
				createdAt: "2024-01-01T10:01:00.000Z",
			},
			{
				id: 3,
				runId: "run-1",
				agentName: "test-agent",
				sessionId: "session-1",
				eventType: "tool_start",
				toolName: "Edit",
				toolArgs: JSON.stringify({ file_path: "src/config.ts" }),
				toolDurationMs: null,
				level: "info",
				data: null,
				createdAt: "2024-01-01T10:02:00.000Z",
			},
			{
				id: 4,
				runId: "run-1",
				agentName: "test-agent",
				sessionId: "session-1",
				eventType: "tool_start",
				toolName: "Write",
				toolArgs: JSON.stringify({ file_path: "src/new-file.ts" }),
				toolDurationMs: null,
				level: "info",
				data: null,
				createdAt: "2024-01-01T10:03:00.000Z",
			},
		];

		const result = analyzeSessionInsights({
			events,
			toolStats: [],
			agentName: "test-agent",
			capability: "builder",
			domains: ["typescript"],
		});

		expect(result.fileProfile.totalEdits).toBe(4);
		expect(result.fileProfile.hotFiles).toHaveLength(1);
		expect(result.fileProfile.hotFiles[0]).toEqual({
			path: "src/config.ts",
			editCount: 3,
		});
	});

	test("generates error pattern insight when errors are present", () => {
		const events: StoredEvent[] = [
			{
				id: 1,
				runId: "run-1",
				agentName: "test-agent",
				sessionId: "session-1",
				eventType: "tool_start",
				toolName: "Bash",
				toolArgs: JSON.stringify({ command: "bun test" }),
				toolDurationMs: null,
				level: "error",
				data: "Test failed",
				createdAt: "2024-01-01T10:00:00.000Z",
			},
			{
				id: 2,
				runId: "run-1",
				agentName: "test-agent",
				sessionId: "session-1",
				eventType: "tool_start",
				toolName: "Edit",
				toolArgs: JSON.stringify({ file_path: "src/test.ts" }),
				toolDurationMs: null,
				level: "error",
				data: "File not found",
				createdAt: "2024-01-01T10:01:00.000Z",
			},
		];

		const result = analyzeSessionInsights({
			events,
			toolStats: [],
			agentName: "test-agent",
			capability: "builder",
			domains: ["typescript"],
		});

		expect(result.toolProfile.errorCount).toBe(2);
		const errorInsight = result.insights.find((i) => i.type === "failure");
		expect(errorInsight).toBeDefined();
		expect(errorInsight?.description).toContain("2 error(s)");
		expect(errorInsight?.description).toContain("Bash");
		expect(errorInsight?.description).toContain("Edit");
		expect(errorInsight?.tags).toContain("error-pattern");
	});

	test("generates tool workflow pattern insight for sessions with 10+ tool calls", () => {
		const toolStats: ToolStats[] = [
			{ toolName: "Read", count: 12, avgDurationMs: 50, maxDurationMs: 100 },
			{ toolName: "Grep", count: 5, avgDurationMs: 80, maxDurationMs: 150 },
			{ toolName: "Edit", count: 3, avgDurationMs: 120, maxDurationMs: 200 },
		];

		const result = analyzeSessionInsights({
			events: [],
			toolStats,
			agentName: "test-agent",
			capability: "scout",
			domains: ["architecture"],
		});

		const workflowInsight = result.insights.find((i) => i.tags.includes("tool-profile"));
		expect(workflowInsight).toBeDefined();
		expect(workflowInsight?.type).toBe("pattern");
		expect(workflowInsight?.domain).toBe("architecture");
		expect(workflowInsight?.description).toContain("Read (12)");
		expect(workflowInsight?.description).toContain("read-heavy workflow");
		expect(workflowInsight?.tags).toContain("scout");
	});

	test("generates hot file insights with inferred domains", () => {
		const events: StoredEvent[] = [
			// 4 edits to src/mail/store.ts → messaging domain
			...Array.from({ length: 4 }, (_, i) => ({
				id: i + 1,
				runId: "run-1",
				agentName: "test-agent",
				sessionId: "session-1",
				eventType: "tool_start" as const,
				toolName: "Edit",
				toolArgs: JSON.stringify({ file_path: "src/mail/store.ts" }),
				toolDurationMs: null,
				level: "info" as const,
				data: null,
				createdAt: `2024-01-01T10:0${i}:00.000Z`,
			})),
			// 3 edits to src/commands/log.ts → cli domain
			...Array.from({ length: 3 }, (_, i) => ({
				id: i + 5,
				runId: "run-1",
				agentName: "test-agent",
				sessionId: "session-1",
				eventType: "tool_start" as const,
				toolName: "Edit",
				toolArgs: JSON.stringify({ file_path: "src/commands/log.ts" }),
				toolDurationMs: null,
				level: "info" as const,
				data: null,
				createdAt: `2024-01-01T10:0${i + 4}:00.000Z`,
			})),
		];

		const result = analyzeSessionInsights({
			events,
			toolStats: [],
			agentName: "test-agent",
			capability: "builder",
			domains: ["typescript"],
		});

		const hotFileInsights = result.insights.filter((i) => i.tags.includes("hot-file"));
		expect(hotFileInsights).toHaveLength(2);

		const mailInsight = hotFileInsights.find((i) => i.description.includes("src/mail/store.ts"));
		expect(mailInsight?.domain).toBe("messaging");
		expect(mailInsight?.description).toContain("4 edits");

		const cliInsight = hotFileInsights.find((i) => i.description.includes("src/commands/log.ts"));
		expect(cliInsight?.domain).toBe("cli");
		expect(cliInsight?.description).toContain("3 edits");
	});

	test("limits hot files to top 3", () => {
		const events: StoredEvent[] = [
			// 5 files with 3+ edits, should only return top 3
			...Array.from({ length: 5 }, (_, i) => ({
				id: i + 1,
				runId: "run-1",
				agentName: "test-agent",
				sessionId: "session-1",
				eventType: "tool_start" as const,
				toolName: "Edit",
				toolArgs: JSON.stringify({ file_path: `file${i}.ts` }),
				toolDurationMs: null,
				level: "info" as const,
				data: null,
				createdAt: "2024-01-01T10:00:00.000Z",
			})),
			...Array.from({ length: 5 }, (_, i) => ({
				id: i + 6,
				runId: "run-1",
				agentName: "test-agent",
				sessionId: "session-1",
				eventType: "tool_start" as const,
				toolName: "Edit",
				toolArgs: JSON.stringify({ file_path: `file${i}.ts` }),
				toolDurationMs: null,
				level: "info" as const,
				data: null,
				createdAt: "2024-01-01T10:01:00.000Z",
			})),
			...Array.from({ length: 5 }, (_, i) => ({
				id: i + 11,
				runId: "run-1",
				agentName: "test-agent",
				sessionId: "session-1",
				eventType: "tool_start" as const,
				toolName: "Edit",
				toolArgs: JSON.stringify({ file_path: `file${i}.ts` }),
				toolDurationMs: null,
				level: "info" as const,
				data: null,
				createdAt: "2024-01-01T10:02:00.000Z",
			})),
			// Extra edits to file0 and file1 to make them top 2
			...Array.from({ length: 2 }, (_, i) => ({
				id: i + 16,
				runId: "run-1",
				agentName: "test-agent",
				sessionId: "session-1",
				eventType: "tool_start" as const,
				toolName: "Edit",
				toolArgs: JSON.stringify({ file_path: "file0.ts" }),
				toolDurationMs: null,
				level: "info" as const,
				data: null,
				createdAt: "2024-01-01T10:03:00.000Z",
			})),
			{
				id: 18,
				runId: "run-1",
				agentName: "test-agent",
				sessionId: "session-1",
				eventType: "tool_start" as const,
				toolName: "Edit",
				toolArgs: JSON.stringify({ file_path: "file1.ts" }),
				toolDurationMs: null,
				level: "info" as const,
				data: null,
				createdAt: "2024-01-01T10:04:00.000Z",
			},
		];

		const result = analyzeSessionInsights({
			events,
			toolStats: [],
			agentName: "test-agent",
			capability: "builder",
			domains: ["typescript"],
		});

		const hotFileInsights = result.insights.filter((i) => i.tags.includes("hot-file"));
		expect(hotFileInsights).toHaveLength(3);
		expect(hotFileInsights[0]?.description).toContain("file0.ts");
		expect(hotFileInsights[0]?.description).toContain("5 edits");
		expect(hotFileInsights[1]?.description).toContain("file1.ts");
		expect(hotFileInsights[1]?.description).toContain("4 edits");
	});

	test("handles malformed tool args gracefully", () => {
		const events: StoredEvent[] = [
			{
				id: 1,
				runId: "run-1",
				agentName: "test-agent",
				sessionId: "session-1",
				eventType: "tool_start",
				toolName: "Edit",
				toolArgs: "not-valid-json",
				toolDurationMs: null,
				level: "info",
				data: null,
				createdAt: "2024-01-01T10:00:00.000Z",
			},
		];

		const result = analyzeSessionInsights({
			events,
			toolStats: [],
			agentName: "test-agent",
			capability: "builder",
			domains: ["typescript"],
		});

		expect(result.fileProfile.totalEdits).toBe(0);
		expect(result.fileProfile.hotFiles).toEqual([]);
	});

	test("classifies workflow types correctly", () => {
		// Test write-heavy
		const writeHeavyStats: ToolStats[] = [
			{ toolName: "Edit", count: 12, avgDurationMs: 120, maxDurationMs: 200 },
			{ toolName: "Read", count: 3, avgDurationMs: 50, maxDurationMs: 100 },
		];

		const writeResult = analyzeSessionInsights({
			events: [],
			toolStats: writeHeavyStats,
			agentName: "test-agent",
			capability: "builder",
			domains: ["typescript"],
		});

		const writeInsight = writeResult.insights.find((i) => i.tags.includes("tool-profile"));
		expect(writeInsight?.description).toContain("write-heavy workflow");

		// Test bash-heavy
		const bashHeavyStats: ToolStats[] = [
			{ toolName: "Bash", count: 12, avgDurationMs: 500, maxDurationMs: 1000 },
			{ toolName: "Read", count: 3, avgDurationMs: 50, maxDurationMs: 100 },
		];

		const bashResult = analyzeSessionInsights({
			events: [],
			toolStats: bashHeavyStats,
			agentName: "test-agent",
			capability: "builder",
			domains: ["typescript"],
		});

		const bashInsight = bashResult.insights.find((i) => i.tags.includes("tool-profile"));
		expect(bashInsight?.description).toContain("bash-heavy workflow");

		// Test balanced
		const balancedStats: ToolStats[] = [
			{ toolName: "Read", count: 5, avgDurationMs: 50, maxDurationMs: 100 },
			{ toolName: "Edit", count: 5, avgDurationMs: 120, maxDurationMs: 200 },
			{ toolName: "Bash", count: 5, avgDurationMs: 500, maxDurationMs: 1000 },
		];

		const balancedResult = analyzeSessionInsights({
			events: [],
			toolStats: balancedStats,
			agentName: "test-agent",
			capability: "builder",
			domains: ["typescript"],
		});

		const balancedInsight = balancedResult.insights.find((i) => i.tags.includes("tool-profile"));
		expect(balancedInsight?.description).toContain("balanced workflow");
	});
});

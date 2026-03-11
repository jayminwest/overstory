/**
 * Tests for `overstory costs` command.
 *
 * Uses real bun:sqlite (temp files) to test the costs command end-to-end.
 * Captures process.stdout.write to verify output formatting.
 *
 * Real implementations used for: filesystem (temp dirs), SQLite (MetricsStore,
 * SessionStore). No mocks needed -- all dependencies are cheap and local.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ValidationError } from "../errors.ts";
import { createMetricsStore } from "../metrics/store.ts";
import { createSessionStore } from "../sessions/store.ts";
import { cleanupTempDir } from "../test-helpers.ts";
import type { SessionMetrics } from "../types.ts";
import { costsCommand } from "./costs.ts";

/** Helper to create a SessionMetrics with sensible defaults. */
function makeMetrics(overrides: Partial<SessionMetrics> = {}): SessionMetrics {
	return {
		agentName: "builder-1",
		taskId: "task-001",
		capability: "builder",
		startedAt: new Date().toISOString(),
		completedAt: new Date().toISOString(),
		durationMs: 60000,
		exitCode: 0,
		mergeResult: null,
		parentAgent: null,
		inputTokens: 12345,
		outputTokens: 5678,
		cacheReadTokens: 8000,
		cacheCreationTokens: 901,
		estimatedCostUsd: 0.42,
		modelUsed: "claude-sonnet-4-20250514",
		runId: null,
		...overrides,
	};
}

describe("costsCommand", () => {
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
		tempDir = await mkdtemp(join(tmpdir(), "costs-test-"));
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
			await costsCommand(["--help"]);
			const out = output();

			expect(out).toContain("costs");
			expect(out).toContain("--agent");
			expect(out).toContain("--run");
			expect(out).toContain("--by-capability");
			expect(out).toContain("--last");
			expect(out).toContain("--json");
		});

		test("-h shows help text", async () => {
			await costsCommand(["-h"]);
			const out = output();

			expect(out).toContain("costs");
		});
	});

	// === Missing metrics.db (graceful handling) ===

	describe("missing metrics.db", () => {
		test("text mode outputs friendly message when no metrics.db exists", async () => {
			await costsCommand([]);
			const out = output();

			expect(out).toBe("No metrics data yet.\n");
		});

		test("JSON mode outputs empty array when no metrics.db exists", async () => {
			await costsCommand(["--json"]);
			const out = output();

			const parsed = JSON.parse(out.trim()) as {
				success: boolean;
				command: string;
				sessions: unknown[];
			};
			expect(parsed.success).toBe(true);
			expect(parsed.command).toBe("costs");
			expect(parsed.sessions).toEqual([]);
		});
	});

	// === Argument validation ===

	describe("argument validation", () => {
		test("--last with non-numeric value throws ValidationError", async () => {
			await expect(costsCommand(["--last", "abc"])).rejects.toThrow(ValidationError);
		});

		test("--last with zero throws ValidationError", async () => {
			await expect(costsCommand(["--last", "0"])).rejects.toThrow(ValidationError);
		});

		test("--last with negative value throws ValidationError", async () => {
			await expect(costsCommand(["--last", "-5"])).rejects.toThrow(ValidationError);
		});
	});

	// === JSON output mode ===

	describe("JSON output mode", () => {
		test("outputs valid JSON array with sessions", async () => {
			const dbPath = join(tempDir, ".overstory", "metrics.db");
			const store = createMetricsStore(dbPath);
			store.recordSession(makeMetrics({ agentName: "builder-1", taskId: "t1" }));
			store.recordSession(makeMetrics({ agentName: "scout-1", taskId: "t2", capability: "scout" }));
			store.close();

			await costsCommand(["--json"]);
			const out = output();

			const parsed = JSON.parse(out.trim()) as { success: boolean; sessions: unknown[] };
			expect(parsed.success).toBe(true);
			expect(Array.isArray(parsed.sessions)).toBe(true);
			expect(parsed.sessions).toHaveLength(2);
		});

		test("JSON output includes expected token fields", async () => {
			const dbPath = join(tempDir, ".overstory", "metrics.db");
			const store = createMetricsStore(dbPath);
			store.recordSession(
				makeMetrics({
					agentName: "builder-1",
					taskId: "t1",
					inputTokens: 100,
					outputTokens: 50,
					cacheReadTokens: 30,
					cacheCreationTokens: 10,
					estimatedCostUsd: 0.15,
				}),
			);
			store.close();

			await costsCommand(["--json"]);
			const out = output();

			const parsed = JSON.parse(out.trim()) as {
				success: boolean;
				sessions: Record<string, unknown>[];
			};
			expect(parsed.sessions).toHaveLength(1);
			const session = parsed.sessions[0];
			expect(session).toBeDefined();
			expect(session?.inputTokens).toBe(100);
			expect(session?.outputTokens).toBe(50);
			expect(session?.cacheReadTokens).toBe(30);
			expect(session?.cacheCreationTokens).toBe(10);
			expect(session?.estimatedCostUsd).toBe(0.15);
		});

		test("JSON output returns empty array when no sessions match", async () => {
			const dbPath = join(tempDir, ".overstory", "metrics.db");
			const store = createMetricsStore(dbPath);
			store.recordSession(makeMetrics({ agentName: "builder-1", taskId: "t1" }));
			store.close();

			await costsCommand(["--json", "--agent", "nonexistent"]);
			const out = output();

			const parsed = JSON.parse(out.trim()) as { success: boolean; sessions: unknown[] };
			expect(parsed.sessions).toEqual([]);
		});

		test("JSON --by-capability outputs grouped object", async () => {
			const dbPath = join(tempDir, ".overstory", "metrics.db");
			const store = createMetricsStore(dbPath);
			store.recordSession(
				makeMetrics({
					agentName: "builder-1",
					taskId: "t1",
					capability: "builder",
					inputTokens: 100,
				}),
			);
			store.recordSession(
				makeMetrics({
					agentName: "scout-1",
					taskId: "t2",
					capability: "scout",
					inputTokens: 50,
				}),
			);
			store.close();

			await costsCommand(["--json", "--by-capability"]);
			const out = output();

			const parsed = JSON.parse(out.trim()) as { grouped: Record<string, unknown> };
			expect(parsed.grouped).toBeDefined();
			expect(parsed.grouped.builder).toBeDefined();
			expect(parsed.grouped.scout).toBeDefined();

			const builderGroup = parsed.grouped.builder as Record<string, unknown>;
			expect(builderGroup.sessions).toBeDefined();
			expect(builderGroup.totals).toBeDefined();
		});
	});

	// === Human output format ===

	describe("human output format", () => {
		test("shows Cost Summary header", async () => {
			const dbPath = join(tempDir, ".overstory", "metrics.db");
			const store = createMetricsStore(dbPath);
			store.recordSession(makeMetrics({ agentName: "builder-1", taskId: "t1" }));
			store.close();

			await costsCommand([]);
			const out = output();

			expect(out).toContain("Cost Summary");
		});

		test("shows column headers", async () => {
			const dbPath = join(tempDir, ".overstory", "metrics.db");
			const store = createMetricsStore(dbPath);
			store.recordSession(makeMetrics({ agentName: "builder-1", taskId: "t1" }));
			store.close();

			await costsCommand([]);
			const out = output();

			expect(out).toContain("Agent");
			expect(out).toContain("Capability");
			expect(out).toContain("Input");
			expect(out).toContain("Output");
			expect(out).toContain("Cache");
			expect(out).toContain("Cost");
		});

		test("shows agent name and capability in output", async () => {
			const dbPath = join(tempDir, ".overstory", "metrics.db");
			const store = createMetricsStore(dbPath);
			store.recordSession(
				makeMetrics({
					agentName: "builder-1",
					taskId: "t1",
					capability: "builder",
				}),
			);
			store.close();

			await costsCommand([]);
			const out = output();

			expect(out).toContain("builder-1");
			expect(out).toContain("builder");
		});

		test("shows separator line", async () => {
			const dbPath = join(tempDir, ".overstory", "metrics.db");
			const store = createMetricsStore(dbPath);
			store.recordSession(makeMetrics({ agentName: "builder-1", taskId: "t1" }));
			store.close();

			await costsCommand([]);
			const out = output();

			expect(out).toContain("\u2500".repeat(70));
		});

		test("shows Total row", async () => {
			const dbPath = join(tempDir, ".overstory", "metrics.db");
			const store = createMetricsStore(dbPath);
			store.recordSession(makeMetrics({ agentName: "builder-1", taskId: "t1" }));
			store.close();

			await costsCommand([]);
			const out = output();

			expect(out).toContain("Total");
		});

		test("no sessions shows 'No session data found' message", async () => {
			const dbPath = join(tempDir, ".overstory", "metrics.db");
			const store = createMetricsStore(dbPath);
			// Create DB but don't insert anything
			store.close();

			await costsCommand([]);
			const out = output();

			expect(out).toContain("No session data found");
		});
	});

	// === Number formatting ===

	describe("number formatting", () => {
		test("formats numbers with thousands separators", async () => {
			const dbPath = join(tempDir, ".overstory", "metrics.db");
			const store = createMetricsStore(dbPath);
			store.recordSession(
				makeMetrics({
					agentName: "builder-1",
					taskId: "t1",
					inputTokens: 12345,
					outputTokens: 5678,
				}),
			);
			store.close();

			await costsCommand([]);
			const out = output();

			expect(out).toContain("12,345");
			expect(out).toContain("5,678");
		});

		test("formats cost with dollar sign and 2 decimal places", async () => {
			const dbPath = join(tempDir, ".overstory", "metrics.db");
			const store = createMetricsStore(dbPath);
			store.recordSession(
				makeMetrics({
					agentName: "builder-1",
					taskId: "t1",
					estimatedCostUsd: 0.42,
				}),
			);
			store.close();

			await costsCommand([]);
			const out = output();

			expect(out).toContain("$0.42");
		});

		test("handles zero tokens correctly", async () => {
			const dbPath = join(tempDir, ".overstory", "metrics.db");
			const store = createMetricsStore(dbPath);
			store.recordSession(
				makeMetrics({
					agentName: "builder-1",
					taskId: "t1",
					inputTokens: 0,
					outputTokens: 0,
					cacheReadTokens: 0,
					cacheCreationTokens: 0,
					estimatedCostUsd: 0,
				}),
			);
			store.close();

			await costsCommand([]);
			const out = output();

			expect(out).toContain("$0.00");
		});

		test("handles null cost correctly", async () => {
			const dbPath = join(tempDir, ".overstory", "metrics.db");
			const store = createMetricsStore(dbPath);
			store.recordSession(
				makeMetrics({
					agentName: "builder-1",
					taskId: "t1",
					estimatedCostUsd: null,
				}),
			);
			store.close();

			await costsCommand([]);
			const out = output();

			expect(out).toContain("$0.00");
		});
	});

	// === --agent filter ===

	describe("--agent filter", () => {
		test("filters sessions by agent name", async () => {
			const dbPath = join(tempDir, ".overstory", "metrics.db");
			const store = createMetricsStore(dbPath);
			store.recordSession(makeMetrics({ agentName: "builder-1", taskId: "t1", inputTokens: 100 }));
			store.recordSession(makeMetrics({ agentName: "scout-1", taskId: "t2", inputTokens: 200 }));
			store.close();

			await costsCommand(["--json", "--agent", "builder-1"]);
			const out = output();

			const parsed = JSON.parse(out.trim()) as { sessions: Record<string, unknown>[] };
			expect(parsed.sessions).toHaveLength(1);
			expect(parsed.sessions[0]?.agentName).toBe("builder-1");
		});

		test("returns empty for non-existent agent", async () => {
			const dbPath = join(tempDir, ".overstory", "metrics.db");
			const store = createMetricsStore(dbPath);
			store.recordSession(makeMetrics({ agentName: "builder-1", taskId: "t1" }));
			store.close();

			await costsCommand(["--json", "--agent", "nonexistent"]);
			const out = output();

			const parsed = JSON.parse(out.trim()) as { sessions: unknown[] };
			expect(parsed.sessions).toEqual([]);
		});
	});

	// === --run filter ===

	describe("--run filter", () => {
		test("filters sessions by run ID directly from metrics.db", async () => {
			const dbPath = join(tempDir, ".overstory", "metrics.db");
			const store = createMetricsStore(dbPath);
			store.recordSession(
				makeMetrics({ agentName: "builder-1", taskId: "task-001", runId: "run-2026-01-01" }),
			);
			store.recordSession(
				makeMetrics({
					agentName: "scout-1",
					taskId: "task-002",
					capability: "scout",
					runId: "run-other",
				}),
			);
			store.close();

			await costsCommand(["--json", "--run", "run-2026-01-01"]);
			const out = output();

			const parsed = JSON.parse(out.trim()) as { sessions: Record<string, unknown>[] };
			expect(parsed.sessions).toHaveLength(1);
			expect(parsed.sessions[0]?.agentName).toBe("builder-1");
		});

		test("returns empty when no sessions match run ID", async () => {
			const dbPath = join(tempDir, ".overstory", "metrics.db");
			const store = createMetricsStore(dbPath);
			store.recordSession(
				makeMetrics({ agentName: "builder-1", taskId: "t1", runId: "run-2026-01-01" }),
			);
			store.close();

			await costsCommand(["--json", "--run", "run-nonexistent"]);
			const out = output();

			const parsed = JSON.parse(out.trim()) as { sessions: unknown[] };
			expect(parsed.sessions).toEqual([]);
		});
	});

	// === --by-capability grouping ===

	describe("--by-capability grouping", () => {
		test("shows capability header", async () => {
			const dbPath = join(tempDir, ".overstory", "metrics.db");
			const store = createMetricsStore(dbPath);
			store.recordSession(
				makeMetrics({ agentName: "builder-1", taskId: "t1", capability: "builder" }),
			);
			store.close();

			await costsCommand(["--by-capability"]);
			const out = output();

			expect(out).toContain("Cost by Capability");
		});

		test("shows Sessions column header", async () => {
			const dbPath = join(tempDir, ".overstory", "metrics.db");
			const store = createMetricsStore(dbPath);
			store.recordSession(
				makeMetrics({ agentName: "builder-1", taskId: "t1", capability: "builder" }),
			);
			store.close();

			await costsCommand(["--by-capability"]);
			const out = output();

			expect(out).toContain("Sessions");
		});

		test("groups multiple sessions by capability", async () => {
			const dbPath = join(tempDir, ".overstory", "metrics.db");
			const store = createMetricsStore(dbPath);
			store.recordSession(
				makeMetrics({
					agentName: "builder-1",
					taskId: "t1",
					capability: "builder",
					inputTokens: 1000,
				}),
			);
			store.recordSession(
				makeMetrics({
					agentName: "builder-2",
					taskId: "t2",
					capability: "builder",
					inputTokens: 2000,
				}),
			);
			store.recordSession(
				makeMetrics({
					agentName: "scout-1",
					taskId: "t3",
					capability: "scout",
					inputTokens: 500,
				}),
			);
			store.close();

			await costsCommand(["--by-capability"]);
			const out = output();

			expect(out).toContain("builder");
			expect(out).toContain("scout");
			expect(out).toContain("Total");
		});

		test("shows correct session count per capability", async () => {
			const dbPath = join(tempDir, ".overstory", "metrics.db");
			const store = createMetricsStore(dbPath);
			store.recordSession(makeMetrics({ agentName: "b1", taskId: "t1", capability: "builder" }));
			store.recordSession(makeMetrics({ agentName: "b2", taskId: "t2", capability: "builder" }));
			store.recordSession(makeMetrics({ agentName: "b3", taskId: "t3", capability: "builder" }));
			store.recordSession(makeMetrics({ agentName: "s1", taskId: "t4", capability: "scout" }));
			store.close();

			await costsCommand(["--json", "--by-capability"]);
			const out = output();

			const parsed = JSON.parse(out.trim()) as {
				grouped: Record<string, { sessions: unknown[]; totals: Record<string, unknown> }>;
			};
			expect(parsed.grouped.builder?.sessions).toHaveLength(3);
			expect(parsed.grouped.scout?.sessions).toHaveLength(1);
		});

		test("empty data shows no session data message", async () => {
			const dbPath = join(tempDir, ".overstory", "metrics.db");
			const store = createMetricsStore(dbPath);
			store.close();

			await costsCommand(["--by-capability"]);
			const out = output();

			expect(out).toContain("No session data found");
		});
	});

	// === --last flag ===

	describe("--last flag", () => {
		test("limits the number of sessions returned", async () => {
			const dbPath = join(tempDir, ".overstory", "metrics.db");
			const store = createMetricsStore(dbPath);
			for (let i = 0; i < 10; i++) {
				store.recordSession(makeMetrics({ agentName: `agent-${i}`, taskId: `t-${i}` }));
			}
			store.close();

			await costsCommand(["--json", "--last", "3"]);
			const out = output();

			const parsed = JSON.parse(out.trim()) as { sessions: unknown[] };
			expect(parsed.sessions).toHaveLength(3);
		});

		test("default limit is 20", async () => {
			const dbPath = join(tempDir, ".overstory", "metrics.db");
			const store = createMetricsStore(dbPath);
			for (let i = 0; i < 25; i++) {
				store.recordSession(makeMetrics({ agentName: `agent-${i}`, taskId: `t-${i}` }));
			}
			store.close();

			await costsCommand(["--json"]);
			const out = output();

			const parsed = JSON.parse(out.trim()) as { sessions: unknown[] };
			expect(parsed.sessions).toHaveLength(20);
		});
	});

	// === Edge cases ===

	describe("edge cases", () => {
		test("handles session with all zero tokens", async () => {
			const dbPath = join(tempDir, ".overstory", "metrics.db");
			const store = createMetricsStore(dbPath);
			store.recordSession(
				makeMetrics({
					agentName: "builder-1",
					taskId: "t1",
					inputTokens: 0,
					outputTokens: 0,
					cacheReadTokens: 0,
					cacheCreationTokens: 0,
					estimatedCostUsd: 0,
				}),
			);
			store.close();

			// Should not throw
			await costsCommand([]);
			const out = output();

			expect(out).toContain("Cost Summary");
			expect(out).toContain("builder-1");
		});

		test("handles session with null cost", async () => {
			const dbPath = join(tempDir, ".overstory", "metrics.db");
			const store = createMetricsStore(dbPath);
			store.recordSession(
				makeMetrics({
					agentName: "builder-1",
					taskId: "t1",
					estimatedCostUsd: null,
				}),
			);
			store.close();

			// Should not throw
			await costsCommand([]);
			const out = output();

			expect(out).toContain("Cost Summary");
			expect(out).toContain("$0.00");
		});

		test("cache column sums cacheRead + cacheCreation tokens", async () => {
			const dbPath = join(tempDir, ".overstory", "metrics.db");
			const store = createMetricsStore(dbPath);
			store.recordSession(
				makeMetrics({
					agentName: "builder-1",
					taskId: "t1",
					cacheReadTokens: 8000,
					cacheCreationTokens: 901,
				}),
			);
			store.close();

			await costsCommand([]);
			const out = output();

			// 8000 + 901 = 8,901
			expect(out).toContain("8,901");
		});

		test("total row sums across all sessions", async () => {
			const dbPath = join(tempDir, ".overstory", "metrics.db");
			const store = createMetricsStore(dbPath);
			store.recordSession(
				makeMetrics({
					agentName: "builder-1",
					taskId: "t1",
					inputTokens: 100,
					outputTokens: 50,
					estimatedCostUsd: 0.1,
				}),
			);
			store.recordSession(
				makeMetrics({
					agentName: "scout-1",
					taskId: "t2",
					capability: "scout",
					inputTokens: 200,
					outputTokens: 100,
					estimatedCostUsd: 0.2,
				}),
			);
			store.close();

			await costsCommand(["--json"]);
			const out = output();

			const parsed = JSON.parse(out.trim()) as { sessions: SessionMetrics[] };
			const totalInput = parsed.sessions.reduce((sum, s) => sum + s.inputTokens, 0);
			const totalOutput = parsed.sessions.reduce((sum, s) => sum + s.outputTokens, 0);
			expect(totalInput).toBe(300);
			expect(totalOutput).toBe(150);
		});

		test("multiple flags work together", async () => {
			const dbPath = join(tempDir, ".overstory", "metrics.db");
			const store = createMetricsStore(dbPath);
			store.recordSession(
				makeMetrics({ agentName: "builder-1", taskId: "t1", capability: "builder" }),
			);
			store.recordSession(
				makeMetrics({ agentName: "builder-2", taskId: "t2", capability: "builder" }),
			);
			store.close();

			await costsCommand(["--by-capability", "--last", "10"]);
			const out = output();

			expect(out).toContain("Cost by Capability");
			expect(out).toContain("builder");
		});
	});

	// === --live flag ===

	describe("--live flag", () => {
		test("shows 'No live data available' when no snapshots exist", async () => {
			const overstoryDir = join(tempDir, ".overstory");
			const metricsDbPath = join(overstoryDir, "metrics.db");
			const metricsStore = createMetricsStore(metricsDbPath);
			metricsStore.close();

			await costsCommand(["--live"]);
			const out = output();

			expect(out).toContain("No live data available");
			expect(out).toContain("Token snapshots begin after first tool call");
		});

		test("shows live table when snapshots exist with active sessions", async () => {
			const overstoryDir = join(tempDir, ".overstory");

			// Create active sessions
			const sessDbPath = join(overstoryDir, "sessions.db");
			const sessionStore = createSessionStore(sessDbPath);
			sessionStore.upsert({
				id: "sess-001",
				agentName: "builder-1",
				capability: "builder",
				runtime: "claude",
				worktreePath: "/tmp/wt1",
				branchName: "feat/task1",
				taskId: "task-001",
				tmuxSession: "tmux-001",
				state: "working",
				pid: 12345,
				parentAgent: null,
				depth: 0,
				runId: "run-001",
				startedAt: new Date(Date.now() - 120_000).toISOString(), // 2 min ago
				lastActivity: new Date().toISOString(),
				escalationLevel: 0,
				stalledSince: null,
				rateLimitedSince: null,
				transcriptPath: null,
			});
			sessionStore.close();

			// Create snapshots
			const metricsDbPath = join(overstoryDir, "metrics.db");
			const metricsStore = createMetricsStore(metricsDbPath);
			metricsStore.recordSnapshot({
				agentName: "builder-1",
				inputTokens: 1000,
				outputTokens: 500,
				cacheReadTokens: 200,
				cacheCreationTokens: 100,
				estimatedCostUsd: 0.15,
				modelUsed: "claude-sonnet-4-5",
				runId: null,
				createdAt: new Date().toISOString(),
			});
			metricsStore.close();

			await costsCommand(["--live"]);
			const out = output();

			expect(out).toContain("Live Token Usage");
			expect(out).toContain("1 active agents");
			expect(out).toContain("builder-1");
			expect(out).toContain("builder");
			expect(out).toContain("1,000"); // inputTokens
			expect(out).toContain("500"); // outputTokens
			expect(out).toContain("300"); // cache total (200 + 100)
			expect(out).toContain("$0.15");
			expect(out).toContain("Burn rate");
			expect(out).toContain("tokens/min");
		});

		test("JSON output with --live returns expected structure", async () => {
			const overstoryDir = join(tempDir, ".overstory");

			// Create active sessions
			const sessDbPath = join(overstoryDir, "sessions.db");
			const sessionStore = createSessionStore(sessDbPath);
			sessionStore.upsert({
				id: "sess-001",
				agentName: "builder-1",
				capability: "builder",
				runtime: "claude",
				worktreePath: "/tmp/wt1",
				branchName: "feat/task1",
				taskId: "task-001",
				tmuxSession: "tmux-001",
				state: "working",
				pid: 12345,
				parentAgent: null,
				depth: 0,
				runId: "run-001",
				startedAt: new Date(Date.now() - 120_000).toISOString(), // 2 min ago
				lastActivity: new Date().toISOString(),
				escalationLevel: 0,
				stalledSince: null,
				rateLimitedSince: null,
				transcriptPath: null,
			});
			sessionStore.close();

			// Create snapshots
			const metricsDbPath = join(overstoryDir, "metrics.db");
			const metricsStore = createMetricsStore(metricsDbPath);
			metricsStore.recordSnapshot({
				agentName: "builder-1",
				inputTokens: 1000,
				outputTokens: 500,
				cacheReadTokens: 200,
				cacheCreationTokens: 100,
				estimatedCostUsd: 0.15,
				modelUsed: "claude-sonnet-4-5",
				runId: null,
				createdAt: new Date().toISOString(),
			});
			metricsStore.close();

			await costsCommand(["--live", "--json"]);
			const out = output();

			const parsed = JSON.parse(out.trim()) as {
				agents: unknown[];
				totals: Record<string, unknown>;
			};
			expect(parsed.agents).toHaveLength(1);
			expect(parsed.totals).toBeDefined();
			expect(parsed.totals.inputTokens).toBe(1000);
			expect(parsed.totals.outputTokens).toBe(500);
			expect(parsed.totals.cacheTokens).toBe(300);
			expect(parsed.totals.costUsd).toBe(0.15);
			expect(parsed.totals.burnRatePerMin).toBeGreaterThan(0);
			expect(parsed.totals.tokensPerMin).toBeGreaterThan(0);

			const agent = parsed.agents[0] as Record<string, unknown>;
			expect(agent.agentName).toBe("builder-1");
			expect(agent.capability).toBe("builder");
			expect(agent.inputTokens).toBe(1000);
			expect(agent.outputTokens).toBe(500);
		});

		test("--live with --agent filters by agent", async () => {
			const overstoryDir = join(tempDir, ".overstory");

			// Create active sessions
			const sessDbPath = join(overstoryDir, "sessions.db");
			const sessionStore = createSessionStore(sessDbPath);
			sessionStore.upsert({
				id: "sess-001",
				agentName: "builder-1",
				capability: "builder",
				runtime: "claude",
				worktreePath: "/tmp/wt1",
				branchName: "feat/task1",
				taskId: "task-001",
				tmuxSession: "tmux-001",
				state: "working",
				pid: 12345,
				parentAgent: null,
				depth: 0,
				runId: "run-001",
				startedAt: new Date(Date.now() - 120_000).toISOString(),
				lastActivity: new Date().toISOString(),
				escalationLevel: 0,
				stalledSince: null,
				rateLimitedSince: null,
				transcriptPath: null,
			});
			sessionStore.upsert({
				id: "sess-002",
				agentName: "scout-1",
				capability: "scout",
				runtime: "claude",
				worktreePath: "/tmp/wt2",
				branchName: "feat/task2",
				taskId: "task-002",
				tmuxSession: "tmux-002",
				state: "working",
				pid: 12346,
				parentAgent: null,
				depth: 0,
				runId: "run-001",
				startedAt: new Date(Date.now() - 120_000).toISOString(),
				lastActivity: new Date().toISOString(),
				escalationLevel: 0,
				stalledSince: null,
				rateLimitedSince: null,
				transcriptPath: null,
			});
			sessionStore.close();

			// Create snapshots
			const metricsDbPath = join(overstoryDir, "metrics.db");
			const metricsStore = createMetricsStore(metricsDbPath);
			metricsStore.recordSnapshot({
				agentName: "builder-1",
				inputTokens: 1000,
				outputTokens: 500,
				cacheReadTokens: 0,
				cacheCreationTokens: 0,
				estimatedCostUsd: 0.15,
				modelUsed: "claude-sonnet-4-5",
				runId: null,
				createdAt: new Date().toISOString(),
			});
			metricsStore.recordSnapshot({
				agentName: "scout-1",
				inputTokens: 2000,
				outputTokens: 1000,
				cacheReadTokens: 0,
				cacheCreationTokens: 0,
				estimatedCostUsd: 0.25,
				modelUsed: "claude-sonnet-4-5",
				runId: null,
				createdAt: new Date().toISOString(),
			});
			metricsStore.close();

			await costsCommand(["--live", "--json", "--agent", "builder-1"]);
			const out = output();

			const parsed = JSON.parse(out.trim()) as { agents: Record<string, unknown>[] };
			expect(parsed.agents).toHaveLength(1);
			expect(parsed.agents[0]?.agentName).toBe("builder-1");
		});

		test("--live shows burn rate in output", async () => {
			const overstoryDir = join(tempDir, ".overstory");

			// Create active sessions
			const sessDbPath = join(overstoryDir, "sessions.db");
			const sessionStore = createSessionStore(sessDbPath);
			sessionStore.upsert({
				id: "sess-001",
				agentName: "builder-1",
				capability: "builder",
				runtime: "claude",
				worktreePath: "/tmp/wt1",
				branchName: "feat/task1",
				taskId: "task-001",
				tmuxSession: "tmux-001",
				state: "working",
				pid: 12345,
				parentAgent: null,
				depth: 0,
				runId: "run-001",
				startedAt: new Date(Date.now() - 120_000).toISOString(), // 2 min ago
				lastActivity: new Date().toISOString(),
				escalationLevel: 0,
				stalledSince: null,
				rateLimitedSince: null,
				transcriptPath: null,
			});
			sessionStore.close();

			// Create snapshots
			const metricsDbPath = join(overstoryDir, "metrics.db");
			const metricsStore = createMetricsStore(metricsDbPath);
			metricsStore.recordSnapshot({
				agentName: "builder-1",
				inputTokens: 1000,
				outputTokens: 500,
				cacheReadTokens: 0,
				cacheCreationTokens: 0,
				estimatedCostUsd: 0.3,
				modelUsed: "claude-sonnet-4-5",
				runId: null,
				createdAt: new Date().toISOString(),
			});
			metricsStore.close();

			await costsCommand(["--live"]);
			const out = output();

			expect(out).toContain("Burn rate:");
			expect(out).toContain("/min");
			expect(out).toContain("tokens/min");
			expect(out).toContain("Elapsed:");
		});

		test("--live with no metrics.db shows empty JSON or message", async () => {
			await costsCommand(["--live", "--json"]);
			const out = output();

			const parsed = JSON.parse(out.trim()) as {
				agents: unknown[];
				totals: Record<string, unknown>;
			};
			expect(parsed.agents).toEqual([]);
			expect(parsed.totals.costUsd).toBe(0);
		});
	});

	// === --bead filter ===

	describe("--bead filter", () => {
		test("--bead filters by task ID (JSON)", async () => {
			const dbPath = join(tempDir, ".overstory", "metrics.db");
			const store = createMetricsStore(dbPath);
			store.recordSession(makeMetrics({ agentName: "builder-1", taskId: "task-A" }));
			store.recordSession(makeMetrics({ agentName: "builder-2", taskId: "task-A" }));
			store.recordSession(
				makeMetrics({ agentName: "scout-1", taskId: "task-B", capability: "scout" }),
			);
			store.close();

			await costsCommand(["--json", "--bead", "task-A"]);
			const out = output();

			const parsed = JSON.parse(out.trim()) as { sessions: Record<string, unknown>[] };
			expect(parsed.sessions).toHaveLength(2);
			expect(parsed.sessions.every((s) => s.taskId === "task-A")).toBe(true);
		});

		test("--bead returns empty for unknown task", async () => {
			const dbPath = join(tempDir, ".overstory", "metrics.db");
			const store = createMetricsStore(dbPath);
			store.recordSession(makeMetrics({ agentName: "builder-1", taskId: "task-A" }));
			store.close();

			await costsCommand(["--json", "--bead", "nonexistent"]);
			const out = output();

			const parsed = JSON.parse(out.trim()) as { sessions: unknown[] };
			expect(parsed.sessions).toEqual([]);
		});

		test("--bead appears in help text", async () => {
			await costsCommand(["--help"]);
			const out = output();

			expect(out).toContain("--bead");
		});
	});

	// === --self flag ===

	describe("--self flag", () => {
		let tempHome: string;
		let originalHome: string | undefined;

		/** Helper to create a transcript JSONL with known token values. */
		function makeTranscriptContent(): string {
			const entry = {
				type: "assistant",
				message: {
					model: "claude-sonnet-4-20250514",
					usage: {
						input_tokens: 5000,
						output_tokens: 2000,
						cache_read_input_tokens: 15000,
						cache_creation_input_tokens: 3000,
					},
				},
			};
			return `${JSON.stringify(entry)}\n`;
		}

		beforeEach(async () => {
			originalHome = process.env.HOME;
			tempHome = await mkdtemp(join(tmpdir(), "costs-self-home-"));
		});

		afterEach(async () => {
			process.env.HOME = originalHome;
			await cleanupTempDir(tempHome);
		});

		test("--self shows orchestrator cost when transcript exists", async () => {
			// Use process.cwd() to get the symlink-resolved path (on macOS /var -> /private/var).
			// config.project.root comes from resolveProjectRoot which uses process.cwd() internally,
			// so we must match that for the project key.
			const resolvedRoot = process.cwd();
			const projectKey = resolvedRoot.replace(/\//g, "-");
			const projectDir = join(tempHome, ".claude", "projects", projectKey);
			await mkdir(projectDir, { recursive: true });
			await Bun.write(join(projectDir, "session-abc123.jsonl"), makeTranscriptContent());

			process.env.HOME = tempHome;

			await costsCommand(["--self"]);
			const out = output();

			expect(out).toContain("Orchestrator Session Cost");
			expect(out).toContain("claude-sonnet-4-20250514");
			expect(out).toContain("5,000"); // input tokens formatted
			expect(out).toContain("2,000"); // output tokens formatted
			expect(out).toContain("18,000"); // cache total (15000 + 3000)
			// Should have some cost estimate
			expect(out).toContain("$");
		});

		test("--self --json outputs JSON with expected fields", async () => {
			// Use process.cwd() to match the symlink-resolved root used by config
			const resolvedRoot = process.cwd();
			const projectKey = resolvedRoot.replace(/\//g, "-");
			const projectDir = join(tempHome, ".claude", "projects", projectKey);
			await mkdir(projectDir, { recursive: true });
			await Bun.write(join(projectDir, "session-abc123.jsonl"), makeTranscriptContent());

			process.env.HOME = tempHome;

			await costsCommand(["--self", "--json"]);
			const out = output();

			const parsed = JSON.parse(out.trim()) as Record<string, unknown>;
			expect(parsed.source).toBe("self");
			expect(typeof parsed.transcriptPath).toBe("string");
			expect(parsed.model).toBe("claude-sonnet-4-20250514");
			expect(parsed.inputTokens).toBe(5000);
			expect(parsed.outputTokens).toBe(2000);
			expect(parsed.cacheReadTokens).toBe(15000);
			expect(parsed.cacheCreationTokens).toBe(3000);
			expect(parsed.estimatedCostUsd).toBeDefined();
		});

		test("--self shows error when no transcript found", async () => {
			// No .claude directory — just set HOME to tempHome with nothing in it
			process.env.HOME = tempHome;

			await costsCommand(["--self"]);
			const out = output();

			expect(out).toContain("No transcript found");
		});

		test("--self --json outputs error JSON when no transcript found", async () => {
			// No .claude directory
			process.env.HOME = tempHome;

			await costsCommand(["--self", "--json"]);
			const out = output();

			const parsed = JSON.parse(out.trim()) as Record<string, unknown>;
			expect(typeof parsed.error).toBe("string");
			expect(parsed.error as string).toContain("No transcript found");
		});

		test("--self in help text", async () => {
			await costsCommand(["--help"]);
			const out = output();

			expect(out).toContain("--self");
		});
	});
});

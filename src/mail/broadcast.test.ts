import { describe, expect, test } from "bun:test";
import type { AgentSession } from "../types.ts";
import { isGroupAddress, resolveGroupAddress } from "./broadcast.ts";

describe("isGroupAddress", () => {
	test("returns true for addresses starting with @", () => {
		expect(isGroupAddress("@all")).toBe(true);
		expect(isGroupAddress("@builders")).toBe(true);
		expect(isGroupAddress("@scouts")).toBe(true);
		expect(isGroupAddress("@Builder")).toBe(true); // case-insensitive input allowed
	});

	test("returns false for regular agent names", () => {
		expect(isGroupAddress("orchestrator")).toBe(false);
		expect(isGroupAddress("my-builder-agent")).toBe(false);
		expect(isGroupAddress("scout-001")).toBe(false);
	});

	test("returns false for empty string", () => {
		expect(isGroupAddress("")).toBe(false);
	});
});

describe("resolveGroupAddress", () => {
	// Helper to create minimal AgentSession fixtures
	function createSession(agentName: string, capability: string): AgentSession {
		return {
			id: `session-${agentName}`,
			agentName,
			capability,
			runtime: "claude",
			worktreePath: `/worktrees/${agentName}`,
			branchName: `branch-${agentName}`,
			taskId: "bead-001",
			tmuxSession: `overstory-test-${agentName}`,
			state: "working",
			pid: 12345,
			parentAgent: null,
			depth: 0,
			runId: "run-001",
			startedAt: "2024-01-01T00:00:00Z",
			lastActivity: "2024-01-01T00:01:00Z",
			escalationLevel: 0,
			stalledSince: null,
			rateLimitedSince: null,
			transcriptPath: null,
		};
	}

	const activeSessions: AgentSession[] = [
		createSession("orchestrator", "coordinator"),
		createSession("builder-1", "builder"),
		createSession("builder-2", "builder"),
		createSession("scout-1", "scout"),
		createSession("reviewer-1", "reviewer"),
		createSession("lead-1", "lead"),
	];

	describe("@all group", () => {
		test("resolves to all active agents except sender", () => {
			const recipients = resolveGroupAddress("@all", activeSessions, "orchestrator");
			expect(recipients).toEqual(["builder-1", "builder-2", "scout-1", "reviewer-1", "lead-1"]);
		});

		test("excludes sender from recipients", () => {
			const recipients = resolveGroupAddress("@all", activeSessions, "builder-1");
			expect(recipients).toContain("orchestrator");
			expect(recipients).toContain("builder-2");
			expect(recipients).not.toContain("builder-1"); // sender excluded
		});

		test("throws when group resolves to zero recipients", () => {
			const singleSession = [createSession("solo", "builder")];
			expect(() => resolveGroupAddress("@all", singleSession, "solo")).toThrow(
				"resolved to zero recipients",
			);
		});

		test("is case-insensitive", () => {
			const recipients = resolveGroupAddress("@ALL", activeSessions, "orchestrator");
			expect(recipients.length).toBe(5);
		});
	});

	describe("capability groups", () => {
		test("resolves @builders to all builder agents", () => {
			const recipients = resolveGroupAddress("@builders", activeSessions, "orchestrator");
			expect(recipients).toEqual(["builder-1", "builder-2"]);
		});

		test("resolves @scouts to all scout agents", () => {
			const recipients = resolveGroupAddress("@scouts", activeSessions, "orchestrator");
			expect(recipients).toEqual(["scout-1"]);
		});

		test("resolves @reviewers to all reviewer agents", () => {
			const recipients = resolveGroupAddress("@reviewers", activeSessions, "orchestrator");
			expect(recipients).toEqual(["reviewer-1"]);
		});

		test("resolves @leads to all lead agents", () => {
			const recipients = resolveGroupAddress("@leads", activeSessions, "orchestrator");
			expect(recipients).toEqual(["lead-1"]);
		});

		test("excludes sender from capability group", () => {
			const recipients = resolveGroupAddress("@builders", activeSessions, "builder-1");
			expect(recipients).toEqual(["builder-2"]);
		});

		test("throws when capability group has no matching agents", () => {
			const noMergers = activeSessions.filter((s) => s.capability !== "merger");
			expect(() => resolveGroupAddress("@mergers", noMergers, "orchestrator")).toThrow(
				"resolved to zero recipients",
			);
		});

		test("throws when all matching agents are the sender", () => {
			const singleBuilder = [createSession("solo-builder", "builder")];
			expect(() => resolveGroupAddress("@builders", singleBuilder, "solo-builder")).toThrow(
				"resolved to zero recipients",
			);
		});
	});

	describe("singular aliases", () => {
		test("@builder resolves same as @builders", () => {
			const singular = resolveGroupAddress("@builder", activeSessions, "orchestrator");
			const plural = resolveGroupAddress("@builders", activeSessions, "orchestrator");
			expect(singular).toEqual(plural);
		});

		test("@scout resolves same as @scouts", () => {
			const singular = resolveGroupAddress("@scout", activeSessions, "orchestrator");
			const plural = resolveGroupAddress("@scouts", activeSessions, "orchestrator");
			expect(singular).toEqual(plural);
		});

		test("@reviewer resolves same as @reviewers", () => {
			const singular = resolveGroupAddress("@reviewer", activeSessions, "orchestrator");
			const plural = resolveGroupAddress("@reviewers", activeSessions, "orchestrator");
			expect(singular).toEqual(plural);
		});

		test("@lead resolves same as @leads", () => {
			const singular = resolveGroupAddress("@lead", activeSessions, "orchestrator");
			const plural = resolveGroupAddress("@leads", activeSessions, "orchestrator");
			expect(singular).toEqual(plural);
		});

		test("@merger resolves same as @mergers", () => {
			const withMerger = [...activeSessions, createSession("merger-1", "merger")];
			const singular = resolveGroupAddress("@merger", withMerger, "orchestrator");
			const plural = resolveGroupAddress("@mergers", withMerger, "orchestrator");
			expect(singular).toEqual(plural);
		});

		test("@supervisor resolves same as @supervisors", () => {
			const withSupervisor = [...activeSessions, createSession("supervisor-1", "supervisor")];
			const singular = resolveGroupAddress("@supervisor", withSupervisor, "orchestrator");
			const plural = resolveGroupAddress("@supervisors", withSupervisor, "orchestrator");
			expect(singular).toEqual(plural);
		});

		test("@coordinator resolves same as @coordinators", () => {
			const singular = resolveGroupAddress("@coordinator", activeSessions, "builder-1");
			const plural = resolveGroupAddress("@coordinators", activeSessions, "builder-1");
			expect(singular).toEqual(plural);
		});

		test("@monitor resolves same as @monitors", () => {
			const withMonitor = [...activeSessions, createSession("monitor-1", "monitor")];
			const singular = resolveGroupAddress("@monitor", withMonitor, "orchestrator");
			const plural = resolveGroupAddress("@monitors", withMonitor, "orchestrator");
			expect(singular).toEqual(plural);
		});
	});

	describe("unknown groups", () => {
		test("throws for unknown group address", () => {
			expect(() => resolveGroupAddress("@unknown", activeSessions, "orchestrator")).toThrow(
				"Unknown group address",
			);
		});

		test("error message lists valid groups", () => {
			expect(() => resolveGroupAddress("@invalid", activeSessions, "orchestrator")).toThrow("@all");
		});
	});

	describe("edge cases", () => {
		test("handles empty active sessions list", () => {
			expect(() => resolveGroupAddress("@all", [], "orchestrator")).toThrow(
				"resolved to zero recipients",
			);
		});

		test("handles sessions with mixed case capability names", () => {
			const mixedCase = [createSession("builder-1", "Builder")];
			// Capability groups match exact string — "Builder" !== "builder"
			expect(() => resolveGroupAddress("@builders", mixedCase, "orchestrator")).toThrow(
				"resolved to zero recipients",
			);
		});
	});
});

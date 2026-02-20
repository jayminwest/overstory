import { describe, expect, test } from "bun:test";
import type { OverstoryConfig } from "../types.ts";
import { checkDependencies } from "./dependencies.ts";

// Minimal config for testing
const mockConfig: OverstoryConfig = {
	project: {
		name: "test-project",
		root: "/tmp/test",
		canonicalBranch: "main",
	},
	agents: {
		manifestPath: "/tmp/.overstory/agent-manifest.json",
		baseDir: "/tmp/.overstory/agents",
		maxConcurrent: 5,
		staggerDelayMs: 1000,
		maxDepth: 2,
	},
	worktrees: {
		baseDir: "/tmp/.overstory/worktrees",
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
	providers: {
		anthropic: { type: "native", runtimes: ["claude"] },
	},
	watchdog: {
		tier0Enabled: false,
		tier0IntervalMs: 30000,
		tier1Enabled: false,
		tier2Enabled: false,
		staleThresholdMs: 300000,
		zombieThresholdMs: 600000,
		nudgeIntervalMs: 60000,
	},
	models: {},
	logging: {
		verbose: false,
		redactSecrets: true,
	},
};

describe("checkDependencies", () => {
	test("returns checks for all required tools", async () => {
		const checks = await checkDependencies(mockConfig, "/tmp/.overstory");

		expect(checks).toBeArray();
		expect(checks.length).toBeGreaterThanOrEqual(5);

		// Verify we have checks for each required tool
		const toolNames = checks.map((c) => c.name);
		expect(toolNames).toContain("git availability");
		expect(toolNames).toContain("bun availability");
		expect(toolNames).toContain("tmux availability");
		expect(toolNames).toContain("bd availability");
		expect(toolNames).toContain("mulch availability");
	});

	test("includes bd CGO support check when bd is available", async () => {
		const checks = await checkDependencies(mockConfig, "/tmp/.overstory");

		const bdCheck = checks.find((c) => c.name === "bd availability");
		if (bdCheck?.status === "pass") {
			const cgoCheck = checks.find((c) => c.name === "bd CGO support");
			expect(cgoCheck).toBeDefined();
			expect(cgoCheck?.category).toBe("dependencies");
			expect(["pass", "warn", "fail"]).toContain(cgoCheck?.status ?? "");
		}
	});

	test("all checks have required DoctorCheck fields", async () => {
		const checks = await checkDependencies(mockConfig, "/tmp/.overstory");

		for (const check of checks) {
			expect(check).toHaveProperty("name");
			expect(check).toHaveProperty("category");
			expect(check).toHaveProperty("status");
			expect(check).toHaveProperty("message");

			expect(check.category).toBe("dependencies");
			expect(["pass", "warn", "fail"]).toContain(check.status);
			expect(typeof check.name).toBe("string");
			expect(typeof check.message).toBe("string");

			if (check.details !== undefined) {
				expect(check.details).toBeArray();
			}

			if (check.fixable !== undefined) {
				expect(typeof check.fixable).toBe("boolean");
			}
		}
	});

	test("checks for commonly available tools should pass", async () => {
		const checks = await checkDependencies(mockConfig, "/tmp/.overstory");

		// git and bun should definitely be available in this environment
		const gitCheck = checks.find((c) => c.name === "git availability");
		const bunCheck = checks.find((c) => c.name === "bun availability");

		expect(gitCheck).toBeDefined();
		expect(bunCheck).toBeDefined();

		// These should pass in a normal development environment
		expect(gitCheck?.status).toBe("pass");
		expect(bunCheck?.status).toBe("pass");

		// Passing checks should include version info
		if (gitCheck?.status === "pass") {
			expect(gitCheck.details).toBeArray();
			expect(gitCheck.details?.length).toBeGreaterThan(0);
		}
	});

	test("checks include version details for available tools", async () => {
		const checks = await checkDependencies(mockConfig, "/tmp/.overstory");

		const passingChecks = checks.filter((c) => c.status === "pass");

		for (const check of passingChecks) {
			expect(check.details).toBeDefined();
			expect(check.details).toBeArray();
			expect(check.details?.length).toBeGreaterThan(0);

			// Version string should not be empty
			const version = check.details?.[0];
			expect(version).toBeDefined();
			expect(typeof version).toBe("string");
			expect(version?.length).toBeGreaterThan(0);
		}
	});

	test("failing checks are marked as fixable", async () => {
		const checks = await checkDependencies(mockConfig, "/tmp/.overstory");

		const failingChecks = checks.filter((c) => c.status === "fail" || c.status === "warn");

		// If there are any failing checks, they should be marked fixable
		for (const check of failingChecks) {
			expect(check.fixable).toBe(true);
		}
	});
});

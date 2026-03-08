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
		maxSessionsPerRun: 0,
		maxAgentsPerLead: 5,
	},
	worktrees: {
		baseDir: "/tmp/.overstory/worktrees",
	},
	taskTracker: {
		backend: "auto",
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
		anthropic: { type: "native" },
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
		expect(checks.length).toBeGreaterThanOrEqual(7);

		// Verify we have checks for each required tool
		const toolNames = checks.map((c) => c.name);
		expect(toolNames).toContain("git availability");
		expect(toolNames).toContain("bun availability");
		expect(toolNames).toContain("tmux availability");
		expect(toolNames).toContain("sd availability");
		expect(toolNames).toContain("mulch availability");
		expect(toolNames).toContain("ov availability");
		expect(toolNames).toContain("cn availability");
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

	test("checks for sd when backend is seeds", async () => {
		const seedsConfig: typeof mockConfig = {
			...mockConfig,
			taskTracker: { backend: "seeds", enabled: true },
		};
		const checks = await checkDependencies(seedsConfig, "/tmp/.overstory");
		const toolNames = checks.map((c) => c.name);
		expect(toolNames).toContain("sd availability");
		expect(toolNames).not.toContain("bd availability");
	});

	test("checks for sd when backend is auto (seeds is default)", async () => {
		const checks = await checkDependencies(mockConfig, "/tmp/.overstory");
		const toolNames = checks.map((c) => c.name);
		expect(toolNames).toContain("sd availability");
		expect(toolNames).not.toContain("bd availability");
	});

	test("skips bd CGO check when backend is seeds", async () => {
		const seedsConfig: typeof mockConfig = {
			...mockConfig,
			taskTracker: { backend: "seeds", enabled: true },
		};
		const checks = await checkDependencies(seedsConfig, "/tmp/.overstory");
		const cgoCheck = checks.find((c) => c.name === "bd CGO support");
		expect(cgoCheck).toBeUndefined();
	});

	test("cn check is warn (not fail) when missing", async () => {
		const checks = await checkDependencies(mockConfig, "/tmp/.overstory");
		const cnCheck = checks.find((c) => c.name === "cn availability");
		expect(cnCheck).toBeDefined();
		// cn is optional — should never be "fail", only "pass" or "warn"
		expect(cnCheck?.status).not.toBe("fail");
	});

	test("checks short aliases for available tools", async () => {
		const checks = await checkDependencies(mockConfig, "/tmp/.overstory");
		const mulchCheck = checks.find((c) => c.name === "mulch availability");
		if (mulchCheck?.status === "pass") {
			const mlAlias = checks.find((c) => c.name === "ml alias");
			expect(mlAlias).toBeDefined();
			expect(mlAlias?.category).toBe("dependencies");
			expect(["pass", "warn"]).toContain(mlAlias?.status ?? "");
		}
		const ovCheck = checks.find((c) => c.name === "ov availability");
		if (ovCheck?.status === "pass") {
			const ovAlias = checks.find((c) => c.name === "overstory alias");
			expect(ovAlias).toBeDefined();
			expect(["pass", "warn"]).toContain(ovAlias?.status ?? "");
		}
	});

	test("alias checks are only run when primary tool passes", async () => {
		const checks = await checkDependencies(mockConfig, "/tmp/.overstory");
		// If mulch failed, ml alias should NOT be present
		const mulchCheck = checks.find((c) => c.name === "mulch availability");
		const mlAlias = checks.find((c) => c.name === "ml alias");
		if (mulchCheck?.status !== "pass") {
			expect(mlAlias).toBeUndefined();
		}
	});

	test("install hints appear in details for missing tools", async () => {
		const checks = await checkDependencies(mockConfig, "/tmp/.overstory");
		// Check any failing/warning check with an installHint has npm install guidance
		const cnCheck = checks.find((c) => c.name === "cn availability");
		if (cnCheck?.status === "warn" || cnCheck?.status === "fail") {
			const hasInstallHint = cnCheck.details?.some((d) => d.includes("npm install -g"));
			expect(hasInstallHint).toBe(true);
		}
	});

	test("includes ov availability check", async () => {
		const checks = await checkDependencies(mockConfig, "/tmp/.overstory");
		const ovCheck = checks.find((c) => c.name === "ov availability");
		expect(ovCheck).toBeDefined();
		expect(ovCheck?.category).toBe("dependencies");
	});

	test("includes agent-browser availability check", async () => {
		const checks = await checkDependencies(mockConfig, "/tmp/.overstory");
		const abCheck = checks.find((c) => c.name === "agent-browser availability");
		expect(abCheck).toBeDefined();
		expect(abCheck?.category).toBe("dependencies");
		// agent-browser is optional — should never be "fail"
		expect(abCheck?.status).not.toBe("fail");
	});

	test("agent-browser check has required DoctorCheck fields", async () => {
		const checks = await checkDependencies(mockConfig, "/tmp/.overstory");
		const abCheck = checks.find((c) => c.name === "agent-browser availability");
		expect(abCheck).toBeDefined();
		if (abCheck) {
			expect(abCheck.category).toBe("dependencies");
			expect(["pass", "warn"]).toContain(abCheck.status);
			expect(typeof abCheck.message).toBe("string");
			if (abCheck.details) {
				expect(abCheck.details).toBeArray();
			}
		}
	});
});

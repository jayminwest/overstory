import { describe, expect, test } from "bun:test";
import type { OverstoryConfig } from "../types.ts";
import { checkVersion } from "./version.ts";

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

describe("checkVersion", () => {
	test("returns checks with category version", async () => {
		const checks = await checkVersion(mockConfig, "/tmp/.overstory");

		expect(checks).toBeArray();
		expect(checks.length).toBeGreaterThan(0);

		for (const check of checks) {
			expect(check.category).toBe("version");
		}
	});

	test("includes version-current check", async () => {
		const checks = await checkVersion(mockConfig, "/tmp/.overstory");

		const versionCheck = checks.find((c) => c.name === "version-current");
		expect(versionCheck).toBeDefined();
		expect(versionCheck?.status).toBeOneOf(["pass", "warn", "fail"]);
		expect(versionCheck?.message).toContain("overstory");
	});

	test("includes package-json-sync check", async () => {
		const checks = await checkVersion(mockConfig, "/tmp/.overstory");

		const syncCheck = checks.find((c) => c.name === "package-json-sync");
		expect(syncCheck).toBeDefined();
		expect(syncCheck?.status).toBeOneOf(["pass", "warn", "fail"]);
	});

	test("version-current check reports version string", async () => {
		const checks = await checkVersion(mockConfig, "/tmp/.overstory");

		const versionCheck = checks.find((c) => c.name === "version-current");
		expect(versionCheck).toBeDefined();

		if (versionCheck?.status === "pass") {
			// Message should contain version in format "overstory vX.Y.Z"
			expect(versionCheck.message).toMatch(/overstory v\d+\.\d+\.\d+/);
		}
	});

	test("package-json-sync check provides details", async () => {
		const checks = await checkVersion(mockConfig, "/tmp/.overstory");

		const syncCheck = checks.find((c) => c.name === "package-json-sync");
		expect(syncCheck).toBeDefined();

		if (syncCheck?.status === "pass") {
			// Should include version details
			expect(syncCheck.details).toBeDefined();
			expect(syncCheck.details?.length).toBeGreaterThan(0);

			// Details should mention both package.json and src/index.ts
			const detailsText = syncCheck.details?.join(" ");
			expect(detailsText).toContain("package.json");
			expect(detailsText).toContain("src/index.ts");
		}
	});

	test("all checks have required DoctorCheck fields", async () => {
		const checks = await checkVersion(mockConfig, "/tmp/.overstory");

		for (const check of checks) {
			expect(check).toHaveProperty("name");
			expect(check).toHaveProperty("category");
			expect(check).toHaveProperty("status");
			expect(check).toHaveProperty("message");

			expect(typeof check.name).toBe("string");
			expect(typeof check.message).toBe("string");
			expect(["pass", "warn", "fail"]).toContain(check.status);

			if (check.details !== undefined) {
				expect(check.details).toBeArray();
			}

			if (check.fixable !== undefined) {
				expect(typeof check.fixable).toBe("boolean");
			}
		}
	});
});

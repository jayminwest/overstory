import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OverstoryConfig } from "../types.ts";
import { checkConfig } from "./config-check.ts";

// Helper to create a temp overstory dir with config.yaml
function createTempOverstoryDir(configYaml: string): string {
	const tempDir = mkdtempSync(join(tmpdir(), "overstory-test-"));
	const overstoryDir = join(tempDir, ".overstory");
	mkdirSync(overstoryDir, { recursive: true });
	writeFileSync(join(overstoryDir, "config.yaml"), configYaml);
	return overstoryDir;
}

// Valid minimal config
const validConfigYaml = `
projectName: test-project
project:
  root: ${tmpdir()}
  canonicalBranch: main
maxConcurrent: 5
maxDepth: 2
watchdog:
  tier0Enabled: false
  tier1Enabled: false
  tier2Enabled: false
  tier3Enabled: false
`;

const mockConfig: OverstoryConfig = {
	project: {
		name: "test-project",
		root: tmpdir(),
		canonicalBranch: "main",
	},
	agents: {
		manifestPath: `${tmpdir()}/.overstory/agent-manifest.json`,
		baseDir: `${tmpdir()}/.overstory/agents`,
		maxConcurrent: 5,
		staggerDelayMs: 1000,
		maxDepth: 2,
	},
	worktrees: {
		baseDir: `${tmpdir()}/.overstory/worktrees`,
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

describe("checkConfig", () => {
	test("returns checks with category config", async () => {
		const overstoryDir = createTempOverstoryDir(validConfigYaml);
		const checks = await checkConfig(mockConfig, overstoryDir);

		expect(checks).toBeArray();
		expect(checks.length).toBeGreaterThan(0);

		for (const check of checks) {
			expect(check.category).toBe("config");
		}
	});

	test("includes all four config checks", async () => {
		const overstoryDir = createTempOverstoryDir(validConfigYaml);
		const checks = await checkConfig(mockConfig, overstoryDir);

		const checkNames = checks.map((c) => c.name);
		expect(checkNames).toContain("config-parseable");
		expect(checkNames).toContain("config-valid");
		expect(checkNames).toContain("project-root-exists");
		expect(checkNames).toContain("canonical-branch-exists");
	});

	test("config-parseable passes with valid config", async () => {
		const overstoryDir = createTempOverstoryDir(validConfigYaml);
		const checks = await checkConfig(mockConfig, overstoryDir);

		const parseableCheck = checks.find((c) => c.name === "config-parseable");
		expect(parseableCheck).toBeDefined();
		expect(parseableCheck?.status).toBe("pass");
	});

	test("config-valid passes with valid config", async () => {
		const overstoryDir = createTempOverstoryDir(validConfigYaml);
		const checks = await checkConfig(mockConfig, overstoryDir);

		const validCheck = checks.find((c) => c.name === "config-valid");
		expect(validCheck).toBeDefined();
		expect(validCheck?.status).toBe("pass");
	});

	test("project-root-exists passes when directory exists", async () => {
		const overstoryDir = createTempOverstoryDir(validConfigYaml);
		const checks = await checkConfig(mockConfig, overstoryDir);

		const rootCheck = checks.find((c) => c.name === "project-root-exists");
		expect(rootCheck).toBeDefined();
		expect(rootCheck?.status).toBe("pass");
		expect(rootCheck?.details).toBeDefined();
	});

	test("project-root-exists fails when directory does not exist", async () => {
		const overstoryDir = createTempOverstoryDir(validConfigYaml);
		const configWithBadRoot = {
			...mockConfig,
			project: {
				...mockConfig.project,
				root: "/nonexistent/path/that/does/not/exist",
			},
		};
		const checks = await checkConfig(configWithBadRoot, overstoryDir);

		const rootCheck = checks.find((c) => c.name === "project-root-exists");
		expect(rootCheck).toBeDefined();
		expect(rootCheck?.status).toBe("fail");
		expect(rootCheck?.fixable).toBe(true);
	});

	test("canonical-branch-exists warns when branch does not exist", async () => {
		const overstoryDir = createTempOverstoryDir(validConfigYaml);
		const configWithBadBranch = {
			...mockConfig,
			project: {
				...mockConfig.project,
				canonicalBranch: "nonexistent-branch-xyz",
			},
		};
		const checks = await checkConfig(configWithBadBranch, overstoryDir);

		const branchCheck = checks.find((c) => c.name === "canonical-branch-exists");
		expect(branchCheck).toBeDefined();
		expect(branchCheck?.status).toBe("warn");
		expect(branchCheck?.message).toContain("nonexistent-branch-xyz");
	});

	test("all checks have required DoctorCheck fields", async () => {
		const overstoryDir = createTempOverstoryDir(validConfigYaml);
		const checks = await checkConfig(mockConfig, overstoryDir);

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

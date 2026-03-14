import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTempDir } from "../test-helpers.ts";
import type { OverstoryConfig } from "../types.ts";
import { checkCurrentVersion, checkVersion, checkVersionSync } from "./version.ts";

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
		expect(versionCheck?.message).toContain("ov");
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
			// Message should contain version in format "ov vX.Y.Z"
			expect(versionCheck.message).toMatch(/ov v\d+\.\d+\.\d+/);
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

describe("checkCurrentVersion", () => {
	test("passes against real repo root", async () => {
		// Use the real overstory repo root (two levels up from src/doctor/)
		const toolRoot = join(import.meta.dir, "..", "..");
		const check = await checkCurrentVersion(toolRoot);
		expect(check.name).toBe("version-current");
		expect(check.category).toBe("version");
		expect(check.status).toBe("pass");
		expect(check.message).toMatch(/ov v\d+\.\d+\.\d+/);
	});

	test("fails for temp dir without version field", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "version-test-"));
		try {
			// Write a package.json without a version field
			await Bun.write(join(tempDir, "package.json"), JSON.stringify({ name: "test" }));
			const check = await checkCurrentVersion(tempDir);
			expect(check.name).toBe("version-current");
			expect(check.status).toBe("fail");
			expect(check.message).toContain("no version field");
		} finally {
			await cleanupTempDir(tempDir);
		}
	});

	test("fails for temp dir without package.json", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "version-test-"));
		try {
			const check = await checkCurrentVersion(tempDir);
			expect(check.name).toBe("version-current");
			expect(check.status).toBe("fail");
		} finally {
			await cleanupTempDir(tempDir);
		}
	});
});

describe("checkVersionSync", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "version-sync-test-"));
	});

	afterEach(async () => {
		await cleanupTempDir(tempDir);
	});

	test("passes when versions match", async () => {
		await Bun.write(
			join(tempDir, "package.json"),
			JSON.stringify({ name: "test", version: "1.2.3" }),
		);
		const { mkdir } = await import("node:fs/promises");
		await mkdir(join(tempDir, "src"), { recursive: true });
		await Bun.write(
			join(tempDir, "src", "index.ts"),
			'const VERSION = "1.2.3";\nexport { VERSION };\n',
		);

		const check = await checkVersionSync(tempDir);
		expect(check.name).toBe("package-json-sync");
		expect(check.category).toBe("version");
		expect(check.status).toBe("pass");
		expect(check.message).toContain("synchronized");
		expect(check.details?.join(" ")).toContain("1.2.3");
	});

	test("warns when versions mismatch", async () => {
		await Bun.write(
			join(tempDir, "package.json"),
			JSON.stringify({ name: "test", version: "1.0.0" }),
		);
		const { mkdir } = await import("node:fs/promises");
		await mkdir(join(tempDir, "src"), { recursive: true });
		await Bun.write(
			join(tempDir, "src", "index.ts"),
			'const VERSION = "2.0.0";\nexport { VERSION };\n',
		);

		const check = await checkVersionSync(tempDir);
		expect(check.name).toBe("package-json-sync");
		expect(check.status).toBe("warn");
		expect(check.message).toContain("mismatch");
		expect(check.fixable).toBe(true);
	});

	test("warns when src/index.ts is missing", async () => {
		await Bun.write(
			join(tempDir, "package.json"),
			JSON.stringify({ name: "test", version: "1.0.0" }),
		);
		// No src/index.ts created

		const check = await checkVersionSync(tempDir);
		expect(check.name).toBe("package-json-sync");
		expect(check.status).toBe("warn");
	});
});

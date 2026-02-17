/**
 * Tests for structure doctor checks.
 *
 * Uses temp directories with real filesystem operations.
 * No mocks needed -- all operations are cheap and local.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OverstoryConfig } from "../types.ts";
import { checkStructure } from "./structure.ts";

describe("checkStructure", () => {
	let tempDir: string;
	let overstoryDir: string;
	let mockConfig: OverstoryConfig;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "structure-test-"));
		overstoryDir = join(tempDir, ".overstory");

		mockConfig = {
			project: {
				name: "test-project",
				root: tempDir,
				canonicalBranch: "main",
			},
			agents: {
				manifestPath: ".overstory/agent-manifest.json",
				baseDir: ".overstory/agent-defs",
				maxConcurrent: 5,
				staggerDelayMs: 1000,
				maxDepth: 2,
			},
			worktrees: {
				baseDir: ".overstory/worktrees",
			},
			beads: {
				enabled: true,
			},
			mulch: {
				enabled: true,
				domains: [],
				primeFormat: "markdown",
			},
			merge: {
				aiResolveEnabled: false,
				reimagineEnabled: false,
			},
			watchdog: {
				tier0Enabled: true,
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
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	test("fails when .overstory/ directory does not exist", async () => {
		const checks = await checkStructure(mockConfig, overstoryDir);

		expect(checks.length).toBeGreaterThan(0);
		const dirCheck = checks.find((c) => c.name === ".overstory/ directory");
		expect(dirCheck).toBeDefined();
		expect(dirCheck?.status).toBe("fail");
		expect(dirCheck?.message).toContain("missing");
		expect(dirCheck?.fixable).toBe(true);
	});

	test("passes when all required files and directories exist", async () => {
		// Create .overstory/ and all required structure
		await mkdir(overstoryDir, { recursive: true });
		await mkdir(join(overstoryDir, "agent-defs"), { recursive: true });
		await mkdir(join(overstoryDir, "agents"), { recursive: true });
		await mkdir(join(overstoryDir, "worktrees"), { recursive: true });
		await mkdir(join(overstoryDir, "specs"), { recursive: true });
		await mkdir(join(overstoryDir, "logs"), { recursive: true });

		await Bun.write(join(overstoryDir, "config.yaml"), "project:\n  name: test\n");
		await Bun.write(
			join(overstoryDir, "agent-manifest.json"),
			JSON.stringify({ version: "1.0", agents: {}, capabilityIndex: {} }, null, 2),
		);
		await Bun.write(join(overstoryDir, "hooks.json"), "{}");
		await Bun.write(
			join(overstoryDir, ".gitignore"),
			`worktrees/
logs/
mail.db
mail.db-wal
mail.db-shm
metrics.db
metrics.db-wal
metrics.db-shm
events.db
events.db-wal
events.db-shm
sessions.json
sessions.db
sessions.db-wal
sessions.db-shm
merge-queue.db
merge-queue.db-wal
merge-queue.db-shm
nudge-state.json
pending-nudges/
agents/
specs/
`,
		);

		const checks = await checkStructure(mockConfig, overstoryDir);

		// All checks should pass
		const failedChecks = checks.filter((c) => c.status === "fail");
		expect(failedChecks).toHaveLength(0);

		const dirCheck = checks.find((c) => c.name === ".overstory/ directory");
		expect(dirCheck?.status).toBe("pass");

		const filesCheck = checks.find((c) => c.name === "Required files");
		expect(filesCheck?.status).toBe("pass");

		const dirsCheck = checks.find((c) => c.name === "Required subdirectories");
		expect(dirsCheck?.status).toBe("pass");

		const gitignoreCheck = checks.find((c) => c.name === ".gitignore entries");
		expect(gitignoreCheck?.status).toBe("pass");
	});

	test("reports missing required files", async () => {
		await mkdir(overstoryDir, { recursive: true });
		await Bun.write(join(overstoryDir, "config.yaml"), "project:\n  name: test\n");
		// Missing: agent-manifest.json, hooks.json, .gitignore

		const checks = await checkStructure(mockConfig, overstoryDir);

		const filesCheck = checks.find((c) => c.name === "Required files");
		expect(filesCheck).toBeDefined();
		expect(filesCheck?.status).toBe("fail");
		expect(filesCheck?.details).toContain("agent-manifest.json");
		expect(filesCheck?.details).toContain("hooks.json");
		expect(filesCheck?.details).toContain(".gitignore");
		expect(filesCheck?.fixable).toBe(true);
	});

	test("reports missing required subdirectories", async () => {
		await mkdir(overstoryDir, { recursive: true });
		await mkdir(join(overstoryDir, "agent-defs"), { recursive: true });
		// Missing: agents/, worktrees/, specs/, logs/

		const checks = await checkStructure(mockConfig, overstoryDir);

		const dirsCheck = checks.find((c) => c.name === "Required subdirectories");
		expect(dirsCheck).toBeDefined();
		expect(dirsCheck?.status).toBe("fail");
		expect(dirsCheck?.details).toContain("agents/");
		expect(dirsCheck?.details).toContain("worktrees/");
		expect(dirsCheck?.details).toContain("specs/");
		expect(dirsCheck?.details).toContain("logs/");
		expect(dirsCheck?.fixable).toBe(true);
	});

	test("warns when .gitignore is missing entries", async () => {
		await mkdir(overstoryDir, { recursive: true });
		await Bun.write(
			join(overstoryDir, ".gitignore"),
			`# Incomplete gitignore
worktrees/
logs/
`,
		);

		const checks = await checkStructure(mockConfig, overstoryDir);

		const gitignoreCheck = checks.find((c) => c.name === ".gitignore entries");
		expect(gitignoreCheck).toBeDefined();
		expect(gitignoreCheck?.status).toBe("warn");
		expect(gitignoreCheck?.details).toBeDefined();
		expect(gitignoreCheck?.details?.length).toBeGreaterThan(0);
		expect(gitignoreCheck?.fixable).toBe(true);
	});

	test("validates agent-defs files against manifest", async () => {
		await mkdir(overstoryDir, { recursive: true });
		await mkdir(join(overstoryDir, "agent-defs"), { recursive: true });

		const manifest = {
			version: "1.0",
			agents: {
				scout: { file: "scout.md", model: "haiku", tools: [], capabilities: [], canSpawn: false },
				builder: {
					file: "builder.md",
					model: "sonnet",
					tools: [],
					capabilities: [],
					canSpawn: false,
				},
			},
			capabilityIndex: {},
		};

		await Bun.write(join(overstoryDir, "agent-manifest.json"), JSON.stringify(manifest, null, 2));
		await Bun.write(join(overstoryDir, "agent-defs", "scout.md"), "# Scout");
		// Missing: builder.md

		const checks = await checkStructure(mockConfig, overstoryDir);

		const agentDefsCheck = checks.find((c) => c.name === "Agent definition files");
		expect(agentDefsCheck).toBeDefined();
		expect(agentDefsCheck?.status).toBe("fail");
		expect(agentDefsCheck?.details).toContain("builder.md");
		expect(agentDefsCheck?.fixable).toBe(true);
	});

	test("passes when all agent-defs files are present", async () => {
		await mkdir(overstoryDir, { recursive: true });
		await mkdir(join(overstoryDir, "agent-defs"), { recursive: true });

		const manifest = {
			version: "1.0",
			agents: {
				scout: { file: "scout.md", model: "haiku", tools: [], capabilities: [], canSpawn: false },
				builder: {
					file: "builder.md",
					model: "sonnet",
					tools: [],
					capabilities: [],
					canSpawn: false,
				},
			},
			capabilityIndex: {},
		};

		await Bun.write(join(overstoryDir, "agent-manifest.json"), JSON.stringify(manifest, null, 2));
		await Bun.write(join(overstoryDir, "agent-defs", "scout.md"), "# Scout");
		await Bun.write(join(overstoryDir, "agent-defs", "builder.md"), "# Builder");

		const checks = await checkStructure(mockConfig, overstoryDir);

		const agentDefsCheck = checks.find((c) => c.name === "Agent definition files");
		expect(agentDefsCheck).toBeDefined();
		expect(agentDefsCheck?.status).toBe("pass");
	});

	test("fails gracefully when manifest is malformed", async () => {
		await mkdir(overstoryDir, { recursive: true });
		await Bun.write(join(overstoryDir, "agent-manifest.json"), "invalid json{");

		const checks = await checkStructure(mockConfig, overstoryDir);

		const agentDefsCheck = checks.find((c) => c.name === "Agent definition files");
		expect(agentDefsCheck).toBeDefined();
		expect(agentDefsCheck?.status).toBe("fail");
		expect(agentDefsCheck?.message).toContain("Cannot validate");
		expect(agentDefsCheck?.fixable).toBe(false);
	});

	test("detects leftover temp files", async () => {
		await mkdir(overstoryDir, { recursive: true });
		await Bun.write(join(overstoryDir, "config.yaml.tmp"), "temp");
		await Bun.write(join(overstoryDir, "old-file.bak"), "backup");

		const checks = await checkStructure(mockConfig, overstoryDir);

		const tempFilesCheck = checks.find((c) => c.name === "Leftover temp files");
		expect(tempFilesCheck).toBeDefined();
		expect(tempFilesCheck?.status).toBe("warn");
		expect(tempFilesCheck?.details).toContain("config.yaml.tmp");
		expect(tempFilesCheck?.details).toContain("old-file.bak");
		expect(tempFilesCheck?.fixable).toBe(true);
	});

	test("passes when no temp files exist", async () => {
		await mkdir(overstoryDir, { recursive: true });
		await Bun.write(join(overstoryDir, "config.yaml"), "project:\n  name: test\n");

		const checks = await checkStructure(mockConfig, overstoryDir);

		const tempFilesCheck = checks.find((c) => c.name === "Leftover temp files");
		expect(tempFilesCheck).toBeDefined();
		expect(tempFilesCheck?.status).toBe("pass");
	});
});

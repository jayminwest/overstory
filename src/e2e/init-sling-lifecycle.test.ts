import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { createManifestLoader } from "../agents/manifest.ts";
import { writeOverlay } from "../agents/overlay.ts";
import { initCommand } from "../commands/init.ts";
import { loadConfig } from "../config.ts";
import { cleanupTempDir, createTempGitRepo } from "../test-helpers.ts";
import type { OverlayConfig } from "../types.ts";

/**
 * E2E test: init→sling lifecycle on a throwaway external project.
 *
 * Validates the "project-agnostic" promise by running overstory init on a
 * fresh temp git repo (NOT the overstory repo itself), then verifying all
 * artifacts, loading config + manifest via real APIs, and generating an overlay.
 *
 * Uses real filesystem and real git repos. No mocks.
 * Suppresses stdout because initCommand prints status lines.
 */

const EXPECTED_AGENT_DEFS = [
	"builder.md",
	"coordinator.md",
	"lead.md",
	"merger.md",
	"monitor.md",
	"reviewer.md",
	"scout.md",
	"supervisor.md",
];

describe("E2E: init→sling lifecycle on external project", () => {
	let tempDir: string;
	let originalCwd: string;
	let originalWrite: typeof process.stdout.write;

	beforeEach(async () => {
		tempDir = await createTempGitRepo();
		originalCwd = process.cwd();
		process.chdir(tempDir);

		// Suppress stdout noise from initCommand
		originalWrite = process.stdout.write;
		process.stdout.write = (() => true) as typeof process.stdout.write;
	});

	afterEach(async () => {
		process.chdir(originalCwd);
		process.stdout.write = originalWrite;
		await cleanupTempDir(tempDir);
	});

	test("init creates all expected artifacts", async () => {
		await initCommand([]);

		const overstoryDir = join(tempDir, ".overstory");

		// config.yaml exists
		const configFile = Bun.file(join(overstoryDir, "config.yaml"));
		expect(await configFile.exists()).toBe(true);
		const configText = await configFile.text();
		expect(configText).toContain("modelProfiles:");
		expect(configText).toContain("roleProfiles:");
		expect(configText).toContain("adapters:");
		expect(configText).toContain("adapters:\n      codex:");
		expect(configText).toContain("adapters:\n      claude:");

		// agent-manifest.json exists and is valid JSON
		const manifestFile = Bun.file(join(overstoryDir, "agent-manifest.json"));
		expect(await manifestFile.exists()).toBe(true);
		const manifestText = await manifestFile.text();
		const manifestJson = JSON.parse(manifestText);
		expect(manifestJson).toBeDefined();
		expect(manifestJson.version).toBe("1.0");
		expect(typeof manifestJson.agents).toBe("object");

		// hooks.json exists
		const hooksFile = Bun.file(join(overstoryDir, "hooks.json"));
		expect(await hooksFile.exists()).toBe(true);

		// .gitignore exists
		const gitignoreFile = Bun.file(join(overstoryDir, ".gitignore"));
		expect(await gitignoreFile.exists()).toBe(true);

		// agent-defs/ contains all 8 agent definition files
		const agentDefsDir = join(overstoryDir, "agent-defs");
		const agentDefFiles = (await readdir(agentDefsDir)).filter((f) => f.endsWith(".md")).sort();
		expect(agentDefFiles).toEqual(EXPECTED_AGENT_DEFS);

		// Required subdirectories exist
		const expectedDirs = ["agents", "worktrees", "specs", "logs"];
		for (const dirName of expectedDirs) {
			const dirPath = join(overstoryDir, dirName);
			const dirStat = await stat(dirPath);
			expect(dirStat.isDirectory()).toBe(true);
		}
	});

	test("loadConfig returns valid config pointing to temp dir", async () => {
		await initCommand([]);

		const config = await loadConfig(tempDir);

		// project.root should point to the temp directory
		expect(config.project.root).toBe(tempDir);

		// agents.baseDir should be the relative path to agent-defs
		expect(config.agents.baseDir).toBe(".overstory/agent-defs");

		// canonicalBranch should be detected (main for our test repos)
		expect(config.project.canonicalBranch).toBeTruthy();

		// name should be set (from dir basename or git remote)
		expect(config.project.name).toBeTruthy();
	});

	test("manifest loads successfully with all 8 agents", async () => {
		await initCommand([]);

		const manifestPath = join(tempDir, ".overstory", "agent-manifest.json");
		const agentDefsDir = join(tempDir, ".overstory", "agent-defs");
		const loader = createManifestLoader(manifestPath, agentDefsDir);

		const manifest = await loader.load();

		// All 8 agents present
		const agentNames = Object.keys(manifest.agents).sort();
		expect(agentNames).toEqual([
			"builder",
			"coordinator",
			"lead",
			"merger",
			"monitor",
			"reviewer",
			"scout",
			"supervisor",
		]);

		// Each agent has a valid file reference
		for (const [_name, def] of Object.entries(manifest.agents)) {
			expect(def.file).toEndWith(".md");
			// Verify the referenced .md file actually exists
			const mdFile = Bun.file(join(agentDefsDir, def.file));
			expect(await mdFile.exists()).toBe(true);
		}

		// Validation returns no errors
		const errors = loader.validate();
		expect(errors).toEqual([]);
	});

	test("manifest capability index is consistent", async () => {
		await initCommand([]);

		const manifestPath = join(tempDir, ".overstory", "agent-manifest.json");
		const agentDefsDir = join(tempDir, ".overstory", "agent-defs");
		const loader = createManifestLoader(manifestPath, agentDefsDir);

		const manifest = await loader.load();

		// capabilityIndex should map capabilities to agent names
		expect(Object.keys(manifest.capabilityIndex).length).toBeGreaterThan(0);

		// Each capability in the index should reference agents that declare it
		for (const [cap, names] of Object.entries(manifest.capabilityIndex)) {
			for (const name of names) {
				const agent = manifest.agents[name];
				expect(agent).toBeDefined();
				expect(agent?.capabilities).toContain(cap);
			}
		}
	});

	test("overlay generation works for external project", async () => {
		await initCommand([]);

		const agentDefsDir = join(tempDir, ".overstory", "agent-defs");
		const baseDefinition = await Bun.file(join(agentDefsDir, "builder.md")).text();

		const overlayConfig: OverlayConfig = {
			agentName: "test-agent",
			beadId: "test-bead-001",
			specPath: null,
			branchName: "overstory/test-agent/test-bead-001",
			worktreePath: join(tempDir, ".overstory", "worktrees", "test-agent"),
			fileScope: [],
			mulchDomains: [],
			parentAgent: null,
			depth: 0,
			canSpawn: false,
			capability: "builder",
			baseDefinition,
		};

		// Write the overlay into a subdirectory of the temp dir (simulating a worktree)
		const worktreePath = join(tempDir, ".overstory", "worktrees", "test-agent");
		const { mkdir } = await import("node:fs/promises");
		await mkdir(worktreePath, { recursive: true });

		await writeOverlay(worktreePath, overlayConfig, tempDir);

		// Verify the overlay was written
		const overlayPath = join(worktreePath, ".claude", "CLAUDE.md");
		const overlayFile = Bun.file(overlayPath);
		expect(await overlayFile.exists()).toBe(true);

		const content = await overlayFile.text();

		// Verify template placeholders were replaced
		expect(content).toContain("test-agent");
		expect(content).toContain("test-bead-001");
		expect(content).toContain("overstory/test-agent/test-bead-001");
		expect(content).not.toContain("{{AGENT_NAME}}");
		expect(content).not.toContain("{{BEAD_ID}}");
		expect(content).not.toContain("{{BRANCH_NAME}}");
	});

	test("full init→config→manifest→overlay pipeline succeeds", async () => {
		// This test validates the entire lifecycle in sequence:
		// init → load config → load manifest → generate overlay

		// Step 1: Init
		await initCommand([]);

		// Step 2: Load config
		const config = await loadConfig(tempDir);
		expect(config.project.root).toBe(tempDir);

		// Step 3: Load manifest using config paths
		const manifestPath = join(config.project.root, config.agents.manifestPath);
		const agentDefsDir = join(config.project.root, config.agents.baseDir);
		const loader = createManifestLoader(manifestPath, agentDefsDir);
		await loader.load();

		// Verify builder agent exists (the one we'll use for overlay)
		const builder = loader.getAgent("builder");
		expect(builder).toBeDefined();
		expect(builder?.canSpawn).toBe(false);

		// Verify lead agent can spawn
		const lead = loader.getAgent("lead");
		expect(lead).toBeDefined();
		expect(lead?.canSpawn).toBe(true);

		// Step 4: Generate overlay using a realistic config
		const builderDef = await Bun.file(join(agentDefsDir, "builder.md")).text();
		const overlayConfig: OverlayConfig = {
			agentName: "lifecycle-builder",
			beadId: "lifecycle-001",
			specPath: join(tempDir, ".overstory", "specs", "lifecycle-001.md"),
			branchName: "overstory/lifecycle-builder/lifecycle-001",
			worktreePath: join(tempDir, ".overstory", "worktrees", "lifecycle-builder"),
			fileScope: ["src/main.ts", "src/utils.ts"],
			mulchDomains: ["typescript"],
			parentAgent: "orchestrator",
			depth: 0,
			canSpawn: false,
			capability: "builder",
			baseDefinition: builderDef,
		};

		const worktreePath = join(tempDir, ".overstory", "worktrees", "lifecycle-builder");
		const { mkdir } = await import("node:fs/promises");
		await mkdir(worktreePath, { recursive: true });

		await writeOverlay(worktreePath, overlayConfig, tempDir);

		const overlayContent = await Bun.file(join(worktreePath, ".claude", "CLAUDE.md")).text();

		// Verify all overlay fields rendered correctly
		expect(overlayContent).toContain("lifecycle-builder");
		expect(overlayContent).toContain("lifecycle-001");
		expect(overlayContent).toContain("overstory/lifecycle-builder/lifecycle-001");
		expect(overlayContent).toContain("orchestrator");
		expect(overlayContent).toContain("`src/main.ts`");
		expect(overlayContent).toContain("`src/utils.ts`");
		expect(overlayContent).toContain("mulch prime typescript");

		// No unresolved placeholders
		expect(overlayContent).not.toMatch(/\{\{[A-Z_]+\}\}/);
	});
});

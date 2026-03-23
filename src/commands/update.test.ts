import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { cleanupTempDir, createTempGitRepo } from "../test-helpers.ts";
import type { Spawner } from "./init.ts";
import {
	buildAgentManifest,
	buildHooksJson,
	initCommand,
	OVERSTORY_GITIGNORE,
	OVERSTORY_README,
} from "./init.ts";
import { executeUpdate } from "./update.ts";

/**
 * Tests for `ov update` — refresh .overstory/ managed files.
 *
 * Uses real temp git repos. Suppresses stdout to keep test output clean.
 * Requires a pre-initialized .overstory/ directory (via initCommand).
 */

/** No-op spawner that treats all ecosystem tools as "not installed". */
const noopSpawner: Spawner = async () => ({ exitCode: 1, stdout: "", stderr: "not found" });

const AGENT_DEF_FILES = [
	"builder.md",
	"coordinator.md",
	"lead.md",
	"merger.md",
	"monitor.md",
	"orchestrator.md",
	"ov-co-creation.md",
	"ov-delivery.md",
	"reviewer.md",
	"scout.md",
];

/** Resolve the source agents directory (same logic as init.ts). */
const SOURCE_AGENTS_DIR = join(import.meta.dir, "..", "..", "agents");

describe("executeUpdate: not initialized", () => {
	let tempDir: string;
	let originalCwd: string;
	let originalWrite: typeof process.stdout.write;

	beforeEach(async () => {
		tempDir = await createTempGitRepo();
		originalCwd = process.cwd();
		process.chdir(tempDir);

		originalWrite = process.stdout.write;
		process.stdout.write = (() => true) as typeof process.stdout.write;
	});

	afterEach(async () => {
		process.chdir(originalCwd);
		process.stdout.write = originalWrite;
		await cleanupTempDir(tempDir);
	});

	test("errors when .overstory/config.yaml does not exist", async () => {
		await expect(executeUpdate({})).rejects.toThrow("Not initialized");
	});

	test("error message hints to run ov init", async () => {
		try {
			await executeUpdate({});
			expect.unreachable("Should have thrown");
		} catch (err) {
			expect((err as Error).message).toContain("ov init");
		}
	});
});

describe("executeUpdate: refresh all (no flags)", () => {
	let tempDir: string;
	let originalCwd: string;
	let originalWrite: typeof process.stdout.write;

	beforeEach(async () => {
		tempDir = await createTempGitRepo();
		originalCwd = process.cwd();
		process.chdir(tempDir);

		originalWrite = process.stdout.write;
		process.stdout.write = (() => true) as typeof process.stdout.write;

		// Initialize .overstory/
		await initCommand({ _spawner: noopSpawner });
	});

	afterEach(async () => {
		process.chdir(originalCwd);
		process.stdout.write = originalWrite;
		await cleanupTempDir(tempDir);
	});

	test("refreshes all managed files when no flags given", async () => {
		// Tamper with agent defs
		const scoutPath = join(tempDir, ".overstory", "agent-defs", "scout.md");
		await Bun.write(scoutPath, "# tampered\n");

		// Tamper with manifest
		await Bun.write(join(tempDir, ".overstory", "agent-manifest.json"), "{}");

		// Tamper with hooks
		await Bun.write(join(tempDir, ".overstory", "hooks.json"), "{}");

		// Tamper with gitignore
		await Bun.write(join(tempDir, ".overstory", ".gitignore"), "# old\n");

		// Tamper with readme
		await Bun.write(join(tempDir, ".overstory", "README.md"), "# old\n");

		await executeUpdate({});

		// Verify all files restored
		const scoutContent = await Bun.file(scoutPath).text();
		const sourceScout = await Bun.file(join(SOURCE_AGENTS_DIR, "scout.md")).text();
		expect(scoutContent).toBe(sourceScout);

		const manifestContent = await Bun.file(
			join(tempDir, ".overstory", "agent-manifest.json"),
		).text();
		const expectedManifest = `${JSON.stringify(buildAgentManifest(), null, "\t")}\n`;
		expect(manifestContent).toBe(expectedManifest);

		const hooksContent = await Bun.file(join(tempDir, ".overstory", "hooks.json")).text();
		expect(hooksContent).toBe(buildHooksJson());

		const gitignoreContent = await Bun.file(join(tempDir, ".overstory", ".gitignore")).text();
		expect(gitignoreContent).toBe(OVERSTORY_GITIGNORE);

		const readmeContent = await Bun.file(join(tempDir, ".overstory", "README.md")).text();
		expect(readmeContent).toBe(OVERSTORY_README);
	});

	test("does not touch config.yaml", async () => {
		const configPath = join(tempDir, ".overstory", "config.yaml");
		const originalConfig = await Bun.file(configPath).text();

		await executeUpdate({});

		const afterUpdate = await Bun.file(configPath).text();
		expect(afterUpdate).toBe(originalConfig);
	});

	test("does not touch databases", async () => {
		// Create fake database files
		const mailDbPath = join(tempDir, ".overstory", "mail.db");
		const sessionsDbPath = join(tempDir, ".overstory", "sessions.db");
		await Bun.write(mailDbPath, "fake-mail-db");
		await Bun.write(sessionsDbPath, "fake-sessions-db");

		await executeUpdate({});

		const mailDb = await Bun.file(mailDbPath).text();
		expect(mailDb).toBe("fake-mail-db");

		const sessionsDb = await Bun.file(sessionsDbPath).text();
		expect(sessionsDb).toBe("fake-sessions-db");
	});

	test("handles already-up-to-date files gracefully (idempotent)", async () => {
		// Run update twice — second should report nothing changed
		await executeUpdate({});

		// Capture JSON output of second run
		let captured = "";
		const restoreWrite = process.stdout.write;
		process.stdout.write = ((chunk: unknown) => {
			captured += String(chunk);
			return true;
		}) as typeof process.stdout.write;

		await executeUpdate({ json: true });

		process.stdout.write = restoreWrite;

		const parsed = JSON.parse(captured.trim()) as Record<string, unknown>;
		expect(parsed.success).toBe(true);

		const agentDefs = parsed.agentDefs as { updated: string[]; unchanged: string[] };
		expect(agentDefs.updated).toHaveLength(0);
		expect(agentDefs.unchanged.length).toBeGreaterThan(0);

		expect(parsed.manifest).toEqual({ updated: false });
		expect(parsed.hooks).toEqual({ updated: false });
		expect(parsed.gitignore).toEqual({ updated: false });
		expect(parsed.readme).toEqual({ updated: false });
	});
});

describe("executeUpdate: granular flags", () => {
	let tempDir: string;
	let originalCwd: string;
	let originalWrite: typeof process.stdout.write;

	beforeEach(async () => {
		tempDir = await createTempGitRepo();
		originalCwd = process.cwd();
		process.chdir(tempDir);

		originalWrite = process.stdout.write;
		process.stdout.write = (() => true) as typeof process.stdout.write;

		await initCommand({ _spawner: noopSpawner });
	});

	afterEach(async () => {
		process.chdir(originalCwd);
		process.stdout.write = originalWrite;
		await cleanupTempDir(tempDir);
	});

	test("--agents only refreshes agent-defs", async () => {
		// Tamper with agent def and manifest
		await Bun.write(join(tempDir, ".overstory", "agent-defs", "scout.md"), "# tampered\n");
		await Bun.write(join(tempDir, ".overstory", "agent-manifest.json"), "{}");
		await Bun.write(join(tempDir, ".overstory", "hooks.json"), "{}");

		await executeUpdate({ agents: true });

		// Agent def should be restored
		const scoutContent = await Bun.file(
			join(tempDir, ".overstory", "agent-defs", "scout.md"),
		).text();
		const sourceScout = await Bun.file(join(SOURCE_AGENTS_DIR, "scout.md")).text();
		expect(scoutContent).toBe(sourceScout);

		// Manifest should NOT be restored (--agents only)
		const manifestContent = await Bun.file(
			join(tempDir, ".overstory", "agent-manifest.json"),
		).text();
		expect(manifestContent).toBe("{}");

		// Hooks should NOT be restored (--agents only)
		const hooksContent = await Bun.file(join(tempDir, ".overstory", "hooks.json")).text();
		expect(hooksContent).toBe("{}");
	});

	test("--manifest only refreshes agent-manifest.json", async () => {
		await Bun.write(join(tempDir, ".overstory", "agent-manifest.json"), "{}");
		await Bun.write(join(tempDir, ".overstory", "agent-defs", "scout.md"), "# tampered\n");

		await executeUpdate({ manifest: true });

		// Manifest should be restored
		const manifestContent = await Bun.file(
			join(tempDir, ".overstory", "agent-manifest.json"),
		).text();
		const expectedManifest = `${JSON.stringify(buildAgentManifest(), null, "\t")}\n`;
		expect(manifestContent).toBe(expectedManifest);

		// Agent def should NOT be restored
		const scoutContent = await Bun.file(
			join(tempDir, ".overstory", "agent-defs", "scout.md"),
		).text();
		expect(scoutContent).toBe("# tampered\n");
	});

	test("--hooks only refreshes hooks.json", async () => {
		await Bun.write(join(tempDir, ".overstory", "hooks.json"), "{}");
		await Bun.write(join(tempDir, ".overstory", "agent-manifest.json"), "{}");

		await executeUpdate({ hooks: true });

		// Hooks should be restored
		const hooksContent = await Bun.file(join(tempDir, ".overstory", "hooks.json")).text();
		expect(hooksContent).toBe(buildHooksJson());

		// Manifest should NOT be restored
		const manifestContent = await Bun.file(
			join(tempDir, ".overstory", "agent-manifest.json"),
		).text();
		expect(manifestContent).toBe("{}");
	});

	test("granular flags do not refresh gitignore or readme", async () => {
		await Bun.write(join(tempDir, ".overstory", ".gitignore"), "# old\n");
		await Bun.write(join(tempDir, ".overstory", "README.md"), "# old\n");

		await executeUpdate({ agents: true });

		const gitignoreContent = await Bun.file(join(tempDir, ".overstory", ".gitignore")).text();
		expect(gitignoreContent).toBe("# old\n");

		const readmeContent = await Bun.file(join(tempDir, ".overstory", "README.md")).text();
		expect(readmeContent).toBe("# old\n");
	});
});

describe("executeUpdate: --dry-run", () => {
	let tempDir: string;
	let originalCwd: string;
	let originalWrite: typeof process.stdout.write;

	beforeEach(async () => {
		tempDir = await createTempGitRepo();
		originalCwd = process.cwd();
		process.chdir(tempDir);

		originalWrite = process.stdout.write;
		process.stdout.write = (() => true) as typeof process.stdout.write;

		await initCommand({ _spawner: noopSpawner });
	});

	afterEach(async () => {
		process.chdir(originalCwd);
		process.stdout.write = originalWrite;
		await cleanupTempDir(tempDir);
	});

	test("reports changes without writing files", async () => {
		// Tamper with files
		await Bun.write(join(tempDir, ".overstory", "agent-defs", "scout.md"), "# tampered\n");
		await Bun.write(join(tempDir, ".overstory", "agent-manifest.json"), "{}");

		let captured = "";
		const restoreWrite = process.stdout.write;
		process.stdout.write = ((chunk: unknown) => {
			captured += String(chunk);
			return true;
		}) as typeof process.stdout.write;

		await executeUpdate({ dryRun: true, json: true });

		process.stdout.write = restoreWrite;

		const parsed = JSON.parse(captured.trim()) as Record<string, unknown>;
		expect(parsed.success).toBe(true);
		expect(parsed.dryRun).toBe(true);

		const agentDefs = parsed.agentDefs as { updated: string[]; unchanged: string[] };
		expect(agentDefs.updated).toContain("scout.md");

		expect(parsed.manifest).toEqual({ updated: true });

		// Verify files were NOT actually modified
		const scoutContent = await Bun.file(
			join(tempDir, ".overstory", "agent-defs", "scout.md"),
		).text();
		expect(scoutContent).toBe("# tampered\n");

		const manifestContent = await Bun.file(
			join(tempDir, ".overstory", "agent-manifest.json"),
		).text();
		expect(manifestContent).toBe("{}");
	});
});

describe("executeUpdate: --json output", () => {
	let tempDir: string;
	let originalCwd: string;
	let originalWrite: typeof process.stdout.write;

	beforeEach(async () => {
		tempDir = await createTempGitRepo();
		originalCwd = process.cwd();
		process.chdir(tempDir);

		originalWrite = process.stdout.write;
		process.stdout.write = (() => true) as typeof process.stdout.write;

		await initCommand({ _spawner: noopSpawner });
	});

	afterEach(async () => {
		process.chdir(originalCwd);
		process.stdout.write = originalWrite;
		await cleanupTempDir(tempDir);
	});

	test("outputs correct JSON envelope", async () => {
		let captured = "";
		const restoreWrite = process.stdout.write;
		process.stdout.write = ((chunk: unknown) => {
			captured += String(chunk);
			return true;
		}) as typeof process.stdout.write;

		await executeUpdate({ json: true });

		process.stdout.write = restoreWrite;

		const parsed = JSON.parse(captured.trim()) as Record<string, unknown>;
		expect(parsed.success).toBe(true);
		expect(parsed.command).toBe("update");
		expect(parsed.dryRun).toBe(false);
		expect(parsed.agentDefs).toBeDefined();
		expect(parsed.manifest).toBeDefined();
		expect(parsed.hooks).toBeDefined();
		expect(parsed.gitignore).toBeDefined();
		expect(parsed.readme).toBeDefined();
	});

	test("JSON envelope includes updated file lists", async () => {
		// Tamper with scout
		await Bun.write(join(tempDir, ".overstory", "agent-defs", "scout.md"), "# tampered\n");

		let captured = "";
		const restoreWrite = process.stdout.write;
		process.stdout.write = ((chunk: unknown) => {
			captured += String(chunk);
			return true;
		}) as typeof process.stdout.write;

		await executeUpdate({ json: true });

		process.stdout.write = restoreWrite;

		const parsed = JSON.parse(captured.trim()) as Record<string, unknown>;
		const agentDefs = parsed.agentDefs as { updated: string[]; unchanged: string[] };
		expect(agentDefs.updated).toContain("scout.md");
		expect(agentDefs.unchanged.length).toBeGreaterThan(0);
	});
});

describe("executeUpdate: agent def exclusions", () => {
	let tempDir: string;
	let originalCwd: string;
	let originalWrite: typeof process.stdout.write;

	beforeEach(async () => {
		tempDir = await createTempGitRepo();
		originalCwd = process.cwd();
		process.chdir(tempDir);

		originalWrite = process.stdout.write;
		process.stdout.write = (() => true) as typeof process.stdout.write;

		await initCommand({ _spawner: noopSpawner });
	});

	afterEach(async () => {
		process.chdir(originalCwd);
		process.stdout.write = originalWrite;
		await cleanupTempDir(tempDir);
	});

	test("does not deploy supervisor.md (deprecated)", async () => {
		await executeUpdate({ agents: true });

		const agentDefsDir = join(tempDir, ".overstory", "agent-defs");
		const files = await readdir(agentDefsDir);
		expect(files).not.toContain("supervisor.md");
	});

	test("deploys all non-deprecated agent defs", async () => {
		// Delete all agent defs first
		for (const f of AGENT_DEF_FILES) {
			try {
				const { unlink } = await import("node:fs/promises");
				await unlink(join(tempDir, ".overstory", "agent-defs", f));
			} catch {
				// May not exist
			}
		}

		await executeUpdate({ agents: true });

		const agentDefsDir = join(tempDir, ".overstory", "agent-defs");
		const files = (await readdir(agentDefsDir)).filter((f) => f.endsWith(".md")).sort();
		expect(files).toEqual(AGENT_DEF_FILES);
	});
});

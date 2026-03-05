import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { cleanupTempDir, createTempGitRepo, runGitInDir } from "../test-helpers.ts";
import type { Spawner } from "./init.ts";
import {
	detectDefaultRuntime,
	initCommand,
	OVERSTORY_GITIGNORE,
	OVERSTORY_README,
	resolveToolSet,
} from "./init.ts";

/**
 * Tests for `overstory init` -- agent definition deployment.
 *
 * Uses real temp git repos. Suppresses stdout to keep test output clean.
 * process.cwd() is saved/restored because initCommand uses it to find the project root.
 *
 * Tests that don't exercise ecosystem bootstrap pass a no-op spawner via _spawner
 * so they don't require ml/sd/cn CLIs to be installed (they aren't available in CI).
 */

/** No-op spawner that treats all ecosystem tools as "not installed". */
const noopSpawner: Spawner = async () => ({ exitCode: 1, stdout: "", stderr: "not found" });

const AGENT_DEF_FILES = [
	"scout.md",
	"builder.md",
	"reviewer.md",
	"lead.md",
	"merger.md",
	"coordinator.md",
	"monitor.md",
	"orchestrator.md",
];

/** Resolve the source agents directory (same logic as init.ts). */
const SOURCE_AGENTS_DIR = join(import.meta.dir, "..", "..", "agents");

describe("initCommand: agent-defs deployment", () => {
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

	test("creates .overstory/agent-defs/ with all 8 agent definition files (supervisor deprecated)", async () => {
		await initCommand({ _spawner: noopSpawner });

		const agentDefsDir = join(tempDir, ".overstory", "agent-defs");
		const files = await readdir(agentDefsDir);
		const mdFiles = files.filter((f) => f.endsWith(".md")).sort();

		expect(mdFiles).toEqual(AGENT_DEF_FILES.slice().sort());
	});

	test("copied files match source content", async () => {
		await initCommand({ _spawner: noopSpawner });

		for (const fileName of AGENT_DEF_FILES) {
			const sourcePath = join(SOURCE_AGENTS_DIR, fileName);
			const targetPath = join(tempDir, ".overstory", "agent-defs", fileName);

			const sourceContent = await Bun.file(sourcePath).text();
			const targetContent = await Bun.file(targetPath).text();

			expect(targetContent).toBe(sourceContent);
		}
	});

	test("--force reinit overwrites existing agent def files", async () => {
		// First init
		await initCommand({ _spawner: noopSpawner });

		// Tamper with one of the deployed files
		const tamperPath = join(tempDir, ".overstory", "agent-defs", "scout.md");
		await Bun.write(tamperPath, "# tampered content\n");

		// Verify tamper worked
		const tampered = await Bun.file(tamperPath).text();
		expect(tampered).toBe("# tampered content\n");

		// Reinit with --force
		await initCommand({ force: true, _spawner: noopSpawner });

		// Verify the file was overwritten with the original source
		const sourceContent = await Bun.file(join(SOURCE_AGENTS_DIR, "scout.md")).text();
		const restored = await Bun.file(tamperPath).text();
		expect(restored).toBe(sourceContent);
	});

	test("Stop hook includes mulch learn command", async () => {
		await initCommand({ _spawner: noopSpawner });

		const hooksPath = join(tempDir, ".overstory", "hooks.json");
		const content = await Bun.file(hooksPath).text();
		const parsed = JSON.parse(content);
		const stopHooks = parsed.hooks.Stop[0].hooks;

		expect(stopHooks.length).toBe(2);
		expect(stopHooks[0].command).toContain("ov log session-end");
		expect(stopHooks[1].command).toBe("mulch learn");
	});

	test("PostToolUse hooks include Bash-matched mulch diff hook", async () => {
		await initCommand({ _spawner: noopSpawner });

		const hooksPath = join(tempDir, ".overstory", "hooks.json");
		const content = await Bun.file(hooksPath).text();
		const parsed = JSON.parse(content);
		const postToolUseHooks = parsed.hooks.PostToolUse;

		// Should have the generic tool-end logger plus the new Bash-specific hook
		expect(postToolUseHooks.length).toBe(2);

		const bashHookEntry = postToolUseHooks[1];
		expect(bashHookEntry.matcher).toBe("Bash");
		expect(bashHookEntry.hooks.length).toBe(1);

		const command = bashHookEntry.hooks[0].command;
		expect(command).toContain("git commit");
		expect(command).toContain("mulch diff HEAD~1");
	});
});

describe("initCommand: .overstory/.gitignore", () => {
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

	test("creates .overstory/.gitignore with wildcard+whitelist model", async () => {
		await initCommand({ _spawner: noopSpawner });

		const gitignorePath = join(tempDir, ".overstory", ".gitignore");
		const content = await Bun.file(gitignorePath).text();

		// Verify wildcard+whitelist pattern
		expect(content).toContain("*\n");
		expect(content).toContain("!.gitignore\n");
		expect(content).toContain("!config.yaml\n");
		expect(content).toContain("!agent-manifest.json\n");
		expect(content).toContain("!hooks.json\n");
		expect(content).toContain("!groups.json\n");
		expect(content).toContain("!agent-defs/\n");
		expect(content).toContain("!agent-defs/**\n");

		// Verify it matches the exported constant
		expect(content).toBe(OVERSTORY_GITIGNORE);
	});

	test("gitignore is always written when init completes", async () => {
		// Init should write gitignore
		await initCommand({ _spawner: noopSpawner });

		const gitignorePath = join(tempDir, ".overstory", ".gitignore");
		const content = await Bun.file(gitignorePath).text();

		// Verify gitignore was written with correct content
		expect(content).toBe(OVERSTORY_GITIGNORE);

		// Verify the file exists
		const exists = await Bun.file(gitignorePath).exists();
		expect(exists).toBe(true);
	});

	test("--force reinit overwrites stale .overstory/.gitignore", async () => {
		// First init
		await initCommand({ _spawner: noopSpawner });

		const gitignorePath = join(tempDir, ".overstory", ".gitignore");

		// Tamper with the gitignore file (simulate old deny-list format)
		await Bun.write(gitignorePath, "# old format\nworktrees/\nlogs/\nmail.db\n");

		// Verify tamper worked
		const tampered = await Bun.file(gitignorePath).text();
		expect(tampered).not.toContain("*\n");
		expect(tampered).not.toContain("!.gitignore\n");

		// Reinit with --force
		await initCommand({ force: true, _spawner: noopSpawner });

		// Verify the file was overwritten with the new wildcard+whitelist format
		const restored = await Bun.file(gitignorePath).text();
		expect(restored).toBe(OVERSTORY_GITIGNORE);
		expect(restored).toContain("*\n");
		expect(restored).toContain("!.gitignore\n");
	});

	test("subsequent init without --force does not overwrite gitignore", async () => {
		// First init
		await initCommand({ _spawner: noopSpawner });

		const gitignorePath = join(tempDir, ".overstory", ".gitignore");

		// Tamper with the gitignore file
		await Bun.write(gitignorePath, "# custom content\n");

		// Verify tamper worked
		const tampered = await Bun.file(gitignorePath).text();
		expect(tampered).toBe("# custom content\n");

		// Second init without --force should return early (not overwrite)
		await initCommand({ _spawner: noopSpawner });

		// Verify the file was NOT overwritten (early return prevented it)
		const afterSecondInit = await Bun.file(gitignorePath).text();
		expect(afterSecondInit).toBe("# custom content\n");
	});
});

describe("initCommand: .overstory/README.md", () => {
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

	test("creates .overstory/README.md with expected content", async () => {
		await initCommand({ _spawner: noopSpawner });

		const readmePath = join(tempDir, ".overstory", "README.md");
		const exists = await Bun.file(readmePath).exists();
		expect(exists).toBe(true);

		const content = await Bun.file(readmePath).text();
		expect(content).toBe(OVERSTORY_README);
	});

	test("README.md is whitelisted in gitignore", () => {
		expect(OVERSTORY_GITIGNORE).toContain("!README.md\n");
	});

	test("--force reinit overwrites README.md", async () => {
		// First init
		await initCommand({ _spawner: noopSpawner });

		const readmePath = join(tempDir, ".overstory", "README.md");

		// Tamper with the README
		await Bun.write(readmePath, "# tampered\n");
		const tampered = await Bun.file(readmePath).text();
		expect(tampered).toBe("# tampered\n");

		// Reinit with --force
		await initCommand({ force: true, _spawner: noopSpawner });

		// Verify restored to canonical content
		const restored = await Bun.file(readmePath).text();
		expect(restored).toBe(OVERSTORY_README);
	});

	test("subsequent init without --force does not overwrite README.md", async () => {
		// First init
		await initCommand({ _spawner: noopSpawner });

		const readmePath = join(tempDir, ".overstory", "README.md");

		// Tamper with the README
		await Bun.write(readmePath, "# custom content\n");
		const tampered = await Bun.file(readmePath).text();
		expect(tampered).toBe("# custom content\n");

		// Second init without --force returns early
		await initCommand({ _spawner: noopSpawner });

		// Verify tampered content preserved (early return)
		const afterSecondInit = await Bun.file(readmePath).text();
		expect(afterSecondInit).toBe("# custom content\n");
	});
});

describe("initCommand: canonical branch detection", () => {
	let tempDir: string;
	let originalCwd: string;
	let originalWrite: typeof process.stdout.write;

	beforeEach(async () => {
		tempDir = await createTempGitRepo();
		originalCwd = process.cwd();
		// Remove origin remote so detectCanonicalBranch falls through to
		// current-branch check (otherwise remote HEAD resolves to main regardless)
		await runGitInDir(tempDir, ["remote", "remove", "origin"]);
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

	test("non-standard branch names are accepted as canonicalBranch", async () => {
		// Switch to a non-standard branch name
		await runGitInDir(tempDir, ["switch", "-c", "trunk"]);

		await initCommand({ _spawner: noopSpawner });

		const configPath = join(tempDir, ".overstory", "config.yaml");
		const content = await Bun.file(configPath).text();
		expect(content).toContain("canonicalBranch: trunk");
	});

	test("standard branch names (main) still work as canonicalBranch", async () => {
		// createTempGitRepo defaults to main branch
		await initCommand({ _spawner: noopSpawner });

		const configPath = join(tempDir, ".overstory", "config.yaml");
		const content = await Bun.file(configPath).text();
		expect(content).toContain("canonicalBranch: main");
	});
});

describe("initCommand: --yes flag", () => {
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

	test("--yes reinitializes when .overstory/ already exists", async () => {
		// First init
		await initCommand({ _spawner: noopSpawner });

		// Tamper with config to verify reinit happens
		const configPath = join(tempDir, ".overstory", "config.yaml");
		await Bun.write(configPath, "# tampered\n");

		// Second init with --yes should reinitialize (not return early)
		await initCommand({ yes: true, _spawner: noopSpawner });

		// Verify config was regenerated (not the tampered content)
		const content = await Bun.file(configPath).text();
		expect(content).not.toBe("# tampered\n");
		expect(content).toContain("# Overstory configuration");
	});

	test("--yes works on fresh project (no .overstory/ yet)", async () => {
		await initCommand({ yes: true, _spawner: noopSpawner });

		const configPath = join(tempDir, ".overstory", "config.yaml");
		const exists = await Bun.file(configPath).exists();
		expect(exists).toBe(true);

		const content = await Bun.file(configPath).text();
		expect(content).toContain("# Overstory configuration");
	});

	test("--yes overwrites agent-defs on reinit", async () => {
		// First init
		await initCommand({ _spawner: noopSpawner });

		// Tamper with an agent def
		const scoutPath = join(tempDir, ".overstory", "agent-defs", "scout.md");
		await Bun.write(scoutPath, "TAMPERED CONTENT");

		// Reinit with --yes should overwrite
		await initCommand({ yes: true, _spawner: noopSpawner });

		const restored = await Bun.file(scoutPath).text();
		expect(restored).not.toBe("TAMPERED CONTENT");
	});
});

describe("initCommand: --name flag", () => {
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

	test("--name overrides auto-detected project name", async () => {
		await initCommand({ name: "custom-project", _spawner: noopSpawner });

		const configPath = join(tempDir, ".overstory", "config.yaml");
		const content = await Bun.file(configPath).text();
		expect(content).toContain("name: custom-project");
	});

	test("--name combined with --yes works for fully non-interactive init", async () => {
		await initCommand({ yes: true, name: "scripted-project", _spawner: noopSpawner });

		const configPath = join(tempDir, ".overstory", "config.yaml");
		const content = await Bun.file(configPath).text();
		expect(content).toContain("name: scripted-project");
		expect(content).toContain("# Overstory configuration");
	});
});

// ---- Ecosystem Bootstrap Tests ----

/**
 * Build a Spawner that returns preset responses keyed by "arg0 arg1 ..." prefix.
 * Records all calls for assertion.
 */
function createMockSpawner(
	responses: Record<string, { exitCode: number; stdout: string; stderr: string }>,
): {
	spawner: Spawner;
	calls: string[][];
} {
	const calls: string[][] = [];
	const spawner: Spawner = async (args) => {
		calls.push(args);
		const key = args.join(" ");
		// Longest prefix match
		let bestMatch = "";
		let bestResponse = { exitCode: 1, stdout: "", stderr: "not found" };
		for (const [pattern, response] of Object.entries(responses)) {
			if (key.startsWith(pattern) && pattern.length > bestMatch.length) {
				bestMatch = pattern;
				bestResponse = response;
			}
		}
		return bestResponse;
	};
	return { spawner, calls };
}

describe("resolveToolSet", () => {
	test("default (no opts) returns all three tools in order", () => {
		const tools = resolveToolSet({});
		expect(tools.map((t) => t.name)).toEqual(["mulch", "seeds", "canopy"]);
	});

	test("--skip-mulch removes mulch", () => {
		const tools = resolveToolSet({ skipMulch: true });
		expect(tools.map((t) => t.name)).toEqual(["seeds", "canopy"]);
	});

	test("--skip-seeds removes seeds", () => {
		const tools = resolveToolSet({ skipSeeds: true });
		expect(tools.map((t) => t.name)).toEqual(["mulch", "canopy"]);
	});

	test("--skip-canopy removes canopy", () => {
		const tools = resolveToolSet({ skipCanopy: true });
		expect(tools.map((t) => t.name)).toEqual(["mulch", "seeds"]);
	});

	test("multiple skip flags combine", () => {
		const tools = resolveToolSet({ skipMulch: true, skipSeeds: true });
		expect(tools.map((t) => t.name)).toEqual(["canopy"]);
	});

	test("--tools overrides to specific tools", () => {
		const tools = resolveToolSet({ tools: "mulch,seeds" });
		expect(tools.map((t) => t.name)).toEqual(["mulch", "seeds"]);
	});

	test("--tools single tool", () => {
		const tools = resolveToolSet({ tools: "canopy" });
		expect(tools.map((t) => t.name)).toEqual(["canopy"]);
	});

	test("--tools with unknown name filters it out", () => {
		const tools = resolveToolSet({ tools: "mulch,unknown" });
		expect(tools.map((t) => t.name)).toEqual(["mulch"]);
	});

	test("--tools overrides skip flags", () => {
		// --tools takes precedence over --skip-* flags
		const tools = resolveToolSet({ tools: "mulch", skipMulch: true });
		expect(tools.map((t) => t.name)).toEqual(["mulch"]);
	});

	test("all skip flags returns empty array", () => {
		const tools = resolveToolSet({ skipMulch: true, skipSeeds: true, skipCanopy: true });
		expect(tools).toHaveLength(0);
	});
});

describe("initCommand: ecosystem bootstrap", () => {
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

	test("all tools installed and init succeeds → status initialized", async () => {
		const { spawner, calls } = createMockSpawner({
			"ml --version": { exitCode: 0, stdout: "0.6.3", stderr: "" },
			"ml init": { exitCode: 0, stdout: "initialized", stderr: "" },
			"ml onboard": { exitCode: 0, stdout: "appended", stderr: "" },
			"sd --version": { exitCode: 0, stdout: "0.2.4", stderr: "" },
			"sd init": { exitCode: 0, stdout: "initialized", stderr: "" },
			"sd onboard": { exitCode: 0, stdout: "appended", stderr: "" },
			"cn --version": { exitCode: 0, stdout: "0.2.0", stderr: "" },
			"cn init": { exitCode: 0, stdout: "initialized", stderr: "" },
			"cn onboard": { exitCode: 0, stdout: "appended", stderr: "" },
		});

		await initCommand({ _spawner: spawner });

		// All three init commands were called
		expect(calls).toContainEqual(["ml", "init"]);
		expect(calls).toContainEqual(["sd", "init"]);
		expect(calls).toContainEqual(["cn", "init"]);

		// All three onboard commands were called
		expect(calls).toContainEqual(["ml", "onboard"]);
		expect(calls).toContainEqual(["sd", "onboard"]);
		expect(calls).toContainEqual(["cn", "onboard"]);
	});

	test("tool not installed → init and onboard not called", async () => {
		const { spawner, calls } = createMockSpawner({
			"ml --version": { exitCode: 1, stdout: "", stderr: "command not found" },
			"sd --version": { exitCode: 0, stdout: "0.2.4", stderr: "" },
			"sd init": { exitCode: 0, stdout: "initialized", stderr: "" },
			"sd onboard": { exitCode: 0, stdout: "appended", stderr: "" },
			"cn --version": { exitCode: 0, stdout: "0.2.0", stderr: "" },
			"cn init": { exitCode: 0, stdout: "initialized", stderr: "" },
			"cn onboard": { exitCode: 0, stdout: "appended", stderr: "" },
		});

		await initCommand({ _spawner: spawner });

		// mulch init should NOT have been called
		expect(calls).not.toContainEqual(["ml", "init"]);
		// seeds and canopy should still be called
		expect(calls).toContainEqual(["sd", "init"]);
		expect(calls).toContainEqual(["cn", "init"]);
	});

	test("tool init non-zero + dir exists → already_initialized", async () => {
		// Create .mulch/ directory to simulate existing mulch init
		const { mkdir } = await import("node:fs/promises");
		await mkdir(join(tempDir, ".mulch"), { recursive: true });

		const { spawner } = createMockSpawner({
			"ml --version": { exitCode: 0, stdout: "0.6.3", stderr: "" },
			"ml init": { exitCode: 1, stdout: "", stderr: "already initialized" },
			"ml onboard": { exitCode: 0, stdout: "appended", stderr: "" },
			"sd --version": { exitCode: 0, stdout: "0.2.4", stderr: "" },
			"sd init": { exitCode: 0, stdout: "initialized", stderr: "" },
			"sd onboard": { exitCode: 0, stdout: "appended", stderr: "" },
			"cn --version": { exitCode: 0, stdout: "0.2.0", stderr: "" },
			"cn init": { exitCode: 0, stdout: "initialized", stderr: "" },
			"cn onboard": { exitCode: 0, stdout: "appended", stderr: "" },
		});

		// Should not throw — already_initialized is not an error
		await initCommand({ _spawner: spawner });
	});

	test("--skip-onboard skips onboard calls", async () => {
		const { spawner, calls } = createMockSpawner({
			"ml --version": { exitCode: 0, stdout: "0.6.3", stderr: "" },
			"ml init": { exitCode: 0, stdout: "initialized", stderr: "" },
			"sd --version": { exitCode: 0, stdout: "0.2.4", stderr: "" },
			"sd init": { exitCode: 0, stdout: "initialized", stderr: "" },
			"cn --version": { exitCode: 0, stdout: "0.2.0", stderr: "" },
			"cn init": { exitCode: 0, stdout: "initialized", stderr: "" },
		});

		await initCommand({ skipOnboard: true, _spawner: spawner });

		expect(calls).not.toContainEqual(["ml", "onboard"]);
		expect(calls).not.toContainEqual(["sd", "onboard"]);
		expect(calls).not.toContainEqual(["cn", "onboard"]);
	});

	test("--skip-mulch skips mulch entirely", async () => {
		const { spawner, calls } = createMockSpawner({
			"sd --version": { exitCode: 0, stdout: "0.2.4", stderr: "" },
			"sd init": { exitCode: 0, stdout: "initialized", stderr: "" },
			"sd onboard": { exitCode: 0, stdout: "appended", stderr: "" },
			"cn --version": { exitCode: 0, stdout: "0.2.0", stderr: "" },
			"cn init": { exitCode: 0, stdout: "initialized", stderr: "" },
			"cn onboard": { exitCode: 0, stdout: "appended", stderr: "" },
		});

		await initCommand({ skipMulch: true, _spawner: spawner });

		expect(calls.filter((c) => c[0] === "ml")).toHaveLength(0);
	});

	test("--json outputs JSON envelope with tools and onboard status", async () => {
		const { spawner } = createMockSpawner({
			"ml --version": { exitCode: 0, stdout: "0.6.3", stderr: "" },
			"ml init": { exitCode: 0, stdout: "initialized", stderr: "" },
			"ml onboard": { exitCode: 0, stdout: "appended", stderr: "" },
			"sd --version": { exitCode: 0, stdout: "0.2.4", stderr: "" },
			"sd init": { exitCode: 0, stdout: "initialized", stderr: "" },
			"sd onboard": { exitCode: 0, stdout: "appended", stderr: "" },
			"cn --version": { exitCode: 0, stdout: "0.2.0", stderr: "" },
			"cn init": { exitCode: 0, stdout: "initialized", stderr: "" },
			"cn onboard": { exitCode: 0, stdout: "appended", stderr: "" },
		});

		let capturedOutput = "";
		const restoreWrite = process.stdout.write;
		process.stdout.write = ((chunk: unknown) => {
			capturedOutput += String(chunk);
			return true;
		}) as typeof process.stdout.write;

		await initCommand({ json: true, _spawner: spawner });

		process.stdout.write = restoreWrite;

		// Find the JSON line (last line with JSON content)
		const jsonLine = capturedOutput.split("\n").find((line) => line.startsWith('{"success":'));

		expect(jsonLine).toBeDefined();
		const parsed = JSON.parse(jsonLine ?? "{}") as Record<string, unknown>;
		expect(parsed.success).toBe(true);
		expect(parsed.command).toBe("init");
		expect(parsed.tools).toBeDefined();
		expect(parsed.onboard).toBeDefined();
		expect(typeof parsed.gitattributes).toBe("boolean");

		const tools = parsed.tools as Record<string, { status: string }>;
		expect(tools.overstory?.status).toBe("initialized");
		expect(tools.mulch?.status).toBe("initialized");
		expect(tools.seeds?.status).toBe("initialized");
		expect(tools.canopy?.status).toBe("initialized");
	});
});

describe("initCommand: .gitattributes setup", () => {
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

	test("creates .gitattributes with merge=union entries", async () => {
		// Use a spawner that skips all ecosystem tools so only gitattributes step runs
		const { spawner } = createMockSpawner({});
		await initCommand({ skipMulch: true, skipSeeds: true, skipCanopy: true, _spawner: spawner });

		const gitattrsPath = join(tempDir, ".gitattributes");
		const exists = await Bun.file(gitattrsPath).exists();
		expect(exists).toBe(true);

		const content = await Bun.file(gitattrsPath).text();
		expect(content).toContain(".mulch/expertise/*.jsonl merge=union");
		expect(content).toContain(".seeds/issues.jsonl merge=union");
	});

	test("does not duplicate entries on reinit with --force", async () => {
		const { spawner } = createMockSpawner({});

		// First init
		await initCommand({ skipMulch: true, skipSeeds: true, skipCanopy: true, _spawner: spawner });

		// Second init with --force
		await initCommand({
			force: true,
			skipMulch: true,
			skipSeeds: true,
			skipCanopy: true,
			_spawner: spawner,
		});

		const gitattrsPath = join(tempDir, ".gitattributes");
		const content = await Bun.file(gitattrsPath).text();

		// Count occurrences — should be exactly one each
		const mulchCount = (content.match(/\.mulch\/expertise\/\*\.jsonl merge=union/g) ?? []).length;
		const seedsCount = (content.match(/\.seeds\/issues\.jsonl merge=union/g) ?? []).length;
		expect(mulchCount).toBe(1);
		expect(seedsCount).toBe(1);
	});

	test("preserves existing .gitattributes content", async () => {
		// Pre-create .gitattributes with existing content
		const existingContent = "*.lock binary\n*.png binary\n";
		await Bun.write(join(tempDir, ".gitattributes"), existingContent);

		const { spawner } = createMockSpawner({});
		await initCommand({ skipMulch: true, skipSeeds: true, skipCanopy: true, _spawner: spawner });

		const content = await Bun.file(join(tempDir, ".gitattributes")).text();
		expect(content).toContain("*.lock binary");
		expect(content).toContain("*.png binary");
		expect(content).toContain(".mulch/expertise/*.jsonl merge=union");
		expect(content).toContain(".seeds/issues.jsonl merge=union");
	});

	test("no-op when entries already present", async () => {
		// Pre-create .gitattributes with the entries already
		const existingContent =
			".mulch/expertise/*.jsonl merge=union\n.seeds/issues.jsonl merge=union\n";
		await Bun.write(join(tempDir, ".gitattributes"), existingContent);

		const { spawner } = createMockSpawner({});
		await initCommand({ skipMulch: true, skipSeeds: true, skipCanopy: true, _spawner: spawner });

		const content = await Bun.file(join(tempDir, ".gitattributes")).text();
		// Content should be unchanged
		expect(content).toBe(existingContent);
	});
});

// ---- detectDefaultRuntime Tests ----

describe("detectDefaultRuntime", () => {
	test("returns 'claude' when claude is installed (highest priority)", async () => {
		const { spawner } = createMockSpawner({
			"which claude": { exitCode: 0, stdout: "/usr/local/bin/claude", stderr: "" },
			"which copilot": { exitCode: 0, stdout: "/usr/local/bin/copilot", stderr: "" },
		});
		const result = await detectDefaultRuntime(spawner);
		expect(result).toBe("claude");
	});

	test("returns 'copilot' when only copilot is installed", async () => {
		const { spawner } = createMockSpawner({
			"which claude": { exitCode: 1, stdout: "", stderr: "" },
			"which copilot": { exitCode: 0, stdout: "/usr/local/bin/copilot", stderr: "" },
		});
		const result = await detectDefaultRuntime(spawner);
		expect(result).toBe("copilot");
	});

	test("returns 'gemini' when only gemini is installed", async () => {
		const { spawner } = createMockSpawner({
			"which claude": { exitCode: 1, stdout: "", stderr: "" },
			"which copilot": { exitCode: 1, stdout: "", stderr: "" },
			"which gemini": { exitCode: 0, stdout: "/usr/local/bin/gemini", stderr: "" },
		});
		const result = await detectDefaultRuntime(spawner);
		expect(result).toBe("gemini");
	});

	test("returns 'opencode' when only opencode is installed", async () => {
		const { spawner } = createMockSpawner({
			"which claude": { exitCode: 1, stdout: "", stderr: "" },
			"which copilot": { exitCode: 1, stdout: "", stderr: "" },
			"which gemini": { exitCode: 1, stdout: "", stderr: "" },
			"which opencode": { exitCode: 0, stdout: "/usr/local/bin/opencode", stderr: "" },
		});
		const result = await detectDefaultRuntime(spawner);
		expect(result).toBe("opencode");
	});

	test("returns 'sapling' when only sp is installed", async () => {
		const { spawner } = createMockSpawner({
			"which claude": { exitCode: 1, stdout: "", stderr: "" },
			"which copilot": { exitCode: 1, stdout: "", stderr: "" },
			"which gemini": { exitCode: 1, stdout: "", stderr: "" },
			"which opencode": { exitCode: 1, stdout: "", stderr: "" },
			"which sp": { exitCode: 0, stdout: "/usr/local/bin/sp", stderr: "" },
		});
		const result = await detectDefaultRuntime(spawner);
		expect(result).toBe("sapling");
	});

	test("returns 'pi' when only pi is installed", async () => {
		const { spawner } = createMockSpawner({
			"which claude": { exitCode: 1, stdout: "", stderr: "" },
			"which copilot": { exitCode: 1, stdout: "", stderr: "" },
			"which gemini": { exitCode: 1, stdout: "", stderr: "" },
			"which opencode": { exitCode: 1, stdout: "", stderr: "" },
			"which sp": { exitCode: 1, stdout: "", stderr: "" },
			"which pi": { exitCode: 0, stdout: "/usr/local/bin/pi", stderr: "" },
		});
		const result = await detectDefaultRuntime(spawner);
		expect(result).toBe("pi");
	});

	test("returns 'claude' as fallback when no runtimes are installed", async () => {
		const spawner: Spawner = async () => ({ exitCode: 1, stdout: "", stderr: "not found" });
		const result = await detectDefaultRuntime(spawner);
		expect(result).toBe("claude");
	});

	test("uses which checks, not version flags", async () => {
		const calls: string[][] = [];
		const spawner: Spawner = async (args) => {
			calls.push(args);
			return { exitCode: 1, stdout: "", stderr: "not found" };
		};
		await detectDefaultRuntime(spawner);
		// All calls should be 'which <cli>'
		expect(calls.every((c) => c[0] === "which")).toBe(true);
		expect(calls.length).toBeGreaterThan(0);
	});
});

describe("initCommand: runtime detection integration", () => {
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

	test("config.yaml runtime.default is set to detected runtime", async () => {
		const { spawner } = createMockSpawner({
			"which claude": { exitCode: 1, stdout: "", stderr: "" },
			"which copilot": { exitCode: 0, stdout: "/usr/bin/copilot", stderr: "" },
		});

		await initCommand({ _spawner: spawner });

		const configPath = join(tempDir, ".overstory", "config.yaml");
		const content = await Bun.file(configPath).text();
		expect(content).toContain("default: copilot");
	});

	test("config.yaml runtime.default falls back to claude when nothing detected", async () => {
		const { spawner } = createMockSpawner({});

		await initCommand({ _spawner: spawner });

		const configPath = join(tempDir, ".overstory", "config.yaml");
		const content = await Bun.file(configPath).text();
		expect(content).toContain("default: claude");
	});
});

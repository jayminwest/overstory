import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentError } from "../errors.ts";
import { cleanupTempDir } from "../test-helpers.ts";
import type { OverlayConfig, QualityGate } from "../types.ts";
import {
	formatQualityGatesBash,
	formatQualityGatesCapabilities,
	formatQualityGatesInline,
	formatQualityGatesSteps,
	formatSiblings,
	generateOverlay,
	isCanonicalRoot,
	writeOverlay,
} from "./overlay.ts";

const SAMPLE_BASE_DEFINITION = `# Builder Agent

You are a **builder agent** in the overstory swarm system.

## Role
Implement changes according to a spec.

## Propulsion Principle
Read your assignment. Execute immediately.

## Failure Modes
- FILE_SCOPE_VIOLATION
- SILENT_FAILURE
`;

/** Build a complete OverlayConfig with sensible defaults, overrideable by partial. */
function makeConfig(overrides?: Partial<OverlayConfig>): OverlayConfig {
	return {
		agentName: "test-builder",
		taskId: "overstory-abc",
		specPath: ".overstory/specs/overstory-abc.md",
		branchName: "agent/test-builder/overstory-abc",
		worktreePath: "/tmp/test-project/.overstory/worktrees/test-builder",
		fileScope: ["src/agents/manifest.ts", "src/agents/overlay.ts"],
		mulchDomains: ["typescript", "testing"],
		parentAgent: "lead-alpha",
		depth: 1,
		canSpawn: false,
		capability: "builder",
		baseDefinition: SAMPLE_BASE_DEFINITION,
		...overrides,
	};
}

describe("generateOverlay", () => {
	test("output contains agent name", async () => {
		const config = makeConfig({ agentName: "my-scout" });
		const output = await generateOverlay(config);

		expect(output).toContain("my-scout");
	});

	test("output contains task ID", async () => {
		const config = makeConfig({ taskId: "overstory-xyz" });
		const output = await generateOverlay(config);

		expect(output).toContain("overstory-xyz");
	});

	test("output contains branch name", async () => {
		const config = makeConfig({ branchName: "agent/scout/overstory-xyz" });
		const output = await generateOverlay(config);

		expect(output).toContain("agent/scout/overstory-xyz");
	});

	test("output contains parent agent name", async () => {
		const config = makeConfig({ parentAgent: "lead-bravo" });
		const output = await generateOverlay(config);

		expect(output).toContain("lead-bravo");
	});

	test("output contains depth", async () => {
		const config = makeConfig({ depth: 2 });
		const output = await generateOverlay(config);

		expect(output).toContain("2");
	});

	test("output contains spec path when provided", async () => {
		const config = makeConfig({ specPath: ".overstory/specs/my-task.md" });
		const output = await generateOverlay(config);

		expect(output).toContain(".overstory/specs/my-task.md");
	});

	test("shows fallback text when specPath is null", async () => {
		const config = makeConfig({ specPath: null });
		const output = await generateOverlay(config);

		expect(output).toContain("No spec file provided");
		expect(output).not.toContain("{{SPEC_PATH}}");
	});

	test("includes 'Read your task spec' instruction when spec provided", async () => {
		const config = makeConfig({ specPath: ".overstory/specs/my-task.md" });
		const output = await generateOverlay(config);

		expect(output).toContain("Read your task spec at the path above");
	});

	test("does not include 'Read your task spec' instruction when specPath is null", async () => {
		const config = makeConfig({ specPath: null });
		const output = await generateOverlay(config);

		expect(output).not.toContain("Read your task spec at the path above");
		expect(output).toContain("No task spec was provided");
	});

	test("shows 'coordinator' when parentAgent is null", async () => {
		const config = makeConfig({ parentAgent: null });
		const output = await generateOverlay(config);

		expect(output).toContain("coordinator");
	});

	test("file scope is formatted as markdown bullets", async () => {
		const config = makeConfig({
			fileScope: ["src/foo.ts", "src/bar.ts"],
		});
		const output = await generateOverlay(config);

		expect(output).toContain("- `src/foo.ts`");
		expect(output).toContain("- `src/bar.ts`");
	});

	test("empty file scope shows fallback text", async () => {
		const config = makeConfig({ fileScope: [] });
		const output = await generateOverlay(config);

		expect(output).toContain("No file scope restrictions");
	});

	test("mulch domains formatted as prime command", async () => {
		const config = makeConfig({ mulchDomains: ["typescript", "testing"] });
		const output = await generateOverlay(config);

		expect(output).toContain("ml prime typescript testing");
	});

	test("empty mulch domains shows fallback text", async () => {
		const config = makeConfig({ mulchDomains: [] });
		const output = await generateOverlay(config);

		expect(output).toContain("No specific expertise domains configured");
	});

	test("canSpawn false says 'You may NOT spawn sub-workers'", async () => {
		const config = makeConfig({ canSpawn: false });
		const output = await generateOverlay(config);

		expect(output).toContain("You may NOT spawn sub-workers");
	});

	test("canSpawn true includes sling example", async () => {
		const config = makeConfig({
			canSpawn: true,
			agentName: "lead-alpha",
			depth: 1,
		});
		const output = await generateOverlay(config);

		expect(output).toContain("ov sling");
		expect(output).toContain("--parent lead-alpha");
		expect(output).toContain("--depth 2");
	});

	test("no unreplaced placeholders remain in output", async () => {
		const config = makeConfig();
		const output = await generateOverlay(config);

		expect(output).not.toContain("{{");
		expect(output).not.toContain("}}");
	});

	test("includes pre-loaded expertise when mulchExpertise is provided", async () => {
		const config = makeConfig({
			mulchExpertise: "## architecture\n- Pattern: use singleton for config loader",
		});
		const output = await generateOverlay(config);

		expect(output).toContain("### Pre-loaded Expertise");
		expect(output).toContain("automatically loaded at spawn time");
		expect(output).toContain("## architecture");
		expect(output).toContain("Pattern: use singleton for config loader");
	});

	test("omits expertise section when mulchExpertise is undefined", async () => {
		const config = makeConfig({ mulchExpertise: undefined });
		const output = await generateOverlay(config);

		expect(output).not.toContain("### Pre-loaded Expertise");
		expect(output).not.toContain("automatically loaded at spawn time");
	});

	test("omits expertise section when mulchExpertise is empty string", async () => {
		const config = makeConfig({ mulchExpertise: "" });
		const output = await generateOverlay(config);

		expect(output).not.toContain("### Pre-loaded Expertise");
	});

	test("omits expertise section when mulchExpertise is whitespace only", async () => {
		const config = makeConfig({ mulchExpertise: "   \n\t  \n  " });
		const output = await generateOverlay(config);

		expect(output).not.toContain("### Pre-loaded Expertise");
	});

	test("builder capability includes full quality gates section", async () => {
		const config = makeConfig({ capability: "builder" });
		const output = await generateOverlay(config);

		expect(output).toContain("Quality Gates");
		expect(output).toContain("bun test");
		expect(output).toContain("bun run lint");
		expect(output).toContain("Commit");
	});

	test("lead capability includes full quality gates section", async () => {
		const config = makeConfig({ capability: "lead" });
		const output = await generateOverlay(config);

		expect(output).toContain("Quality Gates");
		expect(output).toContain("bun test");
		expect(output).toContain("bun run lint");
	});

	test("merger capability includes full quality gates section", async () => {
		const config = makeConfig({ capability: "merger" });
		const output = await generateOverlay(config);

		expect(output).toContain("Quality Gates");
		expect(output).toContain("bun test");
	});

	test("scout capability gets read-only completion section instead of quality gates", async () => {
		const config = makeConfig({ capability: "scout", agentName: "my-scout" });
		const output = await generateOverlay(config);

		expect(output).toContain("Completion");
		expect(output).toContain("read-only agent");
		expect(output).toContain("Do NOT commit");
		expect(output).not.toContain("Quality Gates");
		expect(output).not.toContain("bun test");
		expect(output).not.toContain("bun run lint");
	});

	test("reviewer capability gets read-only completion section instead of quality gates", async () => {
		const config = makeConfig({ capability: "reviewer", agentName: "my-reviewer" });
		const output = await generateOverlay(config);

		expect(output).toContain("Completion");
		expect(output).toContain("read-only agent");
		expect(output).toContain("Do NOT commit");
		expect(output).not.toContain("Quality Gates");
		expect(output).not.toContain("bun test");
		expect(output).not.toContain("bun run lint");
	});

	test("scout completion section includes sd close and mail send", async () => {
		const config = makeConfig({
			capability: "scout",
			agentName: "recon-1",
			taskId: "overstory-task1",
			parentAgent: "lead-alpha",
		});
		const output = await generateOverlay(config);

		expect(output).toContain("sd close overstory-task1");
		expect(output).toContain("ov mail send --to lead-alpha");
	});

	test("reviewer completion section uses coordinator when no parent", async () => {
		const config = makeConfig({
			capability: "reviewer",
			parentAgent: null,
		});
		const output = await generateOverlay(config);

		expect(output).toContain("--to coordinator");
	});

	test("output includes communication section with agent address", async () => {
		const config = makeConfig({ agentName: "worker-42" });
		const output = await generateOverlay(config);

		expect(output).toContain("ov mail check --agent worker-42");
		expect(output).toContain("ov mail send --to");
	});

	test("output includes base agent definition content (Layer 1)", async () => {
		const config = makeConfig();
		const output = await generateOverlay(config);

		expect(output).toContain("# Builder Agent");
		expect(output).toContain("Propulsion Principle");
		expect(output).toContain("FILE_SCOPE_VIOLATION");
	});

	test("base definition appears before task assignment section", async () => {
		const config = makeConfig();
		const output = await generateOverlay(config);

		const baseDefIndex = output.indexOf("# Builder Agent");
		const assignmentIndex = output.indexOf("## Your Assignment");
		expect(baseDefIndex).toBeGreaterThan(-1);
		expect(assignmentIndex).toBeGreaterThan(-1);
		expect(baseDefIndex).toBeLessThan(assignmentIndex);
	});

	test("output contains worktree path in assignment section", async () => {
		const config = makeConfig({
			worktreePath: "/project/.overstory/worktrees/my-builder",
		});
		const output = await generateOverlay(config);

		expect(output).toContain("/project/.overstory/worktrees/my-builder");
		expect(output).toContain("**Worktree:**");
	});

	test("output contains Working Directory section with worktree path", async () => {
		const config = makeConfig({
			worktreePath: "/tmp/worktrees/builder-1",
		});
		const output = await generateOverlay(config);

		expect(output).toContain("## Working Directory");
		expect(output).toContain("Your worktree root is: `/tmp/worktrees/builder-1`");
		expect(output).toContain("PATH_BOUNDARY_VIOLATION");
	});

	test("file scope section references worktree root", async () => {
		const config = makeConfig({
			worktreePath: "/tmp/worktrees/builder-scope",
		});
		const output = await generateOverlay(config);

		expect(output).toContain(
			"These paths are relative to your worktree root: `/tmp/worktrees/builder-scope`",
		);
	});

	test("builder constraints include worktree isolation", async () => {
		const config = makeConfig({
			capability: "builder",
			worktreePath: "/tmp/worktrees/builder-constraints",
		});
		const output = await generateOverlay(config);

		expect(output).toContain("WORKTREE ISOLATION");
		expect(output).toContain("/tmp/worktrees/builder-constraints");
		expect(output).toContain("NEVER write to the canonical repo root");
	});

	test("no unreplaced WORKTREE_PATH placeholders", async () => {
		const config = makeConfig();
		const output = await generateOverlay(config);

		expect(output).not.toContain("{{WORKTREE_PATH}}");
	});

	test("builder with custom qualityGates uses them instead of defaults", async () => {
		const gates: QualityGate[] = [
			{ name: "Test", command: "pytest", description: "all tests pass" },
			{ name: "Lint", command: "ruff check .", description: "no lint errors" },
		];
		const config = makeConfig({ capability: "builder", qualityGates: gates });
		const output = await generateOverlay(config);

		expect(output).toContain("pytest");
		expect(output).toContain("ruff check .");
		expect(output).not.toContain("bun test");
		expect(output).not.toContain("bun run lint");
		expect(output).not.toContain("bun run typecheck");
	});

	test("builder with undefined qualityGates falls back to defaults", async () => {
		const config = makeConfig({ capability: "builder", qualityGates: undefined });
		const output = await generateOverlay(config);

		expect(output).toContain("bun test");
		expect(output).toContain("bun run lint");
		expect(output).toContain("bun run typecheck");
	});

	test("builder with empty qualityGates array falls back to defaults", async () => {
		const config = makeConfig({ capability: "builder", qualityGates: [] });
		const output = await generateOverlay(config);

		expect(output).toContain("bun test");
		expect(output).toContain("bun run lint");
		expect(output).toContain("bun run typecheck");
	});

	test("custom qualityGates are numbered correctly", async () => {
		const gates: QualityGate[] = [
			{ name: "Build", command: "cargo build", description: "compilation succeeds" },
			{ name: "Test", command: "cargo test", description: "all tests pass" },
		];
		const config = makeConfig({ capability: "builder", qualityGates: gates });
		const output = await generateOverlay(config);

		expect(output).toContain("1. **Build:**");
		expect(output).toContain("2. **Test:**");
		// Commit should be item 3
		expect(output).toContain("3. **Commit:**");
	});

	test("scout capability ignores qualityGates (stays read-only)", async () => {
		const gates: QualityGate[] = [
			{ name: "Test", command: "pytest", description: "all tests pass" },
		];
		const config = makeConfig({ capability: "scout", qualityGates: gates });
		const output = await generateOverlay(config);

		expect(output).toContain("read-only agent");
		expect(output).not.toContain("pytest");
		expect(output).not.toContain("Quality Gates");
	});

	test("default trackerCli renders as sd in quality gates", async () => {
		const config = makeConfig({ capability: "builder", taskId: "overstory-task1" });
		const output = await generateOverlay(config);

		expect(output).toContain("sd close overstory-task1");
	});

	test("custom trackerCli replaces sd in quality gates", async () => {
		const config = makeConfig({
			capability: "builder",
			trackerCli: "sd",
			taskId: "overstory-test1",
		});
		const output = await generateOverlay(config);

		expect(output).toContain("sd close overstory-test1");
		expect(output).not.toContain("bd close");
	});

	test("custom trackerCli replaces bd in constraints", async () => {
		const config = makeConfig({
			capability: "builder",
			trackerCli: "sd",
		});
		const output = await generateOverlay(config);

		expect(output).toContain("`sd close`");
	});

	test("custom trackerCli replaces bd in read-only completion section", async () => {
		const config = makeConfig({
			capability: "scout",
			trackerCli: "sd",
			taskId: "overstory-test2",
		});
		const output = await generateOverlay(config);

		expect(output).toContain("sd close overstory-test2");
		expect(output).not.toContain("bd close");
	});

	test("TRACKER_CLI in base definition is replaced", async () => {
		const config = makeConfig({
			trackerCli: "sd",
			baseDefinition: "Run `{{TRACKER_CLI}} show` to check status.",
		});
		const output = await generateOverlay(config);

		expect(output).toContain("Run `sd show` to check status.");
		expect(output).not.toContain("{{TRACKER_CLI}}");
	});

	test("TRACKER_NAME in base definition is replaced", async () => {
		const config = makeConfig({
			trackerName: "seeds",
			baseDefinition: "Close your {{TRACKER_NAME}} issue when done.",
		});
		const output = await generateOverlay(config);

		expect(output).toContain("Close your seeds issue when done.");
		expect(output).not.toContain("{{TRACKER_NAME}}");
	});

	test("defaults: no trackerCli/trackerName produces sd/seeds", async () => {
		const config = makeConfig({ capability: "builder", taskId: "overstory-back" });
		const output = await generateOverlay(config);

		expect(output).toContain("sd close overstory-back");
	});

	test("dispatch overrides: skipReview injects SKIP REVIEW directive for leads", async () => {
		const config = makeConfig({
			capability: "lead",
			skipReview: true,
			canSpawn: true,
		});
		const output = await generateOverlay(config);

		expect(output).toContain("Dispatch Overrides");
		expect(output).toContain("SKIP REVIEW");
		expect(output).toContain("Self-verify");
	});

	test("dispatch overrides: maxAgentsOverride injects MAX AGENTS directive for leads", async () => {
		const config = makeConfig({
			capability: "lead",
			maxAgentsOverride: 3,
			canSpawn: true,
		});
		const output = await generateOverlay(config);

		expect(output).toContain("Dispatch Overrides");
		expect(output).toContain("MAX AGENTS");
		expect(output).toContain("3");
	});

	test("dispatch overrides: maxAgentsOverride of 1 directs the lead to spend the slot on a single builder", async () => {
		const config = makeConfig({
			capability: "lead",
			maxAgentsOverride: 1,
			canSpawn: true,
		});
		const output = await generateOverlay(config);

		expect(output).toContain("MAX AGENTS");
		expect(output).toContain("single builder");
		expect(output).toContain("Leads cannot implement directly");
	});

	test("dispatch overrides: maxAgentsOverride of 2 enables compressed-mode guidance", async () => {
		const config = makeConfig({
			capability: "lead",
			maxAgentsOverride: 2,
			canSpawn: true,
		});
		const output = await generateOverlay(config);

		expect(output).toContain("MAX AGENTS");
		expect(output).toContain("compressed mode");
		expect(output).toContain("Leads do not implement");
	});

	test("dispatch overrides: both skipReview and maxAgentsOverride together", async () => {
		const config = makeConfig({
			capability: "lead",
			skipReview: true,
			maxAgentsOverride: 4,
			canSpawn: true,
		});
		const output = await generateOverlay(config);

		expect(output).toContain("SKIP REVIEW");
		expect(output).toContain("MAX AGENTS");
		expect(output).toContain("4");
	});

	test("dispatch overrides: not injected for builder capability", async () => {
		const config = makeConfig({
			capability: "builder",
			skipReview: true,
			maxAgentsOverride: 3,
		});
		const output = await generateOverlay(config);

		expect(output).not.toContain("Dispatch Overrides");
	});

	test("dispatch overrides: not injected when no overrides set", async () => {
		const config = makeConfig({
			capability: "lead",
			canSpawn: true,
		});
		const output = await generateOverlay(config);

		expect(output).not.toContain("Dispatch Overrides");
	});

	test("dispatch overrides: maxAgentsOverride of 0 is not injected", async () => {
		const config = makeConfig({
			capability: "lead",
			maxAgentsOverride: 0,
			canSpawn: true,
		});
		const output = await generateOverlay(config);

		expect(output).not.toContain("MAX AGENTS");
	});

	test("no unreplaced DISPATCH_OVERRIDES placeholder", async () => {
		const config = makeConfig();
		const output = await generateOverlay(config);

		expect(output).not.toContain("{{DISPATCH_OVERRIDES}}");
	});
});

describe("writeOverlay", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "overstory-overlay-test-"));
	});

	afterEach(async () => {
		await cleanupTempDir(tempDir);
	});

	test("creates .claude/CLAUDE.md in worktree directory", async () => {
		const worktreePath = join(tempDir, "worktree");
		const config = makeConfig();

		await writeOverlay(worktreePath, config, "/nonexistent-canonical-root");

		const outputPath = join(worktreePath, ".claude", "CLAUDE.md");
		const file = Bun.file(outputPath);
		const exists = await file.exists();
		expect(exists).toBe(true);
	});

	test("written file contains the overlay content", async () => {
		const worktreePath = join(tempDir, "worktree");
		const config = makeConfig({ agentName: "file-writer-test" });

		await writeOverlay(worktreePath, config, "/nonexistent-canonical-root");

		const outputPath = join(worktreePath, ".claude", "CLAUDE.md");
		const content = await Bun.file(outputPath).text();
		expect(content).toContain("file-writer-test");
		expect(content).toContain(config.taskId);
		expect(content).toContain(config.branchName);
	});

	test("creates .claude directory even if worktree already exists", async () => {
		const worktreePath = join(tempDir, "existing-worktree");
		const { mkdir } = await import("node:fs/promises");
		await mkdir(worktreePath, { recursive: true });

		const config = makeConfig();
		await writeOverlay(worktreePath, config, "/nonexistent-canonical-root");

		const outputPath = join(worktreePath, ".claude", "CLAUDE.md");
		const exists = await Bun.file(outputPath).exists();
		expect(exists).toBe(true);
	});

	test("overwrites existing CLAUDE.md if it already exists", async () => {
		const worktreePath = join(tempDir, "worktree");
		const claudeDir = join(worktreePath, ".claude");
		const { mkdir } = await import("node:fs/promises");
		await mkdir(claudeDir, { recursive: true });
		await Bun.write(join(claudeDir, "CLAUDE.md"), "old content");

		const config = makeConfig({ agentName: "new-agent" });
		await writeOverlay(worktreePath, config, "/nonexistent-canonical-root");

		const content = await Bun.file(join(claudeDir, "CLAUDE.md")).text();
		expect(content).toContain("new-agent");
		expect(content).not.toContain("old content");
	});

	test("writeOverlay content matches generateOverlay output", async () => {
		const worktreePath = join(tempDir, "worktree");
		const config = makeConfig();

		const generated = await generateOverlay(config);
		await writeOverlay(worktreePath, config, "/nonexistent-canonical-root");

		const written = await Bun.file(join(worktreePath, ".claude", "CLAUDE.md")).text();
		expect(written).toBe(generated);
	});

	test("throws AgentError when worktreePath is the canonical project root", async () => {
		const fakeProjectRoot = join(tempDir, "project-root");
		await mkdir(fakeProjectRoot, { recursive: true });

		const config = makeConfig({ agentName: "rogue-agent" });

		expect(async () => {
			await writeOverlay(fakeProjectRoot, config, fakeProjectRoot);
		}).toThrow(AgentError);
	});

	test("error message mentions canonical project root when guard triggers", async () => {
		const fakeProjectRoot = join(tempDir, "project-root-msg");
		await mkdir(fakeProjectRoot, { recursive: true });

		const config = makeConfig({ agentName: "rogue-agent" });

		try {
			await writeOverlay(fakeProjectRoot, config, fakeProjectRoot);
			expect.unreachable("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(AgentError);
			const agentErr = err as AgentError;
			expect(agentErr.message).toContain("canonical project root");
			expect(agentErr.message).toContain(fakeProjectRoot);
			expect(agentErr.agentName).toBe("rogue-agent");
		}
	});

	test("does NOT throw when worktreePath is a proper worktree subdirectory", async () => {
		const fakeProjectRoot = join(tempDir, "project-with-worktrees");
		await mkdir(join(fakeProjectRoot, ".overstory", "worktrees", "my-agent"), { recursive: true });

		const worktreePath = join(fakeProjectRoot, ".overstory", "worktrees", "my-agent");
		const config = makeConfig();

		// This should succeed — the worktree is not the canonical root
		await writeOverlay(worktreePath, config, fakeProjectRoot);

		const outputPath = join(worktreePath, ".claude", "CLAUDE.md");
		const exists = await Bun.file(outputPath).exists();
		expect(exists).toBe(true);
	});

	test("does not write CLAUDE.md when guard rejects the path", async () => {
		const fakeProjectRoot = join(tempDir, "project-no-write");
		await mkdir(fakeProjectRoot, { recursive: true });

		const config = makeConfig();

		try {
			await writeOverlay(fakeProjectRoot, config, fakeProjectRoot);
		} catch {
			// Expected
		}

		// Verify CLAUDE.md was NOT written
		const claudeMdPath = join(fakeProjectRoot, ".claude", "CLAUDE.md");
		const exists = await Bun.file(claudeMdPath).exists();
		expect(exists).toBe(false);
	});

	test("succeeds for worktree with .overstory/config.yaml (dogfooding scenario)", async () => {
		// When dogfooding on overstory's own repo, .overstory/config.yaml is tracked
		// in git. Every worktree checkout includes it. The old file-existence heuristic
		// would incorrectly reject these worktrees. The path-comparison guard must allow
		// writes because the worktree path differs from the canonical root (overstory-p4st).
		const fakeProjectRoot = join(tempDir, "overstory-dogfood");
		const worktreePath = join(fakeProjectRoot, ".overstory", "worktrees", "dogfood-agent");
		await mkdir(join(worktreePath, ".overstory"), { recursive: true });
		// Simulate tracked .overstory/config.yaml appearing in the worktree checkout
		await Bun.write(
			join(worktreePath, ".overstory", "config.yaml"),
			"project:\n  name: overstory\n",
		);

		const config = makeConfig({ agentName: "dogfood-agent" });

		// Must succeed — worktreePath !== fakeProjectRoot even though config.yaml exists
		await writeOverlay(worktreePath, config, fakeProjectRoot);

		const outputPath = join(worktreePath, ".claude", "CLAUDE.md");
		const exists = await Bun.file(outputPath).exists();
		expect(exists).toBe(true);
	});

	test("writes to custom instruction path when provided", async () => {
		const worktreePath = join(tempDir, "worktree");
		const config = makeConfig();
		await writeOverlay(worktreePath, config, "/nonexistent-canonical-root", "AGENTS.md");
		const outputPath = join(worktreePath, "AGENTS.md");
		expect(await Bun.file(outputPath).exists()).toBe(true);
		expect(await Bun.file(join(worktreePath, ".claude", "CLAUDE.md")).exists()).toBe(false);
	});

	test("custom instruction path creates necessary subdirectories", async () => {
		const worktreePath = join(tempDir, "worktree");
		const config = makeConfig();
		await writeOverlay(
			worktreePath,
			config,
			"/nonexistent-canonical-root",
			".pi/instructions/AGENT.md",
		);
		expect(await Bun.file(join(worktreePath, ".pi", "instructions", "AGENT.md")).exists()).toBe(
			true,
		);
	});
});

describe("isCanonicalRoot", () => {
	test("returns true when dir matches canonicalRoot", () => {
		expect(isCanonicalRoot("/projects/my-app", "/projects/my-app")).toBe(true);
	});

	test("returns true when paths resolve to the same location", () => {
		expect(isCanonicalRoot("/projects/my-app/./", "/projects/my-app")).toBe(true);
	});

	test("returns false when dir differs from canonicalRoot", () => {
		expect(
			isCanonicalRoot("/projects/my-app/.overstory/worktrees/agent-1", "/projects/my-app"),
		).toBe(false);
	});

	test("returns false for worktree even when it contains .overstory/config.yaml (dogfooding)", () => {
		// This is the core dogfooding scenario: the worktree has .overstory/config.yaml
		// because it's tracked in git, but the path is different from the canonical root.
		const canonicalRoot = "/projects/overstory";
		const worktreePath = "/projects/overstory/.overstory/worktrees/dogfood-agent";
		expect(isCanonicalRoot(worktreePath, canonicalRoot)).toBe(false);
	});
});

describe("formatQualityGatesInline", () => {
	test("formats default gates as inline backtick list", () => {
		const result = formatQualityGatesInline(undefined);
		expect(result).toBe("`bun test`, `bun run lint`, `bun run typecheck`");
	});

	test("formats custom gates as inline backtick list", () => {
		const gates: QualityGate[] = [
			{ name: "Test", command: "pytest", description: "all tests pass" },
			{ name: "Lint", command: "ruff check .", description: "no lint errors" },
		];
		const result = formatQualityGatesInline(gates);
		expect(result).toBe("`pytest`, `ruff check .`");
	});

	test("falls back to defaults for empty array", () => {
		const result = formatQualityGatesInline([]);
		expect(result).toContain("`bun test`");
	});
});

describe("formatQualityGatesSteps", () => {
	test("formats default gates as numbered steps", () => {
		const result = formatQualityGatesSteps(undefined);
		expect(result).toContain("1. Run `bun test`");
		expect(result).toContain("2. Run `bun run lint`");
		expect(result).toContain("3. Run `bun run typecheck`");
	});

	test("formats custom gates as numbered steps", () => {
		const gates: QualityGate[] = [
			{ name: "Build", command: "cargo build", description: "compilation succeeds" },
			{ name: "Test", command: "cargo test", description: "all tests pass" },
		];
		const result = formatQualityGatesSteps(gates);
		expect(result).toBe(
			"1. Run `cargo build` -- compilation succeeds.\n2. Run `cargo test` -- all tests pass.",
		);
	});
});

describe("formatQualityGatesBash", () => {
	test("formats as fenced bash block with aligned comments", () => {
		const result = formatQualityGatesBash(undefined);
		expect(result).toContain("```bash");
		expect(result).toContain("bun test");
		expect(result).toContain("bun run lint");
		expect(result).toContain("bun run typecheck");
		expect(result).toContain("```");
	});

	test("capitalizes first letter of description in comments", () => {
		const gates: QualityGate[] = [
			{ name: "Test", command: "pytest", description: "all tests pass" },
		];
		const result = formatQualityGatesBash(gates);
		expect(result).toContain("# All tests pass");
	});

	test("custom gates produce correct bash block", () => {
		const gates: QualityGate[] = [
			{ name: "Test", command: "npm test", description: "tests pass" },
			{ name: "Lint", command: "npm run lint", description: "lint clean" },
		];
		const result = formatQualityGatesBash(gates);
		expect(result).toContain("npm test");
		expect(result).toContain("npm run lint");
		expect(result).not.toContain("bun");
	});
});

describe("formatQualityGatesCapabilities", () => {
	test("formats as indented bullet list", () => {
		const result = formatQualityGatesCapabilities(undefined);
		expect(result).toContain("  - `bun test`");
		expect(result).toContain("  - `bun run lint`");
		expect(result).toContain("  - `bun run typecheck`");
	});

	test("custom gates produce correct capability bullets", () => {
		const gates: QualityGate[] = [
			{ name: "Test", command: "pytest", description: "run tests" },
			{ name: "Type", command: "mypy .", description: "type check" },
		];
		const result = formatQualityGatesCapabilities(gates);
		expect(result).toBe("  - `pytest` (run tests)\n  - `mypy .` (type check)");
	});
});

describe("INSTRUCTION_PATH placeholder", () => {
	test("defaults to .claude/CLAUDE.md when instructionPath is not set", async () => {
		const config = makeConfig({
			baseDefinition: "Read your overlay at {{INSTRUCTION_PATH}} in your worktree.",
		});
		const output = await generateOverlay(config);

		expect(output).toContain("Read your overlay at .claude/CLAUDE.md in your worktree.");
		expect(output).not.toContain("{{INSTRUCTION_PATH}}");
	});

	test("uses custom instructionPath when set", async () => {
		const config = makeConfig({
			instructionPath: "SAPLING.md",
			baseDefinition: "Read your overlay at {{INSTRUCTION_PATH}} in your worktree.",
		});
		const output = await generateOverlay(config);

		expect(output).toContain("Read your overlay at SAPLING.md in your worktree.");
		expect(output).not.toContain("{{INSTRUCTION_PATH}}");
		expect(output).not.toContain(".claude/CLAUDE.md");
	});

	test("INSTRUCTION_PATH in base definition replaced throughout (multiple occurrences)", async () => {
		const config = makeConfig({
			instructionPath: "AGENTS.md",
			baseDefinition: "Step 1: read {{INSTRUCTION_PATH}}.\nContext is in {{INSTRUCTION_PATH}}.",
		});
		const output = await generateOverlay(config);

		expect(output).not.toContain("{{INSTRUCTION_PATH}}");
		expect(output.split("AGENTS.md").length - 1).toBeGreaterThanOrEqual(2);
	});

	test("no unreplaced INSTRUCTION_PATH placeholders in final output", async () => {
		const config = makeConfig({ instructionPath: "SAPLING.md" });
		const output = await generateOverlay(config);

		expect(output).not.toContain("{{INSTRUCTION_PATH}}");
	});
});

describe("quality gate placeholders in base definitions", () => {
	test("QUALITY_GATE_INLINE in base definition gets replaced", async () => {
		const config = makeConfig({
			baseDefinition: "Run {{QUALITY_GATE_INLINE}} before closing.",
		});
		const output = await generateOverlay(config);
		expect(output).toContain("`bun test`, `bun run lint`, `bun run typecheck`");
		expect(output).not.toContain("{{QUALITY_GATE_INLINE}}");
	});

	test("QUALITY_GATE_STEPS in base definition gets replaced", async () => {
		const config = makeConfig({
			baseDefinition: "## Steps\n{{QUALITY_GATE_STEPS}}",
		});
		const output = await generateOverlay(config);
		expect(output).toContain("1. Run `bun test`");
		expect(output).not.toContain("{{QUALITY_GATE_STEPS}}");
	});

	test("QUALITY_GATE_BASH in base definition gets replaced", async () => {
		const config = makeConfig({
			baseDefinition: "## Workflow\n{{QUALITY_GATE_BASH}}",
		});
		const output = await generateOverlay(config);
		expect(output).toContain("```bash");
		expect(output).toContain("bun test");
		expect(output).not.toContain("{{QUALITY_GATE_BASH}}");
	});

	test("QUALITY_GATE_CAPABILITIES in base definition gets replaced", async () => {
		const config = makeConfig({
			baseDefinition: "## Caps\n{{QUALITY_GATE_CAPABILITIES}}",
		});
		const output = await generateOverlay(config);
		expect(output).toContain("  - `bun test`");
		expect(output).not.toContain("{{QUALITY_GATE_CAPABILITIES}}");
	});

	test("custom quality gates in base definition get custom commands", async () => {
		const gates: QualityGate[] = [
			{ name: "Test", command: "pytest", description: "all tests pass" },
			{ name: "Lint", command: "ruff check .", description: "no lint errors" },
		];
		const config = makeConfig({
			capability: "builder",
			qualityGates: gates,
			baseDefinition:
				"Run {{QUALITY_GATE_INLINE}} before closing.\n{{QUALITY_GATE_BASH}}\n{{QUALITY_GATE_STEPS}}",
		});
		const output = await generateOverlay(config);
		expect(output).toContain("`pytest`, `ruff check .`");
		expect(output).toContain("pytest");
		expect(output).toContain("ruff check .");
		expect(output).not.toContain("bun test");
		expect(output).not.toContain("{{QUALITY_GATE");
	});
});

describe("formatSiblings (overstory-f76a)", () => {
	test("empty siblings array → empty string", () => {
		const config = makeConfig({ siblings: [] });
		expect(formatSiblings(config)).toBe("");
	});

	test("missing siblings field → empty string", () => {
		const config = makeConfig();
		expect(formatSiblings(config)).toBe("");
	});

	test("one sibling → markdown with the name and rebase guidance", () => {
		const config = makeConfig({ siblings: ["sibling-a"] });
		const out = formatSiblings(config);
		expect(out).toContain("## Parallel Siblings");
		expect(out).toContain("- sibling-a");
		expect(out).toContain("git fetch origin main:main");
		expect(out).toContain("git rebase main");
		expect(out).toContain("merge_ready");
	});

	test("multiple siblings render every name as a bullet", () => {
		const config = makeConfig({ siblings: ["sibling-a", "sibling-b", "sibling-c"] });
		const out = formatSiblings(config);
		expect(out).toContain("- sibling-a");
		expect(out).toContain("- sibling-b");
		expect(out).toContain("- sibling-c");
	});
});

describe("generateOverlay siblings wiring (overstory-f76a)", () => {
	test("siblings field renders Parallel Siblings section in overlay", async () => {
		const config = makeConfig({ siblings: ["sibling-a", "sibling-b"] });
		const output = await generateOverlay(config);
		expect(output).toContain("## Parallel Siblings");
		expect(output).toContain("- sibling-a");
		expect(output).toContain("- sibling-b");
		expect(output).toContain("git rebase main");
		expect(output).not.toContain("{{SIBLINGS}}");
	});

	test("no siblings → overlay omits Parallel Siblings section", async () => {
		const config = makeConfig();
		const output = await generateOverlay(config);
		expect(output).not.toContain("## Parallel Siblings");
		expect(output).not.toContain("{{SIBLINGS}}");
	});

	test("empty siblings array → overlay omits Parallel Siblings section", async () => {
		const config = makeConfig({ siblings: [] });
		const output = await generateOverlay(config);
		expect(output).not.toContain("## Parallel Siblings");
	});
});

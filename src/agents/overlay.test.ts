import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OverlayConfig } from "../types.ts";
import { generateOverlay, writeOverlay } from "./overlay.ts";

/** Build a complete OverlayConfig with sensible defaults, overrideable by partial. */
function makeConfig(overrides?: Partial<OverlayConfig>): OverlayConfig {
	return {
		agentName: "test-builder",
		beadId: "overstory-abc",
		specPath: ".overstory/specs/overstory-abc.md",
		branchName: "agent/test-builder/overstory-abc",
		fileScope: ["src/agents/manifest.ts", "src/agents/overlay.ts"],
		mulchDomains: ["typescript", "testing"],
		parentAgent: "lead-alpha",
		depth: 1,
		canSpawn: false,
		capability: "builder",
		...overrides,
	};
}

describe("generateOverlay", () => {
	test("output contains agent name", async () => {
		const config = makeConfig({ agentName: "my-scout" });
		const output = await generateOverlay(config);

		expect(output).toContain("my-scout");
	});

	test("output contains bead ID", async () => {
		const config = makeConfig({ beadId: "overstory-xyz" });
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

	test("shows 'orchestrator' when parentAgent is null", async () => {
		const config = makeConfig({ parentAgent: null });
		const output = await generateOverlay(config);

		expect(output).toContain("orchestrator");
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

		expect(output).toContain("mulch prime typescript testing");
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

		expect(output).toContain("overstory sling");
		expect(output).toContain("--parent lead-alpha");
		expect(output).toContain("--depth 2");
	});

	test("no unreplaced placeholders remain in output", async () => {
		const config = makeConfig();
		const output = await generateOverlay(config);

		expect(output).not.toContain("{{");
		expect(output).not.toContain("}}");
	});

	test("builder capability includes full quality gates section", async () => {
		const config = makeConfig({ capability: "builder" });
		const output = await generateOverlay(config);

		expect(output).toContain("Quality Gates");
		expect(output).toContain("bun test");
		expect(output).toContain("biome check");
		expect(output).toContain("Commit");
	});

	test("lead capability includes full quality gates section", async () => {
		const config = makeConfig({ capability: "lead" });
		const output = await generateOverlay(config);

		expect(output).toContain("Quality Gates");
		expect(output).toContain("bun test");
		expect(output).toContain("biome check");
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
		expect(output).not.toContain("biome check");
	});

	test("reviewer capability gets read-only completion section instead of quality gates", async () => {
		const config = makeConfig({ capability: "reviewer", agentName: "my-reviewer" });
		const output = await generateOverlay(config);

		expect(output).toContain("Completion");
		expect(output).toContain("read-only agent");
		expect(output).toContain("Do NOT commit");
		expect(output).not.toContain("Quality Gates");
		expect(output).not.toContain("bun test");
		expect(output).not.toContain("biome check");
	});

	test("scout completion section includes bd close and mail send", async () => {
		const config = makeConfig({
			capability: "scout",
			agentName: "recon-1",
			beadId: "overstory-task1",
			parentAgent: "lead-alpha",
		});
		const output = await generateOverlay(config);

		expect(output).toContain("bd close overstory-task1");
		expect(output).toContain("overstory mail send --to lead-alpha");
	});

	test("reviewer completion section uses orchestrator when no parent", async () => {
		const config = makeConfig({
			capability: "reviewer",
			parentAgent: null,
		});
		const output = await generateOverlay(config);

		expect(output).toContain("--to orchestrator");
	});

	test("output includes communication section with agent address", async () => {
		const config = makeConfig({ agentName: "worker-42" });
		const output = await generateOverlay(config);

		expect(output).toContain("overstory mail check --agent worker-42");
		expect(output).toContain("overstory mail send --to");
	});
});

describe("writeOverlay", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "overstory-overlay-test-"));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	test("creates .claude/CLAUDE.md in worktree directory", async () => {
		const worktreePath = join(tempDir, "worktree");
		const config = makeConfig();

		await writeOverlay(worktreePath, config);

		const outputPath = join(worktreePath, ".claude", "CLAUDE.md");
		const file = Bun.file(outputPath);
		const exists = await file.exists();
		expect(exists).toBe(true);
	});

	test("written file contains the overlay content", async () => {
		const worktreePath = join(tempDir, "worktree");
		const config = makeConfig({ agentName: "file-writer-test" });

		await writeOverlay(worktreePath, config);

		const outputPath = join(worktreePath, ".claude", "CLAUDE.md");
		const content = await Bun.file(outputPath).text();
		expect(content).toContain("file-writer-test");
		expect(content).toContain(config.beadId);
		expect(content).toContain(config.branchName);
	});

	test("creates .claude directory even if worktree already exists", async () => {
		const worktreePath = join(tempDir, "existing-worktree");
		const { mkdir } = await import("node:fs/promises");
		await mkdir(worktreePath, { recursive: true });

		const config = makeConfig();
		await writeOverlay(worktreePath, config);

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
		await writeOverlay(worktreePath, config);

		const content = await Bun.file(join(claudeDir, "CLAUDE.md")).text();
		expect(content).toContain("new-agent");
		expect(content).not.toContain("old content");
	});

	test("writeOverlay content matches generateOverlay output", async () => {
		const worktreePath = join(tempDir, "worktree");
		const config = makeConfig();

		const generated = await generateOverlay(config);
		await writeOverlay(worktreePath, config);

		const written = await Bun.file(join(worktreePath, ".claude", "CLAUDE.md")).text();
		expect(written).toBe(generated);
	});
});

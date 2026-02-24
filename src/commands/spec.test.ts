/**
 * Tests for the `overstory spec` command.
 *
 * Uses real filesystem (temp dirs) for all tests. No mocks.
 * Philosophy: "never mock what you can use for real" (mx-252b16).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { cleanupTempDir, createTempGitRepo } from "../test-helpers.ts";
import { generateSpecTemplate, specCommand, writeSpec } from "./spec.ts";

let tempDir: string;
let overstoryDir: string;
let originalCwd: string;
let stdoutOutput: string;
let _stderrOutput: string;
let originalStdoutWrite: typeof process.stdout.write;
let originalStderrWrite: typeof process.stderr.write;

beforeEach(async () => {
	tempDir = await createTempGitRepo();
	overstoryDir = join(tempDir, ".overstory");
	await mkdir(overstoryDir, { recursive: true });

	// Write minimal config.yaml so resolveProjectRoot works
	await Bun.write(
		join(overstoryDir, "config.yaml"),
		`project:\n  name: test-project\n  root: ${tempDir}\n  canonicalBranch: main\n`,
	);

	originalCwd = process.cwd();
	process.chdir(tempDir);

	// Capture stdout/stderr
	stdoutOutput = "";
	_stderrOutput = "";
	originalStdoutWrite = process.stdout.write;
	originalStderrWrite = process.stderr.write;
	process.stdout.write = ((chunk: string) => {
		stdoutOutput += chunk;
		return true;
	}) as typeof process.stdout.write;
	process.stderr.write = ((chunk: string) => {
		_stderrOutput += chunk;
		return true;
	}) as typeof process.stderr.write;
});

afterEach(async () => {
	process.chdir(originalCwd);
	process.stdout.write = originalStdoutWrite;
	process.stderr.write = originalStderrWrite;
	await cleanupTempDir(tempDir);
});

// === help ===

describe("help", () => {
	test("--help shows usage", async () => {
		await specCommand(["--help"]);
		expect(stdoutOutput).toContain("overstory spec");
		expect(stdoutOutput).toContain("write");
		expect(stdoutOutput).toContain("--body");
		expect(stdoutOutput).toContain("--agent");
	});

	test("-h shows usage", async () => {
		await specCommand(["-h"]);
		expect(stdoutOutput).toContain("overstory spec");
	});

	test("no args shows help", async () => {
		await specCommand([]);
		expect(stdoutOutput).toContain("overstory spec");
	});
});

// === validation ===

describe("validation", () => {
	test("unknown subcommand throws ValidationError", async () => {
		await expect(specCommand(["unknown"])).rejects.toThrow("Unknown spec subcommand");
	});

	test("write without bead-id throws ValidationError", async () => {
		await expect(specCommand(["write"])).rejects.toThrow("Bead ID is required");
	});

	test("write without body throws ValidationError", async () => {
		await expect(specCommand(["write", "task-abc", "--agent", "scout-1"])).rejects.toThrow(
			"Spec body is required",
		);
	});

	test("write with empty body throws ValidationError", async () => {
		await expect(specCommand(["write", "task-abc", "--body", "  "])).rejects.toThrow(
			"Spec body is required",
		);
	});
});

// === writeSpec (core function) ===

describe("writeSpec", () => {
	test("writes spec file to .overstory/specs/<bead-id>.md", async () => {
		const specPath = await writeSpec(tempDir, "task-abc", "# My Spec\n\nDetails here.");

		expect(specPath).toBe(join(tempDir, ".overstory", "specs", "task-abc.md"));

		const content = await Bun.file(specPath).text();
		expect(content).toBe("# My Spec\n\nDetails here.\n");
	});

	test("creates specs directory if it does not exist", async () => {
		// Verify specs dir does not exist yet
		const specsDir = join(overstoryDir, "specs");
		expect(await Bun.file(join(specsDir, ".gitkeep")).exists()).toBe(false);

		await writeSpec(tempDir, "task-xyz", "content");

		const content = await Bun.file(join(specsDir, "task-xyz.md")).text();
		expect(content).toBe("content\n");
	});

	test("adds attribution header when agent is provided", async () => {
		const specPath = await writeSpec(tempDir, "task-123", "# Spec body", "scout-1");

		const content = await Bun.file(specPath).text();
		expect(content).toContain("<!-- written-by: scout-1 -->");
		expect(content).toContain("# Spec body");
	});

	test("does not add attribution header when agent is omitted", async () => {
		const specPath = await writeSpec(tempDir, "task-456", "# Spec body");

		const content = await Bun.file(specPath).text();
		expect(content).not.toContain("written-by");
		expect(content).toBe("# Spec body\n");
	});

	test("ensures trailing newline", async () => {
		const specPath = await writeSpec(tempDir, "task-nl", "no newline at end");

		const content = await Bun.file(specPath).text();
		expect(content.endsWith("\n")).toBe(true);
	});

	test("does not double trailing newline", async () => {
		const specPath = await writeSpec(tempDir, "task-nl2", "already has newline\n");

		const content = await Bun.file(specPath).text();
		expect(content).toBe("already has newline\n");
		expect(content.endsWith("\n\n")).toBe(false);
	});

	test("overwrites existing spec file", async () => {
		await writeSpec(tempDir, "task-ow", "version 1");
		await writeSpec(tempDir, "task-ow", "version 2");

		const specPath = join(overstoryDir, "specs", "task-ow.md");
		const content = await Bun.file(specPath).text();
		expect(content).toBe("version 2\n");
	});
});

// === specCommand (CLI integration) ===

describe("specCommand write", () => {
	test("writes spec and prints path", async () => {
		await specCommand(["write", "task-cmd", "--body", "# CLI Spec"]);

		// Path may differ due to macOS /var -> /private/var symlink resolution
		expect(stdoutOutput.trim()).toContain(".overstory/specs/task-cmd.md");

		const specPath = stdoutOutput.trim();
		const content = await Bun.file(specPath).text();
		expect(content).toBe("# CLI Spec\n");
	});

	test("writes spec with agent attribution", async () => {
		await specCommand(["write", "task-attr", "--body", "# Attributed", "--agent", "scout-2"]);

		expect(stdoutOutput.trim()).toContain(".overstory/specs/task-attr.md");

		const specPath = stdoutOutput.trim();
		const content = await Bun.file(specPath).text();
		expect(content).toContain("<!-- written-by: scout-2 -->");
		expect(content).toContain("# Attributed");
	});

	test("flags can appear in any order", async () => {
		await specCommand(["write", "--agent", "scout-3", "--body", "# Content", "task-order"]);

		expect(stdoutOutput.trim()).toContain(".overstory/specs/task-order.md");

		const specPath = stdoutOutput.trim();
		const content = await Bun.file(specPath).text();
		expect(content).toContain("<!-- written-by: scout-3 -->");
		expect(content).toContain("# Content");
	});
});

// === generateSpecTemplate ===

describe("generateSpecTemplate", () => {
	test("generates scaffold with all 14+4 sections", () => {
		const template = generateSpecTemplate("task-tmpl");
		expect(template).toContain("# task-tmpl");
		expect(template).toContain("## Why");
		expect(template).toContain("## Design Principles");
		expect(template).toContain("## On-Disk Format");
		expect(template).toContain("## Data Model");
		expect(template).toContain("## CLI");
		expect(template).toContain("## JSON Output Format");
		expect(template).toContain("## Concurrency Model");
		expect(template).toContain("## Migration");
		expect(template).toContain("## Integration");
		expect(template).toContain("## What It Does NOT Do");
		expect(template).toContain("## Tech Stack");
		expect(template).toContain("## Project Infrastructure");
		expect(template).toContain("## Estimated Size");
		expect(template).toContain("## Agent Assignments");
		expect(template).toContain("## Execution Order");
		expect(template).toContain("## Failure Modes");
		expect(template).toContain("## Success Criteria");
	});

	test("includes TODO placeholders", () => {
		const template = generateSpecTemplate("task-tmpl");
		expect(template).toContain("<!-- TODO: fill in this section -->");
	});

	test("includes body content under title when provided", () => {
		const template = generateSpecTemplate("task-ctx", "This is context for the task");
		expect(template).toContain("# task-ctx");
		expect(template).toContain("This is context for the task");
		// Body should appear before the first section heading
		const bodyIdx = template.indexOf("This is context");
		const whyIdx = template.indexOf("## Why");
		expect(bodyIdx).toBeLessThan(whyIdx);
	});

	test("omits body section when not provided", () => {
		const template = generateSpecTemplate("task-nobody");
		// Title line followed by empty line then first section
		const lines = template.split("\n");
		expect(lines[0]).toBe("# task-nobody");
		expect(lines[1]).toBe("");
		expect(lines[2]).toBe("## Why");
	});
});

// === specCommand write --template ===

describe("specCommand write --template", () => {
	test("--template generates scaffold without --body", async () => {
		await specCommand(["write", "task-scaffold", "--template"]);

		expect(stdoutOutput.trim()).toContain(".overstory/specs/task-scaffold.md");

		const specPath = stdoutOutput.trim();
		const content = await Bun.file(specPath).text();
		expect(content).toContain("# task-scaffold");
		expect(content).toContain("## Why");
		expect(content).toContain("## Success Criteria");
		expect(content).toContain("<!-- TODO: fill in this section -->");
	});

	test("--template with --body includes body as context", async () => {
		await specCommand([
			"write",
			"task-ctx",
			"--template",
			"--body",
			"Migrate auth from sessions to JWT",
		]);

		const specPath = stdoutOutput.trim();
		const content = await Bun.file(specPath).text();
		expect(content).toContain("# task-ctx");
		expect(content).toContain("Migrate auth from sessions to JWT");
		expect(content).toContain("## Why");
	});

	test("--template with --agent adds attribution", async () => {
		await specCommand(["write", "task-tmpl-agent", "--template", "--agent", "scout-5"]);

		const specPath = stdoutOutput.trim();
		const content = await Bun.file(specPath).text();
		expect(content).toContain("<!-- written-by: scout-5 -->");
		expect(content).toContain("## Why");
	});
});

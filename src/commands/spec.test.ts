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
import { specWriteCommand, writeSpec } from "./spec.ts";

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

// === validation ===

describe("validation", () => {
	test("write without task-id throws ValidationError", async () => {
		await expect(specWriteCommand("", {})).rejects.toThrow("Task ID is required");
	});

	test("write without body throws ValidationError", async () => {
		await expect(specWriteCommand("task-abc", { agent: "scout-1" })).rejects.toThrow(
			"Spec body is required",
		);
	});

	test("write with empty body throws ValidationError", async () => {
		await expect(specWriteCommand("task-abc", { body: "  " })).rejects.toThrow(
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

	test("writes Trellis spec artifacts for co-creation workflow", async () => {
		const specPath = await writeSpec(tempDir, "task-open", "# OpenSpec body", "scout-1", {
			workflow: "co-creation",
		});

		expect(specPath).toBe(join(tempDir, ".trellis", "specs", "task-open.yaml"));
		const content = await Bun.file(specPath).text();
		expect(content).toContain("# written-by: scout-1");
		expect(content).toContain("id: task-open");
		expect(content).toContain("title: OpenSpec body");
		expect(content).toContain("objective: |");
		expect(content).toContain("  # OpenSpec body");
	});

	test("writes richer Trellis metadata when provided", async () => {
		const specPath = await writeSpec(tempDir, "task-rich", "Document the dogfood flow", "scout-1", {
			workflow: "co-creation",
			title: "Dogfood Trellis flow",
			seed: "agent-context-0002",
			reference: ["README.md", "docs/README.md"],
			constraint: ["Keep docs authoritative"],
			acceptance: ["Agents can find the canon index"],
		});

		expect(specPath).toBe(join(tempDir, ".trellis", "specs", "task-rich.yaml"));
		const content = await Bun.file(specPath).text();
		expect(content).toContain("title: Dogfood Trellis flow");
		expect(content).toContain("seed: agent-context-0002");
		expect(content).toContain("objective: |");
		expect(content).toContain("  Document the dogfood flow");
		expect(content).toContain("  - Keep docs authoritative");
		expect(content).toContain("  - Agents can find the canon index");
		expect(content).toContain("  - README.md");
		expect(content).toContain("  - docs/README.md");
	});

	test("derives a shortened Trellis title instead of copying the full body", async () => {
		const body =
			"Create and maintain a stable canon/doctrine index for docs/, separating core canon from supporting context and making the authoritative navigation path obvious to operators and agents.";

		const specPath = await writeSpec(tempDir, "task-short", body, undefined, {
			workflow: "co-creation",
		});

		const content = await Bun.file(specPath).text();
		expect(specPath).toBe(join(tempDir, ".trellis", "specs", "task-short.yaml"));
		expect(content).toContain(
			"title: Create and maintain a stable canon/doctrine index for docs/, separating…",
		);
		expect(content).toContain("objective: |");
		expect(content).toContain(`  ${body}`);
	});

	test("can force Trellis output without workflow alias", async () => {
		const specPath = await writeSpec(tempDir, "task-force", "# Forced", undefined, {
			trellis: true,
		});

		expect(specPath).toBe(join(tempDir, ".trellis", "specs", "task-force.yaml"));
	});

	test("refuses to overwrite an existing Trellis spec by default", async () => {
		await writeSpec(tempDir, "task-safe", "version 1", undefined, {
			workflow: "co-creation",
		});

		await expect(
			writeSpec(tempDir, "task-safe", "version 2", undefined, {
				workflow: "co-creation",
			}),
		).rejects.toThrow("Trellis spec already exists");

		const content = await Bun.file(join(tempDir, ".trellis", "specs", "task-safe.yaml")).text();
		expect(content).toContain("  version 1");
		expect(content).not.toContain("  version 2");
	});

	test("allows replacing an existing Trellis spec with --force", async () => {
		await writeSpec(tempDir, "task-force-replace", "version 1", undefined, {
			workflow: "co-creation",
		});

		await writeSpec(tempDir, "task-force-replace", "version 2", undefined, {
			workflow: "co-creation",
			force: true,
		});

		const content = await Bun.file(
			join(tempDir, ".trellis", "specs", "task-force-replace.yaml"),
		).text();
		expect(content).toContain("  version 2");
		expect(content).not.toContain("  version 1");
	});
});

// === specWriteCommand (CLI integration) ===

describe("specWriteCommand (integration)", () => {
	test("writes spec and prints success", async () => {
		await specWriteCommand("task-cmd", { body: "# CLI Spec" });

		expect(stdoutOutput).toContain("Spec written");
		expect(stdoutOutput).toContain("task-cmd");

		const specPath = join(tempDir, ".overstory", "specs", "task-cmd.md");
		const content = await Bun.file(specPath).text();
		expect(content).toBe("# CLI Spec\n");
	});

	test("writes spec with agent attribution", async () => {
		await specWriteCommand("task-attr", { body: "# Attributed", agent: "scout-2" });

		expect(stdoutOutput).toContain("Spec written");
		expect(stdoutOutput).toContain("task-attr");

		const specPath = join(tempDir, ".overstory", "specs", "task-attr.md");
		const content = await Bun.file(specPath).text();
		expect(content).toContain("<!-- written-by: scout-2 -->");
		expect(content).toContain("# Attributed");
	});

	test("writes spec without agent when agent is omitted", async () => {
		await specWriteCommand("task-noagent", { body: "# No Agent" });

		expect(stdoutOutput).toContain("Spec written");
		expect(stdoutOutput).toContain("task-noagent");

		const specPath = join(tempDir, ".overstory", "specs", "task-noagent.md");
		const content = await Bun.file(specPath).text();
		expect(content).not.toContain("written-by");
		expect(content).toBe("# No Agent\n");
	});

	test("uses workflow alias to select Trellis output path", async () => {
		await specWriteCommand("task-cc", { body: "# Co-create", workflow: "co-creation" });

		const specPath = join(tempDir, ".trellis", "specs", "task-cc.yaml");
		const content = await Bun.file(specPath).text();
		expect(content).toContain("title: Co-create");
		expect(content).toContain("  # Co-create");
	});

	test("passes Trellis bootstrap metadata through the CLI surface", async () => {
		await specWriteCommand("task-meta", {
			body: "Write a better initial Trellis artifact",
			title: "Better Trellis bootstrap",
			seed: "operator-cli-0002",
			reference: ["README.md", "docs/contract.md"],
			constraint: ["Keep Trellis as the source of truth"],
			acceptance: ["Initial spec is useful without immediate rewrite"],
			workflow: "co-creation",
		});

		const specPath = join(tempDir, ".trellis", "specs", "task-meta.yaml");
		const content = await Bun.file(specPath).text();
		expect(content).toContain("title: Better Trellis bootstrap");
		expect(content).toContain("seed: operator-cli-0002");
		expect(content).toContain("  - Keep Trellis as the source of truth");
		expect(content).toContain("  - Initial spec is useful without immediate rewrite");
		expect(content).toContain("  - README.md");
		expect(content).toContain("  - docs/contract.md");
	});

	test("refuses to overwrite an existing Trellis spec via the CLI surface", async () => {
		await specWriteCommand("task-existing", {
			body: "first version",
			workflow: "co-creation",
		});

		await expect(
			specWriteCommand("task-existing", {
				body: "second version",
				workflow: "co-creation",
			}),
		).rejects.toThrow("Trellis spec already exists");
	});

	test("allows Trellis overwrite via the CLI surface when forced", async () => {
		await specWriteCommand("task-existing-force", {
			body: "first version",
			workflow: "co-creation",
		});

		await specWriteCommand("task-existing-force", {
			body: "second version",
			workflow: "co-creation",
			force: true,
		});

		const content = await Bun.file(
			join(tempDir, ".trellis", "specs", "task-existing-force.yaml"),
		).text();
		expect(content).toContain("  second version");
		expect(content).not.toContain("  first version");
	});

	test("uses OVERSTORY_PROFILE env to default co-creation specs into Trellis", async () => {
		const previous = process.env.OVERSTORY_PROFILE;
		process.env.OVERSTORY_PROFILE = "ov-co-creation";

		try {
			await specWriteCommand("task-env", { body: "# Env profile" });
		} finally {
			if (previous === undefined) {
				delete process.env.OVERSTORY_PROFILE;
			} else {
				process.env.OVERSTORY_PROFILE = previous;
			}
		}

		const specPath = join(tempDir, ".trellis", "specs", "task-env.yaml");
		const content = await Bun.file(specPath).text();
		expect(content).toContain("title: Env profile");
		expect(content).toContain("  # Env profile");
	});
});

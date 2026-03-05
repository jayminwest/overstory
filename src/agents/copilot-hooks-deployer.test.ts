import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTempDir } from "../test-helpers.ts";
import { deployCopilotHooks } from "./copilot-hooks-deployer.ts";
import { PATH_PREFIX } from "./hooks-deployer.ts";

describe("deployCopilotHooks", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "overstory-copilot-hooks-test-"));
	});

	afterEach(async () => {
		await cleanupTempDir(tempDir);
	});

	test("writes hooks.json to .github/hooks/ directory", async () => {
		const worktreePath = join(tempDir, "worktree");
		await deployCopilotHooks(worktreePath, "my-builder");

		const hooksPath = join(worktreePath, ".github", "hooks", "hooks.json");
		const exists = await Bun.file(hooksPath).exists();
		expect(exists).toBe(true);
	});

	test("creates .github/hooks/ directory if it does not exist", async () => {
		const worktreePath = join(tempDir, "new-worktree");
		// Directory does not exist before the call
		await deployCopilotHooks(worktreePath, "builder-1");

		const hooksPath = join(worktreePath, ".github", "hooks", "hooks.json");
		expect(await Bun.file(hooksPath).exists()).toBe(true);
	});

	test("output file is valid JSON", async () => {
		const worktreePath = join(tempDir, "worktree");
		await deployCopilotHooks(worktreePath, "test-agent");

		const hooksPath = join(worktreePath, ".github", "hooks", "hooks.json");
		const raw = await Bun.file(hooksPath).text();
		expect(() => JSON.parse(raw)).not.toThrow();
	});

	test("output has Copilot schema structure (top-level hooks with onSessionStart)", async () => {
		const worktreePath = join(tempDir, "worktree");
		await deployCopilotHooks(worktreePath, "test-agent");

		const hooksPath = join(worktreePath, ".github", "hooks", "hooks.json");
		const config = JSON.parse(await Bun.file(hooksPath).text()) as Record<string, unknown>;

		expect(config).toHaveProperty("hooks");
		const hooks = config.hooks as Record<string, unknown>;
		expect(hooks).toHaveProperty("onSessionStart");
		expect(Array.isArray(hooks.onSessionStart)).toBe(true);
	});

	test("replaces {{AGENT_NAME}} with agentName in all commands", async () => {
		const worktreePath = join(tempDir, "worktree");
		await deployCopilotHooks(worktreePath, "scout-agent-42");

		const hooksPath = join(worktreePath, ".github", "hooks", "hooks.json");
		const raw = await Bun.file(hooksPath).text();

		expect(raw).toContain("scout-agent-42");
		expect(raw).not.toContain("{{AGENT_NAME}}");
	});

	test("prepends PATH_PREFIX to all hook commands", async () => {
		const worktreePath = join(tempDir, "worktree");
		await deployCopilotHooks(worktreePath, "builder-1");

		const hooksPath = join(worktreePath, ".github", "hooks", "hooks.json");
		const config = JSON.parse(await Bun.file(hooksPath).text()) as {
			hooks: Record<string, Array<{ command: string }>>;
		};

		const allCommands = Object.values(config.hooks)
			.flat()
			.map((e) => e.command);
		expect(allCommands.length).toBeGreaterThan(0);
		for (const cmd of allCommands) {
			expect(cmd).toStartWith(PATH_PREFIX);
		}
	});

	test("onSessionStart entries are objects with command field only (no matcher, no type)", async () => {
		const worktreePath = join(tempDir, "worktree");
		await deployCopilotHooks(worktreePath, "builder-1");

		const hooksPath = join(worktreePath, ".github", "hooks", "hooks.json");
		const config = JSON.parse(await Bun.file(hooksPath).text()) as {
			hooks: { onSessionStart: Array<Record<string, unknown>> };
		};

		for (const entry of config.hooks.onSessionStart) {
			expect(typeof entry.command).toBe("string");
			// Copilot schema has no matcher or type fields
			expect(entry).not.toHaveProperty("matcher");
			expect(entry).not.toHaveProperty("type");
		}
	});

	test("onSessionStart includes ov prime command", async () => {
		const worktreePath = join(tempDir, "worktree");
		await deployCopilotHooks(worktreePath, "prime-test-agent");

		const hooksPath = join(worktreePath, ".github", "hooks", "hooks.json");
		const config = JSON.parse(await Bun.file(hooksPath).text()) as {
			hooks: { onSessionStart: Array<{ command: string }> };
		};

		const commands = config.hooks.onSessionStart.map((e) => e.command);
		expect(commands.some((c) => c.includes("ov prime") && c.includes("prime-test-agent"))).toBe(
			true,
		);
	});

	test("onSessionStart includes ov mail check --inject command", async () => {
		const worktreePath = join(tempDir, "worktree");
		await deployCopilotHooks(worktreePath, "mail-test-agent");

		const hooksPath = join(worktreePath, ".github", "hooks", "hooks.json");
		const config = JSON.parse(await Bun.file(hooksPath).text()) as {
			hooks: { onSessionStart: Array<{ command: string }> };
		};

		const commands = config.hooks.onSessionStart.map((e) => e.command);
		expect(
			commands.some((c) => c.includes("ov mail check --inject") && c.includes("mail-test-agent")),
		).toBe(true);
	});

	test("all hook commands include ENV_GUARD pattern", async () => {
		const worktreePath = join(tempDir, "worktree");
		await deployCopilotHooks(worktreePath, "guard-test-agent");

		const hooksPath = join(worktreePath, ".github", "hooks", "hooks.json");
		const config = JSON.parse(await Bun.file(hooksPath).text()) as {
			hooks: Record<string, Array<{ command: string }>>;
		};

		const allCommands = Object.values(config.hooks)
			.flat()
			.map((e) => e.command);
		for (const cmd of allCommands) {
			expect(cmd).toContain("OVERSTORY_AGENT_NAME");
		}
	});

	test("template file exists and is valid JSON after substitution", async () => {
		// Verify template file is present and parseable (basic template health check).
		const templatePath = join(import.meta.dir, "..", "..", "templates", "copilot-hooks.json.tmpl");
		const exists = await Bun.file(templatePath).exists();
		expect(exists).toBe(true);

		const raw = (await Bun.file(templatePath).text()).replace(/\{\{AGENT_NAME\}\}/g, "test");
		expect(() => JSON.parse(raw)).not.toThrow();
	});
});

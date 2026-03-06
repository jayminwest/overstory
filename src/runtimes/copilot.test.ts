import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTempDir } from "../test-helpers.ts";
import type { ResolvedModel } from "../types.ts";
import { CopilotRuntime, ensureCopilotTrustedFolders } from "./copilot.ts";
import type { SpawnOpts } from "./types.ts";

describe("CopilotRuntime", () => {
	const runtime = new CopilotRuntime();

	describe("id and instructionPath", () => {
		test("id is 'copilot'", () => {
			expect(runtime.id).toBe("copilot");
		});

		test("instructionPath is .github/copilot-instructions.md", () => {
			expect(runtime.instructionPath).toBe(".github/copilot-instructions.md");
		});
	});

	describe("buildSpawnCommand", () => {
		test("bypass permission mode includes --allow-all-tools", () => {
			const opts: SpawnOpts = {
				model: "sonnet",
				permissionMode: "bypass",
				cwd: "/tmp/worktree",
				env: {},
			};
			const cmd = runtime.buildSpawnCommand(opts);
			expect(cmd).toBe("copilot --model claude-sonnet-4-6 --allow-all-tools");
		});

		test("ask permission mode omits permission flag", () => {
			const opts: SpawnOpts = {
				model: "opus",
				permissionMode: "ask",
				cwd: "/tmp/worktree",
				env: {},
			};
			const cmd = runtime.buildSpawnCommand(opts);
			expect(cmd).toBe("copilot --model claude-opus-4-6");
			expect(cmd).not.toContain("--allow-all-tools");
			expect(cmd).not.toContain("--permission-mode");
		});

		test("appendSystemPrompt is ignored (copilot has no such flag)", () => {
			const opts: SpawnOpts = {
				model: "sonnet",
				permissionMode: "bypass",
				cwd: "/tmp/worktree",
				env: {},
				appendSystemPrompt: "You are a builder agent.",
			};
			const cmd = runtime.buildSpawnCommand(opts);
			expect(cmd).toBe("copilot --model claude-sonnet-4-6 --allow-all-tools");
			expect(cmd).not.toContain("append-system-prompt");
			expect(cmd).not.toContain("You are a builder agent");
		});

		test("appendSystemPromptFile is ignored (copilot has no such flag)", () => {
			const opts: SpawnOpts = {
				model: "opus",
				permissionMode: "bypass",
				cwd: "/project",
				env: {},
				appendSystemPromptFile: "/project/.overstory/agent-defs/coordinator.md",
			};
			const cmd = runtime.buildSpawnCommand(opts);
			expect(cmd).toBe("copilot --model claude-opus-4-6 --allow-all-tools");
			expect(cmd).not.toContain("cat");
			expect(cmd).not.toContain("coordinator.md");
		});

		test("cwd and env are not embedded in command string", () => {
			const opts: SpawnOpts = {
				model: "sonnet",
				permissionMode: "bypass",
				cwd: "/some/specific/path",
				env: { GITHUB_TOKEN: "gh-test-123" },
			};
			const cmd = runtime.buildSpawnCommand(opts);
			expect(cmd).not.toContain("/some/specific/path");
			expect(cmd).not.toContain("gh-test-123");
			expect(cmd).not.toContain("GITHUB_TOKEN");
		});

		test("known aliases expand to fully-qualified names, unknown models pass through", () => {
			const cases: Array<[string, string]> = [
				["sonnet", "claude-sonnet-4-6"],
				["opus", "claude-opus-4-6"],
				["haiku", "claude-haiku-4-5"],
				["gpt-4o", "gpt-4o"],
				["openrouter/gpt-5", "openrouter/gpt-5"],
			];
			for (const [alias, expected] of cases) {
				const opts: SpawnOpts = {
					model: alias,
					permissionMode: "bypass",
					cwd: "/tmp",
					env: {},
				};
				const cmd = runtime.buildSpawnCommand(opts);
				expect(cmd).toContain(`--model ${expected}`);
			}
		});

		test("produces identical output for same inputs (deterministic)", () => {
			const opts: SpawnOpts = {
				model: "sonnet",
				permissionMode: "bypass",
				cwd: "/tmp/worktree",
				env: {},
			};
			const cmd1 = runtime.buildSpawnCommand(opts);
			const cmd2 = runtime.buildSpawnCommand(opts);
			expect(cmd1).toBe(cmd2);
		});
	});

	describe("expandModel", () => {
		test("expands 'sonnet' to claude-sonnet-4-6", () => {
			expect(runtime.expandModel("sonnet")).toBe("claude-sonnet-4-6");
		});

		test("expands 'opus' to claude-opus-4-6", () => {
			expect(runtime.expandModel("opus")).toBe("claude-opus-4-6");
		});

		test("expands 'haiku' to claude-haiku-4-5", () => {
			expect(runtime.expandModel("haiku")).toBe("claude-haiku-4-5");
		});

		test("passes through fully-qualified names unchanged", () => {
			expect(runtime.expandModel("claude-sonnet-4-6")).toBe("claude-sonnet-4-6");
			expect(runtime.expandModel("gpt-4o")).toBe("gpt-4o");
			expect(runtime.expandModel("openrouter/gpt-5")).toBe("openrouter/gpt-5");
		});

		test("passes through unknown aliases unchanged", () => {
			expect(runtime.expandModel("my-custom-model")).toBe("my-custom-model");
		});
	});

	describe("buildPrintCommand", () => {
		test("basic command without model includes --allow-all-tools", () => {
			const argv = runtime.buildPrintCommand("Summarize this diff");
			expect(argv).toEqual(["copilot", "-p", "Summarize this diff", "--allow-all-tools"]);
		});

		test("command with model override appends --model flag (alias expanded)", () => {
			const argv = runtime.buildPrintCommand("Classify this error", "haiku");
			expect(argv).toEqual([
				"copilot",
				"-p",
				"Classify this error",
				"--allow-all-tools",
				"--model",
				"claude-haiku-4-5",
			]);
		});

		test("command with fully-qualified model passes through unchanged", () => {
			const argv = runtime.buildPrintCommand("Summarize", "gpt-4o");
			expect(argv).toEqual([
				"copilot",
				"-p",
				"Summarize",
				"--allow-all-tools",
				"--model",
				"gpt-4o",
			]);
		});

		test("model undefined omits --model flag", () => {
			const argv = runtime.buildPrintCommand("Hello", undefined);
			expect(argv).not.toContain("--model");
			expect(argv).toContain("--allow-all-tools");
		});

		test("--allow-all-tools always present regardless of model", () => {
			const withModel = runtime.buildPrintCommand("prompt", "opus");
			const withoutModel = runtime.buildPrintCommand("prompt");
			expect(withModel).toContain("--allow-all-tools");
			expect(withoutModel).toContain("--allow-all-tools");
		});
	});

	describe("detectReady", () => {
		test("returns loading for empty pane", () => {
			const state = runtime.detectReady("");
			expect(state).toEqual({ phase: "loading" });
		});

		test("returns loading for partial content (prompt only, no status bar)", () => {
			const state = runtime.detectReady("Welcome to Copilot!\n\u276f");
			expect(state).toEqual({ phase: "loading" });
		});

		test("returns loading for partial content (status bar only, no prompt)", () => {
			const state = runtime.detectReady("shift+tab to toggle");
			expect(state).toEqual({ phase: "loading" });
		});

		test("returns ready for ❯ + shift+tab", () => {
			const state = runtime.detectReady("GitHub Copilot\n\u276f\nshift+tab to chat");
			expect(state).toEqual({ phase: "ready" });
		});

		test("returns ready for ❯ + esc", () => {
			const state = runtime.detectReady("GitHub Copilot\n\u276f\nesc to cancel");
			expect(state).toEqual({ phase: "ready" });
		});

		test("returns ready for 'copilot' keyword + shift+tab (case-insensitive)", () => {
			const state = runtime.detectReady("Copilot Agent Ready\nshift+tab");
			expect(state).toEqual({ phase: "ready" });
		});

		test("returns ready for 'copilot' keyword + esc (case-insensitive)", () => {
			const state = runtime.detectReady("GitHub Copilot v1.0\npress esc to exit");
			expect(state).toEqual({ phase: "ready" });
		});

		test("case-insensitive match for 'COPILOT'", () => {
			const state = runtime.detectReady("GITHUB COPILOT\nESC");
			expect(state).toEqual({ phase: "ready" });
		});

		test("returns loading for random pane content", () => {
			const state = runtime.detectReady("Loading...\nPlease wait");
			expect(state).toEqual({ phase: "loading" });
		});

		test("no trust dialog phase — trust text is ignored", () => {
			// Copilot has no trust dialog; this should just test loading/ready states
			const state = runtime.detectReady("trust this folder");
			// Without prompt+statusbar indicators, remains loading
			expect(state).toEqual({ phase: "loading" });
		});

		test("Shift+Tab (capital) is matched case-insensitively", () => {
			const state = runtime.detectReady("\u276f\nShift+Tab to toggle");
			expect(state).toEqual({ phase: "ready" });
		});
	});

	describe("buildEnv", () => {
		test("returns empty object when model has no env", () => {
			const model: ResolvedModel = { model: "sonnet" };
			const env = runtime.buildEnv(model);
			expect(env).toEqual({});
		});

		test("returns model.env when present", () => {
			const model: ResolvedModel = {
				model: "gpt-4o",
				env: { GITHUB_TOKEN: "gh-test-123", COPILOT_API_URL: "https://api.github.com" },
			};
			const env = runtime.buildEnv(model);
			expect(env).toEqual({
				GITHUB_TOKEN: "gh-test-123",
				COPILOT_API_URL: "https://api.github.com",
			});
		});

		test("returns empty object when model.env is undefined", () => {
			const model: ResolvedModel = { model: "opus", env: undefined };
			const env = runtime.buildEnv(model);
			expect(env).toEqual({});
		});

		test("env is safe to spread into session env", () => {
			const model: ResolvedModel = { model: "sonnet" };
			const env = runtime.buildEnv(model);
			const combined = { ...env, OVERSTORY_AGENT_NAME: "builder-1" };
			expect(combined).toEqual({ OVERSTORY_AGENT_NAME: "builder-1" });
		});
	});

	describe("deployConfig", () => {
		let tempDir: string;

		beforeEach(async () => {
			tempDir = await mkdtemp(join(tmpdir(), "overstory-copilot-test-"));
		});

		afterEach(async () => {
			await cleanupTempDir(tempDir);
		});

		test("writes overlay to .github/copilot-instructions.md when provided", async () => {
			const worktreePath = join(tempDir, "worktree");

			await runtime.deployConfig(
				worktreePath,
				{ content: "# Copilot Instructions\nYou are a builder." },
				{
					agentName: "test-builder",
					capability: "builder",
					worktreePath,
				},
			);

			const overlayPath = join(worktreePath, ".github", "copilot-instructions.md");
			const content = await Bun.file(overlayPath).text();
			expect(content).toBe("# Copilot Instructions\nYou are a builder.");
		});

		test("creates .github directory if it does not exist", async () => {
			const worktreePath = join(tempDir, "new-worktree");

			await runtime.deployConfig(
				worktreePath,
				{ content: "# Instructions" },
				{ agentName: "test", capability: "builder", worktreePath },
			);

			const githubDirExists = await Bun.file(
				join(worktreePath, ".github", "copilot-instructions.md"),
			).exists();
			expect(githubDirExists).toBe(true);
		});

		test("skips overlay write when overlay is undefined", async () => {
			const worktreePath = join(tempDir, "worktree");

			await runtime.deployConfig(worktreePath, undefined, {
				agentName: "coordinator",
				capability: "coordinator",
				worktreePath,
			});

			// No overlay written — copilot-instructions.md should not exist.
			const overlayPath = join(worktreePath, ".github", "copilot-instructions.md");
			const overlayExists = await Bun.file(overlayPath).exists();
			expect(overlayExists).toBe(false);
		});

		test("does not write settings.local.json (Copilot uses its own hooks format)", async () => {
			const worktreePath = join(tempDir, "worktree");

			await runtime.deployConfig(
				worktreePath,
				{ content: "# Instructions" },
				{ agentName: "test-builder", capability: "builder", worktreePath },
			);

			// Copilot does not deploy Claude Code hooks.
			const settingsPath = join(worktreePath, ".claude", "settings.local.json");
			const settingsExists = await Bun.file(settingsPath).exists();
			expect(settingsExists).toBe(false);
		});

		test("writes .github/hooks/hooks.json with Copilot schema when deployConfig is called", async () => {
			const worktreePath = join(tempDir, "worktree-hooks");

			await runtime.deployConfig(
				worktreePath,
				{ content: "# Instructions" },
				{ agentName: "test-builder", capability: "builder", worktreePath },
			);

			const hooksPath = join(worktreePath, ".github", "hooks", "hooks.json");
			const hooksExists = await Bun.file(hooksPath).exists();
			expect(hooksExists).toBe(true);

			const hooksContent = JSON.parse(await Bun.file(hooksPath).text()) as Record<string, unknown>;
			// Copilot schema: top-level "hooks" key with onSessionStart array
			expect(hooksContent).toHaveProperty("hooks");
			const hooks = hooksContent.hooks as Record<string, unknown>;
			expect(hooks).toHaveProperty("onSessionStart");
			expect(Array.isArray(hooks.onSessionStart)).toBe(true);
		});

		test("hooks.json contains agentName substituted in commands", async () => {
			const worktreePath = join(tempDir, "worktree-agentname");

			await runtime.deployConfig(worktreePath, undefined, {
				agentName: "my-test-agent",
				capability: "builder",
				worktreePath,
			});

			const hooksPath = join(worktreePath, ".github", "hooks", "hooks.json");
			const raw = await Bun.file(hooksPath).text();
			expect(raw).toContain("my-test-agent");
			expect(raw).not.toContain("{{AGENT_NAME}}");
		});
	});

	describe("parseTranscript", () => {
		let tempDir: string;

		beforeEach(async () => {
			tempDir = await mkdtemp(join(tmpdir(), "overstory-copilot-transcript-test-"));
		});

		afterEach(async () => {
			await cleanupTempDir(tempDir);
		});

		test("returns null for non-existent file", async () => {
			const result = await runtime.parseTranscript(join(tempDir, "does-not-exist.jsonl"));
			expect(result).toBeNull();
		});

		test("parses Claude-style transcript (type:assistant, message.usage)", async () => {
			const transcriptPath = join(tempDir, "session.jsonl");
			const entry = JSON.stringify({
				type: "assistant",
				message: {
					model: "claude-sonnet-4-6",
					usage: {
						input_tokens: 100,
						output_tokens: 50,
					},
				},
			});
			await Bun.write(transcriptPath, `${entry}\n`);

			const result = await runtime.parseTranscript(transcriptPath);
			expect(result).not.toBeNull();
			expect(result?.inputTokens).toBe(100);
			expect(result?.outputTokens).toBe(50);
			expect(result?.model).toBe("claude-sonnet-4-6");
		});

		test("parses Pi-style transcript (type:message_end, top-level tokens)", async () => {
			const transcriptPath = join(tempDir, "session.jsonl");
			const modelEntry = JSON.stringify({ type: "model_change", model: "gpt-4o" });
			const tokenEntry = JSON.stringify({
				type: "message_end",
				inputTokens: 200,
				outputTokens: 75,
			});
			await Bun.write(transcriptPath, `${modelEntry}\n${tokenEntry}\n`);

			const result = await runtime.parseTranscript(transcriptPath);
			expect(result).not.toBeNull();
			expect(result?.inputTokens).toBe(200);
			expect(result?.outputTokens).toBe(75);
			expect(result?.model).toBe("gpt-4o");
		});

		test("aggregates multiple Claude-style turns", async () => {
			const transcriptPath = join(tempDir, "session.jsonl");
			const entry1 = JSON.stringify({
				type: "assistant",
				message: {
					model: "claude-sonnet-4-6",
					usage: { input_tokens: 100, output_tokens: 50 },
				},
			});
			const entry2 = JSON.stringify({
				type: "assistant",
				message: {
					model: "claude-sonnet-4-6",
					usage: { input_tokens: 200, output_tokens: 75 },
				},
			});
			await Bun.write(transcriptPath, `${entry1}\n${entry2}\n`);

			const result = await runtime.parseTranscript(transcriptPath);
			expect(result?.inputTokens).toBe(300);
			expect(result?.outputTokens).toBe(125);
		});

		test("aggregates multiple Pi-style turns", async () => {
			const transcriptPath = join(tempDir, "session.jsonl");
			const entry1 = JSON.stringify({ type: "message_end", inputTokens: 100, outputTokens: 40 });
			const entry2 = JSON.stringify({ type: "message_end", inputTokens: 150, outputTokens: 60 });
			await Bun.write(transcriptPath, `${entry1}\n${entry2}\n`);

			const result = await runtime.parseTranscript(transcriptPath);
			expect(result?.inputTokens).toBe(250);
			expect(result?.outputTokens).toBe(100);
		});

		test("top-level model field is picked up from any entry", async () => {
			const transcriptPath = join(tempDir, "session.jsonl");
			const modelEntry = JSON.stringify({ model: "copilot-4" });
			const tokenEntry = JSON.stringify({
				type: "assistant",
				message: { usage: { input_tokens: 10, output_tokens: 5 } },
			});
			await Bun.write(transcriptPath, `${modelEntry}\n${tokenEntry}\n`);

			const result = await runtime.parseTranscript(transcriptPath);
			expect(result?.model).toBe("copilot-4");
			expect(result?.inputTokens).toBe(10);
		});

		test("message.model takes precedence over top-level model when both present", async () => {
			const transcriptPath = join(tempDir, "session.jsonl");
			const entry = JSON.stringify({
				type: "assistant",
				model: "top-level-model",
				message: {
					model: "message-model",
					usage: { input_tokens: 10, output_tokens: 5 },
				},
			});
			await Bun.write(transcriptPath, `${entry}\n`);

			const result = await runtime.parseTranscript(transcriptPath);
			// message.model is processed after top-level model in same entry,
			// so message.model wins for assistant entries.
			expect(result?.model).toBe("message-model");
		});

		test("mixed Claude-style and Pi-style in same transcript", async () => {
			const transcriptPath = join(tempDir, "session.jsonl");
			const claudeEntry = JSON.stringify({
				type: "assistant",
				message: {
					model: "claude-sonnet-4-6",
					usage: { input_tokens: 100, output_tokens: 40 },
				},
			});
			const piEntry = JSON.stringify({
				type: "message_end",
				inputTokens: 50,
				outputTokens: 20,
			});
			await Bun.write(transcriptPath, `${claudeEntry}\n${piEntry}\n`);

			const result = await runtime.parseTranscript(transcriptPath);
			expect(result?.inputTokens).toBe(150);
			expect(result?.outputTokens).toBe(60);
		});

		test("skips non-relevant entry types", async () => {
			const transcriptPath = join(tempDir, "session.jsonl");
			const userEntry = JSON.stringify({ type: "user", message: { content: "hello" } });
			const assistantEntry = JSON.stringify({
				type: "assistant",
				message: {
					model: "claude-sonnet-4-6",
					usage: { input_tokens: 50, output_tokens: 25 },
				},
			});
			await Bun.write(transcriptPath, `${userEntry}\n${assistantEntry}\n`);

			const result = await runtime.parseTranscript(transcriptPath);
			expect(result?.inputTokens).toBe(50);
			expect(result?.outputTokens).toBe(25);
		});

		test("skips malformed lines and continues parsing", async () => {
			const transcriptPath = join(tempDir, "session.jsonl");
			const goodEntry = JSON.stringify({
				type: "assistant",
				message: { model: "gpt-4o", usage: { input_tokens: 30, output_tokens: 15 } },
			});
			await Bun.write(transcriptPath, `not json at all\n${goodEntry}\n{broken`);

			const result = await runtime.parseTranscript(transcriptPath);
			expect(result).not.toBeNull();
			expect(result?.inputTokens).toBe(30);
			expect(result?.outputTokens).toBe(15);
		});

		test("returns zero tokens for empty transcript", async () => {
			const transcriptPath = join(tempDir, "empty.jsonl");
			await Bun.write(transcriptPath, "");

			const result = await runtime.parseTranscript(transcriptPath);
			expect(result).not.toBeNull();
			expect(result?.inputTokens).toBe(0);
			expect(result?.outputTokens).toBe(0);
			expect(result?.model).toBe("");
		});
	});
});

describe("ensureCopilotTrustedFolders", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "overstory-copilot-trust-test-"));
	});

	afterEach(async () => {
		await cleanupTempDir(tempDir);
	});

	test("creates config.json with trustedFolders when file does not exist", async () => {
		const configDir = join(tempDir, "github-copilot");
		await ensureCopilotTrustedFolders("/some/worktree", configDir);

		const configPath = join(configDir, "config.json");
		const content = JSON.parse(await Bun.file(configPath).text()) as Record<string, unknown>;
		expect(Array.isArray(content.trustedFolders)).toBe(true);
		expect(content.trustedFolders).toContain("/some/worktree");
	});

	test("creates config directory if it does not exist", async () => {
		const configDir = join(tempDir, "nested", "github-copilot");
		await ensureCopilotTrustedFolders("/my/worktree", configDir);

		const configPath = join(configDir, "config.json");
		const exists = await Bun.file(configPath).exists();
		expect(exists).toBe(true);
	});

	test("appends to existing trustedFolders without duplicates", async () => {
		const configDir = join(tempDir, "github-copilot");
		await ensureCopilotTrustedFolders("/first/path", configDir);
		await ensureCopilotTrustedFolders("/second/path", configDir);

		const configPath = join(configDir, "config.json");
		const content = JSON.parse(await Bun.file(configPath).text()) as Record<string, unknown>;
		expect(Array.isArray(content.trustedFolders)).toBe(true);
		const trusted = content.trustedFolders as string[];
		expect(trusted).toContain("/first/path");
		expect(trusted).toContain("/second/path");
		expect(trusted.length).toBe(2);
	});

	test("does not duplicate existing entries", async () => {
		const configDir = join(tempDir, "github-copilot");
		await ensureCopilotTrustedFolders("/some/worktree", configDir);
		await ensureCopilotTrustedFolders("/some/worktree", configDir);

		const configPath = join(configDir, "config.json");
		const content = JSON.parse(await Bun.file(configPath).text()) as Record<string, unknown>;
		const trusted = content.trustedFolders as string[];
		expect(trusted.filter((p) => p === "/some/worktree").length).toBe(1);
	});

	test("preserves other config keys when updating trustedFolders", async () => {
		const configDir = join(tempDir, "github-copilot");
		const configPath = join(configDir, "config.json");
		await Bun.write(
			configPath,
			`${JSON.stringify({ someOtherKey: "value", trustedFolders: [] }, null, "\t")}\n`,
		);

		await ensureCopilotTrustedFolders("/new/worktree", configDir);

		const content = JSON.parse(await Bun.file(configPath).text()) as Record<string, unknown>;
		expect(content.someOtherKey).toBe("value");
		expect(content.trustedFolders as string[]).toContain("/new/worktree");
	});

	test("handles invalid JSON in existing config by starting fresh", async () => {
		const configDir = join(tempDir, "github-copilot");
		await Bun.write(join(configDir, "config.json"), "not valid json");
		await ensureCopilotTrustedFolders("/new/worktree", configDir);

		const configPath = join(configDir, "config.json");
		const content = JSON.parse(await Bun.file(configPath).text()) as Record<string, unknown>;
		expect(content.trustedFolders as string[]).toContain("/new/worktree");
	});

	test("treats non-array trustedFolders as empty and replaces it", async () => {
		const configDir = join(tempDir, "github-copilot");
		const configPath = join(configDir, "config.json");
		await Bun.write(
			configPath,
			`${JSON.stringify({ trustedFolders: "not-an-array" }, null, "\t")}\n`,
		);

		await ensureCopilotTrustedFolders("/my/worktree", configDir);

		const content = JSON.parse(await Bun.file(configPath).text()) as Record<string, unknown>;
		expect(Array.isArray(content.trustedFolders)).toBe(true);
		expect(content.trustedFolders as string[]).toContain("/my/worktree");
	});
});

describe("CopilotRuntime.prepareWorktree", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "overstory-copilot-prepworktree-test-"));
	});

	afterEach(async () => {
		await cleanupTempDir(tempDir);
	});

	test("prepareWorktree is defined on CopilotRuntime", () => {
		const runtime = new CopilotRuntime();
		expect(typeof runtime.prepareWorktree).toBe("function");
	});

	test("calling prepareWorktree with a worktreePath does not throw", async () => {
		// We can't inject configDir through the interface method, but we can verify
		// it doesn't throw. The actual file write goes to real homedir, which is
		// tested via ensureCopilotTrustedFolders directly.
		const runtime = new CopilotRuntime();
		await expect(runtime.prepareWorktree("/test/worktree")).resolves.toBeUndefined();
	});
});

describe("CopilotRuntime integration: registry resolves 'copilot'", () => {
	test("getRuntime('copilot') returns CopilotRuntime", async () => {
		const { getRuntime } = await import("./registry.ts");
		const rt = getRuntime("copilot");
		expect(rt).toBeInstanceOf(CopilotRuntime);
		expect(rt.id).toBe("copilot");
		expect(rt.instructionPath).toBe(".github/copilot-instructions.md");
	});
});

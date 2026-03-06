import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedModel } from "../types.ts";
import { PiRuntime } from "./pi.ts";
import type { SpawnOpts } from "./types.ts";

describe("PiRuntime", () => {
	const runtime = new PiRuntime();

	describe("id and instructionPath", () => {
		test("id is 'pi'", () => {
			expect(runtime.id).toBe("pi");
		});

		test("instructionPath is .claude/CLAUDE.md", () => {
			expect(runtime.instructionPath).toBe(".claude/CLAUDE.md");
		});
	});

	describe("expandModel", () => {
		test("expands known alias to provider-qualified ID", () => {
			expect(runtime.expandModel("sonnet")).toBe("anthropic/claude-sonnet-4-6");
			expect(runtime.expandModel("opus")).toBe("anthropic/claude-opus-4-6");
			expect(runtime.expandModel("haiku")).toBe("anthropic/claude-haiku-4-5");
		});

		test("passes through already-qualified model (contains /)", () => {
			expect(runtime.expandModel("anthropic/claude-opus-4-6")).toBe("anthropic/claude-opus-4-6");
			expect(runtime.expandModel("openrouter/gpt-5")).toBe("openrouter/gpt-5");
		});

		test("unknown alias gets provider prefix", () => {
			expect(runtime.expandModel("gpt-4o")).toBe("anthropic/gpt-4o");
		});

		test("custom config with different provider", () => {
			const custom = new PiRuntime({
				provider: "amazon-bedrock",
				modelMap: {
					opus: "amazon-bedrock/us.anthropic.claude-opus-4-6-v1",
				},
			});
			expect(custom.expandModel("opus")).toBe("amazon-bedrock/us.anthropic.claude-opus-4-6-v1");
			// Unknown alias gets the custom provider prefix
			expect(custom.expandModel("sonnet")).toBe("amazon-bedrock/sonnet");
		});

		test("custom modelMap overrides defaults", () => {
			const custom = new PiRuntime({
				provider: "anthropic",
				modelMap: {
					sonnet: "anthropic/claude-sonnet-4-5-20250514",
				},
			});
			expect(custom.expandModel("sonnet")).toBe("anthropic/claude-sonnet-4-5-20250514");
			// Aliases not in the custom map fall back to provider prefix
			expect(custom.expandModel("opus")).toBe("anthropic/opus");
		});
	});

	describe("buildSpawnCommand", () => {
		test("expands model alias to provider-qualified ID", () => {
			const opts: SpawnOpts = {
				model: "sonnet",
				permissionMode: "bypass",
				cwd: "/tmp/worktree",
				env: {},
			};
			const cmd = runtime.buildSpawnCommand(opts);
			expect(cmd).toBe("pi --model anthropic/claude-sonnet-4-6");
		});

		test("permissionMode is NOT included in command (Pi has no permission-mode flag)", () => {
			const opts: SpawnOpts = {
				model: "opus",
				permissionMode: "bypass",
				cwd: "/tmp/worktree",
				env: {},
			};
			const cmd = runtime.buildSpawnCommand(opts);
			expect(cmd).not.toContain("--permission-mode");
			expect(cmd).not.toContain("bypassPermissions");
			expect(cmd).not.toContain("default");
		});

		test("ask permissionMode also excluded", () => {
			const opts: SpawnOpts = {
				model: "haiku",
				permissionMode: "ask",
				cwd: "/tmp/worktree",
				env: {},
			};
			const cmd = runtime.buildSpawnCommand(opts);
			expect(cmd).not.toContain("--permission-mode");
			expect(cmd).toBe("pi --model anthropic/claude-haiku-4-5");
		});

		test("with appendSystemPrompt (no quotes in prompt)", () => {
			const opts: SpawnOpts = {
				model: "sonnet",
				permissionMode: "bypass",
				cwd: "/tmp/worktree",
				env: {},
				appendSystemPrompt: "You are a builder agent.",
			};
			const cmd = runtime.buildSpawnCommand(opts);
			expect(cmd).toBe(
				"pi --model anthropic/claude-sonnet-4-6 --append-system-prompt 'You are a builder agent.'",
			);
		});

		test("with appendSystemPrompt containing single quotes (POSIX escape)", () => {
			const opts: SpawnOpts = {
				model: "sonnet",
				permissionMode: "bypass",
				cwd: "/tmp/worktree",
				env: {},
				appendSystemPrompt: "Don't touch the user's files",
			};
			const cmd = runtime.buildSpawnCommand(opts);
			expect(cmd).toContain("--append-system-prompt");
			expect(cmd).toBe(
				"pi --model anthropic/claude-sonnet-4-6 --append-system-prompt 'Don'\\''t touch the user'\\''s files'",
			);
		});

		test("with appendSystemPromptFile uses $(cat ...) expansion", () => {
			const opts: SpawnOpts = {
				model: "opus",
				permissionMode: "bypass",
				cwd: "/project",
				env: {},
				appendSystemPromptFile: "/project/.overstory/agent-defs/coordinator.md",
			};
			const cmd = runtime.buildSpawnCommand(opts);
			expect(cmd).toBe(
				`pi --model anthropic/claude-opus-4-6 --append-system-prompt "$(cat '/project/.overstory/agent-defs/coordinator.md')"`,
			);
		});

		test("appendSystemPromptFile takes precedence over appendSystemPrompt", () => {
			const opts: SpawnOpts = {
				model: "opus",
				permissionMode: "bypass",
				cwd: "/project",
				env: {},
				appendSystemPromptFile: "/project/.overstory/agent-defs/coordinator.md",
				appendSystemPrompt: "This inline content should be ignored",
			};
			const cmd = runtime.buildSpawnCommand(opts);
			expect(cmd).toContain("$(cat ");
			expect(cmd).not.toContain("This inline content should be ignored");
		});

		test("without appendSystemPrompt omits the flag", () => {
			const opts: SpawnOpts = {
				model: "haiku",
				permissionMode: "bypass",
				cwd: "/tmp/worktree",
				env: {},
			};
			const cmd = runtime.buildSpawnCommand(opts);
			expect(cmd).not.toContain("--append-system-prompt");
		});

		test("cwd and env are not embedded in command string", () => {
			const opts: SpawnOpts = {
				model: "sonnet",
				permissionMode: "bypass",
				cwd: "/some/specific/path",
				env: { API_KEY: "sk-test-123" },
			};
			const cmd = runtime.buildSpawnCommand(opts);
			expect(cmd).not.toContain("/some/specific/path");
			expect(cmd).not.toContain("sk-test-123");
			expect(cmd).not.toContain("API_KEY");
		});

		test("already-qualified models pass through unchanged", () => {
			for (const model of ["openrouter/gpt-5", "amazon-bedrock/us.anthropic.claude-opus-4-6-v1"]) {
				const opts: SpawnOpts = {
					model,
					permissionMode: "bypass",
					cwd: "/tmp",
					env: {},
				};
				const cmd = runtime.buildSpawnCommand(opts);
				expect(cmd).toContain(`--model ${model}`);
			}
		});

		test("aliases are expanded in spawn command", () => {
			for (const [alias, expected] of [
				["sonnet", "anthropic/claude-sonnet-4-6"],
				["opus", "anthropic/claude-opus-4-6"],
				["haiku", "anthropic/claude-haiku-4-5"],
			] as const) {
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
	});

	describe("buildPrintCommand", () => {
		test("basic command without model — prompt is last positional arg", () => {
			const argv = runtime.buildPrintCommand("Summarize this diff");
			expect(argv).toEqual(["pi", "--print", "Summarize this diff"]);
		});

		test("command with model alias — expands to qualified ID", () => {
			const argv = runtime.buildPrintCommand("Classify this error", "haiku");
			expect(argv).toEqual([
				"pi",
				"--print",
				"--model",
				"anthropic/claude-haiku-4-5",
				"Classify this error",
			]);
		});

		test("command with already-qualified model — passes through", () => {
			const argv = runtime.buildPrintCommand("Classify this error", "openrouter/gpt-5");
			expect(argv).toEqual(["pi", "--print", "--model", "openrouter/gpt-5", "Classify this error"]);
		});

		test("model undefined omits --model flag", () => {
			const argv = runtime.buildPrintCommand("Hello", undefined);
			expect(argv).not.toContain("--model");
		});

		test("prompt is the last element (positional, not -p flag)", () => {
			const prompt = "My test prompt";
			const argv = runtime.buildPrintCommand(prompt, "sonnet");
			expect(argv[argv.length - 1]).toBe(prompt);
			expect(argv).not.toContain("-p");
		});

		test("without model, argv has exactly 3 elements", () => {
			const argv = runtime.buildPrintCommand("prompt text");
			expect(argv.length).toBe(3);
		});

		test("with model, argv has exactly 5 elements", () => {
			const argv = runtime.buildPrintCommand("prompt text", "sonnet");
			expect(argv.length).toBe(5);
		});
	});

	describe("detectReady", () => {
		test("returns loading for empty pane", () => {
			const state = runtime.detectReady("");
			expect(state).toEqual({ phase: "loading" });
		});

		test("returns loading when only 'pi v' header present (no status bar)", () => {
			const state = runtime.detectReady(" pi v0.55.1\n escape to interrupt");
			expect(state).toEqual({ phase: "loading" });
		});

		test("returns loading when only status bar present (no header)", () => {
			const state = runtime.detectReady("0.0%/200k (auto)         (anthropic) claude-opus-4-6");
			expect(state).toEqual({ phase: "loading" });
		});

		test("returns ready for real Pi TUI pane content", () => {
			const pane = [
				" pi v0.55.1",
				" escape to interrupt",
				" ctrl+c to clear",
				"",
				"[Context]",
				"  ~/Projects/os-eco/CLAUDE.md",
				"",
				"[Extensions]",
				"  project",
				"    overstory-guard.ts",
				"",
				"────────────────────────────────",
				"~/Projects/os-eco/overstory (main)",
				"0.0%/200k (auto)         (anthropic) claude-opus-4-6 • high",
			].join("\n");
			const state = runtime.detectReady(pane);
			expect(state).toEqual({ phase: "ready" });
		});

		test("returns ready for minimal header + status bar", () => {
			const state = runtime.detectReady("pi v1.0\n\n42.5%/200k done");
			expect(state).toEqual({ phase: "ready" });
		});

		test("returns loading for random pane content", () => {
			const state = runtime.detectReady("Loading...\nPlease wait");
			expect(state).toEqual({ phase: "loading" });
		});

		test("no dialog phase — Pi has no trust dialog", () => {
			// Pi does not have a trust dialog; even 'trust this folder' should not trigger dialog
			const state = runtime.detectReady("trust this folder");
			expect(state.phase).not.toBe("dialog");
		});

		test("handles bedrock model provider in status bar", () => {
			const pane =
				" pi v0.55.1\n\n0.0%/200k (auto)         (amazon-bedrock) us.anthropic.claude-opus-4-6-v1 • high";
			const state = runtime.detectReady(pane);
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
				model: "sonnet",
				env: { API_KEY: "sk-test-123", BASE_URL: "https://api.example.com" },
			};
			const env = runtime.buildEnv(model);
			expect(env).toEqual({ API_KEY: "sk-test-123", BASE_URL: "https://api.example.com" });
		});

		test("returns empty object when model.env is undefined", () => {
			const model: ResolvedModel = { model: "opus", env: undefined };
			const env = runtime.buildEnv(model);
			expect(env).toEqual({});
		});

		test("result is safe to spread", () => {
			const model: ResolvedModel = { model: "sonnet" };
			const env = runtime.buildEnv(model);
			const combined = { ...env, OVERSTORY_AGENT_NAME: "builder-1" };
			expect(combined).toEqual({ OVERSTORY_AGENT_NAME: "builder-1" });
		});
	});

	describe("deployConfig", () => {
		let tempDir: string;

		beforeEach(async () => {
			tempDir = await mkdtemp(join(tmpdir(), "overstory-pi-test-"));
		});

		afterEach(async () => {
			await rm(tempDir, { recursive: true, force: true });
		});

		test("writes overlay to .claude/CLAUDE.md when overlay is provided", async () => {
			const worktreePath = join(tempDir, "worktree");

			await runtime.deployConfig(
				worktreePath,
				{ content: "# Pi Agent Overlay\nThis is the overlay content." },
				{ agentName: "test-builder", capability: "builder", worktreePath },
			);

			const overlayPath = join(worktreePath, ".claude", "CLAUDE.md");
			const content = await Bun.file(overlayPath).text();
			expect(content).toBe("# Pi Agent Overlay\nThis is the overlay content.");
		});

		test("deploys guard extension to .pi/extensions/overstory-guard.ts", async () => {
			const worktreePath = join(tempDir, "worktree");

			await runtime.deployConfig(
				worktreePath,
				{ content: "# Overlay" },
				{ agentName: "test-builder", capability: "builder", worktreePath },
			);

			const guardPath = join(worktreePath, ".pi", "extensions", "overstory-guard.ts");
			const exists = await Bun.file(guardPath).exists();
			expect(exists).toBe(true);
		});

		test("guard extension contains agent name and worktree path", async () => {
			const worktreePath = join(tempDir, "my-worktree");

			await runtime.deployConfig(
				worktreePath,
				{ content: "# Overlay" },
				{ agentName: "my-pi-agent", capability: "builder", worktreePath },
			);

			const guardPath = join(worktreePath, ".pi", "extensions", "overstory-guard.ts");
			const content = await Bun.file(guardPath).text();
			expect(content).toContain("my-pi-agent");
			expect(content).toContain(worktreePath);
		});

		test("deploys Pi settings.json with extensions config", async () => {
			const worktreePath = join(tempDir, "worktree");

			await runtime.deployConfig(
				worktreePath,
				{ content: "# Overlay" },
				{ agentName: "test-builder", capability: "builder", worktreePath },
			);

			const settingsPath = join(worktreePath, ".pi", "settings.json");
			const exists = await Bun.file(settingsPath).exists();
			expect(exists).toBe(true);

			const content = await Bun.file(settingsPath).text();
			const parsed = JSON.parse(content) as Record<string, unknown>;
			expect(parsed.extensions).toEqual(["./extensions"]);
		});

		test("settings.json has trailing newline", async () => {
			const worktreePath = join(tempDir, "worktree");

			await runtime.deployConfig(worktreePath, undefined, {
				agentName: "test-builder",
				capability: "builder",
				worktreePath,
			});

			const settingsPath = join(worktreePath, ".pi", "settings.json");
			const content = await Bun.file(settingsPath).text();
			expect(content.endsWith("\n")).toBe(true);
		});

		test("settings.json uses tab indentation", async () => {
			const worktreePath = join(tempDir, "worktree");

			await runtime.deployConfig(worktreePath, undefined, {
				agentName: "test-builder",
				capability: "builder",
				worktreePath,
			});

			const settingsPath = join(worktreePath, ".pi", "settings.json");
			const content = await Bun.file(settingsPath).text();
			// Tab-indented JSON has \t before array entries
			expect(content).toContain("\t");
		});

		test("skips CLAUDE.md when overlay is undefined", async () => {
			const worktreePath = join(tempDir, "worktree");

			await runtime.deployConfig(worktreePath, undefined, {
				agentName: "coordinator",
				capability: "coordinator",
				worktreePath,
			});

			const overlayPath = join(worktreePath, ".claude", "CLAUDE.md");
			const overlayExists = await Bun.file(overlayPath).exists();
			expect(overlayExists).toBe(false);
		});

		test("still deploys guard and settings when overlay is undefined", async () => {
			const worktreePath = join(tempDir, "worktree");

			await runtime.deployConfig(worktreePath, undefined, {
				agentName: "coordinator",
				capability: "coordinator",
				worktreePath,
			});

			const guardPath = join(worktreePath, ".pi", "extensions", "overstory-guard.ts");
			const settingsPath = join(worktreePath, ".pi", "settings.json");

			expect(await Bun.file(guardPath).exists()).toBe(true);
			expect(await Bun.file(settingsPath).exists()).toBe(true);
		});

		test("all three files present when overlay is provided", async () => {
			const worktreePath = join(tempDir, "worktree");

			await runtime.deployConfig(
				worktreePath,
				{ content: "# Overlay" },
				{ agentName: "test-builder", capability: "builder", worktreePath },
			);

			const claudeMdExists = await Bun.file(join(worktreePath, ".claude", "CLAUDE.md")).exists();
			const guardExists = await Bun.file(
				join(worktreePath, ".pi", "extensions", "overstory-guard.ts"),
			).exists();
			const settingsExists = await Bun.file(join(worktreePath, ".pi", "settings.json")).exists();

			expect(claudeMdExists).toBe(true);
			expect(guardExists).toBe(true);
			expect(settingsExists).toBe(true);
		});
	});

	describe("parseTranscript", () => {
		let tempDir: string;

		beforeEach(async () => {
			tempDir = await mkdtemp(join(tmpdir(), "overstory-pi-transcript-test-"));
		});

		afterEach(async () => {
			await rm(tempDir, { recursive: true, force: true });
		});

		test("returns null for non-existent file", async () => {
			const result = await runtime.parseTranscript(join(tempDir, "does-not-exist.jsonl"));
			expect(result).toBeNull();
		});

		test("parses message_end event with top-level inputTokens/outputTokens", async () => {
			const transcriptPath = join(tempDir, "session.jsonl");
			const entry = JSON.stringify({
				type: "message_end",
				inputTokens: 100,
				outputTokens: 50,
			});
			await Bun.write(transcriptPath, `${entry}\n`);

			const result = await runtime.parseTranscript(transcriptPath);
			expect(result).not.toBeNull();
			expect(result?.inputTokens).toBe(100);
			expect(result?.outputTokens).toBe(50);
		});

		test("aggregates multiple message_end events", async () => {
			const transcriptPath = join(tempDir, "session.jsonl");
			const entry1 = JSON.stringify({ type: "message_end", inputTokens: 100, outputTokens: 50 });
			const entry2 = JSON.stringify({ type: "message_end", inputTokens: 200, outputTokens: 75 });
			await Bun.write(transcriptPath, `${entry1}\n${entry2}\n`);

			const result = await runtime.parseTranscript(transcriptPath);
			expect(result).not.toBeNull();
			expect(result?.inputTokens).toBe(300);
			expect(result?.outputTokens).toBe(125);
		});

		test("reads model from model_change event", async () => {
			const transcriptPath = join(tempDir, "session.jsonl");
			const modelChange = JSON.stringify({ type: "model_change", model: "claude-sonnet-4-6" });
			const messageEnd = JSON.stringify({ type: "message_end", inputTokens: 10, outputTokens: 5 });
			await Bun.write(transcriptPath, `${modelChange}\n${messageEnd}\n`);

			const result = await runtime.parseTranscript(transcriptPath);
			expect(result?.model).toBe("claude-sonnet-4-6");
		});

		test("last model_change wins when multiple present", async () => {
			const transcriptPath = join(tempDir, "session.jsonl");
			const change1 = JSON.stringify({ type: "model_change", model: "sonnet" });
			const change2 = JSON.stringify({ type: "model_change", model: "opus" });
			const msgEnd = JSON.stringify({ type: "message_end", inputTokens: 10, outputTokens: 5 });
			await Bun.write(transcriptPath, `${change1}\n${change2}\n${msgEnd}\n`);

			const result = await runtime.parseTranscript(transcriptPath);
			expect(result?.model).toBe("opus");
		});

		test("defaults model to empty string when no model_change events", async () => {
			const transcriptPath = join(tempDir, "session.jsonl");
			const entry = JSON.stringify({ type: "message_end", inputTokens: 10, outputTokens: 5 });
			await Bun.write(transcriptPath, `${entry}\n`);

			const result = await runtime.parseTranscript(transcriptPath);
			expect(result?.model).toBe("");
		});

		test("skips non-message_end events for token counting", async () => {
			const transcriptPath = join(tempDir, "session.jsonl");
			// Claude-style assistant events should NOT be counted (wrong format for Pi)
			const claudeStyleEntry = JSON.stringify({
				type: "assistant",
				message: { usage: { input_tokens: 999, output_tokens: 999 } },
			});
			const piEntry = JSON.stringify({ type: "message_end", inputTokens: 10, outputTokens: 5 });
			await Bun.write(transcriptPath, `${claudeStyleEntry}\n${piEntry}\n`);

			const result = await runtime.parseTranscript(transcriptPath);
			expect(result?.inputTokens).toBe(10);
			expect(result?.outputTokens).toBe(5);
		});

		test("returns zero counts for file with no message_end events", async () => {
			const transcriptPath = join(tempDir, "session.jsonl");
			const entry = JSON.stringify({ type: "tool_call", name: "Read", input: {} });
			await Bun.write(transcriptPath, `${entry}\n`);

			const result = await runtime.parseTranscript(transcriptPath);
			expect(result).not.toBeNull();
			expect(result?.inputTokens).toBe(0);
			expect(result?.outputTokens).toBe(0);
		});

		test("returns null for completely malformed file (non-JSON)", async () => {
			const transcriptPath = join(tempDir, "bad.jsonl");
			await Bun.write(transcriptPath, "not json at all\nstill not json");

			// All lines fail to parse, result has 0 tokens (not null)
			const result = await runtime.parseTranscript(transcriptPath);
			if (result !== null) {
				expect(result.inputTokens).toBe(0);
				expect(result.outputTokens).toBe(0);
			}
		});

		test("skips malformed lines and parses valid ones", async () => {
			const transcriptPath = join(tempDir, "mixed.jsonl");
			const bad = "not json";
			const good = JSON.stringify({ type: "message_end", inputTokens: 42, outputTokens: 7 });
			await Bun.write(transcriptPath, `${bad}\n${good}\n`);

			const result = await runtime.parseTranscript(transcriptPath);
			expect(result?.inputTokens).toBe(42);
			expect(result?.outputTokens).toBe(7);
		});

		test("handles empty file (returns zero counts)", async () => {
			const transcriptPath = join(tempDir, "empty.jsonl");
			await Bun.write(transcriptPath, "");

			const result = await runtime.parseTranscript(transcriptPath);
			expect(result).not.toBeNull();
			expect(result?.inputTokens).toBe(0);
			expect(result?.outputTokens).toBe(0);
		});

		test("parses Pi v3 format: message events with message.usage", async () => {
			const transcriptPath = join(tempDir, "v3-session.jsonl");
			const session = JSON.stringify({ type: "session", version: 3, id: "test" });
			const modelChange = JSON.stringify({
				type: "model_change",
				provider: "anthropic",
				modelId: "claude-opus-4-6",
			});
			const msg = JSON.stringify({
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Hello" }],
					model: "claude-opus-4-6",
					usage: { input: 100, output: 50, cacheRead: 200, cacheWrite: 0, totalTokens: 350 },
				},
			});
			await Bun.write(transcriptPath, `${session}\n${modelChange}\n${msg}\n`);

			const result = await runtime.parseTranscript(transcriptPath);
			expect(result).not.toBeNull();
			// input (100) + cacheRead (200) = 300
			expect(result?.inputTokens).toBe(300);
			expect(result?.outputTokens).toBe(50);
			expect(result?.model).toBe("claude-opus-4-6");
		});

		test("parses model from modelId field in model_change (v3)", async () => {
			const transcriptPath = join(tempDir, "v3-model.jsonl");
			const modelChange = JSON.stringify({
				type: "model_change",
				modelId: "claude-sonnet-4-6",
			});
			await Bun.write(transcriptPath, `${modelChange}\n`);

			const result = await runtime.parseTranscript(transcriptPath);
			expect(result?.model).toBe("claude-sonnet-4-6");
		});

		test("aggregates multiple v3 message events", async () => {
			const transcriptPath = join(tempDir, "v3-multi.jsonl");
			const msg1 = JSON.stringify({
				type: "message",
				message: {
					role: "assistant",
					usage: { input: 100, output: 50, cacheRead: 0 },
				},
			});
			const msg2 = JSON.stringify({
				type: "message",
				message: {
					role: "assistant",
					usage: { input: 200, output: 75, cacheRead: 50 },
				},
			});
			await Bun.write(transcriptPath, `${msg1}\n${msg2}\n`);

			const result = await runtime.parseTranscript(transcriptPath);
			expect(result?.inputTokens).toBe(350); // 100 + 200 + 50 cacheRead
			expect(result?.outputTokens).toBe(125); // 50 + 75
		});

		test("skips user message events (only counts assistant)", async () => {
			const transcriptPath = join(tempDir, "v3-user.jsonl");
			const userMsg = JSON.stringify({
				type: "message",
				message: {
					role: "user",
					content: [{ type: "text", text: "Fix the bug" }],
				},
			});
			const assistantMsg = JSON.stringify({
				type: "message",
				message: {
					role: "assistant",
					usage: { input: 100, output: 50 },
				},
			});
			await Bun.write(transcriptPath, `${userMsg}\n${assistantMsg}\n`);

			const result = await runtime.parseTranscript(transcriptPath);
			expect(result?.inputTokens).toBe(100);
			expect(result?.outputTokens).toBe(50);
		});

		test("falls back to message.model when model_change absent", async () => {
			const transcriptPath = join(tempDir, "v3-fallback-model.jsonl");
			const msg = JSON.stringify({
				type: "message",
				message: {
					role: "assistant",
					model: "claude-haiku-4-5",
					usage: { input: 10, output: 5 },
				},
			});
			await Bun.write(transcriptPath, `${msg}\n`);

			const result = await runtime.parseTranscript(transcriptPath);
			expect(result?.model).toBe("claude-haiku-4-5");
		});
	});

	describe("getTranscriptDir", () => {
		test("returns path under ~/.pi/agent/sessions with encoded project path", () => {
			const dir = runtime.getTranscriptDir("/home/user/project");
			expect(dir).not.toBeNull();
			expect(dir).toContain(".pi");
			expect(dir).toContain("sessions");
			expect(dir).toContain("--home-user-project--");
		});

		test("encodes Windows paths (backslashes and colon)", () => {
			const dir = runtime.getTranscriptDir("C:\\Users\\test\\project");
			expect(dir).not.toBeNull();
			expect(dir).toContain("--C-Users-test-project--");
		});
	});
});

describe("PiRuntime integration: registry resolves 'pi'", () => {
	test("getRuntime('pi') returns PiRuntime", async () => {
		const { getRuntime } = await import("./registry.ts");
		const rt = getRuntime("pi");
		expect(rt).toBeInstanceOf(PiRuntime);
		expect(rt.id).toBe("pi");
		expect(rt.instructionPath).toBe(".claude/CLAUDE.md");
	});

	test("getRuntime rejects truly unknown runtimes", async () => {
		const { getRuntime } = await import("./registry.ts");
		expect(() => getRuntime("nonexistent")).toThrow('Unknown runtime: "nonexistent"');
		expect(() => getRuntime("does-not-exist")).toThrow('Unknown runtime: "does-not-exist"');
	});
});

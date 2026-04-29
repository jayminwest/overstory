import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventStore } from "../events/store.ts";
import { cleanupTempDir } from "../test-helpers.ts";
import type { ResolvedModel } from "../types.ts";
import { ClaudeRuntime } from "./claude.ts";
import type { AgentEvent, DirectSpawnOpts, SpawnOpts } from "./types.ts";

describe("ClaudeRuntime", () => {
	const runtime = new ClaudeRuntime();

	describe("id and instructionPath", () => {
		test("id is 'claude'", () => {
			expect(runtime.id).toBe("claude");
		});

		test("instructionPath is .claude/CLAUDE.md", () => {
			expect(runtime.instructionPath).toBe(".claude/CLAUDE.md");
		});
	});

	describe("buildSpawnCommand", () => {
		test("basic command with bypass permission mode", () => {
			const opts: SpawnOpts = {
				model: "sonnet",
				permissionMode: "bypass",
				cwd: "/tmp/worktree",
				env: {},
			};
			const cmd = runtime.buildSpawnCommand(opts);
			expect(cmd).toBe("claude --model sonnet --permission-mode bypassPermissions");
		});

		test("basic command with ask permission mode", () => {
			const opts: SpawnOpts = {
				model: "opus",
				permissionMode: "ask",
				cwd: "/tmp/worktree",
				env: {},
			};
			const cmd = runtime.buildSpawnCommand(opts);
			expect(cmd).toBe("claude --model opus --permission-mode default");
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
				"claude --model sonnet --permission-mode bypassPermissions --append-system-prompt 'You are a builder agent.'",
			);
		});

		test("with appendSystemPrompt containing single quotes", () => {
			const opts: SpawnOpts = {
				model: "sonnet",
				permissionMode: "bypass",
				cwd: "/tmp/worktree",
				env: {},
				appendSystemPrompt: "Don't touch the user's files",
			};
			const cmd = runtime.buildSpawnCommand(opts);
			// POSIX single-quote escape: end quote, backslash-quote, start quote → '\\''
			expect(cmd).toContain("--append-system-prompt");
			expect(cmd).toBe(
				"claude --model sonnet --permission-mode bypassPermissions --append-system-prompt 'Don'\\''t touch the user'\\''s files'",
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
				`claude --model opus --permission-mode bypassPermissions --append-system-prompt "$(cat '/project/.overstory/agent-defs/coordinator.md')"`,
			);
		});

		test("appendSystemPromptFile with single quotes in path", () => {
			const opts: SpawnOpts = {
				model: "opus",
				permissionMode: "bypass",
				cwd: "/project",
				env: {},
				appendSystemPromptFile: "/project/it's a path/agent.md",
			};
			const cmd = runtime.buildSpawnCommand(opts);
			expect(cmd).toContain("$(cat '/project/it'\\''s a path/agent.md')");
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
				env: { ANTHROPIC_API_KEY: "sk-test-123" },
			};
			const cmd = runtime.buildSpawnCommand(opts);
			expect(cmd).not.toContain("/some/specific/path");
			expect(cmd).not.toContain("sk-test-123");
			expect(cmd).not.toContain("ANTHROPIC_API_KEY");
		});

		test("produces identical output for the same inputs (deterministic)", () => {
			const opts: SpawnOpts = {
				model: "sonnet",
				permissionMode: "bypass",
				cwd: "/tmp/worktree",
				env: {},
				appendSystemPrompt: "You are a scout.",
			};
			const cmd1 = runtime.buildSpawnCommand(opts);
			const cmd2 = runtime.buildSpawnCommand(opts);
			expect(cmd1).toBe(cmd2);
		});

		test("all model names pass through unchanged", () => {
			for (const model of ["sonnet", "opus", "haiku", "claude-sonnet-4-6", "openrouter/gpt-5"]) {
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

		test("systemPrompt field is ignored (only appendSystemPrompt is used)", () => {
			const opts: SpawnOpts = {
				model: "sonnet",
				permissionMode: "bypass",
				cwd: "/tmp",
				env: {},
				systemPrompt: "This should not appear",
			};
			const cmd = runtime.buildSpawnCommand(opts);
			expect(cmd).not.toContain("This should not appear");
			expect(cmd).not.toContain("--system-prompt");
		});
	});

	describe("buildPrintCommand", () => {
		test("basic command without model", () => {
			const argv = runtime.buildPrintCommand("Summarize this diff");
			expect(argv).toEqual(["claude", "--print", "-p", "Summarize this diff"]);
		});

		test("command with model override", () => {
			const argv = runtime.buildPrintCommand("Classify this error", "haiku");
			expect(argv).toEqual(["claude", "--print", "-p", "Classify this error", "--model", "haiku"]);
		});

		test("model undefined omits --model flag", () => {
			const argv = runtime.buildPrintCommand("Hello", undefined);
			expect(argv).not.toContain("--model");
		});
	});

	describe("detectReady", () => {
		test("returns loading for empty pane", () => {
			const state = runtime.detectReady("");
			expect(state).toEqual({ phase: "loading" });
		});

		test("returns loading for partial content (prompt only, no status bar)", () => {
			const state = runtime.detectReady("Welcome to Claude Code!\n\u276f");
			expect(state).toEqual({ phase: "loading" });
		});

		test("returns loading for partial content (status bar only, no prompt)", () => {
			const state = runtime.detectReady("bypass permissions");
			expect(state).toEqual({ phase: "loading" });
		});

		test("returns ready for prompt indicator ❯ + bypass permissions", () => {
			const state = runtime.detectReady("Welcome to Claude Code!\n\u276f\nbypass permissions");
			expect(state).toEqual({ phase: "ready" });
		});

		test('returns ready for Try " + bypass permissions', () => {
			const state = runtime.detectReady('Try "help" to get started\nbypass permissions');
			expect(state).toEqual({ phase: "ready" });
		});

		test("returns loading for prompt indicator + shift+tab (no bypass permissions)", () => {
			// shift+tab appears in ALL Claude Code sessions — it must NOT trigger ready
			const state = runtime.detectReady("Claude Code\n\u276f\nshift+tab to chat");
			expect(state).toEqual({ phase: "loading" });
		});

		test('returns loading for Try " + shift+tab (no bypass permissions)', () => {
			// False-positive scenario: shift+tab alone is not a reliable readiness signal
			const state = runtime.detectReady('Try "help"\nshift+tab');
			expect(state).toEqual({ phase: "loading" });
		});

		test("returns dialog for trust dialog", () => {
			const state = runtime.detectReady("Do you trust this folder? trust this folder");
			expect(state).toEqual({ phase: "dialog", action: "Enter" });
		});

		test("returns dialog for bypass permissions confirmation", () => {
			const state = runtime.detectReady(
				"WARNING: Claude Code running in Bypass Permissions mode\n❯ 1. No, exit\n2. Yes, I accept",
			);
			expect(state).toEqual({ phase: "dialog", action: "type:2" });
		});

		test("bypass permissions confirmation takes precedence over ready indicators", () => {
			const state = runtime.detectReady(
				"WARNING: Claude Code running in Bypass Permissions mode\n❯ 1. No, exit\n2. Yes, I accept\nbypass permissions",
			);
			expect(state).toEqual({ phase: "dialog", action: "type:2" });
		});

		test("trust dialog takes precedence over ready indicators", () => {
			const state = runtime.detectReady("trust this folder\n\u276f\nbypass permissions");
			expect(state).toEqual({ phase: "dialog", action: "Enter" });
		});

		test("returns loading for random pane content", () => {
			const state = runtime.detectReady("Loading Claude Code...\nPlease wait");
			expect(state).toEqual({ phase: "loading" });
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
				env: { ANTHROPIC_API_KEY: "sk-test-123", ANTHROPIC_BASE_URL: "https://api.example.com" },
			};
			const env = runtime.buildEnv(model);
			expect(env).toEqual({
				ANTHROPIC_API_KEY: "sk-test-123",
				ANTHROPIC_BASE_URL: "https://api.example.com",
			});
		});

		test("returns empty object when model.env is undefined", () => {
			const model: ResolvedModel = { model: "opus", env: undefined };
			const env = runtime.buildEnv(model);
			expect(env).toEqual({});
		});
	});

	describe("deployConfig", () => {
		let tempDir: string;

		beforeEach(async () => {
			tempDir = await mkdtemp(join(tmpdir(), "overstory-claude-test-"));
		});

		afterEach(async () => {
			await cleanupTempDir(tempDir);
		});

		test("writes overlay to .claude/CLAUDE.md when overlay is provided", async () => {
			const worktreePath = join(tempDir, "worktree");

			await runtime.deployConfig(
				worktreePath,
				{ content: "# Agent Overlay\nThis is the overlay content." },
				{
					agentName: "test-builder",
					capability: "builder",
					worktreePath,
				},
			);

			const overlayPath = join(worktreePath, ".claude", "CLAUDE.md");
			const content = await Bun.file(overlayPath).text();
			expect(content).toBe("# Agent Overlay\nThis is the overlay content.");
		});

		test("writes settings.local.json when overlay is provided", async () => {
			const worktreePath = join(tempDir, "worktree");

			await runtime.deployConfig(
				worktreePath,
				{ content: "# Overlay" },
				{
					agentName: "test-builder",
					capability: "builder",
					worktreePath,
				},
			);

			const settingsPath = join(worktreePath, ".claude", "settings.local.json");
			const exists = await Bun.file(settingsPath).exists();
			expect(exists).toBe(true);

			const parsed = JSON.parse(await Bun.file(settingsPath).text());
			expect(parsed.hooks).toBeDefined();
		});

		test("skips overlay write when overlay is undefined (hooks-only)", async () => {
			const worktreePath = join(tempDir, "worktree");

			await runtime.deployConfig(worktreePath, undefined, {
				agentName: "coordinator",
				capability: "coordinator",
				worktreePath,
			});

			// CLAUDE.md should NOT exist (no overlay written)
			const overlayPath = join(worktreePath, ".claude", "CLAUDE.md");
			const overlayExists = await Bun.file(overlayPath).exists();
			expect(overlayExists).toBe(false);

			// But settings.local.json SHOULD exist (hooks deployed)
			const settingsPath = join(worktreePath, ".claude", "settings.local.json");
			const settingsExists = await Bun.file(settingsPath).exists();
			expect(settingsExists).toBe(true);
		});

		test("settings.local.json contains agent name", async () => {
			const worktreePath = join(tempDir, "worktree");

			await runtime.deployConfig(worktreePath, undefined, {
				agentName: "my-supervisor",
				capability: "supervisor",
				worktreePath,
			});

			const settingsPath = join(worktreePath, ".claude", "settings.local.json");
			const content = await Bun.file(settingsPath).text();
			expect(content).toContain("my-supervisor");
			expect(content).not.toContain("{{AGENT_NAME}}");
		});

		test("settings.local.json is valid JSON with hooks", async () => {
			const worktreePath = join(tempDir, "worktree");

			await runtime.deployConfig(
				worktreePath,
				{ content: "# Overlay" },
				{
					agentName: "json-test",
					capability: "builder",
					worktreePath,
				},
			);

			const settingsPath = join(worktreePath, ".claude", "settings.local.json");
			const content = await Bun.file(settingsPath).text();
			const parsed = JSON.parse(content);
			expect(parsed.hooks).toBeDefined();
			expect(typeof parsed.hooks).toBe("object");
		});

		test("different capabilities produce different guard sets", async () => {
			const builderPath = join(tempDir, "builder-wt");
			const scoutPath = join(tempDir, "scout-wt");

			await runtime.deployConfig(
				builderPath,
				{ content: "# Builder" },
				{ agentName: "test-builder", capability: "builder", worktreePath: builderPath },
			);

			await runtime.deployConfig(
				scoutPath,
				{ content: "# Scout" },
				{ agentName: "test-scout", capability: "scout", worktreePath: scoutPath },
			);

			const builderSettings = await Bun.file(
				join(builderPath, ".claude", "settings.local.json"),
			).text();
			const scoutSettings = await Bun.file(
				join(scoutPath, ".claude", "settings.local.json"),
			).text();

			// Scout should have file-modification guards that builder doesn't
			// Scout is non-implementation, builder is implementation
			expect(scoutSettings).not.toBe(builderSettings);
		});

		test("writes PreToolUse-only settings.local.json when isHeadless is true", async () => {
			// overstory-e24b: headless Claude Code DOES dispatch settings.local.json hooks,
			// so the security guards (PreToolUse) must be deployed even in headless mode.
			// Non-PreToolUse events have headless equivalents (initial stdin prompt, mail
			// injection loop, stream-json parser) and are stripped to avoid duplicate work.
			const worktreePath = join(tempDir, "headless-wt");

			await runtime.deployConfig(
				worktreePath,
				{ content: "# Headless Overlay" },
				{
					agentName: "headless-builder",
					capability: "builder",
					worktreePath,
					isHeadless: true,
				},
			);

			// Overlay still written
			const overlayPath = join(worktreePath, ".claude", "CLAUDE.md");
			expect(await Bun.file(overlayPath).exists()).toBe(true);

			// Hooks file IS created in headless mode (reversal of overstory-1c32 design Q6)
			const settingsPath = join(worktreePath, ".claude", "settings.local.json");
			expect(await Bun.file(settingsPath).exists()).toBe(true);

			const parsed = JSON.parse(await Bun.file(settingsPath).text()) as {
				hooks: Record<string, unknown[]>;
			};

			// Only PreToolUse entries — SessionStart/UserPromptSubmit/PostToolUse/Stop/PreCompact stripped
			expect(Object.keys(parsed.hooks)).toEqual(["PreToolUse"]);
			expect(parsed.hooks.PreToolUse?.length ?? 0).toBeGreaterThan(0);

			// Sanity: the deployed PreToolUse guards include the destructive-command blocks
			// that were the operational concern in overstory-e24b.
			const serialized = JSON.stringify(parsed.hooks.PreToolUse);
			expect(serialized).toContain("git push is blocked");
			expect(serialized).toContain("git reset --hard");
			expect(serialized).toContain("Path boundary violation");
		});

		test("still writes settings.local.json when isHeadless is false", async () => {
			const worktreePath = join(tempDir, "tmux-wt");

			await runtime.deployConfig(
				worktreePath,
				{ content: "# Tmux Overlay" },
				{
					agentName: "tmux-builder",
					capability: "builder",
					worktreePath,
					isHeadless: false,
				},
			);

			const settingsPath = join(worktreePath, ".claude", "settings.local.json");
			const settingsExists = await Bun.file(settingsPath).exists();
			expect(settingsExists).toBe(true);
		});

		test("still writes settings.local.json when isHeadless is omitted (backward compat)", async () => {
			const worktreePath = join(tempDir, "default-wt");

			await runtime.deployConfig(worktreePath, undefined, {
				agentName: "default-agent",
				capability: "builder",
				worktreePath,
			});

			const settingsPath = join(worktreePath, ".claude", "settings.local.json");
			const settingsExists = await Bun.file(settingsPath).exists();
			expect(settingsExists).toBe(true);
		});
	});

	describe("parseTranscript", () => {
		let tempDir: string;

		beforeEach(async () => {
			tempDir = await mkdtemp(join(tmpdir(), "overstory-transcript-test-"));
		});

		afterEach(async () => {
			await cleanupTempDir(tempDir);
		});

		test("returns null for non-existent file", async () => {
			const result = await runtime.parseTranscript(join(tempDir, "does-not-exist.jsonl"));
			expect(result).toBeNull();
		});

		test("parses a valid transcript with one assistant turn", async () => {
			const transcriptPath = join(tempDir, "session.jsonl");
			const entry = JSON.stringify({
				type: "assistant",
				message: {
					model: "claude-sonnet-4-6",
					usage: {
						input_tokens: 100,
						output_tokens: 50,
						cache_read_input_tokens: 500,
						cache_creation_input_tokens: 200,
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

		test("aggregates multiple assistant turns", async () => {
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
			expect(result).not.toBeNull();
			expect(result?.inputTokens).toBe(300);
			expect(result?.outputTokens).toBe(125);
		});

		test("skips non-assistant entries", async () => {
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
			expect(result).not.toBeNull();
			expect(result?.inputTokens).toBe(50);
			expect(result?.outputTokens).toBe(25);
		});

		test("returns null for malformed file", async () => {
			const transcriptPath = join(tempDir, "bad.jsonl");
			await Bun.write(transcriptPath, "not json at all\n{broken");

			const result = await runtime.parseTranscript(transcriptPath);
			// parseTranscriptUsage should handle gracefully; result may have 0 tokens
			// If it throws, ClaudeRuntime catches and returns null
			if (result !== null) {
				expect(result.inputTokens).toBe(0);
				expect(result.outputTokens).toBe(0);
			}
		});
	});
});

describe("ClaudeRuntime integration: spawn command matches pre-refactor behavior", () => {
	const runtime = new ClaudeRuntime();

	test("sling-style spawn: bypass mode, no system prompt", () => {
		const cmd = runtime.buildSpawnCommand({
			model: "sonnet",
			permissionMode: "bypass",
			cwd: "/project/.overstory/worktrees/builder-1",
			env: { OVERSTORY_AGENT_NAME: "builder-1" },
		});
		// Pre-refactor: `claude --model ${model} --permission-mode bypassPermissions`
		expect(cmd).toBe("claude --model sonnet --permission-mode bypassPermissions");
	});

	test("coordinator-style spawn: bypass mode with appendSystemPrompt", () => {
		const baseDefinition = "# Coordinator\nYou are the coordinator agent.";
		const cmd = runtime.buildSpawnCommand({
			model: "opus",
			permissionMode: "bypass",
			cwd: "/project",
			appendSystemPrompt: baseDefinition,
			env: { OVERSTORY_AGENT_NAME: "coordinator" },
		});
		// Pre-refactor: `claude --model ${model} --permission-mode bypassPermissions --append-system-prompt '...'`
		expect(cmd).toBe(
			`claude --model opus --permission-mode bypassPermissions --append-system-prompt '# Coordinator\nYou are the coordinator agent.'`,
		);
	});

	test("supervisor-style spawn: identical to coordinator pattern", () => {
		const baseDefinition = "# Supervisor\nYou manage a project.";
		const cmd = runtime.buildSpawnCommand({
			model: "opus",
			permissionMode: "bypass",
			cwd: "/project",
			appendSystemPrompt: baseDefinition,
			env: { OVERSTORY_AGENT_NAME: "supervisor-1" },
		});
		expect(cmd).toContain("--model opus");
		expect(cmd).toContain("--permission-mode bypassPermissions");
		expect(cmd).toContain("--append-system-prompt");
		expect(cmd).toContain("# Supervisor");
	});

	test("monitor-style spawn: sonnet model with appendSystemPrompt", () => {
		const baseDefinition = "# Monitor\nYou patrol the fleet.";
		const cmd = runtime.buildSpawnCommand({
			model: "sonnet",
			permissionMode: "bypass",
			cwd: "/project",
			appendSystemPrompt: baseDefinition,
			env: { OVERSTORY_AGENT_NAME: "monitor" },
		});
		expect(cmd).toBe(
			`claude --model sonnet --permission-mode bypassPermissions --append-system-prompt '# Monitor\nYou patrol the fleet.'`,
		);
	});
});

describe("ClaudeRuntime integration: detectReady matches pre-refactor tmux behavior", () => {
	const runtime = new ClaudeRuntime();

	// These test cases mirror the exact pane content strings used in tmux.test.ts
	// to verify the callback produces identical behavior to the old hardcoded detection.

	test("ready: 'Try \"help\" to get started' + 'bypass permissions'", () => {
		const state = runtime.detectReady('Try "help" to get started\nbypass permissions');
		expect(state.phase).toBe("ready");
	});

	test("ready: ❯ + 'bypass permissions'", () => {
		const state = runtime.detectReady("Welcome to Claude Code!\n\n\u276f\nbypass permissions");
		expect(state.phase).toBe("ready");
	});

	test("loading: 'Try \"help\"' + 'shift+tab' (no bypass permissions — false-positive fix)", () => {
		// shift+tab appears in all Claude Code sessions, must not trigger ready without bypass permissions
		const state = runtime.detectReady('Try "help"\nshift+tab');
		expect(state.phase).toBe("loading");
	});

	test("not ready: only prompt (no status bar)", () => {
		const state = runtime.detectReady("Welcome to Claude Code!\n\u276f");
		expect(state.phase).toBe("loading");
	});

	test("not ready: only status bar (no prompt)", () => {
		const state = runtime.detectReady("bypass permissions");
		expect(state.phase).toBe("loading");
	});

	test("dialog: trust this folder", () => {
		const state = runtime.detectReady("Do you trust this folder? trust this folder");
		expect(state.phase).toBe("dialog");
		expect((state as { phase: "dialog"; action: string }).action).toBe("Enter");
	});

	test("dialog: bypass permissions confirmation", () => {
		const state = runtime.detectReady(
			"WARNING: Claude Code running in Bypass Permissions mode\n❯ 1. No, exit\n2. Yes, I accept",
		);
		expect(state.phase).toBe("dialog");
		expect((state as { phase: "dialog"; action: string }).action).toBe("type:2");
	});
});

describe("ClaudeRuntime integration: buildEnv matches pre-refactor env injection", () => {
	const runtime = new ClaudeRuntime();

	test("native Anthropic model: passes env through", () => {
		const model: ResolvedModel = {
			model: "sonnet",
			env: { ANTHROPIC_API_KEY: "sk-ant-test" },
		};
		const env = runtime.buildEnv(model);
		expect(env).toEqual({ ANTHROPIC_API_KEY: "sk-ant-test" });
	});

	test("gateway model: passes gateway env through", () => {
		const model: ResolvedModel = {
			model: "openrouter/gpt-5",
			env: { OPENROUTER_API_KEY: "sk-or-test", OPENAI_BASE_URL: "https://openrouter.ai/api/v1" },
		};
		const env = runtime.buildEnv(model);
		expect(env).toEqual({
			OPENROUTER_API_KEY: "sk-or-test",
			OPENAI_BASE_URL: "https://openrouter.ai/api/v1",
		});
	});

	test("model without env: returns empty object (safe to spread)", () => {
		const model: ResolvedModel = { model: "sonnet" };
		const env = runtime.buildEnv(model);
		expect(env).toEqual({});
		// Must be safe to spread into createSession env
		const combined = { ...env, OVERSTORY_AGENT_NAME: "builder-1" };
		expect(combined).toEqual({ OVERSTORY_AGENT_NAME: "builder-1" });
	});
});

describe("ClaudeRuntime integration: registry resolves 'claude' as default", () => {
	// Import registry here to test the full resolution path
	test("getRuntime() returns ClaudeRuntime", async () => {
		const { getRuntime } = await import("./registry.ts");
		const rt = getRuntime();
		expect(rt).toBeInstanceOf(ClaudeRuntime);
		expect(rt.id).toBe("claude");
		expect(rt.instructionPath).toBe(".claude/CLAUDE.md");
	});

	test("getRuntime('claude') returns ClaudeRuntime", async () => {
		const { getRuntime } = await import("./registry.ts");
		const rt = getRuntime("claude");
		expect(rt).toBeInstanceOf(ClaudeRuntime);
	});

	test("getRuntime rejects unknown runtimes", async () => {
		const { getRuntime } = await import("./registry.ts");
		expect(() => getRuntime("nonexistent-runtime")).toThrow(
			'Unknown runtime: "nonexistent-runtime"',
		);
		expect(() => getRuntime("does-not-exist")).toThrow('Unknown runtime: "does-not-exist"');
	});
});

// ─── buildDirectSpawn ────────────────────────────────────────────────────────

describe("ClaudeRuntime.buildDirectSpawn", () => {
	const runtime = new ClaudeRuntime();

	test("returns fixed headless argv without model", () => {
		const opts: DirectSpawnOpts = {
			cwd: "/worktree",
			env: {},
			instructionPath: ".claude/CLAUDE.md",
		};
		expect(runtime.buildDirectSpawn(opts)).toEqual([
			"claude",
			"-p",
			"--output-format",
			"stream-json",
			"--input-format",
			"stream-json",
			"--verbose",
			"--strict-mcp-config",
			"--permission-mode",
			"bypassPermissions",
		]);
	});

	test("appends --model when model is specified", () => {
		const opts: DirectSpawnOpts = {
			cwd: "/worktree",
			env: {},
			instructionPath: ".claude/CLAUDE.md",
			model: "claude-sonnet-4-6",
		};
		const argv = runtime.buildDirectSpawn(opts);
		expect(argv.at(-2)).toBe("--model");
		expect(argv.at(-1)).toBe("claude-sonnet-4-6");
		expect(argv).toHaveLength(12);
	});

	test("does not include instructionPath in argv", () => {
		const opts: DirectSpawnOpts = {
			cwd: "/worktree",
			env: {},
			instructionPath: "/secret/path/CLAUDE.md",
		};
		const argv = runtime.buildDirectSpawn(opts);
		expect(argv.join(" ")).not.toContain("secret");
		expect(argv.join(" ")).not.toContain("CLAUDE.md");
	});

	test("model undefined omits --model flag", () => {
		const opts: DirectSpawnOpts = {
			cwd: "/worktree",
			env: {},
			instructionPath: ".claude/CLAUDE.md",
			model: undefined,
		};
		expect(runtime.buildDirectSpawn(opts)).not.toContain("--model");
	});

	test("resumeSessionId emits --resume <id> after --model", () => {
		const opts: DirectSpawnOpts = {
			cwd: "/worktree",
			env: {},
			instructionPath: ".claude/CLAUDE.md",
			model: "claude-sonnet-4-6",
			resumeSessionId: "sess-resume-abc",
		};
		const argv = runtime.buildDirectSpawn(opts);
		// --model and its value precede --resume and its value
		const modelIdx = argv.indexOf("--model");
		const resumeIdx = argv.indexOf("--resume");
		expect(modelIdx).toBeGreaterThan(-1);
		expect(resumeIdx).toBeGreaterThan(modelIdx + 1);
		expect(argv[resumeIdx + 1]).toBe("sess-resume-abc");
		// Trailing pair is --resume <id>
		expect(argv.at(-2)).toBe("--resume");
		expect(argv.at(-1)).toBe("sess-resume-abc");
	});

	test("omits --resume when resumeSessionId is undefined", () => {
		const opts: DirectSpawnOpts = {
			cwd: "/worktree",
			env: {},
			instructionPath: ".claude/CLAUDE.md",
		};
		expect(runtime.buildDirectSpawn(opts)).not.toContain("--resume");
	});

	test("omits --resume when resumeSessionId is empty string", () => {
		const opts: DirectSpawnOpts = {
			cwd: "/worktree",
			env: {},
			instructionPath: ".claude/CLAUDE.md",
			resumeSessionId: "",
		};
		expect(runtime.buildDirectSpawn(opts)).not.toContain("--resume");
	});

	test("omits --resume when resumeSessionId is null", () => {
		const opts: DirectSpawnOpts = {
			cwd: "/worktree",
			env: {},
			instructionPath: ".claude/CLAUDE.md",
			resumeSessionId: null,
		};
		expect(runtime.buildDirectSpawn(opts)).not.toContain("--resume");
	});
});

// ─── parseEvents unit tests ──────────────────────────────────────────────────

function toStream(s: string): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(s));
			controller.close();
		},
	});
}

function toChunkedStream(chunks: string[]): ReadableStream<Uint8Array> {
	const enc = new TextEncoder();
	return new ReadableStream({
		start(controller) {
			for (const c of chunks) controller.enqueue(enc.encode(c));
			controller.close();
		},
	});
}

async function collectEvents(stream: ReadableStream<Uint8Array>): Promise<AgentEvent[]> {
	const rt = new ClaudeRuntime();
	const events: AgentEvent[] = [];
	for await (const ev of rt.parseEvents(stream)) {
		events.push(ev);
	}
	return events;
}

describe("ClaudeRuntime.parseEvents unit", () => {
	test("empty stream yields no events", async () => {
		const events = await collectEvents(toStream(""));
		expect(events).toHaveLength(0);
	});

	test("system message → status event with sessionId and subtype", async () => {
		const line = JSON.stringify({ type: "system", subtype: "init", session_id: "sess-abc" });
		const events = await collectEvents(toStream(`${line}\n`));
		expect(events).toHaveLength(1);
		const ev = events[0];
		expect(ev?.type).toBe("status");
		expect(ev?.sessionId).toBe("sess-abc");
		expect(ev?.subtype).toBe("init");
		expect(typeof ev?.timestamp).toBe("string");
	});

	test("assistant text block → assistant_message with text, model, usage", async () => {
		const line = JSON.stringify({
			type: "assistant",
			message: {
				model: "claude-sonnet-4-6",
				content: [{ type: "text", text: "hello world" }],
				usage: { input_tokens: 10, output_tokens: 5 },
			},
		});
		const events = await collectEvents(toStream(`${line}\n`));
		expect(events).toHaveLength(1);
		const ev = events[0];
		expect(ev?.type).toBe("assistant_message");
		expect(ev?.text).toBe("hello world");
		expect(ev?.model).toBe("claude-sonnet-4-6");
		expect((ev?.usage as Record<string, number>)?.input_tokens).toBe(10);
	});

	test("assistant text block without model/usage omits those fields", async () => {
		const line = JSON.stringify({
			type: "assistant",
			message: { content: [{ type: "text", text: "bare text" }] },
		});
		const events = await collectEvents(toStream(`${line}\n`));
		expect(events).toHaveLength(1);
		const ev = events[0];
		expect(ev).toBeDefined();
		if (!ev) return;
		expect(ev.type).toBe("assistant_message");
		expect(ev.text).toBe("bare text");
		expect(Object.hasOwn(ev, "model")).toBe(false);
		expect(Object.hasOwn(ev, "usage")).toBe(false);
	});

	test("assistant tool_use block → tool_use event with callId, name, input", async () => {
		const line = JSON.stringify({
			type: "assistant",
			message: {
				content: [
					{
						type: "tool_use",
						id: "call-1",
						name: "Read",
						input: { path: "/tmp/foo.ts" },
					},
				],
			},
		});
		const events = await collectEvents(toStream(`${line}\n`));
		expect(events).toHaveLength(1);
		const ev = events[0];
		expect(ev?.type).toBe("tool_use");
		expect(ev?.callId).toBe("call-1");
		expect(ev?.name).toBe("Read");
		expect((ev?.input as Record<string, string>)?.path).toBe("/tmp/foo.ts");
	});

	test("assistant thinking block is skipped", async () => {
		const line = JSON.stringify({
			type: "assistant",
			message: {
				content: [{ type: "thinking", thinking: "let me think" }],
			},
		});
		const events = await collectEvents(toStream(`${line}\n`));
		expect(events).toHaveLength(0);
	});

	test("user tool_result block → tool_result event with toolUseId and content", async () => {
		const line = JSON.stringify({
			type: "user",
			message: {
				content: [
					{
						type: "tool_result",
						tool_use_id: "call-1",
						content: "file contents here",
					},
				],
			},
		});
		const events = await collectEvents(toStream(`${line}\n`));
		expect(events).toHaveLength(1);
		const ev = events[0];
		expect(ev?.type).toBe("tool_result");
		expect(ev?.toolUseId).toBe("call-1");
		expect(ev?.content).toBe("file contents here");
	});

	test("result message → result event with all fields", async () => {
		const line = JSON.stringify({
			type: "result",
			session_id: "sess-xyz",
			result: "task complete",
			is_error: false,
			duration_ms: 2500,
			num_turns: 3,
		});
		const events = await collectEvents(toStream(`${line}\n`));
		expect(events).toHaveLength(1);
		const ev = events[0];
		expect(ev?.type).toBe("result");
		expect(ev?.sessionId).toBe("sess-xyz");
		expect(ev?.result).toBe("task complete");
		expect(ev?.isError).toBe(false);
		expect(ev?.durationMs).toBe(2500);
		expect(ev?.numTurns).toBe(3);
	});

	test("unknown message type (log, control_request) is skipped", async () => {
		const lines = [
			JSON.stringify({ type: "log", message: "some log line" }),
			JSON.stringify({ type: "control_request", payload: {} }),
		].join("\n");
		const events = await collectEvents(toStream(`${lines}\n`));
		expect(events).toHaveLength(0);
	});

	test("multi-block assistant message [text, tool_use, text] yields 3 events in order", async () => {
		const line = JSON.stringify({
			type: "assistant",
			message: {
				content: [
					{ type: "text", text: "first" },
					{ type: "tool_use", id: "c1", name: "Bash", input: { cmd: "ls" } },
					{ type: "text", text: "second" },
				],
			},
		});
		const events = await collectEvents(toStream(`${line}\n`));
		expect(events).toHaveLength(3);
		expect(events[0]?.type).toBe("assistant_message");
		expect(events[0]?.text).toBe("first");
		expect(events[1]?.type).toBe("tool_use");
		expect(events[1]?.name).toBe("Bash");
		expect(events[2]?.type).toBe("assistant_message");
		expect(events[2]?.text).toBe("second");
	});

	test("user message with multiple tool_result blocks yields one event per block", async () => {
		const line = JSON.stringify({
			type: "user",
			message: {
				content: [
					{ type: "tool_result", tool_use_id: "c1", content: "result 1" },
					{ type: "tool_result", tool_use_id: "c2", content: "result 2" },
				],
			},
		});
		const events = await collectEvents(toStream(`${line}\n`));
		expect(events).toHaveLength(2);
		expect(events[0]?.toolUseId).toBe("c1");
		expect(events[1]?.toolUseId).toBe("c2");
	});

	test("partial lines (chunked reads) are buffered until newline arrives", async () => {
		const line = JSON.stringify({ type: "system", subtype: "init", session_id: "sess-chunked" });
		// Split the JSON at an arbitrary byte boundary
		const mid = Math.floor(line.length / 2);
		const chunks = [line.slice(0, mid), line.slice(mid), "\n"];
		const events = await collectEvents(toChunkedStream(chunks));
		expect(events).toHaveLength(1);
		expect(events[0]?.type).toBe("status");
		expect(events[0]?.sessionId).toBe("sess-chunked");
	});

	test("malformed lines are silently skipped", async () => {
		const good = JSON.stringify({ type: "system", subtype: "init", session_id: "s1" });
		const input = `${good}\nnot json at all\n{broken\n`;
		const events = await collectEvents(toStream(input));
		expect(events).toHaveLength(1);
		expect(events[0]?.type).toBe("status");
	});

	test("trailing data without newline is flushed", async () => {
		const line = JSON.stringify({ type: "system", subtype: "init", session_id: "s-trailing" });
		// No trailing newline
		const events = await collectEvents(toStream(line));
		expect(events).toHaveLength(1);
		expect(events[0]?.sessionId).toBe("s-trailing");
	});

	test("empty lines between events are ignored", async () => {
		const l1 = JSON.stringify({ type: "system", subtype: "init", session_id: "s1" });
		const l2 = JSON.stringify({
			type: "result",
			session_id: "s1",
			result: "ok",
			is_error: false,
			duration_ms: 1,
			num_turns: 1,
		});
		const input = `${l1}\n\n\n${l2}\n`;
		const events = await collectEvents(toStream(input));
		expect(events).toHaveLength(2);
	});

	test("multiple valid lines in sequence yield events in order", async () => {
		const l1 = JSON.stringify({ type: "system", subtype: "init", session_id: "s1" });
		const l2 = JSON.stringify({
			type: "assistant",
			message: { content: [{ type: "text", text: "hi" }] },
		});
		const l3 = JSON.stringify({
			type: "result",
			session_id: "s1",
			result: "done",
			is_error: false,
			duration_ms: 0,
			num_turns: 1,
		});
		const events = await collectEvents(toStream(`${l1}\n${l2}\n${l3}\n`));
		expect(events[0]?.type).toBe("status");
		expect(events[1]?.type).toBe("assistant_message");
		expect(events[2]?.type).toBe("result");
	});
});

// ─── parseEvents onSessionId hook ────────────────────────────────────────────

describe("ClaudeRuntime.parseEvents onSessionId hook", () => {
	test("fires onSessionId once on first system event", async () => {
		const rt = new ClaudeRuntime();
		const called: string[] = [];
		const line = JSON.stringify({ type: "system", subtype: "init", session_id: "sess-abc" });
		for await (const _ of rt.parseEvents(toStream(`${line}\n`), {
			onSessionId: (sid) => called.push(sid),
		})) {
			// consume
		}
		expect(called).toHaveLength(1);
		expect(called[0]).toBe("sess-abc");
	});

	test("does not fire when stream ends before any session_id event", async () => {
		const rt = new ClaudeRuntime();
		const called: string[] = [];
		const line = JSON.stringify({
			type: "assistant",
			message: { content: [{ type: "text", text: "hello" }] },
		});
		for await (const _ of rt.parseEvents(toStream(`${line}\n`), {
			onSessionId: (sid) => called.push(sid),
		})) {
			// consume
		}
		expect(called).toHaveLength(0);
	});

	test("does not fire on subsequent events with same/different session_id", async () => {
		const rt = new ClaudeRuntime();
		const called: string[] = [];
		const l1 = JSON.stringify({ type: "system", subtype: "init", session_id: "sess-abc" });
		const l2 = JSON.stringify({
			type: "result",
			session_id: "sess-abc",
			result: "ok",
			is_error: false,
			duration_ms: 1,
			num_turns: 1,
		});
		for await (const _ of rt.parseEvents(toStream(`${l1}\n${l2}\n`), {
			onSessionId: (sid) => called.push(sid),
		})) {
			// consume
		}
		expect(called).toHaveLength(1);
		expect(called[0]).toBe("sess-abc");
	});

	test("callback errors do not crash the parser", async () => {
		const rt = new ClaudeRuntime();
		const sysLine = JSON.stringify({ type: "system", subtype: "init", session_id: "sess-err" });
		const textLine = JSON.stringify({
			type: "assistant",
			message: { content: [{ type: "text", text: "after error" }] },
		});
		const events: AgentEvent[] = [];
		for await (const ev of rt.parseEvents(toStream(`${sysLine}\n${textLine}\n`), {
			onSessionId: () => {
				throw new Error("intentional consumer error");
			},
		})) {
			events.push(ev);
		}
		// Both events should still be yielded despite the callback throwing
		expect(events).toHaveLength(2);
		expect(events[0]?.type).toBe("status");
		expect(events[1]?.type).toBe("assistant_message");
	});

	test("callback runs synchronously before next yield", async () => {
		const rt = new ClaudeRuntime();
		const order: string[] = [];
		const sysLine = JSON.stringify({ type: "system", subtype: "init", session_id: "sess-sync" });
		const textLine = JSON.stringify({
			type: "assistant",
			message: { content: [{ type: "text", text: "second" }] },
		});
		for await (const ev of rt.parseEvents(toStream(`${sysLine}\n${textLine}\n`), {
			onSessionId: (sid) => order.push(`callback:${sid}`),
		})) {
			order.push(`event:${ev.type}`);
		}
		// callback must appear before the second event (synchronous inline)
		expect(order[0]).toBe("callback:sess-sync");
		expect(order[1]).toBe("event:status");
		expect(order[2]).toBe("event:assistant_message");
	});
});

// ─── parseEvents batching tests ─────────────────────────────────────────────

function controllableStream(): {
	stream: ReadableStream<Uint8Array>;
	enqueue: (data: string) => void;
	close: () => void;
} {
	let ctrl!: ReadableStreamDefaultController<Uint8Array>;
	const enc = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		start(c) {
			ctrl = c;
		},
	});
	return {
		stream,
		enqueue: (data: string) => ctrl.enqueue(enc.encode(data)),
		close: () => ctrl.close(),
	};
}

async function collectWithOpts(
	stream: ReadableStream<Uint8Array>,
	opts: { flushIntervalMs?: number; flushSizeBytes?: number },
): Promise<AgentEvent[]> {
	const rt = new ClaudeRuntime();
	const events: AgentEvent[] = [];
	for await (const ev of rt.parseEvents(stream, opts)) {
		events.push(ev);
	}
	return events;
}

describe("ClaudeRuntime.parseEvents batching", () => {
	function assistantText(text: string, model?: string, usage?: Record<string, number>): string {
		const message: Record<string, unknown> = { content: [{ type: "text", text }] };
		if (model !== undefined) message.model = model;
		if (usage !== undefined) message.usage = usage;
		return JSON.stringify({ type: "assistant", message });
	}

	function assistantMixed(blocks: unknown[]): string {
		return JSON.stringify({ type: "assistant", message: { content: blocks } });
	}

	function systemLine(sessionId: string): string {
		return JSON.stringify({ type: "system", subtype: "init", session_id: sessionId });
	}

	function resultLine(sessionId: string): string {
		return JSON.stringify({
			type: "result",
			session_id: sessionId,
			result: "done",
			is_error: false,
			duration_ms: 0,
			num_turns: 1,
		});
	}

	test("1: multiple text fragments within window batch into one event", async () => {
		const fragments = ["hello", " ", "world", "!", " bye"];
		const lines = `${fragments.map((t) => assistantText(t)).join("\n")}\n`;
		const events = await collectWithOpts(toStream(lines), { flushIntervalMs: 500 });
		expect(events).toHaveLength(1);
		expect(events[0]?.type).toBe("assistant_message");
		expect(events[0]?.text).toBe("hello world! bye");
		expect(typeof events[0]?.timestamp).toBe("string");
	});

	test("2: timer flush: first batch emitted after flushIntervalMs when stream is idle", async () => {
		const { stream, enqueue, close } = controllableStream();
		const collectPromise = collectWithOpts(stream, { flushIntervalMs: 50 });
		enqueue(`${assistantText("first")}\n`);
		await new Promise<void>((r) => setTimeout(r, 200));
		enqueue(`${assistantText("second")}\n`);
		close();
		const events = await collectPromise;
		expect(events).toHaveLength(2);
		expect(events[0]?.text).toBe("first");
		expect(events[1]?.text).toBe("second");
	});

	test("3: tool_use mid-stream flushes pending text first", async () => {
		const line = assistantMixed([
			{ type: "text", text: "before tool" },
			{ type: "tool_use", id: "c1", name: "Read", input: {} },
		]);
		const events = await collectWithOpts(toStream(`${line}\n`), { flushIntervalMs: 500 });
		expect(events).toHaveLength(2);
		expect(events[0]?.type).toBe("assistant_message");
		expect(events[0]?.text).toBe("before tool");
		expect(events[1]?.type).toBe("tool_use");
		expect(events[1]?.name).toBe("Read");
	});

	test("4: multi-block [text, tool_use, text] preserves in-order delivery", async () => {
		const line = assistantMixed([
			{ type: "text", text: "first" },
			{ type: "tool_use", id: "c1", name: "Bash", input: {} },
			{ type: "text", text: "second" },
		]);
		const events = await collectWithOpts(toStream(`${line}\n`), { flushIntervalMs: 500 });
		expect(events).toHaveLength(3);
		expect(events[0]?.type).toBe("assistant_message");
		expect(events[0]?.text).toBe("first");
		expect(events[1]?.type).toBe("tool_use");
		expect(events[1]?.name).toBe("Bash");
		expect(events[2]?.type).toBe("assistant_message");
		expect(events[2]?.text).toBe("second");
	});

	test("5: stream-end flushes pending text when no other flush trigger fires", async () => {
		const line = assistantText("only text");
		const events = await collectWithOpts(toStream(`${line}\n`), { flushIntervalMs: 500 });
		expect(events).toHaveLength(1);
		expect(events[0]?.type).toBe("assistant_message");
		expect(events[0]?.text).toBe("only text");
	});

	test("6: size cap flush: fragments summing beyond cap produce multiple batched events", async () => {
		const textA = "a".repeat(60);
		const textB = "b".repeat(60);
		const lines = `${assistantText(textA)}\n${assistantText(textB)}\n`;
		const events = await collectWithOpts(toStream(lines), {
			flushIntervalMs: 500,
			flushSizeBytes: 100,
		});
		expect(events.length).toBeGreaterThanOrEqual(2);
		const allText = events.map((e) => e.text as string).join("");
		expect(allText).toBe(textA + textB);
	});

	test("7: single fragment exceeding size cap is emitted as its own batch", async () => {
		const bigText = "x".repeat(200); // 200 bytes > cap of 100
		const line = assistantText(bigText);
		const events = await collectWithOpts(toStream(`${line}\n`), {
			flushIntervalMs: 500,
			flushSizeBytes: 100,
		});
		expect(events).toHaveLength(1);
		expect(events[0]?.text).toBe(bigText);
	});

	test("8: non-text events between text batches reset the batch", async () => {
		const lines = `${[
			assistantText("alpha"),
			systemLine("s1"),
			assistantText("beta"),
			resultLine("s1"),
		].join("\n")}\n`;
		const events = await collectWithOpts(toStream(lines), { flushIntervalMs: 500 });
		expect(events).toHaveLength(4);
		expect(events[0]?.type).toBe("assistant_message");
		expect(events[0]?.text).toBe("alpha");
		expect(events[1]?.type).toBe("status");
		expect(events[2]?.type).toBe("assistant_message");
		expect(events[2]?.text).toBe("beta");
		expect(events[3]?.type).toBe("result");
	});

	test("9: batched event model/usage use the latest contributing message (latest wins)", async () => {
		const msg1 = assistantText("hello ", "model-A", { input_tokens: 10, output_tokens: 5 });
		const msg2 = assistantText("world", "model-B", { input_tokens: 20, output_tokens: 10 });
		const lines = `${msg1}\n${msg2}\n`;
		const events = await collectWithOpts(toStream(lines), { flushIntervalMs: 500 });
		expect(events).toHaveLength(1);
		expect(events[0]?.model).toBe("model-B");
		expect((events[0]?.usage as Record<string, number>)?.input_tokens).toBe(20);
	});

	test("10: model/usage are omitted on batched event when no contributing message provided them", async () => {
		const msg = assistantText("no model here");
		const events = await collectWithOpts(toStream(`${msg}\n`), { flushIntervalMs: 500 });
		expect(events).toHaveLength(1);
		expect(Object.hasOwn(events[0] ?? {}, "model")).toBe(false);
		expect(Object.hasOwn(events[0] ?? {}, "usage")).toBe(false);
	});
});

// ─── parseEvents + EventStore integration test ───────────────────────────────

describe("ClaudeRuntime integration: parseEvents + EventStore", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "claude-parse-events-int-"));
	});

	afterEach(async () => {
		await cleanupTempDir(tempDir);
	});

	test("fixture events land in EventStore and round-trip correctly", async () => {
		const fixturePath = join(import.meta.dir, "__fixtures__", "claude-stream-fixture.ts");
		const proc = Bun.spawn(["bun", fixturePath], { stdout: "pipe" });

		const runtime = new ClaudeRuntime();
		const collected: AgentEvent[] = [];
		for await (const ev of runtime.parseEvents(proc.stdout)) {
			collected.push(ev);
		}
		await proc.exited;

		// Fixture emits: system init, assistant text, result → 3 events
		expect(collected).toHaveLength(3);
		expect(collected[0]?.type).toBe("status");
		expect(collected[0]?.sessionId).toBe("sess-123");
		expect(collected[1]?.type).toBe("assistant_message");
		expect(collected[1]?.text).toBe("hello");
		expect(collected[2]?.type).toBe("result");
		expect(collected[2]?.result).toBe("done");

		// Insert each event into a fresh EventStore
		const dbPath = join(tempDir, "events.db");
		const store = createEventStore(dbPath);
		const agentName = "fixture-agent";

		for (const ev of collected) {
			store.insert({
				runId: null,
				agentName,
				sessionId: typeof ev.sessionId === "string" ? ev.sessionId : null,
				eventType: "custom",
				toolName: typeof ev.name === "string" ? ev.name : null,
				toolArgs: null,
				toolDurationMs: null,
				level: "info",
				data: JSON.stringify(ev),
			});
		}

		// Query and verify count, order, and data round-trip
		const stored = store.getByAgent(agentName);
		expect(stored).toHaveLength(3);

		for (let i = 0; i < stored.length; i++) {
			const row = stored[i];
			const original = collected[i];
			if (!row || !original) continue;
			expect(row.data).not.toBeNull();
			const parsed = JSON.parse(row.data as string) as AgentEvent;
			expect(parsed.type).toBe(original.type);
		}
	});
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTempDir } from "../test-helpers.ts";
import type { ResolvedModel } from "../types.ts";
import { ClaudeRuntime } from "./claude.ts";
import type { SpawnOpts } from "./types.ts";

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

		test("with resumeSessionId adds --resume flag", () => {
			const opts: SpawnOpts = {
				model: "sonnet",
				permissionMode: "bypass",
				cwd: "/tmp/worktree",
				env: {},
				resumeSessionId: "abc-123-session",
			};
			const cmd = runtime.buildSpawnCommand(opts);
			expect(cmd).toContain("--resume abc-123-session");
			expect(cmd).toBe(
				"claude --model sonnet --permission-mode bypassPermissions --resume abc-123-session",
			);
		});

		test("resumeSessionId combined with appendSystemPrompt", () => {
			const opts: SpawnOpts = {
				model: "opus",
				permissionMode: "bypass",
				cwd: "/tmp/worktree",
				env: {},
				resumeSessionId: "session-456",
				appendSystemPrompt: "Continue work.",
			};
			const cmd = runtime.buildSpawnCommand(opts);
			expect(cmd).toContain("--resume session-456");
			expect(cmd).toContain("--append-system-prompt 'Continue work.'");
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

		test("returns ready for prompt indicator + shift+tab", () => {
			const state = runtime.detectReady("Claude Code\n\u276f\nshift+tab to chat");
			expect(state).toEqual({ phase: "ready" });
		});

		test('returns ready for Try " + shift+tab', () => {
			const state = runtime.detectReady('Try "help"\nshift+tab');
			expect(state).toEqual({ phase: "ready" });
		});

		test("returns dialog for trust dialog", () => {
			const state = runtime.detectReady("Do you trust this folder? trust this folder");
			expect(state).toEqual({ phase: "dialog", action: "Enter" });
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

	test("ready: 'Try \"help\"' + 'shift+tab'", () => {
		const state = runtime.detectReady('Try "help"\nshift+tab');
		expect(state.phase).toBe("ready");
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
		expect(() => getRuntime("aider")).toThrow('Unknown runtime: "aider"');
		expect(() => getRuntime("cursor")).toThrow('Unknown runtime: "cursor"');
	});
});

describe("ClaudeRuntime detectRateLimit", () => {
	const runtime = new ClaudeRuntime();

	describe("detectRateLimit", () => {
		test("detects usage cap with minute reset", () => {
			const result = runtime.detectRateLimit("You've hit your limit. Usage resets in 45 minutes.");
			expect(result.limited).toBe(true);
			if (result.limited) {
				expect(result.resumesAt).not.toBeNull();
				expect(result.message).toContain("usage cap");
			}
		});

		test("detects usage cap with time reset (PM)", () => {
			const result = runtime.detectRateLimit("You've hit your limit. Resets 3:00 PM");
			expect(result.limited).toBe(true);
			if (result.limited) {
				expect(result.resumesAt).not.toBeNull();
				expect(result.message).toContain("usage cap");
			}
		});

		test("detects usage cap without parseable time", () => {
			const result = runtime.detectRateLimit("Usage cap reached. Please wait.");
			expect(result.limited).toBe(true);
			if (result.limited) {
				expect(result.resumesAt).toBeNull();
				expect(result.message).toContain("usage cap");
			}
		});

		test("detects rate-limit-options dialog", () => {
			const result = runtime.detectRateLimit(
				'<div class="rate-limit-options">Choose an option</div>',
			);
			expect(result.limited).toBe(true);
			if (result.limited) {
				expect(result.message).toContain("rate limited");
			}
		});

		test("detects generic rate limit text", () => {
			const result = runtime.detectRateLimit("Error: rate limit exceeded");
			expect(result.limited).toBe(true);
		});

		test("returns not limited for normal output", () => {
			const result = runtime.detectRateLimit(
				"✓ File written successfully\n$ bun test\n5 pass, 0 fail",
			);
			expect(result.limited).toBe(false);
		});

		test("returns not limited for empty string", () => {
			const result = runtime.detectRateLimit("");
			expect(result.limited).toBe(false);
		});
	});
});

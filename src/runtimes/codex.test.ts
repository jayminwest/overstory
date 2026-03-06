import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedModel } from "../types.ts";
import { CodexRuntime } from "./codex.ts";
import type { SpawnOpts } from "./types.ts";

describe("CodexRuntime", () => {
	const runtime = new CodexRuntime();

	describe("id and instructionPath", () => {
		test("id is 'codex'", () => {
			expect(runtime.id).toBe("codex");
		});

		test("instructionPath is AGENTS.md", () => {
			expect(runtime.instructionPath).toBe("AGENTS.md");
		});
	});

	describe("buildSpawnCommand", () => {
		test("basic command uses interactive codex with --full-auto", () => {
			const opts: SpawnOpts = {
				model: "gpt-5-codex",
				permissionMode: "bypass",
				cwd: "/tmp/worktree",
				env: {},
			};
			const cmd = runtime.buildSpawnCommand(opts);
			expect(cmd).toContain("codex --full-auto");
			expect(cmd).toContain("--model gpt-5-codex");
			expect(cmd).toContain("Read AGENTS.md");
		});

		test("manifest aliases omit --model so codex uses default configured model", () => {
			for (const alias of ["sonnet", "opus", "haiku"]) {
				const opts: SpawnOpts = {
					model: alias,
					permissionMode: "bypass",
					cwd: "/tmp/worktree",
					env: {},
				};
				const cmd = runtime.buildSpawnCommand(opts);
				expect(cmd).toContain("codex --full-auto");
				expect(cmd).not.toContain(" --model ");
			}
		});

		test("permissionMode is NOT included in command (Codex uses OS sandbox)", () => {
			const opts: SpawnOpts = {
				model: "gpt-5-codex",
				permissionMode: "bypass",
				cwd: "/tmp/worktree",
				env: {},
			};
			const cmd = runtime.buildSpawnCommand(opts);
			expect(cmd).not.toContain("--permission-mode");
			expect(cmd).not.toContain("bypassPermissions");
		});

		test("ask permissionMode also excluded (OS sandbox enforces security)", () => {
			const opts: SpawnOpts = {
				model: "gpt-5-codex",
				permissionMode: "ask",
				cwd: "/tmp/worktree",
				env: {},
			};
			const cmd = runtime.buildSpawnCommand(opts);
			expect(cmd).not.toContain("--permission-mode");
		});

		test("with appendSystemPrompt prepends to the exec prompt", () => {
			const opts: SpawnOpts = {
				model: "gpt-5-codex",
				permissionMode: "bypass",
				cwd: "/tmp/worktree",
				env: {},
				appendSystemPrompt: "You are a builder agent.",
			};
			const cmd = runtime.buildSpawnCommand(opts);
			expect(cmd).toContain("You are a builder agent.");
			expect(cmd).toContain("Read AGENTS.md");
		});

		test("with appendSystemPrompt containing single quotes (POSIX escape)", () => {
			const opts: SpawnOpts = {
				model: "gpt-5-codex",
				permissionMode: "bypass",
				cwd: "/tmp/worktree",
				env: {},
				appendSystemPrompt: "Don't touch the user's files",
			};
			const cmd = runtime.buildSpawnCommand(opts);
			expect(cmd).toContain("Don'\\''t touch the user'\\''s files");
			expect(cmd).toContain("Read AGENTS.md");
		});

		test("with appendSystemPromptFile uses $(cat ...) expansion", () => {
			const opts: SpawnOpts = {
				model: "gpt-5-codex",
				permissionMode: "bypass",
				cwd: "/project",
				env: {},
				appendSystemPromptFile: "/project/.overstory/agent-defs/coordinator.md",
			};
			const cmd = runtime.buildSpawnCommand(opts);
			expect(cmd).toContain("$(cat '/project/.overstory/agent-defs/coordinator.md')");
			expect(cmd).toContain("Read AGENTS.md");
		});

		test("appendSystemPromptFile with single quotes in path", () => {
			const opts: SpawnOpts = {
				model: "gpt-5-codex",
				permissionMode: "bypass",
				cwd: "/project",
				env: {},
				appendSystemPromptFile: "/project/it's a path/agent.md",
			};
			const cmd = runtime.buildSpawnCommand(opts);
			expect(cmd).toContain("$(cat '/project/it'\\''s a path/agent.md')");
		});

		test("appendSystemPromptFile suffix is single-quoted (prevents shell expansion)", () => {
			const opts: SpawnOpts = {
				model: "gpt-5-codex",
				permissionMode: "bypass",
				cwd: "/project",
				env: {},
				appendSystemPromptFile: "/project/agent.md",
			};
			const cmd = runtime.buildSpawnCommand(opts);
			// The suffix text must be in single quotes, NOT double quotes.
			// Double quotes would allow $, backticks, and " in the cat output
			// to be interpreted by the shell.
			expect(cmd).toContain("')\"' Read AGENTS.md");
			expect(cmd).toEndWith("begin immediately.'");
		});

		test("appendSystemPromptFile takes precedence over appendSystemPrompt", () => {
			const opts: SpawnOpts = {
				model: "gpt-5-codex",
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

		test("without appendSystemPrompt uses default AGENTS.md prompt", () => {
			const opts: SpawnOpts = {
				model: "gpt-5-codex",
				permissionMode: "bypass",
				cwd: "/tmp/worktree",
				env: {},
			};
			const cmd = runtime.buildSpawnCommand(opts);
			expect(cmd).toBe(
				"codex --full-auto --model gpt-5-codex 'Read AGENTS.md for your task assignment and begin immediately.'",
			);
		});

		test("cwd and env are not embedded in command string", () => {
			const opts: SpawnOpts = {
				model: "gpt-5-codex",
				permissionMode: "bypass",
				cwd: "/some/specific/path",
				env: { OPENAI_API_KEY: "sk-test-123" },
			};
			const cmd = runtime.buildSpawnCommand(opts);
			expect(cmd).not.toContain("/some/specific/path");
			expect(cmd).not.toContain("sk-test-123");
			expect(cmd).not.toContain("OPENAI_API_KEY");
		});

		test("produces identical output for the same inputs (deterministic)", () => {
			const opts: SpawnOpts = {
				model: "gpt-5-codex",
				permissionMode: "bypass",
				cwd: "/tmp/worktree",
				env: {},
				appendSystemPrompt: "You are a builder.",
			};
			const cmd1 = runtime.buildSpawnCommand(opts);
			const cmd2 = runtime.buildSpawnCommand(opts);
			expect(cmd1).toBe(cmd2);
		});

		test("all model names pass through unchanged", () => {
			for (const model of ["gpt-5-codex", "gpt-4o", "o3", "custom-model-v2"]) {
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

		test("systemPrompt field is ignored", () => {
			const opts: SpawnOpts = {
				model: "gpt-5-codex",
				permissionMode: "bypass",
				cwd: "/tmp",
				env: {},
				systemPrompt: "This should not appear",
			};
			const cmd = runtime.buildSpawnCommand(opts);
			expect(cmd).not.toContain("This should not appear");
		});
	});

	describe("buildPrintCommand", () => {
		test("basic command without model", () => {
			const argv = runtime.buildPrintCommand("Summarize this diff");
			expect(argv).toEqual(["codex", "exec", "--full-auto", "--ephemeral", "Summarize this diff"]);
		});

		test("command with model override", () => {
			const argv = runtime.buildPrintCommand("Classify this error", "gpt-5-codex");
			expect(argv).toEqual([
				"codex",
				"exec",
				"--full-auto",
				"--ephemeral",
				"--model",
				"gpt-5-codex",
				"Classify this error",
			]);
		});

		test("model undefined omits --model flag", () => {
			const argv = runtime.buildPrintCommand("Hello", undefined);
			expect(argv).not.toContain("--model");
		});

		test("prompt is the last element (positional argument)", () => {
			const prompt = "My test prompt";
			const argv = runtime.buildPrintCommand(prompt, "gpt-5-codex");
			expect(argv[argv.length - 1]).toBe(prompt);
		});

		test("without model, argv has exactly 5 elements", () => {
			const argv = runtime.buildPrintCommand("prompt text");
			expect(argv.length).toBe(5);
		});

		test("with model, argv has exactly 7 elements", () => {
			const argv = runtime.buildPrintCommand("prompt text", "gpt-5-codex");
			expect(argv.length).toBe(7);
		});

		test("does not include --json (print expects plain text stdout)", () => {
			const argv = runtime.buildPrintCommand("Summarize");
			expect(argv).not.toContain("--json");
		});

		test("includes --ephemeral (no session persistence for one-shot calls)", () => {
			const argv = runtime.buildPrintCommand("Summarize");
			expect(argv).toContain("--ephemeral");
		});
	});

	describe("detectReady", () => {
		test("returns ready for empty pane", () => {
			const state = runtime.detectReady("");
			expect(state).toEqual({ phase: "ready" });
		});

		test("returns ready for any pane content", () => {
			const state = runtime.detectReady("Loading Codex...\nPlease wait");
			expect(state).toEqual({ phase: "ready" });
		});

		test("returns ready for NDJSON output", () => {
			const state = runtime.detectReady(
				'{"type":"thread.started","thread_id":"abc"}\n{"type":"turn.started"}',
			);
			expect(state).toEqual({ phase: "ready" });
		});

		test("no dialog phase — Codex has no trust dialog", () => {
			const state = runtime.detectReady("trust this folder");
			expect(state.phase).not.toBe("dialog");
			expect(state.phase).toBe("ready");
		});
	});

	describe("requiresBeaconVerification", () => {
		test("returns false (no beacon verification needed)", () => {
			expect(runtime.requiresBeaconVerification()).toBe(false);
		});
	});

	describe("buildEnv", () => {
		test("returns empty object when model has no env", () => {
			const model: ResolvedModel = { model: "gpt-5-codex" };
			const env = runtime.buildEnv(model);
			expect(env).toEqual({});
		});

		test("returns model.env when present", () => {
			const model: ResolvedModel = {
				model: "gpt-5-codex",
				env: { OPENAI_API_KEY: "sk-test-123", OPENAI_BASE_URL: "https://api.example.com" },
			};
			const env = runtime.buildEnv(model);
			expect(env).toEqual({
				OPENAI_API_KEY: "sk-test-123",
				OPENAI_BASE_URL: "https://api.example.com",
			});
		});

		test("returns empty object when model.env is undefined", () => {
			const model: ResolvedModel = { model: "gpt-5-codex", env: undefined };
			const env = runtime.buildEnv(model);
			expect(env).toEqual({});
		});

		test("result is safe to spread", () => {
			const model: ResolvedModel = { model: "gpt-5-codex" };
			const env = runtime.buildEnv(model);
			const combined = { ...env, OVERSTORY_AGENT_NAME: "builder-1" };
			expect(combined).toEqual({ OVERSTORY_AGENT_NAME: "builder-1" });
		});
	});

	describe("deployConfig", () => {
		let tempDir: string;

		beforeEach(async () => {
			tempDir = await mkdtemp(join(tmpdir(), "overstory-codex-test-"));
		});

		afterEach(async () => {
			await rm(tempDir, { recursive: true, force: true });
		});

		test("writes overlay to AGENTS.md (not .claude/CLAUDE.md)", async () => {
			const worktreePath = join(tempDir, "worktree");

			await runtime.deployConfig(
				worktreePath,
				{ content: "# Agent Overlay\nThis is the task specification." },
				{ agentName: "test-builder", capability: "builder", worktreePath },
			);

			const agentsPath = join(worktreePath, "AGENTS.md");
			const content = await Bun.file(agentsPath).text();
			expect(content).toBe("# Agent Overlay\nThis is the task specification.");

			// .claude/CLAUDE.md should NOT exist
			const claudeMdPath = join(worktreePath, ".claude", "CLAUDE.md");
			const claudeExists = await Bun.file(claudeMdPath).exists();
			expect(claudeExists).toBe(false);
		});

		test("no hooks or guard extensions are deployed (OS sandbox)", async () => {
			const worktreePath = join(tempDir, "worktree");

			await runtime.deployConfig(
				worktreePath,
				{ content: "# Overlay" },
				{ agentName: "test-builder", capability: "builder", worktreePath },
			);

			// No .claude/settings.local.json (Claude hooks)
			const settingsPath = join(worktreePath, ".claude", "settings.local.json");
			const settingsExists = await Bun.file(settingsPath).exists();
			expect(settingsExists).toBe(false);

			// No .pi/extensions/ (Pi guard extensions)
			const piGuardPath = join(worktreePath, ".pi", "extensions", "overstory-guard.ts");
			const piGuardExists = await Bun.file(piGuardPath).exists();
			expect(piGuardExists).toBe(false);
		});

		test("no-op when overlay is undefined (Codex has no hooks to deploy)", async () => {
			const worktreePath = join(tempDir, "worktree");

			await runtime.deployConfig(worktreePath, undefined, {
				agentName: "coordinator",
				capability: "coordinator",
				worktreePath,
			});

			// AGENTS.md should NOT exist
			const agentsPath = join(worktreePath, "AGENTS.md");
			const agentsExists = await Bun.file(agentsPath).exists();
			expect(agentsExists).toBe(false);
		});

		test("overlay content is written verbatim", async () => {
			const worktreePath = join(tempDir, "worktree");
			const content = "# Task\n\n## Acceptance Criteria\n\n- [ ] Tests pass\n- [ ] Lint clean\n";

			await runtime.deployConfig(
				worktreePath,
				{ content },
				{ agentName: "builder-1", capability: "builder", worktreePath },
			);

			const agentsPath = join(worktreePath, "AGENTS.md");
			const written = await Bun.file(agentsPath).text();
			expect(written).toBe(content);
		});

		test("creates worktree directory if it does not exist", async () => {
			const worktreePath = join(tempDir, "deep", "nested", "worktree");

			await runtime.deployConfig(
				worktreePath,
				{ content: "# Overlay" },
				{ agentName: "builder-1", capability: "builder", worktreePath },
			);

			const agentsPath = join(worktreePath, "AGENTS.md");
			const exists = await Bun.file(agentsPath).exists();
			expect(exists).toBe(true);
		});

		test("different capabilities produce the same output (no hook differentiation)", async () => {
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

			// Both should only have AGENTS.md with their respective content
			const builderAgents = await Bun.file(join(builderPath, "AGENTS.md")).text();
			const scoutAgents = await Bun.file(join(scoutPath, "AGENTS.md")).text();
			expect(builderAgents).toBe("# Builder");
			expect(scoutAgents).toBe("# Scout");
		});
	});

	describe("parseTranscript", () => {
		let tempDir: string;

		beforeEach(async () => {
			tempDir = await mkdtemp(join(tmpdir(), "overstory-codex-transcript-test-"));
		});

		afterEach(async () => {
			await rm(tempDir, { recursive: true, force: true });
		});

		test("returns null for non-existent file", async () => {
			const result = await runtime.parseTranscript(join(tempDir, "does-not-exist.jsonl"));
			expect(result).toBeNull();
		});

		test("parses turn.completed event with usage.input_tokens/output_tokens", async () => {
			const transcriptPath = join(tempDir, "session.jsonl");
			const event = JSON.stringify({
				type: "turn.completed",
				usage: { input_tokens: 24763, output_tokens: 122 },
			});
			await Bun.write(transcriptPath, `${event}\n`);

			const result = await runtime.parseTranscript(transcriptPath);
			expect(result).not.toBeNull();
			expect(result?.inputTokens).toBe(24763);
			expect(result?.outputTokens).toBe(122);
		});

		test("aggregates multiple turn.completed events", async () => {
			const transcriptPath = join(tempDir, "session.jsonl");
			const turn1 = JSON.stringify({
				type: "turn.completed",
				usage: { input_tokens: 1000, output_tokens: 200 },
			});
			const turn2 = JSON.stringify({
				type: "turn.completed",
				usage: { input_tokens: 2000, output_tokens: 300 },
			});
			await Bun.write(transcriptPath, `${turn1}\n${turn2}\n`);

			const result = await runtime.parseTranscript(transcriptPath);
			expect(result).not.toBeNull();
			expect(result?.inputTokens).toBe(3000);
			expect(result?.outputTokens).toBe(500);
		});

		test("captures model from event with model field", async () => {
			const transcriptPath = join(tempDir, "session.jsonl");
			const started = JSON.stringify({
				type: "thread.started",
				model: "gpt-5-codex",
				thread_id: "abc",
			});
			const turn = JSON.stringify({
				type: "turn.completed",
				usage: { input_tokens: 100, output_tokens: 50 },
			});
			await Bun.write(transcriptPath, `${started}\n${turn}\n`);

			const result = await runtime.parseTranscript(transcriptPath);
			expect(result?.model).toBe("gpt-5-codex");
		});

		test("last event with model field wins", async () => {
			const transcriptPath = join(tempDir, "session.jsonl");
			const event1 = JSON.stringify({ type: "thread.started", model: "gpt-4o" });
			const event2 = JSON.stringify({
				type: "turn.completed",
				model: "gpt-5-codex",
				usage: { input_tokens: 10, output_tokens: 5 },
			});
			await Bun.write(transcriptPath, `${event1}\n${event2}\n`);

			const result = await runtime.parseTranscript(transcriptPath);
			expect(result?.model).toBe("gpt-5-codex");
		});

		test("defaults model to empty string when no model field in events", async () => {
			const transcriptPath = join(tempDir, "session.jsonl");
			const event = JSON.stringify({
				type: "turn.completed",
				usage: { input_tokens: 10, output_tokens: 5 },
			});
			await Bun.write(transcriptPath, `${event}\n`);

			const result = await runtime.parseTranscript(transcriptPath);
			expect(result?.model).toBe("");
		});

		test("handles turn.completed with cached_input_tokens", async () => {
			const transcriptPath = join(tempDir, "session.jsonl");
			const event = JSON.stringify({
				type: "turn.completed",
				usage: {
					input_tokens: 24763,
					cached_input_tokens: 24448,
					output_tokens: 122,
				},
			});
			await Bun.write(transcriptPath, `${event}\n`);

			const result = await runtime.parseTranscript(transcriptPath);
			// cached_input_tokens is metadata — we only count input_tokens
			expect(result?.inputTokens).toBe(24763);
			expect(result?.outputTokens).toBe(122);
		});

		test("skips non-turn.completed events for token counting", async () => {
			const transcriptPath = join(tempDir, "session.jsonl");
			const threadStarted = JSON.stringify({
				type: "thread.started",
				thread_id: "abc",
			});
			const itemCreated = JSON.stringify({
				type: "item.created",
				item: { type: "message", role: "assistant" },
			});
			const turnCompleted = JSON.stringify({
				type: "turn.completed",
				usage: { input_tokens: 100, output_tokens: 50 },
			});
			await Bun.write(transcriptPath, `${threadStarted}\n${itemCreated}\n${turnCompleted}\n`);

			const result = await runtime.parseTranscript(transcriptPath);
			expect(result?.inputTokens).toBe(100);
			expect(result?.outputTokens).toBe(50);
		});

		test("returns zero counts for file with no turn.completed events", async () => {
			const transcriptPath = join(tempDir, "session.jsonl");
			const event = JSON.stringify({
				type: "thread.started",
				thread_id: "abc",
			});
			await Bun.write(transcriptPath, `${event}\n`);

			const result = await runtime.parseTranscript(transcriptPath);
			expect(result).not.toBeNull();
			expect(result?.inputTokens).toBe(0);
			expect(result?.outputTokens).toBe(0);
		});

		test("skips malformed lines and parses valid ones", async () => {
			const transcriptPath = join(tempDir, "mixed.jsonl");
			const bad = "not json at all";
			const good = JSON.stringify({
				type: "turn.completed",
				usage: { input_tokens: 42, output_tokens: 7 },
			});
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

		test("handles turn.completed without usage field", async () => {
			const transcriptPath = join(tempDir, "session.jsonl");
			const event = JSON.stringify({ type: "turn.completed" });
			await Bun.write(transcriptPath, `${event}\n`);

			const result = await runtime.parseTranscript(transcriptPath);
			expect(result).not.toBeNull();
			expect(result?.inputTokens).toBe(0);
			expect(result?.outputTokens).toBe(0);
		});

		test("does not count Claude-style assistant events", async () => {
			const transcriptPath = join(tempDir, "session.jsonl");
			// Claude-style entries should NOT be counted
			const claudeStyleEntry = JSON.stringify({
				type: "assistant",
				message: { usage: { input_tokens: 999, output_tokens: 999 } },
			});
			const codexEntry = JSON.stringify({
				type: "turn.completed",
				usage: { input_tokens: 10, output_tokens: 5 },
			});
			await Bun.write(transcriptPath, `${claudeStyleEntry}\n${codexEntry}\n`);

			const result = await runtime.parseTranscript(transcriptPath);
			expect(result?.inputTokens).toBe(10);
			expect(result?.outputTokens).toBe(5);
		});

		test("does not count Pi-style message_end events", async () => {
			const transcriptPath = join(tempDir, "session.jsonl");
			// Pi-style entries should NOT be counted
			const piStyleEntry = JSON.stringify({
				type: "message_end",
				inputTokens: 999,
				outputTokens: 999,
			});
			const codexEntry = JSON.stringify({
				type: "turn.completed",
				usage: { input_tokens: 10, output_tokens: 5 },
			});
			await Bun.write(transcriptPath, `${piStyleEntry}\n${codexEntry}\n`);

			const result = await runtime.parseTranscript(transcriptPath);
			expect(result?.inputTokens).toBe(10);
			expect(result?.outputTokens).toBe(5);
		});
	});
});

describe("CodexRuntime integration: spawn command structure", () => {
	const runtime = new CodexRuntime();

	test("sling-style spawn: bypass mode, no system prompt", () => {
		const cmd = runtime.buildSpawnCommand({
			model: "gpt-5-codex",
			permissionMode: "bypass",
			cwd: "/project/.overstory/worktrees/builder-1",
			env: { OVERSTORY_AGENT_NAME: "builder-1" },
		});
		expect(cmd).toBe(
			"codex --full-auto --model gpt-5-codex 'Read AGENTS.md for your task assignment and begin immediately.'",
		);
	});

	test("coordinator-style spawn: bypass mode with appendSystemPrompt", () => {
		const baseDefinition = "# Coordinator\nYou are the coordinator agent.";
		const cmd = runtime.buildSpawnCommand({
			model: "gpt-5-codex",
			permissionMode: "bypass",
			cwd: "/project",
			appendSystemPrompt: baseDefinition,
			env: { OVERSTORY_AGENT_NAME: "coordinator" },
		});
		expect(cmd).toContain("codex --full-auto --model gpt-5-codex");
		expect(cmd).toContain("# Coordinator");
		expect(cmd).toContain("You are the coordinator agent.");
		expect(cmd).toContain("Read AGENTS.md");
	});

	test("coordinator-style spawn: with appendSystemPromptFile", () => {
		const cmd = runtime.buildSpawnCommand({
			model: "gpt-5-codex",
			permissionMode: "bypass",
			cwd: "/project",
			appendSystemPromptFile: "/project/.overstory/agent-defs/coordinator.md",
			env: { OVERSTORY_AGENT_NAME: "coordinator" },
		});
		expect(cmd).toContain("codex --full-auto --model gpt-5-codex");
		expect(cmd).toContain("$(cat '/project/.overstory/agent-defs/coordinator.md')");
		expect(cmd).toContain("Read AGENTS.md");
	});
});

describe("CodexRuntime integration: buildEnv matches provider pattern", () => {
	const runtime = new CodexRuntime();

	test("OpenAI model: passes env through", () => {
		const model: ResolvedModel = {
			model: "gpt-5-codex",
			env: { OPENAI_API_KEY: "sk-test-123" },
		};
		const env = runtime.buildEnv(model);
		expect(env).toEqual({ OPENAI_API_KEY: "sk-test-123" });
	});

	test("custom provider: passes env through", () => {
		const model: ResolvedModel = {
			model: "custom-model",
			env: { OPENAI_API_KEY: "sk-test", OPENAI_BASE_URL: "https://custom.api/v1" },
		};
		const env = runtime.buildEnv(model);
		expect(env).toEqual({
			OPENAI_API_KEY: "sk-test",
			OPENAI_BASE_URL: "https://custom.api/v1",
		});
	});

	test("model without env: returns empty object (safe to spread)", () => {
		const model: ResolvedModel = { model: "gpt-5-codex" };
		const env = runtime.buildEnv(model);
		expect(env).toEqual({});
		const combined = { ...env, OVERSTORY_AGENT_NAME: "builder-1" };
		expect(combined).toEqual({ OVERSTORY_AGENT_NAME: "builder-1" });
	});
});

describe("CodexRuntime integration: registry resolves 'codex'", () => {
	test("getRuntime('codex') returns CodexRuntime", async () => {
		const { getRuntime } = await import("./registry.ts");
		const rt = getRuntime("codex");
		expect(rt).toBeInstanceOf(CodexRuntime);
		expect(rt.id).toBe("codex");
		expect(rt.instructionPath).toBe("AGENTS.md");
	});
});

describe("CodexRuntime detectRateLimit", () => {
	const runtime = new CodexRuntime();

	describe("detectRateLimit", () => {
		test("detects HTTP 429", () => {
			const result = runtime.detectRateLimit("Error: 429 Too Many Requests");
			expect(result.limited).toBe(true);
			if (result.limited) {
				expect(result.message).toContain("429");
			}
		});

		test("detects rate_limit error", () => {
			const result = runtime.detectRateLimit('{"error":{"type":"rate_limit"}}');
			expect(result.limited).toBe(true);
		});

		test("detects 'rate limit' text", () => {
			const result = runtime.detectRateLimit("Rate limit exceeded, please retry");
			expect(result.limited).toBe(true);
		});

		test("detects too many requests", () => {
			const result = runtime.detectRateLimit("Error: Too many requests");
			expect(result.limited).toBe(true);
			if (result.limited) {
				expect(result.message).toContain("too many requests");
			}
		});

		test("detects quota exceeded", () => {
			const result = runtime.detectRateLimit("Error: quota exceeded for org");
			expect(result.limited).toBe(true);
			if (result.limited) {
				expect(result.message).toContain("quota");
			}
		});

		test("detects insufficient_quota", () => {
			const result = runtime.detectRateLimit('{"error":{"code":"insufficient_quota"}}');
			expect(result.limited).toBe(true);
		});

		test("returns not limited for normal output", () => {
			const result = runtime.detectRateLimit("File created: src/main.ts\nDone.");
			expect(result.limited).toBe(false);
		});

		test("returns not limited for empty string", () => {
			const result = runtime.detectRateLimit("");
			expect(result.limited).toBe(false);
		});
	});
});

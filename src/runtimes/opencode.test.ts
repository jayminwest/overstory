import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTempDir } from "../test-helpers.ts";
import type { ResolvedModel } from "../types.ts";
import { OpenCodeRuntime } from "./opencode.ts";
import type { SpawnOpts } from "./types.ts";

describe("OpenCode runtime", () => {
	const runtime = new OpenCodeRuntime();
	let testDir: string;

	beforeEach(async () => {
		testDir = await mkdtemp(join(tmpdir(), "overstory-opencode-"));
	});

	afterEach(async () => {
		await cleanupTempDir(testDir);
	});

	describe("id and instructionPath", () => {
		test("id is 'opencode'", () => {
			expect(runtime.id).toBe("opencode");
		});

		test("instructionPath is .claude/CLAUDE.md", () => {
			expect(runtime.instructionPath).toBe(".claude/CLAUDE.md");
		});
	});

	describe("buildSpawnCommand", () => {
		test("includes model flag", () => {
			const opts: SpawnOpts = {
				model: "openrouter/z-ai/glm-4.7",
				permissionMode: "bypass",
				cwd: "/tmp/worktree",
				env: {},
			};
			const cmd = runtime.buildSpawnCommand(opts);
			expect(cmd).toContain("opencode run");
			expect(cmd).toContain("--model openrouter/z-ai/glm-4.7");
		});

		test("includes dir flag for worktree", () => {
			const opts: SpawnOpts = {
				model: "nvidia/deepseek-ai/deepseek-v3.2",
				permissionMode: "bypass",
				cwd: testDir,
				env: {},
			};
			const cmd = runtime.buildSpawnCommand(opts);
			expect(cmd).toContain(`--dir '${testDir}'`);
		});

		test("includes system prompt from file", () => {
			const opts: SpawnOpts = {
				model: "nvidia/moonshotai/kimi-k2.5",
				permissionMode: "bypass",
				cwd: testDir,
				env: {},
				appendSystemPromptFile: join(testDir, "prompt.txt"),
			};
			const cmd = runtime.buildSpawnCommand(opts);
			expect(cmd).toContain(`--prompt "$(cat '${join(testDir, "prompt.txt")}')"`);
		});

		test("includes inline system prompt", () => {
			const opts: SpawnOpts = {
				model: "sonnet",
				permissionMode: "bypass",
				cwd: testDir,
				env: {},
				appendSystemPrompt: "You are a coding agent",
			};
			const cmd = runtime.buildSpawnCommand(opts);
			expect(cmd).toContain("--prompt 'You are a coding agent'");
		});

		test("properly escapes single quotes in paths", () => {
			const opts: SpawnOpts = {
				model: "sonnet",
				permissionMode: "bypass",
				cwd: "/path/with'quote",
				env: {},
			};
			const cmd = runtime.buildSpawnCommand(opts);
			expect(cmd).toContain("--dir '/path/with'\\''quote'");
		});

		test("properly escapes single quotes in system prompt", () => {
			const opts: SpawnOpts = {
				model: "sonnet",
				permissionMode: "bypass",
				cwd: testDir,
				env: {},
				appendSystemPrompt: "It's a test",
			};
			const cmd = runtime.buildSpawnCommand(opts);
			expect(cmd).toContain("--prompt 'It'\\''s a test'");
		});

		test("works without model uses cwd", () => {
			const opts: SpawnOpts = {
				model: "",
				permissionMode: "bypass",
				cwd: testDir,
				env: {},
			};
			const cmd = runtime.buildSpawnCommand(opts);
			expect(cmd).toContain(`--dir '${testDir}'`);
		});

		test("works without cwd uses model", () => {
			const opts: SpawnOpts = {
				model: "sonnet",
				permissionMode: "bypass",
				cwd: "",
				env: {},
			};
			const cmd = runtime.buildSpawnCommand(opts);
			expect(cmd).toBe("opencode run --model sonnet");
		});
	});

	describe("buildPrintCommand", () => {
		test("includes format json for headless mode", () => {
			const cmd = runtime.buildPrintCommand("Complete the task");
			expect(cmd).toEqual(["opencode", "run", "--format", "json", "Complete the task"]);
		});

		test("includes model when specified", () => {
			const cmd = runtime.buildPrintCommand("Complete the task", "sonnet");
			expect(cmd).toEqual([
				"opencode",
				"run",
				"--format",
				"json",
				"--model",
				"sonnet",
				"Complete the task",
			]);
		});

		test("excludes model when not specified", () => {
			const cmd = runtime.buildPrintCommand("Complete the task");
			expect(cmd).not.toContain("--model");
		});
	});

	describe("deployConfig", () => {
		test("writes CLAUDE.md to worktree", async () => {
			const _opts: SpawnOpts = {
				model: "sonnet",
				permissionMode: "bypass",
				cwd: testDir,
				env: {},
			};
			const overlay = {
				content: "# Task Instructions\n\nDo something",
			};

			const hooks = {
				agentName: "test-agent",
				capability: "builder",
				worktreePath: testDir,
			};

			await runtime.deployConfig(testDir, overlay, hooks);

			const claudeMdPath = join(testDir, ".claude", "CLAUDE.md");
			const file = Bun.file(claudeMdPath);
			expect(await file.exists()).toBe(true);

			const content = await file.text();
			expect(content).toBe(overlay.content);
		});

		test("creates .claude directory if it doesn't exist", async () => {
			const overlay = {
				content: "# Instructions",
			};
			const hooks = {
				agentName: "test-agent",
				capability: "builder",
				worktreePath: testDir,
			};

			await runtime.deployConfig(testDir, overlay, hooks);

			const claudeDir = join(testDir, ".claude");
			const claudeMdPath = join(claudeDir, "CLAUDE.md");
			const file = Bun.file(claudeMdPath);
			expect(await file.exists()).toBe(true);
		});

		test("no-op when overlay is undefined", async () => {
			const hooks = {
				agentName: "test-agent",
				capability: "builder",
				worktreePath: testDir,
			};

			await runtime.deployConfig(testDir, undefined, hooks);

			const claudeMdPath = join(testDir, ".claude", "CLAUDE.md");
			const file = Bun.file(claudeMdPath);
			expect(await file.exists()).toBe(false);
		});
	});

	describe("detectReady", () => {
		test("returns ready when prompt and token count are present", () => {
			const paneContent = "❯ Some prompt\nTokens: 1500";
			const state = runtime.detectReady(paneContent);
			expect(state).toEqual({ phase: "ready" });
		});

		test("returns ready when opencode branding and model indicator are present", () => {
			const paneContent = "opencode v1.2.15\nmodel: sonnet\n❯";
			const state = runtime.detectReady(paneContent);
			expect(state).toEqual({ phase: "ready" });
		});

		test("returns ready when opencode and ready indicator are present", () => {
			const paneContent = "opencode v1.2.15\nReady";
			const state = runtime.detectReady(paneContent);
			expect(state).toEqual({ phase: "ready" });
		});

		test("returns loading when only prompt is present", () => {
			const paneContent = "❯ Some prompt";
			const state = runtime.detectReady(paneContent);
			expect(state).toEqual({ phase: "loading" });
		});

		test("returns loading when only status bar is present", () => {
			const paneContent = "Tokens: 1500";
			const state = runtime.detectReady(paneContent);
			expect(state).toEqual({ phase: "loading" });
		});

		test("returns loading for empty pane", () => {
			const paneContent = "";
			const state = runtime.detectReady(paneContent);
			expect(state).toEqual({ phase: "loading" });
		});

		test("does not false-positive on generic box-drawing characters", () => {
			const paneContent = "❯ prompt\n│ some list\n─── separator";
			const state = runtime.detectReady(paneContent);
			expect(state).toEqual({ phase: "loading" });
		});
	});

	describe("parseTranscript", () => {
		test("returns null when file doesn't exist", async () => {
			const result = await runtime.parseTranscript(join(testDir, "nonexistent.json"));
			expect(result).toBeNull();
		});

		test("parses JSONL format with inputTokens and outputTokens", async () => {
			const transcriptPath = join(testDir, "transcript.jsonl");
			const content = `{"inputTokens":100,"outputTokens":200,"model":"model-1"}
{"inputTokens":50,"outputTokens":100,"model":"model-2"}`;
			await Bun.write(transcriptPath, content);

			const result = await runtime.parseTranscript(transcriptPath);
			expect(result).not.toBeNull();
			expect(result?.inputTokens).toBe(150);
			expect(result?.outputTokens).toBe(300);
			expect(result?.model).toBe("model-2");
		});

		test("parses JSONL format with usage object", async () => {
			const transcriptPath = join(testDir, "transcript.jsonl");
			const content = `{"usage":{"inputTokens":100,"outputTokens":200}}
{"usage":{"inputTokens":50,"outputTokens":100}}`;
			await Bun.write(transcriptPath, content);

			const result = await runtime.parseTranscript(transcriptPath);
			expect(result).not.toBeNull();
			expect(result?.inputTokens).toBe(150);
			expect(result?.outputTokens).toBe(300);
		});

		test("parses JSONL format with message.usage object", async () => {
			const transcriptPath = join(testDir, "transcript.jsonl");
			const content = `{"message":{"usage":{"input_tokens":100,"output_tokens":200},"model":"model-1"}}`;
			await Bun.write(transcriptPath, content);

			const result = await runtime.parseTranscript(transcriptPath);
			expect(result).not.toBeNull();
			expect(result?.inputTokens).toBe(100);
			expect(result?.outputTokens).toBe(200);
			expect(result?.model).toBe("model-1");
		});

		test("parses single JSON object format", async () => {
			const transcriptPath = join(testDir, "transcript.json");
			const content = JSON.stringify({
				tokens: {
					input: 100,
					output: 200,
				},
				model: "sonnet",
			});
			await Bun.write(transcriptPath, content);

			const result = await runtime.parseTranscript(transcriptPath);
			expect(result).not.toBeNull();
			expect(result?.inputTokens).toBe(100);
			expect(result?.outputTokens).toBe(200);
			expect(result?.model).toBe("sonnet");
		});

		test("handles prompt_tokens and completion_tokens fields", async () => {
			const transcriptPath = join(testDir, "transcript.json");
			const content = JSON.stringify({
				tokens: {
					prompt_tokens: 100,
					completion_tokens: 200,
				},
			});
			await Bun.write(transcriptPath, content);

			const result = await runtime.parseTranscript(transcriptPath);
			expect(result).not.toBeNull();
			expect(result?.inputTokens).toBe(100);
			expect(result?.outputTokens).toBe(200);
		});

		test("returns null for malformed JSON", async () => {
			const transcriptPath = join(testDir, "transcript.json");
			await Bun.write(transcriptPath, "invalid json");

			const result = await runtime.parseTranscript(transcriptPath);
			expect(result).toBeNull();
		});

		test("returns null when no tokens found", async () => {
			const transcriptPath = join(testDir, "transcript.json");
			const content = JSON.stringify({
				someField: "value",
			});
			await Bun.write(transcriptPath, content);

			const result = await runtime.parseTranscript(transcriptPath);
			expect(result).toBeNull();
		});

		test("handles options.model for model field", async () => {
			const transcriptPath = join(testDir, "transcript.json");
			const content = JSON.stringify({
				tokens: {
					input: 100,
					output: 200,
				},
				options: {
					model: "sonnet",
				},
			});
			await Bun.write(transcriptPath, content);

			const result = await runtime.parseTranscript(transcriptPath);
			expect(result?.model).toBe("sonnet");
		});
	});

	describe("getTranscriptDir", () => {
		test("returns null", () => {
			expect(runtime.getTranscriptDir("/some/project")).toBeNull();
		});
	});

	describe("requiresBeaconVerification", () => {
		test("returns false", () => {
			expect(runtime.requiresBeaconVerification()).toBe(false);
		});
	});

	describe("buildEnv", () => {
		test("returns empty object when model.env is undefined", () => {
			const model: ResolvedModel = {
				model: "sonnet",
			};
			const env = runtime.buildEnv(model);
			expect(env).toEqual({});
		});

		test("returns model.env when set", () => {
			const model: ResolvedModel = {
				model: "sonnet",
				env: {
					OPENROUTER_API_KEY: "test-key",
					NVIDIA_API_KEY: "test-nvidia-key",
				},
			};
			const env = runtime.buildEnv(model);
			expect(env).toEqual({
				OPENROUTER_API_KEY: "test-key",
				NVIDIA_API_KEY: "test-nvidia-key",
			});
		});
	});
});

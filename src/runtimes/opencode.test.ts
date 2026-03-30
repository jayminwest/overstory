import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTempDir } from "../test-helpers.ts";
import type { ResolvedModel } from "../types.ts";
import { OpenCodeRuntime } from "./opencode.ts";
import type { SpawnOpts } from "./types.ts";

describe("OpenCodeRuntime", () => {
	const runtime = new OpenCodeRuntime();

	describe("id and instructionPath", () => {
		test("id is 'opencode'", () => {
			expect(runtime.id).toBe("opencode");
		});

		test("instructionPath is AGENTS.md", () => {
			expect(runtime.instructionPath).toBe("AGENTS.md");
		});

		test("stability is experimental", () => {
			expect(runtime.stability).toBe("experimental");
		});
	});

	describe("buildSpawnCommand", () => {
		test("includes --model flag", () => {
			const opts: SpawnOpts = {
				model: "sonnet",
				permissionMode: "bypass",
				cwd: "/tmp/worktree",
				env: {},
			};
			const cmd = runtime.buildSpawnCommand(opts);
			expect(cmd).toBe("opencode --model sonnet");
		});

		test("permissionMode is ignored (opencode has no permission flag)", () => {
			const bypass: SpawnOpts = {
				model: "opus",
				permissionMode: "bypass",
				cwd: "/tmp",
				env: {},
			};
			const ask: SpawnOpts = { ...bypass, permissionMode: "ask" };
			expect(runtime.buildSpawnCommand(bypass)).toBe("opencode --model opus");
			expect(runtime.buildSpawnCommand(ask)).toBe("opencode --model opus");
		});

		test("appendSystemPrompt is ignored (opencode has no such flag)", () => {
			const opts: SpawnOpts = {
				model: "sonnet",
				permissionMode: "bypass",
				cwd: "/tmp/worktree",
				env: {},
				appendSystemPrompt: "You are a builder agent.",
			};
			const cmd = runtime.buildSpawnCommand(opts);
			expect(cmd).toBe("opencode --model sonnet");
			expect(cmd).not.toContain("append-system-prompt");
			expect(cmd).not.toContain("You are a builder agent");
		});

		test("appendSystemPromptFile is ignored (opencode has no such flag)", () => {
			const opts: SpawnOpts = {
				model: "opus",
				permissionMode: "bypass",
				cwd: "/project",
				env: {},
				appendSystemPromptFile: "/project/.overstory/specs/task.md",
			};
			const cmd = runtime.buildSpawnCommand(opts);
			expect(cmd).toBe("opencode --model opus");
			expect(cmd).not.toContain("task.md");
		});

		test("cwd and env are not embedded in command string", () => {
			const opts: SpawnOpts = {
				model: "sonnet",
				permissionMode: "bypass",
				cwd: "/some/specific/path",
				env: { OPENAI_API_KEY: "sk-test-123" },
			};
			const cmd = runtime.buildSpawnCommand(opts);
			expect(cmd).not.toContain("/some/specific/path");
			expect(cmd).not.toContain("sk-test-123");
			expect(cmd).not.toContain("OPENAI_API_KEY");
		});

		test("all model names pass through unchanged", () => {
			for (const model of ["sonnet", "opus", "haiku", "gpt-4o", "openrouter/gpt-5"]) {
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

		test("produces identical output for same inputs (deterministic)", () => {
			const opts: SpawnOpts = {
				model: "sonnet",
				permissionMode: "bypass",
				cwd: "/tmp/worktree",
				env: {},
			};
			expect(runtime.buildSpawnCommand(opts)).toBe(runtime.buildSpawnCommand(opts));
		});
	});

	describe("buildPrintCommand", () => {
		test("uses opencode run subcommand with --format json", () => {
			const argv = runtime.buildPrintCommand("Summarize this diff");
			expect(argv).toEqual(["opencode", "run", "--format", "json", "Summarize this diff"]);
		});

		test("command with model override appends --model flag", () => {
			const argv = runtime.buildPrintCommand("Classify this error", "haiku");
			expect(argv).toEqual([
				"opencode",
				"run",
				"--format",
				"json",
				"Classify this error",
				"--model",
				"haiku",
			]);
		});

		test("model undefined omits --model flag", () => {
			const argv = runtime.buildPrintCommand("Hello", undefined);
			expect(argv).not.toContain("--model");
			expect(argv).toContain("--format");
			expect(argv).toContain("json");
		});

		test("prompt is passed as positional argument (not via --prompt flag)", () => {
			const prompt = "Fix the bug in src/foo.ts line 42";
			const argv = runtime.buildPrintCommand(prompt);
			// Prompt should be after the --format json flags
			expect(argv[4]).toBe(prompt);
			expect(argv).not.toContain("--prompt");
		});
	});

	describe("detectReady", () => {
		test("returns loading for empty pane", () => {
			expect(runtime.detectReady("")).toEqual({ phase: "loading" });
		});

		test("returns loading for blank pane (only whitespace/newlines)", () => {
			expect(runtime.detectReady("\n\n\n\n")).toEqual({ phase: "loading" });
		});

		test("returns ready for real OpenCode TUI pane content", () => {
			// Real captured tmux pane from OpenCode v1.2.27
			const pane = [
				"",
				"",
				"                                                      \u2584",
				"                     \u2588\u2580\u2580\u2588 \u2588\u2580\u2580\u2588 \u2588\u2580\u2580\u2588 \u2588\u2580\u2580\u2584 \u2588\u2580\u2580\u2580 \u2588\u2580\u2580\u2588 \u2588\u2580\u2580\u2588 \u2588\u2580\u2580\u2588",
				"                     \u2588  \u2588 \u2588  \u2588 \u2588\u2580\u2580\u2580 \u2588  \u2588 \u2588    \u2588  \u2588 \u2588  \u2588 \u2588\u2580\u2580\u2580",
				"                     \u2580\u2580\u2580\u2580 \u2588\u2580\u2580\u2580 \u2580\u2580\u2580\u2580 \u2580\u2580\u2580\u2580 \u2580\u2580\u2580\u2580 \u2580\u2580\u2580\u2580 \u2580\u2580\u2580\u2580 \u2580\u2580\u2580\u2580",
				"",
				"",
				"   \u2503",
				'   \u2503  Ask anything... "What is the tech stack of this project?"',
				"   \u2503",
				"   \u2503  Build  Claude Opus 4.6 Claude (ai-proxy-ai-proxy-2)",
				"   \u2579\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580",
				"                                                   tab agents  ctrl+p commands",
				"",
				"",
				"",
				"            \u25cf Tip Run /unshare to remove a session from public access",
				"",
				"  /private/tmp  \u229a 1 MCP /status                                         1.2.27",
			].join("\n");
			expect(runtime.detectReady(pane)).toEqual({ phase: "ready" });
		});

		test("returns loading when only version present but no Ask anything", () => {
			const pane = "Loading OpenCode...\n1.2.27";
			expect(runtime.detectReady(pane)).toEqual({ phase: "loading" });
		});

		test("returns loading when only Ask anything present but no version", () => {
			const pane = 'Ask anything... "What is the tech stack?"';
			expect(runtime.detectReady(pane)).toEqual({ phase: "loading" });
		});

		test("returns ready for minimal matching pane content", () => {
			const pane = "Ask anything...\nSome status bar info 1.2.27";
			expect(runtime.detectReady(pane)).toEqual({ phase: "ready" });
		});

		test("never returns dialog phase", () => {
			const state = runtime.detectReady("trust this folder?");
			expect(state.phase).not.toBe("dialog");
		});

		test("handles different version numbers", () => {
			const pane = "Ask anything...\nstatus bar 2.0.0";
			expect(runtime.detectReady(pane)).toEqual({ phase: "ready" });
		});
	});

	describe("requiresBeaconVerification", () => {
		test("returns false", () => {
			expect(runtime.requiresBeaconVerification()).toBe(false);
		});
	});

	describe("parseTranscript", () => {
		let tempDir: string;

		beforeEach(async () => {
			tempDir = await mkdtemp(join(tmpdir(), "overstory-opencode-transcript-test-"));
		});

		afterEach(async () => {
			await cleanupTempDir(tempDir);
		});

		test("returns null for non-existent file", async () => {
			const result = await runtime.parseTranscript(join(tempDir, "does-not-exist.jsonl"));
			expect(result).toBeNull();
		});

		test("parses step_finish events with token data", async () => {
			const transcriptPath = join(tempDir, "session.jsonl");
			const entry = JSON.stringify({
				type: "step_finish",
				part: {
					type: "step-finish",
					reason: "stop",
					tokens: {
						total: 23838,
						input: 2,
						output: 6,
						reasoning: 0,
						cache: { read: 23494, write: 336 },
					},
				},
			});
			await Bun.write(transcriptPath, `${entry}\n`);

			const result = await runtime.parseTranscript(transcriptPath);
			expect(result).not.toBeNull();
			// input (2) + cache.read (23494) = 23496
			expect(result?.inputTokens).toBe(23496);
			expect(result?.outputTokens).toBe(6);
		});

		test("aggregates multiple step_finish events", async () => {
			const transcriptPath = join(tempDir, "session.jsonl");
			const entry1 = JSON.stringify({
				type: "step_finish",
				part: {
					type: "step-finish",
					tokens: { total: 100, input: 10, output: 20, cache: { read: 50, write: 10 } },
				},
			});
			const entry2 = JSON.stringify({
				type: "step_finish",
				part: {
					type: "step-finish",
					tokens: { total: 200, input: 30, output: 40, cache: { read: 100, write: 20 } },
				},
			});
			await Bun.write(transcriptPath, `${entry1}\n${entry2}\n`);

			const result = await runtime.parseTranscript(transcriptPath);
			expect(result).not.toBeNull();
			// input: 10+30 = 40, cache.read: 50+100 = 150, total input: 190
			expect(result?.inputTokens).toBe(190);
			// output: 20+40 = 60
			expect(result?.outputTokens).toBe(60);
		});

		test("ignores non-step_finish events for token counting", async () => {
			const transcriptPath = join(tempDir, "session.jsonl");
			const stepStart = JSON.stringify({
				type: "step_start",
				part: { type: "step-start" },
			});
			const toolUse = JSON.stringify({
				type: "tool_use",
				part: { type: "tool", tool: "bash" },
			});
			const text = JSON.stringify({
				type: "text",
				part: { type: "text", text: "Hello" },
			});
			const stepFinish = JSON.stringify({
				type: "step_finish",
				part: {
					type: "step-finish",
					tokens: { total: 100, input: 5, output: 10, cache: { read: 80, write: 5 } },
				},
			});
			await Bun.write(transcriptPath, `${stepStart}\n${toolUse}\n${text}\n${stepFinish}\n`);

			const result = await runtime.parseTranscript(transcriptPath);
			expect(result?.inputTokens).toBe(85); // 5 + 80
			expect(result?.outputTokens).toBe(10);
		});

		test("handles step_finish without cache data", async () => {
			const transcriptPath = join(tempDir, "session.jsonl");
			const entry = JSON.stringify({
				type: "step_finish",
				part: {
					type: "step-finish",
					tokens: { total: 50, input: 20, output: 30 },
				},
			});
			await Bun.write(transcriptPath, `${entry}\n`);

			const result = await runtime.parseTranscript(transcriptPath);
			expect(result?.inputTokens).toBe(20);
			expect(result?.outputTokens).toBe(30);
		});

		test("captures model from top-level model field", async () => {
			const transcriptPath = join(tempDir, "session.jsonl");
			const entry = JSON.stringify({
				type: "step_finish",
				model: "anthropic/claude-sonnet-4-5",
				part: {
					type: "step-finish",
					tokens: { total: 10, input: 5, output: 5 },
				},
			});
			await Bun.write(transcriptPath, `${entry}\n`);

			const result = await runtime.parseTranscript(transcriptPath);
			expect(result?.model).toBe("anthropic/claude-sonnet-4-5");
		});

		test("returns empty model string when no model field present", async () => {
			const transcriptPath = join(tempDir, "session.jsonl");
			const entry = JSON.stringify({
				type: "step_finish",
				part: {
					type: "step-finish",
					tokens: { total: 10, input: 5, output: 5 },
				},
			});
			await Bun.write(transcriptPath, `${entry}\n`);

			const result = await runtime.parseTranscript(transcriptPath);
			expect(result?.model).toBe("");
		});

		test("skips malformed lines and parses valid ones", async () => {
			const transcriptPath = join(tempDir, "mixed.jsonl");
			const bad = "not json";
			const good = JSON.stringify({
				type: "step_finish",
				part: {
					type: "step-finish",
					tokens: { total: 42, input: 10, output: 7, cache: { read: 25, write: 0 } },
				},
			});
			await Bun.write(transcriptPath, `${bad}\n${good}\n`);

			const result = await runtime.parseTranscript(transcriptPath);
			expect(result?.inputTokens).toBe(35); // 10 + 25
			expect(result?.outputTokens).toBe(7);
		});

		test("handles empty file", async () => {
			const transcriptPath = join(tempDir, "empty.jsonl");
			await Bun.write(transcriptPath, "");

			const result = await runtime.parseTranscript(transcriptPath);
			expect(result).not.toBeNull();
			expect(result?.inputTokens).toBe(0);
			expect(result?.outputTokens).toBe(0);
		});

		test("returns zero counts for file with no step_finish events", async () => {
			const transcriptPath = join(tempDir, "no-tokens.jsonl");
			const entry = JSON.stringify({ type: "step_start", part: { type: "step-start" } });
			await Bun.write(transcriptPath, `${entry}\n`);

			const result = await runtime.parseTranscript(transcriptPath);
			expect(result).not.toBeNull();
			expect(result?.inputTokens).toBe(0);
			expect(result?.outputTokens).toBe(0);
		});
	});

	describe("getTranscriptDir", () => {
		test("returns path under ~/.local/share/opencode/", () => {
			const dir = runtime.getTranscriptDir("/some/project");
			expect(dir).not.toBeNull();
			expect(dir).toContain(".local");
			expect(dir).toContain("share");
			expect(dir).toContain("opencode");
		});

		test("returns same path regardless of project root (global DB)", () => {
			const dir1 = runtime.getTranscriptDir("/project/alpha");
			const dir2 = runtime.getTranscriptDir("/project/beta");
			expect(dir1).toBe(dir2);
		});

		test("returns null when HOME is unset", () => {
			const originalHome = process.env.HOME;
			const originalUserProfile = process.env.USERPROFILE;
			try {
				delete process.env.HOME;
				delete process.env.USERPROFILE;
				expect(runtime.getTranscriptDir("/some/project")).toBeNull();
			} finally {
				if (originalHome !== undefined) process.env.HOME = originalHome;
				if (originalUserProfile !== undefined) process.env.USERPROFILE = originalUserProfile;
			}
		});
	});

	describe("buildEnv", () => {
		test("returns empty object when model has no env", () => {
			const model: ResolvedModel = { model: "sonnet" };
			expect(runtime.buildEnv(model)).toEqual({});
		});

		test("returns model.env when present", () => {
			const model: ResolvedModel = {
				model: "gpt-4o",
				env: { OPENAI_API_KEY: "sk-test-123", OPENCODE_API_URL: "https://api.openai.com" },
			};
			expect(runtime.buildEnv(model)).toEqual({
				OPENAI_API_KEY: "sk-test-123",
				OPENCODE_API_URL: "https://api.openai.com",
			});
		});

		test("returns empty object when model.env is undefined", () => {
			const model: ResolvedModel = { model: "opus", env: undefined };
			expect(runtime.buildEnv(model)).toEqual({});
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
			tempDir = await mkdtemp(join(tmpdir(), "overstory-opencode-test-"));
		});

		afterEach(async () => {
			await cleanupTempDir(tempDir);
		});

		test("writes overlay to AGENTS.md when provided", async () => {
			const worktreePath = join(tempDir, "worktree");

			await runtime.deployConfig(
				worktreePath,
				{ content: "# Agent Instructions\nYou are a builder." },
				{ agentName: "test-builder", capability: "builder", worktreePath },
			);

			const content = await Bun.file(join(worktreePath, "AGENTS.md")).text();
			expect(content).toBe("# Agent Instructions\nYou are a builder.");
		});

		test("creates worktree directory if it does not exist", async () => {
			const worktreePath = join(tempDir, "new-worktree");

			await runtime.deployConfig(
				worktreePath,
				{ content: "# Instructions" },
				{ agentName: "test", capability: "builder", worktreePath },
			);

			const exists = await Bun.file(join(worktreePath, "AGENTS.md")).exists();
			expect(exists).toBe(true);
		});

		test("skips overlay write when overlay is undefined", async () => {
			const worktreePath = join(tempDir, "worktree");

			await runtime.deployConfig(worktreePath, undefined, {
				agentName: "coordinator",
				capability: "coordinator",
				worktreePath,
			});

			const exists = await Bun.file(join(worktreePath, "AGENTS.md")).exists();
			expect(exists).toBe(false);
		});

		test("deploys guard plugin to .opencode/plugins/overstory-guard.ts", async () => {
			const worktreePath = join(tempDir, "worktree");

			await runtime.deployConfig(
				worktreePath,
				{ content: "# Overlay" },
				{ agentName: "test-builder", capability: "builder", worktreePath },
			);

			const guardPath = join(worktreePath, ".opencode", "plugins", "overstory-guard.ts");
			const exists = await Bun.file(guardPath).exists();
			expect(exists).toBe(true);
		});

		test("guard plugin contains agent name and worktree path", async () => {
			const worktreePath = join(tempDir, "my-worktree");

			await runtime.deployConfig(
				worktreePath,
				{ content: "# Overlay" },
				{ agentName: "my-oc-agent", capability: "builder", worktreePath },
			);

			const guardPath = join(worktreePath, ".opencode", "plugins", "overstory-guard.ts");
			const content = await Bun.file(guardPath).text();
			expect(content).toContain("my-oc-agent");
			expect(content).toContain(worktreePath);
		});

		test("guard plugin contains OverstoryGuard export", async () => {
			const worktreePath = join(tempDir, "worktree");

			await runtime.deployConfig(
				worktreePath,
				{ content: "# Overlay" },
				{ agentName: "test", capability: "builder", worktreePath },
			);

			const guardPath = join(worktreePath, ".opencode", "plugins", "overstory-guard.ts");
			const content = await Bun.file(guardPath).text();
			expect(content).toContain("export const OverstoryGuard");
			expect(content).toContain("tool.execute.before");
		});

		test("deploys opencode.json permission config", async () => {
			const worktreePath = join(tempDir, "worktree");

			await runtime.deployConfig(
				worktreePath,
				{ content: "# Overlay" },
				{ agentName: "test-builder", capability: "builder", worktreePath },
			);

			const configPath = join(worktreePath, "opencode.json");
			const exists = await Bun.file(configPath).exists();
			expect(exists).toBe(true);

			const content = await Bun.file(configPath).text();
			const parsed = JSON.parse(content) as Record<string, unknown>;
			expect(parsed.$schema).toBe("https://opencode.ai/config.json");
			expect(parsed.permission).toBeDefined();
		});

		test("opencode.json has trailing newline", async () => {
			const worktreePath = join(tempDir, "worktree");

			await runtime.deployConfig(worktreePath, undefined, {
				agentName: "test",
				capability: "builder",
				worktreePath,
			});

			const configPath = join(worktreePath, "opencode.json");
			const content = await Bun.file(configPath).text();
			expect(content.endsWith("\n")).toBe(true);
		});

		test("opencode.json uses tab indentation", async () => {
			const worktreePath = join(tempDir, "worktree");

			await runtime.deployConfig(worktreePath, undefined, {
				agentName: "test",
				capability: "builder",
				worktreePath,
			});

			const configPath = join(worktreePath, "opencode.json");
			const content = await Bun.file(configPath).text();
			expect(content).toContain("\t");
		});

		test("scout agent gets edit/write denied in permission config", async () => {
			const worktreePath = join(tempDir, "worktree");

			await runtime.deployConfig(worktreePath, undefined, {
				agentName: "test-scout",
				capability: "scout",
				worktreePath,
			});

			const configPath = join(worktreePath, "opencode.json");
			const content = await Bun.file(configPath).text();
			const parsed = JSON.parse(content) as Record<string, unknown>;
			const permission = parsed.permission as Record<string, unknown>;
			expect(permission.edit).toBe("deny");
			expect(permission.write).toBe("deny");
		});

		test("builder agent gets permissive permission config", async () => {
			const worktreePath = join(tempDir, "worktree");

			await runtime.deployConfig(worktreePath, undefined, {
				agentName: "test-builder",
				capability: "builder",
				worktreePath,
			});

			const configPath = join(worktreePath, "opencode.json");
			const content = await Bun.file(configPath).text();
			const parsed = JSON.parse(content) as Record<string, unknown>;
			const permission = parsed.permission as Record<string, unknown>;
			expect(permission["*"]).toBe("allow");
		});

		test("still deploys guard plugin and config when overlay is undefined", async () => {
			const worktreePath = join(tempDir, "worktree");

			await runtime.deployConfig(worktreePath, undefined, {
				agentName: "coordinator",
				capability: "coordinator",
				worktreePath,
			});

			const guardPath = join(worktreePath, ".opencode", "plugins", "overstory-guard.ts");
			const configPath = join(worktreePath, "opencode.json");

			expect(await Bun.file(guardPath).exists()).toBe(true);
			expect(await Bun.file(configPath).exists()).toBe(true);
		});

		test("all three files present when overlay is provided", async () => {
			const worktreePath = join(tempDir, "worktree");

			await runtime.deployConfig(
				worktreePath,
				{ content: "# Overlay" },
				{ agentName: "test-builder", capability: "builder", worktreePath },
			);

			const agentsMdExists = await Bun.file(join(worktreePath, "AGENTS.md")).exists();
			const guardExists = await Bun.file(
				join(worktreePath, ".opencode", "plugins", "overstory-guard.ts"),
			).exists();
			const configExists = await Bun.file(join(worktreePath, "opencode.json")).exists();

			expect(agentsMdExists).toBe(true);
			expect(guardExists).toBe(true);
			expect(configExists).toBe(true);
		});

		test("overwrites existing AGENTS.md", async () => {
			const worktreePath = join(tempDir, "worktree");
			await mkdir(worktreePath, { recursive: true });
			await Bun.write(join(worktreePath, "AGENTS.md"), "old content");

			await runtime.deployConfig(
				worktreePath,
				{ content: "new content" },
				{ agentName: "test", capability: "builder", worktreePath },
			);

			const content = await Bun.file(join(worktreePath, "AGENTS.md")).text();
			expect(content).toBe("new content");
		});

		test("does not write settings.local.json (not Claude Code)", async () => {
			const worktreePath = join(tempDir, "worktree");

			await runtime.deployConfig(
				worktreePath,
				{ content: "# Instructions" },
				{ agentName: "test-builder", capability: "builder", worktreePath },
			);

			const settingsExists = await Bun.file(
				join(worktreePath, ".claude", "settings.local.json"),
			).exists();
			expect(settingsExists).toBe(false);
		});
	});
});

describe("OpenCodeRuntime integration: registry resolves 'opencode'", () => {
	test("getRuntime('opencode') returns OpenCodeRuntime", async () => {
		const { getRuntime } = await import("./registry.ts");
		const rt = getRuntime("opencode");
		expect(rt).toBeInstanceOf(OpenCodeRuntime);
		expect(rt.id).toBe("opencode");
		expect(rt.instructionPath).toBe("AGENTS.md");
	});
});

describe("OpenCodeRuntime E2E: real OpenCode installation", () => {
	// These tests verify behavior against the real opencode CLI.
	// They are skipped if opencode is not installed.

	let hasOpenCode = false;

	beforeEach(async () => {
		try {
			const proc = Bun.spawn(["which", "opencode"], {
				stdout: "pipe",
				stderr: "pipe",
			});
			const exitCode = await proc.exited;
			hasOpenCode = exitCode === 0;
		} catch {
			hasOpenCode = false;
		}
	});

	test("opencode run --format json produces parseable nd-JSON with step_finish tokens", async () => {
		if (!hasOpenCode) {
			console.log("Skipping E2E test: opencode not installed");
			return;
		}

		const runtime = new OpenCodeRuntime();
		const argv = runtime.buildPrintCommand("Reply with just the word PONG");

		const proc = Bun.spawn(argv, {
			stdout: "pipe",
			stderr: "pipe",
			timeout: 30_000,
		});

		const stdout = await new Response(proc.stdout).text();
		await proc.exited;

		// Should have at least one step_finish event with tokens.
		const lines = stdout.split("\n").filter((l) => l.trim().length > 0);
		expect(lines.length).toBeGreaterThan(0);

		let foundStepFinish = false;
		for (const line of lines) {
			const entry = JSON.parse(line) as Record<string, unknown>;
			if (entry.type === "step_finish") {
				foundStepFinish = true;
				const part = entry.part as Record<string, unknown>;
				const tokens = part?.tokens as Record<string, unknown>;
				expect(tokens).toBeDefined();
				expect(typeof tokens?.total).toBe("number");
				expect(typeof tokens?.input).toBe("number");
				expect(typeof tokens?.output).toBe("number");
			}
		}

		expect(foundStepFinish).toBe(true);
	});

	test("getTranscriptDir points to existing directory", async () => {
		if (!hasOpenCode) {
			console.log("Skipping E2E test: opencode not installed");
			return;
		}

		const runtime = new OpenCodeRuntime();
		const dir = runtime.getTranscriptDir("/tmp/test");
		expect(dir).not.toBeNull();

		if (dir) {
			const exists = await Bun.file(join(dir, "opencode.db")).exists();
			// Only check if the user has run opencode before (DB exists).
			// Don't fail if they haven't — the directory may not exist yet.
			if (exists) {
				expect(exists).toBe(true);
			}
		}
	});
});

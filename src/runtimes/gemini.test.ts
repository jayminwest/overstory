import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTempDir } from "../test-helpers.ts";
import type { ResolvedModel } from "../types.ts";
import { GeminiRuntime } from "./gemini.ts";
import type { SpawnOpts } from "./types.ts";

describe("GeminiRuntime", () => {
	const runtime = new GeminiRuntime();

	describe("id and instructionPath", () => {
		test("id is 'gemini'", () => {
			expect(runtime.id).toBe("gemini");
		});

		test("instructionPath is GEMINI.md", () => {
			expect(runtime.instructionPath).toBe("GEMINI.md");
		});
	});

	describe("buildSpawnCommand", () => {
		test("bypass permission mode includes --approval-mode yolo", () => {
			const opts: SpawnOpts = {
				model: "gemini-2.5-pro",
				permissionMode: "bypass",
				cwd: "/tmp/worktree",
				env: {},
			};
			const cmd = runtime.buildSpawnCommand(opts);
			expect(cmd).toBe("gemini -m gemini-2.5-pro --approval-mode yolo");
		});

		test("ask permission mode omits approval flag", () => {
			const opts: SpawnOpts = {
				model: "gemini-2.5-flash",
				permissionMode: "ask",
				cwd: "/tmp/worktree",
				env: {},
			};
			const cmd = runtime.buildSpawnCommand(opts);
			expect(cmd).toBe("gemini -m gemini-2.5-flash");
			expect(cmd).not.toContain("--approval-mode");
			expect(cmd).not.toContain("yolo");
		});

		test("appendSystemPrompt is ignored (gemini has no such flag)", () => {
			const opts: SpawnOpts = {
				model: "gemini-2.5-pro",
				permissionMode: "bypass",
				cwd: "/tmp/worktree",
				env: {},
				appendSystemPrompt: "You are a builder agent.",
			};
			const cmd = runtime.buildSpawnCommand(opts);
			expect(cmd).toBe("gemini -m gemini-2.5-pro --approval-mode yolo");
			expect(cmd).not.toContain("append-system-prompt");
			expect(cmd).not.toContain("You are a builder agent");
		});

		test("appendSystemPromptFile is ignored (gemini has no such flag)", () => {
			const opts: SpawnOpts = {
				model: "gemini-2.5-pro",
				permissionMode: "bypass",
				cwd: "/project",
				env: {},
				appendSystemPromptFile: "/project/.overstory/agent-defs/coordinator.md",
			};
			const cmd = runtime.buildSpawnCommand(opts);
			expect(cmd).toBe("gemini -m gemini-2.5-pro --approval-mode yolo");
			expect(cmd).not.toContain("cat");
			expect(cmd).not.toContain("coordinator.md");
		});

		test("cwd and env are not embedded in command string", () => {
			const opts: SpawnOpts = {
				model: "gemini-2.5-pro",
				permissionMode: "bypass",
				cwd: "/some/specific/path",
				env: { GEMINI_API_KEY: "test-key" },
			};
			const cmd = runtime.buildSpawnCommand(opts);
			expect(cmd).not.toContain("/some/specific/path");
			expect(cmd).not.toContain("test-key");
			expect(cmd).not.toContain("GEMINI_API_KEY");
		});

		test("model alias is passed through unchanged", () => {
			const opts: SpawnOpts = {
				model: "flash",
				permissionMode: "bypass",
				cwd: "/tmp/worktree",
				env: {},
			};
			const cmd = runtime.buildSpawnCommand(opts);
			expect(cmd).toContain("-m flash");
		});
	});

	describe("buildPrintCommand", () => {
		test("basic prompt produces gemini -p argv with --yolo", () => {
			const cmd = runtime.buildPrintCommand("Resolve this conflict");
			expect(cmd).toEqual(["gemini", "-p", "Resolve this conflict", "--yolo"]);
		});

		test("with model override adds -m flag", () => {
			const cmd = runtime.buildPrintCommand("Triage this failure", "gemini-2.5-flash");
			expect(cmd).toEqual([
				"gemini",
				"-p",
				"Triage this failure",
				"--yolo",
				"-m",
				"gemini-2.5-flash",
			]);
		});

		test("without model omits -m flag", () => {
			const cmd = runtime.buildPrintCommand("Classify this error");
			expect(cmd).not.toContain("-m");
		});

		test("prompt with special characters is preserved", () => {
			const prompt = 'Fix the "bug" in file\'s path & run tests';
			const cmd = runtime.buildPrintCommand(prompt);
			expect(cmd[2]).toBe(prompt);
		});

		test("empty prompt is passed through", () => {
			const cmd = runtime.buildPrintCommand("");
			expect(cmd).toEqual(["gemini", "-p", "", "--yolo"]);
		});
	});

	describe("deployConfig", () => {
		let tempDir: string;

		beforeEach(async () => {
			tempDir = await mkdtemp(join(tmpdir(), "ov-gemini-test-"));
		});

		afterEach(async () => {
			await cleanupTempDir(tempDir);
		});

		test("writes GEMINI.md to worktree root", async () => {
			await runtime.deployConfig(
				tempDir,
				{ content: "# Task\nBuild the feature." },
				{ agentName: "test-agent", capability: "builder", worktreePath: tempDir },
			);

			const file = Bun.file(join(tempDir, "GEMINI.md"));
			expect(await file.exists()).toBe(true);
			expect(await file.text()).toBe("# Task\nBuild the feature.");
		});

		test("no-op when overlay is undefined", async () => {
			await runtime.deployConfig(tempDir, undefined, {
				agentName: "test-agent",
				capability: "coordinator",
				worktreePath: tempDir,
			});

			const file = Bun.file(join(tempDir, "GEMINI.md"));
			expect(await file.exists()).toBe(false);
		});

		test("hooks parameter is unused (no guard deployment)", async () => {
			await runtime.deployConfig(
				tempDir,
				{ content: "# Instructions" },
				{
					agentName: "my-builder",
					capability: "builder",
					worktreePath: tempDir,
					qualityGates: [
						{ command: "bun test", name: "tests", description: "all tests must pass" },
					],
				},
			);

			// Only GEMINI.md should exist — no settings files or guard extensions.
			const geminiFile = Bun.file(join(tempDir, "GEMINI.md"));
			expect(await geminiFile.exists()).toBe(true);

			// No Claude Code settings file.
			const settingsFile = Bun.file(join(tempDir, ".claude", "settings.local.json"));
			expect(await settingsFile.exists()).toBe(false);

			// No Pi guard extension.
			const piGuardFile = Bun.file(join(tempDir, ".pi", "extensions", "overstory-guard.ts"));
			expect(await piGuardFile.exists()).toBe(false);
		});

		test("overwrites existing GEMINI.md", async () => {
			await Bun.write(join(tempDir, "GEMINI.md"), "# Old content");

			await runtime.deployConfig(
				tempDir,
				{ content: "# New content" },
				{ agentName: "test-agent", capability: "builder", worktreePath: tempDir },
			);

			const file = Bun.file(join(tempDir, "GEMINI.md"));
			expect(await file.text()).toBe("# New content");
		});

		test("creates parent directories if needed", async () => {
			const nestedDir = join(tempDir, "nested", "deep");

			await runtime.deployConfig(
				nestedDir,
				{ content: "# Nested" },
				{ agentName: "test-agent", capability: "builder", worktreePath: nestedDir },
			);

			const file = Bun.file(join(nestedDir, "GEMINI.md"));
			expect(await file.exists()).toBe(true);
		});
	});

	describe("detectReady", () => {
		test("returns ready when placeholder and gemini branding visible", () => {
			const pane = "✨ Gemini CLI v1.0.0\n\n> Type your message or @path/to/file";
			expect(runtime.detectReady(pane)).toEqual({ phase: "ready" });
		});

		test("returns ready with > prefix and gemini text", () => {
			const pane = "gemini-2.5-pro | model: gemini\n> ";
			expect(runtime.detectReady(pane)).toEqual({ phase: "ready" });
		});

		test("returns ready with ❯ prompt and gemini text", () => {
			const pane = "Gemini CLI\n❯ ";
			expect(runtime.detectReady(pane)).toEqual({ phase: "ready" });
		});

		test("returns loading when no prompt indicator", () => {
			const pane = "Starting Gemini CLI...";
			expect(runtime.detectReady(pane)).toEqual({ phase: "loading" });
		});

		test("returns loading when no gemini branding", () => {
			const pane = "> Type your message or @path/to/file";
			expect(runtime.detectReady(pane)).toEqual({ phase: "loading" });
		});

		test("returns loading for empty pane", () => {
			expect(runtime.detectReady("")).toEqual({ phase: "loading" });
		});

		test("returns loading during initialization", () => {
			const pane = "Loading model...";
			expect(runtime.detectReady(pane)).toEqual({ phase: "loading" });
		});

		test("case-insensitive gemini detection", () => {
			const pane = "GEMINI CLI v1.0\n> ready";
			expect(runtime.detectReady(pane)).toEqual({ phase: "ready" });
		});

		test("case-insensitive placeholder detection", () => {
			const pane = "Gemini\nType Your Message here";
			expect(runtime.detectReady(pane)).toEqual({ phase: "ready" });
		});

		test("never returns dialog phase (gemini has no trust dialog)", () => {
			// Try various pane contents — should never get "dialog" phase.
			const panes = ["", "Gemini CLI", "> ready", "Gemini\n> ", "Loading...", "trust this folder"];
			for (const pane of panes) {
				const result = runtime.detectReady(pane);
				expect(result.phase).not.toBe("dialog");
			}
		});
	});

	describe("requiresBeaconVerification", () => {
		test("not defined — defaults to true (gets resend loop)", () => {
			// GeminiRuntime does not override requiresBeaconVerification.
			// When omitted, the orchestrator defaults to true (resend loop enabled).
			// Verify the method is not present on the instance.
			expect("requiresBeaconVerification" in runtime).toBe(false);
		});
	});

	describe("parseTranscript", () => {
		let tempDir: string;

		beforeEach(async () => {
			tempDir = await mkdtemp(join(tmpdir(), "ov-gemini-transcript-"));
		});

		afterEach(async () => {
			await cleanupTempDir(tempDir);
		});

		test("returns null for missing file", async () => {
			const result = await runtime.parseTranscript(join(tempDir, "nonexistent.jsonl"));
			expect(result).toBeNull();
		});

		test("parses init event for model", async () => {
			const transcript = [
				'{"type":"init","timestamp":"2026-01-01T00:00:00Z","session_id":"abc","model":"gemini-2.5-pro"}',
				'{"type":"result","timestamp":"2026-01-01T00:01:00Z","status":"success","stats":{"input_tokens":100,"output_tokens":50,"total_tokens":150,"cached":0,"input":100,"duration_ms":1000,"tool_calls":0}}',
			].join("\n");

			const path = join(tempDir, "transcript.jsonl");
			await Bun.write(path, transcript);

			const result = await runtime.parseTranscript(path);
			expect(result).toEqual({
				inputTokens: 100,
				outputTokens: 50,
				model: "gemini-2.5-pro",
			});
		});

		test("aggregates token usage from multiple result events", async () => {
			const transcript = [
				'{"type":"init","model":"gemini-2.5-flash"}',
				'{"type":"result","stats":{"input_tokens":200,"output_tokens":100}}',
				'{"type":"result","stats":{"input_tokens":150,"output_tokens":75}}',
			].join("\n");

			const path = join(tempDir, "transcript.jsonl");
			await Bun.write(path, transcript);

			const result = await runtime.parseTranscript(path);
			expect(result).toEqual({
				inputTokens: 350,
				outputTokens: 175,
				model: "gemini-2.5-flash",
			});
		});

		test("handles transcript with no token usage", async () => {
			const transcript = [
				'{"type":"init","model":"gemini-2.5-pro"}',
				'{"type":"message","role":"user","content":"hello"}',
				'{"type":"message","role":"assistant","content":"hi","delta":true}',
			].join("\n");

			const path = join(tempDir, "transcript.jsonl");
			await Bun.write(path, transcript);

			const result = await runtime.parseTranscript(path);
			expect(result).toEqual({
				inputTokens: 0,
				outputTokens: 0,
				model: "gemini-2.5-pro",
			});
		});

		test("skips malformed JSON lines", async () => {
			const transcript = [
				'{"type":"init","model":"gemini-2.5-pro"}',
				"this is not json",
				'{"type":"result","stats":{"input_tokens":500,"output_tokens":200}}',
				"{broken json",
			].join("\n");

			const path = join(tempDir, "transcript.jsonl");
			await Bun.write(path, transcript);

			const result = await runtime.parseTranscript(path);
			expect(result).toEqual({
				inputTokens: 500,
				outputTokens: 200,
				model: "gemini-2.5-pro",
			});
		});

		test("returns empty model when no init event", async () => {
			const transcript = '{"type":"result","stats":{"input_tokens":100,"output_tokens":50}}';

			const path = join(tempDir, "transcript.jsonl");
			await Bun.write(path, transcript);

			const result = await runtime.parseTranscript(path);
			expect(result).toEqual({
				inputTokens: 100,
				outputTokens: 50,
				model: "",
			});
		});

		test("handles empty file", async () => {
			const path = join(tempDir, "empty.jsonl");
			await Bun.write(path, "");

			const result = await runtime.parseTranscript(path);
			expect(result).toEqual({
				inputTokens: 0,
				outputTokens: 0,
				model: "",
			});
		});

		test("handles result event with missing stats", async () => {
			const transcript = [
				'{"type":"init","model":"gemini-2.5-pro"}',
				'{"type":"result","status":"error"}',
			].join("\n");

			const path = join(tempDir, "transcript.jsonl");
			await Bun.write(path, transcript);

			const result = await runtime.parseTranscript(path);
			expect(result).toEqual({
				inputTokens: 0,
				outputTokens: 0,
				model: "gemini-2.5-pro",
			});
		});

		test("handles result event with partial stats", async () => {
			const transcript = [
				'{"type":"init","model":"gemini-2.5-pro"}',
				'{"type":"result","stats":{"input_tokens":300}}',
			].join("\n");

			const path = join(tempDir, "transcript.jsonl");
			await Bun.write(path, transcript);

			const result = await runtime.parseTranscript(path);
			expect(result).toEqual({
				inputTokens: 300,
				outputTokens: 0,
				model: "gemini-2.5-pro",
			});
		});

		test("fallback model from any event with model field", async () => {
			const transcript = [
				'{"type":"message","role":"assistant","model":"gemini-2.5-pro","content":"hello"}',
				'{"type":"result","stats":{"input_tokens":50,"output_tokens":25}}',
			].join("\n");

			const path = join(tempDir, "transcript.jsonl");
			await Bun.write(path, transcript);

			const result = await runtime.parseTranscript(path);
			expect(result).toEqual({
				inputTokens: 50,
				outputTokens: 25,
				model: "gemini-2.5-pro",
			});
		});

		test("init event model takes precedence over fallback", async () => {
			const transcript = [
				'{"type":"message","model":"gemini-2.5-flash"}',
				'{"type":"init","model":"gemini-2.5-pro"}',
				'{"type":"result","stats":{"input_tokens":10,"output_tokens":5}}',
			].join("\n");

			const path = join(tempDir, "transcript.jsonl");
			await Bun.write(path, transcript);

			const result = await runtime.parseTranscript(path);
			expect(result).toEqual({
				inputTokens: 10,
				outputTokens: 5,
				model: "gemini-2.5-pro",
			});
		});

		test("handles trailing newline", async () => {
			const transcript =
				'{"type":"init","model":"gemini-2.5-pro"}\n{"type":"result","stats":{"input_tokens":100,"output_tokens":50}}\n';

			const path = join(tempDir, "transcript.jsonl");
			await Bun.write(path, transcript);

			const result = await runtime.parseTranscript(path);
			expect(result).toEqual({
				inputTokens: 100,
				outputTokens: 50,
				model: "gemini-2.5-pro",
			});
		});

		test("full stream-json transcript with all event types", async () => {
			const transcript = [
				'{"type":"init","timestamp":"2026-03-01T12:00:00Z","session_id":"sess-123","model":"gemini-2.5-pro"}',
				'{"type":"message","timestamp":"2026-03-01T12:00:01Z","role":"user","content":"Fix the bug"}',
				'{"type":"message","timestamp":"2026-03-01T12:00:02Z","role":"assistant","content":"I will","delta":true}',
				'{"type":"tool_use","timestamp":"2026-03-01T12:00:03Z","tool_name":"Read","tool_id":"read-1","parameters":{"file_path":"/src/main.ts"}}',
				'{"type":"tool_result","timestamp":"2026-03-01T12:00:04Z","tool_id":"read-1","status":"success","output":"contents"}',
				'{"type":"message","timestamp":"2026-03-01T12:00:05Z","role":"assistant","content":"Fixed it","delta":true}',
				'{"type":"result","timestamp":"2026-03-01T12:00:06Z","status":"success","stats":{"total_tokens":1500,"input_tokens":1000,"output_tokens":500,"cached":200,"input":800,"duration_ms":5000,"tool_calls":1}}',
			].join("\n");

			const path = join(tempDir, "full-session.jsonl");
			await Bun.write(path, transcript);

			const result = await runtime.parseTranscript(path);
			expect(result).toEqual({
				inputTokens: 1000,
				outputTokens: 500,
				model: "gemini-2.5-pro",
			});
		});
	});

	describe("buildEnv", () => {
		test("returns model env vars when present", () => {
			const model: ResolvedModel = {
				model: "gemini-2.5-pro",
				env: { GEMINI_API_KEY: "test-key-123" },
			};
			expect(runtime.buildEnv(model)).toEqual({ GEMINI_API_KEY: "test-key-123" });
		});

		test("returns empty object when model has no env", () => {
			const model: ResolvedModel = { model: "gemini-2.5-pro" };
			expect(runtime.buildEnv(model)).toEqual({});
		});

		test("passes through multiple env vars", () => {
			const model: ResolvedModel = {
				model: "gemini-2.5-pro",
				env: {
					GEMINI_API_KEY: "key",
					GOOGLE_CLOUD_PROJECT: "my-project",
				},
			};
			expect(runtime.buildEnv(model)).toEqual({
				GEMINI_API_KEY: "key",
				GOOGLE_CLOUD_PROJECT: "my-project",
			});
		});
	});
});

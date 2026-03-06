import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTempDir } from "../test-helpers.ts";
import type { ResolvedModel } from "../types.ts";
import { CursorRuntime } from "./cursor.ts";
import type { SpawnOpts } from "./types.ts";

describe("CursorRuntime", () => {
	const runtime = new CursorRuntime();

	describe("id and instructionPath", () => {
		test("id is 'cursor'", () => {
			expect(runtime.id).toBe("cursor");
		});

		test("instructionPath is .cursor/rules/overstory.md", () => {
			expect(runtime.instructionPath).toBe(".cursor/rules/overstory.md");
		});
	});

	describe("buildSpawnCommand", () => {
		test("bypass permission mode includes --yolo", () => {
			const opts: SpawnOpts = {
				model: "sonnet",
				permissionMode: "bypass",
				cwd: "/tmp/worktree",
				env: {},
			};
			const cmd = runtime.buildSpawnCommand(opts);
			expect(cmd).toBe("agent --model sonnet --yolo");
		});

		test("ask permission mode omits permission flag", () => {
			const opts: SpawnOpts = {
				model: "opus",
				permissionMode: "ask",
				cwd: "/tmp/worktree",
				env: {},
			};
			const cmd = runtime.buildSpawnCommand(opts);
			expect(cmd).toBe("agent --model opus");
			expect(cmd).not.toContain("--yolo");
			expect(cmd).not.toContain("--permission-mode");
		});

		test("appendSystemPrompt is ignored (agent CLI has no such flag)", () => {
			const opts: SpawnOpts = {
				model: "sonnet",
				permissionMode: "bypass",
				cwd: "/tmp/worktree",
				env: {},
				appendSystemPrompt: "You are a builder agent.",
			};
			const cmd = runtime.buildSpawnCommand(opts);
			expect(cmd).toBe("agent --model sonnet --yolo");
			expect(cmd).not.toContain("append-system-prompt");
			expect(cmd).not.toContain("You are a builder agent");
		});

		test("appendSystemPromptFile is ignored (agent CLI has no such flag)", () => {
			const opts: SpawnOpts = {
				model: "opus",
				permissionMode: "bypass",
				cwd: "/project",
				env: {},
				appendSystemPromptFile: "/project/.overstory/agent-defs/coordinator.md",
			};
			const cmd = runtime.buildSpawnCommand(opts);
			expect(cmd).toBe("agent --model opus --yolo");
			expect(cmd).not.toContain("cat");
			expect(cmd).not.toContain("coordinator.md");
		});

		test("cwd and env are not embedded in command string", () => {
			const opts: SpawnOpts = {
				model: "sonnet",
				permissionMode: "bypass",
				cwd: "/some/specific/path",
				env: { CURSOR_API_KEY: "test-key-123" },
			};
			const cmd = runtime.buildSpawnCommand(opts);
			expect(cmd).not.toContain("/some/specific/path");
			expect(cmd).not.toContain("test-key-123");
			expect(cmd).not.toContain("CURSOR_API_KEY");
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
			const cmd1 = runtime.buildSpawnCommand(opts);
			const cmd2 = runtime.buildSpawnCommand(opts);
			expect(cmd1).toBe(cmd2);
		});
	});

	describe("buildPrintCommand", () => {
		test("basic prompt includes -p and --yolo", () => {
			const argv = runtime.buildPrintCommand("Summarize this diff");
			expect(argv).toEqual(["agent", "-p", "Summarize this diff", "--yolo"]);
		});

		test("with model override appends --model flag", () => {
			const argv = runtime.buildPrintCommand("Classify this error", "sonnet");
			expect(argv).toEqual(["agent", "-p", "Classify this error", "--yolo", "--model", "sonnet"]);
		});

		test("without model omits --model flag", () => {
			const argv = runtime.buildPrintCommand("Hello");
			expect(argv).not.toContain("--model");
		});

		test("model undefined omits --model flag", () => {
			const argv = runtime.buildPrintCommand("Hello", undefined);
			expect(argv).not.toContain("--model");
			expect(argv).toContain("--yolo");
		});

		test("--yolo always present regardless of model", () => {
			const withModel = runtime.buildPrintCommand("prompt", "opus");
			const withoutModel = runtime.buildPrintCommand("prompt");
			expect(withModel).toContain("--yolo");
			expect(withoutModel).toContain("--yolo");
		});

		test("prompt with special characters is preserved", () => {
			const prompt = 'Fix the "bug" in file\'s path & run tests';
			const argv = runtime.buildPrintCommand(prompt);
			expect(argv[2]).toBe(prompt);
		});

		test("empty prompt is passed through", () => {
			const argv = runtime.buildPrintCommand("");
			expect(argv).toEqual(["agent", "-p", "", "--yolo"]);
		});
	});

	describe("detectReady", () => {
		test("returns loading for empty pane", () => {
			expect(runtime.detectReady("")).toEqual({ phase: "loading" });
		});

		test("returns loading for partial content (prompt only, no status bar)", () => {
			const state = runtime.detectReady("Welcome!\n\u276f");
			expect(state).toEqual({ phase: "loading" });
		});

		test("returns loading for partial content (status bar only, no prompt)", () => {
			const state = runtime.detectReady("shift+tab to toggle");
			expect(state).toEqual({ phase: "loading" });
		});

		test("returns ready for ❯ + shift+tab", () => {
			const state = runtime.detectReady("Cursor Agent\n\u276f\nshift+tab to chat");
			expect(state).toEqual({ phase: "ready" });
		});

		test("returns ready for ❯ + esc", () => {
			const state = runtime.detectReady("Cursor Agent\n\u276f\nesc to cancel");
			expect(state).toEqual({ phase: "ready" });
		});

		test("returns ready for ❯ + agent keyword", () => {
			const state = runtime.detectReady("Agent Ready\n\u276f\ntype here");
			expect(state).toEqual({ phase: "ready" });
		});

		test("returns ready for > prefix + shift+tab", () => {
			const pane = "Cursor\n> \nshift+tab";
			expect(runtime.detectReady(pane)).toEqual({ phase: "ready" });
		});

		test("returns ready for > prefix + esc", () => {
			const pane = "Some content\n> type here\npress esc to exit";
			expect(runtime.detectReady(pane)).toEqual({ phase: "ready" });
		});

		test("returns ready for > prefix + agent keyword", () => {
			const pane = "Agent v1.0\n> ";
			expect(runtime.detectReady(pane)).toEqual({ phase: "ready" });
		});

		test("case-insensitive match for status bar keywords", () => {
			expect(runtime.detectReady("\u276f\nSHIFT+TAB")).toEqual({ phase: "ready" });
			expect(runtime.detectReady("\u276f\nESC to exit")).toEqual({ phase: "ready" });
			expect(runtime.detectReady("\u276f\nAGENT mode")).toEqual({ phase: "ready" });
		});

		test("returns loading for random pane content", () => {
			expect(runtime.detectReady("Loading...\nPlease wait")).toEqual({ phase: "loading" });
		});

		test("never returns dialog phase", () => {
			const panes = [
				"",
				"Cursor Agent",
				"> ready",
				"\u276f\nshift+tab",
				"Loading...",
				"trust this folder",
			];
			for (const pane of panes) {
				const result = runtime.detectReady(pane);
				expect(result.phase).not.toBe("dialog");
			}
		});

		test("Shift+Tab (capital) is matched case-insensitively", () => {
			const state = runtime.detectReady("\u276f\nShift+Tab to toggle");
			expect(state).toEqual({ phase: "ready" });
		});
	});

	describe("deployConfig", () => {
		let tempDir: string;

		beforeEach(async () => {
			tempDir = await mkdtemp(join(tmpdir(), "ov-cursor-test-"));
		});

		afterEach(async () => {
			await cleanupTempDir(tempDir);
		});

		test("writes overlay to .cursor/rules/overstory.md when provided", async () => {
			const worktreePath = join(tempDir, "worktree");

			await runtime.deployConfig(
				worktreePath,
				{ content: "# Cursor Instructions\nYou are a builder." },
				{ agentName: "test-builder", capability: "builder", worktreePath },
			);

			const overlayPath = join(worktreePath, ".cursor", "rules", "overstory.md");
			const content = await Bun.file(overlayPath).text();
			expect(content).toBe("# Cursor Instructions\nYou are a builder.");
		});

		test("creates .cursor/rules/ directory if it does not exist", async () => {
			const worktreePath = join(tempDir, "new-worktree");

			await runtime.deployConfig(
				worktreePath,
				{ content: "# Instructions" },
				{ agentName: "test", capability: "builder", worktreePath },
			);

			const fileExists = await Bun.file(
				join(worktreePath, ".cursor", "rules", "overstory.md"),
			).exists();
			expect(fileExists).toBe(true);
		});

		test("skips overlay write when overlay is undefined", async () => {
			const worktreePath = join(tempDir, "worktree");

			await runtime.deployConfig(worktreePath, undefined, {
				agentName: "coordinator",
				capability: "coordinator",
				worktreePath,
			});

			const overlayExists = await Bun.file(
				join(worktreePath, ".cursor", "rules", "overstory.md"),
			).exists();
			expect(overlayExists).toBe(false);
		});

		test("does not write guard files (no hook deployment)", async () => {
			const worktreePath = join(tempDir, "worktree");

			await runtime.deployConfig(
				worktreePath,
				{ content: "# Instructions" },
				{
					agentName: "test-builder",
					capability: "builder",
					worktreePath,
					qualityGates: [
						{ command: "bun test", name: "tests", description: "all tests must pass" },
					],
				},
			);

			const overlayFile = Bun.file(join(worktreePath, ".cursor", "rules", "overstory.md"));
			expect(await overlayFile.exists()).toBe(true);

			const settingsFile = Bun.file(join(worktreePath, ".claude", "settings.local.json"));
			expect(await settingsFile.exists()).toBe(false);

			const piGuardFile = Bun.file(join(worktreePath, ".pi", "extensions", "overstory-guard.ts"));
			expect(await piGuardFile.exists()).toBe(false);
		});

		test("overwrites existing overlay file", async () => {
			const overlayPath = join(tempDir, ".cursor", "rules", "overstory.md");
			const { mkdir: mkdirFS } = await import("node:fs/promises");
			await mkdirFS(join(tempDir, ".cursor", "rules"), { recursive: true });
			await Bun.write(overlayPath, "# Old content");

			await runtime.deployConfig(
				tempDir,
				{ content: "# New content" },
				{ agentName: "test-agent", capability: "builder", worktreePath: tempDir },
			);

			const content = await Bun.file(overlayPath).text();
			expect(content).toBe("# New content");
		});
	});

	describe("parseTranscript", () => {
		let tempDir: string;

		beforeEach(async () => {
			tempDir = await mkdtemp(join(tmpdir(), "ov-cursor-transcript-"));
		});

		afterEach(async () => {
			await cleanupTempDir(tempDir);
		});

		test("returns null for non-existent file", async () => {
			const result = await runtime.parseTranscript(join(tempDir, "does-not-exist.jsonl"));
			expect(result).toBeNull();
		});

		test("extracts model from system/init event", async () => {
			const transcript = [
				JSON.stringify({
					type: "system",
					subtype: "init",
					model: "claude-sonnet-4-6",
				}),
			].join("\n");

			const path = join(tempDir, "transcript.jsonl");
			await Bun.write(path, transcript);

			const result = await runtime.parseTranscript(path);
			expect(result).not.toBeNull();
			expect(result?.model).toBe("claude-sonnet-4-6");
		});

		test("always returns zero tokens (not available in Cursor format)", async () => {
			const transcript = [
				JSON.stringify({ type: "system", subtype: "init", model: "sonnet" }),
				JSON.stringify({ type: "assistant", content: "Hello world" }),
			].join("\n");

			const path = join(tempDir, "transcript.jsonl");
			await Bun.write(path, transcript);

			const result = await runtime.parseTranscript(path);
			expect(result?.inputTokens).toBe(0);
			expect(result?.outputTokens).toBe(0);
		});

		test("skips malformed JSON lines and continues parsing", async () => {
			const goodEntry = JSON.stringify({
				type: "system",
				subtype: "init",
				model: "opus",
			});

			const path = join(tempDir, "transcript.jsonl");
			await Bun.write(path, `not json at all\n${goodEntry}\n{broken`);

			const result = await runtime.parseTranscript(path);
			expect(result).not.toBeNull();
			expect(result?.model).toBe("opus");
			expect(result?.inputTokens).toBe(0);
			expect(result?.outputTokens).toBe(0);
		});

		test("returns empty model for empty file", async () => {
			const path = join(tempDir, "empty.jsonl");
			await Bun.write(path, "");

			const result = await runtime.parseTranscript(path);
			expect(result).not.toBeNull();
			expect(result?.inputTokens).toBe(0);
			expect(result?.outputTokens).toBe(0);
			expect(result?.model).toBe("");
		});

		test("handles trailing newlines", async () => {
			const transcript = `${JSON.stringify({ type: "system", subtype: "init", model: "sonnet" })}\n\n\n`;

			const path = join(tempDir, "transcript.jsonl");
			await Bun.write(path, transcript);

			const result = await runtime.parseTranscript(path);
			expect(result?.model).toBe("sonnet");
			expect(result?.inputTokens).toBe(0);
		});

		test("ignores non-init system events", async () => {
			const transcript = [
				JSON.stringify({ type: "system", subtype: "heartbeat", model: "should-not-match" }),
				JSON.stringify({ type: "system", subtype: "init", model: "correct-model" }),
			].join("\n");

			const path = join(tempDir, "transcript.jsonl");
			await Bun.write(path, transcript);

			const result = await runtime.parseTranscript(path);
			expect(result?.model).toBe("correct-model");
		});

		test("last init event wins when multiple are present", async () => {
			const transcript = [
				JSON.stringify({ type: "system", subtype: "init", model: "first-model" }),
				JSON.stringify({ type: "system", subtype: "init", model: "second-model" }),
			].join("\n");

			const path = join(tempDir, "transcript.jsonl");
			await Bun.write(path, transcript);

			const result = await runtime.parseTranscript(path);
			expect(result?.model).toBe("second-model");
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
				env: { CURSOR_API_KEY: "test-key", CURSOR_HOST: "https://cursor.sh" },
			};
			const env = runtime.buildEnv(model);
			expect(env).toEqual({
				CURSOR_API_KEY: "test-key",
				CURSOR_HOST: "https://cursor.sh",
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

	describe("getTranscriptDir", () => {
		test("returns null (transcript location not yet verified)", () => {
			expect(runtime.getTranscriptDir("/some/project")).toBeNull();
		});
	});

	describe("requiresBeaconVerification", () => {
		test("not defined — defaults to true (gets resend loop)", () => {
			expect("requiresBeaconVerification" in runtime).toBe(false);
		});
	});
});

describe("CursorRuntime integration: registry resolves 'cursor'", () => {
	test("getRuntime('cursor') returns CursorRuntime", async () => {
		const { getRuntime } = await import("./registry.ts");
		const rt = getRuntime("cursor");
		expect(rt).toBeInstanceOf(CursorRuntime);
		expect(rt.id).toBe("cursor");
		expect(rt.instructionPath).toBe(".cursor/rules/overstory.md");
	});
});

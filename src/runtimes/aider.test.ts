import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AiderRuntime } from "./aider.ts";

describe("AiderRuntime", () => {
	const runtime = new AiderRuntime();
	let testDir: string;

	beforeEach(async () => {
		testDir = await mkdtemp(join(tmpdir(), "overstory-aider-test-"));
	});

	afterEach(async () => {
		await rm(testDir, { recursive: true });
	});

	it("has correct id and instruction path", () => {
		expect(runtime.id).toBe("aider");
		expect(runtime.instructionPath).toBe("CONVENTIONS.md");
	});

	it("buildSpawnCommand includes --yes-always --no-auto-commits and model", () => {
		const cmd = runtime.buildSpawnCommand({
			model: "anthropic/claude-sonnet-4-6",
			permissionMode: "bypass",
			cwd: "/tmp/test",
			env: {},
		});
		expect(cmd).toContain("aider --yes-always --no-auto-commits");
		expect(cmd).toContain("--model anthropic/claude-sonnet-4-6");
	});

	it("buildSpawnCommand includes append system prompt as --message", () => {
		const cmd = runtime.buildSpawnCommand({
			model: "sonnet",
			permissionMode: "bypass",
			appendSystemPrompt: "You are a scout.",
			cwd: "/tmp/test",
			env: {},
		});
		expect(cmd).toContain("--message");
		expect(cmd).toContain("You are a scout.");
	});

	it("buildSpawnCommand uses --read for appendSystemPromptFile", () => {
		const cmd = runtime.buildSpawnCommand({
			model: "sonnet",
			permissionMode: "bypass",
			appendSystemPromptFile: "/tmp/role.md",
			cwd: "/tmp/test",
			env: {},
		});
		expect(cmd).toContain("--read '/tmp/role.md'");
	});

	it("buildPrintCommand returns correct argv", () => {
		const argv = runtime.buildPrintCommand("fix the bug");
		expect(argv[0]).toBe("aider");
		expect(argv).toContain("--message");
		expect(argv).toContain("fix the bug");
		expect(argv).toContain("--yes-always");
		expect(argv).toContain("--no-auto-commits");
	});

	it("buildPrintCommand includes model when provided", () => {
		const argv = runtime.buildPrintCommand("fix the bug", "gpt-4o");
		expect(argv).toContain("--model");
		expect(argv).toContain("gpt-4o");
	});

	it("deployConfig writes CONVENTIONS.md", async () => {
		await runtime.deployConfig(
			testDir,
			{ content: "# Scout instructions" },
			{
				agentName: "scout-1",
				capability: "scout",
				worktreePath: testDir,
			},
		);
		const content = await readFile(join(testDir, "CONVENTIONS.md"), "utf-8");
		expect(content).toBe("# Scout instructions");
	});

	it("deployConfig is no-op when overlay is undefined", async () => {
		await runtime.deployConfig(testDir, undefined, {
			agentName: "scout-1",
			capability: "scout",
			worktreePath: testDir,
		});
		const file = Bun.file(join(testDir, "CONVENTIONS.md"));
		expect(await file.exists()).toBe(false);
	});

	it("detectReady recognizes aider prompt", () => {
		expect(runtime.detectReady("some output\naider> ").phase).toBe("ready");
		expect(runtime.detectReady("> ").phase).toBe("ready");
		expect(runtime.detectReady("Loading...").phase).toBe("loading");
	});

	it("does not require beacon verification", () => {
		expect(runtime.requiresBeaconVerification()).toBe(false);
	});

	it("parseTranscript returns null", async () => {
		expect(await runtime.parseTranscript("/nonexistent")).toBeNull();
	});

	it("buildEnv returns model env vars", () => {
		expect(runtime.buildEnv({ model: "sonnet", env: { OPENAI_API_KEY: "sk-test" } })).toEqual({
			OPENAI_API_KEY: "sk-test",
		});
	});

	it("buildEnv returns empty object when no env", () => {
		expect(runtime.buildEnv({ model: "sonnet" })).toEqual({});
	});

	it("getTranscriptDir returns null", () => {
		expect(runtime.getTranscriptDir("/tmp/project")).toBeNull();
	});
});

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AmpRuntime } from "./amp.ts";

describe("AmpRuntime", () => {
	const runtime = new AmpRuntime();
	let testDir: string;

	beforeEach(async () => {
		testDir = await mkdtemp(join(tmpdir(), "overstory-amp-test-"));
	});

	afterEach(async () => {
		await rm(testDir, { recursive: true });
	});

	it("has correct id and instruction path", () => {
		expect(runtime.id).toBe("amp");
		expect(runtime.instructionPath).toBe(".amp/AGENT.md");
	});

	it("buildSpawnCommand includes --model and --yes", () => {
		const cmd = runtime.buildSpawnCommand({
			model: "anthropic/claude-sonnet-4-6",
			permissionMode: "bypass",
			cwd: "/tmp/test",
			env: {},
		});
		expect(cmd).toContain("amp --model anthropic/claude-sonnet-4-6 --yes");
	});

	it("buildSpawnCommand includes append system prompt as --prompt", () => {
		const cmd = runtime.buildSpawnCommand({
			model: "sonnet",
			permissionMode: "bypass",
			appendSystemPrompt: "You are a reviewer.",
			cwd: "/tmp/test",
			env: {},
		});
		expect(cmd).toContain("--prompt");
		expect(cmd).toContain("You are a reviewer.");
	});

	it("buildSpawnCommand uses cat for appendSystemPromptFile", () => {
		const cmd = runtime.buildSpawnCommand({
			model: "sonnet",
			permissionMode: "bypass",
			appendSystemPromptFile: "/tmp/role.md",
			cwd: "/tmp/test",
			env: {},
		});
		expect(cmd).toContain("--prompt");
		expect(cmd).toContain("cat '/tmp/role.md'");
	});

	it("buildSpawnCommand includes default prompt when no append", () => {
		const cmd = runtime.buildSpawnCommand({
			model: "sonnet",
			permissionMode: "bypass",
			cwd: "/tmp/test",
			env: {},
		});
		expect(cmd).toContain("--prompt");
		expect(cmd).toContain("Read .amp/AGENT.md");
	});

	it("buildPrintCommand returns correct argv", () => {
		const argv = runtime.buildPrintCommand("review the diff");
		expect(argv[0]).toBe("amp");
		expect(argv).toContain("--prompt");
		expect(argv).toContain("review the diff");
		expect(argv).toContain("--no-input");
		expect(argv).toContain("--yes");
	});

	it("buildPrintCommand includes model when provided", () => {
		const argv = runtime.buildPrintCommand("review the diff", "gpt-4o");
		expect(argv).toContain("--model");
		expect(argv).toContain("gpt-4o");
	});

	it("deployConfig writes .amp/AGENT.md", async () => {
		await runtime.deployConfig(
			testDir,
			{ content: "# Reviewer instructions" },
			{
				agentName: "reviewer-1",
				capability: "reviewer",
				worktreePath: testDir,
			},
		);
		const content = await readFile(join(testDir, ".amp", "AGENT.md"), "utf-8");
		expect(content).toBe("# Reviewer instructions");
	});

	it("deployConfig creates parent .amp directory", async () => {
		await runtime.deployConfig(
			testDir,
			{ content: "# Test" },
			{
				agentName: "test",
				capability: "scout",
				worktreePath: testDir,
			},
		);
		const file = Bun.file(join(testDir, ".amp", "AGENT.md"));
		expect(await file.exists()).toBe(true);
	});

	it("deployConfig is no-op when overlay is undefined", async () => {
		await runtime.deployConfig(testDir, undefined, {
			agentName: "test",
			capability: "scout",
			worktreePath: testDir,
		});
		const file = Bun.file(join(testDir, ".amp", "AGENT.md"));
		expect(await file.exists()).toBe(false);
	});

	it("detectReady requires both prompt AND branding (AND logic)", () => {
		// Both prompt and branding → ready
		expect(runtime.detectReady("some output\namp> ").phase).toBe("ready");
		expect(runtime.detectReady("amp v1.0.0\n> ").phase).toBe("ready");
		expect(runtime.detectReady("AMP CLI\n> ").phase).toBe("ready");

		// Prompt only (no branding) → loading
		expect(runtime.detectReady("some output\n> ").phase).toBe("loading");

		// Branding only (no prompt) → loading
		expect(runtime.detectReady("amp v1.0.0").phase).toBe("loading");
		expect(runtime.detectReady("amp v1.2.3 starting...").phase).toBe("loading");

		// Neither → loading
		expect(runtime.detectReady("Initializing...").phase).toBe("loading");

		// Substring false-positive prevention: "amp" inside other words must NOT match branding
		expect(runtime.detectReady("this is an example output\n> ").phase).toBe("loading");
		expect(runtime.detectReady("stamped result\n> ").phase).toBe("loading");
	});

	it("does not require beacon verification", () => {
		expect(runtime.requiresBeaconVerification()).toBe(false);
	});

	it("parseTranscript returns null", async () => {
		expect(await runtime.parseTranscript("/nonexistent")).toBeNull();
	});

	it("buildEnv returns model env vars", () => {
		expect(runtime.buildEnv({ model: "sonnet", env: { SRC_ACCESS_TOKEN: "token" } })).toEqual({
			SRC_ACCESS_TOKEN: "token",
		});
	});

	it("buildEnv returns empty object when no env", () => {
		expect(runtime.buildEnv({ model: "sonnet" })).toEqual({});
	});

	it("getTranscriptDir returns null", () => {
		expect(runtime.getTranscriptDir("/tmp/project")).toBeNull();
	});
});

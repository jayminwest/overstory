import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GooseRuntime } from "./goose.ts";

describe("GooseRuntime", () => {
	const runtime = new GooseRuntime();
	let testDir: string;

	beforeEach(async () => {
		testDir = await mkdtemp(join(tmpdir(), "overstory-goose-test-"));
	});

	afterEach(async () => {
		await rm(testDir, { recursive: true });
	});

	it("has correct id and instruction path", () => {
		expect(runtime.id).toBe("goose");
		expect(runtime.instructionPath).toBe(".goosehints");
	});

	it("buildSpawnCommand includes model", () => {
		const cmd = runtime.buildSpawnCommand({
			model: "anthropic/claude-sonnet-4-6",
			permissionMode: "bypass",
			cwd: "/tmp/test",
			env: {},
		});
		expect(cmd).toContain("goose --model anthropic/claude-sonnet-4-6");
	});

	it("buildSpawnCommand includes append system prompt with --with-prompt", () => {
		const cmd = runtime.buildSpawnCommand({
			model: "sonnet",
			permissionMode: "bypass",
			appendSystemPrompt: "You are a builder.",
			cwd: "/tmp/test",
			env: {},
		});
		expect(cmd).toContain("--with-prompt");
		expect(cmd).toContain("You are a builder.");
	});

	it("buildSpawnCommand uses --instructions for appendSystemPromptFile", () => {
		const cmd = runtime.buildSpawnCommand({
			model: "sonnet",
			permissionMode: "bypass",
			appendSystemPromptFile: "/tmp/role.md",
			cwd: "/tmp/test",
			env: {},
		});
		expect(cmd).toContain("--instructions '/tmp/role.md'");
	});

	it("buildPrintCommand returns correct argv", () => {
		const argv = runtime.buildPrintCommand("scan for bugs");
		expect(argv[0]).toBe("goose");
		expect(argv[1]).toBe("run");
		expect(argv).toContain("--text");
		expect(argv).toContain("scan for bugs");
	});

	it("buildPrintCommand includes model when provided", () => {
		const argv = runtime.buildPrintCommand("scan for bugs", "gpt-4o");
		expect(argv).toContain("--model");
		expect(argv).toContain("gpt-4o");
	});

	it("deployConfig writes .goosehints", async () => {
		await runtime.deployConfig(
			testDir,
			{ content: "# Builder instructions" },
			{
				agentName: "builder-1",
				capability: "builder",
				worktreePath: testDir,
			},
		);
		const content = await readFile(join(testDir, ".goosehints"), "utf-8");
		expect(content).toBe("# Builder instructions");
	});

	it("deployConfig is no-op when overlay is undefined", async () => {
		await runtime.deployConfig(testDir, undefined, {
			agentName: "builder-1",
			capability: "builder",
			worktreePath: testDir,
		});
		const file = Bun.file(join(testDir, ".goosehints"));
		expect(await file.exists()).toBe(false);
	});

	it("detectReady requires both prompt AND branding (AND logic)", () => {
		// Both prompt and branding → ready
		expect(runtime.detectReady("Goose v1.2.3\n> ").phase).toBe("ready");
		expect(runtime.detectReady("goose-agent\n❯ ").phase).toBe("ready");
		expect(runtime.detectReady("( O) ready\n> ").phase).toBe("ready");

		// Prompt only (no branding) → loading
		expect(runtime.detectReady("thinking...\n> ").phase).toBe("loading");

		// Branding only (no prompt) → loading
		expect(runtime.detectReady("Goose v1.2.3").phase).toBe("loading");
		expect(runtime.detectReady("Loading Goose...").phase).toBe("loading");

		// Neither → loading
		expect(runtime.detectReady("Loading models...").phase).toBe("loading");
	});

	it("does not require beacon verification", () => {
		expect(runtime.requiresBeaconVerification()).toBe(false);
	});

	it("parseTranscript returns null", async () => {
		expect(await runtime.parseTranscript("/nonexistent")).toBeNull();
	});

	it("buildEnv returns model env vars", () => {
		expect(runtime.buildEnv({ model: "sonnet", env: { GOOSE_API_KEY: "key" } })).toEqual({
			GOOSE_API_KEY: "key",
		});
	});

	it("buildEnv returns empty object when no env", () => {
		expect(runtime.buildEnv({ model: "sonnet" })).toEqual({});
	});

	it("getTranscriptDir returns null", () => {
		expect(runtime.getTranscriptDir("/tmp/project")).toBeNull();
	});
});

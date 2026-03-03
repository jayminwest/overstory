import { describe, expect, it } from "bun:test";
import type { OverstoryConfig } from "../types.ts";
import { ClaudeRuntime } from "./claude.ts";
import { CodexRuntime } from "./codex.ts";
import { CopilotRuntime } from "./copilot.ts";
import { GeminiRuntime } from "./gemini.ts";
import { PiRuntime } from "./pi.ts";
import { getRuntime } from "./registry.ts";

describe("getRuntime", () => {
	it("returns a ClaudeRuntime by default (no args)", () => {
		const runtime = getRuntime();
		expect(runtime).toBeInstanceOf(ClaudeRuntime);
		expect(runtime.id).toBe("claude");
	});

	it('returns a ClaudeRuntime when name is "claude"', () => {
		const runtime = getRuntime("claude");
		expect(runtime).toBeInstanceOf(ClaudeRuntime);
		expect(runtime.id).toBe("claude");
	});

	it("throws with a helpful message for an unknown runtime", () => {
		expect(() => getRuntime("unknown-runtime")).toThrow(
			'Unknown runtime: "unknown-runtime". Available: claude, codex, pi, copilot, gemini',
		);
	});

	it("uses config.runtime.default when name is omitted", () => {
		const config = { runtime: { default: "claude" } } as OverstoryConfig;
		const runtime = getRuntime(undefined, config);
		expect(runtime).toBeInstanceOf(ClaudeRuntime);
		expect(runtime.id).toBe("claude");
	});

	it("explicit name overrides config.runtime.default", () => {
		const config = { runtime: { default: "claude" } } as OverstoryConfig;
		// Both are "claude" here since that's the only registered runtime,
		// but the name arg takes precedence over config.
		const runtime = getRuntime("claude", config);
		expect(runtime).toBeInstanceOf(ClaudeRuntime);
	});

	it("resolves codex runtime from config default", () => {
		const config = { runtime: { default: "codex" } } as OverstoryConfig;
		const runtime = getRuntime(undefined, config);
		expect(runtime).toBeInstanceOf(CodexRuntime);
		expect(runtime.id).toBe("codex");
	});

	it("returns a new instance on each call (factory pattern)", () => {
		const a = getRuntime();
		const b = getRuntime();
		expect(a).not.toBe(b);
	});

	it("returns PiRuntime when name is 'pi'", () => {
		const runtime = getRuntime("pi");
		expect(runtime).toBeInstanceOf(PiRuntime);
		expect(runtime.id).toBe("pi");
	});

	it("passes Pi config from OverstoryConfig to PiRuntime", () => {
		const config = {
			runtime: {
				default: "pi",
				pi: {
					provider: "amazon-bedrock",
					modelMap: {
						opus: "amazon-bedrock/us.anthropic.claude-opus-4-6-v1",
					},
				},
			},
		} as unknown as OverstoryConfig;
		const runtime = getRuntime(undefined, config) as PiRuntime;
		expect(runtime).toBeInstanceOf(PiRuntime);
		// Verify the config was applied by testing model expansion
		expect(runtime.expandModel("opus")).toBe("amazon-bedrock/us.anthropic.claude-opus-4-6-v1");
	});

	it("Pi runtime uses defaults when no Pi config in OverstoryConfig", () => {
		const config = { runtime: { default: "pi" } } as OverstoryConfig;
		const runtime = getRuntime(undefined, config) as PiRuntime;
		expect(runtime).toBeInstanceOf(PiRuntime);
		// Should use default anthropic mappings
		expect(runtime.expandModel("sonnet")).toBe("anthropic/claude-sonnet-4-6");
	});

	it("returns CopilotRuntime when name is 'copilot'", () => {
		const runtime = getRuntime("copilot");
		expect(runtime).toBeInstanceOf(CopilotRuntime);
		expect(runtime.id).toBe("copilot");
	});

	it("uses config.runtime.default 'copilot' when name is omitted", () => {
		const config = { runtime: { default: "copilot" } } as OverstoryConfig;
		const runtime = getRuntime(undefined, config);
		expect(runtime).toBeInstanceOf(CopilotRuntime);
		expect(runtime.id).toBe("copilot");
	});

	it("copilot runtime returns a new instance on each call", () => {
		const a = getRuntime("copilot");
		const b = getRuntime("copilot");
		expect(a).not.toBe(b);
	});

	it("returns GeminiRuntime when name is 'gemini'", () => {
		const runtime = getRuntime("gemini");
		expect(runtime).toBeInstanceOf(GeminiRuntime);
		expect(runtime.id).toBe("gemini");
	});

	it("uses config.runtime.default 'gemini' when name is omitted", () => {
		const config = { runtime: { default: "gemini" } } as OverstoryConfig;
		const runtime = getRuntime(undefined, config);
		expect(runtime).toBeInstanceOf(GeminiRuntime);
		expect(runtime.id).toBe("gemini");
	});
});

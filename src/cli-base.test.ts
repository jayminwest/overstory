import { describe, expect, test } from "bun:test";
import {
	buildInteractiveAgentCommand,
	getInstructionLayout,
	requiresNonRoot,
	resolveCliBase,
} from "./cli-base.ts";
import type { OverstoryConfig } from "./types.ts";

function makeConfig(overrides: Partial<OverstoryConfig> = {}): OverstoryConfig {
	return {
		project: { name: "test", root: "/tmp/test", canonicalBranch: "main" },
		agents: {
			manifestPath: ".overstory/agent-manifest.json",
			baseDir: ".overstory/agent-defs",
			maxConcurrent: 25,
			staggerDelayMs: 2_000,
			maxDepth: 2,
		},
		worktrees: { baseDir: ".overstory/worktrees" },
		beads: { enabled: true },
		mulch: { enabled: true, domains: [], primeFormat: "markdown" },
		merge: { aiResolveEnabled: true, reimagineEnabled: false },
		cli: { base: "claude" },
		providers: { anthropic: { type: "native" } },
		watchdog: {
			tier0Enabled: true,
			tier0IntervalMs: 30_000,
			tier1Enabled: false,
			tier2Enabled: false,
			staleThresholdMs: 300_000,
			zombieThresholdMs: 600_000,
			nudgeIntervalMs: 60_000,
		},
		models: {},
		logging: { verbose: false, redactSecrets: true },
		...overrides,
	};
}

describe("resolveCliBase", () => {
	test("defaults to claude when cli section is missing", () => {
		const config = makeConfig();
		delete config.cli;
		expect(resolveCliBase(config)).toBe("claude");
	});

	test("returns codex when configured", () => {
		const config = makeConfig({ cli: { base: "codex" } });
		expect(resolveCliBase(config)).toBe("codex");
	});
});

describe("getInstructionLayout", () => {
	test("returns claude paths", () => {
		const layout = getInstructionLayout("claude");
		expect(layout.dir).toBe(".claude");
		expect(layout.file).toBe("CLAUDE.md");
		expect(layout.startupPath).toBe(".claude/CLAUDE.md");
	});

	test("returns codex paths", () => {
		const layout = getInstructionLayout("codex");
		expect(layout.dir).toBe(".");
		expect(layout.file).toBe("AGENTS.md");
		expect(layout.startupPath).toBe("AGENTS.md");
	});
});

describe("buildInteractiveAgentCommand", () => {
	test("embeds system prompt for claude", () => {
		const result = buildInteractiveAgentCommand({
			cliBase: "claude",
			model: "opus",
			systemPrompt: "You are coordinator",
		});
		expect(result.command).toContain("claude --model opus");
		expect(result.command).toContain("--append-system-prompt");
		expect(result.systemPromptEmbedded).toBe(true);
	});

	test("uses codex launch command without inline prompt injection", () => {
		const result = buildInteractiveAgentCommand({
			cliBase: "codex",
			model: "gpt-5",
			systemPrompt: "ignored for now",
		});
		expect(result.command).toBe("codex --model gpt-5");
		expect(result.systemPromptEmbedded).toBe(false);
	});
});

describe("requiresNonRoot", () => {
	test("returns true for claude and false for codex", () => {
		expect(requiresNonRoot("claude")).toBe(true);
		expect(requiresNonRoot("codex")).toBe(false);
	});
});

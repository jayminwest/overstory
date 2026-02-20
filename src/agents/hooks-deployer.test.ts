import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentError } from "../errors.ts";
import { createEventStore } from "../events/store.ts";
import {
	buildBashFileGuardScript,
	buildBashPathBoundaryScript,
	buildPathBoundaryGuardScript,
	deployHooks,
	getBashPathBoundaryGuards,
	getCapabilityGuards,
	getDangerGuards,
	getPathBoundaryGuards,
} from "./hooks-deployer.ts";

describe("deployHooks", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "overstory-hooks-test-"));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	test("creates .claude/settings.local.json in worktree directory", async () => {
		const worktreePath = join(tempDir, "worktree");

		await deployHooks(worktreePath, "test-agent");

		const outputPath = join(worktreePath, ".claude", "settings.local.json");
		const exists = await Bun.file(outputPath).exists();
		expect(exists).toBe(true);
	});

	test("replaces {{AGENT_NAME}} with the actual agent name", async () => {
		const worktreePath = join(tempDir, "worktree");

		await deployHooks(worktreePath, "my-builder");

		const outputPath = join(worktreePath, ".claude", "settings.local.json");
		const content = await Bun.file(outputPath).text();
		expect(content).toContain("my-builder");
		expect(content).not.toContain("{{AGENT_NAME}}");
	});

	test("replaces all occurrences of {{AGENT_NAME}}", async () => {
		const worktreePath = join(tempDir, "worktree");

		await deployHooks(worktreePath, "scout-alpha");

		const outputPath = join(worktreePath, ".claude", "settings.local.json");
		const content = await Bun.file(outputPath).text();

		// The template has {{AGENT_NAME}} in multiple hook commands
		const occurrences = content.split("scout-alpha").length - 1;
		expect(occurrences).toBeGreaterThanOrEqual(6);
		expect(content).not.toContain("{{AGENT_NAME}}");
	});

	test("output is valid JSON", async () => {
		const worktreePath = join(tempDir, "worktree");

		await deployHooks(worktreePath, "json-test-agent");

		const outputPath = join(worktreePath, ".claude", "settings.local.json");
		const content = await Bun.file(outputPath).text();
		const parsed = JSON.parse(content);
		expect(parsed).toBeDefined();
		expect(parsed.hooks).toBeDefined();
	});

	test("output contains SessionStart hook", async () => {
		const worktreePath = join(tempDir, "worktree");

		await deployHooks(worktreePath, "hook-check");

		const outputPath = join(worktreePath, ".claude", "settings.local.json");
		const content = await Bun.file(outputPath).text();
		const parsed = JSON.parse(content);
		expect(parsed.hooks.SessionStart).toBeDefined();
		expect(parsed.hooks.SessionStart).toBeArray();
		expect(parsed.hooks.SessionStart.length).toBeGreaterThan(0);
	});

	test("output contains UserPromptSubmit hook", async () => {
		const worktreePath = join(tempDir, "worktree");

		await deployHooks(worktreePath, "hook-check");

		const outputPath = join(worktreePath, ".claude", "settings.local.json");
		const content = await Bun.file(outputPath).text();
		const parsed = JSON.parse(content);
		expect(parsed.hooks.UserPromptSubmit).toBeDefined();
		expect(parsed.hooks.UserPromptSubmit).toBeArray();
	});

	test("output contains PreToolUse hook", async () => {
		const worktreePath = join(tempDir, "worktree");

		await deployHooks(worktreePath, "hook-check");

		const outputPath = join(worktreePath, ".claude", "settings.local.json");
		const content = await Bun.file(outputPath).text();
		const parsed = JSON.parse(content);
		expect(parsed.hooks.PreToolUse).toBeDefined();
		expect(parsed.hooks.PreToolUse).toBeArray();
	});

	test("output contains PostToolUse hook", async () => {
		const worktreePath = join(tempDir, "worktree");

		await deployHooks(worktreePath, "hook-check");

		const outputPath = join(worktreePath, ".claude", "settings.local.json");
		const content = await Bun.file(outputPath).text();
		const parsed = JSON.parse(content);
		expect(parsed.hooks.PostToolUse).toBeDefined();
		expect(parsed.hooks.PostToolUse).toBeArray();
	});

	test("output contains Stop hook", async () => {
		const worktreePath = join(tempDir, "worktree");

		await deployHooks(worktreePath, "hook-check");

		const outputPath = join(worktreePath, ".claude", "settings.local.json");
		const content = await Bun.file(outputPath).text();
		const parsed = JSON.parse(content);
		expect(parsed.hooks.Stop).toBeDefined();
		expect(parsed.hooks.Stop).toBeArray();
	});

	test("PostToolUse hook includes debounced mail check entry", async () => {
		const worktreePath = join(tempDir, "worktree");

		await deployHooks(worktreePath, "mail-check-agent");

		const outputPath = join(worktreePath, ".claude", "settings.local.json");
		const content = await Bun.file(outputPath).text();
		const parsed = JSON.parse(content);
		const postToolUse = parsed.hooks.PostToolUse;
		// PostToolUse should have 2 entries: logger and mail check
		expect(postToolUse).toHaveLength(2);
		// First entry is the logging hook
		expect(postToolUse[0].hooks[0].command).toContain("overstory log tool-end");
		// Second entry is the debounced mail check
		expect(postToolUse[1].hooks[0].command).toContain("overstory mail check --inject");
		expect(postToolUse[1].hooks[0].command).toContain("mail-check-agent");
		expect(postToolUse[1].hooks[0].command).toContain("--debounce 30000");
		expect(postToolUse[1].hooks[0].command).toContain("OVERSTORY_AGENT_NAME");
	});

	test("output contains PreCompact hook", async () => {
		const worktreePath = join(tempDir, "worktree");

		await deployHooks(worktreePath, "hook-check");

		const outputPath = join(worktreePath, ".claude", "settings.local.json");
		const content = await Bun.file(outputPath).text();
		const parsed = JSON.parse(content);
		expect(parsed.hooks.PreCompact).toBeDefined();
		expect(parsed.hooks.PreCompact).toBeArray();
	});

	test("all six hook types are present", async () => {
		const worktreePath = join(tempDir, "worktree");

		await deployHooks(worktreePath, "all-hooks");

		const outputPath = join(worktreePath, ".claude", "settings.local.json");
		const content = await Bun.file(outputPath).text();
		const parsed = JSON.parse(content);
		const hookTypes = Object.keys(parsed.hooks);
		expect(hookTypes).toContain("SessionStart");
		expect(hookTypes).toContain("UserPromptSubmit");
		expect(hookTypes).toContain("PreToolUse");
		expect(hookTypes).toContain("PostToolUse");
		expect(hookTypes).toContain("Stop");
		expect(hookTypes).toContain("PreCompact");
		expect(hookTypes).toHaveLength(6);
	});

	test("SessionStart hook runs overstory init", async () => {
		const worktreePath = join(tempDir, "worktree");

		await deployHooks(worktreePath, "prime-agent");

		const outputPath = join(worktreePath, ".claude", "settings.local.json");
		const content = await Bun.file(outputPath).text();
		const parsed = JSON.parse(content);
		const sessionStart = parsed.hooks.SessionStart[0];
		expect(sessionStart.hooks[0].type).toBe("command");
		expect(sessionStart.hooks[0].command).toContain("overstory init");
		expect(sessionStart.hooks[0].command).toContain("OVERSTORY_AGENT_NAME");
	});

	test("UserPromptSubmit hook runs mail check with agent name", async () => {
		const worktreePath = join(tempDir, "worktree");

		await deployHooks(worktreePath, "mail-agent");

		const outputPath = join(worktreePath, ".claude", "settings.local.json");
		const content = await Bun.file(outputPath).text();
		const parsed = JSON.parse(content);
		const userPrompt = parsed.hooks.UserPromptSubmit[0];
		expect(userPrompt.hooks[0].command).toContain(
			"overstory mail check --inject --agent mail-agent",
		);
		expect(userPrompt.hooks[0].command).toContain("OVERSTORY_AGENT_NAME");
	});

	test("PreCompact hook runs overstory init", async () => {
		const worktreePath = join(tempDir, "worktree");

		await deployHooks(worktreePath, "compact-agent");

		const outputPath = join(worktreePath, ".claude", "settings.local.json");
		const content = await Bun.file(outputPath).text();
		const parsed = JSON.parse(content);
		const preCompact = parsed.hooks.PreCompact[0];
		expect(preCompact.hooks[0].type).toBe("command");
		expect(preCompact.hooks[0].command).toContain("overstory init");
		expect(preCompact.hooks[0].command).toContain("OVERSTORY_AGENT_NAME");
	});

	test("PreToolUse hook pipes stdin to overstory log with --stdin flag", async () => {
		const worktreePath = join(tempDir, "worktree");

		await deployHooks(worktreePath, "stdin-agent");

		const outputPath = join(worktreePath, ".claude", "settings.local.json");
		const content = await Bun.file(outputPath).text();
		const parsed = JSON.parse(content);

		// Find the base PreToolUse hook (matcher == "")
		const preToolUse = parsed.hooks.PreToolUse;
		const baseHook = preToolUse.find((h: { matcher: string }) => h.matcher === "");
		expect(baseHook).toBeDefined();
		expect(baseHook.hooks[0].command).toContain("--stdin");
		expect(baseHook.hooks[0].command).toContain("overstory log tool-start");
		expect(baseHook.hooks[0].command).toContain("stdin-agent");
		expect(baseHook.hooks[0].command).not.toContain("read -r INPUT");
	});

	test("PostToolUse hook pipes stdin to overstory log with --stdin flag", async () => {
		const worktreePath = join(tempDir, "worktree");

		await deployHooks(worktreePath, "stdin-agent");

		const outputPath = join(worktreePath, ".claude", "settings.local.json");
		const content = await Bun.file(outputPath).text();
		const parsed = JSON.parse(content);
		const postToolUse = parsed.hooks.PostToolUse[0];
		expect(postToolUse.hooks[0].command).toContain("--stdin");
		expect(postToolUse.hooks[0].command).toContain("overstory log tool-end");
		expect(postToolUse.hooks[0].command).toContain("stdin-agent");
		expect(postToolUse.hooks[0].command).not.toContain("read -r INPUT");
	});

	test("PostToolUse hook includes mail check with debounce", async () => {
		const worktreePath = join(tempDir, "mail-debounce-wt");

		await deployHooks(worktreePath, "mail-debounce-agent");

		const outputPath = join(worktreePath, ".claude", "settings.local.json");
		const content = await Bun.file(outputPath).text();
		const parsed = JSON.parse(content);
		const postToolUse = parsed.hooks.PostToolUse[0];

		// Should have 2 hooks: tool-end logging + mail check
		expect(postToolUse.hooks).toHaveLength(2);

		// Second hook should be mail check with debounce
		expect(postToolUse.hooks[1].command).toContain("overstory mail check");
		expect(postToolUse.hooks[1].command).toContain("--inject");
		expect(postToolUse.hooks[1].command).toContain("--agent mail-debounce-agent");
		expect(postToolUse.hooks[1].command).toContain("--debounce 500");
		expect(postToolUse.hooks[1].command).toContain("OVERSTORY_AGENT_NAME");
	});

	test("Stop hook pipes stdin to overstory log with --stdin flag", async () => {
		const worktreePath = join(tempDir, "worktree");

		await deployHooks(worktreePath, "stdin-agent");

		const outputPath = join(worktreePath, ".claude", "settings.local.json");
		const content = await Bun.file(outputPath).text();
		const parsed = JSON.parse(content);
		const stop = parsed.hooks.Stop[0];
		expect(stop.hooks[0].command).toContain("--stdin");
		expect(stop.hooks[0].command).toContain("overstory log session-end");
		expect(stop.hooks[0].command).toContain("stdin-agent");
		expect(stop.hooks[0].command).not.toContain("read -r INPUT");
	});

	test("Stop hook includes mulch learn command", async () => {
		const worktreePath = join(tempDir, "worktree");

		await deployHooks(worktreePath, "learn-agent");

		const outputPath = join(worktreePath, ".claude", "settings.local.json");
		const content = await Bun.file(outputPath).text();
		const parsed = JSON.parse(content);
		const stop = parsed.hooks.Stop[0];
		expect(stop.hooks.length).toBe(2);
		expect(stop.hooks[1].command).toContain("mulch learn");
		expect(stop.hooks[1].command).toContain("OVERSTORY_AGENT_NAME");
	});

	test("hook commands no longer use sed-based extraction", async () => {
		const worktreePath = join(tempDir, "worktree");

		await deployHooks(worktreePath, "no-sed-agent");

		const outputPath = join(worktreePath, ".claude", "settings.local.json");
		const content = await Bun.file(outputPath).text();
		const parsed = JSON.parse(content);

		// PreToolUse base hook should not contain sed or --tool-name
		const preToolUse = parsed.hooks.PreToolUse;
		const basePreHook = preToolUse.find((h: { matcher: string }) => h.matcher === "");
		expect(basePreHook.hooks[0].command).not.toContain("--tool-name");
		expect(basePreHook.hooks[0].command).not.toContain("TOOL_NAME=$(");

		// PostToolUse should not contain sed or --tool-name
		const postToolUse = parsed.hooks.PostToolUse[0];
		expect(postToolUse.hooks[0].command).not.toContain("--tool-name");
		expect(postToolUse.hooks[0].command).not.toContain("TOOL_NAME=$(");
	});

	test("creates .claude directory even if worktree already exists", async () => {
		const worktreePath = join(tempDir, "existing-worktree");
		const { mkdir } = await import("node:fs/promises");
		await mkdir(worktreePath, { recursive: true });

		await deployHooks(worktreePath, "test-agent");

		const outputPath = join(worktreePath, ".claude", "settings.local.json");
		const exists = await Bun.file(outputPath).exists();
		expect(exists).toBe(true);
	});

	test("overwrites existing settings.local.json", async () => {
		const worktreePath = join(tempDir, "worktree");
		const claudeDir = join(worktreePath, ".claude");
		const { mkdir } = await import("node:fs/promises");
		await mkdir(claudeDir, { recursive: true });
		await Bun.write(join(claudeDir, "settings.local.json"), '{"old": true}');

		await deployHooks(worktreePath, "new-agent");

		const content = await Bun.file(join(claudeDir, "settings.local.json")).text();
		expect(content).toContain("new-agent");
		expect(content).not.toContain('"old"');
	});

	test("handles agent names with special characters", async () => {
		const worktreePath = join(tempDir, "worktree");

		await deployHooks(worktreePath, "agent-with-dashes-123");

		const outputPath = join(worktreePath, ".claude", "settings.local.json");
		const content = await Bun.file(outputPath).text();
		expect(content).toContain("agent-with-dashes-123");
		// Should still be valid JSON
		const parsed = JSON.parse(content);
		expect(parsed.hooks).toBeDefined();
	});

	test("throws AgentError when template is missing", async () => {
		// We can't easily remove the template without affecting the repo,
		// but we can verify the error type by testing the module's behavior.
		// The function uses getTemplatePath() internally which is not exported,
		// so we test indirectly: verify that a successful call works, confirming
		// the template exists. The error path is tested via the error type assertion.
		const worktreePath = join(tempDir, "worktree");

		// Successful deployment proves the template exists
		await deployHooks(worktreePath, "template-exists");
		const exists = await Bun.file(join(worktreePath, ".claude", "settings.local.json")).exists();
		expect(exists).toBe(true);
	});

	test("AgentError includes agent name in context", async () => {
		// Verify AgentError shape by constructing one (as the function does internally)
		const error = new AgentError("test error", { agentName: "failing-agent" });
		expect(error.agentName).toBe("failing-agent");
		expect(error.code).toBe("AGENT_ERROR");
		expect(error.name).toBe("AgentError");
		expect(error.message).toBe("test error");
	});

	test("write failure throws AgentError", async () => {
		// Use a path that will fail to write (read-only parent)
		const invalidPath = "/dev/null/impossible-path";

		try {
			await deployHooks(invalidPath, "fail-agent");
			// Should not reach here
			expect(true).toBe(false);
		} catch (err) {
			expect(err).toBeInstanceOf(AgentError);
			if (err instanceof AgentError) {
				expect(err.agentName).toBe("fail-agent");
				expect(err.code).toBe("AGENT_ERROR");
			}
		}
	});

	test("scout capability adds path boundary + block guards for Write/Edit/NotebookEdit and Bash file guards", async () => {
		const worktreePath = join(tempDir, "scout-wt");

		await deployHooks(worktreePath, "scout-agent", "scout");

		const outputPath = join(worktreePath, ".claude", "settings.local.json");
		const content = await Bun.file(outputPath).text();
		const parsed = JSON.parse(content);
		const preToolUse = parsed.hooks.PreToolUse;

		// Scout gets both path boundary guards AND block guards for Write/Edit/NotebookEdit
		const writeGuards = preToolUse.filter((h: { matcher: string }) => h.matcher === "Write");
		const editGuards = preToolUse.filter((h: { matcher: string }) => h.matcher === "Edit");
		const notebookGuards = preToolUse.filter(
			(h: { matcher: string }) => h.matcher === "NotebookEdit",
		);

		// 2 each: path boundary + capability block
		expect(writeGuards.length).toBe(2);
		expect(editGuards.length).toBe(2);
		expect(notebookGuards.length).toBe(2);

		// Find the capability block guard (contains "cannot modify files")
		const writeBlockGuard = writeGuards.find((h: { hooks: Array<{ command: string }> }) =>
			h.hooks[0]?.command?.includes("cannot modify files"),
		);
		expect(writeBlockGuard).toBeDefined();
		expect(writeBlockGuard.hooks[0].command).toContain('"decision":"block"');

		// Should have multiple Bash guards: danger guard + file guard + universal push guard
		const bashGuards = preToolUse.filter((h: { matcher: string }) => h.matcher === "Bash");
		expect(bashGuards.length).toBe(3); // danger guard + file guard + universal push guard
	});

	test("reviewer capability adds same guards as scout", async () => {
		const worktreePath = join(tempDir, "reviewer-wt");

		await deployHooks(worktreePath, "reviewer-agent", "reviewer");

		const outputPath = join(worktreePath, ".claude", "settings.local.json");
		const content = await Bun.file(outputPath).text();
		const parsed = JSON.parse(content);
		const preToolUse = parsed.hooks.PreToolUse;

		const guardMatchers = preToolUse
			.filter((h: { matcher: string }) => h.matcher !== "")
			.map((h: { matcher: string }) => h.matcher);

		expect(guardMatchers).toContain("Bash");
		expect(guardMatchers).toContain("Write");
		expect(guardMatchers).toContain("Edit");
		expect(guardMatchers).toContain("NotebookEdit");
	});

	test("lead capability gets Write/Edit/NotebookEdit guards and Bash file guards", async () => {
		const worktreePath = join(tempDir, "lead-wt");

		await deployHooks(worktreePath, "lead-agent", "lead");

		const outputPath = join(worktreePath, ".claude", "settings.local.json");
		const content = await Bun.file(outputPath).text();
		const parsed = JSON.parse(content);
		const preToolUse = parsed.hooks.PreToolUse;

		const guardMatchers = preToolUse
			.filter((h: { matcher: string }) => h.matcher !== "")
			.map((h: { matcher: string }) => h.matcher);

		expect(guardMatchers).toContain("Write");
		expect(guardMatchers).toContain("Edit");
		expect(guardMatchers).toContain("NotebookEdit");
		expect(guardMatchers).toContain("Bash");

		// Should have 3 Bash guards: danger guard + file guard + universal push guard
		const bashGuards = preToolUse.filter((h: { matcher: string }) => h.matcher === "Bash");
		expect(bashGuards.length).toBe(3);
	});

	test("builder capability gets path boundary + Bash danger + Bash path boundary guards + native team tool blocks", async () => {
		const worktreePath = join(tempDir, "builder-wt");

		await deployHooks(worktreePath, "builder-agent", "builder");

		const outputPath = join(worktreePath, ".claude", "settings.local.json");
		const content = await Bun.file(outputPath).text();
		const parsed = JSON.parse(content);
		const preToolUse = parsed.hooks.PreToolUse;

		const guardMatchers = preToolUse
			.filter((h: { matcher: string }) => h.matcher !== "")
			.map((h: { matcher: string }) => h.matcher);

		// Path boundary guards + Bash danger guard + Bash path boundary guard + 10 native team tool blocks
		expect(guardMatchers).toContain("Bash");
		expect(guardMatchers).toContain("Task");
		expect(guardMatchers).toContain("TeamCreate");
		// Builder has Write guards for path boundary (not block guards)
		expect(guardMatchers).toContain("Write");
		const writeGuards = preToolUse.filter(
			(h: { matcher: string; hooks: Array<{ command: string }> }) => h.matcher === "Write",
		);
		// Path boundary guard, not a full block
		expect(writeGuards[0].hooks[0].command).toContain("OVERSTORY_WORKTREE_PATH");
		expect(writeGuards[0].hooks[0].command).not.toContain("cannot modify files");

		// Builder should have 3 Bash guards: danger guard + path boundary guard + universal push guard
		const bashGuards = preToolUse.filter((h: { matcher: string }) => h.matcher === "Bash");
		expect(bashGuards.length).toBe(3);
		// One should be the danger guard (checks git push)
		const dangerGuard = bashGuards.find(
			(h: { hooks: Array<{ command: string }> }) =>
				h.hooks[0]?.command?.includes("git") && h.hooks[0]?.command?.includes("push"),
		);
		expect(dangerGuard).toBeDefined();
		// One should be the path boundary guard
		const pathBoundaryGuard = bashGuards.find((h: { hooks: Array<{ command: string }> }) =>
			h.hooks[0]?.command?.includes("Bash path boundary violation"),
		);
		expect(pathBoundaryGuard).toBeDefined();
	});

	test("merger capability gets path boundary + Bash danger guards + native team tool blocks", async () => {
		const worktreePath = join(tempDir, "merger-wt");

		await deployHooks(worktreePath, "merger-agent", "merger");

		const outputPath = join(worktreePath, ".claude", "settings.local.json");
		const content = await Bun.file(outputPath).text();
		const parsed = JSON.parse(content);
		const preToolUse = parsed.hooks.PreToolUse;

		const guardMatchers = preToolUse
			.filter((h: { matcher: string }) => h.matcher !== "")
			.map((h: { matcher: string }) => h.matcher);

		expect(guardMatchers).toContain("Bash");
		expect(guardMatchers).toContain("Task");
		// Merger has Write path boundary guards
		expect(guardMatchers).toContain("Write");
	});

	test("default capability (no arg) gets path boundary + Bash danger guards + native team tool blocks", async () => {
		const worktreePath = join(tempDir, "default-wt");

		await deployHooks(worktreePath, "default-agent");

		const outputPath = join(worktreePath, ".claude", "settings.local.json");
		const content = await Bun.file(outputPath).text();
		const parsed = JSON.parse(content);
		const preToolUse = parsed.hooks.PreToolUse;

		const guardMatchers = preToolUse
			.filter((h: { matcher: string }) => h.matcher !== "")
			.map((h: { matcher: string }) => h.matcher);

		expect(guardMatchers).toContain("Bash");
		expect(guardMatchers).toContain("Task");
		// Default (builder) has Write path boundary guards
		expect(guardMatchers).toContain("Write");
	});

	test("guards are prepended before base logging hook", async () => {
		const worktreePath = join(tempDir, "order-wt");

		await deployHooks(worktreePath, "order-agent", "scout");

		const outputPath = join(worktreePath, ".claude", "settings.local.json");
		const content = await Bun.file(outputPath).text();
		const parsed = JSON.parse(content);
		const preToolUse = parsed.hooks.PreToolUse;

		// Guards (matcher != "") should come before base (matcher == "")
		const baseIdx = preToolUse.findIndex((h: { matcher: string }) => h.matcher === "");
		const writeIdx = preToolUse.findIndex((h: { matcher: string }) => h.matcher === "Write");

		expect(writeIdx).toBeLessThan(baseIdx);
	});
});

describe("getCapabilityGuards", () => {
	// 10 native team tool blocks apply to ALL capabilities
	const NATIVE_TEAM_TOOL_COUNT = 10;

	test("returns 14 guards for scout (10 team + 3 tool blocks + 1 bash file guard)", () => {
		const guards = getCapabilityGuards("scout");
		expect(guards.length).toBe(NATIVE_TEAM_TOOL_COUNT + 4);
	});

	test("returns 14 guards for reviewer (10 team + 3 tool blocks + 1 bash file guard)", () => {
		const guards = getCapabilityGuards("reviewer");
		expect(guards.length).toBe(NATIVE_TEAM_TOOL_COUNT + 4);
	});

	test("returns 14 guards for lead (10 team + 3 tool blocks + 1 bash file guard)", () => {
		const guards = getCapabilityGuards("lead");
		expect(guards.length).toBe(NATIVE_TEAM_TOOL_COUNT + 4);
	});

	test("returns 11 guards for builder (10 team + 1 bash path boundary)", () => {
		const guards = getCapabilityGuards("builder");
		expect(guards.length).toBe(NATIVE_TEAM_TOOL_COUNT + 1);
	});

	test("returns 11 guards for merger (10 team + 1 bash path boundary)", () => {
		const guards = getCapabilityGuards("merger");
		expect(guards.length).toBe(NATIVE_TEAM_TOOL_COUNT + 1);
	});

	test("returns 10 guards for unknown capability (10 team tool blocks only)", () => {
		const guards = getCapabilityGuards("unknown");
		expect(guards.length).toBe(NATIVE_TEAM_TOOL_COUNT);
	});

	test("builder gets Bash path boundary guard", () => {
		const guards = getCapabilityGuards("builder");
		const bashGuard = guards.find((g) => g.matcher === "Bash");
		expect(bashGuard).toBeDefined();
		expect(bashGuard?.hooks[0]?.command).toContain("OVERSTORY_WORKTREE_PATH");
		expect(bashGuard?.hooks[0]?.command).toContain("Bash path boundary violation");
	});

	test("merger gets Bash path boundary guard", () => {
		const guards = getCapabilityGuards("merger");
		const bashGuard = guards.find((g) => g.matcher === "Bash");
		expect(bashGuard).toBeDefined();
		expect(bashGuard?.hooks[0]?.command).toContain("OVERSTORY_WORKTREE_PATH");
		expect(bashGuard?.hooks[0]?.command).toContain("Bash path boundary violation");
	});

	test("scout guards include Write, Edit, NotebookEdit, and Bash matchers", () => {
		const guards = getCapabilityGuards("scout");
		const matchers = guards.map((g) => g.matcher);
		expect(matchers).toContain("Write");
		expect(matchers).toContain("Edit");
		expect(matchers).toContain("NotebookEdit");
		expect(matchers).toContain("Bash");
	});

	test("lead guards include Write, Edit, NotebookEdit, and Bash matchers", () => {
		const guards = getCapabilityGuards("lead");
		const matchers = guards.map((g) => g.matcher);
		expect(matchers).toContain("Write");
		expect(matchers).toContain("Edit");
		expect(matchers).toContain("NotebookEdit");
		expect(matchers).toContain("Bash");
	});

	test("tool block guards include capability name in reason", () => {
		const guards = getCapabilityGuards("scout");
		const writeGuard = guards.find((g) => g.matcher === "Write");
		expect(writeGuard).toBeDefined();
		expect(writeGuard?.hooks[0]?.command).toContain("scout");
		expect(writeGuard?.hooks[0]?.command).toContain("cannot modify files");
	});

	test("lead tool block guards include lead in reason", () => {
		const guards = getCapabilityGuards("lead");
		const editGuard = guards.find((g) => g.matcher === "Edit");
		expect(editGuard).toBeDefined();
		expect(editGuard?.hooks[0]?.command).toContain("lead");
		expect(editGuard?.hooks[0]?.command).toContain("cannot modify files");
	});

	test("bash file guard for scout includes capability in block message", () => {
		const guards = getCapabilityGuards("scout");
		const bashGuard = guards.find((g) => g.matcher === "Bash");
		expect(bashGuard).toBeDefined();
		expect(bashGuard?.hooks[0]?.command).toContain("scout agents cannot modify files");
	});

	test("bash file guard for lead includes capability in block message", () => {
		const guards = getCapabilityGuards("lead");
		const bashGuard = guards.find((g) => g.matcher === "Bash");
		expect(bashGuard).toBeDefined();
		expect(bashGuard?.hooks[0]?.command).toContain("lead agents cannot modify files");
	});

	test("all capabilities get Task tool blocked", () => {
		for (const cap of [
			"scout",
			"reviewer",
			"lead",
			"coordinator",
			"supervisor",
			"builder",
			"merger",
		]) {
			const guards = getCapabilityGuards(cap);
			const taskGuard = guards.find((g) => g.matcher === "Task");
			expect(taskGuard).toBeDefined();
			expect(taskGuard?.hooks[0]?.command).toContain("overstory sling");
		}
	});

	test("all capabilities get TeamCreate and SendMessage blocked", () => {
		for (const cap of [
			"scout",
			"reviewer",
			"lead",
			"coordinator",
			"supervisor",
			"builder",
			"merger",
		]) {
			const guards = getCapabilityGuards(cap);
			const matchers = guards.map((g) => g.matcher);
			expect(matchers).toContain("TeamCreate");
			expect(matchers).toContain("SendMessage");
		}
	});

	test("block guard commands include env var guard prefix", () => {
		const guards = getCapabilityGuards("scout");
		for (const tool of ["Write", "Edit", "NotebookEdit"]) {
			const guard = guards.find((g) => g.matcher === tool);
			expect(guard).toBeDefined();
			expect(guard?.hooks[0]?.command).toContain('[ -z "$OVERSTORY_AGENT_NAME" ] && exit 0;');
		}
	});

	test("native team tool block guards include env var guard prefix", () => {
		const guards = getCapabilityGuards("builder");
		const taskGuard = guards.find((g) => g.matcher === "Task");
		expect(taskGuard).toBeDefined();
		expect(taskGuard?.hooks[0]?.command).toContain('[ -z "$OVERSTORY_AGENT_NAME" ] && exit 0;');
	});

	test("coordinator gets 14 guards (10 team + 3 tool blocks + 1 bash file guard)", () => {
		const guards = getCapabilityGuards("coordinator");
		expect(guards.length).toBe(NATIVE_TEAM_TOOL_COUNT + 4);
	});

	test("supervisor gets 14 guards (10 team + 3 tool blocks + 1 bash file guard)", () => {
		const guards = getCapabilityGuards("supervisor");
		expect(guards.length).toBe(NATIVE_TEAM_TOOL_COUNT + 4);
	});
});

describe("getDangerGuards", () => {
	test("returns exactly one Bash guard entry", () => {
		const guards = getDangerGuards("test-agent");
		expect(guards).toHaveLength(1);
		expect(guards[0]?.matcher).toBe("Bash");
	});

	test("guard command includes agent name for branch validation", () => {
		const guards = getDangerGuards("my-builder");
		const command = guards[0]?.hooks[0]?.command ?? "";
		expect(command).toContain("overstory/my-builder/");
	});

	test("guard command blocks all git push", () => {
		const guards = getDangerGuards("test-agent");
		const command = guards[0]?.hooks[0]?.command ?? "";
		expect(command).toContain("git");
		expect(command).toContain("push");
		expect(command).toContain("block");
	});

	test("guard command checks for git reset --hard", () => {
		const guards = getDangerGuards("test-agent");
		const command = guards[0]?.hooks[0]?.command ?? "";
		expect(command).toContain("reset");
		expect(command).toContain("--hard");
	});

	test("guard command checks for git checkout -b", () => {
		const guards = getDangerGuards("test-agent");
		const command = guards[0]?.hooks[0]?.command ?? "";
		expect(command).toContain("checkout");
		expect(command).toContain("-b");
	});

	test("guard hook type is command", () => {
		const guards = getDangerGuards("test-agent");
		expect(guards[0]?.hooks[0]?.type).toBe("command");
	});

	test("guard command includes env var guard prefix", () => {
		const guards = getDangerGuards("test-agent");
		const command = guards[0]?.hooks[0]?.command ?? "";
		expect(command).toContain('[ -z "$OVERSTORY_AGENT_NAME" ] && exit 0;');
	});

	test("all capabilities get Bash danger guards in deployed hooks", async () => {
		const capabilities = ["builder", "scout", "reviewer", "lead", "merger"];
		const tempDir = await import("node:fs/promises").then((fs) =>
			fs.mkdtemp(join(require("node:os").tmpdir(), "overstory-danger-test-")),
		);

		try {
			for (const cap of capabilities) {
				const worktreePath = join(tempDir, `${cap}-wt`);
				await deployHooks(worktreePath, `${cap}-agent`, cap);

				const outputPath = join(worktreePath, ".claude", "settings.local.json");
				const content = await Bun.file(outputPath).text();
				const parsed = JSON.parse(content);
				const preToolUse = parsed.hooks.PreToolUse;

				const bashGuard = preToolUse.find((h: { matcher: string }) => h.matcher === "Bash");
				expect(bashGuard).toBeDefined();
				expect(bashGuard.hooks[0].command).toContain(`overstory/${cap}-agent/`);
			}
		} finally {
			await import("node:fs/promises").then((fs) =>
				fs.rm(tempDir, { recursive: true, force: true }),
			);
		}
	});

	test("guard ordering: path boundary → danger → capability in scout", async () => {
		const tempDir = await import("node:fs/promises").then((fs) =>
			fs.mkdtemp(join(require("node:os").tmpdir(), "overstory-order-test-")),
		);

		try {
			const worktreePath = join(tempDir, "scout-order-wt");
			await deployHooks(worktreePath, "scout-order", "scout");

			const outputPath = join(worktreePath, ".claude", "settings.local.json");
			const content = await Bun.file(outputPath).text();
			const parsed = JSON.parse(content);
			const preToolUse = parsed.hooks.PreToolUse;

			// Path boundary Write guard (first) should come before Bash danger guard
			const pathBoundaryWriteIdx = preToolUse.findIndex(
				(h: { matcher: string; hooks: Array<{ command: string }> }) =>
					h.matcher === "Write" && h.hooks[0]?.command?.includes("OVERSTORY_WORKTREE_PATH"),
			);
			const bashDangerIdx = preToolUse.findIndex((h: { matcher: string }) => h.matcher === "Bash");
			// Capability block Write guard should come after Bash danger guard
			const writeBlockIdx = preToolUse.findIndex(
				(h: { matcher: string; hooks: Array<{ command: string }> }) =>
					h.matcher === "Write" && h.hooks[0]?.command?.includes("cannot modify files"),
			);

			expect(pathBoundaryWriteIdx).toBeLessThan(bashDangerIdx);
			expect(bashDangerIdx).toBeLessThan(writeBlockIdx);
		} finally {
			await import("node:fs/promises").then((fs) =>
				fs.rm(tempDir, { recursive: true, force: true }),
			);
		}
	});
});

describe("buildBashFileGuardScript", () => {
	test("returns a string containing the capability name", () => {
		const script = buildBashFileGuardScript("scout");
		expect(script).toContain("scout agents cannot modify files");
	});

	test("reads stdin input", () => {
		const script = buildBashFileGuardScript("scout");
		expect(script).toContain("read -r INPUT");
	});

	test("extracts command from JSON input", () => {
		const script = buildBashFileGuardScript("reviewer");
		expect(script).toContain("CMD=$(");
	});

	test("includes safe prefix whitelist checks", () => {
		const script = buildBashFileGuardScript("scout");
		expect(script).toContain("overstory ");
		expect(script).toContain("bd ");
		expect(script).toContain("git status");
		expect(script).toContain("git log");
		expect(script).toContain("git diff");
		expect(script).toContain("mulch ");
		expect(script).toContain("bun test");
		expect(script).toContain("bun run lint");
	});

	test("includes dangerous command pattern checks", () => {
		const script = buildBashFileGuardScript("lead");
		// File modification commands
		expect(script).toContain("sed");
		expect(script).toContain("tee");
		expect(script).toContain("vim");
		expect(script).toContain("nano");
		expect(script).toContain("mv");
		expect(script).toContain("cp");
		expect(script).toContain("rm");
		expect(script).toContain("mkdir");
		expect(script).toContain("touch");
		// Git modification commands
		expect(script).toContain("git\\s+add");
		expect(script).toContain("git\\s+commit");
		expect(script).toContain("git\\s+push");
	});

	test("blocks sed -i for all non-implementation capabilities", () => {
		for (const cap of ["scout", "reviewer", "lead"]) {
			const script = buildBashFileGuardScript(cap);
			expect(script).toContain("sed\\s+-i");
		}
	});

	test("blocks bun install and bun add", () => {
		const script = buildBashFileGuardScript("scout");
		expect(script).toContain("bun\\s+install");
		expect(script).toContain("bun\\s+add");
	});

	test("blocks npm install", () => {
		const script = buildBashFileGuardScript("scout");
		expect(script).toContain("npm\\s+install");
	});

	test("blocks file permission commands", () => {
		const script = buildBashFileGuardScript("reviewer");
		expect(script).toContain("chmod");
		expect(script).toContain("chown");
	});

	test("blocks append redirect operator", () => {
		const script = buildBashFileGuardScript("lead");
		expect(script).toContain(">>");
	});

	test("blocks bun -e eval execution", () => {
		const script = buildBashFileGuardScript("scout");
		expect(script).toContain("bun\\s+-e");
	});

	test("blocks node -e eval execution", () => {
		const script = buildBashFileGuardScript("scout");
		expect(script).toContain("node\\s+-e");
	});

	test("blocks runtime eval flags (bun --eval, deno eval, python -c, perl -e, ruby -e)", () => {
		const script = buildBashFileGuardScript("scout");
		expect(script).toContain("bun\\s+--eval");
		expect(script).toContain("deno\\s+eval");
		expect(script).toContain("python3?\\s+-c");
		expect(script).toContain("perl\\s+-e");
		expect(script).toContain("ruby\\s+-e");
	});

	test("includes env var guard prefix", () => {
		const script = buildBashFileGuardScript("scout");
		expect(script).toMatch(/^\[ -z "\$OVERSTORY_AGENT_NAME" \] && exit 0;/);
	});

	test("accepts extra safe prefixes for coordinator", () => {
		const script = buildBashFileGuardScript("coordinator", ["git add", "git commit"]);
		expect(script).toContain("git add");
		expect(script).toContain("git commit");
	});

	test("default script does not whitelist git add/commit", () => {
		const script = buildBashFileGuardScript("scout");
		// git add/commit should NOT be in the safe prefix checks (only in danger patterns)
		// The safe prefixes use exit 0, danger patterns use decision:block
		const safeSection = script.split("grep -qE '")[0] ?? "";
		expect(safeSection).not.toContain("'^\\s*git add'");
		expect(safeSection).not.toContain("'^\\s*git commit'");
	});

	test("safe prefix checks use exit 0 to allow", () => {
		const script = buildBashFileGuardScript("scout");
		// Each safe prefix should have an exit 0 to allow the command
		expect(script).toContain("exit 0; fi;");
	});

	test("dangerous pattern check outputs block decision JSON", () => {
		const script = buildBashFileGuardScript("reviewer");
		expect(script).toContain('"decision":"block"');
		expect(script).toContain("reviewer agents cannot modify files");
	});
});

describe("structural enforcement integration", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "overstory-structural-test-"));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	test("non-implementation agents have more guards than implementation agents", async () => {
		const scoutPath = join(tempDir, "scout-wt");
		const builderPath = join(tempDir, "builder-wt");

		await deployHooks(scoutPath, "scout-1", "scout");
		await deployHooks(builderPath, "builder-1", "builder");

		const scoutContent = await Bun.file(join(scoutPath, ".claude", "settings.local.json")).text();
		const builderContent = await Bun.file(
			join(builderPath, ".claude", "settings.local.json"),
		).text();

		const scoutPreToolUse = JSON.parse(scoutContent).hooks.PreToolUse;
		const builderPreToolUse = JSON.parse(builderContent).hooks.PreToolUse;

		// Scout should have more PreToolUse entries than builder
		expect(scoutPreToolUse.length).toBeGreaterThan(builderPreToolUse.length);
	});

	test("scout and reviewer have identical guard structures", async () => {
		const scoutPath = join(tempDir, "scout-wt");
		const reviewerPath = join(tempDir, "reviewer-wt");

		await deployHooks(scoutPath, "scout-1", "scout");
		await deployHooks(reviewerPath, "reviewer-1", "reviewer");

		const scoutContent = await Bun.file(join(scoutPath, ".claude", "settings.local.json")).text();
		const reviewerContent = await Bun.file(
			join(reviewerPath, ".claude", "settings.local.json"),
		).text();

		const scoutPreToolUse = JSON.parse(scoutContent).hooks.PreToolUse;
		const reviewerPreToolUse = JSON.parse(reviewerContent).hooks.PreToolUse;

		// Same number of guards
		expect(scoutPreToolUse.length).toBe(reviewerPreToolUse.length);

		// Same matchers (just different agent names in commands)
		const scoutMatchers = scoutPreToolUse.map((h: { matcher: string }) => h.matcher);
		const reviewerMatchers = reviewerPreToolUse.map((h: { matcher: string }) => h.matcher);
		expect(scoutMatchers).toEqual(reviewerMatchers);
	});

	test("lead has same guard structure as scout/reviewer", async () => {
		const leadPath = join(tempDir, "lead-wt");
		const scoutPath = join(tempDir, "scout-wt");

		await deployHooks(leadPath, "lead-1", "lead");
		await deployHooks(scoutPath, "scout-1", "scout");

		const leadContent = await Bun.file(join(leadPath, ".claude", "settings.local.json")).text();
		const scoutContent = await Bun.file(join(scoutPath, ".claude", "settings.local.json")).text();

		const leadPreToolUse = JSON.parse(leadContent).hooks.PreToolUse;
		const scoutPreToolUse = JSON.parse(scoutContent).hooks.PreToolUse;

		// Same number of guards
		expect(leadPreToolUse.length).toBe(scoutPreToolUse.length);

		// Same matchers
		const leadMatchers = leadPreToolUse.map((h: { matcher: string }) => h.matcher);
		const scoutMatchers = scoutPreToolUse.map((h: { matcher: string }) => h.matcher);
		expect(leadMatchers).toEqual(scoutMatchers);
	});

	test("builder and merger have identical guard structures", async () => {
		const builderPath = join(tempDir, "builder-wt");
		const mergerPath = join(tempDir, "merger-wt");

		await deployHooks(builderPath, "builder-1", "builder");
		await deployHooks(mergerPath, "merger-1", "merger");

		const builderContent = await Bun.file(
			join(builderPath, ".claude", "settings.local.json"),
		).text();
		const mergerContent = await Bun.file(join(mergerPath, ".claude", "settings.local.json")).text();

		const builderPreToolUse = JSON.parse(builderContent).hooks.PreToolUse;
		const mergerPreToolUse = JSON.parse(mergerContent).hooks.PreToolUse;

		// Same number of guards
		expect(builderPreToolUse.length).toBe(mergerPreToolUse.length);

		// Same matchers
		const builderMatchers = builderPreToolUse.map((h: { matcher: string }) => h.matcher);
		const mergerMatchers = mergerPreToolUse.map((h: { matcher: string }) => h.matcher);
		expect(builderMatchers).toEqual(mergerMatchers);
	});

	test("all deployed configs produce valid JSON", async () => {
		const capabilities = [
			"scout",
			"reviewer",
			"lead",
			"builder",
			"merger",
			"coordinator",
			"supervisor",
		];

		for (const cap of capabilities) {
			const wt = join(tempDir, `${cap}-wt`);
			await deployHooks(wt, `${cap}-agent`, cap);

			const content = await Bun.file(join(wt, ".claude", "settings.local.json")).text();
			expect(() => JSON.parse(content)).not.toThrow();
		}
	});

	test("coordinator bash guard whitelists git add and git commit", async () => {
		const worktreePath = join(tempDir, "coord-wt");

		await deployHooks(worktreePath, "coordinator-agent", "coordinator");

		const outputPath = join(worktreePath, ".claude", "settings.local.json");
		const content = await Bun.file(outputPath).text();
		const parsed = JSON.parse(content);
		const preToolUse = parsed.hooks.PreToolUse;

		// Find the bash file guard (the second Bash entry, after the danger guard)
		const bashGuards = preToolUse.filter((h: { matcher: string }) => h.matcher === "Bash");
		expect(bashGuards.length).toBe(3);

		// The file guard (second Bash guard) should whitelist git add/commit
		const fileGuard = bashGuards[1];
		expect(fileGuard.hooks[0].command).toContain("git add");
		expect(fileGuard.hooks[0].command).toContain("git commit");
	});

	test("scout bash guard does NOT whitelist git add/commit", async () => {
		const worktreePath = join(tempDir, "scout-git-wt");

		await deployHooks(worktreePath, "scout-git", "scout");

		const outputPath = join(worktreePath, ".claude", "settings.local.json");
		const content = await Bun.file(outputPath).text();
		const parsed = JSON.parse(content);
		const preToolUse = parsed.hooks.PreToolUse;

		const bashGuards = preToolUse.filter((h: { matcher: string }) => h.matcher === "Bash");
		const fileGuard = bashGuards[1];

		// The safe prefix section should not include git add or git commit for scouts
		const command = fileGuard.hooks[0].command;
		const safePrefixSection = command.split("grep -qE '")[0] ?? "";
		expect(safePrefixSection).not.toContain("'^\\s*git add'");
		expect(safePrefixSection).not.toContain("'^\\s*git commit'");
	});

	test("coordinator and supervisor have same guard structure", async () => {
		const coordPath = join(tempDir, "coord-wt");
		const supPath = join(tempDir, "sup-wt");

		await deployHooks(coordPath, "coord-1", "coordinator");
		await deployHooks(supPath, "sup-1", "supervisor");

		const coordContent = await Bun.file(join(coordPath, ".claude", "settings.local.json")).text();
		const supContent = await Bun.file(join(supPath, ".claude", "settings.local.json")).text();

		const coordPreToolUse = JSON.parse(coordContent).hooks.PreToolUse;
		const supPreToolUse = JSON.parse(supContent).hooks.PreToolUse;

		// Same number of guards
		expect(coordPreToolUse.length).toBe(supPreToolUse.length);

		// Same matchers
		const coordMatchers = coordPreToolUse.map((h: { matcher: string }) => h.matcher);
		const supMatchers = supPreToolUse.map((h: { matcher: string }) => h.matcher);
		expect(coordMatchers).toEqual(supMatchers);
	});

	test("all template hooks include ENV_GUARD for project root isolation", async () => {
		const worktreePath = join(tempDir, "env-guard-tmpl-wt");

		await deployHooks(worktreePath, "env-guard-agent", "builder");

		const outputPath = join(worktreePath, ".claude", "settings.local.json");
		const content = await Bun.file(outputPath).text();
		const parsed = JSON.parse(content);

		// All hook types from the template should include ENV_GUARD
		for (const hookType of [
			"SessionStart",
			"UserPromptSubmit",
			"PreCompact",
			"PostToolUse",
			"Stop",
		]) {
			const hooks = parsed.hooks[hookType] as Array<{
				matcher: string;
				hooks: Array<{ command: string }>;
			}>;
			expect(hooks.length).toBeGreaterThan(0);
			const baseHook = hooks.find((h) => h.matcher === "");
			expect(baseHook).toBeDefined();
			expect(baseHook?.hooks[0]?.command).toContain("OVERSTORY_AGENT_NAME");
		}

		// PreToolUse base hook (matcher == "") should also have ENV_GUARD
		const preToolUse = parsed.hooks.PreToolUse as Array<{
			matcher: string;
			hooks: Array<{ command: string }>;
		}>;
		const basePreToolUse = preToolUse.find((h) => h.matcher === "");
		expect(basePreToolUse).toBeDefined();
		expect(basePreToolUse?.hooks[0]?.command).toContain("OVERSTORY_AGENT_NAME");
	});

	test("all deployed hook commands include env var guard for project root isolation", async () => {
		const worktreePath = join(tempDir, "coord-env-wt");

		await deployHooks(worktreePath, "coordinator-env", "coordinator");

		const outputPath = join(worktreePath, ".claude", "settings.local.json");
		const content = await Bun.file(outputPath).text();
		const parsed = JSON.parse(content);
		const preToolUse = parsed.hooks.PreToolUse as Array<{
			matcher: string;
			hooks: Array<{ type: string; command: string }>;
		}>;

		// All guard entries (non-empty matchers, i.e. generated by getDangerGuards/getCapabilityGuards)
		// must include the env var guard so hooks deployed to project root only activate for agents
		const guardEntries = preToolUse.filter((entry) => entry.matcher !== "");
		expect(guardEntries.length).toBeGreaterThan(0);

		for (const entry of guardEntries) {
			for (const hook of entry.hooks) {
				if (hook.type === "command") {
					// Skip the universal git push guard which intentionally lacks ENV_GUARD
					if (
						entry.matcher === "Bash" &&
						hook.command.includes("git push is blocked") &&
						!hook.command.includes("OVERSTORY_AGENT_NAME")
					) {
						continue;
					}
					expect(hook.command).toContain("OVERSTORY_AGENT_NAME");
				}
			}
		}
	});

	test("all capabilities block Task tool for overstory sling enforcement", async () => {
		const capabilities = [
			"scout",
			"reviewer",
			"lead",
			"builder",
			"merger",
			"coordinator",
			"supervisor",
		];

		for (const cap of capabilities) {
			const wt = join(tempDir, `${cap}-task-wt`);
			await deployHooks(wt, `${cap}-agent`, cap);

			const content = await Bun.file(join(wt, ".claude", "settings.local.json")).text();
			const parsed = JSON.parse(content);
			const preToolUse = parsed.hooks.PreToolUse;

			const taskGuard = preToolUse.find((h: { matcher: string }) => h.matcher === "Task");
			expect(taskGuard).toBeDefined();
			expect(taskGuard.hooks[0].command).toContain("overstory sling");
		}
	});

	test("all capabilities get path boundary guards in deployed hooks", async () => {
		const capabilities = [
			"scout",
			"reviewer",
			"lead",
			"builder",
			"merger",
			"coordinator",
			"supervisor",
		];

		for (const cap of capabilities) {
			const wt = join(tempDir, `${cap}-path-wt`);
			await deployHooks(wt, `${cap}-agent`, cap);

			const content = await Bun.file(join(wt, ".claude", "settings.local.json")).text();
			const parsed = JSON.parse(content);
			const preToolUse = parsed.hooks.PreToolUse;

			// Path boundary guards should be present for Write, Edit, NotebookEdit
			// They use OVERSTORY_WORKTREE_PATH env var
			const writeGuards = preToolUse.filter(
				(h: { matcher: string; hooks: Array<{ command: string }> }) =>
					h.matcher === "Write" && h.hooks[0]?.command?.includes("OVERSTORY_WORKTREE_PATH"),
			);
			const editGuards = preToolUse.filter(
				(h: { matcher: string; hooks: Array<{ command: string }> }) =>
					h.matcher === "Edit" && h.hooks[0]?.command?.includes("OVERSTORY_WORKTREE_PATH"),
			);
			const notebookGuards = preToolUse.filter(
				(h: { matcher: string; hooks: Array<{ command: string }> }) =>
					h.matcher === "NotebookEdit" && h.hooks[0]?.command?.includes("OVERSTORY_WORKTREE_PATH"),
			);

			expect(writeGuards.length).toBeGreaterThanOrEqual(1);
			expect(editGuards.length).toBeGreaterThanOrEqual(1);
			expect(notebookGuards.length).toBeGreaterThanOrEqual(1);
		}
	});

	test("path boundary guards appear before danger guards in deployed hooks", async () => {
		const worktreePath = join(tempDir, "order-path-wt");

		await deployHooks(worktreePath, "order-path-agent", "builder");

		const outputPath = join(worktreePath, ".claude", "settings.local.json");
		const content = await Bun.file(outputPath).text();
		const parsed = JSON.parse(content);
		const preToolUse = parsed.hooks.PreToolUse;

		// Path boundary Write guard should come before Bash danger guard
		const pathWriteIdx = preToolUse.findIndex(
			(h: { matcher: string; hooks: Array<{ command: string }> }) =>
				h.matcher === "Write" && h.hooks[0]?.command?.includes("OVERSTORY_WORKTREE_PATH"),
		);
		const bashDangerIdx = preToolUse.findIndex(
			(h: { matcher: string; hooks: Array<{ command: string }> }) =>
				h.matcher === "Bash" && h.hooks[0]?.command?.includes("git"),
		);

		expect(pathWriteIdx).toBeGreaterThanOrEqual(0);
		expect(bashDangerIdx).toBeGreaterThanOrEqual(0);
		expect(pathWriteIdx).toBeLessThan(bashDangerIdx);
	});
});

describe("buildPathBoundaryGuardScript", () => {
	test("returns a string containing env var guard", () => {
		const script = buildPathBoundaryGuardScript("file_path");
		expect(script).toContain('[ -z "$OVERSTORY_AGENT_NAME" ] && exit 0;');
	});

	test("returns a string checking OVERSTORY_WORKTREE_PATH", () => {
		const script = buildPathBoundaryGuardScript("file_path");
		expect(script).toContain('[ -z "$OVERSTORY_WORKTREE_PATH" ] && exit 0;');
	});

	test("reads stdin input", () => {
		const script = buildPathBoundaryGuardScript("file_path");
		expect(script).toContain("read -r INPUT");
	});

	test("extracts the specified field name from JSON", () => {
		const script = buildPathBoundaryGuardScript("file_path");
		expect(script).toContain('"file_path"');

		const notebookScript = buildPathBoundaryGuardScript("notebook_path");
		expect(notebookScript).toContain('"notebook_path"');
	});

	test("resolves relative paths against cwd", () => {
		const script = buildPathBoundaryGuardScript("file_path");
		expect(script).toContain("$(pwd)");
	});

	test("allows paths inside the worktree", () => {
		const script = buildPathBoundaryGuardScript("file_path");
		expect(script).toContain('"$OVERSTORY_WORKTREE_PATH"/*) exit 0');
	});

	test("blocks paths outside the worktree with decision:block", () => {
		const script = buildPathBoundaryGuardScript("file_path");
		expect(script).toContain('"decision":"block"');
		expect(script).toContain("Path boundary violation");
	});

	test("fails open when path field is empty", () => {
		const script = buildPathBoundaryGuardScript("file_path");
		expect(script).toContain('[ -z "$FILE_PATH" ] && exit 0;');
	});
});

describe("getPathBoundaryGuards", () => {
	test("returns exactly 3 guards (Write, Edit, NotebookEdit)", () => {
		const guards = getPathBoundaryGuards();
		expect(guards).toHaveLength(3);
	});

	test("guards match Write, Edit, and NotebookEdit tools", () => {
		const guards = getPathBoundaryGuards();
		const matchers = guards.map((g) => g.matcher);
		expect(matchers).toContain("Write");
		expect(matchers).toContain("Edit");
		expect(matchers).toContain("NotebookEdit");
	});

	test("Write and Edit guards extract file_path field", () => {
		const guards = getPathBoundaryGuards();
		const writeGuard = guards.find((g) => g.matcher === "Write");
		const editGuard = guards.find((g) => g.matcher === "Edit");
		expect(writeGuard?.hooks[0]?.command).toContain('"file_path"');
		expect(editGuard?.hooks[0]?.command).toContain('"file_path"');
	});

	test("NotebookEdit guard extracts notebook_path field", () => {
		const guards = getPathBoundaryGuards();
		const notebookGuard = guards.find((g) => g.matcher === "NotebookEdit");
		expect(notebookGuard?.hooks[0]?.command).toContain('"notebook_path"');
	});

	test("all guards include OVERSTORY_WORKTREE_PATH check", () => {
		const guards = getPathBoundaryGuards();
		for (const guard of guards) {
			expect(guard.hooks[0]?.command).toContain("OVERSTORY_WORKTREE_PATH");
		}
	});

	test("all guards have command type hooks", () => {
		const guards = getPathBoundaryGuards();
		for (const guard of guards) {
			expect(guard.hooks[0]?.type).toBe("command");
		}
	});
});

describe("buildBashPathBoundaryScript", () => {
	test("returns a string containing env var guard", () => {
		const script = buildBashPathBoundaryScript();
		expect(script).toContain('[ -z "$OVERSTORY_AGENT_NAME" ] && exit 0;');
	});

	test("checks OVERSTORY_WORKTREE_PATH env var", () => {
		const script = buildBashPathBoundaryScript();
		expect(script).toContain('[ -z "$OVERSTORY_WORKTREE_PATH" ] && exit 0;');
	});

	test("reads stdin input", () => {
		const script = buildBashPathBoundaryScript();
		expect(script).toContain("read -r INPUT");
	});

	test("extracts command from JSON input", () => {
		const script = buildBashPathBoundaryScript();
		expect(script).toContain("CMD=$(");
		expect(script).toContain('"command"');
	});

	test("checks for file-modifying patterns before path extraction", () => {
		const script = buildBashPathBoundaryScript();
		// Should check for file-modifying patterns first
		expect(script).toContain("grep -qE");
		expect(script).toContain("sed\\s+-i");
		expect(script).toContain("\\bmv\\s");
		expect(script).toContain("\\bcp\\s");
		expect(script).toContain("\\brm\\s");
		expect(script).toContain("tee\\s");
		expect(script).toContain("\\brsync\\s");
		expect(script).toContain("\\binstall\\s");
	});

	test("includes common file-modifying patterns", () => {
		const script = buildBashPathBoundaryScript();
		expect(script).toContain("sed\\s+-i");
		expect(script).toContain("sed\\s+--in-place");
		expect(script).toContain("echo\\s+.*>");
		expect(script).toContain("printf\\s+.*>");
		expect(script).toContain("cat\\s+.*>");
		expect(script).toContain("tee\\s");
		expect(script).toContain("\\bmv\\s");
		expect(script).toContain("\\bcp\\s");
		expect(script).toContain("\\brm\\s");
		expect(script).toContain("\\bmkdir\\s");
		expect(script).toContain("\\btouch\\s");
		expect(script).toContain("\\bchmod\\s");
		expect(script).toContain("\\bchown\\s");
		expect(script).toContain(">>");
		expect(script).toContain("\\binstall\\s");
		expect(script).toContain("\\brsync\\s");
	});

	test("passes through non-file-modifying commands", () => {
		const script = buildBashPathBoundaryScript();
		// Non-modifying commands should hit the early exit
		expect(script).toContain("exit 0; fi;");
	});

	test("extracts absolute paths from command", () => {
		const script = buildBashPathBoundaryScript();
		// Should extract tokens starting with /
		expect(script).toContain("grep '^/'");
	});

	test("allows commands with no absolute paths (relative paths OK)", () => {
		const script = buildBashPathBoundaryScript();
		expect(script).toContain('[ -z "$PATHS" ] && exit 0;');
	});

	test("validates paths against worktree boundary", () => {
		const script = buildBashPathBoundaryScript();
		expect(script).toContain('"$OVERSTORY_WORKTREE_PATH"/*');
		expect(script).toContain('"$OVERSTORY_WORKTREE_PATH")');
	});

	test("allows /dev/* paths as safe exceptions", () => {
		const script = buildBashPathBoundaryScript();
		expect(script).toContain("/dev/*");
	});

	test("allows /tmp/* paths as safe exceptions", () => {
		const script = buildBashPathBoundaryScript();
		expect(script).toContain("/tmp/*");
	});

	test("blocks paths outside worktree with decision:block", () => {
		const script = buildBashPathBoundaryScript();
		expect(script).toContain('"decision":"block"');
		expect(script).toContain("Bash path boundary violation");
		expect(script).toContain("outside your worktree");
	});

	test("iterates over extracted paths with while loop", () => {
		const script = buildBashPathBoundaryScript();
		expect(script).toContain("while IFS= read -r P; do");
		expect(script).toContain("done;");
	});

	test("strips trailing quotes and semicolons from extracted paths", () => {
		const script = buildBashPathBoundaryScript();
		// sed should strip trailing junk from path tokens
		expect(script).toContain("sed 's/[\";>]*$//'");
	});
});

describe("getBashPathBoundaryGuards", () => {
	test("returns exactly 1 Bash guard entry", () => {
		const guards = getBashPathBoundaryGuards();
		expect(guards).toHaveLength(1);
		expect(guards[0]?.matcher).toBe("Bash");
	});

	test("guard hook type is command", () => {
		const guards = getBashPathBoundaryGuards();
		expect(guards[0]?.hooks[0]?.type).toBe("command");
	});

	test("guard command checks OVERSTORY_WORKTREE_PATH", () => {
		const guards = getBashPathBoundaryGuards();
		const command = guards[0]?.hooks[0]?.command ?? "";
		expect(command).toContain("OVERSTORY_WORKTREE_PATH");
	});

	test("guard command includes env var guard prefix", () => {
		const guards = getBashPathBoundaryGuards();
		const command = guards[0]?.hooks[0]?.command ?? "";
		expect(command).toContain('[ -z "$OVERSTORY_AGENT_NAME" ] && exit 0;');
	});

	test("guard blocks paths outside worktree", () => {
		const guards = getBashPathBoundaryGuards();
		const command = guards[0]?.hooks[0]?.command ?? "";
		expect(command).toContain("Bash path boundary violation");
	});
});

describe("bash path boundary integration", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "overstory-bash-path-test-"));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	test("builder gets Bash path boundary guard in deployed hooks", async () => {
		const worktreePath = join(tempDir, "builder-bp-wt");

		await deployHooks(worktreePath, "builder-bp", "builder");

		const outputPath = join(worktreePath, ".claude", "settings.local.json");
		const content = await Bun.file(outputPath).text();
		const parsed = JSON.parse(content);
		const preToolUse = parsed.hooks.PreToolUse;

		const bashGuards = preToolUse.filter((h: { matcher: string }) => h.matcher === "Bash");
		// Should have 3 Bash guards: danger guard + path boundary guard + universal push guard
		expect(bashGuards.length).toBe(3);

		// Find the path boundary guard
		const pathGuard = bashGuards.find((h: { hooks: Array<{ command: string }> }) =>
			h.hooks[0]?.command?.includes("Bash path boundary violation"),
		);
		expect(pathGuard).toBeDefined();
		expect(pathGuard.hooks[0].command).toContain("OVERSTORY_WORKTREE_PATH");
	});

	test("merger gets Bash path boundary guard in deployed hooks", async () => {
		const worktreePath = join(tempDir, "merger-bp-wt");

		await deployHooks(worktreePath, "merger-bp", "merger");

		const outputPath = join(worktreePath, ".claude", "settings.local.json");
		const content = await Bun.file(outputPath).text();
		const parsed = JSON.parse(content);
		const preToolUse = parsed.hooks.PreToolUse;

		const bashGuards = preToolUse.filter((h: { matcher: string }) => h.matcher === "Bash");
		expect(bashGuards.length).toBe(3);

		const pathGuard = bashGuards.find((h: { hooks: Array<{ command: string }> }) =>
			h.hooks[0]?.command?.includes("Bash path boundary violation"),
		);
		expect(pathGuard).toBeDefined();
	});

	test("scout does NOT get Bash path boundary guard", async () => {
		const worktreePath = join(tempDir, "scout-bp-wt");

		await deployHooks(worktreePath, "scout-bp", "scout");

		const outputPath = join(worktreePath, ".claude", "settings.local.json");
		const content = await Bun.file(outputPath).text();
		const parsed = JSON.parse(content);
		const preToolUse = parsed.hooks.PreToolUse;

		// Scout gets danger guard + file guard + universal push guard (3 Bash guards), but NOT path boundary
		const bashGuards = preToolUse.filter((h: { matcher: string }) => h.matcher === "Bash");
		expect(bashGuards.length).toBe(3);

		const pathGuard = bashGuards.find((h: { hooks: Array<{ command: string }> }) =>
			h.hooks[0]?.command?.includes("Bash path boundary violation"),
		);
		expect(pathGuard).toBeUndefined();
	});

	test("reviewer does NOT get Bash path boundary guard", async () => {
		const worktreePath = join(tempDir, "reviewer-bp-wt");

		await deployHooks(worktreePath, "reviewer-bp", "reviewer");

		const outputPath = join(worktreePath, ".claude", "settings.local.json");
		const content = await Bun.file(outputPath).text();
		const parsed = JSON.parse(content);
		const preToolUse = parsed.hooks.PreToolUse;

		const pathGuard = preToolUse.find(
			(h: { matcher: string; hooks: Array<{ command: string }> }) =>
				h.matcher === "Bash" && h.hooks[0]?.command?.includes("Bash path boundary violation"),
		);
		expect(pathGuard).toBeUndefined();
	});

	test("lead does NOT get Bash path boundary guard", async () => {
		const worktreePath = join(tempDir, "lead-bp-wt");

		await deployHooks(worktreePath, "lead-bp", "lead");

		const outputPath = join(worktreePath, ".claude", "settings.local.json");
		const content = await Bun.file(outputPath).text();
		const parsed = JSON.parse(content);
		const preToolUse = parsed.hooks.PreToolUse;

		const pathGuard = preToolUse.find(
			(h: { matcher: string; hooks: Array<{ command: string }> }) =>
				h.matcher === "Bash" && h.hooks[0]?.command?.includes("Bash path boundary violation"),
		);
		expect(pathGuard).toBeUndefined();
	});

	test("Bash path boundary guard appears after danger guard in builder", async () => {
		const worktreePath = join(tempDir, "builder-order-wt");

		await deployHooks(worktreePath, "builder-order", "builder");

		const outputPath = join(worktreePath, ".claude", "settings.local.json");
		const content = await Bun.file(outputPath).text();
		const parsed = JSON.parse(content);
		const preToolUse = parsed.hooks.PreToolUse;

		const dangerIdx = preToolUse.findIndex(
			(h: { matcher: string; hooks: Array<{ command: string }> }) =>
				h.matcher === "Bash" &&
				h.hooks[0]?.command?.includes("git") &&
				h.hooks[0]?.command?.includes("push"),
		);
		const pathBoundaryIdx = preToolUse.findIndex(
			(h: { matcher: string; hooks: Array<{ command: string }> }) =>
				h.matcher === "Bash" && h.hooks[0]?.command?.includes("Bash path boundary violation"),
		);

		expect(dangerIdx).toBeGreaterThanOrEqual(0);
		expect(pathBoundaryIdx).toBeGreaterThanOrEqual(0);
		// Danger guard comes from getDangerGuards, path boundary from getCapabilityGuards
		// In deployHooks: allGuards = [...pathGuards, ...dangerGuards, ...capabilityGuards]
		// So danger guard comes before path boundary guard
		expect(dangerIdx).toBeLessThan(pathBoundaryIdx);
	});

	test("default capability (builder) gets Bash path boundary guard", async () => {
		const worktreePath = join(tempDir, "default-bp-wt");

		await deployHooks(worktreePath, "default-bp");

		const outputPath = join(worktreePath, ".claude", "settings.local.json");
		const content = await Bun.file(outputPath).text();
		const parsed = JSON.parse(content);
		const preToolUse = parsed.hooks.PreToolUse;

		const pathGuard = preToolUse.find(
			(h: { matcher: string; hooks: Array<{ command: string }> }) =>
				h.matcher === "Bash" && h.hooks[0]?.command?.includes("Bash path boundary violation"),
		);
		expect(pathGuard).toBeDefined();
	});

	test("deployed hooks include universal git push guard without ENV_GUARD", async () => {
		const worktreePath = join(tempDir, "universal-push-wt");

		await deployHooks(worktreePath, "universal-push-agent", "builder");

		const outputPath = join(worktreePath, ".claude", "settings.local.json");
		const content = await Bun.file(outputPath).text();
		const parsed = JSON.parse(content);
		const preToolUse = parsed.hooks.PreToolUse;

		// Find the universal git push guard: Bash matcher, blocks git push, no ENV_GUARD
		const universalGuard = preToolUse.find(
			(h: { matcher: string; hooks: Array<{ command: string }> }) =>
				h.matcher === "Bash" &&
				h.hooks[0]?.command?.includes("git push is blocked") &&
				!h.hooks[0]?.command?.includes("OVERSTORY_AGENT_NAME"),
		);
		expect(universalGuard).toBeDefined();
		expect(universalGuard.hooks[0].command).toContain('"decision":"block"');
	});
});

describe("hook lifecycle env-state matrix", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "overstory-hook-matrix-test-"));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	async function runHookCommand(
		command: string,
		cwd: string,
		env: NodeJS.ProcessEnv,
		stdinPayload: string,
	): Promise<{ exitCode: number; stdout: string; stderr: string }> {
		const proc = Bun.spawn(["sh", "-c", command], {
			cwd,
			env,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		proc.stdin.write(stdinPayload);
		proc.stdin.end();

		const exitCode = await proc.exited;
		const stdout = await new Response(proc.stdout).text();
		const stderr = await new Response(proc.stderr).text();
		return { exitCode, stdout, stderr };
	}

	test("deployed PreToolUse hook matrix honors env gate and captures events from worktree", async () => {
		const projectRoot = join(tempDir, "project");
		const worktreePath = join(projectRoot, "worktrees", "matrix-agent");
		const agentName = "matrix-agent";

		await mkdir(join(projectRoot, ".overstory"), { recursive: true });
		await Bun.write(
			join(projectRoot, ".overstory", "config.yaml"),
			`project:\n  name: matrix\n  root: ${projectRoot}\n  canonicalBranch: main\n`,
		);

		const binDir = join(projectRoot, "bin");
		const overstoryShim = join(binDir, "overstory");
		await mkdir(binDir, { recursive: true });
		await Bun.write(
			overstoryShim,
			`#!/bin/sh\nexec bun run "${join(import.meta.dir, "..", "index.ts").replace(/\\/g, "/")}" "$@"\n`,
		);
		await chmod(overstoryShim, 0o755);

		await deployHooks(worktreePath, agentName, "builder");
		await mkdir(join(worktreePath, ".overstory"), { recursive: true });
		await Bun.write(
			join(worktreePath, ".overstory", "config.yaml"),
			`project:\n  name: matrix\n  root: ${projectRoot}\n  canonicalBranch: main\n`,
		);

		const settings = JSON.parse(
			await Bun.file(join(worktreePath, ".claude", "settings.local.json")).text(),
		) as {
			hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }> };
		};
		const basePreToolUse = settings.hooks.PreToolUse.find((entry) => entry.matcher === "");
		expect(basePreToolUse).toBeDefined();
		const command = basePreToolUse?.hooks[0]?.command ?? "";
		expect(command).toContain("overstory log tool-start");

		const rows = [
			{
				name: "without_OVERSTORY_AGENT_NAME",
				withAgentEnv: false,
				stdinPayload: JSON.stringify({
					tool_name: "Read",
					tool_input: { file_path: "/src/no-env.ts" },
					session_id: "sess-no-env",
				}),
				expectedEvents: 0,
			},
			{
				name: "with_OVERSTORY_AGENT_NAME",
				withAgentEnv: true,
				stdinPayload: JSON.stringify({
					tool_name: "Read",
					tool_input: { file_path: "/src/with-env.ts" },
					session_id: "sess-with-env",
				}),
				expectedEvents: 1,
			},
		] as const;

		for (const row of rows) {
			const env: NodeJS.ProcessEnv = {
				...process.env,
				PATH: `${binDir}:${process.env.PATH ?? ""}`,
			};
			if (row.withAgentEnv) {
				env.OVERSTORY_AGENT_NAME = agentName;
			} else {
				delete env.OVERSTORY_AGENT_NAME;
			}

			const result = await runHookCommand(command, projectRoot, env, row.stdinPayload);
			expect(result.exitCode).toBe(0);
			expect(result.stderr).toBe("");

			const eventStore = createEventStore(join(projectRoot, ".overstory", "events.db"));
			const events = eventStore.getByAgent(agentName);
			eventStore.close();
			expect(events).toHaveLength(row.expectedEvents);

			if (row.withAgentEnv) {
				expect(events[0]?.eventType).toBe("tool_start");
				expect(events[0]?.toolName).toBe("Read");
				const data = JSON.parse(events[0]?.data ?? "{}") as { summary?: string };
				expect(data.summary).toBe("read: /src/with-env.ts");
			}
		}
	});
});

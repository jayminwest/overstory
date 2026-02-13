/**
 * Tests for Tier 1 AI-assisted triage.
 * classifyResponse and buildTriagePrompt are pure functions — tested directly.
 * triageAgent uses real filesystem (temp dirs). Claude spawn is expected to
 * fail in test environments, exercising the fallback-to-extend path.
 * spawnClaude is NOT mocked — we rely on it failing naturally in tests.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTriagePrompt, classifyResponse, triageAgent } from "./triage.ts";

describe("classifyResponse", () => {
	test("returns 'retry' when response contains 'retry'", () => {
		const result = classifyResponse("The operation should retry.");
		expect(result).toBe("retry");
	});

	test("returns 'retry' when response contains 'recoverable'", () => {
		const result = classifyResponse("This error is recoverable.");
		expect(result).toBe("retry");
	});

	test("returns 'terminate' when response contains 'terminate'", () => {
		const result = classifyResponse("You should terminate the agent.");
		expect(result).toBe("terminate");
	});

	test("returns 'terminate' when response contains 'fatal'", () => {
		const result = classifyResponse("This is a fatal error.");
		expect(result).toBe("terminate");
	});

	test("returns 'terminate' when response contains 'failed'", () => {
		const result = classifyResponse("The operation has failed.");
		expect(result).toBe("terminate");
	});

	test("handles mixed case (e.g., 'RETRY', 'Fatal')", () => {
		expect(classifyResponse("RETRY this operation")).toBe("retry");
		expect(classifyResponse("Fatal error occurred")).toBe("terminate");
		expect(classifyResponse("RecOverAble issue")).toBe("retry");
	});

	test("returns 'extend' when response contains none of the keywords", () => {
		const result = classifyResponse("The agent is processing data.");
		expect(result).toBe("extend");
	});

	test("returns 'extend' for empty string", () => {
		const result = classifyResponse("");
		expect(result).toBe("extend");
	});

	test("first match wins when response has multiple keywords", () => {
		// 'retry' is checked before 'terminate'
		const result = classifyResponse("retry this but it may terminate later");
		expect(result).toBe("retry");
	});
});

describe("buildTriagePrompt", () => {
	test("contains agent name in output", () => {
		const prompt = buildTriagePrompt("test-agent", "2026-02-13T10:00:00Z", "log content");
		expect(prompt).toContain("test-agent");
	});

	test("contains lastActivity timestamp in output", () => {
		const timestamp = "2026-02-13T10:00:00Z";
		const prompt = buildTriagePrompt("test-agent", timestamp, "log content");
		expect(prompt).toContain(timestamp);
	});

	test("contains log content wrapped in code fences", () => {
		const logContent = "Error: something went wrong\nat line 42";
		const prompt = buildTriagePrompt("test-agent", "2026-02-13T10:00:00Z", logContent);
		expect(prompt).toContain("```");
		expect(prompt).toContain(logContent);
		expect(prompt.split("```").length).toBeGreaterThanOrEqual(3); // Opening and closing fences
	});

	test("contains classification instructions (retry/terminate/extend)", () => {
		const prompt = buildTriagePrompt("test-agent", "2026-02-13T10:00:00Z", "log content");
		expect(prompt).toContain("retry");
		expect(prompt).toContain("terminate");
		expect(prompt).toContain("extend");
	});
});

describe("triageAgent", () => {
	let tempRoot: string;

	beforeEach(async () => {
		tempRoot = await mkdtemp(join(tmpdir(), "triage-test-"));
	});

	afterEach(async () => {
		await rm(tempRoot, { recursive: true, force: true });
	});

	test("returns 'extend' when no logs directory exists", async () => {
		const result = await triageAgent({
			agentName: "test-agent",
			root: tempRoot,
			lastActivity: "2026-02-13T10:00:00Z",
		});
		expect(result).toBe("extend");
	});

	test("returns 'extend' when logs directory exists but is empty", async () => {
		const logsDir = join(tempRoot, ".overstory", "logs", "test-agent");
		await mkdir(logsDir, { recursive: true });

		const result = await triageAgent({
			agentName: "test-agent",
			root: tempRoot,
			lastActivity: "2026-02-13T10:00:00Z",
		});
		expect(result).toBe("extend");
	});

	test("returns 'extend' when logs directory has session dir but no session.log", async () => {
		const logsDir = join(tempRoot, ".overstory", "logs", "test-agent", "2026-02-13T10-00-00");
		await Bun.write(join(logsDir, ".gitkeep"), "");

		const result = await triageAgent({
			agentName: "test-agent",
			root: tempRoot,
			lastActivity: "2026-02-13T10:00:00Z",
		});
		expect(result).toBe("extend");
	});

	test("returns 'extend' when session.log exists but claude binary fails", async () => {
		const timestamp = "2026-02-13T10-00-00";
		const sessionLogPath = join(
			tempRoot,
			".overstory",
			"logs",
			"test-agent",
			timestamp,
			"session.log",
		);

		// Create session.log with some content
		await Bun.write(
			sessionLogPath,
			"Agent started\nProcessing data\nError: something went wrong\n",
		);

		// triageAgent will try to spawn claude which should fail or be killed by timeout.
		// Short timeout ensures the test doesn't hang even if the claude binary
		// exists on the system (e.g., inside a Claude Code session).
		const result = await triageAgent({
			agentName: "test-agent",
			root: tempRoot,
			lastActivity: "2026-02-13T10:00:00Z",
			timeoutMs: 500,
		});
		expect(result).toBe("extend");
	});
});

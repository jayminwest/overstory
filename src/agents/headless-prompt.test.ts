import { describe, expect, test } from "bun:test";
import {
	buildInitialHeadlessPrompt,
	encodeUserTurn,
	formatMailSection,
} from "./headless-prompt.ts";

describe("encodeUserTurn", () => {
	test("produces a valid NDJSON line", () => {
		const line = encodeUserTurn("hello world");
		expect(line).toEndWith("\n");
		const parsed = JSON.parse(line.trim());
		expect(parsed.type).toBe("user");
		expect(parsed.message.role).toBe("user");
		expect(parsed.message.content).toHaveLength(1);
		expect(parsed.message.content[0].type).toBe("text");
		expect(parsed.message.content[0].text).toBe("hello world");
	});

	test("handles multi-line text", () => {
		const text = "line one\nline two\nline three";
		const line = encodeUserTurn(text);
		const parsed = JSON.parse(line.trim());
		expect(parsed.message.content[0].text).toBe(text);
	});
});

describe("formatMailSection", () => {
	test("returns empty string for no messages", () => {
		expect(formatMailSection([])).toBe("");
	});

	test("formats a single message", () => {
		const result = formatMailSection([
			{ from: "coordinator", subject: "dispatch", priority: "normal", body: "Start working." },
		]);
		expect(result).toContain("[MAIL] From: coordinator");
		expect(result).toContain("Subject: dispatch");
		expect(result).toContain("Start working.");
	});

	test("separates multiple messages with dividers", () => {
		const result = formatMailSection([
			{ from: "lead", subject: "task-1", priority: "high", body: "First task." },
			{ from: "orchestrator", subject: "context", priority: "low", body: "Extra context." },
		]);
		expect(result).toContain("---");
		expect(result).toContain("First task.");
		expect(result).toContain("Extra context.");
	});
});

describe("buildInitialHeadlessPrompt", () => {
	test("combines all three sections", () => {
		const result = buildInitialHeadlessPrompt(
			"## Prime Context\nExpertise here.",
			"[MAIL] From: orchestrator | Subject: dispatch\n\nDo the thing.",
			"Read your overlay and begin immediately.",
		);
		const parsed = JSON.parse(result.trim());
		const text: string = parsed.message.content[0].text;
		expect(text).toContain("Prime Context");
		expect(text).toContain("[MAIL]");
		expect(text).toContain("Read your overlay and begin immediately.");
		expect(text).toContain("---");
	});

	test("omits primeContext when undefined", () => {
		const result = buildInitialHeadlessPrompt(
			undefined,
			"[MAIL] From: lead | Subject: dispatch\n\nTask body.",
			"Begin.",
		);
		const parsed = JSON.parse(result.trim());
		const text: string = parsed.message.content[0].text;
		expect(text).not.toContain("Prime Context");
		expect(text).toContain("[MAIL]");
		expect(text).toContain("Begin.");
	});

	test("omits dispatchMail when undefined", () => {
		const result = buildInitialHeadlessPrompt("## Prime Context", undefined, "Begin.");
		const parsed = JSON.parse(result.trim());
		const text: string = parsed.message.content[0].text;
		expect(text).toContain("Prime Context");
		expect(text).not.toContain("[MAIL]");
		expect(text).toContain("Begin.");
	});

	test("always includes beacon even when other sections are empty", () => {
		const result = buildInitialHeadlessPrompt(undefined, undefined, "Start now.");
		const parsed = JSON.parse(result.trim());
		const text: string = parsed.message.content[0].text;
		expect(text).toBe("Start now.");
	});

	test("output is valid NDJSON ending with newline", () => {
		const result = buildInitialHeadlessPrompt("ctx", "mail", "go");
		expect(result).toEndWith("\n");
		expect(() => JSON.parse(result.trim())).not.toThrow();
	});
});

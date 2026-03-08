import { describe, expect, test } from "bun:test";
import {
	DANGEROUS_BASH_PATTERNS,
	INTERACTIVE_TOOLS,
	NATIVE_TEAM_TOOLS,
	SAFE_BASH_PREFIXES,
	WRITE_TOOLS,
} from "./guard-rules.ts";

// ─── NATIVE_TEAM_TOOLS ───────────────────────────────────────────────────────

describe("NATIVE_TEAM_TOOLS", () => {
	test("is a non-empty array", () => {
		expect(Array.isArray(NATIVE_TEAM_TOOLS)).toBe(true);
		expect(NATIVE_TEAM_TOOLS.length).toBeGreaterThan(0);
	});

	test("contains all expected Claude Code team/task tools", () => {
		const expected = [
			"Task",
			"TeamCreate",
			"TeamDelete",
			"SendMessage",
			"TaskCreate",
			"TaskUpdate",
			"TaskList",
			"TaskGet",
			"TaskOutput",
			"TaskStop",
		];
		for (const tool of expected) {
			expect(NATIVE_TEAM_TOOLS).toContain(tool);
		}
	});

	test("has exactly 10 entries", () => {
		expect(NATIVE_TEAM_TOOLS.length).toBe(10);
	});

	test("has no duplicate entries", () => {
		const unique = new Set(NATIVE_TEAM_TOOLS);
		expect(unique.size).toBe(NATIVE_TEAM_TOOLS.length);
	});

	test("all entries are non-empty strings", () => {
		for (const tool of NATIVE_TEAM_TOOLS) {
			expect(typeof tool).toBe("string");
			expect(tool.length).toBeGreaterThan(0);
		}
	});
});

// ─── INTERACTIVE_TOOLS ───────────────────────────────────────────────────────

describe("INTERACTIVE_TOOLS", () => {
	test("is a non-empty array", () => {
		expect(Array.isArray(INTERACTIVE_TOOLS)).toBe(true);
		expect(INTERACTIVE_TOOLS.length).toBeGreaterThan(0);
	});

	test("contains AskUserQuestion", () => {
		expect(INTERACTIVE_TOOLS).toContain("AskUserQuestion");
	});

	test("contains EnterPlanMode", () => {
		expect(INTERACTIVE_TOOLS).toContain("EnterPlanMode");
	});

	test("contains EnterWorktree", () => {
		expect(INTERACTIVE_TOOLS).toContain("EnterWorktree");
	});

	test("has no duplicate entries", () => {
		const unique = new Set(INTERACTIVE_TOOLS);
		expect(unique.size).toBe(INTERACTIVE_TOOLS.length);
	});

	test("all entries are non-empty strings", () => {
		for (const tool of INTERACTIVE_TOOLS) {
			expect(typeof tool).toBe("string");
			expect(tool.length).toBeGreaterThan(0);
		}
	});

	test("does not contain any NATIVE_TEAM_TOOLS (no overlap)", () => {
		const nativeSet = new Set(NATIVE_TEAM_TOOLS);
		for (const tool of INTERACTIVE_TOOLS) {
			expect(nativeSet.has(tool)).toBe(false);
		}
	});
});

// ─── WRITE_TOOLS ─────────────────────────────────────────────────────────────

describe("WRITE_TOOLS", () => {
	test("is a non-empty array", () => {
		expect(Array.isArray(WRITE_TOOLS)).toBe(true);
		expect(WRITE_TOOLS.length).toBeGreaterThan(0);
	});

	test("contains Write", () => {
		expect(WRITE_TOOLS).toContain("Write");
	});

	test("contains Edit", () => {
		expect(WRITE_TOOLS).toContain("Edit");
	});

	test("contains NotebookEdit", () => {
		expect(WRITE_TOOLS).toContain("NotebookEdit");
	});

	test("has no duplicate entries", () => {
		const unique = new Set(WRITE_TOOLS);
		expect(unique.size).toBe(WRITE_TOOLS.length);
	});

	test("all entries are non-empty strings", () => {
		for (const tool of WRITE_TOOLS) {
			expect(typeof tool).toBe("string");
			expect(tool.length).toBeGreaterThan(0);
		}
	});

	test("does not overlap with NATIVE_TEAM_TOOLS", () => {
		const nativeSet = new Set(NATIVE_TEAM_TOOLS);
		for (const tool of WRITE_TOOLS) {
			expect(nativeSet.has(tool)).toBe(false);
		}
	});

	test("does not overlap with INTERACTIVE_TOOLS", () => {
		const interactiveSet = new Set(INTERACTIVE_TOOLS);
		for (const tool of WRITE_TOOLS) {
			expect(interactiveSet.has(tool)).toBe(false);
		}
	});
});

// ─── DANGEROUS_BASH_PATTERNS ─────────────────────────────────────────────────

describe("DANGEROUS_BASH_PATTERNS", () => {
	test("is a non-empty array", () => {
		expect(Array.isArray(DANGEROUS_BASH_PATTERNS)).toBe(true);
		expect(DANGEROUS_BASH_PATTERNS.length).toBeGreaterThan(0);
	});

	test("all entries are non-empty strings", () => {
		for (const pattern of DANGEROUS_BASH_PATTERNS) {
			expect(typeof pattern).toBe("string");
			expect(pattern.length).toBeGreaterThan(0);
		}
	});

	test("all entries are valid regex patterns", () => {
		for (const pattern of DANGEROUS_BASH_PATTERNS) {
			expect(() => new RegExp(pattern)).not.toThrow();
		}
	});

	test("has no duplicate entries", () => {
		const unique = new Set(DANGEROUS_BASH_PATTERNS);
		expect(unique.size).toBe(DANGEROUS_BASH_PATTERNS.length);
	});

	// Verify key dangerous operations are covered
	test("contains sed -i pattern", () => {
		const pattern = DANGEROUS_BASH_PATTERNS.find((p) => p.includes("sed") && p.includes("-i"));
		expect(pattern).toBeDefined();
	});

	test("contains echo redirect pattern", () => {
		const pattern = DANGEROUS_BASH_PATTERNS.find((p) => p.includes("echo") && p.includes(">"));
		expect(pattern).toBeDefined();
	});

	test("contains printf redirect pattern", () => {
		const pattern = DANGEROUS_BASH_PATTERNS.find((p) => p.includes("printf") && p.includes(">"));
		expect(pattern).toBeDefined();
	});

	test("contains cat redirect pattern", () => {
		const pattern = DANGEROUS_BASH_PATTERNS.find((p) => p.includes("cat") && p.includes(">"));
		expect(pattern).toBeDefined();
	});

	test("contains tee pattern", () => {
		const pattern = DANGEROUS_BASH_PATTERNS.find((p) => p.includes("tee"));
		expect(pattern).toBeDefined();
	});

	test("contains rm pattern", () => {
		const pattern = DANGEROUS_BASH_PATTERNS.find((p) => p.includes("rm"));
		expect(pattern).toBeDefined();
	});

	test("contains mv pattern", () => {
		const pattern = DANGEROUS_BASH_PATTERNS.find((p) => p.includes("mv"));
		expect(pattern).toBeDefined();
	});

	test("contains cp pattern", () => {
		const pattern = DANGEROUS_BASH_PATTERNS.find((p) => p.includes("cp"));
		expect(pattern).toBeDefined();
	});

	test("contains mkdir pattern", () => {
		const pattern = DANGEROUS_BASH_PATTERNS.find((p) => p.includes("mkdir"));
		expect(pattern).toBeDefined();
	});

	test("contains git add pattern", () => {
		const pattern = DANGEROUS_BASH_PATTERNS.find((p) => p.includes("git") && p.includes("add"));
		expect(pattern).toBeDefined();
	});

	test("contains git commit pattern", () => {
		const pattern = DANGEROUS_BASH_PATTERNS.find((p) => p.includes("git") && p.includes("commit"));
		expect(pattern).toBeDefined();
	});

	test("contains git push pattern", () => {
		const pattern = DANGEROUS_BASH_PATTERNS.find((p) => p.includes("git") && p.includes("push"));
		expect(pattern).toBeDefined();
	});

	test("contains git reset pattern", () => {
		const pattern = DANGEROUS_BASH_PATTERNS.find((p) => p.includes("git") && p.includes("reset"));
		expect(pattern).toBeDefined();
	});

	test("contains npm install pattern", () => {
		const pattern = DANGEROUS_BASH_PATTERNS.find((p) => p.includes("npm") && p.includes("install"));
		expect(pattern).toBeDefined();
	});

	test("contains bun install pattern", () => {
		const pattern = DANGEROUS_BASH_PATTERNS.find((p) => p.includes("bun") && p.includes("install"));
		expect(pattern).toBeDefined();
	});

	// Runtime eval bypass patterns
	test("contains bun -e / --eval pattern (runtime eval bypass)", () => {
		const hasEval = DANGEROUS_BASH_PATTERNS.some(
			(p) => p.includes("bun") && (p.includes("-e") || p.includes("eval")),
		);
		expect(hasEval).toBe(true);
	});

	test("contains node -e / --eval pattern (runtime eval bypass)", () => {
		const hasEval = DANGEROUS_BASH_PATTERNS.some(
			(p) => p.includes("node") && (p.includes("-e") || p.includes("eval")),
		);
		expect(hasEval).toBe(true);
	});

	test("contains python -c pattern (runtime eval bypass)", () => {
		const hasEval = DANGEROUS_BASH_PATTERNS.some((p) => p.includes("python") && p.includes("-c"));
		expect(hasEval).toBe(true);
	});

	// Functional: combined pattern matches dangerous commands
	test("combined pattern matches 'sed -i' command", () => {
		const combined = new RegExp(DANGEROUS_BASH_PATTERNS.join("|"));
		expect(combined.test("sed -i 's/foo/bar/' file.txt")).toBe(true);
	});

	test("combined pattern matches 'echo foo > file' command", () => {
		const combined = new RegExp(DANGEROUS_BASH_PATTERNS.join("|"));
		expect(combined.test("echo foo > file.txt")).toBe(true);
	});

	test("combined pattern matches 'rm -rf' command", () => {
		const combined = new RegExp(DANGEROUS_BASH_PATTERNS.join("|"));
		expect(combined.test("rm -rf /tmp/foo")).toBe(true);
	});

	test("combined pattern matches 'git commit' command", () => {
		const combined = new RegExp(DANGEROUS_BASH_PATTERNS.join("|"));
		expect(combined.test("git commit -m 'message'")).toBe(true);
	});

	test("combined pattern matches 'git push' command", () => {
		const combined = new RegExp(DANGEROUS_BASH_PATTERNS.join("|"));
		expect(combined.test("git push origin main")).toBe(true);
	});

	test("combined pattern matches 'bun --eval' command", () => {
		const combined = new RegExp(DANGEROUS_BASH_PATTERNS.join("|"));
		expect(combined.test("bun --eval 'console.log(1)'")).toBe(true);
	});

	test("combined pattern matches 'node -e' command", () => {
		const combined = new RegExp(DANGEROUS_BASH_PATTERNS.join("|"));
		expect(combined.test("node -e 'process.exit(1)'")).toBe(true);
	});

	test("combined pattern does NOT match safe read commands", () => {
		const combined = new RegExp(DANGEROUS_BASH_PATTERNS.join("|"));
		expect(combined.test("cat README.md")).toBe(false);
		expect(combined.test("grep -r 'foo' src/")).toBe(false);
		expect(combined.test("ls -la")).toBe(false);
	});
});

// ─── SAFE_BASH_PREFIXES ──────────────────────────────────────────────────────

describe("SAFE_BASH_PREFIXES", () => {
	test("is a non-empty array", () => {
		expect(Array.isArray(SAFE_BASH_PREFIXES)).toBe(true);
		expect(SAFE_BASH_PREFIXES.length).toBeGreaterThan(0);
	});

	test("all entries are non-empty strings", () => {
		for (const prefix of SAFE_BASH_PREFIXES) {
			expect(typeof prefix).toBe("string");
			expect(prefix.length).toBeGreaterThan(0);
		}
	});

	test("has no duplicate entries", () => {
		const unique = new Set(SAFE_BASH_PREFIXES);
		expect(unique.size).toBe(SAFE_BASH_PREFIXES.length);
	});

	test("includes overstory CLI shorthand 'ov '", () => {
		expect(SAFE_BASH_PREFIXES).toContain("ov ");
	});

	test("includes overstory CLI full name 'overstory '", () => {
		expect(SAFE_BASH_PREFIXES).toContain("overstory ");
	});

	test("includes beads CLI 'bd '", () => {
		expect(SAFE_BASH_PREFIXES).toContain("bd ");
	});

	test("includes seeds CLI 'sd '", () => {
		expect(SAFE_BASH_PREFIXES).toContain("sd ");
	});

	test("includes mulch CLI 'mulch '", () => {
		expect(SAFE_BASH_PREFIXES).toContain("mulch ");
	});

	test("includes agent-browser CLI 'agent-browser '", () => {
		expect(SAFE_BASH_PREFIXES).toContain("agent-browser ");
	});

	test("includes read-only git commands", () => {
		expect(SAFE_BASH_PREFIXES).toContain("git status");
		expect(SAFE_BASH_PREFIXES).toContain("git log");
		expect(SAFE_BASH_PREFIXES).toContain("git diff");
	});

	test("does not include destructive git commands as safe prefixes", () => {
		// git push, git reset, git commit should NOT be safe (builders can commit
		// but non-implementation agents should not)
		expect(SAFE_BASH_PREFIXES).not.toContain("git push");
		expect(SAFE_BASH_PREFIXES).not.toContain("git reset");
	});

	test("safe prefixes match expected commands via startsWith", () => {
		const isSafe = (cmd: string) =>
			SAFE_BASH_PREFIXES.some((prefix) => cmd.trimStart().startsWith(prefix));

		expect(isSafe("ov mail send --to parent --subject test")).toBe(true);
		expect(isSafe("overstory status")).toBe(true);
		expect(isSafe("sd close overstory-1234")).toBe(true);
		expect(isSafe("bd ready")).toBe(true);
		expect(isSafe("mulch record cli --type convention")).toBe(true);
		expect(isSafe("git status")).toBe(true);
		expect(isSafe("git log --oneline")).toBe(true);
		expect(isSafe("git diff HEAD")).toBe(true);
		expect(isSafe("agent-browser open http://localhost:3000 --session test")).toBe(true);
		expect(isSafe("agent-browser snapshot -i --json")).toBe(true);
	});
});

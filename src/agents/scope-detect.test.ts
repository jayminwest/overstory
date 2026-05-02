import { describe, expect, test } from "bun:test";
import {
	detectScopeViolation,
	findScopeViolations,
	hasExpansionReason,
	IMPLEMENTATION_CAPABILITIES,
	parseExpansionReasonsFromGitLog,
} from "./scope-detect.ts";

describe("findScopeViolations", () => {
	test("literal match: in-scope file is not a violation", () => {
		const result = findScopeViolations(["src/foo.ts"], ["src/foo.ts"]);
		expect(result).toEqual([]);
	});

	test("glob match: src/foo/**/*.ts allows nested file", () => {
		const result = findScopeViolations(
			["src/foo/bar/baz.ts", "src/foo/qux.ts"],
			["src/foo/**/*.ts"],
		);
		expect(result).toEqual([]);
	});

	test("out-of-scope file is reported", () => {
		const result = findScopeViolations(["src/other.ts"], ["src/foo.ts"]);
		expect(result).toEqual(["src/other.ts"]);
	});

	test("empty fileScope is treated as unrestricted", () => {
		const result = findScopeViolations(["any/file.ts", "another.ts"], []);
		expect(result).toEqual([]);
	});

	test("partial violations: returns only the out-of-scope subset", () => {
		const result = findScopeViolations(
			["src/foo.ts", "src/other.ts", "src/bar.ts"],
			["src/foo.ts", "src/bar.ts"],
		);
		expect(result).toEqual(["src/other.ts"]);
	});

	test("glob match: literal path equals scope entry without a glob char", () => {
		const result = findScopeViolations(["a.ts"], ["a.ts"]);
		expect(result).toEqual([]);
	});
});

describe("hasExpansionReason", () => {
	test("expansion_reason: with value → true", () => {
		expect(hasExpansionReason("expansion_reason: foo")).toBe(true);
	});

	test("Expansion_Reason: case-insensitive → true", () => {
		expect(hasExpansionReason("Expansion_Reason: bar")).toBe(true);
	});

	test("EXPANSION_REASON: multi-word value → true", () => {
		expect(hasExpansionReason("EXPANSION_REASON: baz quux")).toBe(true);
	});

	test("expansion_reason: empty value → false", () => {
		expect(hasExpansionReason("expansion_reason:")).toBe(false);
	});

	test("expansion_reason: only whitespace → false", () => {
		expect(hasExpansionReason("expansion_reason:   ")).toBe(false);
	});

	test("expansion-reason: hyphen separator → false", () => {
		expect(hasExpansionReason("expansion-reason: foo")).toBe(false);
	});

	test("no marker → false", () => {
		expect(hasExpansionReason("no reason here")).toBe(false);
	});

	test("marker embedded in commit body with prefix → true", () => {
		const body = "Refactor the thing\n\nexpansion_reason: had to update shared types\n";
		expect(hasExpansionReason(body)).toBe(true);
	});
});

describe("parseExpansionReasonsFromGitLog", () => {
	test("returns each value across multiple commit bodies", () => {
		const log = [
			"feat: a thing",
			"",
			"expansion_reason: needed shared type",
			"",
			"fix: another thing",
			"",
			"expansion_reason: had to update barrel export",
		].join("\n");
		const result = parseExpansionReasonsFromGitLog(log);
		expect(result).toEqual(["needed shared type", "had to update barrel export"]);
	});

	test("trims whitespace around values", () => {
		const log = "expansion_reason:    surrounded by spaces   \n";
		const result = parseExpansionReasonsFromGitLog(log);
		expect(result).toEqual(["surrounded by spaces"]);
	});

	test("ignores commits without the marker", () => {
		const log = "feat: regular commit\n\nfix: another\n";
		expect(parseExpansionReasonsFromGitLog(log)).toEqual([]);
	});

	test("empty log returns empty array", () => {
		expect(parseExpansionReasonsFromGitLog("")).toEqual([]);
	});

	test("case-insensitive match", () => {
		const log = "Expansion_Reason: capitalized variant\n";
		expect(parseExpansionReasonsFromGitLog(log)).toEqual(["capitalized variant"]);
	});
});

describe("detectScopeViolation", () => {
	test("returns expected violations and expansion reasons via stub", () => {
		const stub = (args: string[]): string => {
			if (args[0] === "diff") return "src/foo.ts\nsrc/other.ts\n";
			if (args[0] === "log") return "feat: change\n\nexpansion_reason: cross-cutting\n";
			return "";
		};
		const result = detectScopeViolation({
			worktreePath: "/tmp/wt",
			baseRef: "main",
			fileScope: ["src/foo.ts"],
			gitRunner: stub,
		});
		expect(result.violations).toEqual(["src/other.ts"]);
		expect(result.expansionReasons).toEqual(["cross-cutting"]);
	});

	test("returns empty when stub throws", () => {
		const stub = (): string => {
			throw new Error("boom");
		};
		const result = detectScopeViolation({
			worktreePath: "/tmp/wt",
			baseRef: "main",
			fileScope: ["src/foo.ts"],
			gitRunner: stub,
		});
		expect(result.violations).toEqual([]);
		expect(result.expansionReasons).toEqual([]);
	});

	test("empty fileScope yields no violations regardless of diff", () => {
		const stub = (args: string[]): string => {
			if (args[0] === "diff") return "src/anything.ts\n";
			return "";
		};
		const result = detectScopeViolation({
			worktreePath: "/tmp/wt",
			baseRef: "main",
			fileScope: [],
			gitRunner: stub,
		});
		expect(result.violations).toEqual([]);
	});

	test("blank diff lines are filtered", () => {
		const stub = (args: string[]): string => {
			if (args[0] === "diff") return "\nsrc/foo.ts\n\n\nsrc/bar.ts\n";
			return "";
		};
		const result = detectScopeViolation({
			worktreePath: "/tmp/wt",
			baseRef: "main",
			fileScope: ["src/foo.ts"],
			gitRunner: stub,
		});
		expect(result.violations).toEqual(["src/bar.ts"]);
	});
});

describe("IMPLEMENTATION_CAPABILITIES", () => {
	test("includes builder and merger", () => {
		expect(IMPLEMENTATION_CAPABILITIES.has("builder")).toBe(true);
		expect(IMPLEMENTATION_CAPABILITIES.has("merger")).toBe(true);
	});

	test("excludes read-only roles", () => {
		expect(IMPLEMENTATION_CAPABILITIES.has("scout")).toBe(false);
		expect(IMPLEMENTATION_CAPABILITIES.has("reviewer")).toBe(false);
		expect(IMPLEMENTATION_CAPABILITIES.has("lead")).toBe(false);
	});
});

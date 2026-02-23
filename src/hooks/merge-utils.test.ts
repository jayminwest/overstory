import { describe, expect, test } from "bun:test";
import {
	collectCommands,
	isOverstoryCommand,
	mergeEventHooks,
	stripOverstoryCommands,
} from "./merge-utils.ts";

describe("isOverstoryCommand", () => {
	test("matches overstory binary calls", () => {
		expect(isOverstoryCommand("overstory prime --agent foo")).toBe(true);
	});

	test("matches mulch binary calls", () => {
		expect(isOverstoryCommand("mulch learn")).toBe(true);
	});

	test("matches OVERSTORY_ env var references", () => {
		expect(isOverstoryCommand('[ -z "$OVERSTORY_AGENT_NAME" ] && exit 0;')).toBe(true);
	});

	test("matches OVERSTORY_WORKTREE_PATH references", () => {
		expect(
			isOverstoryCommand('[ -z "$OVERSTORY_WORKTREE_PATH" ] && exit 0; read -r INPUT;'),
		).toBe(true);
	});

	test("does not match unrelated commands", () => {
		expect(isOverstoryCommand("echo my-custom-hook")).toBe(false);
	});

	test("does not match empty string", () => {
		expect(isOverstoryCommand("")).toBe(false);
	});

	test("does not match commands with similar substrings", () => {
		expect(isOverstoryCommand("my-overstuff-tool")).toBe(false);
	});
});

describe("stripOverstoryCommands", () => {
	test("returns null when all hooks are overstory", () => {
		const entry = {
			matcher: "",
			hooks: [{ type: "command", command: "overstory prime --agent foo" }],
		};
		expect(stripOverstoryCommands(entry)).toBeNull();
	});

	test("preserves non-overstory hooks", () => {
		const entry = {
			matcher: "",
			hooks: [
				{ type: "command", command: "echo custom-hook" },
				{ type: "command", command: "overstory prime --agent foo" },
			],
		};
		const result = stripOverstoryCommands(entry) as Record<string, unknown>;
		expect(result).not.toBeNull();
		const hooks = result.hooks as Array<{ command: string }>;
		expect(hooks).toHaveLength(1);
		expect(hooks[0].command).toBe("echo custom-hook");
	});

	test("strips commands with OVERSTORY_ env vars", () => {
		const entry = {
			matcher: "",
			hooks: [
				{ type: "command", command: '[ -z "$OVERSTORY_AGENT_NAME" ] && exit 0; echo block' },
			],
		};
		expect(stripOverstoryCommands(entry)).toBeNull();
	});

	test("returns non-object values unchanged", () => {
		expect(stripOverstoryCommands("string")).toBe("string");
		expect(stripOverstoryCommands(42)).toBe(42);
		expect(stripOverstoryCommands(null)).toBeNull();
	});

	test("returns entry unchanged if no hooks array", () => {
		const entry = { matcher: "", other: "value" };
		expect(stripOverstoryCommands(entry)).toEqual(entry);
	});
});

describe("collectCommands", () => {
	test("collects commands from multiple entries", () => {
		const entries = [
			{ matcher: "", hooks: [{ type: "command", command: "cmd1" }] },
			{ matcher: "", hooks: [{ type: "command", command: "cmd2" }] },
		];
		const cmds = collectCommands(entries);
		expect(cmds.size).toBe(2);
		expect(cmds.has("cmd1")).toBe(true);
		expect(cmds.has("cmd2")).toBe(true);
	});

	test("handles entries with multiple inner hooks", () => {
		const entries = [
			{
				matcher: "",
				hooks: [
					{ type: "command", command: "cmd1" },
					{ type: "command", command: "cmd2" },
				],
			},
		];
		const cmds = collectCommands(entries);
		expect(cmds.size).toBe(2);
	});

	test("skips non-object entries", () => {
		const entries = [
			"string",
			null,
			{ matcher: "", hooks: [{ type: "command", command: "cmd1" }] },
		];
		const cmds = collectCommands(entries);
		expect(cmds.size).toBe(1);
	});

	test("returns empty set for empty array", () => {
		expect(collectCommands([]).size).toBe(0);
	});
});

describe("mergeEventHooks", () => {
	test("appends new entries to target", () => {
		const target = [{ matcher: "", hooks: [{ type: "command", command: "existing-cmd" }] }];
		const source = [{ matcher: "", hooks: [{ type: "command", command: "new-cmd" }] }];
		const result = mergeEventHooks(target, source);
		expect(result).toHaveLength(2);
	});

	test("deduplicates entries with same commands", () => {
		const target = [{ matcher: "", hooks: [{ type: "command", command: "same-cmd" }] }];
		const source = [{ matcher: "", hooks: [{ type: "command", command: "same-cmd" }] }];
		const result = mergeEventHooks(target, source);
		expect(result).toHaveLength(1);
	});

	test("preserves order: target first, then new source entries", () => {
		const target = [{ matcher: "", hooks: [{ type: "command", command: "target-cmd" }] }];
		const source = [{ matcher: "", hooks: [{ type: "command", command: "source-cmd" }] }];
		const result = mergeEventHooks(target, source) as Array<{
			hooks: Array<{ command: string }>;
		}>;
		expect(result[0].hooks[0].command).toBe("target-cmd");
		expect(result[1].hooks[0].command).toBe("source-cmd");
	});

	test("handles empty target", () => {
		const source = [{ matcher: "", hooks: [{ type: "command", command: "new-cmd" }] }];
		const result = mergeEventHooks([], source);
		expect(result).toHaveLength(1);
	});

	test("handles empty source", () => {
		const target = [{ matcher: "", hooks: [{ type: "command", command: "existing-cmd" }] }];
		const result = mergeEventHooks(target, []);
		expect(result).toHaveLength(1);
	});
});

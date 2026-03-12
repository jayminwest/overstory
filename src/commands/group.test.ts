/**
 * Tests for overstory group command.
 *
 * Uses real temp directories for groups.json I/O and direct function calls
 * to createGroup, addToGroup, removeFromGroup, getGroupProgress, printGroupProgress.
 * Tracker validation uses inline stub objects (no mock.module).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { GroupError, ValidationError } from "../errors.ts";
import { cleanupTempDir, createTempGitRepo } from "../test-helpers.ts";
import type { TrackerIssue } from "../tracker/types.ts";
import type { TaskGroup, TaskGroupProgress } from "../types.ts";
import {
	addToGroup,
	createGroup,
	getGroupProgress,
	loadGroups,
	printGroupProgress,
	removeFromGroup,
} from "./group.ts";

let tempDir: string;
let overstoryDir: string;

beforeEach(async () => {
	tempDir = await createTempGitRepo();
	overstoryDir = join(tempDir, ".overstory");
	await mkdir(overstoryDir, { recursive: true });
});

afterEach(async () => {
	await cleanupTempDir(tempDir);
});

/**
 * Helper to write groups.json directly for test setup.
 */
async function writeGroups(groups: TaskGroup[]): Promise<void> {
	const path = join(overstoryDir, "groups.json");
	await Bun.write(path, `${JSON.stringify(groups, null, "\t")}\n`);
}

function makeGroup(overrides?: Partial<TaskGroup>): TaskGroup {
	return {
		id: `group-${crypto.randomUUID().slice(0, 8)}`,
		name: "Test Group",
		memberIssueIds: ["issue-1", "issue-2"],
		status: "active",
		createdAt: new Date().toISOString(),
		completedAt: null,
		...overrides,
	};
}

// -- loadGroups --

describe("loadGroups", () => {
	test("returns empty array when groups.json does not exist", async () => {
		const groups = await loadGroups(tempDir);
		expect(groups).toEqual([]);
	});

	test("returns empty array when groups.json is malformed", async () => {
		const path = join(overstoryDir, "groups.json");
		await Bun.write(path, "not valid json");
		const groups = await loadGroups(tempDir);
		expect(groups).toEqual([]);
	});

	test("loads groups from valid groups.json", async () => {
		const group = makeGroup({ name: "My Group" });
		await writeGroups([group]);
		const groups = await loadGroups(tempDir);
		expect(groups).toHaveLength(1);
		expect(groups[0]?.name).toBe("My Group");
	});
});

// -- createGroup --

describe("createGroup", () => {
	test("creates a group with valid name and issue IDs", async () => {
		const group = await createGroup(tempDir, "Feature Batch", ["abc-1", "def-2"], true);
		expect(group.name).toBe("Feature Batch");
		expect(group.memberIssueIds).toEqual(["abc-1", "def-2"]);
		expect(group.status).toBe("active");
		expect(group.completedAt).toBeNull();
		expect(group.id).toMatch(/^group-[a-f0-9]{8}$/);
		expect(group.createdAt).toBeTruthy();
	});

	test("persists to disk", async () => {
		await createGroup(tempDir, "Persisted", ["x-1"], true);
		const loaded = await loadGroups(tempDir);
		expect(loaded).toHaveLength(1);
		expect(loaded[0]?.name).toBe("Persisted");
		expect(loaded[0]?.memberIssueIds).toEqual(["x-1"]);
	});

	test("throws ValidationError for empty name", async () => {
		await expect(createGroup(tempDir, "", ["id-1"], true)).rejects.toThrow(ValidationError);
		await expect(createGroup(tempDir, "   ", ["id-1"], true)).rejects.toThrow(ValidationError);
	});

	test("throws ValidationError for empty issueIds", async () => {
		await expect(createGroup(tempDir, "Name", [], true)).rejects.toThrow(ValidationError);
	});

	test("throws ValidationError for duplicate IDs", async () => {
		await expect(createGroup(tempDir, "Name", ["a", "b", "a"], true)).rejects.toThrow(
			ValidationError,
		);
	});

	test("appends to existing groups", async () => {
		await createGroup(tempDir, "First", ["id-1"], true);
		await createGroup(tempDir, "Second", ["id-2"], true);
		const loaded = await loadGroups(tempDir);
		expect(loaded).toHaveLength(2);
		expect(loaded[0]?.name).toBe("First");
		expect(loaded[1]?.name).toBe("Second");
	});
});

// -- addToGroup --

describe("addToGroup", () => {
	test("adds IDs to an existing group", async () => {
		const created = await createGroup(tempDir, "G", ["a"], true);
		const updated = await addToGroup(tempDir, created.id, ["b", "c"], true);
		expect(updated.memberIssueIds).toEqual(["a", "b", "c"]);
	});

	test("throws GroupError when group not found", async () => {
		await expect(addToGroup(tempDir, "group-missing0", ["x"], true)).rejects.toThrow(GroupError);
	});

	test("throws GroupError for duplicate member", async () => {
		const created = await createGroup(tempDir, "G", ["a", "b"], true);
		await expect(addToGroup(tempDir, created.id, ["a"], true)).rejects.toThrow(GroupError);
	});

	test("reopens completed group when adding issues", async () => {
		const created = await createGroup(tempDir, "G", ["a"], true);
		// Manually mark as completed on disk
		const groups = await loadGroups(tempDir);
		const target = groups[0];
		if (!target) throw new Error("expected group");
		target.status = "completed";
		target.completedAt = new Date().toISOString();
		await writeGroups(groups);

		const updated = await addToGroup(tempDir, created.id, ["b"], true);
		expect(updated.status).toBe("active");
		expect(updated.completedAt).toBeNull();
	});

	test("throws ValidationError for empty issueIds", async () => {
		const created = await createGroup(tempDir, "G", ["a"], true);
		await expect(addToGroup(tempDir, created.id, [], true)).rejects.toThrow(ValidationError);
	});
});

// -- removeFromGroup --

describe("removeFromGroup", () => {
	test("removes IDs from a group", async () => {
		const created = await createGroup(tempDir, "G", ["a", "b", "c"], true);
		const updated = await removeFromGroup(tempDir, created.id, ["b"]);
		expect(updated.memberIssueIds).toEqual(["a", "c"]);
	});

	test("throws GroupError when group not found", async () => {
		await expect(removeFromGroup(tempDir, "group-missing0", ["x"])).rejects.toThrow(GroupError);
	});

	test("throws GroupError for non-member issue", async () => {
		const created = await createGroup(tempDir, "G", ["a", "b"], true);
		await expect(removeFromGroup(tempDir, created.id, ["z"])).rejects.toThrow(GroupError);
	});

	test("throws GroupError when removal would empty the group", async () => {
		const created = await createGroup(tempDir, "G", ["only"], true);
		await expect(removeFromGroup(tempDir, created.id, ["only"])).rejects.toThrow(GroupError);
	});

	test("throws ValidationError for empty issueIds", async () => {
		const created = await createGroup(tempDir, "G", ["a"], true);
		await expect(removeFromGroup(tempDir, created.id, [])).rejects.toThrow(ValidationError);
	});

	test("persists removal to disk", async () => {
		const created = await createGroup(tempDir, "G", ["a", "b", "c"], true);
		await removeFromGroup(tempDir, created.id, ["b"]);
		const loaded = await loadGroups(tempDir);
		expect(loaded[0]?.memberIssueIds).toEqual(["a", "c"]);
	});
});

// -- getGroupProgress --

describe("getGroupProgress", () => {
	test("counts default to open without tracker", async () => {
		const group = makeGroup({ memberIssueIds: ["x", "y", "z"] });
		const groups = [group];
		await writeGroups(groups);

		const progress = await getGroupProgress(tempDir, group, groups);
		expect(progress.total).toBe(3);
		expect(progress.open).toBe(3);
		expect(progress.completed).toBe(0);
		expect(progress.inProgress).toBe(0);
		expect(progress.blocked).toBe(0);
	});

	test("auto-closes when all issues are closed (stub tracker)", async () => {
		const group = makeGroup({ memberIssueIds: ["done-1", "done-2"] });
		const groups = [group];
		await writeGroups(groups);

		const stubTracker = {
			ready: async () => [],
			show: async (id: string): Promise<TrackerIssue> => ({
				id,
				title: id,
				status: "closed",
				priority: 3,
				type: "task",
			}),
			create: async () => "",
			claim: async () => {},
			close: async () => {},
			list: async () => [],
			sync: async () => {},
		};

		const progress = await getGroupProgress(tempDir, group, groups, stubTracker);
		expect(progress.completed).toBe(2);
		expect(progress.total).toBe(2);
		expect(progress.group.status).toBe("completed");
		expect(progress.group.completedAt).not.toBeNull();
	});

	test("does not auto-close when some issues are still open", async () => {
		const group = makeGroup({ memberIssueIds: ["done-1", "open-1"] });
		const groups = [group];
		await writeGroups(groups);

		const stubTracker = {
			ready: async () => [],
			show: async (id: string): Promise<TrackerIssue> => ({
				id,
				title: id,
				status: id.startsWith("done-") ? "closed" : "open",
				priority: 3,
				type: "task",
			}),
			create: async () => "",
			claim: async () => {},
			close: async () => {},
			list: async () => [],
			sync: async () => {},
		};

		const progress = await getGroupProgress(tempDir, group, groups, stubTracker);
		expect(progress.completed).toBe(1);
		expect(progress.open).toBe(1);
		expect(progress.group.status).toBe("active");
	});

	test("counts in_progress and blocked statuses", async () => {
		const group = makeGroup({ memberIssueIds: ["ip-1", "bl-1", "cl-1", "op-1"] });
		const groups = [group];
		await writeGroups(groups);

		const statusMap: Record<string, string> = {
			"ip-1": "in_progress",
			"bl-1": "blocked",
			"cl-1": "closed",
			"op-1": "open",
		};

		const stubTracker = {
			ready: async () => [],
			show: async (id: string): Promise<TrackerIssue> => ({
				id,
				title: id,
				status: statusMap[id] ?? "open",
				priority: 3,
				type: "task",
			}),
			create: async () => "",
			claim: async () => {},
			close: async () => {},
			list: async () => [],
			sync: async () => {},
		};

		const progress = await getGroupProgress(tempDir, group, groups, stubTracker);
		expect(progress.inProgress).toBe(1);
		expect(progress.blocked).toBe(1);
		expect(progress.completed).toBe(1);
		expect(progress.open).toBe(1);
	});
});

// -- printGroupProgress --

describe("printGroupProgress", () => {
	test("outputs formatted progress for active group", () => {
		const group = makeGroup({ id: "group-abc12345", name: "My Group" });
		const progress: TaskGroupProgress = {
			group,
			total: 5,
			completed: 2,
			inProgress: 1,
			blocked: 1,
			open: 1,
		};

		const chunks: string[] = [];
		const origWrite = process.stdout.write;
		process.stdout.write = ((chunk: string) => {
			chunks.push(chunk);
			return true;
		}) as typeof process.stdout.write;

		try {
			printGroupProgress(progress);
		} finally {
			process.stdout.write = origWrite;
		}

		const output = chunks.join("");
		expect(output).toContain("My Group");
		expect(output).toContain("group-abc12345");
		expect(output).toContain("[active]");
		expect(output).toContain("5 total");
		expect(output).toContain("2 completed");
		expect(output).toContain("1 in_progress");
		expect(output).toContain("1 blocked");
		expect(output).toContain("1 open");
	});

	test("outputs completed timestamp for completed group", () => {
		const group = makeGroup({
			id: "group-done1234",
			name: "Done Group",
			status: "completed",
			completedAt: "2026-01-15T10:00:00.000Z",
		});
		const progress: TaskGroupProgress = {
			group,
			total: 2,
			completed: 2,
			inProgress: 0,
			blocked: 0,
			open: 0,
		};

		const chunks: string[] = [];
		const origWrite = process.stdout.write;
		process.stdout.write = ((chunk: string) => {
			chunks.push(chunk);
			return true;
		}) as typeof process.stdout.write;

		try {
			printGroupProgress(progress);
		} finally {
			process.stdout.write = origWrite;
		}

		const output = chunks.join("");
		expect(output).toContain("[completed]");
		expect(output).toContain("2026-01-15T10:00:00.000Z");
	});
});

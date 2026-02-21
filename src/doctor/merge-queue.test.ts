import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMergeQueue } from "../merge/queue.ts";
import type { OverstoryConfig } from "../types.ts";
import { checkMergeQueue } from "./merge-queue.ts";
import type { DoctorCheck } from "./types.ts";

describe("checkMergeQueue", () => {
	let tempDir: string;
	let mockConfig: OverstoryConfig;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "overstory-test-"));
		mockConfig = {
			project: { name: "test", root: tempDir, canonicalBranch: "main" },
			agents: {
				manifestPath: "",
				baseDir: "",
				maxConcurrent: 5,
				staggerDelayMs: 100,
				maxDepth: 2,
				maxSessionsPerRun: 0,
			},
			worktrees: { baseDir: "" },
			beads: { enabled: true },
			mulch: { enabled: true, domains: [], primeFormat: "markdown" },
			merge: { aiResolveEnabled: false, reimagineEnabled: false },
			providers: {
				anthropic: { type: "native" },
			},
			watchdog: {
				tier0Enabled: true,
				tier0IntervalMs: 30000,
				tier1Enabled: false,
				tier2Enabled: false,
				staleThresholdMs: 300000,
				zombieThresholdMs: 600000,
				nudgeIntervalMs: 60000,
			},
			models: {},
			logging: { verbose: false, redactSecrets: true },
		};
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	test("passes when merge queue db does not exist", () => {
		const checks = checkMergeQueue(mockConfig, tempDir) as DoctorCheck[];

		expect(checks).toHaveLength(1);
		expect(checks[0]?.status).toBe("pass");
		expect(checks[0]?.name).toBe("merge-queue.db exists");
		expect(checks[0]?.message).toContain("normal for new installations");
	});

	test("passes when merge queue is empty", () => {
		const dbPath = join(tempDir, "merge-queue.db");
		// Create empty queue
		const queue = createMergeQueue(dbPath);
		queue.close();

		const checks = checkMergeQueue(mockConfig, tempDir) as DoctorCheck[];

		expect(checks).toHaveLength(1);
		expect(checks[0]?.status).toBe("pass");
		expect(checks[0]?.name).toBe("merge-queue.db schema");
		expect(checks[0]?.message).toBe("Merge queue has 0 entries");
	});

	test("passes with valid queue entries", () => {
		const dbPath = join(tempDir, "merge-queue.db");
		const queue = createMergeQueue(dbPath);
		queue.enqueue({
			branchName: "feature/test",
			beadId: "beads-abc",
			agentName: "test-agent",
			filesModified: ["src/test.ts"],
		});
		queue.enqueue({
			branchName: "feature/another",
			beadId: "beads-def",
			agentName: "another-agent",
			filesModified: ["src/another.ts"],
		});
		// Mark second entry as merged
		const entry = queue.list()[1];
		if (entry) {
			queue.updateStatus(entry.branchName, "merged", "clean-merge");
		}
		queue.close();

		const checks = checkMergeQueue(mockConfig, tempDir) as DoctorCheck[];

		expect(checks).toHaveLength(1);
		expect(checks[0]?.status).toBe("pass");
		expect(checks[0]?.name).toBe("merge-queue.db schema");
		expect(checks[0]?.message).toBe("Merge queue has 2 entries");
	});

	test("fails when db is corrupted", () => {
		const dbPath = join(tempDir, "merge-queue.db");
		// Write invalid data to db file
		const fs = require("node:fs");
		fs.writeFileSync(dbPath, "not a valid sqlite database");

		const checks = checkMergeQueue(mockConfig, tempDir) as DoctorCheck[];

		expect(checks).toHaveLength(1);
		expect(checks[0]?.status).toBe("fail");
		expect(checks[0]?.name).toBe("merge-queue.db readable");
		expect(checks[0]?.message).toContain("Failed to read merge-queue.db");
	});

	test("fails when table does not exist", () => {
		const dbPath = join(tempDir, "merge-queue.db");
		// Create a db but without the merge_queue table
		const db = new Database(dbPath);
		db.exec("CREATE TABLE other_table (id INTEGER PRIMARY KEY)");
		db.close();

		const checks = checkMergeQueue(mockConfig, tempDir) as DoctorCheck[];

		const schemaCheck = checks.find((c) => c?.name === "merge-queue.db schema");
		expect(schemaCheck?.status).toBe("fail");
		expect(schemaCheck?.message).toContain("merge_queue table not found");
	});

	test("warns about stale pending entries", () => {
		const dbPath = join(tempDir, "merge-queue.db");
		// Create queue and manually insert stale entry (2 days old)
		const queue = createMergeQueue(dbPath);
		queue.close();

		const staleDate = new Date();
		staleDate.setDate(staleDate.getDate() - 2); // 2 days ago

		const db = new Database(dbPath);
		db.prepare(
			"INSERT INTO merge_queue (branch_name, bead_id, agent_name, files_modified, status, enqueued_at) VALUES (?, ?, ?, ?, ?, ?)",
		).run(
			"feature/stale",
			"beads-abc",
			"test-agent",
			JSON.stringify(["src/test.ts"]),
			"pending",
			staleDate.toISOString(),
		);
		db.close();

		const checks = checkMergeQueue(mockConfig, tempDir) as DoctorCheck[];

		const staleCheck = checks.find((c) => c?.name === "merge-queue.db staleness");
		expect(staleCheck?.status).toBe("warn");
		expect(staleCheck?.message).toContain("potentially stale");
		expect(staleCheck?.details?.[0]).toContain("feature/stale");
	});

	test("does not warn about old completed entries", () => {
		const dbPath = join(tempDir, "merge-queue.db");
		// Create queue and manually insert old merged entry (2 days ago)
		const queue = createMergeQueue(dbPath);
		queue.close();

		const oldDate = new Date();
		oldDate.setDate(oldDate.getDate() - 2); // 2 days ago

		const db = new Database(dbPath);
		db.prepare(
			"INSERT INTO merge_queue (branch_name, bead_id, agent_name, files_modified, status, enqueued_at, resolved_tier) VALUES (?, ?, ?, ?, ?, ?, ?)",
		).run(
			"feature/old-merged",
			"beads-abc",
			"test-agent",
			JSON.stringify(["src/test.ts"]),
			"merged",
			oldDate.toISOString(),
			"clean-merge",
		);
		db.close();

		const checks = checkMergeQueue(mockConfig, tempDir) as DoctorCheck[];

		const staleCheck = checks.find((c) => c?.name === "merge-queue.db staleness");
		expect(staleCheck).toBeUndefined();
	});

	test("warns about duplicate branches", () => {
		const dbPath = join(tempDir, "merge-queue.db");
		const queue = createMergeQueue(dbPath);
		queue.enqueue({
			branchName: "feature/duplicate",
			beadId: "beads-abc",
			agentName: "test-agent",
			filesModified: ["src/test.ts"],
		});
		queue.enqueue({
			branchName: "feature/duplicate",
			beadId: "beads-def",
			agentName: "another-agent",
			filesModified: ["src/another.ts"],
		});
		queue.close();

		const checks = checkMergeQueue(mockConfig, tempDir) as DoctorCheck[];

		const duplicateCheck = checks.find((c) => c?.name === "merge-queue.db duplicates");
		expect(duplicateCheck?.status).toBe("warn");
		expect(duplicateCheck?.message).toContain("duplicate branch entries");
		expect(duplicateCheck?.details?.[0]).toContain("feature/duplicate");
	});
});

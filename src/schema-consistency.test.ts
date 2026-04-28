/**
 * SQL schema consistency tests.
 *
 * Verifies that SQL CREATE TABLE column names match the TypeScript row interfaces
 * and row-to-object conversion functions across all four SQLite stores.
 * Prevents regressions like the bead_id/task_id column rename that caused runtime failures.
 *
 * Strategy: create each store (which runs CREATE TABLE), then open a second
 * read-only connection to the same temp file and query PRAGMA table_info().
 * bun:sqlite with WAL mode allows concurrent readers.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventStore } from "./events/store.ts";
import { createMailStore } from "./mail/store.ts";
import { createMergeQueue } from "./merge/queue.ts";
import { createMetricsStore } from "./metrics/store.ts";
import { createSessionStore } from "./sessions/store.ts";

import { cleanupTempDir } from "./test-helpers.ts";

/** Extract sorted column names from a table via PRAGMA table_info(). */
function getTableColumns(db: Database, tableName: string): string[] {
	const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
	return rows.map((r) => r.name).sort();
}

describe("SQL schema consistency", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "overstory-schema-test-"));
	});

	afterEach(async () => {
		await cleanupTempDir(tmpDir);
	});

	describe("SessionStore", () => {
		test("sessions table columns match SessionRow interface", () => {
			const dbPath = join(tmpDir, "sessions.db");
			const store = createSessionStore(dbPath);

			const db = new Database(dbPath, { readonly: true });
			const actual = getTableColumns(db, "sessions");
			db.close();
			store.close();

			// Columns from SessionRow interface in src/sessions/store.ts
			const expected = [
				"agent_name",
				"branch_name",
				"capability",
				"claude_session_id",
				"depth",
				"escalation_level",
				"id",
				"last_activity",
				"parent_agent",
				"pid",
				"run_id",
				"prompt_version",
				"stalled_since",
				"started_at",
				"state",
				"task_id",
				"tmux_session",
				"transcript_path",
				"worktree_path",
			].sort();

			expect(actual).toEqual(expected);
		});

		test("runs table columns match RunRow interface", () => {
			const dbPath = join(tmpDir, "sessions.db");
			const store = createSessionStore(dbPath);

			const db = new Database(dbPath, { readonly: true });
			const actual = getTableColumns(db, "runs");
			db.close();
			store.close();

			// Columns from RunRow interface in src/sessions/store.ts
			const expected = [
				"agent_count",
				"completed_at",
				"coordinator_name",
				"coordinator_session_id",
				"id",
				"started_at",
				"status",
			].sort();

			expect(actual).toEqual(expected);
		});
	});

	describe("EventStore", () => {
		test("events table columns match EventRow interface", () => {
			const dbPath = join(tmpDir, "events.db");
			const store = createEventStore(dbPath);

			const db = new Database(dbPath, { readonly: true });
			const actual = getTableColumns(db, "events");
			db.close();
			store.close();

			// Columns from EventRow interface in src/events/store.ts
			const expected = [
				"agent_name",
				"created_at",
				"data",
				"event_type",
				"id",
				"level",
				"run_id",
				"session_id",
				"tool_args",
				"tool_duration_ms",
				"tool_name",
			].sort();

			expect(actual).toEqual(expected);
		});
	});

	describe("MetricsStore", () => {
		test("sessions table columns match metrics SessionRow interface", () => {
			const dbPath = join(tmpDir, "metrics.db");
			const store = createMetricsStore(dbPath);

			const db = new Database(dbPath, { readonly: true });
			const actual = getTableColumns(db, "sessions");
			db.close();
			store.close();

			// Columns from SessionRow interface in src/metrics/store.ts
			const expected = [
				"agent_name",
				"cache_creation_tokens",
				"cache_read_tokens",
				"capability",
				"completed_at",
				"duration_ms",
				"estimated_cost_usd",
				"exit_code",
				"input_tokens",
				"merge_result",
				"model_used",
				"output_tokens",
				"parent_agent",
				"run_id",
				"started_at",
				"task_id",
			].sort();

			expect(actual).toEqual(expected);
		});

		test("token_snapshots table columns match SnapshotRow interface", () => {
			const dbPath = join(tmpDir, "metrics.db");
			const store = createMetricsStore(dbPath);

			const db = new Database(dbPath, { readonly: true });
			const actual = getTableColumns(db, "token_snapshots");
			db.close();
			store.close();

			// Columns from SnapshotRow interface in src/metrics/store.ts
			const expected = [
				"agent_name",
				"cache_creation_tokens",
				"cache_read_tokens",
				"created_at",
				"estimated_cost_usd",
				"id",
				"input_tokens",
				"model_used",
				"output_tokens",
				"run_id",
			].sort();

			expect(actual).toEqual(expected);
		});
	});

	describe("MailStore", () => {
		test("messages table columns match MessageRow interface", () => {
			const dbPath = join(tmpDir, "mail.db");
			const store = createMailStore(dbPath);

			const db = new Database(dbPath, { readonly: true });
			const actual = getTableColumns(db, "messages");
			db.close();
			store.close();

			// Columns from MessageRow interface in src/mail/store.ts
			const expected = [
				"body",
				"created_at",
				"from_agent",
				"id",
				"payload",
				"priority",
				"read",
				"subject",
				"thread_id",
				"to_agent",
				"type",
			].sort();

			expect(actual).toEqual(expected);
		});
	});

	describe("MergeQueue", () => {
		test("merge_queue table columns match MergeQueueRow interface", () => {
			const dbPath = join(tmpDir, "merge-queue.db");
			const queue = createMergeQueue(dbPath);

			const db = new Database(dbPath, { readonly: true });
			const actual = getTableColumns(db, "merge_queue");
			db.close();
			queue.close();

			// Columns from MergeQueueRow interface in src/merge/queue.ts
			const expected = [
				"agent_name",
				"branch_name",
				"enqueued_at",
				"files_modified",
				"id",
				"resolved_tier",
				"status",
				"task_id",
			].sort();

			expect(actual).toEqual(expected);
		});
	});
});

/**
 * SQLite-backed FIFO merge queue for agent branches.
 *
 * Backed by a SQLite database with WAL mode for concurrent access.
 * Uses bun:sqlite for zero-dependency, synchronous database access.
 * FIFO ordering guaranteed via autoincrement id.
 */

import { Database } from "bun:sqlite";
import { MergeError } from "../errors.ts";
import type { MergeEntry, ResolutionTier } from "../types.ts";

export interface MergeQueue {
	/** Add a new entry to the end of the queue with pending status. */
	enqueue(entry: Omit<MergeEntry, "enqueuedAt" | "status" | "resolvedTier">): MergeEntry;

	/** Remove and return the first pending entry, or null if none. */
	dequeue(): MergeEntry | null;

	/** Return the first pending entry without removing it, or null if none. */
	peek(): MergeEntry | null;

	/** List entries, optionally filtered by status. */
	list(status?: MergeEntry["status"]): MergeEntry[];

	/** Update the status (and optional resolution tier) of an entry by branch name. */
	updateStatus(branchName: string, status: MergeEntry["status"], tier?: ResolutionTier): void;

	/** Close the database connection. */
	close(): void;
}

/** Row shape as stored in SQLite (snake_case columns). */
interface MergeQueueRow {
	id: number;
	branch_name: string;
	bead_id: string;
	agent_name: string;
	files_modified: string; // JSON array stored as text
	enqueued_at: string;
	status: string;
	resolved_tier: string | null;
}

const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS merge_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  branch_name TEXT NOT NULL,
  bead_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  files_modified TEXT NOT NULL DEFAULT '[]',
  enqueued_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','merging','merged','conflict','failed')),
  resolved_tier TEXT
    CHECK(resolved_tier IS NULL OR resolved_tier IN ('clean-merge','auto-resolve','ai-resolve','reimagine'))
)`;

const CREATE_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_merge_queue_status ON merge_queue(status);
CREATE INDEX IF NOT EXISTS idx_merge_queue_branch ON merge_queue(branch_name)`;

/** Convert a database row (snake_case) to a MergeEntry object (camelCase). */
function rowToEntry(row: MergeQueueRow): MergeEntry {
	// Parse files_modified from JSON string to array, with fallback to empty array
	let filesModified: string[] = [];
	try {
		const parsed = JSON.parse(row.files_modified);
		filesModified = Array.isArray(parsed) ? parsed : [];
	} catch {
		// Fallback to empty array on parse error
		filesModified = [];
	}

	return {
		branchName: row.branch_name,
		beadId: row.bead_id,
		agentName: row.agent_name,
		filesModified,
		enqueuedAt: row.enqueued_at,
		status: row.status as MergeEntry["status"],
		resolvedTier: row.resolved_tier as ResolutionTier | null,
	};
}

/**
 * Create a new MergeQueue backed by a SQLite database at the given path.
 *
 * Initializes the database with WAL mode and a 5-second busy timeout.
 * Creates the merge_queue table and indexes if they do not already exist.
 */
export function createMergeQueue(dbPath: string): MergeQueue {
	const db = new Database(dbPath);

	// Configure for concurrent access from multiple agent processes
	db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA synchronous = NORMAL");
	db.exec("PRAGMA busy_timeout = 5000");

	// Create schema
	db.exec(CREATE_TABLE);
	db.exec(CREATE_INDEXES);

	// Prepare statements for frequent operations
	const insertStmt = db.prepare<
		MergeQueueRow,
		{
			$branch_name: string;
			$bead_id: string;
			$agent_name: string;
			$files_modified: string;
			$enqueued_at: string;
		}
	>(`
		INSERT INTO merge_queue (branch_name, bead_id, agent_name, files_modified, enqueued_at)
		VALUES ($branch_name, $bead_id, $agent_name, $files_modified, $enqueued_at)
		RETURNING *
	`);

	const getFirstPendingStmt = db.prepare<MergeQueueRow, Record<string, never>>(`
		SELECT * FROM merge_queue WHERE status = 'pending' ORDER BY id ASC LIMIT 1
	`);

	const deleteByIdStmt = db.prepare<void, { $id: number }>(`
		DELETE FROM merge_queue WHERE id = $id
	`);

	const listAllStmt = db.prepare<MergeQueueRow, Record<string, never>>(`
		SELECT * FROM merge_queue ORDER BY id ASC
	`);

	const listByStatusStmt = db.prepare<MergeQueueRow, { $status: string }>(`
		SELECT * FROM merge_queue WHERE status = $status ORDER BY id ASC
	`);

	const getByBranchStmt = db.prepare<MergeQueueRow, { $branch_name: string }>(`
		SELECT * FROM merge_queue WHERE branch_name = $branch_name
	`);

	const updateStatusStmt = db.prepare<
		void,
		{
			$branch_name: string;
			$status: string;
			$resolved_tier: string | null;
		}
	>(`
		UPDATE merge_queue
		SET status = $status, resolved_tier = $resolved_tier
		WHERE branch_name = $branch_name
	`);

	return {
		enqueue(input): MergeEntry {
			const filesModifiedJson = JSON.stringify(input.filesModified);
			const enqueuedAt = new Date().toISOString();

			const row = insertStmt.get({
				$branch_name: input.branchName,
				$bead_id: input.beadId,
				$agent_name: input.agentName,
				$files_modified: filesModifiedJson,
				$enqueued_at: enqueuedAt,
			});

			if (row === null || row === undefined) {
				throw new MergeError("Failed to insert entry into merge queue");
			}

			return rowToEntry(row);
		},

		dequeue(): MergeEntry | null {
			const row = getFirstPendingStmt.get({});

			if (row === null || row === undefined) {
				return null;
			}

			// Delete the entry
			deleteByIdStmt.run({ $id: row.id });

			return rowToEntry(row);
		},

		peek(): MergeEntry | null {
			const row = getFirstPendingStmt.get({});

			if (row === null || row === undefined) {
				return null;
			}

			return rowToEntry(row);
		},

		list(status?): MergeEntry[] {
			let rows: MergeQueueRow[];

			if (status === undefined) {
				rows = listAllStmt.all({});
			} else {
				rows = listByStatusStmt.all({ $status: status });
			}

			return rows.map(rowToEntry);
		},

		updateStatus(branchName, status, tier?): void {
			// Check if entry exists
			const existing = getByBranchStmt.get({ $branch_name: branchName });

			if (existing === null || existing === undefined) {
				throw new MergeError(`No queue entry found for branch: ${branchName}`, {
					branchName,
				});
			}

			// Update the entry
			updateStatusStmt.run({
				$branch_name: branchName,
				$status: status,
				$resolved_tier: tier ?? null,
			});
		},

		close(): void {
			db.exec("PRAGMA wal_checkpoint(PASSIVE)");
			db.close();
		},
	};
}

/**
 * SQLite-backed event store for agent activity observability.
 *
 * Tracks tool invocations, session lifecycle, mail events, and errors.
 * Uses bun:sqlite for zero-dependency, synchronous database access.
 * WAL mode enables concurrent reads from multiple agent processes.
 */

import { Database } from "bun:sqlite";
import type {
	EventLevel,
	EventQueryOptions,
	EventStore,
	InsertEvent,
	StoredEvent,
	ToolStats,
} from "../types.ts";

/** EventQueryOptions extended with optional project_id filter. */
export interface EventQueryOptionsWithProject extends EventQueryOptions {
	projectId?: string;
}

/** Row shape as stored in SQLite (snake_case columns). */
interface EventRow {
	id: number;
	run_id: string | null;
	agent_name: string;
	session_id: string | null;
	event_type: string;
	tool_name: string | null;
	tool_args: string | null;
	tool_duration_ms: number | null;
	level: string;
	data: string | null;
	created_at: string;
	project_id: string;
}

const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT,
  agent_name TEXT NOT NULL,
  session_id TEXT,
  event_type TEXT NOT NULL,
  tool_name TEXT,
  tool_args TEXT,
  tool_duration_ms INTEGER,
  level TEXT NOT NULL DEFAULT 'info' CHECK(level IN ('debug','info','warn','error')),
  data TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now')),
  project_id TEXT NOT NULL DEFAULT '_default'
)`;

const CREATE_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_events_agent_time ON events(agent_name, created_at);
CREATE INDEX IF NOT EXISTS idx_events_run_time ON events(run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_events_type_time ON events(event_type, created_at);
CREATE INDEX IF NOT EXISTS idx_events_tool_agent ON events(tool_name, agent_name);
CREATE INDEX IF NOT EXISTS idx_events_level_error ON events(level) WHERE level = 'error';
CREATE INDEX IF NOT EXISTS idx_events_project_time ON events(project_id, created_at)`;

/**
 * Migrate an existing events table to the current schema.
 *
 * Uses PRAGMA table_info to check for missing columns and adds them
 * via ALTER TABLE. This is idempotent — safe to run on an already-migrated DB.
 */
function migrateSchema(db: Database): void {
	const tableInfo = db.prepare<{ name: string }, []>("PRAGMA table_info(events)").all();
	if (tableInfo.length === 0) {
		// Table doesn't exist yet; CREATE TABLE IF NOT EXISTS will handle it
		return;
	}
	const hasProjectId = tableInfo.some((col: { name: string }) => col.name === "project_id");
	if (!hasProjectId) {
		db.exec("ALTER TABLE events ADD COLUMN project_id TEXT NOT NULL DEFAULT '_default'");
	}
}

/** Convert a database row (snake_case) to a StoredEvent object (camelCase). */
function rowToEvent(row: EventRow): StoredEvent {
	return {
		id: row.id,
		runId: row.run_id,
		agentName: row.agent_name,
		sessionId: row.session_id,
		eventType: row.event_type as StoredEvent["eventType"],
		toolName: row.tool_name,
		toolArgs: row.tool_args,
		toolDurationMs: row.tool_duration_ms,
		level: row.level as EventLevel,
		data: row.data,
		createdAt: row.created_at,
		projectId: row.project_id,
	};
}

/** Build WHERE clause fragments and params from EventQueryOptionsWithProject. */
function buildFilterClauses(
	opts: EventQueryOptionsWithProject | undefined,
	existingConditions: string[] = [],
	existingParams: Record<string, string | number> = {},
): { whereClause: string; params: Record<string, string | number>; limitClause: string } {
	const conditions = [...existingConditions];
	const params = { ...existingParams };

	if (opts?.since !== undefined) {
		conditions.push("created_at >= $since");
		params.$since = opts.since;
	}
	if (opts?.until !== undefined) {
		conditions.push("created_at <= $until");
		params.$until = opts.until;
	}
	if (opts?.level !== undefined) {
		conditions.push("level = $level");
		params.$level = opts.level;
	}
	if (opts?.projectId !== undefined) {
		conditions.push("project_id = $project_id");
		params.$project_id = opts.projectId;
	}

	const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
	const limitClause = opts?.limit !== undefined ? `LIMIT ${opts.limit}` : "";

	return { whereClause, params, limitClause };
}

/** EventStore interface extended with project_id support at the store level. */
export interface EventStoreWithProject extends EventStore {
	insert(event: InsertEvent): number;
	getByAgent(agentName: string, opts?: EventQueryOptionsWithProject): StoredEvent[];
	getByRun(runId: string, opts?: EventQueryOptionsWithProject): StoredEvent[];
	getErrors(opts?: EventQueryOptionsWithProject): StoredEvent[];
	getTimeline(opts: EventQueryOptionsWithProject & { since: string }): StoredEvent[];
}

/**
 * Create a new EventStore backed by a SQLite database at the given path.
 *
 * Initializes the database with WAL mode and a 5-second busy timeout.
 * Creates the events table and indexes if they do not already exist.
 */
export function createEventStore(dbPath: string): EventStoreWithProject {
	const db = new Database(dbPath);

	// Configure for concurrent access from multiple agent processes.
	db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA synchronous = NORMAL");
	db.exec("PRAGMA busy_timeout = 5000");

	// Migrate existing tables to current schema (no-op if already up to date)
	migrateSchema(db);

	// Create schema
	db.exec(CREATE_TABLE);
	db.exec(CREATE_INDEXES);

	// Prepare the insert statement
	const insertStmt = db.prepare<
		{ id: number },
		{
			$run_id: string | null;
			$agent_name: string;
			$session_id: string | null;
			$event_type: string;
			$tool_name: string | null;
			$tool_args: string | null;
			$tool_duration_ms: number | null;
			$level: string;
			$data: string | null;
			$project_id: string;
		}
	>(`
		INSERT INTO events
			(run_id, agent_name, session_id, event_type, tool_name, tool_args, tool_duration_ms, level, data, project_id)
		VALUES
			($run_id, $agent_name, $session_id, $event_type, $tool_name, $tool_args, $tool_duration_ms, $level, $data, $project_id)
		RETURNING id
	`);

	// Prepare correlateToolEnd: find the most recent tool_start for this agent+tool
	// that has no corresponding tool_end yet (no tool_duration_ms set).
	const correlateStmt = db.prepare<
		{ id: number; created_at: string },
		{ $agent_name: string; $tool_name: string }
	>(`
		SELECT id, created_at FROM events
		WHERE agent_name = $agent_name
		  AND tool_name = $tool_name
		  AND event_type = 'tool_start'
		  AND tool_duration_ms IS NULL
		ORDER BY created_at DESC
		LIMIT 1
	`);

	const updateDurationStmt = db.prepare<void, { $id: number; $duration_ms: number }>(`
		UPDATE events SET tool_duration_ms = $duration_ms WHERE id = $id
	`);

	// Prepare getByAgent
	const byAgentStmt = db.prepare<EventRow, { $agent_name: string }>(`
		SELECT * FROM events WHERE agent_name = $agent_name ORDER BY created_at ASC
	`);

	// Prepare getByRun
	const byRunStmt = db.prepare<EventRow, { $run_id: string }>(`
		SELECT * FROM events WHERE run_id = $run_id ORDER BY created_at ASC
	`);

	return {
		insert(event: InsertEvent): number {
			const row = insertStmt.get({
				$run_id: event.runId,
				$agent_name: event.agentName,
				$session_id: event.sessionId,
				$event_type: event.eventType,
				$tool_name: event.toolName,
				$tool_args: event.toolArgs,
				$tool_duration_ms: event.toolDurationMs,
				$level: event.level,
				$data: event.data,
				$project_id: event.projectId ?? "_default",
			});
			// RETURNING id always returns a row for INSERT; if somehow null, fallback to 0
			if (!row) {
				return 0;
			}
			return row.id;
		},

		correlateToolEnd(
			agentName: string,
			toolName: string,
		): { startId: number; durationMs: number } | null {
			const startRow = correlateStmt.get({
				$agent_name: agentName,
				$tool_name: toolName,
			});

			if (!startRow) {
				return null;
			}

			const startTime = new Date(startRow.created_at).getTime();
			const durationMs = Date.now() - startTime;

			// Mark the start event with the computed duration
			updateDurationStmt.run({
				$id: startRow.id,
				$duration_ms: durationMs,
			});

			return { startId: startRow.id, durationMs };
		},

		getByAgent(agentName: string, opts?: EventQueryOptionsWithProject): StoredEvent[] {
			if (
				opts !== undefined &&
				(opts.since !== undefined ||
					opts.until !== undefined ||
					opts.level !== undefined ||
					opts.limit !== undefined ||
					opts.projectId !== undefined)
			) {
				// Use dynamic query with filters
				const { whereClause, params, limitClause } = buildFilterClauses(
					opts,
					["agent_name = $agent_name"],
					{ $agent_name: agentName },
				);
				const query = `SELECT * FROM events ${whereClause} ORDER BY created_at ASC ${limitClause}`;
				const rows = db.prepare<EventRow, Record<string, string | number>>(query).all(params);
				return rows.map(rowToEvent);
			}
			const rows = byAgentStmt.all({ $agent_name: agentName });
			return rows.map(rowToEvent);
		},

		getByRun(runId: string, opts?: EventQueryOptionsWithProject): StoredEvent[] {
			if (
				opts !== undefined &&
				(opts.since !== undefined ||
					opts.until !== undefined ||
					opts.level !== undefined ||
					opts.limit !== undefined ||
					opts.projectId !== undefined)
			) {
				const { whereClause, params, limitClause } = buildFilterClauses(
					opts,
					["run_id = $run_id"],
					{ $run_id: runId },
				);
				const query = `SELECT * FROM events ${whereClause} ORDER BY created_at ASC ${limitClause}`;
				const rows = db.prepare<EventRow, Record<string, string | number>>(query).all(params);
				return rows.map(rowToEvent);
			}
			const rows = byRunStmt.all({ $run_id: runId });
			return rows.map(rowToEvent);
		},

		getErrors(opts?: EventQueryOptionsWithProject): StoredEvent[] {
			const { whereClause, params, limitClause } = buildFilterClauses(opts, ["level = 'error'"]);
			const query = `SELECT * FROM events ${whereClause} ORDER BY created_at DESC ${limitClause}`;
			const rows = db.prepare<EventRow, Record<string, string | number>>(query).all(params);
			return rows.map(rowToEvent);
		},

		getTimeline(opts: EventQueryOptionsWithProject & { since: string }): StoredEvent[] {
			const { whereClause, params, limitClause } = buildFilterClauses(opts);
			const query = `SELECT * FROM events ${whereClause} ORDER BY created_at ASC ${limitClause}`;
			const rows = db.prepare<EventRow, Record<string, string | number>>(query).all(params);
			return rows.map(rowToEvent);
		},

		getToolStats(opts?: { agentName?: string; since?: string }): ToolStats[] {
			const conditions: string[] = ["tool_name IS NOT NULL", "event_type = 'tool_start'"];
			const params: Record<string, string> = {};

			if (opts?.agentName !== undefined) {
				conditions.push("agent_name = $agent_name");
				params.$agent_name = opts.agentName;
			}
			if (opts?.since !== undefined) {
				conditions.push("created_at >= $since");
				params.$since = opts.since;
			}

			const whereClause = `WHERE ${conditions.join(" AND ")}`;
			const query = `
				SELECT
					tool_name,
					COUNT(*) AS count,
					COALESCE(AVG(tool_duration_ms), 0) AS avg_duration_ms,
					COALESCE(MAX(tool_duration_ms), 0) AS max_duration_ms
				FROM events
				${whereClause}
				GROUP BY tool_name
				ORDER BY count DESC
			`;
			const rows = db
				.prepare<
					{
						tool_name: string;
						count: number;
						avg_duration_ms: number;
						max_duration_ms: number;
					},
					Record<string, string>
				>(query)
				.all(params);

			return rows.map((row) => ({
				toolName: row.tool_name,
				count: row.count,
				avgDurationMs: row.avg_duration_ms,
				maxDurationMs: row.max_duration_ms,
			}));
		},

		purge(opts: { all?: boolean; olderThanMs?: number; agentName?: string }): number {
			if (opts.all) {
				const countRow = db
					.prepare<{ cnt: number }, []>("SELECT COUNT(*) as cnt FROM events")
					.get();
				const count = countRow?.cnt ?? 0;
				db.prepare("DELETE FROM events").run();
				return count;
			}

			const conditions: string[] = [];
			const params: Record<string, string> = {};

			if (opts.olderThanMs !== undefined) {
				const cutoff = new Date(Date.now() - opts.olderThanMs).toISOString();
				conditions.push("created_at < $cutoff");
				params.$cutoff = cutoff;
			}

			if (opts.agentName !== undefined) {
				conditions.push("agent_name = $agent_name");
				params.$agent_name = opts.agentName;
			}

			if (conditions.length === 0) {
				return 0;
			}

			const whereClause = conditions.join(" AND ");
			const countRow = db
				.prepare<{ cnt: number }, Record<string, string>>(
					`SELECT COUNT(*) as cnt FROM events WHERE ${whereClause}`,
				)
				.get(params);
			const count = countRow?.cnt ?? 0;

			db.prepare<void, Record<string, string>>(`DELETE FROM events WHERE ${whereClause}`).run(
				params,
			);

			return count;
		},

		close(): void {
			try {
				db.exec("PRAGMA wal_checkpoint(PASSIVE)");
			} catch {
				// Best effort -- checkpoint failure is non-fatal
			}
			db.close();
		},
	};
}

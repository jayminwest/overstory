/**
 * SQLite-backed metrics storage for agent session data.
 *
 * Uses bun:sqlite for zero-dependency, synchronous database access.
 * All operations are sync — no async/await needed.
 */

import { Database } from "bun:sqlite";
import type { SessionMetrics, TokenSnapshot } from "../types.ts";

export interface MetricsStore {
	recordSession(metrics: SessionMetrics, projectId?: string): void;
	getRecentSessions(limit?: number, projectId?: string): SessionMetrics[];
	getSessionsByAgent(agentName: string, projectId?: string): SessionMetrics[];
	getSessionsByRun(runId: string, projectId?: string): SessionMetrics[];
	getSessionsByTask(taskId: string, projectId?: string): SessionMetrics[];
	getAverageDuration(capability?: string, projectId?: string): number;
	/** Count the total number of sessions in the database (no limit cap). */
	countSessions(projectId?: string): number;
	/** Delete metrics matching the given criteria. Returns the number of rows deleted. */
	purge(options: { all?: boolean; agent?: string }): number;
	/** Record a token usage snapshot for a running agent. */
	recordSnapshot(snapshot: TokenSnapshot, projectId?: string): void;
	/** Get the most recent snapshot per active agent (one row per agent). */
	getLatestSnapshots(projectId?: string): TokenSnapshot[];
	/** Get the timestamp of the most recent snapshot for an agent, or null. */
	getLatestSnapshotTime(agentName: string, projectId?: string): string | null;
	/** Delete snapshots matching criteria. Returns number of rows deleted. */
	purgeSnapshots(options: { all?: boolean; agent?: string; olderThanMs?: number }): number;
	close(): void;
}

/** Row shape as stored in SQLite (snake_case columns). */
interface SessionRow {
	project_id: string;
	agent_name: string;
	task_id: string;
	capability: string;
	started_at: string;
	completed_at: string | null;
	duration_ms: number;
	exit_code: number | null;
	merge_result: string | null;
	parent_agent: string | null;
	input_tokens: number;
	output_tokens: number;
	cache_read_tokens: number;
	cache_creation_tokens: number;
	estimated_cost_usd: number | null;
	model_used: string | null;
	run_id: string | null;
}

/** Snapshot row shape as stored in SQLite (snake_case columns). */
interface SnapshotRow {
	id: number;
	project_id: string;
	agent_name: string;
	input_tokens: number;
	output_tokens: number;
	cache_read_tokens: number;
	cache_creation_tokens: number;
	estimated_cost_usd: number | null;
	model_used: string | null;
	created_at: string;
}

const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS sessions (
  project_id TEXT NOT NULL DEFAULT '_default',
  agent_name TEXT NOT NULL,
  task_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  exit_code INTEGER,
  merge_result TEXT,
  parent_agent TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_cost_usd REAL,
  model_used TEXT,
  run_id TEXT,
  PRIMARY KEY (agent_name, task_id)
)`;

const CREATE_SNAPSHOTS_TABLE = `
CREATE TABLE IF NOT EXISTS token_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL DEFAULT '_default',
  agent_name TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_cost_usd REAL,
  model_used TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now'))
)`;

const CREATE_SNAPSHOTS_INDEX = `
CREATE INDEX IF NOT EXISTS idx_snapshots_agent_time
  ON token_snapshots(agent_name, created_at)
`;

/** Token columns added in the token instrumentation migration. */
const TOKEN_COLUMNS = [
	{ name: "input_tokens", ddl: "INTEGER NOT NULL DEFAULT 0" },
	{ name: "output_tokens", ddl: "INTEGER NOT NULL DEFAULT 0" },
	{ name: "cache_read_tokens", ddl: "INTEGER NOT NULL DEFAULT 0" },
	{ name: "cache_creation_tokens", ddl: "INTEGER NOT NULL DEFAULT 0" },
	{ name: "estimated_cost_usd", ddl: "REAL" },
	{ name: "model_used", ddl: "TEXT" },
] as const;

/**
 * Migrate an existing sessions table from bead_id to task_id column.
 * Safe to call multiple times — only renames if bead_id exists and task_id does not.
 */
function migrateBeadIdToTaskId(db: Database): void {
	const rows = db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
	const existingColumns = new Set(rows.map((r) => r.name));
	if (existingColumns.has("bead_id") && !existingColumns.has("task_id")) {
		db.exec("ALTER TABLE sessions RENAME COLUMN bead_id TO task_id");
	}
}

/**
 * Migrate an existing sessions table to include the run_id column.
 * Safe to call multiple times — only adds the column if missing.
 */
function migrateRunIdColumn(db: Database): void {
	const rows = db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
	const existingColumns = new Set(rows.map((r) => r.name));
	if (!existingColumns.has("run_id")) {
		db.exec("ALTER TABLE sessions ADD COLUMN run_id TEXT");
	}
}

/**
 * Migrate an existing sessions table to include token columns.
 * Safe to call multiple times — only adds columns that are missing.
 */
function migrateTokenColumns(db: Database): void {
	const rows = db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
	const existingColumns = new Set(rows.map((r) => r.name));

	for (const col of TOKEN_COLUMNS) {
		if (!existingColumns.has(col.name)) {
			db.exec(`ALTER TABLE sessions ADD COLUMN ${col.name} ${col.ddl}`);
		}
	}
}

/**
 * Migrate the sessions table to add project_id column.
 * Safe to call multiple times — only adds if table exists and column is missing.
 */
function migrateSessionProjectIdColumn(db: Database): void {
	const rows = db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
	const existingColumns = new Set(rows.map((r) => r.name));
	if (existingColumns.size > 0 && !existingColumns.has("project_id")) {
		db.exec("ALTER TABLE sessions ADD COLUMN project_id TEXT NOT NULL DEFAULT '_default'");
	}
}

/**
 * Migrate the token_snapshots table to add project_id column.
 * Safe to call multiple times — only adds if table exists and column is missing.
 */
function migrateSnapshotProjectIdColumn(db: Database): void {
	const rows = db.prepare("PRAGMA table_info(token_snapshots)").all() as Array<{ name: string }>;
	const existingColumns = new Set(rows.map((r) => r.name));
	if (existingColumns.size > 0 && !existingColumns.has("project_id")) {
		db.exec(
			"ALTER TABLE token_snapshots ADD COLUMN project_id TEXT NOT NULL DEFAULT '_default'",
		);
	}
}

/** Convert a database row (snake_case) to a SessionMetrics object (camelCase). */
function rowToMetrics(row: SessionRow): SessionMetrics {
	return {
		projectId: row.project_id,
		agentName: row.agent_name,
		taskId: row.task_id,
		capability: row.capability,
		startedAt: row.started_at,
		completedAt: row.completed_at,
		durationMs: row.duration_ms,
		exitCode: row.exit_code,
		mergeResult: row.merge_result as SessionMetrics["mergeResult"],
		parentAgent: row.parent_agent,
		inputTokens: row.input_tokens,
		outputTokens: row.output_tokens,
		cacheReadTokens: row.cache_read_tokens,
		cacheCreationTokens: row.cache_creation_tokens,
		estimatedCostUsd: row.estimated_cost_usd,
		modelUsed: row.model_used,
		runId: row.run_id,
	};
}

/** Convert a database snapshot row (snake_case) to a TokenSnapshot object (camelCase). */
function rowToSnapshot(row: SnapshotRow): TokenSnapshot {
	return {
		projectId: row.project_id,
		agentName: row.agent_name,
		inputTokens: row.input_tokens,
		outputTokens: row.output_tokens,
		cacheReadTokens: row.cache_read_tokens,
		cacheCreationTokens: row.cache_creation_tokens,
		estimatedCostUsd: row.estimated_cost_usd,
		modelUsed: row.model_used,
		createdAt: row.created_at,
	};
}

/**
 * Create a new MetricsStore backed by a SQLite database at the given path.
 *
 * Initializes the database with WAL mode and a 5-second busy timeout.
 * Creates the sessions table if it does not already exist.
 * Migrates existing tables to add token columns and project_id if missing.
 */
export function createMetricsStore(dbPath: string): MetricsStore {
	const db = new Database(dbPath);

	// Configure for concurrent access
	db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA busy_timeout = 5000");

	// Create schema
	db.exec(CREATE_TABLE);
	db.exec(CREATE_SNAPSHOTS_TABLE);
	db.exec(CREATE_SNAPSHOTS_INDEX);

	// Migrate: rename bead_id → task_id, add token columns, run_id, and project_id to existing tables
	migrateBeadIdToTaskId(db);
	migrateTokenColumns(db);
	migrateRunIdColumn(db);
	migrateSessionProjectIdColumn(db);
	migrateSnapshotProjectIdColumn(db);

	// Prepare statements for all queries
	const insertStmt = db.prepare<
		void,
		{
			$project_id: string;
			$agent_name: string;
			$task_id: string;
			$capability: string;
			$started_at: string;
			$completed_at: string | null;
			$duration_ms: number;
			$exit_code: number | null;
			$merge_result: string | null;
			$parent_agent: string | null;
			$input_tokens: number;
			$output_tokens: number;
			$cache_read_tokens: number;
			$cache_creation_tokens: number;
			$estimated_cost_usd: number | null;
			$model_used: string | null;
			$run_id: string | null;
		}
	>(`
		INSERT OR REPLACE INTO sessions
			(project_id, agent_name, task_id, capability, started_at, completed_at, duration_ms, exit_code, merge_result, parent_agent, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, estimated_cost_usd, model_used, run_id)
		VALUES
			($project_id, $agent_name, $task_id, $capability, $started_at, $completed_at, $duration_ms, $exit_code, $merge_result, $parent_agent, $input_tokens, $output_tokens, $cache_read_tokens, $cache_creation_tokens, $estimated_cost_usd, $model_used, $run_id)
	`);

	const recentStmt = db.prepare<SessionRow, { $limit: number }>(`
		SELECT * FROM sessions ORDER BY started_at DESC LIMIT $limit
	`);

	const byAgentStmt = db.prepare<SessionRow, { $agent_name: string }>(`
		SELECT * FROM sessions WHERE agent_name = $agent_name ORDER BY started_at DESC
	`);

	const byRunStmt = db.prepare<SessionRow, { $run_id: string }>(`
		SELECT * FROM sessions WHERE run_id = $run_id ORDER BY started_at DESC
	`);

	const byTaskStmt = db.prepare<SessionRow, { $task_id: string }>(`
		SELECT * FROM sessions WHERE task_id = $task_id ORDER BY started_at DESC
	`);

	const avgDurationAllStmt = db.prepare<{ avg_duration: number | null }, Record<string, never>>(`
		SELECT AVG(duration_ms) AS avg_duration FROM sessions WHERE completed_at IS NOT NULL
	`);

	const countSessionsStmt = db.prepare<{ cnt: number }, Record<string, never>>(`
		SELECT COUNT(*) as cnt FROM sessions
	`);

	const avgDurationByCapStmt = db.prepare<
		{ avg_duration: number | null },
		{ $capability: string }
	>(`
		SELECT AVG(duration_ms) AS avg_duration FROM sessions
		WHERE completed_at IS NOT NULL AND capability = $capability
	`);

	// Snapshot prepared statements
	const insertSnapshotStmt = db.prepare<
		void,
		{
			$project_id: string;
			$agent_name: string;
			$input_tokens: number;
			$output_tokens: number;
			$cache_read_tokens: number;
			$cache_creation_tokens: number;
			$estimated_cost_usd: number | null;
			$model_used: string | null;
			$created_at: string;
		}
	>(`
		INSERT INTO token_snapshots
			(project_id, agent_name, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, estimated_cost_usd, model_used, created_at)
		VALUES
			($project_id, $agent_name, $input_tokens, $output_tokens, $cache_read_tokens, $cache_creation_tokens, $estimated_cost_usd, $model_used, $created_at)
	`);

	const latestSnapshotsStmt = db.prepare<SnapshotRow, Record<string, never>>(`
		SELECT s.*
		FROM token_snapshots s
		INNER JOIN (
			SELECT agent_name, MAX(created_at) as max_created_at
			FROM token_snapshots
			GROUP BY agent_name
		) latest ON s.agent_name = latest.agent_name AND s.created_at = latest.max_created_at
	`);

	const latestSnapshotTimeStmt = db.prepare<
		{ created_at: string } | null,
		{ $agent_name: string }
	>(`
		SELECT MAX(created_at) as created_at
		FROM token_snapshots
		WHERE agent_name = $agent_name
	`);

	return {
		recordSession(metrics: SessionMetrics, projectId = "_default"): void {
			const effectiveProjectId = projectId ?? metrics.projectId ?? "_default";
			insertStmt.run({
				$project_id: effectiveProjectId,
				$agent_name: metrics.agentName,
				$task_id: metrics.taskId,
				$capability: metrics.capability,
				$started_at: metrics.startedAt,
				$completed_at: metrics.completedAt,
				$duration_ms: metrics.durationMs,
				$exit_code: metrics.exitCode,
				$merge_result: metrics.mergeResult,
				$parent_agent: metrics.parentAgent,
				$input_tokens: metrics.inputTokens,
				$output_tokens: metrics.outputTokens,
				$cache_read_tokens: metrics.cacheReadTokens,
				$cache_creation_tokens: metrics.cacheCreationTokens,
				$estimated_cost_usd: metrics.estimatedCostUsd,
				$model_used: metrics.modelUsed,
				$run_id: metrics.runId,
			});
		},

		getRecentSessions(limit = 20, projectId?: string): SessionMetrics[] {
			if (projectId !== undefined) {
				const rows = db
					.prepare<SessionRow, { $limit: number; $project_id: string }>(
						"SELECT * FROM sessions WHERE project_id = $project_id ORDER BY started_at DESC LIMIT $limit",
					)
					.all({ $limit: limit, $project_id: projectId });
				return rows.map(rowToMetrics);
			}
			const rows = recentStmt.all({ $limit: limit });
			return rows.map(rowToMetrics);
		},

		getSessionsByAgent(agentName: string, projectId?: string): SessionMetrics[] {
			if (projectId !== undefined) {
				const rows = db
					.prepare<SessionRow, { $agent_name: string; $project_id: string }>(
						`SELECT * FROM sessions WHERE agent_name = $agent_name
						AND project_id = $project_id ORDER BY started_at DESC`,
					)
					.all({ $agent_name: agentName, $project_id: projectId });
				return rows.map(rowToMetrics);
			}
			const rows = byAgentStmt.all({ $agent_name: agentName });
			return rows.map(rowToMetrics);
		},

		getSessionsByRun(runId: string, projectId?: string): SessionMetrics[] {
			if (projectId !== undefined) {
				const rows = db
					.prepare<SessionRow, { $run_id: string; $project_id: string }>(
						`SELECT * FROM sessions WHERE run_id = $run_id
						AND project_id = $project_id ORDER BY started_at DESC`,
					)
					.all({ $run_id: runId, $project_id: projectId });
				return rows.map(rowToMetrics);
			}
			const rows = byRunStmt.all({ $run_id: runId });
			return rows.map(rowToMetrics);
		},

		getSessionsByTask(taskId: string, projectId?: string): SessionMetrics[] {
			if (projectId !== undefined) {
				const rows = db
					.prepare<SessionRow, { $task_id: string; $project_id: string }>(
						`SELECT * FROM sessions WHERE task_id = $task_id
						AND project_id = $project_id ORDER BY started_at DESC`,
					)
					.all({ $task_id: taskId, $project_id: projectId });
				return rows.map(rowToMetrics);
			}
			const rows = byTaskStmt.all({ $task_id: taskId });
			return rows.map(rowToMetrics);
		},

		getAverageDuration(capability?: string, projectId?: string): number {
			if (capability !== undefined && projectId !== undefined) {
				const row = db
					.prepare<
						{ avg_duration: number | null },
						{ $capability: string; $project_id: string }
					>(
						`SELECT AVG(duration_ms) AS avg_duration FROM sessions
						WHERE completed_at IS NOT NULL AND capability = $capability
						AND project_id = $project_id`,
					)
					.get({ $capability: capability, $project_id: projectId });
				return row?.avg_duration ?? 0;
			}
			if (capability !== undefined) {
				const row = avgDurationByCapStmt.get({ $capability: capability });
				return row?.avg_duration ?? 0;
			}
			if (projectId !== undefined) {
				const row = db
					.prepare<{ avg_duration: number | null }, { $project_id: string }>(
						`SELECT AVG(duration_ms) AS avg_duration FROM sessions
						WHERE completed_at IS NOT NULL AND project_id = $project_id`,
					)
					.get({ $project_id: projectId });
				return row?.avg_duration ?? 0;
			}
			const row = avgDurationAllStmt.get({});
			return row?.avg_duration ?? 0;
		},

		countSessions(projectId?: string): number {
			if (projectId !== undefined) {
				const row = db
					.prepare<{ cnt: number }, { $project_id: string }>(
						"SELECT COUNT(*) as cnt FROM sessions WHERE project_id = $project_id",
					)
					.get({ $project_id: projectId });
				return row?.cnt ?? 0;
			}
			const row = countSessionsStmt.get();
			return row?.cnt ?? 0;
		},

		purge(options: { all?: boolean; agent?: string }): number {
			if (options.all) {
				const countRow = db
					.prepare<{ cnt: number }, []>("SELECT COUNT(*) as cnt FROM sessions")
					.get();
				const count = countRow?.cnt ?? 0;
				db.prepare("DELETE FROM sessions").run();
				return count;
			}

			if (options.agent !== undefined) {
				const countRow = db
					.prepare<{ cnt: number }, { $agent: string }>(
						"SELECT COUNT(*) as cnt FROM sessions WHERE agent_name = $agent",
					)
					.get({ $agent: options.agent });
				const count = countRow?.cnt ?? 0;
				db.prepare<void, { $agent: string }>("DELETE FROM sessions WHERE agent_name = $agent").run({
					$agent: options.agent,
				});
				return count;
			}

			return 0;
		},

		recordSnapshot(snapshot: TokenSnapshot, projectId = "_default"): void {
			const effectiveProjectId = projectId ?? snapshot.projectId ?? "_default";
			insertSnapshotStmt.run({
				$project_id: effectiveProjectId,
				$agent_name: snapshot.agentName,
				$input_tokens: snapshot.inputTokens,
				$output_tokens: snapshot.outputTokens,
				$cache_read_tokens: snapshot.cacheReadTokens,
				$cache_creation_tokens: snapshot.cacheCreationTokens,
				$estimated_cost_usd: snapshot.estimatedCostUsd,
				$model_used: snapshot.modelUsed,
				$created_at: snapshot.createdAt,
			});
		},

		getLatestSnapshots(projectId?: string): TokenSnapshot[] {
			if (projectId !== undefined) {
				const rows = db
					.prepare<SnapshotRow, { $project_id: string }>(
						`SELECT s.*
						FROM token_snapshots s
						INNER JOIN (
							SELECT agent_name, MAX(created_at) as max_created_at
							FROM token_snapshots
							WHERE project_id = $project_id
							GROUP BY agent_name
						) latest ON s.agent_name = latest.agent_name AND s.created_at = latest.max_created_at
						WHERE s.project_id = $project_id`,
					)
					.all({ $project_id: projectId });
				return rows.map(rowToSnapshot);
			}
			const rows = latestSnapshotsStmt.all({});
			return rows.map(rowToSnapshot);
		},

		getLatestSnapshotTime(agentName: string, projectId?: string): string | null {
			if (projectId !== undefined) {
				const row = db
					.prepare<
						{ created_at: string } | null,
						{ $agent_name: string; $project_id: string }
					>(
						`SELECT MAX(created_at) as created_at FROM token_snapshots
						WHERE agent_name = $agent_name AND project_id = $project_id`,
					)
					.get({ $agent_name: agentName, $project_id: projectId });
				return row?.created_at ?? null;
			}
			const row = latestSnapshotTimeStmt.get({ $agent_name: agentName });
			return row?.created_at ?? null;
		},

		purgeSnapshots(options: { all?: boolean; agent?: string; olderThanMs?: number }): number {
			if (options.all) {
				const countRow = db
					.prepare<{ cnt: number }, []>("SELECT COUNT(*) as cnt FROM token_snapshots")
					.get();
				const count = countRow?.cnt ?? 0;
				db.prepare("DELETE FROM token_snapshots").run();
				return count;
			}

			if (options.agent !== undefined) {
				const countRow = db
					.prepare<{ cnt: number }, { $agent: string }>(
						"SELECT COUNT(*) as cnt FROM token_snapshots WHERE agent_name = $agent",
					)
					.get({ $agent: options.agent });
				const count = countRow?.cnt ?? 0;
				db.prepare<void, { $agent: string }>(
					"DELETE FROM token_snapshots WHERE agent_name = $agent",
				).run({
					$agent: options.agent,
				});
				return count;
			}

			if (options.olderThanMs !== undefined) {
				const cutoffTime = new Date(Date.now() - options.olderThanMs).toISOString();
				const countRow = db
					.prepare<{ cnt: number }, { $cutoff: string }>(
						"SELECT COUNT(*) as cnt FROM token_snapshots WHERE created_at < $cutoff",
					)
					.get({ $cutoff: cutoffTime });
				const count = countRow?.cnt ?? 0;
				db.prepare<void, { $cutoff: string }>(
					"DELETE FROM token_snapshots WHERE created_at < $cutoff",
				).run({
					$cutoff: cutoffTime,
				});
				return count;
			}

			return 0;
		},

		close(): void {
			db.close();
		},
	};
}

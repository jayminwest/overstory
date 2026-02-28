/**
 * SQLite-backed session store for agent lifecycle tracking.
 *
 * Replaces the flat-file sessions.json with a proper database.
 * Uses bun:sqlite for zero-dependency, synchronous database access.
 * WAL mode enables concurrent reads from multiple agent processes.
 */

import { Database } from "bun:sqlite";
import type { AgentSession, AgentState, InsertRun, Run, RunStatus, RunStore } from "../types.ts";

export interface SessionStore {
	/** Insert or update a session. Uses (project_id, agent_name) as the unique key. */
	upsert(session: AgentSession, projectId?: string): void;
	/** Get a session by agent name. When projectId provided, filters by both. */
	getByName(agentName: string, projectId?: string): AgentSession | null;
	/** Get all active sessions (state IN ('booting', 'working', 'stalled')). */
	getActive(projectId?: string): AgentSession[];
	/** Get all sessions regardless of state. */
	getAll(projectId?: string): AgentSession[];
	/** Get the total number of sessions. Lightweight alternative to getAll().length. */
	count(projectId?: string): number;
	/** Get sessions belonging to a specific run. */
	getByRun(runId: string, projectId?: string): AgentSession[];
	/** Update only the state of a session. */
	updateState(agentName: string, state: AgentState, projectId?: string): void;
	/** Update lastActivity to current ISO timestamp. */
	updateLastActivity(agentName: string, projectId?: string): void;
	/** Update escalation level and stalled timestamp. */
	updateEscalation(
		agentName: string,
		level: number,
		stalledSince: string | null,
		projectId?: string,
	): void;
	/** Update the transcript path for a session. */
	updateTranscriptPath(agentName: string, path: string, projectId?: string): void;
	/** Remove a session by agent name. */
	remove(agentName: string, projectId?: string): void;
	/** Purge sessions matching criteria. Returns count of deleted rows. */
	purge(opts: { all?: boolean; state?: AgentState; agent?: string }): number;
	/** Close the database connection. */
	close(): void;
}

/** Extended RunStore interface with optional project_id filtering. */
export interface RunStoreWithProjectId extends RunStore {
	createRun(run: InsertRun, projectId?: string): void;
	getActiveRun(projectId?: string): Run | null;
	listRuns(opts?: { limit?: number; status?: RunStatus; projectId?: string }): Run[];
}

/** Row shape as stored in SQLite (snake_case columns). */
interface SessionRow {
	id: string;
	project_id: string;
	agent_name: string;
	capability: string;
	worktree_path: string;
	branch_name: string;
	task_id: string;
	tmux_session: string;
	state: string;
	pid: number | null;
	parent_agent: string | null;
	depth: number;
	run_id: string | null;
	started_at: string;
	last_activity: string;
	escalation_level: number;
	stalled_since: string | null;
	transcript_path: string | null;
}

/** Row shape for runs table as stored in SQLite (snake_case columns). */
interface RunRow {
	id: string;
	project_id: string;
	started_at: string;
	completed_at: string | null;
	agent_count: number;
	coordinator_session_id: string | null;
	status: string;
}

const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL DEFAULT '_default',
  agent_name TEXT NOT NULL,
  capability TEXT NOT NULL,
  worktree_path TEXT NOT NULL,
  branch_name TEXT NOT NULL,
  task_id TEXT NOT NULL,
  tmux_session TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'booting'
    CHECK(state IN ('booting','working','completed','stalled','zombie')),
  pid INTEGER,
  parent_agent TEXT,
  depth INTEGER NOT NULL DEFAULT 0,
  run_id TEXT,
  started_at TEXT NOT NULL,
  last_activity TEXT NOT NULL,
  escalation_level INTEGER NOT NULL DEFAULT 0,
  stalled_since TEXT,
  transcript_path TEXT,
  UNIQUE(project_id, agent_name)
)`;

const CREATE_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_sessions_state ON sessions(state);
CREATE INDEX IF NOT EXISTS idx_sessions_run ON sessions(run_id);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id)`;

const CREATE_RUNS_TABLE = `
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL DEFAULT '_default',
  started_at TEXT NOT NULL,
  completed_at TEXT,
  agent_count INTEGER NOT NULL DEFAULT 0,
  coordinator_session_id TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK(status IN ('active','completed','failed'))
)`;

const CREATE_RUNS_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status)`;

/** Convert a database row (snake_case) to an AgentSession object (camelCase). */
function rowToSession(row: SessionRow): AgentSession {
	return {
		id: row.id,
		projectId: row.project_id,
		agentName: row.agent_name,
		capability: row.capability,
		worktreePath: row.worktree_path,
		branchName: row.branch_name,
		taskId: row.task_id,
		tmuxSession: row.tmux_session,
		state: row.state as AgentState,
		pid: row.pid,
		parentAgent: row.parent_agent,
		depth: row.depth,
		runId: row.run_id,
		startedAt: row.started_at,
		lastActivity: row.last_activity,
		escalationLevel: row.escalation_level,
		stalledSince: row.stalled_since,
		transcriptPath: row.transcript_path,
	};
}

/** Convert a database row (snake_case) to a Run object (camelCase). */
function rowToRun(row: RunRow): Run {
	return {
		id: row.id,
		projectId: row.project_id,
		startedAt: row.started_at,
		completedAt: row.completed_at,
		agentCount: row.agent_count,
		coordinatorSessionId: row.coordinator_session_id,
		status: row.status as RunStatus,
	};
}

/**
 * Migrate an existing sessions table to add the transcript_path column.
 * Safe to call multiple times — only adds the column if it does not exist.
 */
function migrateAddTranscriptPath(db: Database): void {
	const rows = db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
	const existingColumns = new Set(rows.map((r) => r.name));
	if (!existingColumns.has("transcript_path")) {
		db.exec("ALTER TABLE sessions ADD COLUMN transcript_path TEXT");
	}
}

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
 * Migrate an existing sessions table to include project_id with (project_id, agent_name) uniqueness.
 * Uses rename-recreate-copy-drop pattern since SQLite cannot ALTER constraints.
 * Safe to call multiple times — skips if project_id already exists or table doesn't exist.
 */
function migrateProjectId(db: Database): void {
	const rows = db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
	const existingColumns = new Set(rows.map((r) => r.name));
	// Skip if table doesn't exist (fresh DB) or already migrated
	if (existingColumns.size === 0 || existingColumns.has("project_id")) return;
	const hasTranscriptPath = existingColumns.has("transcript_path");

	db.exec("BEGIN");
	try {
		db.exec("ALTER TABLE sessions RENAME TO sessions_old");
		db.exec(CREATE_TABLE);
		db.exec(`
			INSERT INTO sessions
				(id, project_id, agent_name, capability, worktree_path, branch_name, task_id,
				 tmux_session, state, pid, parent_agent, depth, run_id, started_at,
				 last_activity, escalation_level, stalled_since, transcript_path)
			SELECT
				id, '_default', agent_name, capability, worktree_path, branch_name, task_id,
				tmux_session, state, pid, parent_agent, depth, run_id, started_at,
				last_activity, escalation_level, stalled_since, ${hasTranscriptPath ? "transcript_path" : "NULL"}
			FROM sessions_old
		`);
		db.exec("DROP TABLE sessions_old");
		db.exec("COMMIT");
	} catch (err) {
		db.exec("ROLLBACK");
		throw err;
	}
}

/**
 * Migrate the runs table to add project_id column.
 * Safe to call multiple times — only adds if missing and table exists.
 */
function migrateRunsProjectId(db: Database): void {
	const rows = db.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>;
	const existingColumns = new Set(rows.map((r) => r.name));
	if (existingColumns.size > 0 && !existingColumns.has("project_id")) {
		db.exec("ALTER TABLE runs ADD COLUMN project_id TEXT NOT NULL DEFAULT '_default'");
	}
}

/**
 * Create a new SessionStore backed by a SQLite database at the given path.
 *
 * Initializes the database with WAL mode and a 5-second busy timeout.
 * Creates the sessions table and indexes if they do not already exist.
 */
export function createSessionStore(dbPath: string): SessionStore {
	const db = new Database(dbPath);

	// Configure for concurrent access from multiple agent processes.
	db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA synchronous = NORMAL");
	db.exec("PRAGMA busy_timeout = 5000");

	// Run migrations first (handles existing DBs with old schema)
	migrateBeadIdToTaskId(db);
	migrateProjectId(db);

	// Create schema for fresh DBs (idempotent — IF NOT EXISTS)
	db.exec(CREATE_TABLE);
	db.exec(CREATE_INDEXES);
	db.exec(CREATE_RUNS_TABLE);
	db.exec(CREATE_RUNS_INDEXES);
	// Migrate runs table project_id (for existing runs tables without it)
	migrateRunsProjectId(db);
	// Migrate transcript path (for existing sessions tables without it)
	migrateAddTranscriptPath(db);

	// Prepare statements for frequent operations
	const upsertStmt = db.prepare<
		void,
		{
			$id: string;
			$project_id: string;
			$agent_name: string;
			$capability: string;
			$worktree_path: string;
			$branch_name: string;
			$task_id: string;
			$tmux_session: string;
			$state: string;
			$pid: number | null;
			$parent_agent: string | null;
			$depth: number;
			$run_id: string | null;
			$started_at: string;
			$last_activity: string;
			$escalation_level: number;
			$stalled_since: string | null;
			$transcript_path: string | null;
		}
	>(`
		INSERT INTO sessions
			(id, project_id, agent_name, capability, worktree_path, branch_name, task_id,
			 tmux_session, state, pid, parent_agent, depth, run_id,
			 started_at, last_activity, escalation_level, stalled_since, transcript_path)
		VALUES
			($id, $project_id, $agent_name, $capability, $worktree_path, $branch_name, $task_id,
			 $tmux_session, $state, $pid, $parent_agent, $depth, $run_id,
			 $started_at, $last_activity, $escalation_level, $stalled_since, $transcript_path)
		ON CONFLICT(project_id, agent_name) DO UPDATE SET
			id = excluded.id,
			capability = excluded.capability,
			worktree_path = excluded.worktree_path,
			branch_name = excluded.branch_name,
			task_id = excluded.task_id,
			tmux_session = excluded.tmux_session,
			state = excluded.state,
			pid = excluded.pid,
			parent_agent = excluded.parent_agent,
			depth = excluded.depth,
			run_id = excluded.run_id,
			started_at = excluded.started_at,
			last_activity = excluded.last_activity,
			escalation_level = excluded.escalation_level,
			stalled_since = excluded.stalled_since,
			transcript_path = excluded.transcript_path
	`);

	const getByNameStmt = db.prepare<SessionRow, { $agent_name: string }>(`
		SELECT * FROM sessions WHERE agent_name = $agent_name LIMIT 1
	`);

	const getActiveStmt = db.prepare<SessionRow, Record<string, never>>(`
		SELECT * FROM sessions WHERE state IN ('booting', 'working', 'stalled')
		ORDER BY started_at ASC
	`);

	const getAllStmt = db.prepare<SessionRow, Record<string, never>>(`
		SELECT * FROM sessions ORDER BY started_at ASC
	`);

	const countStmt = db.prepare<{ cnt: number }, Record<string, never>>(
		"SELECT COUNT(*) as cnt FROM sessions",
	);

	const getByRunStmt = db.prepare<SessionRow, { $run_id: string }>(`
		SELECT * FROM sessions WHERE run_id = $run_id ORDER BY started_at ASC
	`);

	const updateStateStmt = db.prepare<void, { $agent_name: string; $state: string }>(`
		UPDATE sessions SET state = $state WHERE agent_name = $agent_name
	`);
	const updateStateByProjectStmt = db.prepare<
		void,
		{ $agent_name: string; $state: string; $project_id: string }
	>(`
		UPDATE sessions SET state = $state WHERE agent_name = $agent_name AND project_id = $project_id
	`);

	const updateLastActivityStmt = db.prepare<void, { $agent_name: string; $last_activity: string }>(`
		UPDATE sessions SET last_activity = $last_activity WHERE agent_name = $agent_name
	`);
	const updateLastActivityByProjectStmt = db.prepare<
		void,
		{ $agent_name: string; $last_activity: string; $project_id: string }
	>(`
		UPDATE sessions SET last_activity = $last_activity
		WHERE agent_name = $agent_name AND project_id = $project_id
	`);

	const updateEscalationStmt = db.prepare<
		void,
		{
			$agent_name: string;
			$escalation_level: number;
			$stalled_since: string | null;
		}
	>(`
		UPDATE sessions
		SET escalation_level = $escalation_level, stalled_since = $stalled_since
		WHERE agent_name = $agent_name
	`);
	const updateEscalationByProjectStmt = db.prepare<
		void,
		{
			$agent_name: string;
			$escalation_level: number;
			$stalled_since: string | null;
			$project_id: string;
		}
	>(`
		UPDATE sessions
		SET escalation_level = $escalation_level, stalled_since = $stalled_since
		WHERE agent_name = $agent_name AND project_id = $project_id
	`);

	const removeStmt = db.prepare<void, { $agent_name: string }>(`
		DELETE FROM sessions WHERE agent_name = $agent_name
	`);
	const removeByProjectStmt = db.prepare<void, { $agent_name: string; $project_id: string }>(`
		DELETE FROM sessions WHERE agent_name = $agent_name AND project_id = $project_id
	`);

	const updateTranscriptPathStmt = db.prepare<
		void,
		{ $agent_name: string; $transcript_path: string }
	>(`
		UPDATE sessions SET transcript_path = $transcript_path WHERE agent_name = $agent_name
	`);
	const updateTranscriptPathByProjectStmt = db.prepare<
		void,
		{ $agent_name: string; $transcript_path: string; $project_id: string }
	>(`
		UPDATE sessions
		SET transcript_path = $transcript_path
		WHERE agent_name = $agent_name AND project_id = $project_id
	`);

	return {
		upsert(session: AgentSession, projectId = "_default"): void {
			const effectiveProjectId = projectId ?? session.projectId ?? "_default";
			upsertStmt.run({
				$id: session.id,
				$project_id: effectiveProjectId,
				$agent_name: session.agentName,
				$capability: session.capability,
				$worktree_path: session.worktreePath,
				$branch_name: session.branchName,
				$task_id: session.taskId,
				$tmux_session: session.tmuxSession,
				$state: session.state,
				$pid: session.pid,
				$parent_agent: session.parentAgent,
				$depth: session.depth,
				$run_id: session.runId,
				$started_at: session.startedAt,
				$last_activity: session.lastActivity,
				$escalation_level: session.escalationLevel,
				$stalled_since: session.stalledSince,
				$transcript_path: session.transcriptPath,
			});
		},

		getByName(agentName: string, projectId?: string): AgentSession | null {
			if (projectId !== undefined) {
				const row = db
					.prepare<SessionRow, { $agent_name: string; $project_id: string }>(
						"SELECT * FROM sessions WHERE agent_name = $agent_name AND project_id = $project_id",
					)
					.get({ $agent_name: agentName, $project_id: projectId });
				return row ? rowToSession(row) : null;
			}
			const row = getByNameStmt.get({ $agent_name: agentName });
			return row ? rowToSession(row) : null;
		},

		getActive(projectId?: string): AgentSession[] {
			if (projectId !== undefined) {
				const rows = db
					.prepare<SessionRow, { $project_id: string }>(
						`SELECT * FROM sessions WHERE state IN ('booting', 'working', 'stalled')
						AND project_id = $project_id ORDER BY started_at ASC`,
					)
					.all({ $project_id: projectId });
				return rows.map(rowToSession);
			}
			const rows = getActiveStmt.all({});
			return rows.map(rowToSession);
		},

		getAll(projectId?: string): AgentSession[] {
			if (projectId !== undefined) {
				const rows = db
					.prepare<SessionRow, { $project_id: string }>(
						"SELECT * FROM sessions WHERE project_id = $project_id ORDER BY started_at ASC",
					)
					.all({ $project_id: projectId });
				return rows.map(rowToSession);
			}
			const rows = getAllStmt.all({});
			return rows.map(rowToSession);
		},

		count(projectId?: string): number {
			if (projectId !== undefined) {
				const row = db
					.prepare<{ cnt: number }, { $project_id: string }>(
						"SELECT COUNT(*) as cnt FROM sessions WHERE project_id = $project_id",
					)
					.get({ $project_id: projectId });
				return row?.cnt ?? 0;
			}
			const row = countStmt.get({});
			return row?.cnt ?? 0;
		},

		getByRun(runId: string, projectId?: string): AgentSession[] {
			if (projectId !== undefined) {
				const rows = db
					.prepare<SessionRow, { $run_id: string; $project_id: string }>(
						`SELECT * FROM sessions WHERE run_id = $run_id AND project_id = $project_id
						ORDER BY started_at ASC`,
					)
					.all({ $run_id: runId, $project_id: projectId });
				return rows.map(rowToSession);
			}
			const rows = getByRunStmt.all({ $run_id: runId });
			return rows.map(rowToSession);
		},

		updateState(agentName: string, state: AgentState, projectId?: string): void {
			if (projectId !== undefined) {
				updateStateByProjectStmt.run({ $agent_name: agentName, $state: state, $project_id: projectId });
			} else {
				updateStateStmt.run({ $agent_name: agentName, $state: state });
			}
		},

		updateLastActivity(agentName: string, projectId?: string): void {
			const lastActivity = new Date().toISOString();
			if (projectId !== undefined) {
				updateLastActivityByProjectStmt.run({
					$agent_name: agentName,
					$last_activity: lastActivity,
					$project_id: projectId,
				});
			} else {
				updateLastActivityStmt.run({ $agent_name: agentName, $last_activity: lastActivity });
			}
		},

		updateEscalation(
			agentName: string,
			level: number,
			stalledSince: string | null,
			projectId?: string,
		): void {
			if (projectId !== undefined) {
				updateEscalationByProjectStmt.run({
					$agent_name: agentName,
					$escalation_level: level,
					$stalled_since: stalledSince,
					$project_id: projectId,
				});
			} else {
				updateEscalationStmt.run({
					$agent_name: agentName,
					$escalation_level: level,
					$stalled_since: stalledSince,
				});
			}
		},

		updateTranscriptPath(agentName: string, path: string, projectId?: string): void {
			if (projectId !== undefined) {
				updateTranscriptPathByProjectStmt.run({
					$agent_name: agentName,
					$transcript_path: path,
					$project_id: projectId,
				});
			} else {
				updateTranscriptPathStmt.run({ $agent_name: agentName, $transcript_path: path });
			}
		},

		remove(agentName: string, projectId?: string): void {
			if (projectId !== undefined) {
				removeByProjectStmt.run({ $agent_name: agentName, $project_id: projectId });
			} else {
				removeStmt.run({ $agent_name: agentName });
			}
		},

		purge(opts: { all?: boolean; state?: AgentState; agent?: string }): number {
			if (opts.all) {
				const countRow = db
					.prepare<{ cnt: number }, []>("SELECT COUNT(*) as cnt FROM sessions")
					.get();
				const count = countRow?.cnt ?? 0;
				db.prepare("DELETE FROM sessions").run();
				return count;
			}

			const conditions: string[] = [];
			const params: Record<string, string> = {};

			if (opts.state !== undefined) {
				conditions.push("state = $state");
				params.$state = opts.state;
			}

			if (opts.agent !== undefined) {
				conditions.push("agent_name = $agent");
				params.$agent = opts.agent;
			}

			if (conditions.length === 0) {
				return 0;
			}

			const whereClause = conditions.join(" AND ");
			const countQuery = `SELECT COUNT(*) as cnt FROM sessions WHERE ${whereClause}`;
			const countRow = db.prepare<{ cnt: number }, Record<string, string>>(countQuery).get(params);
			const count = countRow?.cnt ?? 0;

			const deleteQuery = `DELETE FROM sessions WHERE ${whereClause}`;
			db.prepare<void, Record<string, string>>(deleteQuery).run(params);

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

/**
 * Create a new RunStore backed by a SQLite database at the given path.
 *
 * Shares the same sessions.db file as SessionStore. Initializes the runs
 * table alongside sessions. Uses WAL mode for concurrent access.
 */
export function createRunStore(dbPath: string): RunStoreWithProjectId {
	const db = new Database(dbPath);

	// Configure for concurrent access from multiple agent processes.
	db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA synchronous = NORMAL");
	db.exec("PRAGMA busy_timeout = 5000");

	// Create schema (idempotent — safe if SessionStore already created these)
	db.exec(CREATE_RUNS_TABLE);
	db.exec(CREATE_RUNS_INDEXES);

	// Migrate existing runs tables without project_id
	migrateRunsProjectId(db);

	// Prepare statements for frequent operations
	const insertRunStmt = db.prepare<
		void,
		{
			$id: string;
			$project_id: string;
			$started_at: string;
			$completed_at: string | null;
			$agent_count: number;
			$coordinator_session_id: string | null;
			$status: string;
		}
	>(`
		INSERT INTO runs (id, project_id, started_at, completed_at, agent_count, coordinator_session_id, status)
		VALUES ($id, $project_id, $started_at, $completed_at, $agent_count, $coordinator_session_id, $status)
	`);

	const getRunStmt = db.prepare<RunRow, { $id: string }>(`
		SELECT * FROM runs WHERE id = $id
	`);

	const getActiveRunStmt = db.prepare<RunRow, Record<string, never>>(`
		SELECT * FROM runs WHERE status = 'active'
		ORDER BY started_at DESC
		LIMIT 1
	`);

	const incrementAgentCountStmt = db.prepare<void, { $id: string }>(`
		UPDATE runs SET agent_count = agent_count + 1 WHERE id = $id
	`);

	const completeRunStmt = db.prepare<
		void,
		{ $id: string; $status: string; $completed_at: string }
	>(`
		UPDATE runs SET status = $status, completed_at = $completed_at WHERE id = $id
	`);

	return {
		createRun(run: InsertRun, projectId = "_default"): void {
			const effectiveProjectId = projectId ?? run.projectId ?? "_default";
			insertRunStmt.run({
				$id: run.id,
				$project_id: effectiveProjectId,
				$started_at: run.startedAt,
				$completed_at: null,
				$agent_count: run.agentCount ?? 0,
				$coordinator_session_id: run.coordinatorSessionId,
				$status: run.status,
			});
		},

		getRun(id: string): Run | null {
			const row = getRunStmt.get({ $id: id });
			return row ? rowToRun(row) : null;
		},

		getActiveRun(projectId?: string): Run | null {
			if (projectId !== undefined) {
				const row = db
					.prepare<RunRow, { $project_id: string }>(
						`SELECT * FROM runs WHERE status = 'active' AND project_id = $project_id
						ORDER BY started_at DESC LIMIT 1`,
					)
					.get({ $project_id: projectId });
				return row ? rowToRun(row) : null;
			}
			const row = getActiveRunStmt.get({});
			return row ? rowToRun(row) : null;
		},

		listRuns(opts?: { limit?: number; status?: RunStatus; projectId?: string }): Run[] {
			const conditions: string[] = [];
			const params: Record<string, string | number> = {};

			if (opts?.status !== undefined) {
				conditions.push("status = $status");
				params.$status = opts.status;
			}

			if (opts?.projectId !== undefined) {
				conditions.push("project_id = $project_id");
				params.$project_id = opts.projectId;
			}

			const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
			const limitClause = opts?.limit !== undefined ? `LIMIT ${opts.limit}` : "";
			const query = `SELECT * FROM runs ${whereClause} ORDER BY started_at DESC ${limitClause}`;

			const rows = db.prepare<RunRow, Record<string, string | number>>(query).all(params);
			return rows.map(rowToRun);
		},

		incrementAgentCount(runId: string): void {
			incrementAgentCountStmt.run({ $id: runId });
		},

		completeRun(runId: string, status: "completed" | "failed"): void {
			completeRunStmt.run({
				$id: runId,
				$status: status,
				$completed_at: new Date().toISOString(),
			});
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

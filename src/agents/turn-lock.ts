/**
 * Per-agent serialization lock for the spawn-per-turn engine.
 *
 * Ensures that two `runTurn` calls for the same agent never overlap. The lock
 * is layered:
 *
 * 1. **In-process layer** — a module-level `Map<agentName, Promise<void>>`
 *    chained via `.then`. Concurrent calls inside the same Bun process queue up.
 *
 * 2. **Cross-process layer** — a SQLite-backed lease at
 *    `{overstoryDir}/turn-locks.db`. Each agent has at most one row in
 *    `turn_locks(agent_name, held_by_pid, acquired_at)`. Acquire wraps the
 *    state change in `BEGIN IMMEDIATE` so two processes cannot claim the same
 *    row in the same instant. The transaction itself is short — it does not
 *    span the whole turn — so other agents' acquires are not blocked.
 *
 * Stale leases (where `held_by_pid` is no longer alive) are stolen on the
 * next acquire attempt. Both layers are released when `release()` is called.
 */

import { Database } from "bun:sqlite";
import { join } from "node:path";

/** In-process serialization tail per agent. Holds the latest queued promise. */
const inProcessTails = new Map<string, Promise<void>>();

export interface TurnLockHandle {
	readonly agentName: string;
	/** Release both layers. Idempotent. */
	release(): void;
}

export interface AcquireTurnLockOpts {
	agentName: string;
	overstoryDir: string;
	/** Process id recorded as the holder. Defaults to `process.pid`. */
	ownerPid?: number;
	/** Maximum time to wait for cross-process acquisition, in ms. Default 60_000. */
	timeoutMs?: number;
	/** Polling interval between cross-process retries when contended. Default 50ms. */
	pollMs?: number;
	/** Test injection: time source. */
	_now?: () => number;
	/** Test injection: liveness check (default uses `process.kill(pid, 0)`). */
	_isProcessAlive?: (pid: number) => boolean;
	/** Test injection: explicit DB path (overrides `{overstoryDir}/turn-locks.db`). */
	_dbPath?: string;
}

const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS turn_locks (
  agent_name TEXT PRIMARY KEY,
  held_by_pid INTEGER,
  acquired_at TEXT
)`;

/** Default cross-process database path. */
export function turnLockDbPath(overstoryDir: string): string {
	return join(overstoryDir, "turn-locks.db");
}

function defaultIsProcessAlive(pid: number): boolean {
	if (!Number.isFinite(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		// EPERM means the process exists but we lack permission to signal it.
		// Treat as alive so we don't steal an active lock.
		const code = (err as NodeJS.ErrnoException).code;
		return code === "EPERM";
	}
}

function openDb(path: string): Database {
	const db = new Database(path);
	db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA synchronous = NORMAL");
	db.exec("PRAGMA busy_timeout = 5000");
	db.exec(CREATE_TABLE);
	return db;
}

/**
 * Acquire the per-agent turn lock. Resolves once both layers are held.
 *
 * The returned handle MUST be released — failure to do so leaves a stale row
 * that future acquires will treat as held until the holder's pid expires.
 */
export async function acquireTurnLock(opts: AcquireTurnLockOpts): Promise<TurnLockHandle> {
	const { agentName, overstoryDir } = opts;
	const ownerPid = opts.ownerPid ?? process.pid;
	const now = opts._now ?? (() => Date.now());
	const isProcessAlive = opts._isProcessAlive ?? defaultIsProcessAlive;
	const dbPath = opts._dbPath ?? turnLockDbPath(overstoryDir);
	const timeoutMs = opts.timeoutMs ?? 60_000;
	const pollMs = opts.pollMs ?? 50;

	// === Layer 1: in-process serialization ===
	const previous = inProcessTails.get(agentName) ?? Promise.resolve();
	let inProcessRelease!: () => void;
	const current = new Promise<void>((resolve) => {
		inProcessRelease = resolve;
	});
	inProcessTails.set(
		agentName,
		previous.then(() => current),
	);
	await previous;

	// === Layer 2: cross-process SQLite lease ===
	const db = openDb(dbPath);
	const ensureRowStmt = db.prepare<void, { $n: string }>(
		"INSERT OR IGNORE INTO turn_locks (agent_name, held_by_pid, acquired_at) VALUES ($n, NULL, NULL)",
	);
	const selectStmt = db.prepare<
		{ held_by_pid: number | null; acquired_at: string | null },
		{ $n: string }
	>("SELECT held_by_pid, acquired_at FROM turn_locks WHERE agent_name = $n");
	const claimStmt = db.prepare<void, { $n: string; $p: number; $a: string }>(
		"UPDATE turn_locks SET held_by_pid = $p, acquired_at = $a WHERE agent_name = $n",
	);
	const releaseStmt = db.prepare<void, { $n: string; $p: number }>(
		"UPDATE turn_locks SET held_by_pid = NULL, acquired_at = NULL WHERE agent_name = $n AND held_by_pid = $p",
	);

	const tearDown = (): void => {
		try {
			db.close();
		} catch {
			// best-effort
		}
		inProcessRelease();
	};

	const deadline = now() + timeoutMs;
	let acquired = false;

	while (!acquired) {
		try {
			db.exec("BEGIN IMMEDIATE");
		} catch (err) {
			// busy_timeout exhausted — fall through to retry until our own deadline.
			if (now() >= deadline) {
				tearDown();
				throw err;
			}
			await Bun.sleep(pollMs);
			continue;
		}

		try {
			ensureRowStmt.run({ $n: agentName });
			const row = selectStmt.get({ $n: agentName });
			const held = row?.held_by_pid ?? null;
			const stale = held !== null && !isProcessAlive(held);
			if (held === null || stale || held === ownerPid) {
				claimStmt.run({
					$n: agentName,
					$p: ownerPid,
					$a: new Date(now()).toISOString(),
				});
				db.exec("COMMIT");
				acquired = true;
			} else {
				db.exec("ROLLBACK");
			}
		} catch (err) {
			try {
				db.exec("ROLLBACK");
			} catch {
				// ignore
			}
			tearDown();
			throw err;
		}

		if (!acquired) {
			if (now() >= deadline) {
				tearDown();
				throw new Error(
					`turn-lock: timed out after ${timeoutMs}ms acquiring lock for "${agentName}"`,
				);
			}
			await Bun.sleep(pollMs);
		}
	}

	let released = false;
	return {
		agentName,
		release(): void {
			if (released) return;
			released = true;
			try {
				releaseStmt.run({ $n: agentName, $p: ownerPid });
			} catch {
				// best-effort: SQL failure must not block in-process release.
			}
			try {
				db.close();
			} catch {
				// best-effort
			}
			inProcessRelease();
		},
	};
}

/** Inspect the persisted lock state. Used by tests and diagnostics. */
export function readTurnLock(
	overstoryDir: string,
	agentName: string,
	dbPath?: string,
): { heldByPid: number | null; acquiredAt: string | null } {
	const db = openDb(dbPath ?? turnLockDbPath(overstoryDir));
	try {
		const stmt = db.prepare<
			{ held_by_pid: number | null; acquired_at: string | null },
			{ $n: string }
		>("SELECT held_by_pid, acquired_at FROM turn_locks WHERE agent_name = $n");
		const row = stmt.get({ $n: agentName });
		return {
			heldByPid: row?.held_by_pid ?? null,
			acquiredAt: row?.acquired_at ?? null,
		};
	} finally {
		db.close();
	}
}

/** Reset the in-process tail map. Used by tests; not exported through index. */
export function _resetInProcessLocks(): void {
	inProcessTails.clear();
}

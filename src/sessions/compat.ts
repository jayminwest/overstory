/**
 * Backward-compatible session reader.
 *
 * On first call, if sessions.json exists and sessions.db does not,
 * imports all entries from JSON into SQLite. After migration,
 * SQLite is the authoritative source.
 *
 * This module does NOT modify consumers -- it provides a migration
 * bridge that can be called by consumers when they are ready to switch.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentSession } from "../types.ts";
import { createSessionStore, type SessionStore } from "./store.ts";

/**
 * Normalize a session object that may have been parsed from JSON
 * and is missing the `runId` field (added after sessions.json was designed).
 */
function normalizeSession(raw: Record<string, unknown>): AgentSession {
	return {
		id: raw.id as string,
		agentName: raw.agentName as string,
		capability: raw.capability as string,
		runtime: (raw.runtime as string) ?? "claude",
		worktreePath: raw.worktreePath as string,
		branchName: raw.branchName as string,
		taskId: raw.taskId as string,
		tmuxSession: raw.tmuxSession as string,
		state: raw.state as AgentSession["state"],
		pid: (raw.pid as number | null) ?? null,
		parentAgent: (raw.parentAgent as string | null) ?? null,
		depth: (raw.depth as number) ?? 0,
		runId: (raw.runId as string | null) ?? null,
		startedAt: raw.startedAt as string,
		lastActivity: raw.lastActivity as string,
		escalationLevel: (raw.escalationLevel as number) ?? 0,
		stalledSince: (raw.stalledSince as string | null) ?? null,
		rateLimitedSince: (raw.rateLimitedSince as string | null) ?? null,
		transcriptPath: (raw.transcriptPath as string | null) ?? null,
	};
}

/**
 * Load sessions from a sessions.json file.
 * Returns an empty array if the file does not exist or is malformed.
 */
function loadJsonSessions(jsonPath: string): AgentSession[] {
	if (!existsSync(jsonPath)) {
		return [];
	}
	try {
		const text = readFileSync(jsonPath, "utf-8");
		const parsed: unknown = JSON.parse(text);
		if (!Array.isArray(parsed)) {
			return [];
		}
		return parsed.map((entry) => normalizeSession(entry as Record<string, unknown>));
	} catch {
		return [];
	}
}

/**
 * Open or create a SessionStore at the given .overstory directory root.
 *
 * Migration logic:
 * 1. If sessions.db exists AND has rows, open it directly (SQLite is authoritative).
 * 2. If sessions.db exists but is empty, check sessions.json for importable records.
 * 3. If sessions.db does NOT exist but sessions.json does, create sessions.db
 *    and import all entries from sessions.json.
 * 4. If neither exists, create an empty sessions.db.
 *
 * @param overstoryDir - Path to the .overstory directory (e.g., /project/.overstory)
 * @returns An object with the SessionStore and whether a migration occurred.
 */
export function openSessionStore(overstoryDir: string): {
	store: SessionStore;
	migrated: boolean;
} {
	const dbPath = join(overstoryDir, "sessions.db");
	const jsonPath = join(overstoryDir, "sessions.json");

	const dbExists = existsSync(dbPath);

	const store = createSessionStore(dbPath);

	// If the DB already existed AND has data, it is authoritative -- no migration needed.
	// If the DB file exists but is empty (e.g., created by init before any sessions were
	// recorded), fall through to check sessions.json for importable records (overstory-036f).
	if (dbExists && store.count() > 0) {
		return { store, migrated: false };
	}

	// DB was just created. If sessions.json exists, import its entries.
	const jsonSessions = loadJsonSessions(jsonPath);
	if (jsonSessions.length === 0) {
		return { store, migrated: false };
	}

	for (const session of jsonSessions) {
		store.upsert(session);
	}

	return { store, migrated: true };
}

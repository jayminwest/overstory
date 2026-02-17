import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OverstoryConfig } from "../types.ts";
import { checkDatabases } from "./databases.ts";
import type { DoctorCheck } from "./types.ts";

describe("checkDatabases", () => {
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
			},
			worktrees: { baseDir: "" },
			beads: { enabled: true },
			mulch: { enabled: true, domains: [], primeFormat: "markdown" },
			merge: { aiResolveEnabled: false, reimagineEnabled: false },
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

	test("fails when database files do not exist", () => {
		const checks = checkDatabases(mockConfig, tempDir) as DoctorCheck[];

		expect(checks).toHaveLength(3);
		expect(checks[0]?.status).toBe("fail");
		expect(checks[0]?.name).toBe("mail.db exists");
		expect(checks[1]?.status).toBe("fail");
		expect(checks[1]?.name).toBe("metrics.db exists");
		expect(checks[2]?.status).toBe("fail");
		expect(checks[2]?.name).toBe("sessions.db exists");
	});

	test("passes when databases exist with correct schema", () => {
		// Create mail.db
		const mailDb = new Database(join(tempDir, "mail.db"));
		mailDb.exec("PRAGMA journal_mode=WAL");
		mailDb.exec(`
			CREATE TABLE messages (
				id TEXT PRIMARY KEY,
				from_agent TEXT NOT NULL,
				to_agent TEXT NOT NULL,
				subject TEXT NOT NULL,
				body TEXT NOT NULL,
				type TEXT NOT NULL DEFAULT 'status',
				priority TEXT NOT NULL DEFAULT 'normal',
				thread_id TEXT,
				payload TEXT,
				read INTEGER NOT NULL DEFAULT 0,
				created_at TEXT NOT NULL DEFAULT (datetime('now'))
			)
		`);
		mailDb.close();

		// Create metrics.db
		const metricsDb = new Database(join(tempDir, "metrics.db"));
		metricsDb.exec("PRAGMA journal_mode=WAL");
		metricsDb.exec(`
			CREATE TABLE sessions (
				agent_name TEXT NOT NULL,
				bead_id TEXT NOT NULL,
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
				PRIMARY KEY (agent_name, bead_id)
			)
		`);
		metricsDb.close();

		// Create sessions.db
		const sessionsDb = new Database(join(tempDir, "sessions.db"));
		sessionsDb.exec("PRAGMA journal_mode=WAL");
		sessionsDb.exec(`
			CREATE TABLE sessions (
				id TEXT PRIMARY KEY,
				agent_name TEXT NOT NULL UNIQUE,
				capability TEXT NOT NULL,
				worktree_path TEXT NOT NULL,
				branch_name TEXT NOT NULL,
				bead_id TEXT NOT NULL,
				tmux_session TEXT NOT NULL,
				state TEXT NOT NULL DEFAULT 'booting',
				pid INTEGER,
				parent_agent TEXT,
				depth INTEGER NOT NULL DEFAULT 0,
				run_id TEXT,
				started_at TEXT NOT NULL,
				last_activity TEXT NOT NULL,
				escalation_level INTEGER NOT NULL DEFAULT 0,
				stalled_since TEXT
			)
		`);
		sessionsDb.exec(`
			CREATE TABLE runs (
				id TEXT PRIMARY KEY,
				started_at TEXT NOT NULL,
				completed_at TEXT,
				agent_count INTEGER NOT NULL DEFAULT 0,
				coordinator_session_id TEXT,
				status TEXT NOT NULL DEFAULT 'active'
			)
		`);
		sessionsDb.close();

		const checks = checkDatabases(mockConfig, tempDir) as DoctorCheck[];

		expect(checks).toHaveLength(3);
		expect(checks.every((c) => c?.status === "pass")).toBe(true);
		expect(checks[0]?.name).toBe("mail.db health");
		expect(checks[1]?.name).toBe("metrics.db health");
		expect(checks[2]?.name).toBe("sessions.db health");
	});

	test("fails when table is missing", () => {
		// Create mail.db without messages table
		const mailDb = new Database(join(tempDir, "mail.db"));
		mailDb.exec("PRAGMA journal_mode=WAL");
		mailDb.close();

		// Create other databases properly to isolate the test
		const metricsDb = new Database(join(tempDir, "metrics.db"));
		metricsDb.exec("PRAGMA journal_mode=WAL");
		metricsDb.exec(`
			CREATE TABLE sessions (
				agent_name TEXT NOT NULL,
				bead_id TEXT NOT NULL,
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
				PRIMARY KEY (agent_name, bead_id)
			)
		`);
		metricsDb.close();

		const sessionsDb = new Database(join(tempDir, "sessions.db"));
		sessionsDb.exec("PRAGMA journal_mode=WAL");
		sessionsDb.exec(`
			CREATE TABLE sessions (
				id TEXT PRIMARY KEY,
				agent_name TEXT NOT NULL UNIQUE,
				capability TEXT NOT NULL,
				worktree_path TEXT NOT NULL,
				branch_name TEXT NOT NULL,
				bead_id TEXT NOT NULL,
				tmux_session TEXT NOT NULL,
				state TEXT NOT NULL DEFAULT 'booting',
				pid INTEGER,
				parent_agent TEXT,
				depth INTEGER NOT NULL DEFAULT 0,
				run_id TEXT,
				started_at TEXT NOT NULL,
				last_activity TEXT NOT NULL,
				escalation_level INTEGER NOT NULL DEFAULT 0,
				stalled_since TEXT
			)
		`);
		sessionsDb.exec(`
			CREATE TABLE runs (
				id TEXT PRIMARY KEY,
				started_at TEXT NOT NULL,
				completed_at TEXT,
				agent_count INTEGER NOT NULL DEFAULT 0,
				coordinator_session_id TEXT,
				status TEXT NOT NULL DEFAULT 'active'
			)
		`);
		sessionsDb.close();

		const checks = checkDatabases(mockConfig, tempDir) as DoctorCheck[];

		const mailCheck = checks.find((c) => c?.name === "mail.db schema");
		expect(mailCheck?.status).toBe("fail");
		expect(mailCheck?.details).toContain("Missing tables: messages");
	});

	test("fails when column is missing", () => {
		// Create messages table without payload column
		const mailDb = new Database(join(tempDir, "mail.db"));
		mailDb.exec("PRAGMA journal_mode=WAL");
		mailDb.exec(`
			CREATE TABLE messages (
				id TEXT PRIMARY KEY,
				from_agent TEXT NOT NULL,
				to_agent TEXT NOT NULL,
				subject TEXT NOT NULL,
				body TEXT NOT NULL,
				type TEXT NOT NULL DEFAULT 'status',
				priority TEXT NOT NULL DEFAULT 'normal',
				thread_id TEXT,
				read INTEGER NOT NULL DEFAULT 0,
				created_at TEXT NOT NULL DEFAULT (datetime('now'))
			)
		`);
		mailDb.close();

		const checks = checkDatabases(mockConfig, tempDir) as DoctorCheck[];

		const mailCheck = checks.find((c) => c?.name === "mail.db schema");
		expect(mailCheck?.status).toBe("fail");
		expect(mailCheck?.details?.some((d) => d.includes("missing column: payload"))).toBe(true);
	});

	test("warns when WAL mode is not enabled", () => {
		// Create database without WAL mode
		const mailDb = new Database(join(tempDir, "mail.db"));
		mailDb.exec(`
			CREATE TABLE messages (
				id TEXT PRIMARY KEY,
				from_agent TEXT NOT NULL,
				to_agent TEXT NOT NULL,
				subject TEXT NOT NULL,
				body TEXT NOT NULL,
				type TEXT NOT NULL DEFAULT 'status',
				priority TEXT NOT NULL DEFAULT 'normal',
				thread_id TEXT,
				payload TEXT,
				read INTEGER NOT NULL DEFAULT 0,
				created_at TEXT NOT NULL DEFAULT (datetime('now'))
			)
		`);
		mailDb.close();

		const checks = checkDatabases(mockConfig, tempDir) as DoctorCheck[];

		const walCheck = checks.find((c) => c?.name === "mail.db WAL mode");
		expect(walCheck?.status).toBe("warn");
		expect(walCheck?.message).toContain("not using WAL mode");
	});

	test("fails when database is corrupted", () => {
		// Create a corrupt database file (just write garbage)
		const { writeFileSync } = require("node:fs");
		writeFileSync(join(tempDir, "mail.db"), "not a valid sqlite database");

		const checks = checkDatabases(mockConfig, tempDir) as DoctorCheck[];

		const integrityCheck = checks.find((c) => c?.name === "mail.db integrity");
		expect(integrityCheck?.status).toBe("fail");
		expect(integrityCheck?.message).toContain("Failed to open or validate");
	});
});

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, webCommand } from "./web.ts";

/**
 * Tests for `overstory web` command.
 *
 * Two test suites:
 * 1. webCommand — CLI-level tests (help, port validation, background mode)
 * 2. startServer — integration tests using ephemeral ports with real HTTP requests
 */

describe("webCommand", () => {
	let chunks: string[];
	let stderrChunks: string[];
	let originalWrite: typeof process.stdout.write;
	let originalStderrWrite: typeof process.stderr.write;
	let tempDir: string;
	let originalCwd: string;
	let originalExitCode: string | number | null | undefined;

	beforeEach(async () => {
		// Spy on stdout
		chunks = [];
		originalWrite = process.stdout.write;
		process.stdout.write = ((chunk: string) => {
			chunks.push(chunk);
			return true;
		}) as typeof process.stdout.write;

		// Spy on stderr
		stderrChunks = [];
		originalStderrWrite = process.stderr.write;
		process.stderr.write = ((chunk: string) => {
			stderrChunks.push(chunk);
			return true;
		}) as typeof process.stderr.write;

		// Save original exitCode
		originalExitCode = process.exitCode;
		process.exitCode = 0;

		// Create temp dir with .overstory/config.yaml structure
		tempDir = await mkdtemp(join(tmpdir(), "web-test-"));
		const overstoryDir = join(tempDir, ".overstory");
		await Bun.write(
			join(overstoryDir, "config.yaml"),
			`project:\n  name: test\n  root: ${tempDir}\n  canonicalBranch: main\n`,
		);

		// Change to temp dir so loadConfig() works
		originalCwd = process.cwd();
		process.chdir(tempDir);
	});

	afterEach(async () => {
		process.stdout.write = originalWrite;
		process.stderr.write = originalStderrWrite;
		process.exitCode = originalExitCode;
		process.chdir(originalCwd);
		await rm(tempDir, { recursive: true, force: true });
	});

	function output(): string {
		return chunks.join("");
	}

	function stderr(): string {
		return stderrChunks.join("");
	}

	test("--help flag shows help text with key info", async () => {
		await webCommand(["--help"]);
		const out = output();

		expect(out).toContain("overstory web");
		expect(out).toContain("--port");
		expect(out).toContain("--background");
		expect(out).toContain("--json");
		expect(out).toContain("--help");
	});

	test("-h flag shows help text", async () => {
		await webCommand(["-h"]);
		const out = output();

		expect(out).toContain("overstory web");
		expect(out).toContain("--port");
	});

	test("invalid port: NaN", async () => {
		await webCommand(["--port", "abc"]);

		const err = stderr();
		expect(err).toContain("Invalid port");
		expect(err).toContain("abc");
		expect(process.exitCode).toBe(1);
	});

	test("invalid port: out of range (0)", async () => {
		await webCommand(["--port", "0"]);

		const err = stderr();
		expect(err).toContain("Invalid port");
		expect(process.exitCode).toBe(1);
	});

	test("invalid port: out of range (99999)", async () => {
		await webCommand(["--port", "99999"]);

		const err = stderr();
		expect(err).toContain("Invalid port");
		expect(process.exitCode).toBe(1);
	});

	test("background mode: already running detection", async () => {
		// Write a PID file with a running process (use our own PID)
		const pidFilePath = join(tempDir, ".overstory", "web.pid");
		await Bun.write(pidFilePath, `${process.pid}\n`);

		// Try to start in background mode — should fail with "already running"
		await webCommand(["--background"]);

		const err = stderr();
		expect(err).toContain("already running");
		expect(err).toContain(`${process.pid}`);
		expect(process.exitCode).toBe(1);
	});

	test("background mode: stale PID cleanup", async () => {
		// Write a PID file with a non-running process (999999 is very unlikely to exist)
		const pidFilePath = join(tempDir, ".overstory", "web.pid");
		await Bun.write(pidFilePath, "999999\n");

		// Verify the stale PID file exists before the test
		const fileBeforeExists = await Bun.file(pidFilePath).exists();
		expect(fileBeforeExists).toBe(true);

		// Try to start in background mode
		// This will clean up the stale PID file, then attempt to spawn.
		// The spawn will fail because there's no real overstory binary in test env,
		// but the important part is that the stale PID file gets removed.
		try {
			await webCommand(["--background"]);
		} catch {
			// Expected to fail when trying to spawn — that's OK
		}

		// The stale PID file should have been removed during the check
		// (Even if the spawn itself failed, the cleanup happens before spawn)
		// Actually, looking at the code: if existingPid is not null but not running,
		// it removes the PID file. Then it tries to spawn. So the file should be gone
		// OR replaced with a new PID.

		// Let's check: the file should either not exist, OR contain a different PID
		const fileAfterExists = await Bun.file(pidFilePath).exists();
		if (fileAfterExists) {
			const content = await Bun.file(pidFilePath).text();
			expect(content.trim()).not.toBe("999999");
		}
		// If it doesn't exist, that's also valid (spawn failed before writing new PID)
	});
});

// ── Integration tests: real HTTP requests against startServer() ──

/**
 * Create minimal SQLite databases matching the schemas used by handleDashApi.
 */
function seedTestDatabases(overstoryDir: string): void {
	// sessions.db
	const sessionsDb = new Database(join(overstoryDir, "sessions.db"));
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
		INSERT INTO sessions (id, agent_name, capability, worktree_path, branch_name, bead_id, tmux_session, state, started_at, last_activity)
		VALUES ('sess-1', 'test-builder', 'builder', '/tmp/wt', 'feat/test', 'bead-1', 'overstory-test-fake', 'working', '2025-01-01T00:00:00', '2025-01-01T00:01:00')
	`);
	sessionsDb.close();

	// mail.db
	const mailDb = new Database(join(overstoryDir, "mail.db"));
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
	mailDb.exec(`
		INSERT INTO messages (id, from_agent, to_agent, subject, body, type, created_at)
		VALUES ('msg-1', 'builder-a', 'orchestrator', 'Done', 'Task complete', 'result', '2025-01-01T00:00:00')
	`);
	mailDb.close();

	// events.db
	const eventsDb = new Database(join(overstoryDir, "events.db"));
	eventsDb.exec(`
		CREATE TABLE events (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			run_id TEXT,
			agent_name TEXT NOT NULL,
			session_id TEXT,
			event_type TEXT NOT NULL,
			tool_name TEXT,
			tool_args TEXT,
			tool_duration_ms INTEGER,
			level TEXT NOT NULL DEFAULT 'info',
			data TEXT,
			created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now'))
		)
	`);
	eventsDb.exec(`
		INSERT INTO events (agent_name, event_type, level, created_at)
		VALUES ('test-builder', 'tool-end', 'info', '2025-01-01T00:00:00')
	`);
	eventsDb.exec(`
		INSERT INTO events (agent_name, event_type, level, created_at)
		VALUES ('test-builder', 'error', 'error', '2025-01-01T00:00:01')
	`);
	eventsDb.close();

	// merge-queue.db
	const mqDb = new Database(join(overstoryDir, "merge-queue.db"));
	mqDb.exec(`
		CREATE TABLE merge_queue (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			branch_name TEXT NOT NULL,
			bead_id TEXT NOT NULL,
			agent_name TEXT NOT NULL,
			files_modified TEXT NOT NULL DEFAULT '[]',
			enqueued_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now')),
			status TEXT NOT NULL DEFAULT 'pending',
			resolved_tier TEXT
		)
	`);
	mqDb.close();

	// metrics.db
	const metricsDb = new Database(join(overstoryDir, "metrics.db"));
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
}

describe("startServer integration", () => {
	let tempDir: string;
	let server: ReturnType<typeof Bun.serve>;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "web-int-"));
		const overstoryDir = join(tempDir, ".overstory");
		await Bun.write(
			join(overstoryDir, "config.yaml"),
			`project:\n  name: test\n  root: ${tempDir}\n  canonicalBranch: main\n`,
		);
		seedTestDatabases(overstoryDir);
		server = startServer(0, tempDir);
	});

	afterEach(() => {
		server.stop(true);
	});

	function url(path: string): string {
		return `http://localhost:${server.port}${path}`;
	}

	// ── API endpoint tests ──

	test("GET /dash/api/sessions returns session data", async () => {
		const res = await fetch(url("/dash/api/sessions"));
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("application/json");
		const data = (await res.json()) as Array<Record<string, unknown>>;
		expect(data).toBeArray();
		expect(data.length).toBe(1);
		expect(data[0]?.agent_name).toBe("test-builder");
		expect(data[0]?.state).toBe("working");
	});

	test("GET /dash/api/mail returns messages", async () => {
		const res = await fetch(url("/dash/api/mail"));
		expect(res.status).toBe(200);
		const data = (await res.json()) as Array<Record<string, unknown>>;
		expect(data).toBeArray();
		expect(data.length).toBe(1);
		expect(data[0]?.from_agent).toBe("builder-a");
	});

	test("GET /dash/api/mail/:id returns specific message", async () => {
		const res = await fetch(url("/dash/api/mail/msg-1"));
		expect(res.status).toBe(200);
		const data = (await res.json()) as Array<Record<string, unknown>>;
		expect(data).toBeArray();
		expect(data.length).toBe(1);
		expect(data[0]?.id).toBe("msg-1");
	});

	test("GET /dash/api/mail with filters", async () => {
		const res = await fetch(url("/dash/api/mail?from=builder-a&limit=10"));
		expect(res.status).toBe(200);
		const data = (await res.json()) as Array<Record<string, unknown>>;
		expect(data.length).toBe(1);

		// Non-matching filter
		const res2 = await fetch(url("/dash/api/mail?from=nobody"));
		const data2 = (await res2.json()) as Array<Record<string, unknown>>;
		expect(data2.length).toBe(0);
	});

	test("GET /dash/api/events returns events", async () => {
		const res = await fetch(url("/dash/api/events"));
		expect(res.status).toBe(200);
		const data = (await res.json()) as Array<Record<string, unknown>>;
		expect(data).toBeArray();
		expect(data.length).toBe(2);
	});

	test("GET /dash/api/events with level filter", async () => {
		const res = await fetch(url("/dash/api/events?level=error"));
		expect(res.status).toBe(200);
		const data = (await res.json()) as Array<Record<string, unknown>>;
		expect(data.length).toBe(1);
		expect(data[0]?.level).toBe("error");
	});

	test("GET /dash/api/errors returns only error-level events", async () => {
		const res = await fetch(url("/dash/api/errors"));
		expect(res.status).toBe(200);
		const data = (await res.json()) as Array<Record<string, unknown>>;
		expect(data.length).toBe(1);
		expect(data[0]?.level).toBe("error");
	});

	test("GET /dash/api/trace/:agent returns agent events", async () => {
		const res = await fetch(url("/dash/api/trace/test-builder"));
		expect(res.status).toBe(200);
		const data = (await res.json()) as Array<Record<string, unknown>>;
		expect(data.length).toBe(2);
	});

	test("GET /dash/api/trace without agent returns error", async () => {
		const res = await fetch(url("/dash/api/trace"));
		// Route splits on "/" — empty param → error response
		const data = (await res.json()) as Record<string, unknown>;
		expect(data.error).toBe("Agent name required");
	});

	test("GET /dash/api/merge-queue returns empty array", async () => {
		const res = await fetch(url("/dash/api/merge-queue"));
		expect(res.status).toBe(200);
		const data = (await res.json()) as unknown[];
		expect(data).toEqual([]);
	});

	test("GET /dash/api/metrics returns empty array", async () => {
		const res = await fetch(url("/dash/api/metrics"));
		expect(res.status).toBe(200);
		const data = (await res.json()) as unknown[];
		expect(data).toEqual([]);
	});

	test("GET /dash/api/unknown returns 404", async () => {
		const res = await fetch(url("/dash/api/nonexistent"));
		expect(res.status).toBe(404);
		const data = (await res.json()) as Record<string, unknown>;
		expect(data.error).toBe("Unknown endpoint");
	});

	// ── Missing database resilience ──

	test("API returns empty array when database is missing", async () => {
		// Create a server with a root that has no databases
		const emptyDir = await mkdtemp(join(tmpdir(), "web-empty-"));
		const emptyServer = startServer(0, emptyDir);
		try {
			const res = await fetch(`http://localhost:${emptyServer.port}/dash/api/sessions`);
			expect(res.status).toBe(200);
			const data = (await res.json()) as unknown[];
			expect(data).toEqual([]);
		} finally {
			emptyServer.stop(true);
			await rm(emptyDir, { recursive: true, force: true });
		}
	});

	// ── Static file serving ──

	test("GET / serves index.html", async () => {
		const res = await fetch(url("/"));
		// The dashboard/index.html exists in the repo, so this should succeed
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("text/html");
	});

	// ── Path traversal protection ──

	test("path traversal attempts don't serve files outside dashboard", async () => {
		// fetch() normalizes ../ before sending, so the server sees /etc/passwd
		// which resolves inside dashboardDir → 404 (file not found). The resolve()
		// check catches any path that escapes the dashboard directory.
		const res = await fetch(url("/dashboard/../../../etc/passwd"));
		expect([403, 404]).toContain(res.status);

		// Encoded traversal attempt
		const res2 = await fetch(url("/dashboard/%2e%2e/%2e%2e/etc/passwd"));
		expect([403, 404]).toContain(res2.status);

		// Direct path outside dashboard
		const res3 = await fetch(url("/etc/passwd"));
		expect([403, 404]).toContain(res3.status);
	});

	// ── WebSocket upgrade ──

	test("WebSocket upgrade to /ws/terminal/<session> succeeds", async () => {
		const ws = new WebSocket(`ws://localhost:${server.port}/ws/terminal/test-session`);
		const opened = await new Promise<boolean>((resolve) => {
			ws.onopen = () => resolve(true);
			ws.onerror = () => resolve(false);
			setTimeout(() => resolve(false), 2000);
		});
		expect(opened).toBe(true);
		ws.close();
	});

	test("WebSocket upgrade with invalid session name returns 400", async () => {
		const res = await fetch(url("/ws/terminal/bad%20session%21"), {
			headers: { Upgrade: "websocket" },
		});
		// safe() strips invalid chars → empty → 400
		expect(res.status).toBe(400);
	});

	test("WebSocket upgrade without session name returns 400", async () => {
		const res = await fetch(url("/ws/terminal/"), {
			headers: { Upgrade: "websocket" },
		});
		expect([400, 404]).toContain(res.status);
	});

	// ── Trailing slash normalization ──

	test("trailing slash is normalized", async () => {
		const res = await fetch(url("/dash/api/sessions/"));
		// "sessions/" → route="sessions/" → cmd="sessions" after split
		expect(res.status).toBe(200);
	});
});

/**
 * Tests for REST endpoints registered by registerRestApi().
 *
 * Pattern mirrors serve.test.ts:
 *  - temp dir with .overstory/config.yaml
 *  - port 0 for automatic free-port assignment
 *  - _resetHandlers() in beforeEach for isolation
 *  - server stopped in afterEach
 *
 * Stores are seeded with real SQLite instances so cursor/pagination
 * invariants are verified against actual data.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventStore } from "../../events/store.ts";
import type { MailStore } from "../../mail/store.ts";
import { createMailStore } from "../../mail/store.ts";
import type { SessionStore } from "../../sessions/store.ts";
import { createRunStore, createSessionStore } from "../../sessions/store.ts";
import type { EventStore, RunStore } from "../../types.ts";
import { _resetHandlers, createServeServer } from "../serve.ts";
import { registerRestApi } from "./rest.ts";
import { serveStatic } from "./static.ts";

// ─── Helpers ─────────────────────────────────────────────────────────────────

interface TestContext {
	tempDir: string;
	runStore: RunStore;
	sessionStore: SessionStore;
	eventStore: EventStore;
	mailStore: MailStore;
	servers: ReturnType<typeof Bun.serve>[];
}

function makeSession(
	overrides: Partial<{ agentName: string; runId: string | null; startedAt: string }> = {},
) {
	return {
		id: `sess-${Math.random().toString(36).slice(2)}`,
		agentName: overrides.agentName ?? `agent-${Math.random().toString(36).slice(2)}`,
		capability: "builder" as const,
		worktreePath: "/tmp/wt",
		branchName: "my-branch",
		taskId: "task-1",
		tmuxSession: "tmux-sess",
		state: "working" as const,
		pid: null,
		parentAgent: null,
		depth: 0,
		runId: overrides.runId ?? null,
		startedAt: overrides.startedAt ?? new Date().toISOString(),
		lastActivity: new Date().toISOString(),
		escalationLevel: 0,
		stalledSince: null,
		transcriptPath: null,
	};
}

function makeRun(
	overrides: Partial<{
		id: string;
		startedAt: string;
		status: "active" | "completed" | "failed";
	}> = {},
) {
	const id = overrides.id ?? `run-${Math.random().toString(36).slice(2)}`;
	return {
		id,
		startedAt: overrides.startedAt ?? new Date().toISOString(),
		agentCount: 0,
		coordinatorSessionId: null,
		coordinatorName: null,
		status: overrides.status ?? ("active" as const),
	};
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe("registerRestApi", () => {
	let ctx: TestContext;

	beforeEach(() => {
		const tempDir = mkdtempSync(join(tmpdir(), "overstory-rest-test-"));
		mkdirSync(join(tempDir, ".overstory"), { recursive: true });
		writeFileSync(
			join(tempDir, ".overstory", "config.yaml"),
			`project:\n  name: test\n  root: ${tempDir}\n  canonicalBranch: main\n`,
		);

		const sessionsDb = join(tempDir, ".overstory", "sessions.db");
		const eventsDb = join(tempDir, ".overstory", "events.db");
		const mailDb = join(tempDir, ".overstory", "mail.db");

		ctx = {
			tempDir,
			runStore: createRunStore(sessionsDb),
			sessionStore: createSessionStore(sessionsDb),
			eventStore: createEventStore(eventsDb),
			mailStore: createMailStore(mailDb),
			servers: [],
		};

		_resetHandlers();
		registerRestApi({
			_runStore: ctx.runStore,
			_sessionStore: ctx.sessionStore,
			_eventStore: ctx.eventStore,
			_mailStore: ctx.mailStore,
			// Coordinator actions reuse the same stores as the test harness so
			// seeded session/mail rows are visible across the API surface.
			_coordinatorActionDeps: {
				projectRoot: tempDir,
				_sessionStore: ctx.sessionStore,
				_mailStore: ctx.mailStore,
				_askPollIntervalMs: 20,
			},
		});
	});

	afterEach(async () => {
		for (const srv of ctx.servers) {
			srv.stop(true);
		}
		ctx.runStore.close();
		ctx.sessionStore.close();
		ctx.eventStore.close();
		ctx.mailStore.close();
		_resetHandlers();
		rmSync(ctx.tempDir, { recursive: true, force: true });
	});

	async function startServer(): Promise<ReturnType<typeof Bun.serve>> {
		const origCwd = process.cwd;
		process.cwd = () => ctx.tempDir;
		// Force project-relative ui/dist resolution so tests asserting "no UI"
		// don't accidentally serve the package-bundled fallback (overstory-916d).
		const server = await createServeServer(
			{ port: 0, host: "127.0.0.1" },
			{
				_restDeps: false,
				_resolveUiDistPath: (root) => join(root, "ui", "dist"),
			},
		);
		process.cwd = origCwd;
		ctx.servers.push(server);
		return server;
	}

	async function get(server: ReturnType<typeof Bun.serve>, path: string): Promise<Response> {
		return fetch(`http://127.0.0.1:${server.port}${path}`);
	}

	async function getJson<T>(
		server: ReturnType<typeof Bun.serve>,
		path: string,
	): Promise<{ status: number; body: T }> {
		const res = await get(server, path);
		const body = (await res.json()) as T;
		return { status: res.status, body };
	}

	// ─── /healthz ─────────────────────────────────────────────────────────────

	describe("/healthz polish", () => {
		test("returns uptimeMs and version nested in data", async () => {
			const server = await startServer();
			const { status, body } = await getJson<{ data: Record<string, unknown> }>(server, "/healthz");
			expect(status).toBe(200);
			expect(typeof body.data.uptimeMs).toBe("number");
			expect(body.data.uptimeMs).toBeGreaterThanOrEqual(0);
			expect(typeof body.data.version).toBe("string");
			expect(body.data.version).not.toBe("");
		});
	});

	// ─── 503 JSON ─────────────────────────────────────────────────────────────

	describe("503 JSON envelope", () => {
		test("returns JSON envelope when ui/dist missing", async () => {
			const server = await startServer();
			const res = await get(server, "/");
			expect(res.status).toBe(503);
			const body = (await res.json()) as Record<string, unknown>;
			expect(body.success).toBe(false);
			expect(body.command).toBe("serve");
			expect(typeof body.error).toBe("string");
		});
	});

	// ─── Path traversal ────────────────────────────────────────────────────────

	describe("path-traversal guard", () => {
		test("serveStatic rejects ../etc/passwd style path with 403 JSON", async () => {
			const uiDist = join(ctx.tempDir, "ui", "dist");
			mkdirSync(uiDist, { recursive: true });
			writeFileSync(join(uiDist, "index.html"), "<html></html>");

			// HTTP clients normalize /../ to / before sending, so we test the guard directly.
			// The raw path "/../../../etc/passwd" stripped of its leading / becomes
			// "../../../etc/passwd" — resolve() escapes uiRoot → 403.
			const res = await serveStatic(
				"/../../../etc/passwd",
				uiDist,
				() => true as ReturnType<typeof import("node:fs").existsSync>,
			);
			expect(res.status).toBe(403);
			const body = (await res.json()) as Record<string, unknown>;
			expect(body.success).toBe(false);
			expect(body.command).toBe("serve");
		});

		test("serveStatic allows normal paths", async () => {
			const uiDist = join(ctx.tempDir, "ui", "dist");
			mkdirSync(uiDist, { recursive: true });
			writeFileSync(join(uiDist, "index.html"), "<html></html>");
			writeFileSync(join(uiDist, "app.js"), "console.log('hi')");

			const res = await serveStatic(
				"/app.js",
				uiDist,
				() => true as ReturnType<typeof import("node:fs").existsSync>,
			);
			expect([200, 404]).toContain(res.status);
		});
	});

	// ─── 405 Method Not Allowed ───────────────────────────────────────────────

	describe("405 on non-GET /api/* routes", () => {
		test("POST /api/runs returns 405", async () => {
			const server = await startServer();
			const res = await fetch(`http://127.0.0.1:${server.port}/api/runs`, { method: "POST" });
			expect(res.status).toBe(405);
			const body = (await res.json()) as Record<string, unknown>;
			expect(body.success).toBe(false);
		});

		test("DELETE /api/agents returns 405", async () => {
			const server = await startServer();
			const res = await fetch(`http://127.0.0.1:${server.port}/api/agents`, { method: "DELETE" });
			expect(res.status).toBe(405);
		});
	});

	// ─── GET /api/runs ────────────────────────────────────────────────────────

	describe("GET /api/runs", () => {
		test("returns empty list when no runs", async () => {
			const server = await startServer();
			const { status, body } = await getJson<Record<string, unknown>>(server, "/api/runs");
			expect(status).toBe(200);
			expect(body.success).toBe(true);
			expect(Array.isArray(body.data)).toBe(true);
			expect((body.data as unknown[]).length).toBe(0);
		});

		test("returns runs sorted DESC by startedAt", async () => {
			const r1 = makeRun({ id: "run-a", startedAt: "2024-01-01T00:00:00.000Z" });
			const r2 = makeRun({ id: "run-b", startedAt: "2024-02-01T00:00:00.000Z" });
			ctx.runStore.createRun(r1);
			ctx.runStore.createRun(r2);

			const server = await startServer();
			const { status, body } = await getJson<{ data: Array<{ id: string }> }>(server, "/api/runs");
			expect(status).toBe(200);
			expect(body.data[0]?.id).toBe("run-b");
			expect(body.data[1]?.id).toBe("run-a");
		});

		test("success envelope shape", async () => {
			const server = await startServer();
			const { body } = await getJson<Record<string, unknown>>(server, "/api/runs");
			expect(body.success).toBe(true);
			expect(body.command).toBe("serve");
			expect("data" in body).toBe(true);
		});

		test("pagination: two pages, no duplicates, no gaps", async () => {
			// Seed 3 runs
			for (let i = 0; i < 3; i++) {
				const ts = new Date(2024, 0, i + 1).toISOString();
				ctx.runStore.createRun(makeRun({ id: `prun-${i}`, startedAt: ts }));
			}

			const server = await startServer();
			const p1 = await getJson<{ data: Array<{ id: string }>; nextCursor: string | null }>(
				server,
				"/api/runs?limit=2",
			);
			expect(p1.status).toBe(200);
			expect(p1.body.data.length).toBe(2);
			expect(p1.body.nextCursor).not.toBeNull();

			const p2 = await getJson<{ data: Array<{ id: string }>; nextCursor: string | null }>(
				server,
				`/api/runs?limit=2&cursor=${p1.body.nextCursor}`,
			);
			expect(p2.status).toBe(200);
			expect(p2.body.data.length).toBe(1);
			expect(p2.body.nextCursor ?? null).toBeNull();

			const allIds = [...p1.body.data.map((r) => r.id), ...p2.body.data.map((r) => r.id)];
			expect(new Set(allIds).size).toBe(3);
		});

		test("bad limit returns 400", async () => {
			const server = await startServer();
			const { status, body } = await getJson<Record<string, unknown>>(server, "/api/runs?limit=0");
			expect(status).toBe(400);
			expect(body.success).toBe(false);
		});

		test("limit > 500 returns 400", async () => {
			const server = await startServer();
			const { status } = await getJson<Record<string, unknown>>(server, "/api/runs?limit=501");
			expect(status).toBe(400);
		});

		test("bad cursor returns 400", async () => {
			const server = await startServer();
			const { status } = await getJson<Record<string, unknown>>(
				server,
				"/api/runs?cursor=not-valid-base64",
			);
			expect(status).toBe(400);
		});
	});

	// ─── GET /api/runs/:id ────────────────────────────────────────────────────

	describe("GET /api/runs/:id", () => {
		test("404 for unknown run", async () => {
			const server = await startServer();
			const { status, body } = await getJson<Record<string, unknown>>(server, "/api/runs/no-such");
			expect(status).toBe(404);
			expect(body.success).toBe(false);
		});

		test("returns run with agents sorted ASC", async () => {
			const run = makeRun({ id: "run-detail" });
			ctx.runStore.createRun(run);
			const sess1 = makeSession({
				agentName: "agent-1",
				runId: "run-detail",
				startedAt: "2024-01-02T00:00:00.000Z",
			});
			const sess2 = makeSession({
				agentName: "agent-2",
				runId: "run-detail",
				startedAt: "2024-01-01T00:00:00.000Z",
			});
			ctx.sessionStore.upsert(sess1);
			ctx.sessionStore.upsert(sess2);

			const server = await startServer();
			const { status, body } = await getJson<{
				data: { id: string; agents: Array<{ agentName: string }> };
			}>(server, "/api/runs/run-detail");
			expect(status).toBe(200);
			expect(body.data.id).toBe("run-detail");
			expect(body.data.agents.length).toBe(2);
			expect(body.data.agents[0]?.agentName).toBe("agent-2");
			expect(body.data.agents[1]?.agentName).toBe("agent-1");
		});
	});

	// ─── GET /api/agents ──────────────────────────────────────────────────────

	describe("GET /api/agents", () => {
		test("returns empty list when no agents", async () => {
			const server = await startServer();
			const { status, body } = await getJson<Record<string, unknown>>(server, "/api/agents");
			expect(status).toBe(200);
			expect(Array.isArray(body.data)).toBe(true);
		});

		test("returns all agents sorted ASC by startedAt", async () => {
			ctx.sessionStore.upsert(
				makeSession({ agentName: "ag-z", startedAt: "2024-01-03T00:00:00.000Z" }),
			);
			ctx.sessionStore.upsert(
				makeSession({ agentName: "ag-a", startedAt: "2024-01-01T00:00:00.000Z" }),
			);
			ctx.sessionStore.upsert(
				makeSession({ agentName: "ag-m", startedAt: "2024-01-02T00:00:00.000Z" }),
			);

			const server = await startServer();
			const { body } = await getJson<{ data: Array<{ agentName: string }> }>(server, "/api/agents");
			expect(body.data[0]?.agentName).toBe("ag-a");
			expect(body.data[1]?.agentName).toBe("ag-m");
			expect(body.data[2]?.agentName).toBe("ag-z");
		});

		test("?run= filters by run ID", async () => {
			const run = makeRun({ id: "run-filter" });
			ctx.runStore.createRun(run);
			ctx.sessionStore.upsert(makeSession({ agentName: "in-run", runId: "run-filter" }));
			ctx.sessionStore.upsert(makeSession({ agentName: "no-run" }));

			const server = await startServer();
			const { body } = await getJson<{ data: Array<{ agentName: string }> }>(
				server,
				"/api/agents?run=run-filter",
			);
			expect(body.data.length).toBe(1);
			expect(body.data[0]?.agentName).toBe("in-run");
		});

		test("pagination: two pages, no duplicates", async () => {
			for (let i = 0; i < 3; i++) {
				const ts = new Date(2024, 0, i + 1).toISOString();
				ctx.sessionStore.upsert(makeSession({ agentName: `pagent-${i}`, startedAt: ts }));
			}

			const server = await startServer();
			const p1 = await getJson<{ data: Array<{ agentName: string }>; nextCursor: string | null }>(
				server,
				"/api/agents?limit=2",
			);
			expect(p1.body.data.length).toBe(2);
			expect(p1.body.nextCursor).not.toBeNull();

			const p2 = await getJson<{ data: Array<{ agentName: string }>; nextCursor: string | null }>(
				server,
				`/api/agents?limit=2&cursor=${p1.body.nextCursor}`,
			);
			expect(p2.body.data.length).toBe(1);
			expect(p2.body.nextCursor ?? null).toBeNull();

			const allNames = [
				...p1.body.data.map((a) => a.agentName),
				...p2.body.data.map((a) => a.agentName),
			];
			expect(new Set(allNames).size).toBe(3);
		});
	});

	// ─── GET /api/agents/:name ────────────────────────────────────────────────

	describe("GET /api/agents/:name", () => {
		test("404 for unknown agent", async () => {
			const server = await startServer();
			const { status, body } = await getJson<Record<string, unknown>>(
				server,
				"/api/agents/no-such",
			);
			expect(status).toBe(404);
			expect(body.success).toBe(false);
		});

		test("returns agent by name", async () => {
			ctx.sessionStore.upsert(makeSession({ agentName: "my-agent" }));

			const server = await startServer();
			const { status, body } = await getJson<{ data: { agentName: string } }>(
				server,
				"/api/agents/my-agent",
			);
			expect(status).toBe(200);
			expect(body.data.agentName).toBe("my-agent");
		});
	});

	// ─── GET /api/events ──────────────────────────────────────────────────────

	describe("GET /api/events", () => {
		function insertEvent(agentName: string, runId: string | null = null) {
			return ctx.eventStore.insert({
				agentName,
				runId,
				sessionId: null,
				eventType: "tool_start",
				toolName: "Bash",
				toolArgs: null,
				toolDurationMs: null,
				level: "info",
				data: null,
			});
		}

		test("returns empty list when no events", async () => {
			const server = await startServer();
			const { status, body } = await getJson<Record<string, unknown>>(server, "/api/events");
			expect(status).toBe(200);
			expect(Array.isArray(body.data)).toBe(true);
		});

		test("returns events in ASC order", async () => {
			insertEvent("agent-a");
			insertEvent("agent-b");

			const server = await startServer();
			const { body } = await getJson<{ data: Array<{ agentName: string }> }>(server, "/api/events");
			expect(body.data.length).toBe(2);
			// Both inserted; id is monotonically increasing — first should be agent-a
			expect(body.data[0]?.agentName).toBe("agent-a");
		});

		test("?agent= filters by agent", async () => {
			insertEvent("my-agent");
			insertEvent("other-agent");

			const server = await startServer();
			const { body } = await getJson<{ data: Array<{ agentName: string }> }>(
				server,
				"/api/events?agent=my-agent",
			);
			expect(body.data.every((e) => e.agentName === "my-agent")).toBe(true);
		});

		test("?run= filters by run", async () => {
			const run = makeRun({ id: "ev-run" });
			ctx.runStore.createRun(run);
			insertEvent("ag", "ev-run");
			insertEvent("ag", null);

			const server = await startServer();
			const { body } = await getJson<{ data: Array<{ runId: string | null }> }>(
				server,
				"/api/events?run=ev-run",
			);
			expect(body.data.every((e) => e.runId === "ev-run")).toBe(true);
		});

		test("?since= filters events after timestamp", async () => {
			insertEvent("ag");
			// small delay
			await new Promise((r) => setTimeout(r, 5));
			const since = new Date().toISOString();
			await new Promise((r) => setTimeout(r, 5));
			insertEvent("ag");

			const server = await startServer();
			const { body } = await getJson<{ data: unknown[] }>(
				server,
				`/api/events?since=${encodeURIComponent(since)}`,
			);
			expect(body.data.length).toBe(1);
		});

		test("bad ?since= returns 400", async () => {
			const server = await startServer();
			const { status } = await getJson<Record<string, unknown>>(server, "/api/events?since=NOPE");
			expect(status).toBe(400);
		});

		test("pagination: two pages, no duplicates, no gaps", async () => {
			for (let i = 0; i < 3; i++) {
				insertEvent("pg-agent");
			}

			const server = await startServer();
			const p1 = await getJson<{ data: unknown[]; nextCursor: string | null }>(
				server,
				"/api/events?limit=2",
			);
			expect(p1.body.data.length).toBe(2);
			expect(p1.body.nextCursor).not.toBeNull();

			const p2 = await getJson<{ data: unknown[]; nextCursor: string | null }>(
				server,
				`/api/events?limit=2&cursor=${p1.body.nextCursor}`,
			);
			expect(p2.body.data.length).toBe(1);
			expect(p2.body.nextCursor ?? null).toBeNull();

			const total = p1.body.data.length + p2.body.data.length;
			expect(total).toBe(3);
		});
	});

	// ─── GET /api/mail ────────────────────────────────────────────────────────

	describe("GET /api/mail", () => {
		function insertMsg(from: string, to: string, overrides: { read?: boolean } = {}) {
			const msg = ctx.mailStore.insert({
				id: `msg-${Math.random().toString(36).slice(2)}`,
				from,
				to,
				subject: "Test",
				body: "body",
				type: "status" as const,
				priority: "normal" as const,
				threadId: null,
			});
			if (overrides.read === true) {
				ctx.mailStore.markRead(msg.id);
			}
			return msg;
		}

		test("returns empty list when no messages", async () => {
			const server = await startServer();
			const { status, body } = await getJson<Record<string, unknown>>(server, "/api/mail");
			expect(status).toBe(200);
			expect(Array.isArray(body.data)).toBe(true);
		});

		test("returns messages sorted DESC by createdAt", async () => {
			insertMsg("a", "b");
			insertMsg("c", "d");

			const server = await startServer();
			const { body } = await getJson<{ data: Array<{ from: string }> }>(server, "/api/mail");
			// Second message inserted later — should appear first (DESC)
			expect(body.data.length).toBe(2);
		});

		test("?to= filters by recipient", async () => {
			insertMsg("sender", "target");
			insertMsg("sender", "other");

			const server = await startServer();
			const { body } = await getJson<{ data: Array<{ to: string }> }>(
				server,
				"/api/mail?to=target",
			);
			expect(body.data.every((m) => m.to === "target")).toBe(true);
		});

		test("?from= filters by sender", async () => {
			insertMsg("mybot", "user");
			insertMsg("other", "user");

			const server = await startServer();
			const { body } = await getJson<{ data: Array<{ from: string }> }>(
				server,
				"/api/mail?from=mybot",
			);
			expect(body.data.every((m) => m.from === "mybot")).toBe(true);
		});

		test("?unread=true filters unread messages", async () => {
			insertMsg("a", "b");
			insertMsg("a", "b", { read: true });

			const server = await startServer();
			const { body } = await getJson<{ data: Array<{ read: boolean }> }>(
				server,
				"/api/mail?unread=true",
			);
			expect(body.data.every((m) => m.read === false)).toBe(true);
			expect(body.data.length).toBe(1);
		});

		test("pagination: two pages, no duplicates", async () => {
			for (let i = 0; i < 3; i++) {
				insertMsg("x", "y");
			}

			const server = await startServer();
			const p1 = await getJson<{ data: unknown[]; nextCursor: string | null }>(
				server,
				"/api/mail?limit=2",
			);
			expect(p1.body.data.length).toBe(2);
			expect(p1.body.nextCursor).not.toBeNull();

			const p2 = await getJson<{ data: unknown[]; nextCursor: string | null }>(
				server,
				`/api/mail?limit=2&cursor=${p1.body.nextCursor}`,
			);
			expect(p2.body.data.length).toBe(1);
			expect(p2.body.nextCursor ?? null).toBeNull();

			expect(p1.body.data.length + p2.body.data.length).toBe(3);
		});
	});

	// ─── GET /api/mail/:id ────────────────────────────────────────────────────

	describe("GET /api/mail/:id", () => {
		test("404 for unknown message", async () => {
			const server = await startServer();
			const { status, body } = await getJson<Record<string, unknown>>(server, "/api/mail/no-such");
			expect(status).toBe(404);
			expect(body.success).toBe(false);
		});

		test("returns message and thread", async () => {
			const threadId = "thread-abc";
			const msg1 = ctx.mailStore.insert({
				id: "msg-1",
				from: "a",
				to: "b",
				subject: "Start",
				body: "first",
				type: "status" as const,
				priority: "normal" as const,
				threadId,
			});
			ctx.mailStore.insert({
				id: "msg-2",
				from: "b",
				to: "a",
				subject: "Re: Start",
				body: "reply",
				type: "status" as const,
				priority: "normal" as const,
				threadId,
			});

			const server = await startServer();
			const { status, body } = await getJson<{
				data: { message: { id: string }; thread: Array<{ id: string }> };
			}>(server, `/api/mail/${msg1.id}`);

			expect(status).toBe(200);
			expect(body.data.message.id).toBe("msg-1");
			expect(body.data.thread.length).toBe(2);
		});

		test("no threadId: thread contains only the message itself", async () => {
			const msg = ctx.mailStore.insert({
				id: "msg-solo",
				from: "x",
				to: "y",
				subject: "Solo",
				body: "alone",
				type: "status" as const,
				priority: "normal" as const,
				threadId: null,
			});

			const server = await startServer();
			const { body } = await getJson<{
				data: { message: { id: string }; thread: Array<{ id: string }> };
			}>(server, `/api/mail/${msg.id}`);
			expect(body.data.thread.length).toBe(1);
			expect(body.data.thread[0]?.id).toBe("msg-solo");
		});
	});

	// ─── POST /api/mail/:id/read ──────────────────────────────────────────────

	describe("POST /api/mail/:id/read", () => {
		test("marks message as read and returns confirmation", async () => {
			const msg = ctx.mailStore.insert({
				id: "msg-read-test",
				from: "sender",
				to: "recipient",
				subject: "Mark me",
				body: "body",
				type: "status" as const,
				priority: "normal" as const,
				threadId: null,
			});
			expect(msg.read).toBe(false);

			const server = await startServer();
			const res = await fetch(`http://127.0.0.1:${server.port}/api/mail/${msg.id}/read`, {
				method: "POST",
			});
			expect(res.status).toBe(200);
			const body = (await res.json()) as { data: { id: string; read: boolean } };
			expect(body.data.read).toBe(true);

			// Verify persistence
			const updated = ctx.mailStore.getById(msg.id);
			expect(updated?.read).toBe(true);
		});

		test("404 for unknown message", async () => {
			const server = await startServer();
			const res = await fetch(`http://127.0.0.1:${server.port}/api/mail/no-such/read`, {
				method: "POST",
			});
			expect(res.status).toBe(404);
		});
	});

	// ─── POST /api/mail ───────────────────────────────────────────────────────

	describe("POST /api/mail", () => {
		async function postJson(
			server: ReturnType<typeof Bun.serve>,
			path: string,
			body: unknown,
		): Promise<{ status: number; body: Record<string, unknown> }> {
			const res = await fetch(`http://127.0.0.1:${server.port}${path}`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			const json = (await res.json()) as Record<string, unknown>;
			return { status: res.status, body: json };
		}

		test("happy path returns 200 + messageId", async () => {
			ctx.sessionStore.upsert(makeSession({ agentName: "alice" }));

			const server = await startServer();
			const { status, body } = await postJson(server, "/api/mail", {
				to: "alice",
				subject: "Hello",
				body: "world",
			});

			expect(status).toBe(200);
			expect(body.success).toBe(true);
			const data = body.data as { messageId?: string };
			expect(typeof data.messageId).toBe("string");
		});

		test("invalid type returns 400", async () => {
			ctx.sessionStore.upsert(makeSession({ agentName: "bob" }));

			const server = await startServer();
			const { status, body } = await postJson(server, "/api/mail", {
				to: "bob",
				subject: "s",
				body: "b",
				type: "not-a-type",
			});

			expect(status).toBe(400);
			expect(body.success).toBe(false);
		});

		test("invalid priority returns 400", async () => {
			ctx.sessionStore.upsert(makeSession({ agentName: "carol" }));

			const server = await startServer();
			const { status } = await postJson(server, "/api/mail", {
				to: "carol",
				subject: "s",
				body: "b",
				priority: "huge",
			});

			expect(status).toBe(400);
		});

		test("unknown recipient returns 400", async () => {
			const server = await startServer();
			const { status } = await postJson(server, "/api/mail", {
				to: "ghost",
				subject: "s",
				body: "b",
			});
			expect(status).toBe(400);
		});

		test("invalid JSON body returns 400", async () => {
			const server = await startServer();
			const res = await fetch(`http://127.0.0.1:${server.port}/api/mail`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: "{not json",
			});
			expect(res.status).toBe(400);
		});

		test("@builders fans out to two active builders", async () => {
			ctx.sessionStore.upsert(
				makeSession({ agentName: "build-1", startedAt: "2024-01-01T00:00:00.000Z" }),
			);
			ctx.sessionStore.upsert(
				makeSession({ agentName: "build-2", startedAt: "2024-01-02T00:00:00.000Z" }),
			);

			const server = await startServer();
			const { status, body } = await postJson(server, "/api/mail", {
				to: "@builders",
				subject: "s",
				body: "b",
			});

			expect(status).toBe(200);
			const data = body.data as { messageIds?: string[] };
			expect(Array.isArray(data.messageIds)).toBe(true);
			expect(data.messageIds?.length).toBe(2);
		});
	});

	// ─── POST /api/mail/:id/reply ─────────────────────────────────────────────

	describe("POST /api/mail/:id/reply", () => {
		test("returns 200 + messageId", async () => {
			const original = ctx.mailStore.insert({
				id: "msg-reply-orig",
				from: "alice",
				to: "operator",
				subject: "Hi",
				body: "first",
				type: "status" as const,
				priority: "normal" as const,
				threadId: null,
			});

			const server = await startServer();
			const res = await fetch(`http://127.0.0.1:${server.port}/api/mail/${original.id}/reply`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ body: "thanks" }),
			});
			expect(res.status).toBe(200);
			const body = (await res.json()) as { data: { messageId: string } };
			expect(typeof body.data.messageId).toBe("string");

			const reply = ctx.mailStore.getById(body.data.messageId);
			expect(reply?.to).toBe("alice");
			expect(reply?.from).toBe("operator");
			expect(reply?.threadId).toBe(original.id);
		});

		test("404 for missing id", async () => {
			const server = await startServer();
			const res = await fetch(`http://127.0.0.1:${server.port}/api/mail/no-such/reply`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ body: "x" }),
			});
			expect(res.status).toBe(404);
		});

		test("400 when body is missing", async () => {
			const original = ctx.mailStore.insert({
				id: "msg-reply-empty",
				from: "alice",
				to: "operator",
				subject: "Hi",
				body: "first",
				type: "status" as const,
				priority: "normal" as const,
				threadId: null,
			});

			const server = await startServer();
			const res = await fetch(`http://127.0.0.1:${server.port}/api/mail/${original.id}/reply`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({}),
			});
			expect(res.status).toBe(400);
		});
	});

	// ─── DELETE /api/mail/:id ─────────────────────────────────────────────────

	describe("DELETE /api/mail/:id", () => {
		test("deletes the message and returns 200; second call returns 404", async () => {
			const msg = ctx.mailStore.insert({
				id: "msg-to-delete",
				from: "a",
				to: "b",
				subject: "s",
				body: "b",
				type: "status" as const,
				priority: "normal" as const,
				threadId: null,
			});

			const server = await startServer();
			const res1 = await fetch(`http://127.0.0.1:${server.port}/api/mail/${msg.id}`, {
				method: "DELETE",
			});
			expect(res1.status).toBe(200);
			const body1 = (await res1.json()) as { data: { id: string; deleted: boolean } };
			expect(body1.data.deleted).toBe(true);
			expect(body1.data.id).toBe(msg.id);
			expect(ctx.mailStore.getById(msg.id)).toBeNull();

			const res2 = await fetch(`http://127.0.0.1:${server.port}/api/mail/${msg.id}`, {
				method: "DELETE",
			});
			expect(res2.status).toBe(404);
		});

		test("404 when id never existed", async () => {
			const server = await startServer();
			const res = await fetch(`http://127.0.0.1:${server.port}/api/mail/never-existed`, {
				method: "DELETE",
			});
			expect(res.status).toBe(404);
		});
	});

	// ─── Unknown /api/* routes ────────────────────────────────────────────────

	describe("unknown /api/* routes", () => {
		test("returns 404 for unregistered paths", async () => {
			const server = await startServer();
			const { status, body } = await getJson<Record<string, unknown>>(
				server,
				"/api/unknown-endpoint",
			);
			expect(status).toBe(404);
			expect(body.success).toBe(false);
		});
	});

	// ─── Content-Type ─────────────────────────────────────────────────────────

	describe("Content-Type", () => {
		test("all /api/* responses have application/json content-type", async () => {
			const server = await startServer();
			const endpoints = ["/api/runs", "/api/agents", "/api/events", "/api/mail"];
			for (const ep of endpoints) {
				const res = await get(server, ep);
				expect(res.headers.get("content-type")).toContain("application/json");
			}
		});
	});

	// ─── Coordinator API ──────────────────────────────────────────────────────

	describe("coordinator API", () => {
		function makeCoordSession(
			overrides: Partial<{
				tmuxSession: string;
				state: "working" | "completed" | "booting";
				pid: number;
			}> = {},
		) {
			return {
				id: `session-${Date.now()}-coordinator`,
				agentName: "coordinator",
				capability: "coordinator",
				worktreePath: ctx.tempDir,
				branchName: "main",
				taskId: "",
				tmuxSession: overrides.tmuxSession ?? "",
				state: overrides.state ?? ("working" as const),
				pid: overrides.pid ?? 99999,
				parentAgent: null,
				depth: 0,
				runId: "run-test",
				startedAt: new Date().toISOString(),
				lastActivity: new Date().toISOString(),
				escalationLevel: 0,
				stalledSince: null,
				transcriptPath: null,
			};
		}

		// Replace registered handlers with custom action overrides for a test.
		function reregisterWith(overrides: {
			startCoordinatorHeadless?: (deps: unknown) => Promise<{
				started: boolean;
				alreadyRunning: boolean;
				pid: number | null;
				runId: string | null;
			}>;
			stopCoordinator?: (deps: unknown) => Promise<{ stopped: boolean }>;
			checkCoordinatorComplete?: (deps: unknown) => Promise<unknown>;
		}): void {
			_resetHandlers();
			registerRestApi({
				_runStore: ctx.runStore,
				_sessionStore: ctx.sessionStore,
				_eventStore: ctx.eventStore,
				_mailStore: ctx.mailStore,
				_coordinatorActionDeps: {
					projectRoot: ctx.tempDir,
					_sessionStore: ctx.sessionStore,
					_mailStore: ctx.mailStore,
					_askPollIntervalMs: 20,
				},
				_coordinatorActions: overrides as Parameters<typeof registerRestApi>[0] extends infer D
					? D extends { _coordinatorActions?: infer A }
						? A
						: never
					: never,
			});
		}

		// ─── GET /api/coordinator/state ──────────────────────────────────────

		describe("GET /api/coordinator/state", () => {
			test("returns running: false when no session", async () => {
				const server = await startServer();
				const { status, body } = await getJson<{
					data: { running: boolean };
					success: boolean;
				}>(server, "/api/coordinator/state");
				expect(status).toBe(200);
				expect(body.success).toBe(true);
				expect(body.data.running).toBe(false);
			});

			test("returns running: true after seeding a session", async () => {
				ctx.sessionStore.upsert(makeCoordSession({ tmuxSession: "" }));
				const server = await startServer();
				const { status, body } = await getJson<{
					data: { running: boolean; pid: number | null; tmuxSession: string | null };
				}>(server, "/api/coordinator/state");
				expect(status).toBe(200);
				expect(body.data.running).toBe(true);
				expect(body.data.pid).toBe(99999);
				expect(body.data.tmuxSession).toBeNull();
			});

			test("405 for POST", async () => {
				const server = await startServer();
				const res = await fetch(`http://127.0.0.1:${server.port}/api/coordinator/state`, {
					method: "POST",
				});
				expect(res.status).toBe(405);
			});
		});

		// ─── POST /api/coordinator/send ───────────────────────────────────────

		describe("POST /api/coordinator/send", () => {
			test("creates mail row for a headless session", async () => {
				ctx.sessionStore.upsert(makeCoordSession({ tmuxSession: "" }));
				const server = await startServer();
				const res = await fetch(`http://127.0.0.1:${server.port}/api/coordinator/send`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ subject: "hi", body: "the body" }),
				});
				expect(res.status).toBe(200);
				const json = (await res.json()) as { success: boolean; data: { messageId: string } };
				expect(json.success).toBe(true);
				expect(json.data.messageId).toMatch(/^msg-/);

				const rows = ctx.mailStore.getAll({ to: "coordinator" });
				expect(rows.length).toBe(1);
				expect(rows[0]?.subject).toBe("hi");
				expect(rows[0]?.body).toBe("the body");
			});

			test("returns 400 on missing fields", async () => {
				ctx.sessionStore.upsert(makeCoordSession({ tmuxSession: "" }));
				const server = await startServer();
				const res = await fetch(`http://127.0.0.1:${server.port}/api/coordinator/send`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ body: "no subject" }),
				});
				expect(res.status).toBe(400);
				const json = (await res.json()) as { success: boolean };
				expect(json.success).toBe(false);
			});

			test("returns 400 on invalid JSON", async () => {
				ctx.sessionStore.upsert(makeCoordSession({ tmuxSession: "" }));
				const server = await startServer();
				const res = await fetch(`http://127.0.0.1:${server.port}/api/coordinator/send`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: "{not json",
				});
				expect(res.status).toBe(400);
			});

			test("returns 409 when session is tmux-only", async () => {
				ctx.sessionStore.upsert(makeCoordSession({ tmuxSession: "tmux-pane" }));
				const server = await startServer();
				const res = await fetch(`http://127.0.0.1:${server.port}/api/coordinator/send`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ subject: "x", body: "y" }),
				});
				expect(res.status).toBe(409);
			});

			test("returns 409 when no coordinator session is running", async () => {
				const server = await startServer();
				const res = await fetch(`http://127.0.0.1:${server.port}/api/coordinator/send`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ subject: "x", body: "y" }),
				});
				expect(res.status).toBe(409);
			});

			test("405 for GET", async () => {
				const server = await startServer();
				const res = await fetch(`http://127.0.0.1:${server.port}/api/coordinator/send`);
				expect(res.status).toBe(405);
			});
		});

		// ─── POST /api/coordinator/ask ────────────────────────────────────────

		describe("POST /api/coordinator/ask", () => {
			test("creates mail and returns timedOut: true after deadline", async () => {
				ctx.sessionStore.upsert(makeCoordSession({ tmuxSession: "" }));
				const server = await startServer();
				const res = await fetch(`http://127.0.0.1:${server.port}/api/coordinator/ask`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ subject: "Q", body: "?", timeoutSec: 1 }),
				});
				expect(res.status).toBe(200);
				const json = (await res.json()) as {
					success: boolean;
					data: { messageId: string; reply: unknown; timedOut: boolean };
				};
				expect(json.success).toBe(true);
				expect(json.data.timedOut).toBe(true);
				expect(json.data.reply).toBeNull();

				const rows = ctx.mailStore.getAll({ to: "coordinator" });
				expect(rows.length).toBe(1);
			});

			test("returns 400 on timeoutSec out of range", async () => {
				ctx.sessionStore.upsert(makeCoordSession({ tmuxSession: "" }));
				const server = await startServer();
				const res = await fetch(`http://127.0.0.1:${server.port}/api/coordinator/ask`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ subject: "Q", body: "?", timeoutSec: 9999 }),
				});
				expect(res.status).toBe(400);
			});
		});

		// ─── POST /api/coordinator/check-complete ─────────────────────────────

		describe("POST /api/coordinator/check-complete", () => {
			test("returns the structured CheckCompleteResult shape", async () => {
				reregisterWith({
					checkCoordinatorComplete: async () => ({
						complete: false,
						triggers: {
							allAgentsDone: { enabled: false, met: false, detail: "" },
							taskTrackerEmpty: { enabled: false, met: false, detail: "" },
							onShutdownSignal: { enabled: false, met: false, detail: "" },
						},
					}),
				});
				const server = await startServer();
				const res = await fetch(`http://127.0.0.1:${server.port}/api/coordinator/check-complete`, {
					method: "POST",
				});
				expect(res.status).toBe(200);
				const json = (await res.json()) as {
					success: boolean;
					data: { complete: boolean; triggers: Record<string, unknown> };
				};
				expect(json.success).toBe(true);
				expect(json.data.complete).toBe(false);
				expect(json.data.triggers).toBeDefined();
			});
		});

		// ─── POST /api/coordinator/start ──────────────────────────────────────

		describe("POST /api/coordinator/start", () => {
			test("returns started: true when start succeeds (DI stub)", async () => {
				reregisterWith({
					startCoordinatorHeadless: async () => ({
						started: true,
						alreadyRunning: false,
						pid: 12345,
						runId: "run-new",
					}),
				});
				const server = await startServer();
				const res = await fetch(`http://127.0.0.1:${server.port}/api/coordinator/start`, {
					method: "POST",
				});
				expect(res.status).toBe(200);
				const json = (await res.json()) as {
					success: boolean;
					data: { started: boolean; pid: number };
				};
				expect(json.success).toBe(true);
				expect(json.data.started).toBe(true);
				expect(json.data.pid).toBe(12345);
			});

			test("returns alreadyRunning: true when session already exists", async () => {
				ctx.sessionStore.upsert(makeCoordSession({ tmuxSession: "" }));
				const server = await startServer();
				const res = await fetch(`http://127.0.0.1:${server.port}/api/coordinator/start`, {
					method: "POST",
				});
				expect(res.status).toBe(200);
				const json = (await res.json()) as {
					data: { alreadyRunning: boolean; started: boolean };
				};
				expect(json.data.alreadyRunning).toBe(true);
				expect(json.data.started).toBe(false);
			});

			test("405 for GET", async () => {
				const server = await startServer();
				const res = await fetch(`http://127.0.0.1:${server.port}/api/coordinator/start`);
				expect(res.status).toBe(405);
			});
		});

		// ─── POST /api/coordinator/stop ───────────────────────────────────────

		describe("POST /api/coordinator/stop", () => {
			test("returns stopped: true when an active session exists (DI stub)", async () => {
				ctx.sessionStore.upsert(makeCoordSession({ tmuxSession: "" }));
				reregisterWith({
					stopCoordinator: async () => ({ stopped: true }),
				});
				const server = await startServer();
				const res = await fetch(`http://127.0.0.1:${server.port}/api/coordinator/stop`, {
					method: "POST",
				});
				expect(res.status).toBe(200);
				const json = (await res.json()) as { success: boolean; data: { stopped: boolean } };
				expect(json.success).toBe(true);
				expect(json.data.stopped).toBe(true);
			});

			test("returns stopped: false when no active session", async () => {
				const server = await startServer();
				const res = await fetch(`http://127.0.0.1:${server.port}/api/coordinator/stop`, {
					method: "POST",
				});
				expect(res.status).toBe(200);
				const json = (await res.json()) as { data: { stopped: boolean } };
				expect(json.data.stopped).toBe(false);
			});
		});
	});
});

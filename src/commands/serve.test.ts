import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	_resetHandlers,
	createServeServer,
	registerApiHandler,
	registerWsHandler,
} from "./serve.ts";

/**
 * Tests use createServeServer() directly to avoid binding to process SIGINT/SIGTERM.
 * Each test binds to a random free port (port: 0) to avoid conflicts.
 */

describe("createServeServer", () => {
	let tempDir: string;
	let servers: ReturnType<typeof Bun.serve>[] = [];

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "overstory-serve-test-"));
		_resetHandlers();

		// Create minimal .overstory/config.yaml so loadConfig doesn't fail
		mkdirSync(join(tempDir, ".overstory"), { recursive: true });
		writeFileSync(
			join(tempDir, ".overstory", "config.yaml"),
			`project:\n  name: test\n  root: ${tempDir}\n  canonicalBranch: main\n`,
		);
	});

	afterEach(async () => {
		for (const srv of servers) {
			srv.stop(true);
		}
		servers = [];
		_resetHandlers();
		rmSync(tempDir, { recursive: true, force: true });
	});

	async function startServer(
		opts: { port?: number; host?: string } = {},
	): Promise<ReturnType<typeof Bun.serve>> {
		const origCwd = process.cwd;
		// Swap cwd so loadConfig resolves to tempDir
		process.cwd = () => tempDir;
		const server = await createServeServer({
			port: opts.port ?? 0,
			host: opts.host ?? "127.0.0.1",
		});
		process.cwd = origCwd;
		servers.push(server);
		return server;
	}

	test("/healthz returns success JSON", async () => {
		const server = await startServer();
		const res = await fetch(`http://127.0.0.1:${server.port}/healthz`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.success).toBe(true);
		expect(body.status).toBe("ok");
	});

	test("/healthz Content-Type is application/json", async () => {
		const server = await startServer();
		const res = await fetch(`http://127.0.0.1:${server.port}/healthz`);
		expect(res.headers.get("content-type")).toContain("application/json");
	});

	test("/api/* with no handlers returns 404 JSON", async () => {
		const server = await startServer();
		const res = await fetch(`http://127.0.0.1:${server.port}/api/foo`);
		expect(res.status).toBe(404);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.success).toBe(false);
	});

	test("registerApiHandler intercepts /api/* requests", async () => {
		registerApiHandler((req) => {
			const url = new URL(req.url);
			if (url.pathname === "/api/ping") {
				return new Response(JSON.stringify({ pong: true }), {
					headers: { "Content-Type": "application/json" },
				});
			}
			return null;
		});

		const server = await startServer();
		const res = await fetch(`http://127.0.0.1:${server.port}/api/ping`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.pong).toBe(true);
	});

	test("multiple API handlers: first match wins", async () => {
		registerApiHandler(() => null); // pass-through
		registerApiHandler((req) => {
			const url = new URL(req.url);
			if (url.pathname === "/api/second") {
				return new Response("second", { status: 200 });
			}
			return null;
		});

		const server = await startServer();
		const res = await fetch(`http://127.0.0.1:${server.port}/api/second`);
		expect(res.status).toBe(200);
		const text = await res.text();
		expect(text).toBe("second");
	});

	test("static files: 503 when ui/dist missing", async () => {
		const server = await startServer();
		const res = await fetch(`http://127.0.0.1:${server.port}/`);
		expect(res.status).toBe(503);
	});

	test("static files: serves index.html when present", async () => {
		mkdirSync(join(tempDir, "ui", "dist"), { recursive: true });
		writeFileSync(join(tempDir, "ui", "dist", "index.html"), "<html>app</html>");

		const server = await startServer();
		const res = await fetch(`http://127.0.0.1:${server.port}/`);
		expect(res.status).toBe(200);
		const body = await res.text();
		expect(body).toContain("app");
	});

	test("static files: SPA fallback returns index.html for unknown paths", async () => {
		mkdirSync(join(tempDir, "ui", "dist"), { recursive: true });
		writeFileSync(join(tempDir, "ui", "dist", "index.html"), "<html>spa</html>");

		const server = await startServer();
		const res = await fetch(`http://127.0.0.1:${server.port}/some/deep/route`);
		expect(res.status).toBe(200);
		const body = await res.text();
		expect(body).toContain("spa");
	});

	test("static files: serves named asset files", async () => {
		mkdirSync(join(tempDir, "ui", "dist", "assets"), { recursive: true });
		writeFileSync(join(tempDir, "ui", "dist", "assets", "main.js"), 'console.log("hi")');
		writeFileSync(join(tempDir, "ui", "dist", "index.html"), "<html></html>");

		const server = await startServer();
		const res = await fetch(`http://127.0.0.1:${server.port}/assets/main.js`);
		expect(res.status).toBe(200);
	});

	test("/ws without handler returns 404", async () => {
		const server = await startServer();
		// Non-upgrade request to /ws should return 404
		const res = await fetch(`http://127.0.0.1:${server.port}/ws`);
		expect(res.status).toBe(404);
	});

	test("registerWsHandler replaces previous handler", () => {
		const handler1 = { open: () => {} };
		const handler2 = { open: () => {} };
		registerWsHandler(handler1);
		registerWsHandler(handler2);
		// No assertion needed — just validates it doesn't throw
		// The ws handler is exercised via integration if ws tests are added
	});
});

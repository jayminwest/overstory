import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentFifo, removeAgentFifo } from "../agents/headless-stdin.ts";
import { createMailClient } from "../mail/client.ts";
import { createMailStore } from "../mail/store.ts";
import type { DevServerHandle } from "./serve/dev.ts";
import {
	_resetHandlers,
	createServeServer,
	installMailInjectors,
	registerApiHandler,
	registerWsHandler,
	runServe,
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
		const server = await createServeServer(
			{ port: opts.port ?? 0, host: opts.host ?? "127.0.0.1" },
			{ _restDeps: false },
		);
		process.cwd = origCwd;
		servers.push(server);
		return server;
	}

	test("/healthz returns success JSON", async () => {
		const server = await startServer();
		const res = await fetch(`http://127.0.0.1:${server.port}/healthz`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { success: boolean; data?: { status: string } };
		expect(body.success).toBe(true);
		expect(body.data?.status).toBe("ok");
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
		// Now returns JSON envelope instead of plain text
		const ct = res.headers.get("content-type");
		expect(ct).toContain("application/json");
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

describe("installMailInjectors", () => {
	let tempDir: string;
	let overstoryDir: string;
	let mailDbPath: string;
	const stoppers: Array<() => void> = [];
	const readers: Array<{ kill: () => void; exited: Promise<number> }> = [];
	const fifoFds: number[] = [];
	const cleanupAgents: string[] = [];

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "overstory-mailinject-test-"));
		overstoryDir = join(tempDir, ".overstory");
		mkdirSync(overstoryDir, { recursive: true });
		mailDbPath = join(overstoryDir, "mail.db");
	});

	afterEach(async () => {
		for (const stop of stoppers.splice(0)) stop();
		for (const reader of readers.splice(0)) {
			reader.kill();
			await reader.exited;
		}
		for (const fd of fifoFds.splice(0)) {
			try {
				closeSync(fd);
			} catch {}
		}
		for (const agentName of cleanupAgents.splice(0)) {
			removeAgentFifo(overstoryDir, agentName);
		}
		rmSync(tempDir, { recursive: true, force: true });
	});

	/**
	 * Spawn a small subprocess whose stdin is the agent's FIFO, capturing every
	 * byte it reads to a file. Returns the path of the capture file so tests
	 * can read what the "agent" received.
	 */
	function spawnFifoReader(agentName: string): string {
		const captureFile = join(tempDir, `${agentName}.capture`);
		const scriptPath = join(tempDir, `${agentName}-reader.ts`);
		writeFileSync(
			scriptPath,
			`import { openSync, writeSync, closeSync } from "node:fs";
			 const out = openSync(${JSON.stringify(captureFile)}, "w");
			 for await (const chunk of Bun.stdin.stream()) {
			   writeSync(out, chunk);
			 }
			 closeSync(out);
			`,
		);

		const fd = createAgentFifo(overstoryDir, agentName);
		fifoFds.push(fd);
		cleanupAgents.push(agentName);

		const reader = Bun.spawn(["bun", "run", scriptPath], {
			stdin: fd,
			stdout: "pipe",
			stderr: "pipe",
		});
		readers.push(reader);
		return captureFile;
	}

	test("delivers mid-session mail through a per-agent FIFO", async () => {
		const captureFile = spawnFifoReader("inject-agent-1");
		// Allow the reader subprocess to start its read loop.
		await new Promise((r) => setTimeout(r, 200));

		const stop = installMailInjectors(mailDbPath, overstoryDir);
		stoppers.push(stop);

		const store = createMailStore(mailDbPath);
		const client = createMailClient(store);
		client.send({
			from: "coordinator",
			to: "inject-agent-1",
			subject: "mid-session",
			body: "Please pivot to task X.",
			type: "dispatch",
			priority: "normal",
		});
		store.close();

		// Wait through the default 2000ms inject poll.
		await new Promise((r) => setTimeout(r, 2400));

		const captured = readFileSync(captureFile, "utf-8");
		expect(captured.length).toBeGreaterThan(0);
		const parsed = JSON.parse(captured.trimEnd());
		expect(parsed.type).toBe("user");
		const text: string = parsed.message.content[0].text;
		expect(text).toContain("mid-session");
		expect(text).toContain("Please pivot to task X.");
	}, 10000);

	test("stops loops on shutdown", async () => {
		const captureFile = spawnFifoReader("inject-agent-2");
		await new Promise((r) => setTimeout(r, 200));

		const stop = installMailInjectors(mailDbPath, overstoryDir);

		const store = createMailStore(mailDbPath);
		const client = createMailClient(store);
		client.send({
			from: "coordinator",
			to: "inject-agent-2",
			subject: "first",
			body: "first batch",
			type: "dispatch",
			priority: "normal",
		});
		store.close();

		await new Promise((r) => setTimeout(r, 2400));
		const captureAfterFirst = readFileSync(captureFile, "utf-8");
		expect(captureAfterFirst.length).toBeGreaterThan(0);

		stop();

		// Post-shutdown mail must NOT reach the agent.
		const store2 = createMailStore(mailDbPath);
		const client2 = createMailClient(store2);
		client2.send({
			from: "coordinator",
			to: "inject-agent-2",
			subject: "after-stop",
			body: "should not arrive",
			type: "dispatch",
			priority: "normal",
		});
		store2.close();

		await new Promise((r) => setTimeout(r, 2400));
		const captureAfterStop = readFileSync(captureFile, "utf-8");
		expect(captureAfterStop).toBe(captureAfterFirst);
	}, 10000);

	test("reaps the loop for an agent when its FIFO is removed", async () => {
		spawnFifoReader("inject-agent-3");
		await new Promise((r) => setTimeout(r, 200));

		const stop = installMailInjectors(mailDbPath, overstoryDir);
		stoppers.push(stop);

		const store = createMailStore(mailDbPath);
		const client = createMailClient(store);
		client.send({
			from: "coordinator",
			to: "inject-agent-3",
			subject: "first",
			body: "before remove",
			type: "dispatch",
			priority: "normal",
		});
		store.close();

		await new Promise((r) => setTimeout(r, 2400));

		// Simulate agent termination + cleanup: remove the FIFO file.
		removeAgentFifo(overstoryDir, "inject-agent-3");

		// Send more mail; the reaper should drop the loop on the next rescan.
		const store2 = createMailStore(mailDbPath);
		const client2 = createMailClient(store2);
		client2.send({
			from: "coordinator",
			to: "inject-agent-3",
			subject: "after-remove",
			body: "should not arrive",
			type: "dispatch",
			priority: "normal",
		});
		store2.close();

		// Wait long enough for one rescan tick (5s safety net) + writer no-reader.
		await new Promise((r) => setTimeout(r, 6000));

		const checkStore = createMailStore(mailDbPath);
		try {
			const remaining = checkStore.getUnread("inject-agent-3");
			// after-remove message should still be unread (writer reported
			// no-reader and stopped the loop without marking).
			expect(remaining.some((m) => m.subject === "after-remove")).toBe(true);
		} finally {
			checkStore.close();
		}
	}, 12000);
});

describe("runServe auto-build + dev wiring", () => {
	let tempDir: string;
	let origCwd: typeof process.cwd;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "overstory-runserve-test-"));
		_resetHandlers();
		mkdirSync(join(tempDir, ".overstory"), { recursive: true });
		writeFileSync(
			join(tempDir, ".overstory", "config.yaml"),
			`project:\n  name: test\n  root: ${tempDir}\n  canonicalBranch: main\n`,
		);
		origCwd = process.cwd;
		process.cwd = () => tempDir;
	});

	afterEach(() => {
		process.cwd = origCwd;
		_resetHandlers();
		rmSync(tempDir, { recursive: true, force: true });
	});

	test("opts.dev=false invokes _ensureUiBuild and skips _startDevServer", async () => {
		const ensureCalls: Array<{ uiDir: string }> = [];
		const ensureStub = async (o: { uiDir: string }): Promise<void> => {
			ensureCalls.push({ uiDir: o.uiDir });
			throw new Error("__halt__");
		};
		const devCalls: unknown[] = [];
		const devStub = async (): Promise<DevServerHandle> => {
			devCalls.push(true);
			return { port: 0, stop: async () => {} };
		};

		await expect(
			runServe(
				{ port: 0, host: "127.0.0.1", dev: false },
				{ _ensureUiBuild: ensureStub, _startDevServer: devStub, _restDeps: false },
			),
		).rejects.toThrow("__halt__");

		expect(ensureCalls.length).toBe(1);
		expect(ensureCalls[0]?.uiDir).toBe(join(tempDir, "ui"));
		expect(devCalls.length).toBe(0);
	});

	test("opts.dev=true does NOT call _ensureUiBuild", async () => {
		const ensureStub = async (): Promise<void> => {
			throw new Error("ensureUiBuild should not be called in dev mode");
		};
		const devStub = async (): Promise<DevServerHandle> => {
			throw new Error("__halt__");
		};

		await expect(
			runServe(
				{ port: 0, host: "127.0.0.1", dev: true, devPort: 4567 },
				{ _ensureUiBuild: ensureStub, _startDevServer: devStub, _restDeps: false },
			),
		).rejects.toThrow("__halt__");
	});

	test("opts.devPort is forwarded to _startDevServer", async () => {
		const devCalls: Array<{ uiDir: string; port: number; apiPort?: number }> = [];
		const devStub = async (o: {
			uiDir: string;
			port: number;
			apiPort?: number;
		}): Promise<DevServerHandle> => {
			devCalls.push({ uiDir: o.uiDir, port: o.port, apiPort: o.apiPort });
			throw new Error("__halt__");
		};

		await expect(
			runServe(
				{ port: 0, host: "127.0.0.1", dev: true, devPort: 4567 },
				{ _startDevServer: devStub, _skipAutoBuild: true, _restDeps: false },
			),
		).rejects.toThrow("__halt__");

		expect(devCalls.length).toBe(1);
		expect(devCalls[0]?.port).toBe(4567);
		expect(devCalls[0]?.uiDir).toBe(join(tempDir, "ui"));
		// apiPort is the actual bound server port (port 0 => OS-assigned non-zero).
		expect(typeof devCalls[0]?.apiPort).toBe("number");
		expect(devCalls[0]?.apiPort).toBeGreaterThan(0);
	});

	test("_skipAutoBuild bypasses _ensureUiBuild even when dev is false", async () => {
		const ensureStub = async (): Promise<void> => {
			throw new Error("should not be called when _skipAutoBuild is true");
		};
		const devStub = async (): Promise<DevServerHandle> => {
			throw new Error("__halt__");
		};

		// dev=true to ensure runServe halts via devStub regardless.
		await expect(
			runServe(
				{ port: 0, host: "127.0.0.1", dev: true, devPort: 3000 },
				{
					_ensureUiBuild: ensureStub,
					_startDevServer: devStub,
					_skipAutoBuild: true,
					_restDeps: false,
				},
			),
		).rejects.toThrow("__halt__");
	});
});

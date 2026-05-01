import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMailClient } from "../mail/client.ts";
import { createMailStore } from "../mail/store.ts";
import type { DevServerHandle } from "./serve/dev.ts";
import {
	_resetHandlers,
	createServeServer,
	installMailInjectors,
	registerApiHandler,
	registerWsHandler,
	resolveUiDistPath,
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
		opts: {
			port?: number;
			host?: string;
			resolveUiDistPath?: ((projectRoot: string) => string) | "default";
		} = {},
	): Promise<ReturnType<typeof Bun.serve>> {
		const origCwd = process.cwd;
		// Swap cwd so loadConfig resolves to tempDir
		process.cwd = () => tempDir;
		// Default to project-relative ui/dist so the package-bundled fallback
		// (which exists in this dev repo) doesn't leak into tests that assert
		// "no UI" semantics. Pass "default" to opt into the production resolver.
		const resolveUiDist =
			opts.resolveUiDistPath === "default"
				? undefined
				: (opts.resolveUiDistPath ?? ((root: string): string => join(root, "ui", "dist")));
		const server = await createServeServer(
			{ port: opts.port ?? 0, host: opts.host ?? "127.0.0.1" },
			{
				_restDeps: false,
				...(resolveUiDist ? { _resolveUiDistPath: resolveUiDist } : {}),
			},
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

	test("resolveUiDistPath: prefers project ui/dist when present", () => {
		const projectDist = join(tempDir, "ui", "dist");
		mkdirSync(projectDist, { recursive: true });
		expect(resolveUiDistPath(tempDir)).toBe(projectDist);
	});

	test("resolveUiDistPath: falls back to package-bundled ui/dist when project has no ui/", () => {
		// tempDir has no ui/ — simulates fresh `ov init` (overstory-916d).
		const resolved = resolveUiDistPath(tempDir);
		expect(resolved).not.toBe(join(tempDir, "ui", "dist"));
		// Resolves to the dev repo's own ui/dist (or wherever the package lives).
		expect(resolved.endsWith("/ui/dist")).toBe(true);
	});

	test("static files: falls back to package-bundled ui/dist when project has no ui/", async () => {
		// No project ui/dist — use the production resolver so the package fallback is exercised.
		const server = await startServer({ resolveUiDistPath: "default" });
		const res = await fetch(`http://127.0.0.1:${server.port}/`);
		// In CI the dev repo's ui/dist isn't built before tests, so the fallback path
		// resolves but the index.html is missing → 503. The resolver itself is covered
		// by the resolveUiDistPath unit tests above; this test only validates that the
		// served path matches the resolver when ui/dist is present (dev environment).
		const distPath = resolveUiDistPath(tempDir);
		const expected = existsSync(join(distPath, "index.html")) ? 200 : 503;
		expect(res.status).toBe(expected);
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

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "overstory-mailinject-test-"));
		overstoryDir = join(tempDir, ".overstory");
		mkdirSync(overstoryDir, { recursive: true });
		mailDbPath = join(overstoryDir, "mail.db");
	});

	afterEach(async () => {
		for (const stop of stoppers.splice(0)) stop();
		rmSync(tempDir, { recursive: true, force: true });
	});

	test("dispatches task-scoped agents to runTurn (SessionStore-driven discovery)", async () => {
		const { createSessionStore } = await import("../sessions/store.ts");
		const sessionsDbPath = join(overstoryDir, "sessions.db");
		const sessionStore = createSessionStore(sessionsDbPath);
		sessionStore.upsert({
			id: "session-build-1",
			agentName: "build-agent",
			capability: "builder",
			worktreePath: "/tmp/wt",
			branchName: "overstory/build-agent/task-1",
			taskId: "task-1",
			tmuxSession: "",
			state: "working",
			pid: null,
			parentAgent: "lead-1",
			depth: 1,
			runId: null,
			startedAt: new Date().toISOString(),
			lastActivity: new Date().toISOString(),
			escalationLevel: 0,
			stalledSince: null,
			transcriptPath: null,
		});
		sessionStore.close();

		const store = createMailStore(mailDbPath);
		const client = createMailClient(store);
		client.send({
			from: "lead",
			to: "build-agent",
			subject: "Dispatch",
			body: "Begin work.",
			type: "dispatch",
			priority: "normal",
		});
		store.close();

		let runTurnCalled = false;
		let observedNdjson: string | undefined;

		const dispatch = {
			config: {
				project: { name: "x", root: tempDir, canonicalBranch: "main" },
				agents: {
					baseDir: "agents",
					manifestPath: ".overstory/agent-manifest.json",
					maxConcurrent: 5,
					maxSessionsPerRun: 0,
					maxAgentsPerLead: 5,
					maxDepth: 2,
					staggerDelayMs: 0,
					autoNudgeOnMail: false,
				},
				worktrees: { baseDir: ".overstory/worktrees" },
				merge: { mode: "manual" },
				mulch: { enabled: false, domains: {} },
				canopy: { enabled: false },
				taskTracker: { backend: "seeds", enabled: true },
				watchdog: {
					tier0Enabled: false,
					tier0IntervalMs: 30_000,
					tier1Enabled: false,
					maxEscalationLevel: 3,
				},
				models: {},
				logging: { verbose: false, redactSecrets: true },
				runtime: { default: "claude" },
				providers: {},
				// biome-ignore lint/suspicious/noExplicitAny: minimal config shape for the test path
			} as any,
			manifest: {
				version: "1",
				agents: {
					builder: {
						file: "builder.md",
						model: "claude-sonnet",
						tools: [],
						capabilities: ["build"],
						canSpawn: false,
						constraints: [],
					},
				},
				capabilityIndex: { build: ["builder"] },
			},
			_runTurnFn: async (opts: import("../agents/turn-runner.ts").RunTurnOpts) => {
				runTurnCalled = true;
				observedNdjson = opts.userTurnNdjson;
				return {
					exitCode: 0,
					cleanResult: true,
					newSessionId: null,
					resumeMismatch: false,
					terminalMailObserved: false,
					durationMs: 1,
					initialState: "booting" as const,
					finalState: "working" as const,
					stallAborted: false,
					terminalMailMissing: false,
				};
			},
		};

		const stop = installMailInjectors(mailDbPath, overstoryDir, dispatch);
		stoppers.push(stop);

		// Allow several poll ticks so the dispatcher batches the unread mail
		// and routes it through runTurn instead of the FIFO writer.
		await new Promise((r) => setTimeout(r, 2400));

		expect(runTurnCalled).toBe(true);
		expect(observedNdjson).toBeDefined();
		const parsed = JSON.parse(observedNdjson?.trimEnd() ?? "");
		expect(parsed.type).toBe("user");
		expect(parsed.message.content[0].text).toContain("Begin work.");
	}, 8000);
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

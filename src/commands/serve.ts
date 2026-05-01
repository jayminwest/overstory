/**
 * CLI command: ov serve [--port <n>] [--host <addr>]
 *
 * Starts an HTTP server backed by Bun.serve. Serves:
 *  - /healthz         — JSON health envelope (always available)
 *  - /api/*           — REST handlers registered via registerApiHandler()
 *  - /ws              — WebSocket upgrade registered via registerWsHandler()
 *  - everything else  — static files from ui/dist/ with SPA fallback to index.html
 *
 * Route registration is intentionally modular: future streams add REST/WebSocket
 * support by calling the exported register*() helpers — no changes to this file needed.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import { startTurnRunnerMailLoop, type TurnRunnerFn } from "../agents/headless-mail-injector.ts";
import { createManifestLoader } from "../agents/manifest.ts";
import { runTurn } from "../agents/turn-runner.ts";
import { buildRunTurnOptsFactory, isSpawnPerTurnAgent } from "../agents/turn-runner-dispatch.ts";
import { loadConfig } from "../config.ts";
import { ValidationError } from "../errors.ts";
import { apiJson, jsonError, jsonOutput } from "../json.ts";
import { printError, printSuccess } from "../logging/color.ts";
import { openSessionStore } from "../sessions/compat.ts";
import type { AgentManifest, OverstoryConfig } from "../types.ts";
import { ensureUiBuild } from "./serve/build.ts";
import { type DevServerHandle, startDevServer } from "./serve/dev.ts";
import { type RestApiDeps, registerRestApi } from "./serve/rest.ts";
import { serveStatic } from "./serve/static.ts";
import { installBroadcaster } from "./serve/ws.ts";

/**
 * Default TCP port for `ov serve`. 8080 collides with Colima's SSH mux tunnel
 * (and Tomcat/Jenkins/Docker dev proxies); the kernel routes to *:8080 vs.
 * 127.0.0.1:8080 inconsistently, so users saw foreign error JSON instead of
 * the overstory UI (overstory-eaba). 7321 is unassigned and easy to type.
 */
export const DEFAULT_SERVE_PORT = 7321;

// === Extensible route registry ===

/** Handler for /api/* routes. Return null to fall through to the next handler. */
export type ApiHandler = (req: Request) => Response | Promise<Response> | null;

/** Handler for WebSocket upgrade on /ws. */
export type WsHandler = {
	open?: (ws: ServerWebSocket) => void;
	message?: (ws: ServerWebSocket, message: string | Buffer) => void;
	close?: (ws: ServerWebSocket, code: number, reason: string) => void;
	/** Return upgrade data (passed to ws.data) or null to reject with HTTP 400. */
	getUpgradeData?: (req: Request) => unknown | null;
};

// ServerWebSocket is a Bun built-in — use the global type alias
type ServerWebSocket = import("bun").ServerWebSocket<unknown>;

const _apiHandlers: ApiHandler[] = [];
let _wsHandler: WsHandler | undefined;

/**
 * Register an API route handler for requests under /api/*.
 * Handlers are tried in registration order; first non-null response wins.
 * Intended for use by future streams (REST endpoints, etc.).
 */
export function registerApiHandler(handler: ApiHandler): void {
	_apiHandlers.push(handler);
}

/**
 * Register the WebSocket handler for /ws upgrades.
 * Only one handler may be active; subsequent calls replace the previous one.
 * Intended for use by the WebSocket broadcaster stream.
 */
export function registerWsHandler(handler: WsHandler): void {
	_wsHandler = handler;
}

/** Reset registered handlers (test isolation only). */
export function _resetHandlers(): void {
	_apiHandlers.length = 0;
	_wsHandler = undefined;
}

// === Core server logic ===

export interface ServeOptions {
	port?: number;
	host?: string;
	json?: boolean;
	/** When true, also start the Vite-style dev UI server (HMR, /api+/ws proxy). */
	dev?: boolean;
	/** Dev UI port. Ignored unless dev is true. Default 3000. */
	devPort?: number;
}

/** Dependencies injectable for testing. */
export interface ServeDeps {
	_loadConfig?: typeof loadConfig;
	_existsSync?: typeof existsSync;
	_readFile?: (path: string) => Promise<Uint8Array>;
	/** REST store deps. Pass false to skip REST registration (test isolation). */
	_restDeps?: RestApiDeps | false;
	_ensureUiBuild?: typeof ensureUiBuild;
	_startDevServer?: typeof startDevServer;
	/** Skip the auto-build step entirely (test isolation). */
	_skipAutoBuild?: boolean;
	/**
	 * Override ui/dist resolution. Default prefers `<projectRoot>/ui/dist`,
	 * falling back to the prebuilt assets shipped inside the npm package. Tests
	 * pass a stub returning a non-existent path to force the 503 branch in
	 * serveStatic without depending on the dev repo's package layout.
	 */
	_resolveUiDistPath?: (projectRoot: string) => string;
}

/**
 * Resolve the directory containing built UI assets. Prefers the project's own
 * `ui/dist` (so overstory dev builds and project-local UI overrides win), and
 * falls back to the prebuilt `ui/dist` shipped inside @os-eco/overstory-cli
 * for production installs that have no `ui/` workspace (overstory-916d).
 */
export function resolveUiDistPath(
	projectRoot: string,
	_exists: typeof existsSync = existsSync,
): string {
	const projectDist = join(projectRoot, "ui", "dist");
	if (_exists(projectDist)) return projectDist;
	return new URL("../../ui/dist", import.meta.url).pathname;
}

/** Read the package version once at module load to avoid circular imports with index.ts. */
const _pkgVersion = (): string => {
	try {
		const raw = readFileSync(new URL("../../package.json", import.meta.url).pathname, "utf-8");
		return (JSON.parse(raw) as { version: string }).version;
	} catch {
		return "unknown";
	}
};
const SERVE_VERSION = _pkgVersion();

/**
 * Build and return a Bun server instance without binding to process signals.
 * Used by tests to control lifecycle directly.
 */
export async function createServeServer(
	opts: ServeOptions,
	deps: ServeDeps = {},
): Promise<ReturnType<typeof Bun.serve>> {
	const _cfg = deps._loadConfig ?? loadConfig;
	const _exists = deps._existsSync ?? existsSync;

	const cwd = process.cwd();
	const config = await _cfg(cwd);

	const port = opts.port ?? DEFAULT_SERVE_PORT;
	const hostname = opts.host ?? "127.0.0.1";
	const _resolveUiDist = deps._resolveUiDistPath ?? resolveUiDistPath;
	const uiDistPath = _resolveUiDist(config.project.root);
	const startTime = performance.now();

	// Register REST handlers before Bun.serve() — skip only for test isolation
	if (deps._restDeps !== false) {
		registerRestApi({ _projectRoot: config.project.root, ...(deps._restDeps ?? {}) });
	}

	const server = Bun.serve({
		port,
		hostname,
		fetch: async (req: Request, srv: ReturnType<typeof Bun.serve>): Promise<Response> => {
			const url = new URL(req.url);
			const path = url.pathname;

			// /healthz — always handled here
			if (path === "/healthz") {
				return apiJson({
					status: "ok",
					uptimeMs: Math.round(performance.now() - startTime),
					version: SERVE_VERSION,
				});
			}

			// /ws — WebSocket upgrade
			if (path === "/ws") {
				if (_wsHandler === undefined) {
					return new Response(
						JSON.stringify({ success: false, command: "serve", error: "WebSocket not available" }),
						{ status: 404, headers: { "Content-Type": "application/json" } },
					);
				}
				const upgradeData = _wsHandler.getUpgradeData?.(req);
				if (upgradeData === null) {
					return new Response(
						JSON.stringify({
							success: false,
							command: "serve",
							error: "Missing run or agent query parameter",
						}),
						{ status: 400, headers: { "Content-Type": "application/json" } },
					);
				}
				const upgraded = srv.upgrade(req, { data: upgradeData });
				if (upgraded) {
					return new Response(null, { status: 101 });
				}
				return new Response(
					JSON.stringify({ success: false, command: "serve", error: "WebSocket upgrade failed" }),
					{ status: 500, headers: { "Content-Type": "application/json" } },
				);
			}

			// /api/* — delegated to registered API handlers
			if (path.startsWith("/api/")) {
				for (const handler of _apiHandlers) {
					const res = await handler(req);
					if (res !== null) {
						return res;
					}
				}
				return new Response(
					JSON.stringify({ success: false, command: "serve", error: "Not found" }),
					{
						status: 404,
						headers: { "Content-Type": "application/json" },
					},
				);
			}

			// Static files from ui/dist/ with SPA fallback and path-traversal guard
			return serveStatic(path, uiDistPath, _exists);
		},
		websocket: {
			open(ws) {
				_wsHandler?.open?.(ws);
			},
			message(ws, message) {
				_wsHandler?.message?.(ws, message as string | Buffer);
			},
			close(ws, code, reason) {
				_wsHandler?.close?.(ws, code, reason);
			},
		},
	});

	return server;
}

/**
 * Install per-agent mail injection loops, driven by filesystem discovery of
 * stdin FIFOs.
 *
 * Replaces the UserPromptSubmit hook for headless Claude agents: each agent
 * spawned by `ov sling` mkfifos a `{overstoryDir}/agents/{name}/stdin.fifo`,
 * and `ov serve` watches that directory. For every FIFO it sees, the server
 * starts a polling loop that opens the FIFO, writes any unread mail as a
 * stream-json user turn, then closes. Loops are torn down when the FIFO file
 * disappears (agent terminated + cleanup ran), when the writer reports
 * "no-reader" (agent died but cleanup hasn't run), or on graceful shutdown.
 *
 * The cross-process design — file-on-disk vs in-memory registry — is essential
 * because `ov sling` and `ov serve` are separate processes. The earlier
 * connection-registry design only worked when serve and sling shared a process,
 * which is never the case in production. See overstory-41eb.
 */
/** Optional spawn-per-turn dispatch context for `installMailInjectors`. */
export interface MailInjectorDispatchDeps {
	config: OverstoryConfig;
	manifest: AgentManifest;
	/** Test injection: replaces `runTurn`. */
	_runTurnFn?: TurnRunnerFn;
}

/**
 * Attempt to start the spawn-per-turn dispatcher for one agent. Returns the
 * stop function on success, or null when the agent is not eligible (capability
 * gate, flag off, terminal state, missing session row, or runtime can't drive
 * a direct spawn).
 */
function tryInstallTurnRunnerLoop(
	agentName: string,
	mailDbPath: string,
	overstoryDir: string,
	dispatch: MailInjectorDispatchDeps,
): (() => void) | null {
	const { store } = openSessionStore(overstoryDir);
	let session: ReturnType<typeof store.getByName>;
	try {
		session = store.getByName(agentName);
	} finally {
		store.close();
	}
	if (!session) return null;

	let factory: ReturnType<typeof buildRunTurnOptsFactory>;
	try {
		factory = buildRunTurnOptsFactory({
			session,
			config: dispatch.config,
			manifest: dispatch.manifest,
			overstoryDir,
		});
	} catch {
		return null;
	}

	if (!isSpawnPerTurnAgent(session, dispatch.config, factory.runtime)) return null;

	const runTurnFn = dispatch._runTurnFn ?? runTurn;
	// Per-tick liveness check: re-read SessionStore on every poll so that
	// `ov stop` (which writes state=completed within ~milliseconds) is observed
	// before the 5s rescan reaps the loop. Without this guard, the 2s tick
	// could dispatch a fresh runTurn against the stopped agent during the
	// rescan window (overstory-eb7c).
	const isAgentLive = (): boolean => {
		const { store: liveStore } = openSessionStore(overstoryDir);
		try {
			const live = liveStore.getByName(agentName);
			if (!live) return false;
			return live.state !== "completed" && live.state !== "zombie";
		} finally {
			liveStore.close();
		}
	};
	return startTurnRunnerMailLoop(
		agentName,
		factory.build,
		runTurnFn,
		mailDbPath,
		undefined,
		isAgentLive,
	);
}

/**
 * Install per-agent mail injection loops driven by the spawn-per-turn engine.
 *
 * Discovers agents from SessionStore (rather than from a per-agent FIFO file
 * — Phase 3 deletes the FIFO infrastructure). Sessions in non-terminal state
 * with a task-scoped capability get a `runTurn`-driven mail dispatcher; loops
 * auto-stop when the session transitions to `completed`/`zombie`.
 *
 * `dispatch` is required: under Phase 3 spawn-per-turn is the only mail
 * injection mechanism for headless Claude. When called without dispatch (e.g.
 * in tests that don't exercise mail), the function still returns a no-op stop.
 */
export function installMailInjectors(
	mailDbPath: string,
	overstoryDir: string,
	dispatch?: MailInjectorDispatchDeps,
): () => void {
	const activeLoops = new Map<string, () => void>();

	if (dispatch === undefined) {
		// No manifest available — no spawn-per-turn dispatch possible. Return a
		// no-op stop so callers can wire shutdown unconditionally.
		return function noopStopMailInjectors(): void {};
	}

	const startLoopFor = (agentName: string): void => {
		if (activeLoops.has(agentName)) return;
		const turnLoop = tryInstallTurnRunnerLoop(agentName, mailDbPath, overstoryDir, dispatch);
		if (turnLoop === null) return;
		activeLoops.set(agentName, () => {
			turnLoop();
			activeLoops.delete(agentName);
		});
	};

	const stopLoopFor = (agentName: string): void => {
		activeLoops.get(agentName)?.();
	};

	// Discover non-terminal agents from SessionStore. Each rescan re-checks
	// every agent's state so loops auto-stop on completed/zombie.
	const scan = (): void => {
		const { store } = openSessionStore(overstoryDir);
		let sessions: ReturnType<typeof store.getAll>;
		try {
			sessions = store.getAll();
		} finally {
			store.close();
		}
		const liveNames = new Set<string>();
		for (const session of sessions) {
			if (session.state === "completed" || session.state === "zombie") continue;
			liveNames.add(session.agentName);
			startLoopFor(session.agentName);
		}
		// Reap loops whose sessions transitioned to a terminal state.
		for (const name of [...activeLoops.keys()]) {
			if (!liveNames.has(name)) {
				stopLoopFor(name);
			}
		}
	};
	scan();

	const rescanTimer = setInterval(scan, 5000);

	return function stopMailInjectors(): void {
		clearInterval(rescanTimer);
		for (const stop of [...activeLoops.values()]) stop();
		activeLoops.clear();
	};
}

/**
 * Core implementation for `ov serve`. Starts the server and blocks until
 * SIGINT/SIGTERM. Handles graceful shutdown.
 */
export async function runServe(opts: ServeOptions, deps: ServeDeps = {}): Promise<void> {
	const _cfg = deps._loadConfig ?? loadConfig;
	const config = await _cfg(process.cwd());

	const overstoryDir = join(config.project.root, ".overstory");
	const mailDbPath = join(overstoryDir, "mail.db");
	const uiDir = join(config.project.root, "ui");

	// Production mode: ensure ui/dist is current before binding the port.
	// In dev mode, skip the prebuilt assets entirely — the dev server owns
	// the UI surface and reads ui/src directly.
	const _ensureUi = deps._ensureUiBuild ?? ensureUiBuild;
	if (!opts.dev && deps._skipAutoBuild !== true) {
		await _ensureUi({ uiDir });
	}

	// Install broadcaster before Bun.serve so handler is ready for the first request
	const stopBroadcaster = installBroadcaster({
		eventsDbPath: join(overstoryDir, "events.db"),
		mailDbPath,
	});

	// Install per-agent mail injection loops (UserPromptSubmit hook equivalent
	// for headless Claude agents). Discovers task-scoped agents from
	// SessionStore and dispatches each batch of unread mail through `runTurn`,
	// which spawns a fresh claude with --resume per turn (Phase 3 spawn-per-turn).
	const manifestLoader = createManifestLoader(
		join(config.project.root, config.agents.manifestPath),
		join(config.project.root, config.agents.baseDir),
	);
	let manifest: AgentManifest | undefined;
	try {
		manifest = await manifestLoader.load();
	} catch {
		// Non-fatal: missing manifest just means the spawn-per-turn dispatcher
		// stays disabled and every agent uses the legacy FIFO loop.
		manifest = undefined;
	}
	const stopMailInjectors = installMailInjectors(
		mailDbPath,
		overstoryDir,
		manifest ? { config, manifest } : undefined,
	);

	const server = await createServeServer(opts, deps);

	let dev: DevServerHandle | undefined;
	if (opts.dev) {
		const _startDev = deps._startDevServer ?? startDevServer;
		dev = await _startDev({
			uiDir,
			port: opts.devPort ?? 3000,
			apiPort: server.port,
			apiHost: server.hostname,
		});
	}

	const useJson = opts.json ?? false;
	const apiUrl = `http://${server.hostname}:${server.port}`;
	if (useJson) {
		jsonOutput("serve", {
			status: "started",
			port: server.port,
			hostname: server.hostname,
			url: apiUrl,
			...(dev ? { devUrl: `http://127.0.0.1:${dev.port}` } : {}),
		});
	} else {
		printSuccess(`ov serve listening on ${apiUrl}`);
		if (dev) {
			printSuccess(`ov serve dev UI on http://127.0.0.1:${dev.port}`);
		}
	}

	// Graceful shutdown handler
	const shutdown = (): void => {
		if (!useJson) {
			process.stdout.write("\nShutting down...\n");
		}
		// Stop the dev server first so the upstream WebSocket pump drains
		// before we tear down the broadcaster + main server.
		const stopDev = dev ? dev.stop() : Promise.resolve();
		stopDev
			.catch(() => {
				// Best-effort stop — surface nothing on failure.
			})
			.finally(() => {
				stopMailInjectors();
				stopBroadcaster();
				server.stop(true);
				process.exit(0);
			});
	};

	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);

	// Block indefinitely — the server keeps the process alive via Bun's event loop
	await new Promise<void>(() => {});
}

/**
 * Create the Commander command for `ov serve`.
 */
export function createServeCommand(): Command {
	return new Command("serve")
		.description("Start the HTTP server (static UI + /healthz + /api/* + /ws)")
		.option("--port <n>", "TCP port to listen on", String(DEFAULT_SERVE_PORT))
		.option("--host <addr>", "Host/address to bind", "127.0.0.1")
		.option("--dev", "Also start the dev UI server with HMR + API/WS proxy")
		.option("--dev-port <n>", "Dev UI port (only with --dev)", "3000")
		.option("--json", "Output startup info as JSON")
		.action(
			async (opts: {
				port?: string;
				host?: string;
				dev?: boolean;
				devPort?: string;
				json?: boolean;
			}) => {
				const port = opts.port !== undefined ? Number.parseInt(opts.port, 10) : DEFAULT_SERVE_PORT;
				const devPort = opts.devPort !== undefined ? Number.parseInt(opts.devPort, 10) : 3000;
				try {
					if (Number.isNaN(port) || port < 1 || port > 65535) {
						throw new ValidationError(`Invalid port: ${opts.port ?? "undefined"}`, {
							field: "port",
							value: opts.port,
						});
					}
					if (Number.isNaN(devPort) || devPort < 1 || devPort > 65535) {
						throw new ValidationError(`Invalid dev port: ${opts.devPort ?? "undefined"}`, {
							field: "devPort",
							value: opts.devPort,
						});
					}
					await runServe({
						port,
						host: opts.host ?? "127.0.0.1",
						json: opts.json,
						dev: opts.dev ?? false,
						devPort,
					});
				} catch (err: unknown) {
					const msg = err instanceof Error ? err.message : String(err);
					if (opts.json) {
						jsonError("serve", msg);
					} else {
						printError(`ov serve failed: ${msg}`);
					}
					process.exitCode = 1;
				}
			},
		);
}

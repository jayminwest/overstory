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

import { existsSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import { loadConfig } from "../config.ts";
import { jsonError, jsonOutput } from "../json.ts";
import { printError, printSuccess } from "../logging/color.ts";

// === Extensible route registry ===

/** Handler for /api/* routes. Return null to fall through to the next handler. */
export type ApiHandler = (req: Request) => Response | Promise<Response> | null;

/** Handler for WebSocket upgrade on /ws. */
export type WsHandler = {
	open?: (ws: ServerWebSocket) => void;
	message?: (ws: ServerWebSocket, message: string | Buffer) => void;
	close?: (ws: ServerWebSocket, code: number, reason: string) => void;
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
}

/** Dependencies injectable for testing. */
export interface ServeDeps {
	_loadConfig?: typeof loadConfig;
	_existsSync?: typeof existsSync;
	_readFile?: (path: string) => Promise<Uint8Array>;
}

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

	const port = opts.port ?? 8080;
	const hostname = opts.host ?? "127.0.0.1";
	const uiDistPath = join(config.project.root, "ui", "dist");

	const server = Bun.serve({
		port,
		hostname,
		fetch: async (req: Request, srv: ReturnType<typeof Bun.serve>): Promise<Response> => {
			const url = new URL(req.url);
			const path = url.pathname;

			// /healthz — always handled here
			if (path === "/healthz") {
				return new Response(JSON.stringify({ success: true, command: "serve", status: "ok" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}

			// /ws — WebSocket upgrade
			if (path === "/ws") {
				if (_wsHandler !== undefined) {
					const upgraded = srv.upgrade(req, { data: undefined });
					if (upgraded) {
						return new Response(null, { status: 101 });
					}
				}
				return new Response("WebSocket not available", { status: 404 });
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

			// Static files from ui/dist/ with SPA fallback
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
 * Serve a static file from uiDistPath, falling back to index.html for SPA routes.
 */
async function serveStatic(
	path: string,
	uiDistPath: string,
	_exists: typeof existsSync,
): Promise<Response> {
	if (!_exists(uiDistPath)) {
		return new Response("UI not built — run the UI build first", { status: 503 });
	}

	// Normalise path: strip leading slash, default to index.html
	const stripped = path.replace(/^\//, "") || "index.html";
	const filePath = join(uiDistPath, stripped);

	const file = Bun.file(filePath);
	if (await file.exists()) {
		return new Response(file);
	}

	// SPA fallback: any unknown path → index.html
	const indexPath = join(uiDistPath, "index.html");
	const indexFile = Bun.file(indexPath);
	if (await indexFile.exists()) {
		return new Response(indexFile, {
			headers: { "Content-Type": "text/html; charset=utf-8" },
		});
	}

	return new Response("Not found", { status: 404 });
}

/**
 * Core implementation for `ov serve`. Starts the server and blocks until
 * SIGINT/SIGTERM. Handles graceful shutdown.
 */
export async function runServe(opts: ServeOptions, deps: ServeDeps = {}): Promise<void> {
	const server = await createServeServer(opts, deps);

	const useJson = opts.json ?? false;
	if (useJson) {
		jsonOutput("serve", {
			status: "started",
			port: server.port,
			hostname: server.hostname,
			url: `http://${server.hostname}:${server.port}`,
		});
	} else {
		printSuccess(`ov serve listening on http://${server.hostname}:${server.port}`);
	}

	// Graceful shutdown handler
	const shutdown = (): void => {
		if (!useJson) {
			process.stdout.write("\nShutting down...\n");
		}
		server.stop(true);
		process.exit(0);
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
		.option("--port <n>", "TCP port to listen on", "8080")
		.option("--host <addr>", "Host/address to bind", "127.0.0.1")
		.option("--json", "Output startup info as JSON")
		.action(async (opts: { port?: string; host?: string; json?: boolean }) => {
			const port = opts.port !== undefined ? Number.parseInt(opts.port, 10) : 8080;
			if (Number.isNaN(port) || port < 1 || port > 65535) {
				if (opts.json) {
					jsonError("serve", `Invalid port: ${opts.port}`);
				} else {
					printError(`Invalid port: ${opts.port}`);
				}
				process.exitCode = 1;
				return;
			}

			try {
				await runServe({ port, host: opts.host ?? "127.0.0.1", json: opts.json });
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				if (opts.json) {
					jsonError("serve", msg);
				} else {
					printError(`ov serve failed: ${msg}`);
				}
				process.exitCode = 1;
			}
		});
}

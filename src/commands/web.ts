/**
 * CLI command: overstory web [--port <port>] [--background]
 *
 * Starts the Overstory web dashboard server using Bun.serve() with native WebSocket support.
 * Background mode spawns a detached process via Bun.spawn and writes a PID file.
 * Default port is 3000.
 */

import { Database } from "bun:sqlite";
import { join, resolve } from "node:path";
import { loadConfig } from "../config.ts";
import { OverstoryError } from "../errors.ts";
import { isProcessRunning } from "../watchdog/health.ts";

/**
 * Parse a named flag value from args.
 */
function getFlag(args: string[], flag: string): string | undefined {
	const idx = args.indexOf(flag);
	if (idx === -1 || idx + 1 >= args.length) {
		return undefined;
	}
	return args[idx + 1];
}

function hasFlag(args: string[], flag: string): boolean {
	return args.includes(flag);
}

/**
 * Read the PID from the web server PID file.
 * Returns null if the file doesn't exist or can't be parsed.
 */
async function readPidFile(pidFilePath: string): Promise<number | null> {
	const file = Bun.file(pidFilePath);
	const exists = await file.exists();
	if (!exists) {
		return null;
	}

	try {
		const text = await file.text();
		const pid = Number.parseInt(text.trim(), 10);
		if (Number.isNaN(pid) || pid <= 0) {
			return null;
		}
		return pid;
	} catch {
		return null;
	}
}

/**
 * Write a PID to the web server PID file.
 */
async function writePidFile(pidFilePath: string, pid: number): Promise<void> {
	await Bun.write(pidFilePath, `${pid}\n`);
}

/**
 * Remove the web server PID file.
 */
async function removePidFile(pidFilePath: string): Promise<void> {
	const { unlink } = await import("node:fs/promises");
	try {
		await unlink(pidFilePath);
	} catch {
		// File may already be gone — not an error
	}
}

/**
 * Resolve the path to the overstory binary for re-launching.
 * Uses `which overstory` first, then falls back to process.argv.
 */
async function resolveOverstoryBin(): Promise<string> {
	try {
		const proc = Bun.spawn(["which", "overstory"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const exitCode = await proc.exited;
		if (exitCode === 0) {
			const binPath = (await new Response(proc.stdout).text()).trim();
			if (binPath.length > 0) {
				return binPath;
			}
		}
	} catch {
		// which not available or overstory not on PATH
	}

	// Fallback: use the script that's currently running (process.argv[1])
	const scriptPath = process.argv[1];
	if (scriptPath) {
		return scriptPath;
	}

	throw new OverstoryError(
		"Cannot resolve overstory binary path for background launch",
		"WEB_ERROR",
	);
}

// ── Dashboard API helpers ──

/**
 * Sanitize a string to allow only safe identifier characters.
 */
function safe(str: string | null | undefined): string {
	if (!str || typeof str !== "string") return "";
	return str.replace(/[^a-zA-Z0-9_\-.]/g, "");
}

const MIME: Record<string, string> = {
	".html": "text/html",
	".css": "text/css",
	".js": "application/javascript",
	".json": "application/json",
	".png": "image/png",
	".jpg": "image/jpeg",
	".gif": "image/gif",
	".svg": "image/svg+xml",
	".wav": "audio/wav",
	".mp3": "audio/mpeg",
	".ogg": "audio/ogg",
	".ico": "image/x-icon",
	".woff2": "font/woff2",
	".woff": "font/woff",
	".ttf": "font/ttf",
};

/**
 * Open a SQLite database in readonly mode. Returns null if the file doesn't exist.
 */
function openReadonlyDb(root: string, dbFile: string): Database | null {
	const dbPath = join(root, ".overstory", dbFile);
	try {
		return new Database(dbPath, { readonly: true });
	} catch {
		return null;
	}
}

/**
 * Execute an overstory CLI command and parse the JSON output.
 */
async function execOs(root: string, cmd: string[]): Promise<unknown> {
	try {
		const proc = Bun.spawn(cmd, {
			cwd: root,
			stdout: "pipe",
			stderr: "pipe",
		});
		await proc.exited;
		const raw = (await new Response(proc.stdout).text()).trim();
		return raw ? (JSON.parse(raw) as unknown) : {};
	} catch (e: unknown) {
		return { error: e instanceof Error ? e.message : String(e) };
	}
}

/**
 * Handle all /dash/api/* routes.
 */
async function handleDashApi(urlPath: string, fullUrl: string, root: string): Promise<Response> {
	const route = urlPath.replace("/dash/api/", "");
	const [cmd, ...rest] = route.split("/");
	const param = safe(rest.join("/"));
	const url = new URL(fullUrl, "http://localhost");

	const jsonResponse = (data: unknown): Response =>
		new Response(JSON.stringify(data), {
			headers: { "Content-Type": "application/json", "Cache-Control": "no-cache" },
		});

	switch (cmd) {
		case "status":
			return jsonResponse(await execOs(root, ["overstory", "status", "--json"]));

		case "sessions": {
			const db = openReadonlyDb(root, "sessions.db");
			if (!db) return jsonResponse([]);
			try {
				return jsonResponse(
					db
						.prepare(
							"SELECT * FROM sessions ORDER BY CASE WHEN state IN ('working','booting','stalled') THEN 0 ELSE 1 END, started_at DESC",
						)
						.all(),
				);
			} finally {
				db.close();
			}
		}

		case "mail": {
			const db = openReadonlyDb(root, "mail.db");
			if (!db) return jsonResponse([]);
			try {
				if (param) {
					return jsonResponse(
						db.prepare("SELECT * FROM messages WHERE id = $id").all({ $id: param }),
					);
				}
				const from = safe(url.searchParams.get("from"));
				const to = safe(url.searchParams.get("to"));
				const agent = safe(url.searchParams.get("agent"));
				const limitRaw = Number.parseInt(url.searchParams.get("limit") ?? "100", 10);
				const limit = Math.min(Number.isNaN(limitRaw) ? 100 : limitRaw, 500);
				const conditions: string[] = [];
				const params: Record<string, string | number> = {};
				if (from) {
					conditions.push("from_agent = $from");
					params.$from = from;
				}
				if (to) {
					conditions.push("to_agent = $to");
					params.$to = to;
				}
				if (agent) {
					conditions.push("(from_agent = $agent OR to_agent = $agent)");
					params.$agent = agent;
				}
				if (url.searchParams.get("unread") === "true") {
					conditions.push("read = 0");
				}
				const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
				params.$limit = limit;
				return jsonResponse(
					db
						.prepare(`SELECT * FROM messages ${whereClause} ORDER BY created_at DESC LIMIT $limit`)
						.all(params),
				);
			} finally {
				db.close();
			}
		}

		case "inspect":
			if (!param) return jsonResponse({ error: "Agent name required" });
			return jsonResponse(await execOs(root, ["overstory", "inspect", param, "--json"]));

		case "trace": {
			if (!param) return jsonResponse({ error: "Agent name required" });
			const db = openReadonlyDb(root, "events.db");
			if (!db) return jsonResponse([]);
			try {
				return jsonResponse(
					db
						.prepare(
							"SELECT * FROM events WHERE agent_name = $agent_name ORDER BY created_at DESC LIMIT 200",
						)
						.all({ $agent_name: param }),
				);
			} finally {
				db.close();
			}
		}

		case "tmux": {
			if (!param) {
				return new Response("Agent name required", { status: 400 });
			}
			const db = openReadonlyDb(root, "sessions.db");
			if (!db) {
				return new Response("[No active tmux session]", {
					headers: { "Content-Type": "text/plain" },
				});
			}
			let tmuxSession: string | undefined;
			try {
				const row = db
					.prepare<{ tmux_session: string }, { $agent_name: string }>(
						"SELECT tmux_session FROM sessions WHERE agent_name = $agent_name AND state IN ('working','booting','stalled')",
					)
					.get({ $agent_name: param });
				tmuxSession = row?.tmux_session;
			} catch (e: unknown) {
				return new Response(`[Error: ${e instanceof Error ? e.message : String(e)}]`, {
					headers: { "Content-Type": "text/plain" },
				});
			} finally {
				db.close();
			}

			if (tmuxSession) {
				const safeSession = safe(tmuxSession);
				const proc = Bun.spawn(["tmux", "capture-pane", "-t", safeSession, "-p", "-S", "-500"], {
					stdout: "pipe",
					stderr: "pipe",
				});
				await proc.exited;
				const pane = await new Response(proc.stdout).text();
				return new Response(pane || "[Session not active]", {
					headers: { "Content-Type": "text/plain", "Cache-Control": "no-cache" },
				});
			}
			return new Response("[No active tmux session]", {
				headers: { "Content-Type": "text/plain" },
			});
		}

		case "merge-queue": {
			const db = openReadonlyDb(root, "merge-queue.db");
			if (!db) return jsonResponse([]);
			try {
				return jsonResponse(db.prepare("SELECT * FROM merge_queue ORDER BY id DESC").all());
			} finally {
				db.close();
			}
		}

		case "events": {
			const evLimitRaw = Number.parseInt(url.searchParams.get("limit") ?? "100", 10);
			const evLimit = Math.min(Number.isNaN(evLimitRaw) ? 100 : evLimitRaw, 500);
			const level = safe(url.searchParams.get("level"));
			const db = openReadonlyDb(root, "events.db");
			if (!db) return jsonResponse([]);
			try {
				const conditions: string[] = [];
				const params: Record<string, string | number> = {};
				if (level) {
					conditions.push("level = $level");
					params.$level = level;
				}
				const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
				params.$limit = evLimit;
				return jsonResponse(
					db
						.prepare(`SELECT * FROM events ${whereClause} ORDER BY created_at DESC LIMIT $limit`)
						.all(params),
				);
			} finally {
				db.close();
			}
		}

		case "errors": {
			const db = openReadonlyDb(root, "events.db");
			if (!db) return jsonResponse([]);
			try {
				return jsonResponse(
					db
						.prepare("SELECT * FROM events WHERE level='error' ORDER BY created_at DESC LIMIT 50")
						.all(),
				);
			} finally {
				db.close();
			}
		}

		case "metrics": {
			const db = openReadonlyDb(root, "metrics.db");
			if (!db) return jsonResponse([]);
			try {
				return jsonResponse(db.prepare("SELECT * FROM sessions ORDER BY started_at DESC").all());
			} finally {
				db.close();
			}
		}

		case "groups":
			return jsonResponse(await execOs(root, ["overstory", "group", "list", "--json"]));

		case "runs":
			return jsonResponse(await execOs(root, ["overstory", "run", "list", "--json"]));

		case "terminal-start": {
			try {
				// Strip CLAUDECODE env var so claude CLI doesn't refuse to start
				const cleanEnv: Record<string, string> = {};
				for (const [key, value] of Object.entries(process.env)) {
					if (key !== "CLAUDECODE" && key !== "CLAUDE_CODE_ENTRYPOINT" && value !== undefined) {
						cleanEnv[key] = value;
					}
				}

				// Ensure tmux server is running
				const tmuxCheck = Bun.spawn(["tmux", "has-session"], {
					stdout: "pipe",
					stderr: "pipe",
					env: cleanEnv,
				});
				const tmuxCheckCode = await tmuxCheck.exited;
				if (tmuxCheckCode !== 0) {
					const tmuxNew = Bun.spawn(["tmux", "new-session", "-d", "-s", "overstory-default"], {
						stdout: "pipe",
						stderr: "pipe",
						env: cleanEnv,
					});
					await tmuxNew.exited;
				}

				// Start the coordinator
				const coordProc = Bun.spawn(["overstory", "coordinator", "start", "--no-attach"], {
					cwd: root,
					stdout: "pipe",
					stderr: "pipe",
					env: cleanEnv,
				});
				await coordProc.exited;

				const db = openReadonlyDb(root, "sessions.db");
				let tmuxSession: string | null = null;
				if (db) {
					try {
						const row = db
							.prepare<{ tmux_session: string }, Record<string, never>>(
								"SELECT tmux_session FROM sessions WHERE agent_name='orchestrator' AND state IN ('working','booting') ORDER BY started_at DESC LIMIT 1",
							)
							.get({});
						tmuxSession = row?.tmux_session ?? null;
					} finally {
						db.close();
					}
				}

				return jsonResponse({ ok: true, tmux_session: tmuxSession });
			} catch (e: unknown) {
				return jsonResponse({
					error: e instanceof Error ? e.message : String(e),
				});
			}
		}

		case "usage": {
			try {
				const usageHelper = join(import.meta.dir, "../../dashboard/usage.ts");
				const proc = Bun.spawn(["bun", usageHelper, root], {
					cwd: root,
					stdout: "pipe",
					stderr: "pipe",
				});
				await proc.exited;
				const raw = (await new Response(proc.stdout).text()).trim();
				return jsonResponse(raw ? (JSON.parse(raw) as unknown) : { error: "empty" });
			} catch (e: unknown) {
				return jsonResponse({
					error: e instanceof Error ? e.message : String(e),
				});
			}
		}

		default:
			return new Response(JSON.stringify({ error: "Unknown endpoint" }), {
				status: 404,
				headers: { "Content-Type": "application/json" },
			});
	}
}

/**
 * Serve static files from the dashboard/ directory.
 */
async function handleStatic(urlPath: string): Promise<Response> {
	// dashboard/ dir is at ../../dashboard relative to src/commands/web.ts
	const dashboardDir = join(import.meta.dir, "../../dashboard");

	let filePath: string;
	if (urlPath === "/" || urlPath === "/dashboard") {
		filePath = join(dashboardDir, "index.html");
	} else if (urlPath.startsWith("/dashboard/")) {
		// Strip the leading /dashboard/ prefix to resolve inside dashboard dir
		const relative = urlPath.slice("/dashboard/".length);
		filePath = join(dashboardDir, relative);
	} else {
		// Other paths: serve directly relative to dashboard dir
		filePath = join(dashboardDir, urlPath);
	}

	// Prevent path traversal: resolved path must stay within dashboard dir
	const resolved = resolve(filePath);
	const resolvedDashboard = resolve(dashboardDir);
	if (!resolved.startsWith(`${resolvedDashboard}/`) && resolved !== resolvedDashboard) {
		return new Response("Forbidden", { status: 403 });
	}

	const file = Bun.file(resolved);
	const exists = await file.exists();
	if (!exists) {
		return new Response("Not found", { status: 404 });
	}

	const ext = filePath.slice(filePath.lastIndexOf("."));
	const contentType = MIME[ext] ?? "application/octet-stream";

	return new Response(file, {
		headers: { "Content-Type": contentType },
	});
}

// ── WebSocket terminal ──

interface WsData {
	sessionName: string;
	proc?: ReturnType<typeof Bun.spawn>;
	stdin?: { write(data: string | Uint8Array): number | Promise<number> } | null;
	spawned?: boolean;
}

/**
 * Spawn a PTY process for the given tmux session using script(1).
 * Initial dimensions set via COLUMNS/LINES env vars + tmux resize-window.
 */
function spawnTerminal(
	ws: { send: (d: string) => void; close: () => void; data: WsData },
	sessionName: string,
	cols: number,
	rows: number,
	cwd: string,
): void {
	// Validate dimensions
	if (!Number.isFinite(rows) || !Number.isFinite(cols)) {
		ws.send("[Error: invalid terminal dimensions]");
		ws.close();
		return;
	}
	const safeRows = Math.max(1, Math.min(Math.floor(rows), 500));
	const safeCols = Math.max(1, Math.min(Math.floor(cols), 500));

	// Validate session name
	if (!/^[a-zA-Z0-9_\-.]+$/.test(sessionName)) {
		ws.send("[Error: invalid session name]");
		ws.close();
		return;
	}

	// script -qfc allocates a real PTY. The -c flag requires a shell command
	// string, so we can't use a pure array form. sessionName is validated
	// above to match ^[a-zA-Z0-9_\-.]+$ and single-quoted, preventing injection.
	// COLUMNS/LINES env vars set the initial size; we resize via tmux after attach.
	const proc = Bun.spawn(
		["script", "-qfc", `tmux attach-session -t '${sessionName}'`, "/dev/null"],
		{
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			cwd,
			env: {
				...process.env,
				TERM: "xterm-256color",
				COLORTERM: "truecolor",
				LANG: process.env.LANG ?? "C.UTF-8",
				COLUMNS: String(safeCols),
				LINES: String(safeRows),
			},
		},
	);

	ws.data.proc = proc;
	ws.data.stdin = proc.stdin;
	ws.data.spawned = true;

	// Set terminal dimensions via tmux (array-based, no shell interpolation)
	Bun.spawn(
		["tmux", "resize-window", "-t", sessionName, "-x", String(safeCols), "-y", String(safeRows)],
		{ stdout: "ignore", stderr: "ignore" },
	);

	// Stream stdout to WebSocket
	const stdout = proc.stdout;
	(async () => {
		const reader = stdout.getReader();
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				try {
					ws.send(new TextDecoder().decode(value));
				} catch {
					break;
				}
			}
		} catch {
			// Reader error — process likely exited
		}
		try {
			ws.close();
		} catch {
			// Already closed
		}
	})();

	proc.exited.then(() => {
		try {
			ws.close();
		} catch {
			// Already closed
		}
	});
}

/**
 * Start a Bun.serve() instance with HTTP + native WebSocket support.
 *
 * Terminal WebSocket uses `script(1)` + `Bun.spawn` for PTY allocation instead
 * of `node-pty`. This avoids a runtime dependency and works reliably inside
 * Bun.serve()'s WebSocket handlers (node-pty's native addon event callbacks
 * don't fire properly in Bun's event loop).
 *
 * The PTY spawn is deferred until the first resize message arrives from the
 * client, so the terminal starts with the correct dimensions.
 */
export function startServer(port: number, root: string): ReturnType<typeof Bun.serve> {
	const server = Bun.serve<WsData>({
		port,

		fetch(req, srv) {
			const url = new URL(req.url);
			let urlPath = url.pathname;

			// Normalise trailing slash
			if (urlPath.endsWith("/") && urlPath.length > 1) {
				urlPath = urlPath.slice(0, -1);
			}

			// WebSocket upgrade: /ws/terminal/<session>
			const wsMatch = urlPath.match(/^\/ws\/terminal\/(.+)$/);
			if (wsMatch) {
				const rawSession = wsMatch[1];
				if (!rawSession) {
					return new Response("Missing session name", { status: 400 });
				}
				const sessionName = safe(rawSession);
				if (!sessionName) {
					return new Response("Invalid session name", { status: 400 });
				}
				const upgraded = srv.upgrade(req, { data: { sessionName } });
				if (!upgraded) {
					return new Response("WebSocket upgrade failed", { status: 400 });
				}
				return undefined;
			}

			// Dashboard API
			if (urlPath.startsWith("/dash/api/")) {
				return handleDashApi(urlPath, req.url, root);
			}

			// Static files
			return handleStatic(urlPath);
		},

		websocket: {
			open(_ws) {
				// PTY spawn is deferred to the first resize message so we
				// know the actual terminal dimensions from the client.
			},

			message(ws, msg) {
				const data = typeof msg === "string" ? msg : new TextDecoder().decode(msg);
				const { sessionName } = ws.data;

				// Parse JSON messages (resize)
				try {
					const parsed = JSON.parse(data) as unknown;
					if (
						parsed !== null &&
						typeof parsed === "object" &&
						"type" in parsed &&
						"cols" in parsed &&
						"rows" in parsed
					) {
						const obj = parsed as Record<string, unknown>;
						if (
							obj.type === "resize" &&
							typeof obj.cols === "number" &&
							typeof obj.rows === "number"
						) {
							const safeCols = Math.max(1, Math.min(Math.floor(obj.cols), 500));
							const safeRows = Math.max(1, Math.min(Math.floor(obj.rows), 500));
							if (!ws.data.spawned) {
								// First resize: spawn the PTY with correct dimensions
								try {
									spawnTerminal(ws, sessionName, safeCols, safeRows, root);
								} catch (e: unknown) {
									const errMsg = e instanceof Error ? e.message : String(e);
									try {
										ws.send(`[Error starting terminal: ${errMsg}]`);
									} catch {
										// WebSocket may have closed
									}
									ws.close();
								}
							} else {
								// Subsequent resize: update tmux window size
								Bun.spawn(
									[
										"tmux",
										"resize-window",
										"-t",
										sessionName,
										"-x",
										String(safeCols),
										"-y",
										String(safeRows),
									],
									{ stdout: "ignore", stderr: "ignore" },
								);
							}
							return;
						}
					}
				} catch {
					// Not JSON — treat as raw input
				}

				// Forward raw input to PTY stdin
				const { stdin } = ws.data;
				if (stdin) {
					stdin.write(data);
				}
			},

			close(ws) {
				const { proc } = ws.data;
				if (proc) {
					try {
						proc.kill();
					} catch {
						// Already dead
					}
				}
			},
		},
	});

	return server;
}

const WEB_HELP = `overstory web — Start the Overstory web dashboard server

Usage: overstory web [--port <port>] [--background] [--json]

Options:
  --port <port>      Port to listen on (default: 3000)
  --background       Daemonize (run in background)
  --json             Output JSON (port, pid, url)
  --help, -h         Show this help`;

/**
 * Entry point for \`overstory web [--port <port>] [--background]\`.
 */
export async function webCommand(args: string[]): Promise<void> {
	if (args.includes("--help") || args.includes("-h")) {
		process.stdout.write(`${WEB_HELP}\n`);
		return;
	}

	const portStr = getFlag(args, "--port");
	const background = hasFlag(args, "--background");
	const jsonOutput = hasFlag(args, "--json");

	const cwd = process.cwd();
	const config = await loadConfig(cwd);
	const root = config.project.root;

	const port = portStr ? Number.parseInt(portStr, 10) : 3000;
	if (Number.isNaN(port) || port < 1 || port > 65535) {
		process.stderr.write(
			`Error: Invalid port '${portStr}'. Must be a number between 1 and 65535.\n`,
		);
		process.exitCode = 1;
		return;
	}

	const pidFilePath = join(root, ".overstory", "web.pid");

	if (background) {
		// Check if the server is already running
		const existingPid = await readPidFile(pidFilePath);
		if (existingPid !== null && isProcessRunning(existingPid)) {
			process.stderr.write(
				`Error: Web server already running (PID: ${existingPid}). ` +
					`Kill it first or remove ${pidFilePath}\n`,
			);
			process.exitCode = 1;
			return;
		}

		// Clean up stale PID file if process is no longer running
		if (existingPid !== null) {
			await removePidFile(pidFilePath);
		}

		// Build child args forwarding --port but not --background
		const childArgs: string[] = ["web"];
		if (portStr) {
			childArgs.push("--port", portStr);
		}

		// Resolve the overstory binary path
		const overstoryBin = await resolveOverstoryBin();

		// Spawn a detached background process running `overstory web` (without --background)
		const child = Bun.spawn(["bun", "run", overstoryBin, ...childArgs], {
			cwd,
			stdout: "ignore",
			stderr: "ignore",
			stdin: "ignore",
		});

		// Unref the child so the parent can exit without waiting for it
		child.unref();

		const childPid = child.pid;

		// Write PID file for later cleanup
		await writePidFile(pidFilePath, childPid);

		if (jsonOutput) {
			process.stdout.write(
				`${JSON.stringify({ port, pid: childPid, url: `http://localhost:${port}` })}\n`,
			);
		} else {
			process.stdout.write(`Web server started in background (PID: ${childPid}, port: ${port})\n`);
			process.stdout.write(`Dashboard: http://localhost:${port}\n`);
			process.stdout.write(`PID file: ${pidFilePath}\n`);
		}
		return;
	}

	// Foreground mode
	const server = startServer(port, root);

	// Write PID file
	await writePidFile(pidFilePath, process.pid);

	if (jsonOutput) {
		process.stdout.write(
			`${JSON.stringify({ port, pid: process.pid, url: `http://localhost:${port}` })}\n`,
		);
	} else {
		process.stdout.write(`Overstory Dashboard: http://localhost:${port}\n`);
		process.stdout.write("Press Ctrl+C to stop.\n");
	}

	// SIGINT cleanup
	process.on("SIGINT", () => {
		server.stop();
		removePidFile(pidFilePath).finally(() => {
			process.stdout.write("\nWeb server stopped.\n");
			process.exit(0);
		});
	});

	// Block forever
	await new Promise(() => {});
}

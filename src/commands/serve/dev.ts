/**
 * Dev-server launcher for `ov serve --dev`.
 *
 * Spawns ui/dev-server.ts (a Bun.serve script with HMR + API/WS proxy) in the
 * ui/ workspace and exposes a stop() handle for graceful shutdown. The dev
 * server itself proxies /api/* and /ws back to the main `ov serve` process.
 */

import { DEFAULT_SERVE_PORT } from "../serve.ts";

export interface DevServerHandle {
	port: number;
	stop: () => Promise<void>;
}

export interface StartDevServerOptions {
	uiDir: string;
	port: number;
	apiPort?: number;
	apiHost?: string;
	log?: (msg: string) => void;
	_spawn?: typeof Bun.spawn;
}

/** Default sink: write each line to process.stderr with a "[ui-dev] " prefix. */
function defaultLog(line: string): void {
	process.stderr.write(`[ui-dev] ${line}\n`);
}

/**
 * Read a Bun subprocess stream line-by-line and forward each line to sink.
 * The trailing partial line (no newline) is flushed when the stream closes.
 */
async function pipeLines(
	stream: ReadableStream<Uint8Array> | null,
	sink: (line: string) => void,
): Promise<void> {
	if (stream === null) return;
	const decoder = new TextDecoder();
	let buf = "";
	const reader = stream.getReader();
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buf += decoder.decode(value, { stream: true });
			let idx = buf.indexOf("\n");
			while (idx !== -1) {
				sink(buf.slice(0, idx));
				buf = buf.slice(idx + 1);
				idx = buf.indexOf("\n");
			}
		}
		if (buf.length > 0) sink(buf);
	} finally {
		reader.releaseLock();
	}
}

/**
 * Build a string-only environment from process.env plus OVERSTORY_* vars,
 * dropping entries whose value is undefined (process.env's declared type).
 */
function buildEnv(extra: Record<string, string>): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) {
		if (typeof v === "string") env[k] = v;
	}
	for (const [k, v] of Object.entries(extra)) env[k] = v;
	return env;
}

export async function startDevServer(opts: StartDevServerOptions): Promise<DevServerHandle> {
	const spawn = opts._spawn ?? Bun.spawn;
	const log = opts.log ?? defaultLog;

	const env = buildEnv({
		OVERSTORY_DEV_PORT: String(opts.port),
		OVERSTORY_API_PORT: String(opts.apiPort ?? DEFAULT_SERVE_PORT),
		OVERSTORY_API_HOST: opts.apiHost ?? "127.0.0.1",
	});

	const child = spawn(["bun", "--hot", "./dev-server.ts"], {
		cwd: opts.uiDir,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});

	// Pipe child output asynchronously; we don't await these — they resolve
	// when the streams close (i.e., on subprocess exit).
	void pipeLines(child.stdout as ReadableStream<Uint8Array> | null, log);
	void pipeLines(child.stderr as ReadableStream<Uint8Array> | null, log);

	const stop = async (): Promise<void> => {
		try {
			child.kill("SIGTERM");
		} catch {
			// Already exited.
		}
		const timeoutMs = 5000;
		const timeout = new Promise<"timeout">((resolve) =>
			setTimeout(() => resolve("timeout"), timeoutMs),
		);
		const result = await Promise.race([child.exited.then(() => "exited" as const), timeout]);
		if (result === "timeout") {
			try {
				child.kill("SIGKILL");
			} catch {
				// Already exited.
			}
			await child.exited;
		}
	};

	return { port: opts.port, stop };
}

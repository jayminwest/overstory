/**
 * Tests for startDevServer.
 *
 * Bun.spawn is fully stubbed — no real subprocess is launched. We capture the
 * argv, cwd, and env passed to spawn, and verify stop() drives the lifecycle
 * (SIGTERM → exited; SIGKILL fallback after timeout).
 */

import { describe, expect, test } from "bun:test";
import { startDevServer } from "./dev.ts";

interface FakeHandle {
	killCalls: string[];
	exited: Promise<number>;
	kill: (sig?: string) => void;
	stdout: ReadableStream<Uint8Array>;
	stderr: ReadableStream<Uint8Array>;
	resolveExit: (code: number) => void;
}

function makeFakeHandle(): FakeHandle {
	const killCalls: string[] = [];
	let resolveExit!: (code: number) => void;
	const exited = new Promise<number>((r) => {
		resolveExit = r;
	});
	// Empty streams that close immediately.
	const empty = (): ReadableStream<Uint8Array> =>
		new ReadableStream<Uint8Array>({
			start(controller) {
				controller.close();
			},
		});
	return {
		killCalls,
		exited,
		kill: (sig?: string) => {
			killCalls.push(sig ?? "SIGTERM");
		},
		stdout: empty(),
		stderr: empty(),
		resolveExit,
	};
}

interface SpawnCall {
	cmd: string[];
	cwd: string | undefined;
	env: Record<string, string> | undefined;
}

function makeFakeSpawn(handle: FakeHandle): {
	spawn: typeof Bun.spawn;
	calls: SpawnCall[];
} {
	const calls: SpawnCall[] = [];
	const fake = ((cmd: string[], options?: { cwd?: string; env?: Record<string, string> }) => {
		calls.push({ cmd, cwd: options?.cwd, env: options?.env });
		return handle;
	}) as unknown as typeof Bun.spawn;
	return { spawn: fake, calls };
}

describe("startDevServer", () => {
	test("spawns ['bun', '--hot', './dev-server.ts'] in uiDir with OVERSTORY_* env", async () => {
		const handle = makeFakeHandle();
		const { spawn, calls } = makeFakeSpawn(handle);

		const dev = await startDevServer({
			uiDir: "/tmp/ui",
			port: 3500,
			apiPort: 9090,
			apiHost: "0.0.0.0",
			_spawn: spawn,
			log: () => {},
		});

		expect(calls.length).toBe(1);
		expect(calls[0]?.cmd).toEqual(["bun", "--hot", "./dev-server.ts"]);
		expect(calls[0]?.cwd).toBe("/tmp/ui");
		expect(calls[0]?.env?.OVERSTORY_DEV_PORT).toBe("3500");
		expect(calls[0]?.env?.OVERSTORY_API_PORT).toBe("9090");
		expect(calls[0]?.env?.OVERSTORY_API_HOST).toBe("0.0.0.0");
		// Inherits process.env (PATH should usually be present).
		expect(typeof calls[0]?.env?.PATH === "string" || calls[0]?.env?.PATH === undefined).toBe(true);

		expect(dev.port).toBe(3500);

		// Clean up: let stop drive resolveExit so the dangling promise settles.
		handle.resolveExit(0);
		await dev.stop();
	});

	test("defaults apiPort to the ov serve default and apiHost to 127.0.0.1", async () => {
		const handle = makeFakeHandle();
		const { spawn, calls } = makeFakeSpawn(handle);

		const dev = await startDevServer({
			uiDir: "/tmp/ui",
			port: 3000,
			_spawn: spawn,
			log: () => {},
		});

		expect(calls[0]?.env?.OVERSTORY_API_PORT).toBe("7321");
		expect(calls[0]?.env?.OVERSTORY_API_HOST).toBe("127.0.0.1");

		handle.resolveExit(0);
		await dev.stop();
	});

	test("stop() sends SIGTERM and resolves once the process exits", async () => {
		const handle = makeFakeHandle();
		const { spawn } = makeFakeSpawn(handle);

		const dev = await startDevServer({
			uiDir: "/tmp/ui",
			port: 3000,
			_spawn: spawn,
			log: () => {},
		});

		// Resolve exited soon after stop() is called.
		setTimeout(() => handle.resolveExit(0), 10);
		await dev.stop();

		expect(handle.killCalls.length).toBeGreaterThanOrEqual(1);
		expect(handle.killCalls[0]).toBe("SIGTERM");
		// No SIGKILL because the process exited within the 5s timeout.
		expect(handle.killCalls.includes("SIGKILL")).toBe(false);
	});

	test("stop() escalates to SIGKILL when the process ignores SIGTERM", async () => {
		const handle = makeFakeHandle();
		const { spawn } = makeFakeSpawn(handle);

		// Patch the timeout so the test doesn't actually wait 5s.
		const realSetTimeout = globalThis.setTimeout;
		globalThis.setTimeout = ((fn: () => void, _ms?: number) =>
			realSetTimeout(fn, 0)) as unknown as typeof setTimeout;

		try {
			const dev = await startDevServer({
				uiDir: "/tmp/ui",
				port: 3000,
				_spawn: spawn,
				log: () => {},
			});

			// Resolve exited only after SIGKILL has been issued.
			let killed = false;
			const origKill = handle.kill;
			handle.kill = (sig?: string) => {
				origKill(sig);
				if (sig === "SIGKILL") {
					killed = true;
					handle.resolveExit(137);
				}
			};

			await dev.stop();
			expect(killed).toBe(true);
			expect(handle.killCalls).toEqual(["SIGTERM", "SIGKILL"]);
		} finally {
			globalThis.setTimeout = realSetTimeout;
		}
	});
});

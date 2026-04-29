import { afterEach, describe, expect, test } from "bun:test";
import { HeadlessClaudeConnection, hasNudge } from "./headless-connection.ts";
import type { RuntimeConnection } from "./types.ts";

/**
 * Tests use real subprocesses (sleep, cat, echo) — no mocking.
 * Processes spawned in tests are cleaned up via proc.kill() in afterEach
 * where applicable.
 */

describe("HeadlessClaudeConnection", () => {
	const cleanup: Array<() => void> = [];

	afterEach(() => {
		for (const fn of cleanup.splice(0)) {
			try {
				fn();
			} catch {
				// ignore cleanup errors
			}
		}
	});

	describe("sendPrompt / followUp", () => {
		test("sendPrompt writes text to stdin and the process reads it", async () => {
			const proc = Bun.spawn(["cat"], {
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			});
			cleanup.push(() => proc.kill());

			const conn = new HeadlessClaudeConnection(proc.pid, proc.stdin);
			await conn.sendPrompt("hello from sendPrompt\n");
			proc.stdin.end();

			const text = await new Response(proc.stdout).text();
			expect(text.trim()).toBe("hello from sendPrompt");
		});

		test("followUp writes text to stdin and the process reads it", async () => {
			const proc = Bun.spawn(["cat"], {
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			});
			cleanup.push(() => proc.kill());

			const conn = new HeadlessClaudeConnection(proc.pid, proc.stdin);
			await conn.followUp("hello from followUp\n");
			proc.stdin.end();

			const text = await new Response(proc.stdout).text();
			expect(text.trim()).toBe("hello from followUp");
		});

		test("multiple followUp calls each write to stdin in order", async () => {
			const proc = Bun.spawn(["cat"], {
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			});
			cleanup.push(() => proc.kill());

			const conn = new HeadlessClaudeConnection(proc.pid, proc.stdin);
			await conn.followUp("line1\n");
			await conn.followUp("line2\n");
			proc.stdin.end();

			const text = await new Response(proc.stdout).text();
			expect(text).toBe("line1\nline2\n");
		});
	});

	describe("getState", () => {
		test("returns working when process is alive", async () => {
			const proc = Bun.spawn(["sleep", "60"], {
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			});
			cleanup.push(() => proc.kill());

			const conn = new HeadlessClaudeConnection(proc.pid, proc.stdin);
			const state = await conn.getState();
			expect(state.status).toBe("working");
		});

		test("returns error when process has exited", async () => {
			const proc = Bun.spawn(["echo", "done"], {
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			});
			// Drain stdout so the process can exit cleanly
			await new Response(proc.stdout).text();
			await proc.exited;

			const conn = new HeadlessClaudeConnection(proc.pid, proc.stdin);
			const state = await conn.getState();
			// PID is no longer running — kill(pid, 0) throws ESRCH
			expect(state.status).toBe("error");
		});
	});

	describe("abort", () => {
		test("terminates a running process via SIGTERM", async () => {
			const proc = Bun.spawn(["sleep", "60"], {
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			});

			const conn = new HeadlessClaudeConnection(proc.pid, proc.stdin, {
				sigkillDelayMs: 500,
			});
			await conn.abort();

			const exitCode = await proc.exited;
			// Process should have exited (signal exit codes are negative on some systems,
			// or a non-zero code is expected; just verify it exited)
			expect(typeof exitCode).toBe("number");
		});

		test("abort on already-exited process is a no-op (does not throw)", async () => {
			const proc = Bun.spawn(["echo", "bye"], {
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			});
			await new Response(proc.stdout).text();
			await proc.exited;

			const conn = new HeadlessClaudeConnection(proc.pid, proc.stdin, {
				sigkillDelayMs: 100,
			});
			await expect(conn.abort()).resolves.toBeUndefined();
		});
	});

	describe("pid", () => {
		test("exposes the process PID", async () => {
			const proc = Bun.spawn(["sleep", "1"], {
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			});
			cleanup.push(() => proc.kill());

			const conn = new HeadlessClaudeConnection(proc.pid, proc.stdin);
			expect(conn.pid).toBe(proc.pid);
			expect(conn.pid).toBeGreaterThan(0);
		});
	});

	describe("close", () => {
		test("close() does not throw and leaves process running", async () => {
			const proc = Bun.spawn(["sleep", "60"], {
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			});
			cleanup.push(() => proc.kill());

			const conn = new HeadlessClaudeConnection(proc.pid, proc.stdin);
			expect(() => conn.close()).not.toThrow();

			// Process is still alive after close()
			const state = await conn.getState();
			expect(state.status).toBe("working");
		});
	});

	describe("nudge", () => {
		test("nudge writes a stream-json user-message envelope to stdin", async () => {
			const proc = Bun.spawn(["cat"], {
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			});
			cleanup.push(() => proc.kill());

			const conn = new HeadlessClaudeConnection(proc.pid, proc.stdin);
			await conn.nudge("hello nudge");
			proc.stdin.end();

			const text = await new Response(proc.stdout).text();
			const parsed = JSON.parse(text.trim()) as Record<string, unknown>;
			expect(parsed.type).toBe("user");
			const msg = parsed.message as Record<string, unknown>;
			expect(msg.role).toBe("user");
			const content = msg.content as Array<Record<string, unknown>>;
			expect(content[0]?.type).toBe("text");
			expect(content[0]?.text).toBe("hello nudge");
		});

		test("nudge returns Queued status (headless stdin-buffer caveat)", async () => {
			const proc = Bun.spawn(["cat"], {
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			});
			cleanup.push(() => proc.kill());

			const conn = new HeadlessClaudeConnection(proc.pid, proc.stdin);
			const result = await conn.nudge("any message");
			proc.stdin.end();
			expect(result.status).toBe("Queued");
		});

		test("nudge envelope ends with a newline (NDJSON line terminator)", async () => {
			const proc = Bun.spawn(["cat"], {
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			});
			cleanup.push(() => proc.kill());

			const conn = new HeadlessClaudeConnection(proc.pid, proc.stdin);
			await conn.nudge("newline check");
			proc.stdin.end();

			const raw = await new Response(proc.stdout).text();
			expect(raw.endsWith("\n")).toBe(true);
		});
	});
});

describe("hasNudge", () => {
	test("returns true for HeadlessClaudeConnection (has nudge method)", () => {
		const proc = Bun.spawn(["sleep", "1"], {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		proc.kill();

		const conn = new HeadlessClaudeConnection(proc.pid, proc.stdin);
		expect(hasNudge(conn)).toBe(true);
	});

	test("returns false for a plain RuntimeConnection without nudge", () => {
		const plain: RuntimeConnection = {
			sendPrompt: async () => {},
			followUp: async () => {},
			abort: async () => {},
			getState: async () => ({ status: "idle" as const }),
			close: () => {},
		};
		expect(hasNudge(plain)).toBe(false);
	});

	test("returns false for an object with nudge as a non-function", () => {
		const weird = {
			sendPrompt: async () => {},
			followUp: async () => {},
			abort: async () => {},
			getState: async () => ({ status: "idle" as const }),
			close: () => {},
			nudge: "not a function",
		} as unknown as RuntimeConnection;
		expect(hasNudge(weird)).toBe(false);
	});
});

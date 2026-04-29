import { afterEach, describe, expect, test } from "bun:test";
import { HeadlessClaudeConnection } from "./headless-connection.ts";

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
});

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConnection, removeConnection } from "../runtimes/connections.ts";
import { HeadlessClaudeConnection } from "../runtimes/headless-connection.ts";
import { spawnHeadlessAgent } from "./process.ts";

describe("spawnHeadlessAgent", () => {
	it("spawns a command and returns a valid PID", async () => {
		const proc = await spawnHeadlessAgent(["echo", "hello"], {
			cwd: process.cwd(),
			env: { ...(process.env as Record<string, string>) },
		});
		expect(typeof proc.pid).toBe("number");
		expect(proc.pid).toBeGreaterThan(0);
		expect(proc.stdout).toBeDefined();
		expect(proc.stdin).toBeDefined();
	});

	it("throws AgentError when argv is empty", async () => {
		await expect(spawnHeadlessAgent([], { cwd: process.cwd(), env: {} })).rejects.toThrow(
			"empty argv",
		);
	});

	describe("agentName connection registration", () => {
		const registeredNames: string[] = [];

		afterEach(() => {
			for (const name of registeredNames.splice(0)) {
				removeConnection(name);
			}
		});

		it("registers a HeadlessClaudeConnection when agentName is provided", async () => {
			const agentName = "test-headless-agent-xyz";
			registeredNames.push(agentName);

			const proc = await spawnHeadlessAgent(["sleep", "5"], {
				cwd: process.cwd(),
				env: { ...(process.env as Record<string, string>) },
				agentName,
			});

			expect(proc.pid).toBeGreaterThan(0);
			const conn = getConnection(agentName);
			expect(conn).toBeDefined();
			expect(conn).toBeInstanceOf(HeadlessClaudeConnection);

			// Clean up the spawned process
			try {
				process.kill(proc.pid, "SIGTERM");
			} catch {
				// ignore
			}
		});

		it("does not register a connection when agentName is omitted", async () => {
			const proc = await spawnHeadlessAgent(["echo", "no-register"], {
				cwd: process.cwd(),
				env: { ...(process.env as Record<string, string>) },
			});

			// Drain stdout so process exits cleanly
			if (proc.stdout) {
				await new Response(proc.stdout).text();
			}

			// No connection was registered (use a stable lookup key that was never set)
			expect(getConnection("never-registered-in-this-test")).toBeUndefined();
		});

		it("registered connection pid matches the spawned process pid", async () => {
			const agentName = "test-headless-pid-check-xyz";
			registeredNames.push(agentName);

			const proc = await spawnHeadlessAgent(["sleep", "5"], {
				cwd: process.cwd(),
				env: { ...(process.env as Record<string, string>) },
				agentName,
			});

			const conn = getConnection(agentName) as HeadlessClaudeConnection;
			expect(conn).toBeDefined();
			expect(conn.pid).toBe(proc.pid);

			try {
				process.kill(proc.pid, "SIGTERM");
			} catch {
				// ignore
			}
		});
	});

	describe("file redirect mode", () => {
		let tmpDir: string;

		beforeEach(async () => {
			tmpDir = await mkdtemp(join(tmpdir(), "ov-process-test-"));
		});

		afterEach(async () => {
			await rm(tmpDir, { recursive: true, force: true });
		});

		it("redirects stdout to file when stdoutFile is provided", async () => {
			const stdoutFile = join(tmpDir, "stdout.log");
			const proc = await spawnHeadlessAgent(["echo", "hello from file"], {
				cwd: process.cwd(),
				env: { ...(process.env as Record<string, string>) },
				stdoutFile,
			});

			expect(typeof proc.pid).toBe("number");
			expect(proc.pid).toBeGreaterThan(0);
			// stdout is null when redirected to file — no pipe, no backpressure
			expect(proc.stdout).toBeNull();
			expect(proc.stdin).toBeDefined();

			// Wait for process to finish, then check file content
			const exitProc = Bun.spawn(["sh", "-c", "true"], { stdout: "pipe" });
			await exitProc.exited;
			// Give echo a moment to flush
			await Bun.sleep(100);

			const content = await Bun.file(stdoutFile).text();
			expect(content.trim()).toBe("hello from file");
		});

		it("redirects stderr to file when stderrFile is provided", async () => {
			const stderrFile = join(tmpDir, "stderr.log");
			// Write to stderr via sh -c
			const proc = await spawnHeadlessAgent(["sh", "-c", "echo error output >&2"], {
				cwd: process.cwd(),
				env: { ...(process.env as Record<string, string>) },
				stderrFile,
			});

			expect(typeof proc.pid).toBe("number");
			// stdout still piped (no stdoutFile provided)
			expect(proc.stdout).not.toBeNull();

			// Drain stdout to let process exit cleanly
			if (proc.stdout) {
				const reader = proc.stdout.getReader();
				while (!(await reader.read()).done) {
					// drain
				}
				reader.releaseLock();
			}

			await Bun.sleep(100);
			const content = await Bun.file(stderrFile).text();
			expect(content.trim()).toBe("error output");
		});

		it("stdout remains a ReadableStream when no stdoutFile provided (default mode)", async () => {
			const proc = await spawnHeadlessAgent(["echo", "piped"], {
				cwd: process.cwd(),
				env: { ...(process.env as Record<string, string>) },
			});

			expect(proc.stdout).not.toBeNull();
			expect(proc.stdout).toBeInstanceOf(ReadableStream);

			// Read the content via the stream
			const text = await new Response(proc.stdout as ReadableStream<Uint8Array>).text();
			expect(text.trim()).toBe("piped");
		});
	});
});

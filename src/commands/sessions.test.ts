import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionStore } from "../sessions/store.ts";
import { cleanupTempDir } from "../test-helpers.ts";
import type { AgentSession } from "../types.ts";
import { createSessionsCommand } from "./sessions.ts";

function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
	return {
		id: "session-1",
		agentName: "builder-1",
		capability: "builder",
		worktreePath: "/tmp/wt",
		branchName: "overstory/builder-1/task-1",
		taskId: "task-1",
		tmuxSession: "overstory-test-builder-1",
		state: "working",
		pid: 12345,
		parentAgent: null,
		depth: 0,
		runId: null,
		startedAt: new Date().toISOString(),
		lastActivity: new Date().toISOString(),
		escalationLevel: 0,
		stalledSince: null,
		transcriptPath: null,
		...overrides,
	};
}

describe("sessions command", () => {
	let tempDir: string;
	let originalCwd: string;
	let originalTmux: string | undefined;
	let stdoutChunks: string[];
	let stdoutSpy: ReturnType<typeof spyOn>;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "overstory-sessions-test-"));
		originalCwd = process.cwd();
		originalTmux = process.env.TMUX;
		stdoutChunks = [];
		process.chdir(tempDir);

		await Bun.write(
			join(tempDir, ".overstory", "config.yaml"),
			["project:", "  name: test-project", `  root: ${tempDir}`, "  canonicalBranch: main"].join(
				"\n",
			),
		);

		stdoutSpy = spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
			stdoutChunks.push(String(chunk));
			return true;
		});
	});

	afterEach(async () => {
		stdoutSpy.mockRestore();
		process.chdir(originalCwd);
		if (originalTmux === undefined) {
			delete process.env.TMUX;
		} else {
			process.env.TMUX = originalTmux;
		}
		process.exitCode = undefined;
		await cleanupTempDir(tempDir);
	});

	function outputJson(): Record<string, unknown> {
		return JSON.parse(stdoutChunks.join("").trim()) as Record<string, unknown>;
	}

	async function runSessions(args: string[]): Promise<void> {
		const cmd = createSessionsCommand();
		cmd.exitOverride();
		await cmd.parseAsync(args, { from: "user" });
	}

	test("list --json shows attachable sessions with alive state", async () => {
		const store = createSessionStore(join(tempDir, ".overstory", "sessions.db"));
		store.upsert(makeSession());
		store.close();

		const spawnSpy = spyOn(Bun, "spawn").mockImplementation(() => {
			return {
				stdout: new Response("").body as ReadableStream<Uint8Array>,
				stderr: new Response("").body as ReadableStream<Uint8Array>,
				exited: Promise.resolve(0),
				pid: 12345,
			} as unknown as ReturnType<typeof Bun.spawn>;
		});

		try {
			await runSessions(["list", "--json"]);
		} finally {
			spawnSpy.mockRestore();
		}

		const payload = outputJson();
		expect(payload.success).toBe(true);
		expect(payload.command).toBe("sessions list");
		expect(payload.sessions).toEqual([
			{
				agentName: "builder-1",
				tmuxSession: "overstory-test-builder-1",
				capability: "builder",
				state: "working",
				alive: true,
			},
		]);
	});

	test("attach --json prefers coordinator when no agent is specified", async () => {
		const store = createSessionStore(join(tempDir, ".overstory", "sessions.db"));
		store.upsert(
			makeSession({
				id: "session-coordinator",
				agentName: "coordinator",
				capability: "coordinator",
				tmuxSession: "overstory-test-coordinator",
			}),
		);
		store.upsert(makeSession());
		store.close();

		const spawnSpy = spyOn(Bun, "spawn").mockImplementation(() => {
			return {
				stdout: new Response("").body as ReadableStream<Uint8Array>,
				stderr: new Response("").body as ReadableStream<Uint8Array>,
				exited: Promise.resolve(0),
				pid: 12345,
			} as unknown as ReturnType<typeof Bun.spawn>;
		});

		try {
			await runSessions(["attach", "--json"]);
		} finally {
			spawnSpy.mockRestore();
		}

		const payload = outputJson();
		expect(payload.success).toBe(true);
		expect(payload.command).toBe("sessions attach");
		expect(payload.ok).toBe(true);
		expect(payload.agentName).toBe("coordinator");
		expect(payload.tmuxSession).toBe("overstory-test-coordinator");
	});

	test("attach --json returns ambiguous when multiple worker sessions exist", async () => {
		const store = createSessionStore(join(tempDir, ".overstory", "sessions.db"));
		store.upsert(makeSession());
		store.upsert(
			makeSession({
				id: "session-2",
				agentName: "builder-2",
				tmuxSession: "overstory-test-builder-2",
			}),
		);
		store.close();

		await runSessions(["attach", "--json"]);

		const payload = outputJson();
		expect(payload.success).toBe(true);
		expect(payload.command).toBe("sessions attach");
		expect(payload.ok).toBe(false);
		expect(payload.reason).toBe("ambiguous");
	});

	test("current --json returns null and sets exitCode when outside tmux", async () => {
		delete process.env.TMUX;

		await runSessions(["current", "--json"]);

		const payload = outputJson();
		expect(payload.success).toBe(true);
		expect(payload.command).toBe("sessions current");
		expect(payload.tmuxSession).toBeNull();
		expect(process.exitCode).toBe(1);
	});
});

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { AgentError } from "../errors.ts";
import type { ReadyState } from "../runtimes/types.ts";
import {
	capturePaneContent,
	checkSessionState,
	createSession,
	ensureTmuxAvailable,
	getDescendantPids,
	getPanePid,
	isProcessAlive,
	isSessionAlive,
	killProcessTree,
	killSession,
	listSessions,
	sanitizeTmuxName,
	sendKeys,
	waitForTuiReady,
} from "./tmux.ts";

/**
 * tmux tests use Bun.spawn mocks — legitimate exception to "never mock what you can use for real".
 * Real tmux operations would hijack the developer's session and are unavailable in CI.
 */

/**
 * Helper to create a mock Bun.spawn return value.
 *
 * The actual code reads stdout/stderr via `new Response(proc.stdout).text()`
 * and `new Response(proc.stderr).text()`, so we need ReadableStreams.
 */
function mockSpawnResult(
	stdout: string,
	stderr: string,
	exitCode: number,
): {
	stdout: ReadableStream<Uint8Array>;
	stderr: ReadableStream<Uint8Array>;
	exited: Promise<number>;
	pid: number;
} {
	return {
		stdout: new Response(stdout).body as ReadableStream<Uint8Array>,
		stderr: new Response(stderr).body as ReadableStream<Uint8Array>,
		exited: Promise.resolve(exitCode),
		pid: 12345,
	};
}

describe("createSession", () => {
	let spawnSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		spawnSpy = spyOn(Bun, "spawn");
	});

	afterEach(() => {
		spawnSpy.mockRestore();
	});

	test("creates session and returns pane PID", async () => {
		let callCount = 0;
		spawnSpy.mockImplementation(() => {
			callCount++;
			if (callCount === 1) {
				// which overstory — return a bin path
				return mockSpawnResult("/usr/local/bin/overstory\n", "", 0);
			}
			if (callCount === 2) {
				// tmux new-session
				return mockSpawnResult("", "", 0);
			}
			// tmux list-panes -t overstory-auth -F '#{pane_pid}'
			return mockSpawnResult("42\n", "", 0);
		});

		const pid = await createSession(
			"overstory-auth",
			"/repo/worktrees/auth",
			"claude --task 'do work'",
		);

		expect(pid).toBe(42);
	});

	test("passes correct args to tmux new-session with PATH wrapping", async () => {
		let callCount = 0;
		spawnSpy.mockImplementation(() => {
			callCount++;
			if (callCount === 1) {
				// which overstory
				return mockSpawnResult("/usr/local/bin/overstory\n", "", 0);
			}
			if (callCount === 2) {
				return mockSpawnResult("", "", 0);
			}
			return mockSpawnResult("1234\n", "", 0);
		});

		await createSession("my-session", "/work/dir", "echo hello");

		// Call 0 is 'which overstory', call 1 is 'tmux new-session'
		const tmuxCallArgs = spawnSpy.mock.calls[1] as unknown[];
		const cmd = tmuxCallArgs[0] as string[];
		expect(cmd[0]).toBe("tmux");
		expect(cmd[3]).toBe("new-session");
		expect(cmd[5]).toBe("-s");
		expect(cmd[6]).toBe("my-session");
		expect(cmd[7]).toBe("-c");
		expect(cmd[8]).toBe("/work/dir");
		// The command should be wrapped with PATH export
		const wrappedCmd = cmd[9] as string;
		expect(wrappedCmd).toContain("echo hello");
		expect(wrappedCmd).toContain("export PATH=");
		// `exec` replaces the bash wrapper with the command so SIGHUP from a
		// dying tmux server is delivered directly to claude (overstory-505d).
		expect(wrappedCmd).toContain("exec echo hello");

		const opts = tmuxCallArgs[1] as { cwd: string };
		expect(opts.cwd).toBe("/work/dir");
	});

	test("calls list-panes after creating to get pane PID", async () => {
		let callCount = 0;
		spawnSpy.mockImplementation(() => {
			callCount++;
			if (callCount === 1) {
				// which overstory
				return mockSpawnResult("/usr/local/bin/overstory\n", "", 0);
			}
			if (callCount === 2) {
				return mockSpawnResult("", "", 0);
			}
			return mockSpawnResult("7777\n", "", 0);
		});

		await createSession("test-agent", "/tmp", "ls");

		// 3 calls: which overstory, tmux new-session, tmux list-panes
		expect(spawnSpy).toHaveBeenCalledTimes(3);
		const thirdCallArgs = spawnSpy.mock.calls[2] as unknown[];
		const cmd = thirdCallArgs[0] as string[];
		expect(cmd).toEqual([
			"tmux",
			"-L",
			"overstory",
			"list-panes",
			"-t",
			"test-agent",
			"-F",
			"#{pane_pid}",
		]);
	});

	test("throws AgentError if session creation fails", async () => {
		let callCount = 0;
		spawnSpy.mockImplementation(() => {
			callCount++;
			if (callCount === 1) {
				// which overstory
				return mockSpawnResult("/usr/local/bin/overstory\n", "", 0);
			}
			return mockSpawnResult("", "duplicate session: my-session", 1);
		});

		await expect(createSession("my-session", "/tmp", "ls")).rejects.toThrow(AgentError);
	});

	test("throws AgentError if list-panes fails after creation", async () => {
		let callCount = 0;
		spawnSpy.mockImplementation(() => {
			callCount++;
			if (callCount === 1) {
				// which overstory
				return mockSpawnResult("/usr/local/bin/overstory\n", "", 0);
			}
			if (callCount === 2) {
				// new-session succeeds
				return mockSpawnResult("", "", 0);
			}
			// list-panes fails
			return mockSpawnResult("", "error listing panes", 1);
		});

		await expect(createSession("my-session", "/tmp", "ls")).rejects.toThrow(AgentError);
	});

	test("throws AgentError if pane PID output is empty", async () => {
		let callCount = 0;
		spawnSpy.mockImplementation(() => {
			callCount++;
			if (callCount === 1) {
				// which overstory
				return mockSpawnResult("/usr/local/bin/overstory\n", "", 0);
			}
			if (callCount === 2) {
				return mockSpawnResult("", "", 0);
			}
			// list-panes returns empty output
			return mockSpawnResult("", "", 0);
		});

		await expect(createSession("my-session", "/tmp", "ls")).rejects.toThrow(AgentError);
	});

	test("AgentError includes session name context", async () => {
		let callCount = 0;
		spawnSpy.mockImplementation(() => {
			callCount++;
			if (callCount === 1) {
				// which overstory
				return mockSpawnResult("/usr/local/bin/overstory\n", "", 0);
			}
			return mockSpawnResult("", "duplicate session: agent-foo", 1);
		});

		try {
			await createSession("agent-foo", "/tmp", "ls");
			expect(true).toBe(false);
		} catch (err: unknown) {
			expect(err).toBeInstanceOf(AgentError);
			const agentErr = err as AgentError;
			expect(agentErr.message).toContain("agent-foo");
			expect(agentErr.agentName).toBe("agent-foo");
		}
	});

	test("still creates session when which ov and which overstory both fail (uses fallback)", async () => {
		let callCount = 0;
		spawnSpy.mockImplementation(() => {
			callCount++;
			if (callCount === 1) {
				// which ov fails
				return mockSpawnResult("", "ov not found", 1);
			}
			if (callCount === 2) {
				// which overstory fails
				return mockSpawnResult("", "overstory not found", 1);
			}
			if (callCount === 3) {
				// tmux new-session
				return mockSpawnResult("", "", 0);
			}
			// tmux list-panes
			return mockSpawnResult("5555\n", "", 0);
		});

		const pid = await createSession("fallback-agent", "/tmp", "echo test");
		expect(pid).toBe(5555);

		// The tmux command should contain the original command
		// Call 0: which ov, Call 1: which overstory, Call 2: tmux new-session
		const tmuxCallArgs = spawnSpy.mock.calls[2] as unknown[];
		const cmd = tmuxCallArgs[0] as string[];
		const tmuxCmd = cmd[9] as string;
		expect(tmuxCmd).toContain("echo test");
	});

	test("retries list-panes on transient failure", async () => {
		let callCount = 0;
		spawnSpy.mockImplementation(() => {
			callCount++;
			if (callCount === 1) {
				// which overstory
				return mockSpawnResult("/usr/local/bin/overstory\n", "", 0);
			}
			if (callCount === 2) {
				// tmux new-session
				return mockSpawnResult("", "", 0);
			}
			if (callCount === 3) {
				// First list-panes fails (WSL2 race)
				return mockSpawnResult("", "can't find pane\n", 1);
			}
			// Second list-panes succeeds
			return mockSpawnResult("42\n", "", 0);
		});

		const pid = await createSession("retry-session", "/work/dir", "echo hello");
		expect(pid).toBe(42);
		// which + new-session + list-panes(fail) + list-panes(ok)
		expect(spawnSpy).toHaveBeenCalledTimes(4);
	});

	test("throws after exhausting all list-panes retries", async () => {
		let callCount = 0;
		spawnSpy.mockImplementation(() => {
			callCount++;
			if (callCount === 1) {
				// which overstory
				return mockSpawnResult("/usr/local/bin/overstory\n", "", 0);
			}
			if (callCount === 2) {
				// tmux new-session
				return mockSpawnResult("", "", 0);
			}
			// All list-panes attempts fail
			return mockSpawnResult("", "can't find pane\n", 1);
		});

		await expect(
			createSession("retry-exhaust", "/work/dir", "echo hello", undefined, 2),
		).rejects.toThrow(/failed to retrieve PID/);
	});
});

describe("listSessions", () => {
	let spawnSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		spawnSpy = spyOn(Bun, "spawn");
	});

	afterEach(() => {
		spawnSpy.mockRestore();
	});

	test("parses session list output", async () => {
		spawnSpy.mockImplementation(() =>
			mockSpawnResult("overstory-auth:42\noverstory-data:99\n", "", 0),
		);

		const sessions = await listSessions();

		expect(sessions).toHaveLength(2);
		expect(sessions[0]?.name).toBe("overstory-auth");
		expect(sessions[0]?.pid).toBe(42);
		expect(sessions[1]?.name).toBe("overstory-data");
		expect(sessions[1]?.pid).toBe(99);
	});

	test("returns empty array when no server running", async () => {
		spawnSpy.mockImplementation(() =>
			mockSpawnResult("", "no server running on /tmp/tmux-501/default", 1),
		);

		const sessions = await listSessions();

		expect(sessions).toHaveLength(0);
	});

	test("returns empty array when 'no sessions' in stderr", async () => {
		spawnSpy.mockImplementation(() => mockSpawnResult("", "no sessions", 1));

		const sessions = await listSessions();

		expect(sessions).toHaveLength(0);
	});

	test("throws AgentError on other tmux failures", async () => {
		spawnSpy.mockImplementation(() => mockSpawnResult("", "protocol version mismatch", 1));

		await expect(listSessions()).rejects.toThrow(AgentError);
	});

	test("skips malformed lines", async () => {
		spawnSpy.mockImplementation(() =>
			mockSpawnResult("valid-session:123\nmalformed-no-colon\n:no-name\n\n", "", 0),
		);

		const sessions = await listSessions();

		expect(sessions).toHaveLength(1);
		expect(sessions[0]?.name).toBe("valid-session");
		expect(sessions[0]?.pid).toBe(123);
	});

	test("passes correct args to tmux", async () => {
		spawnSpy.mockImplementation(() => mockSpawnResult("", "", 0));

		await listSessions();

		expect(spawnSpy).toHaveBeenCalledTimes(1);
		const callArgs = spawnSpy.mock.calls[0] as unknown[];
		const cmd = callArgs[0] as string[];
		expect(cmd).toEqual([
			"tmux",
			"-L",
			"overstory",
			"list-sessions",
			"-F",
			"#{session_name}:#{pid}",
		]);
	});
});

describe("getPanePid", () => {
	let spawnSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		spawnSpy = spyOn(Bun, "spawn");
	});

	afterEach(() => {
		spawnSpy.mockRestore();
	});

	test("returns PID from tmux display-message", async () => {
		spawnSpy.mockImplementation(() => mockSpawnResult("42\n", "", 0));

		const pid = await getPanePid("overstory-auth");

		expect(pid).toBe(42);
		const callArgs = spawnSpy.mock.calls[0] as unknown[];
		const cmd = callArgs[0] as string[];
		expect(cmd).toEqual([
			"tmux",
			"-L",
			"overstory",
			"display-message",
			"-p",
			"-t",
			"overstory-auth",
			"#{pane_pid}",
		]);
	});

	test("returns null when session does not exist", async () => {
		spawnSpy.mockImplementation(() => mockSpawnResult("", "can't find session: gone", 1));

		const pid = await getPanePid("gone");

		expect(pid).toBeNull();
	});

	test("returns null when output is empty", async () => {
		spawnSpy.mockImplementation(() => mockSpawnResult("", "", 0));

		const pid = await getPanePid("empty-output");

		expect(pid).toBeNull();
	});

	test("returns null when output is not a number", async () => {
		spawnSpy.mockImplementation(() => mockSpawnResult("not-a-pid\n", "", 0));

		const pid = await getPanePid("bad-output");

		expect(pid).toBeNull();
	});
});

describe("getDescendantPids", () => {
	let spawnSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		spawnSpy = spyOn(Bun, "spawn");
	});

	afterEach(() => {
		spawnSpy.mockRestore();
	});

	test("returns empty array when process has no children", async () => {
		spawnSpy.mockImplementation(() => mockSpawnResult("", "", 1));

		const pids = await getDescendantPids(100);

		expect(pids).toEqual([]);
	});

	test("returns direct children when they have no grandchildren", async () => {
		let callCount = 0;
		spawnSpy.mockImplementation(() => {
			callCount++;
			if (callCount === 1) {
				// pgrep -P 100 → children 200, 300
				return mockSpawnResult("200\n300\n", "", 0);
			}
			// pgrep -P 200 and pgrep -P 300 → no grandchildren
			return mockSpawnResult("", "", 1);
		});

		const pids = await getDescendantPids(100);

		expect(pids).toEqual([200, 300]);
	});

	test("returns descendants in depth-first order (deepest first)", async () => {
		// Tree: 100 → 200 → 400
		//             → 300
		let callCount = 0;
		spawnSpy.mockImplementation(() => {
			callCount++;
			if (callCount === 1) {
				// pgrep -P 100 → children 200, 300
				return mockSpawnResult("200\n300\n", "", 0);
			}
			if (callCount === 2) {
				// pgrep -P 200 → child 400
				return mockSpawnResult("400\n", "", 0);
			}
			if (callCount === 3) {
				// pgrep -P 400 → no children
				return mockSpawnResult("", "", 1);
			}
			// pgrep -P 300 → no children
			return mockSpawnResult("", "", 1);
		});

		const pids = await getDescendantPids(100);

		// Deepest-first: 400 (grandchild), then 200, 300 (direct children)
		expect(pids).toEqual([400, 200, 300]);
	});

	test("handles deeply nested tree", async () => {
		// Tree: 1 → 2 → 3 → 4
		let callCount = 0;
		spawnSpy.mockImplementation(() => {
			callCount++;
			if (callCount === 1) {
				// pgrep -P 1 → 2
				return mockSpawnResult("2\n", "", 0);
			}
			if (callCount === 2) {
				// pgrep -P 2 → 3
				return mockSpawnResult("3\n", "", 0);
			}
			if (callCount === 3) {
				// pgrep -P 3 → 4
				return mockSpawnResult("4\n", "", 0);
			}
			// pgrep -P 4 → no children
			return mockSpawnResult("", "", 1);
		});

		const pids = await getDescendantPids(1);

		// Deepest-first: 4, 3, 2
		expect(pids).toEqual([4, 3, 2]);
	});

	test("skips non-numeric pgrep output lines", async () => {
		spawnSpy.mockImplementation((...args: unknown[]) => {
			const cmd = (args[0] as string[])[2];
			if (cmd === "100") {
				return mockSpawnResult("200\nnot-a-pid\n300\n", "", 0);
			}
			return mockSpawnResult("", "", 1);
		});

		const pids = await getDescendantPids(100);

		expect(pids).toEqual([200, 300]);
	});
});

describe("isProcessAlive", () => {
	test("returns true for current process (self-check)", () => {
		// process.pid is always alive
		expect(isProcessAlive(process.pid)).toBe(true);
	});

	test("returns false for a non-existent PID", () => {
		// PID 2147483647 (max int32) is extremely unlikely to exist
		expect(isProcessAlive(2147483647)).toBe(false);
	});
});

describe("killProcessTree", () => {
	let spawnSpy: ReturnType<typeof spyOn>;
	let killSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		spawnSpy = spyOn(Bun, "spawn");
		killSpy = spyOn(process, "kill");
	});

	afterEach(() => {
		spawnSpy.mockRestore();
		killSpy.mockRestore();
	});

	test("sends SIGTERM to root when no descendants", async () => {
		// pgrep -P 100 → no children
		spawnSpy.mockImplementation(() => mockSpawnResult("", "", 1));
		killSpy.mockImplementation(() => true);

		await killProcessTree(100, 0);

		expect(killSpy).toHaveBeenCalledWith(100, "SIGTERM");
	});

	test("sends SIGTERM deepest-first then SIGKILL survivors", async () => {
		// Tree: 100 → 200 → 300
		let pgrepCallCount = 0;
		spawnSpy.mockImplementation(() => {
			pgrepCallCount++;
			if (pgrepCallCount === 1) {
				// pgrep -P 100 → 200
				return mockSpawnResult("200\n", "", 0);
			}
			if (pgrepCallCount === 2) {
				// pgrep -P 200 → 300
				return mockSpawnResult("300\n", "", 0);
			}
			// pgrep -P 300 → no children
			return mockSpawnResult("", "", 1);
		});

		const signals: Array<{ pid: number; signal: string }> = [];
		killSpy.mockImplementation((pid: number, signal: string | number) => {
			signals.push({ pid, signal: String(signal) });
			return true;
		});

		await killProcessTree(100, 0);

		// Phase 1 (SIGTERM): deepest-first → 300, 200, then root 100
		// Phase 2 (SIGKILL): isProcessAlive check (signal 0), then SIGKILL for survivors
		const sigterms = signals.filter((s) => s.signal === "SIGTERM");
		expect(sigterms).toEqual([
			{ pid: 300, signal: "SIGTERM" },
			{ pid: 200, signal: "SIGTERM" },
			{ pid: 100, signal: "SIGTERM" },
		]);
	});

	test("sends SIGKILL to survivors after grace period", async () => {
		// Tree: 100 → 200 (no grandchildren)
		let pgrepCallCount = 0;
		spawnSpy.mockImplementation(() => {
			pgrepCallCount++;
			if (pgrepCallCount === 1) {
				return mockSpawnResult("200\n", "", 0);
			}
			return mockSpawnResult("", "", 1);
		});

		const signals: Array<{ pid: number; signal: string | number }> = [];
		killSpy.mockImplementation((pid: number, signal: string | number) => {
			signals.push({ pid, signal });
			// signal 0 is the isProcessAlive check — simulate processes still alive
			return true;
		});

		await killProcessTree(100, 10); // 10ms grace period for test speed

		// Should have: SIGTERM(200), SIGTERM(100), alive-check(200), SIGKILL(200),
		//              alive-check(100), SIGKILL(100)
		const sigkills = signals.filter((s) => s.signal === "SIGKILL");
		expect(sigkills.length).toBe(2);
		expect(sigkills[0]).toEqual({ pid: 200, signal: "SIGKILL" });
		expect(sigkills[1]).toEqual({ pid: 100, signal: "SIGKILL" });
	});

	test("skips SIGKILL for processes that died during grace period", async () => {
		// No children
		spawnSpy.mockImplementation(() => mockSpawnResult("200\n", "", 0));
		// First call for pgrep children of 200
		let pgrepCallCount = 0;
		spawnSpy.mockImplementation(() => {
			pgrepCallCount++;
			if (pgrepCallCount === 1) {
				return mockSpawnResult("200\n", "", 0);
			}
			return mockSpawnResult("", "", 1);
		});

		const signals: Array<{ pid: number; signal: string | number }> = [];
		killSpy.mockImplementation((pid: number, signal: string | number) => {
			signals.push({ pid, signal });
			// signal 0 (isProcessAlive) — processes are dead
			if (signal === 0) {
				throw new Error("ESRCH");
			}
			return true;
		});

		await killProcessTree(100, 10);

		// Should have SIGTERM calls but no SIGKILL (processes died)
		const sigkills = signals.filter((s) => s.signal === "SIGKILL");
		expect(sigkills).toEqual([]);
	});

	test("silently handles SIGTERM errors for already-dead processes", async () => {
		// No children
		spawnSpy.mockImplementation(() => mockSpawnResult("", "", 1));

		killSpy.mockImplementation(() => {
			throw new Error("ESRCH: No such process");
		});

		// Should not throw
		await killProcessTree(100, 0);
	});
});

describe("killSession", () => {
	let spawnSpy: ReturnType<typeof spyOn>;
	let killSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		spawnSpy = spyOn(Bun, "spawn");
		killSpy = spyOn(process, "kill");
	});

	afterEach(() => {
		spawnSpy.mockRestore();
		killSpy.mockRestore();
	});

	test("gets pane PID, kills process tree, then kills tmux session", async () => {
		const cmds: string[][] = [];
		spawnSpy.mockImplementation((...args: unknown[]) => {
			const cmd = args[0] as string[];
			cmds.push(cmd);

			if (cmd[0] === "tmux" && cmd[3] === "display-message") {
				// getPanePid → returns PID 500
				return mockSpawnResult("500\n", "", 0);
			}
			if (cmd[0] === "pgrep") {
				// getDescendantPids → no children
				return mockSpawnResult("", "", 1);
			}
			if (cmd[0] === "tmux" && cmd[3] === "kill-session") {
				return mockSpawnResult("", "", 0);
			}
			return mockSpawnResult("", "", 0);
		});

		killSpy.mockImplementation(() => true);

		await killSession("overstory-auth");

		// Should have called: tmux display-message, pgrep, tmux kill-session
		expect(cmds[0]).toEqual([
			"tmux",
			"-L",
			"overstory",
			"display-message",
			"-p",
			"-t",
			"overstory-auth",
			"#{pane_pid}",
		]);
		expect(cmds[1]).toEqual(["pgrep", "-P", "500"]);
		const lastCmd = cmds[cmds.length - 1];
		expect(lastCmd).toEqual(["tmux", "-L", "overstory", "kill-session", "-t", "overstory-auth"]);

		// Should have sent SIGTERM to root PID 500
		expect(killSpy).toHaveBeenCalledWith(500, "SIGTERM");
	});

	test("skips process cleanup when pane PID is not available", async () => {
		const cmds: string[][] = [];
		spawnSpy.mockImplementation((...args: unknown[]) => {
			const cmd = args[0] as string[];
			cmds.push(cmd);

			if (cmd[0] === "tmux" && cmd[3] === "display-message") {
				// getPanePid → session not found
				return mockSpawnResult("", "can't find session", 1);
			}
			if (cmd[0] === "tmux" && cmd[3] === "kill-session") {
				return mockSpawnResult("", "", 0);
			}
			return mockSpawnResult("", "", 0);
		});

		await killSession("overstory-auth");

		// Should go straight to tmux kill-session (no pgrep calls)
		expect(cmds).toHaveLength(2);
		expect(cmds[0]?.[3]).toBe("display-message");
		expect(cmds[1]?.[3]).toBe("kill-session");
		// No process.kill calls since we had no PID
		expect(killSpy).not.toHaveBeenCalled();
	});

	test("succeeds silently when session is already gone after process cleanup", async () => {
		spawnSpy.mockImplementation((...args: unknown[]) => {
			const cmd = args[0] as string[];
			if (cmd[0] === "tmux" && cmd[3] === "display-message") {
				return mockSpawnResult("500\n", "", 0);
			}
			if (cmd[0] === "pgrep") {
				return mockSpawnResult("", "", 1);
			}
			if (cmd[0] === "tmux" && cmd[3] === "kill-session") {
				// Session already gone after process cleanup
				return mockSpawnResult("", "can't find session: overstory-auth", 1);
			}
			return mockSpawnResult("", "", 0);
		});

		killSpy.mockImplementation(() => true);

		// Should not throw — session disappearing is expected
		await killSession("overstory-auth");
	});

	test("throws AgentError on unexpected tmux kill-session failure", async () => {
		spawnSpy.mockImplementation((...args: unknown[]) => {
			const cmd = args[0] as string[];
			if (cmd[0] === "tmux" && cmd[3] === "display-message") {
				return mockSpawnResult("", "can't find session", 1);
			}
			if (cmd[0] === "tmux" && cmd[3] === "kill-session") {
				return mockSpawnResult("", "server exited unexpectedly", 1);
			}
			return mockSpawnResult("", "", 0);
		});

		await expect(killSession("broken-session")).rejects.toThrow(AgentError);
	});

	test("AgentError contains session name on failure", async () => {
		spawnSpy.mockImplementation((...args: unknown[]) => {
			const cmd = args[0] as string[];
			if (cmd[0] === "tmux" && cmd[3] === "display-message") {
				return mockSpawnResult("", "error", 1);
			}
			if (cmd[0] === "tmux" && cmd[3] === "kill-session") {
				return mockSpawnResult("", "server exited unexpectedly", 1);
			}
			return mockSpawnResult("", "", 0);
		});

		try {
			await killSession("ghost-agent");
			expect(true).toBe(false);
		} catch (err: unknown) {
			expect(err).toBeInstanceOf(AgentError);
			const agentErr = err as AgentError;
			expect(agentErr.message).toContain("ghost-agent");
			expect(agentErr.agentName).toBe("ghost-agent");
		}
	});

	test("throws AgentError when called with empty session name", async () => {
		// Defense in depth (overstory-74ce): tmux's `-t` argument prefix-matches
		// every session in the server when given an empty string. Without this
		// guard a regression in any caller would wildcard-kill the entire
		// overstory swarm. spawn must NOT be invoked.
		await expect(killSession("")).rejects.toThrow(AgentError);
		expect(spawnSpy).not.toHaveBeenCalled();

		try {
			await killSession("");
		} catch (err: unknown) {
			const agentErr = err as AgentError;
			expect(agentErr.message).toContain("wildcard");
		}
	});
});

describe("isSessionAlive", () => {
	let spawnSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		spawnSpy = spyOn(Bun, "spawn");
	});

	afterEach(() => {
		spawnSpy.mockRestore();
	});

	test("returns true when session exists (exit 0)", async () => {
		spawnSpy.mockImplementation(() => mockSpawnResult("", "", 0));

		const alive = await isSessionAlive("overstory-auth");

		expect(alive).toBe(true);
	});

	test("returns false when session does not exist (non-zero exit)", async () => {
		spawnSpy.mockImplementation(() => mockSpawnResult("", "can't find session: nonexistent", 1));

		const alive = await isSessionAlive("nonexistent");

		expect(alive).toBe(false);
	});

	test("passes correct args to tmux has-session", async () => {
		spawnSpy.mockImplementation(() => mockSpawnResult("", "", 0));

		await isSessionAlive("my-agent");

		expect(spawnSpy).toHaveBeenCalledTimes(1);
		const callArgs = spawnSpy.mock.calls[0] as unknown[];
		const cmd = callArgs[0] as string[];
		expect(cmd).toEqual(["tmux", "-L", "overstory", "has-session", "-t", "my-agent"]);
	});

	test("returns false for empty session name without calling tmux", async () => {
		// Defense in depth (overstory-74ce): an empty `-t` argument prefix-matches
		// every overstory session, so `has-session` would falsely report alive
		// whenever any agent is running. Short-circuit to false without invoking tmux.
		const alive = await isSessionAlive("");
		expect(alive).toBe(false);
		expect(spawnSpy).not.toHaveBeenCalled();
	});
});

describe("checkSessionState", () => {
	let spawnSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		spawnSpy = spyOn(Bun, "spawn");
	});

	afterEach(() => {
		spawnSpy.mockRestore();
	});

	test("returns alive when tmux has-session succeeds", async () => {
		spawnSpy.mockReturnValue(mockSpawnResult("", "", 0));
		const state = await checkSessionState("overstory-test-coordinator");
		expect(state).toBe("alive");
	});

	test("returns no_server when tmux reports no server running", async () => {
		spawnSpy.mockReturnValue(
			mockSpawnResult("", "no server running on /tmp/tmux-1000/default\n", 1),
		);
		const state = await checkSessionState("overstory-test-coordinator");
		expect(state).toBe("no_server");
	});

	test("returns no_server when tmux reports no sessions", async () => {
		spawnSpy.mockReturnValue(mockSpawnResult("", "no sessions\n", 1));
		const state = await checkSessionState("overstory-test-coordinator");
		expect(state).toBe("no_server");
	});

	test("returns dead when session not found", async () => {
		spawnSpy.mockReturnValue(
			mockSpawnResult("", "can't find session: overstory-test-coordinator\n", 1),
		);
		const state = await checkSessionState("overstory-test-coordinator");
		expect(state).toBe("dead");
	});

	test("returns dead for generic tmux failure", async () => {
		spawnSpy.mockReturnValue(
			mockSpawnResult("", "error connecting to /tmp/tmux-1000/default\n", 1),
		);
		const state = await checkSessionState("overstory-test-coordinator");
		expect(state).toBe("dead");
	});
});

describe("sendKeys", () => {
	let spawnSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		spawnSpy = spyOn(Bun, "spawn");
	});

	afterEach(() => {
		spawnSpy.mockRestore();
	});

	test("passes correct args to tmux send-keys", async () => {
		spawnSpy.mockImplementation(() => mockSpawnResult("", "", 0));

		await sendKeys("overstory-auth", "echo hello world");

		expect(spawnSpy).toHaveBeenCalledTimes(1);
		const callArgs = spawnSpy.mock.calls[0] as unknown[];
		const cmd = callArgs[0] as string[];
		expect(cmd).toEqual([
			"tmux",
			"-L",
			"overstory",
			"send-keys",
			"-t",
			"overstory-auth",
			"echo hello world",
			"Enter",
		]);
	});

	test("flattens newlines in keys to spaces", async () => {
		spawnSpy.mockImplementation(() => mockSpawnResult("", "", 0));

		await sendKeys("overstory-agent", "line1\nline2\nline3");

		expect(spawnSpy).toHaveBeenCalledTimes(1);
		const callArgs = spawnSpy.mock.calls[0] as unknown[];
		const cmd = callArgs[0] as string[];
		expect(cmd).toEqual([
			"tmux",
			"-L",
			"overstory",
			"send-keys",
			"-t",
			"overstory-agent",
			"line1 line2 line3",
			"Enter",
		]);
	});

	test("throws AgentError on failure", async () => {
		spawnSpy.mockImplementation(() => mockSpawnResult("", "session not found: dead-agent", 1));

		await expect(sendKeys("dead-agent", "echo test")).rejects.toThrow(AgentError);
	});

	test("AgentError contains session name on failure", async () => {
		spawnSpy.mockImplementation(() => mockSpawnResult("", "session not found: my-agent", 1));

		try {
			await sendKeys("my-agent", "test command");
			expect(true).toBe(false);
		} catch (err: unknown) {
			expect(err).toBeInstanceOf(AgentError);
			const agentErr = err as AgentError;
			expect(agentErr.message).toContain("my-agent");
			expect(agentErr.agentName).toBe("my-agent");
		}
	});

	test("sends Enter with empty string (follow-up submission)", async () => {
		spawnSpy.mockImplementation(() => mockSpawnResult("", "", 0));

		await sendKeys("overstory-agent", "");

		expect(spawnSpy).toHaveBeenCalledTimes(1);
		const callArgs = spawnSpy.mock.calls[0] as unknown[];
		const cmd = callArgs[0] as string[];
		expect(cmd).toEqual([
			"tmux",
			"-L",
			"overstory",
			"send-keys",
			"-t",
			"overstory-agent",
			"",
			"Enter",
		]);
	});

	test("throws descriptive error when tmux server is not running", async () => {
		spawnSpy.mockImplementation(() =>
			mockSpawnResult("", "no server running on /tmp/tmux-0/default\n", 1),
		);
		await expect(sendKeys("overstory-agent-fake", "hello")).rejects.toThrow(
			/Tmux server is not running/,
		);
	});

	test("throws descriptive error when session not found", async () => {
		spawnSpy.mockImplementation(() =>
			mockSpawnResult("", "cant find session: overstory-agent-fake\n", 1),
		);
		await expect(sendKeys("overstory-agent-fake", "hello")).rejects.toThrow(/does not exist/);
	});

	test("throws generic error for other failures", async () => {
		spawnSpy.mockImplementation(() => mockSpawnResult("", "some other error\n", 1));
		await expect(sendKeys("overstory-agent-fake", "hello")).rejects.toThrow(/Failed to send keys/);
	});

	test("retries on transient 'can't find pane' error", async () => {
		let callCount = 0;
		spawnSpy.mockImplementation(() => {
			callCount++;
			if (callCount === 1) {
				// First send-keys fails with transient pane error
				return mockSpawnResult("", "can't find pane\n", 1);
			}
			// Second attempt succeeds
			return mockSpawnResult("", "", 0);
		});

		await sendKeys("overstory-retry-agent", "hello world");
		expect(spawnSpy).toHaveBeenCalledTimes(2);
	});

	test("does not retry on permanent 'session not found' error", async () => {
		spawnSpy.mockImplementation(() => mockSpawnResult("", "cant find session: gone-agent\n", 1));

		await expect(sendKeys("gone-agent", "hello", 3)).rejects.toThrow(/does not exist/);
		// Only called once — no retries for permanent errors
		expect(spawnSpy).toHaveBeenCalledTimes(1);
	});

	test("throws after exhausting retries on transient error", async () => {
		spawnSpy.mockImplementation(() => mockSpawnResult("", "can't find pane\n", 1));

		await expect(sendKeys("overstory-exhaust", "hello", 2)).rejects.toThrow(/not found after/);
		// Initial + 2 retries = 3 calls
		expect(spawnSpy).toHaveBeenCalledTimes(3);
	});
});

describe("capturePaneContent", () => {
	let spawnSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		spawnSpy = spyOn(Bun, "spawn");
	});

	afterEach(() => {
		spawnSpy.mockRestore();
	});

	test("returns trimmed content on success", async () => {
		spawnSpy.mockImplementation(() => mockSpawnResult("  Welcome to Claude Code!  \n\n", "", 0));

		const content = await capturePaneContent("overstory-agent");

		expect(content).toBe("Welcome to Claude Code!");
	});

	test("passes correct args to tmux capture-pane", async () => {
		spawnSpy.mockImplementation(() => mockSpawnResult("some content", "", 0));

		await capturePaneContent("my-session", 100);

		const callArgs = spawnSpy.mock.calls[0] as unknown[];
		const cmd = callArgs[0] as string[];
		expect(cmd).toEqual([
			"tmux",
			"-L",
			"overstory",
			"capture-pane",
			"-t",
			"my-session",
			"-p",
			"-S",
			"-100",
		]);
	});

	test("uses default 50 lines when not specified", async () => {
		spawnSpy.mockImplementation(() => mockSpawnResult("content", "", 0));

		await capturePaneContent("my-session");

		const callArgs = spawnSpy.mock.calls[0] as unknown[];
		const cmd = callArgs[0] as string[];
		expect(cmd[8]).toBe("-50");
	});

	test("returns null when capture-pane fails", async () => {
		spawnSpy.mockImplementation(() => mockSpawnResult("", "can't find session: gone", 1));

		const content = await capturePaneContent("gone");

		expect(content).toBeNull();
	});

	test("returns null when pane is empty (whitespace only)", async () => {
		spawnSpy.mockImplementation(() => mockSpawnResult("   \n\n  \n", "", 0));

		const content = await capturePaneContent("empty-pane");

		expect(content).toBeNull();
	});
});

/** Claude-like detectReady for tests — matches the existing hardcoded behavior. */
function claudeDetectReady(paneContent: string): ReadyState {
	if (
		paneContent.includes("WARNING: Claude Code running in Bypass Permissions mode") &&
		paneContent.includes("1. No, exit") &&
		paneContent.includes("2. Yes, I accept")
	) {
		return { phase: "dialog", action: "type:2" };
	}
	if (paneContent.includes("trust this folder")) {
		return { phase: "dialog", action: "Enter" };
	}
	const hasPrompt = paneContent.includes("\u276f") || paneContent.includes('Try "');
	const hasStatusBar =
		paneContent.includes("bypass permissions") || paneContent.includes("shift+tab");
	if (hasPrompt && hasStatusBar) {
		return { phase: "ready" };
	}
	return { phase: "loading" };
}

describe("waitForTuiReady", () => {
	let spawnSpy: ReturnType<typeof spyOn>;
	let sleepSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		spawnSpy = spyOn(Bun, "spawn");
		// Mock Bun.sleep to avoid real delays in tests.
		// Cast needed because Bun.sleep has overloads that confuse spyOn's type inference.
		sleepSpy = spyOn(Bun as Record<string, unknown>, "sleep").mockResolvedValue(undefined);
	});

	afterEach(() => {
		spawnSpy.mockRestore();
		sleepSpy.mockRestore();
	});

	test("returns true immediately when pane has content on first poll", async () => {
		spawnSpy.mockImplementation(() =>
			mockSpawnResult('Try "help" to get started\nbypass permissions', "", 0),
		);

		const ready = await waitForTuiReady("overstory-agent", claudeDetectReady, 5_000, 500);

		expect(ready).toBe(true);
		// Should not have needed to sleep (content found on first poll)
		expect(sleepSpy).not.toHaveBeenCalled();
	});

	test("returns true after content appears on later poll", async () => {
		let captureCallCount = 0;
		spawnSpy.mockImplementation((...args: unknown[]) => {
			const cmd = args[0] as string[];
			if (cmd[3] === "capture-pane") {
				captureCallCount++;
				if (captureCallCount <= 3) {
					// First 3 capture-pane polls: empty pane (TUI still loading)
					return mockSpawnResult("", "", 0);
				}
				// 4th poll: content appears with both prompt indicator and status bar
				return mockSpawnResult("Welcome to Claude Code!\n\n\u276f\nbypass permissions", "", 0);
			}
			// has-session: session is alive throughout
			return mockSpawnResult("", "", 0);
		});

		const ready = await waitForTuiReady("overstory-agent", claudeDetectReady, 10_000, 500);

		expect(ready).toBe(true);
		// Should have slept 3 times (3 empty capture-pane polls before content appeared)
		expect(sleepSpy).toHaveBeenCalledTimes(3);
	});

	test("returns false when timeout expires without content", async () => {
		// Pane always empty
		spawnSpy.mockImplementation(() => mockSpawnResult("", "", 0));

		const ready = await waitForTuiReady("overstory-agent", claudeDetectReady, 2_000, 500);

		expect(ready).toBe(false);
		// 2000ms / 500ms = 4 polls, 4 sleeps
		expect(sleepSpy).toHaveBeenCalledTimes(4);
	});

	test("returns false when capture-pane always fails", async () => {
		spawnSpy.mockImplementation(() => mockSpawnResult("", "session not found", 1));

		const ready = await waitForTuiReady("dead-session", claudeDetectReady, 1_000, 500);

		expect(ready).toBe(false);
	});

	test("uses default timeout and poll interval", async () => {
		// Return content immediately with both indicators
		spawnSpy.mockImplementation(() => mockSpawnResult('Try "help"\nshift+tab', "", 0));

		const ready = await waitForTuiReady("overstory-agent", claudeDetectReady);

		expect(ready).toBe(true);
	});

	test("returns false immediately when session is dead", async () => {
		// capture-pane fails (session dead), has-session also fails (session dead)
		spawnSpy.mockImplementation((...args: unknown[]) => {
			const cmd = args[0] as string[];
			if (cmd[3] === "capture-pane") {
				return mockSpawnResult("", "can't find session", 1);
			}
			// has-session: session is dead
			return mockSpawnResult("", "can't find session", 1);
		});

		const ready = await waitForTuiReady("dead-session", claudeDetectReady, 15_000, 500);

		expect(ready).toBe(false);
		// Should NOT have polled the full timeout (no sleeps — returned immediately)
		expect(sleepSpy).not.toHaveBeenCalled();
	});

	test("continues polling when session is alive but pane is empty", async () => {
		let captureCallCount = 0;
		spawnSpy.mockImplementation((...args: unknown[]) => {
			const cmd = args[0] as string[];
			if (cmd[3] === "capture-pane") {
				captureCallCount++;
				// Pane stays empty for all polls (session alive but TUI not rendered yet)
				return mockSpawnResult("", "", 0);
			}
			// has-session: session is alive
			return mockSpawnResult("", "", 0);
		});

		// Use a short timeout so the test doesn't take long
		const ready = await waitForTuiReady("loading-session", claudeDetectReady, 1_000, 500);

		expect(ready).toBe(false);
		// Should have polled multiple times (not returned early)
		expect(captureCallCount).toBeGreaterThan(1);
		expect(sleepSpy).toHaveBeenCalled();
	});

	test("returns false when only prompt seen but no status bar", async () => {
		// Pane always shows prompt indicator but never shows status bar text
		spawnSpy.mockImplementation((...args: unknown[]) => {
			const cmd = args[0] as string[];
			if (cmd[3] === "capture-pane") {
				return mockSpawnResult("Welcome to Claude Code!\n\u276f", "", 0);
			}
			// has-session: session is alive
			return mockSpawnResult("", "", 0);
		});

		const ready = await waitForTuiReady("overstory-agent", claudeDetectReady, 1_000, 500);

		expect(ready).toBe(false);
	});

	test("returns false when only status bar seen but no prompt", async () => {
		// Pane always shows status bar but never shows prompt indicator
		spawnSpy.mockImplementation((...args: unknown[]) => {
			const cmd = args[0] as string[];
			if (cmd[3] === "capture-pane") {
				return mockSpawnResult("bypass permissions", "", 0);
			}
			// has-session: session is alive
			return mockSpawnResult("", "", 0);
		});

		const ready = await waitForTuiReady("overstory-agent", claudeDetectReady, 1_000, 500);

		expect(ready).toBe(false);
	});

	test("returns true when prompt and status bar appear on different polls", async () => {
		let captureCallCount = 0;
		spawnSpy.mockImplementation((...args: unknown[]) => {
			const cmd = args[0] as string[];
			if (cmd[3] === "capture-pane") {
				captureCallCount++;
				if (captureCallCount <= 2) {
					// First 2 polls: only prompt indicator visible (phase 1 only)
					return mockSpawnResult("Welcome to Claude Code!\n\u276f", "", 0);
				}
				// 3rd poll onwards: both prompt and status bar visible
				return mockSpawnResult("Welcome to Claude Code!\n\u276f\nbypass permissions", "", 0);
			}
			// has-session: session is alive
			return mockSpawnResult("", "", 0);
		});

		const ready = await waitForTuiReady("overstory-agent", claudeDetectReady, 10_000, 500);

		expect(ready).toBe(true);
		// Should have slept at least twice (2 polls with only prompt before both appeared)
		expect(sleepSpy).toHaveBeenCalledTimes(2);
	});

	test("detects trust dialog and auto-confirms with Enter", async () => {
		const sendKeysCalls: string[][] = [];
		let captureCallCount = 0;
		spawnSpy.mockImplementation((...args: unknown[]) => {
			const cmd = args[0] as string[];
			if (cmd[3] === "capture-pane") {
				captureCallCount++;
				if (captureCallCount === 1) {
					// First poll: trust dialog is showing
					return mockSpawnResult("Do you trust this folder?", "", 0);
				}
				// Subsequent polls: trust confirmed, real TUI with both indicators
				return mockSpawnResult('Try "help"\nshift+tab', "", 0);
			}
			if (cmd[3] === "send-keys") {
				sendKeysCalls.push(cmd);
				return mockSpawnResult("", "", 0);
			}
			// has-session: session is alive
			return mockSpawnResult("", "", 0);
		});

		const ready = await waitForTuiReady("overstory-agent", claudeDetectReady, 10_000, 500);

		expect(ready).toBe(true);
		// sendKeys should have been called once to confirm the trust dialog
		expect(sendKeysCalls).toHaveLength(1);
		const trustCall = sendKeysCalls[0];
		expect(trustCall).toEqual([
			"tmux",
			"-L",
			"overstory",
			"send-keys",
			"-t",
			"overstory-agent",
			"",
			"Enter",
		]);
	});

	test("detects bypass permissions dialog and types 2 before Enter", async () => {
		const sendKeysCalls: string[][] = [];
		let captureCallCount = 0;
		spawnSpy.mockImplementation((...args: unknown[]) => {
			const cmd = args[0] as string[];
			if (cmd[3] === "capture-pane") {
				captureCallCount++;
				if (captureCallCount === 1) {
					return mockSpawnResult(
						"WARNING: Claude Code running in Bypass Permissions mode\n❯ 1. No, exit\n2. Yes, I accept",
						"",
						0,
					);
				}
				return mockSpawnResult('Try "help"\nshift+tab', "", 0);
			}
			if (cmd[3] === "send-keys") {
				sendKeysCalls.push(cmd);
				return mockSpawnResult("", "", 0);
			}
			return mockSpawnResult("", "", 0);
		});

		const ready = await waitForTuiReady("overstory-agent", claudeDetectReady, 10_000, 500);

		expect(ready).toBe(true);
		expect(sendKeysCalls).toHaveLength(2);
		expect(sendKeysCalls[0]).toEqual([
			"tmux",
			"-L",
			"overstory",
			"send-keys",
			"-t",
			"overstory-agent",
			"2",
		]);
		expect(sendKeysCalls[1]).toEqual([
			"tmux",
			"-L",
			"overstory",
			"send-keys",
			"-t",
			"overstory-agent",
			"",
			"Enter",
		]);
	});

	test("retries typed bypass dialog action when the same dialog persists", async () => {
		const sendKeysCalls: string[][] = [];
		let captureCallCount = 0;
		spawnSpy.mockImplementation((...args: unknown[]) => {
			const cmd = args[0] as string[];
			if (cmd[3] === "capture-pane") {
				captureCallCount++;
				if (captureCallCount <= 3) {
					return mockSpawnResult(
						"WARNING: Claude Code running in Bypass Permissions mode\n❯ 1. No, exit\n2. Yes, I accept",
						"",
						0,
					);
				}
				return mockSpawnResult('Try "help"\nshift+tab', "", 0);
			}
			if (cmd[3] === "send-keys") {
				sendKeysCalls.push(cmd);
				return mockSpawnResult("", "", 0);
			}
			return mockSpawnResult("", "", 0);
		});

		const ready = await waitForTuiReady("overstory-agent", claudeDetectReady, 10_000, 500);

		expect(ready).toBe(true);
		expect(sendKeysCalls).toHaveLength(4);
		expect(sendKeysCalls[0]).toEqual([
			"tmux",
			"-L",
			"overstory",
			"send-keys",
			"-t",
			"overstory-agent",
			"2",
		]);
		expect(sendKeysCalls[1]).toEqual([
			"tmux",
			"-L",
			"overstory",
			"send-keys",
			"-t",
			"overstory-agent",
			"",
			"Enter",
		]);
		expect(sendKeysCalls[2]).toEqual([
			"tmux",
			"-L",
			"overstory",
			"send-keys",
			"-t",
			"overstory-agent",
			"2",
		]);
		expect(sendKeysCalls[3]).toEqual([
			"tmux",
			"-L",
			"overstory",
			"send-keys",
			"-t",
			"overstory-agent",
			"",
			"Enter",
		]);
	});

	test("handles trust dialog only once (trustHandled flag)", async () => {
		const sendKeysCalls: string[][] = [];
		let captureCallCount = 0;
		spawnSpy.mockImplementation((...args: unknown[]) => {
			const cmd = args[0] as string[];
			if (cmd[3] === "capture-pane") {
				captureCallCount++;
				if (captureCallCount <= 3) {
					// Multiple polls still show trust dialog (slow dialog dismissal)
					return mockSpawnResult("Do you trust this folder?", "", 0);
				}
				// Eventually TUI loads with both indicators
				return mockSpawnResult('Try "help"\nbypass permissions', "", 0);
			}
			if (cmd[3] === "send-keys") {
				sendKeysCalls.push(cmd);
				return mockSpawnResult("", "", 0);
			}
			// has-session: session is alive
			return mockSpawnResult("", "", 0);
		});

		const ready = await waitForTuiReady("overstory-agent", claudeDetectReady, 10_000, 500);

		expect(ready).toBe(true);
		// sendKeys must be called exactly once — dialogHandled prevents duplicate Enter sends
		expect(sendKeysCalls).toHaveLength(1);
	});
});

describe("ensureTmuxAvailable", () => {
	let spawnSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		spawnSpy = spyOn(Bun, "spawn");
	});

	afterEach(() => {
		spawnSpy.mockRestore();
	});

	test("succeeds when tmux is available", async () => {
		spawnSpy.mockImplementation(() => mockSpawnResult("tmux 3.3a\n", "", 0));

		// Should not throw
		await ensureTmuxAvailable();

		expect(spawnSpy).toHaveBeenCalledTimes(1);
		const callArgs = spawnSpy.mock.calls[0] as unknown[];
		const cmd = callArgs[0] as string[];
		expect(cmd).toEqual(["tmux", "-V"]);
	});

	test("throws AgentError when tmux is not installed", async () => {
		spawnSpy.mockImplementation(() => mockSpawnResult("", "tmux: command not found", 1));

		await expect(ensureTmuxAvailable()).rejects.toThrow(AgentError);
	});

	test("AgentError message mentions tmux not installed", async () => {
		spawnSpy.mockImplementation(() => mockSpawnResult("", "", 127));

		try {
			await ensureTmuxAvailable();
			expect(true).toBe(false); // Should have thrown
		} catch (err: unknown) {
			expect(err).toBeInstanceOf(AgentError);
			const agentErr = err as AgentError;
			expect(agentErr.message).toContain("tmux is not installed");
		}
	});
});

describe("sanitizeTmuxName", () => {
	test("replaces dots with underscores", () => {
		expect(sanitizeTmuxName("consulting.jayminwest.com")).toBe("consulting_jayminwest_com");
	});

	test("replaces colons with underscores", () => {
		expect(sanitizeTmuxName("host:8080")).toBe("host_8080");
	});

	test("replaces mixed dots and colons", () => {
		expect(sanitizeTmuxName("my.project:v2.0")).toBe("my_project_v2_0");
	});

	test("leaves names without special characters unchanged", () => {
		expect(sanitizeTmuxName("my-project")).toBe("my-project");
	});

	test("handles empty string", () => {
		expect(sanitizeTmuxName("")).toBe("");
	});

	test("handles name with only dots", () => {
		expect(sanitizeTmuxName("...")).toBe("___");
	});

	test("produces valid tmux session name components", () => {
		// A real-world project name that would break tmux target parsing
		const projectName = "consulting.jayminwest.com";
		const sessionName = `overstory-${sanitizeTmuxName(projectName)}-coordinator`;
		expect(sessionName).toBe("overstory-consulting_jayminwest_com-coordinator");
		// No dots or colons that tmux would interpret as separators
		expect(sessionName).not.toMatch(/[.:]/);
	});
});

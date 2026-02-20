/**
 * Tests for overstory coordinator command.
 *
 * Uses real temp directories and real git repos for file I/O and config loading.
 * Tmux is injected via the CoordinatorDeps DI interface instead of
 * mock.module() to avoid the process-global mock leak issue
 * (see mulch record mx-56558b).
 *
 * WHY DI instead of mock.module: mock.module() in bun:test is process-global
 * and leaks across test files. The DI approach (same pattern as daemon.ts
 * _tmux/_triage/_nudge) ensures mocks are scoped to each test invocation.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { AgentError, ValidationError } from "../errors.ts";
import { openSessionStore } from "../sessions/compat.ts";
import { createRunStore } from "../sessions/store.ts";
import { cleanupTempDir, createTempGitRepo } from "../test-helpers.ts";
import type { AgentSession } from "../types.ts";
import {
	buildCoordinatorBeacon,
	type CoordinatorDeps,
	coordinatorCommand,
	resolveAttach,
} from "./coordinator.ts";
import { isRunningAsRoot } from "./sling.ts";

// --- Fake Tmux ---

/** Track calls to fake tmux for assertions. */
interface TmuxCallTracker {
	createSession: Array<{
		name: string;
		cwd: string;
		command: string;
		env?: Record<string, string>;
	}>;
	isSessionAlive: Array<{ name: string; result: boolean }>;
	killSession: Array<{ name: string }>;
	sendKeys: Array<{ name: string; keys: string }>;
}

// --- Fake Watchdog ---

/** Track calls to fake watchdog for assertions. */
interface WatchdogCallTracker {
	start: number;
	stop: number;
	isRunning: number;
}

// --- Fake Monitor ---

/** Track calls to fake monitor for assertions. */
interface MonitorCallTracker {
	start: number;
	stop: number;
	isRunning: number;
}

/** Build a fake tmux DI object with configurable session liveness. */
function makeFakeTmux(sessionAliveMap: Record<string, boolean> = {}): {
	tmux: NonNullable<CoordinatorDeps["_tmux"]>;
	calls: TmuxCallTracker;
} {
	const calls: TmuxCallTracker = {
		createSession: [],
		isSessionAlive: [],
		killSession: [],
		sendKeys: [],
	};

	const tmux: NonNullable<CoordinatorDeps["_tmux"]> = {
		createSession: async (
			name: string,
			cwd: string,
			command: string,
			env?: Record<string, string>,
		): Promise<number> => {
			calls.createSession.push({ name, cwd, command, env });
			return 99999; // Fake PID
		},
		isSessionAlive: async (name: string): Promise<boolean> => {
			const alive = sessionAliveMap[name] ?? false;
			calls.isSessionAlive.push({ name, result: alive });
			return alive;
		},
		killSession: async (name: string): Promise<void> => {
			calls.killSession.push({ name });
		},
		sendKeys: async (name: string, keys: string): Promise<void> => {
			calls.sendKeys.push({ name, keys });
		},
	};

	return { tmux, calls };
}

/**
 * Build a fake watchdog DI object with configurable behavior.
 * @param running - Whether the watchdog should report as running
 * @param startSuccess - Whether start() should succeed (return a PID)
 * @param stopSuccess - Whether stop() should succeed (return true)
 */
function makeFakeWatchdog(
	running = false,
	startSuccess = true,
	stopSuccess = true,
): {
	watchdog: NonNullable<CoordinatorDeps["_watchdog"]>;
	calls: WatchdogCallTracker;
} {
	const calls: WatchdogCallTracker = {
		start: 0,
		stop: 0,
		isRunning: 0,
	};

	const watchdog: NonNullable<CoordinatorDeps["_watchdog"]> = {
		async start(): Promise<{ pid: number } | null> {
			calls.start++;
			return startSuccess ? { pid: 88888 } : null;
		},
		async stop(): Promise<boolean> {
			calls.stop++;
			return stopSuccess;
		},
		async isRunning(): Promise<boolean> {
			calls.isRunning++;
			return running;
		},
	};

	return { watchdog, calls };
}

/**
 * Build a fake monitor DI object with configurable behavior.
 * @param running - Whether the monitor should report as running
 * @param startSuccess - Whether start() should succeed (return a PID)
 * @param stopSuccess - Whether stop() should succeed (return true)
 */
function makeFakeMonitor(
	running = false,
	startSuccess = true,
	stopSuccess = true,
): {
	monitor: NonNullable<CoordinatorDeps["_monitor"]>;
	calls: MonitorCallTracker;
} {
	const calls: MonitorCallTracker = {
		start: 0,
		stop: 0,
		isRunning: 0,
	};

	const monitor: NonNullable<CoordinatorDeps["_monitor"]> = {
		async start(): Promise<{ pid: number } | null> {
			calls.start++;
			return startSuccess ? { pid: 77777 } : null;
		},
		async stop(): Promise<boolean> {
			calls.stop++;
			return stopSuccess;
		},
		async isRunning(): Promise<boolean> {
			calls.isRunning++;
			return running;
		},
	};

	return { monitor, calls };
}

// --- Test Setup ---

let tempDir: string;
let overstoryDir: string;
const originalCwd = process.cwd();

/** Save sessions to the SessionStore (sessions.db) for test setup. */
function saveSessionsToDb(sessions: AgentSession[]): void {
	const { store } = openSessionStore(overstoryDir);
	try {
		for (const session of sessions) {
			store.upsert(session);
		}
	} finally {
		store.close();
	}
}

/** Load all sessions from the SessionStore (sessions.db). */
function loadSessionsFromDb(): AgentSession[] {
	const { store } = openSessionStore(overstoryDir);
	try {
		return store.getAll();
	} finally {
		store.close();
	}
}

beforeEach(async () => {
	// Restore cwd FIRST so createTempGitRepo's git operations don't fail
	// if a prior test's tempDir was already cleaned up.
	process.chdir(originalCwd);

	tempDir = await realpath(await createTempGitRepo());
	overstoryDir = join(tempDir, ".overstory");
	await mkdir(overstoryDir, { recursive: true });

	// Write a minimal config.yaml so loadConfig succeeds
	// tier2Enabled: true so existing --monitor tests pass (new skipped tests override inline)
	await Bun.write(
		join(overstoryDir, "config.yaml"),
		[
			"project:",
			"  name: test-project",
			`  root: ${tempDir}`,
			"  canonicalBranch: main",
			"watchdog:",
			"  tier2Enabled: true",
		].join("\n"),
	);

	// Write agent-manifest.json and stub agent-def .md files so manifest loading succeeds
	const agentDefsDir = join(overstoryDir, "agent-defs");
	await mkdir(agentDefsDir, { recursive: true });
	const manifest = {
		version: "1.0",
		agents: {
			coordinator: {
				file: "coordinator.md",
				model: "opus",
				tools: ["Read", "Bash"],
				capabilities: ["coordinate"],
				canSpawn: true,
				constraints: [],
			},
		},
		capabilityIndex: { coordinate: ["coordinator"] },
	};
	await Bun.write(
		join(overstoryDir, "agent-manifest.json"),
		`${JSON.stringify(manifest, null, "\t")}\n`,
	);
	await Bun.write(join(agentDefsDir, "coordinator.md"), "# Coordinator\n");

	// Override cwd so coordinator commands find our temp project
	process.chdir(tempDir);
});

afterEach(async () => {
	process.chdir(originalCwd);
	await cleanupTempDir(tempDir);
});

// --- Helpers ---

function makeCoordinatorSession(overrides: Partial<AgentSession> = {}): AgentSession {
	return {
		id: `session-${Date.now()}-coordinator`,
		agentName: "coordinator",
		capability: "coordinator",
		worktreePath: tempDir,
		branchName: "main",
		beadId: "",
		tmuxSession: "overstory-test-project-coordinator",
		state: "working",
		pid: 99999,
		parentAgent: null,
		depth: 0,
		runId: null,
		startedAt: new Date().toISOString(),
		lastActivity: new Date().toISOString(),
		escalationLevel: 0,
		stalledSince: null,
		...overrides,
	};
}

/** Capture stdout.write output during a function call. */
async function captureStdout(fn: () => Promise<void>): Promise<string> {
	const chunks: string[] = [];
	const originalWrite = process.stdout.write;
	process.stdout.write = ((chunk: string) => {
		chunks.push(chunk);
		return true;
	}) as typeof process.stdout.write;
	try {
		await fn();
	} finally {
		process.stdout.write = originalWrite;
	}
	return chunks.join("");
}

/** Build default CoordinatorDeps with fake tmux, watchdog, and monitor.
 * Always injects fakes for all three to prevent real Bun.spawn(["overstory", ...])
 * calls in tests (overstory CLI is not available in CI). */
function makeDeps(
	sessionAliveMap: Record<string, boolean> = {},
	watchdogConfig?: { running?: boolean; startSuccess?: boolean; stopSuccess?: boolean },
	monitorConfig?: { running?: boolean; startSuccess?: boolean; stopSuccess?: boolean },
): {
	deps: CoordinatorDeps;
	calls: TmuxCallTracker;
	watchdogCalls: WatchdogCallTracker;
	monitorCalls: MonitorCallTracker;
} {
	const { tmux, calls } = makeFakeTmux(sessionAliveMap);
	const { watchdog, calls: watchdogCalls } = makeFakeWatchdog(
		watchdogConfig?.running,
		watchdogConfig?.startSuccess,
		watchdogConfig?.stopSuccess,
	);
	const { monitor, calls: monitorCalls } = makeFakeMonitor(
		monitorConfig?.running,
		monitorConfig?.startSuccess,
		monitorConfig?.stopSuccess,
	);

	const deps: CoordinatorDeps = {
		_tmux: tmux,
		_watchdog: watchdog,
		_monitor: monitor,
	};

	return {
		deps,
		calls,
		watchdogCalls,
		monitorCalls,
	};
}

// --- Tests ---

describe("coordinatorCommand help", () => {
	test("--help outputs help text", async () => {
		const output = await captureStdout(() => coordinatorCommand(["--help"]));
		expect(output).toContain("overstory coordinator");
		expect(output).toContain("start");
		expect(output).toContain("stop");
		expect(output).toContain("status");
	});

	test("--help includes --attach and --no-attach flags", async () => {
		const output = await captureStdout(() => coordinatorCommand(["--help"]));
		expect(output).toContain("--attach");
		expect(output).toContain("--no-attach");
	});

	test("-h outputs help text", async () => {
		const output = await captureStdout(() => coordinatorCommand(["-h"]));
		expect(output).toContain("overstory coordinator");
	});

	test("empty args outputs help text", async () => {
		const output = await captureStdout(() => coordinatorCommand([]));
		expect(output).toContain("overstory coordinator");
		expect(output).toContain("Subcommands:");
	});
});

describe("coordinatorCommand unknown subcommand", () => {
	test("throws ValidationError for unknown subcommand", async () => {
		await expect(coordinatorCommand(["frobnicate"])).rejects.toThrow(ValidationError);
	});

	test("error message includes the bad subcommand name", async () => {
		try {
			await coordinatorCommand(["frobnicate"]);
			expect.unreachable("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(ValidationError);
			const ve = err as ValidationError;
			expect(ve.message).toContain("frobnicate");
			expect(ve.field).toBe("subcommand");
			expect(ve.value).toBe("frobnicate");
		}
	});
});

describe("startCoordinator", () => {
	test("writes session to sessions.json with correct fields", async () => {
		const { deps, calls } = makeDeps();

		// Override Bun.sleep to skip the 3s and 0.5s waits
		const originalSleep = Bun.sleep;
		Bun.sleep = (() => Promise.resolve()) as typeof Bun.sleep;

		try {
			await captureStdout(() => coordinatorCommand(["start"], deps));
		} finally {
			Bun.sleep = originalSleep;
		}

		// Verify sessions.json was written
		const sessions = loadSessionsFromDb();
		expect(sessions).toHaveLength(1);

		const session = sessions[0];
		expect(session).toBeDefined();
		expect(session?.agentName).toBe("coordinator");
		expect(session?.capability).toBe("coordinator");
		expect(session?.tmuxSession).toBe("overstory-test-project-coordinator");
		expect(session?.state).toBe("booting");
		expect(session?.pid).toBe(99999);
		expect(session?.parentAgent).toBeNull();
		expect(session?.depth).toBe(0);
		expect(session?.beadId).toBe("");
		expect(session?.branchName).toBe("main");
		expect(session?.worktreePath).toBe(tempDir);
		expect(session?.id).toMatch(/^session-\d+-coordinator$/);

		// Verify tmux createSession was called
		expect(calls.createSession).toHaveLength(1);
		expect(calls.createSession[0]?.name).toBe("overstory-test-project-coordinator");
		expect(calls.createSession[0]?.cwd).toBe(tempDir);

		// Verify sendKeys was called (beacon + follow-up Enter)
		expect(calls.sendKeys.length).toBeGreaterThanOrEqual(1);
	});

	test("deploys hooks to project root .claude/settings.local.json", async () => {
		const { deps } = makeDeps();
		const originalSleep = Bun.sleep;
		Bun.sleep = (() => Promise.resolve()) as typeof Bun.sleep;

		try {
			await captureStdout(() => coordinatorCommand(["start", "--no-attach"], deps));
		} finally {
			Bun.sleep = originalSleep;
		}

		// Verify .claude/settings.local.json was created at the project root
		const settingsPath = join(tempDir, ".claude", "settings.local.json");
		const settingsFile = Bun.file(settingsPath);
		expect(await settingsFile.exists()).toBe(true);

		const content = await settingsFile.text();
		const config = JSON.parse(content) as {
			hooks: Record<string, unknown[]>;
		};

		// Verify hook categories exist
		expect(config.hooks).toBeDefined();
		expect(config.hooks.SessionStart).toBeDefined();
		expect(config.hooks.UserPromptSubmit).toBeDefined();
		expect(config.hooks.PreToolUse).toBeDefined();
		expect(config.hooks.PostToolUse).toBeDefined();
		expect(config.hooks.Stop).toBeDefined();
	});

	test("hooks use coordinator agent name for event logging", async () => {
		const { deps } = makeDeps();
		const originalSleep = Bun.sleep;
		Bun.sleep = (() => Promise.resolve()) as typeof Bun.sleep;

		try {
			await captureStdout(() => coordinatorCommand(["start", "--no-attach"], deps));
		} finally {
			Bun.sleep = originalSleep;
		}

		const settingsPath = join(tempDir, ".claude", "settings.local.json");
		const content = await Bun.file(settingsPath).text();

		// The hooks should reference the coordinator agent name
		expect(content).toContain("--agent coordinator");
	});

	test("hooks include ENV_GUARD to avoid affecting user's Claude Code session", async () => {
		const { deps } = makeDeps();
		const originalSleep = Bun.sleep;
		Bun.sleep = (() => Promise.resolve()) as typeof Bun.sleep;

		try {
			await captureStdout(() => coordinatorCommand(["start", "--no-attach"], deps));
		} finally {
			Bun.sleep = originalSleep;
		}

		const settingsPath = join(tempDir, ".claude", "settings.local.json");
		const content = await Bun.file(settingsPath).text();

		// PreToolUse guards should include the ENV_GUARD prefix
		expect(content).toContain("OVERSTORY_AGENT_NAME");
	});

	test("injects agent definition via --append-system-prompt when agent-defs/coordinator.md exists", async () => {
		// Deploy a coordinator agent definition
		const agentDefsDir = join(overstoryDir, "agent-defs");
		await mkdir(agentDefsDir, { recursive: true });
		await Bun.write(
			join(agentDefsDir, "coordinator.md"),
			"# Coordinator Agent\n\nYou are the coordinator.\n",
		);

		const { deps, calls } = makeDeps();
		const originalSleep = Bun.sleep;
		Bun.sleep = (() => Promise.resolve()) as typeof Bun.sleep;

		try {
			await captureStdout(() => coordinatorCommand(["start", "--no-attach", "--json"], deps));
		} finally {
			Bun.sleep = originalSleep;
		}

		expect(calls.createSession).toHaveLength(1);
		const cmd = calls.createSession[0]?.command ?? "";
		expect(cmd).toContain("--append-system-prompt");
		expect(cmd).toContain("# Coordinator Agent");
	});

	test("reads model from manifest instead of hardcoding", async () => {
		// Override the manifest to use sonnet instead of default opus
		const manifest = {
			version: "1.0",
			agents: {
				coordinator: {
					file: "coordinator.md",
					model: "sonnet",
					tools: ["Read", "Bash"],
					capabilities: ["coordinate"],
					canSpawn: true,
					constraints: [],
				},
			},
			capabilityIndex: { coordinate: ["coordinator"] },
		};
		await Bun.write(
			join(overstoryDir, "agent-manifest.json"),
			`${JSON.stringify(manifest, null, "\t")}\n`,
		);

		const { deps, calls } = makeDeps();
		const originalSleep = Bun.sleep;
		Bun.sleep = (() => Promise.resolve()) as typeof Bun.sleep;

		try {
			await captureStdout(() => coordinatorCommand(["start", "--no-attach", "--json"], deps));
		} finally {
			Bun.sleep = originalSleep;
		}

		expect(calls.createSession).toHaveLength(1);
		const cmd = calls.createSession[0]?.command ?? "";
		expect(cmd).toContain("--model sonnet");
		expect(cmd).not.toContain("--model opus");
	});

	test("--json outputs JSON with expected fields", async () => {
		const { deps } = makeDeps();
		const originalSleep = Bun.sleep;
		Bun.sleep = (() => Promise.resolve()) as typeof Bun.sleep;

		let output: string;
		try {
			output = await captureStdout(() => coordinatorCommand(["start", "--json"], deps));
		} finally {
			Bun.sleep = originalSleep;
		}

		const parsed = JSON.parse(output) as Record<string, unknown>;
		expect(parsed.agentName).toBe("coordinator");
		expect(parsed.capability).toBe("coordinator");
		expect(parsed.tmuxSession).toBe("overstory-test-project-coordinator");
		expect(parsed.pid).toBe(99999);
		expect(parsed.projectRoot).toBe(tempDir);
	});

	test("rejects duplicate when coordinator is already running", async () => {
		// Write an existing active coordinator session
		const existing = makeCoordinatorSession({ state: "working" });
		saveSessionsToDb([existing]);

		// Mock tmux as alive for the existing session
		const { deps } = makeDeps({ "overstory-test-project-coordinator": true });

		await expect(coordinatorCommand(["start"], deps)).rejects.toThrow(AgentError);

		try {
			await coordinatorCommand(["start"], deps);
		} catch (err) {
			expect(err).toBeInstanceOf(AgentError);
			const ae = err as AgentError;
			expect(ae.message).toContain("already running");
		}
	});

	test("cleans up dead session and starts new one", async () => {
		// Write an existing session that claims to be working
		const deadSession = makeCoordinatorSession({
			id: "session-dead-coordinator",
			state: "working",
		});
		saveSessionsToDb([deadSession]);

		// Mock tmux as NOT alive for the existing session
		const { deps } = makeDeps({ "overstory-test-project-coordinator": false });

		const originalSleep = Bun.sleep;
		Bun.sleep = (() => Promise.resolve()) as typeof Bun.sleep;

		try {
			await captureStdout(() => coordinatorCommand(["start"], deps));
		} finally {
			Bun.sleep = originalSleep;
		}

		// SessionStore uses UNIQUE(agent_name), so the new session replaces the old one.
		// Verify the new session is in booting state with the coordinator name.
		const sessions = loadSessionsFromDb();
		expect(sessions).toHaveLength(1);

		const newSession = sessions[0];
		expect(newSession).toBeDefined();
		expect(newSession?.state).toBe("booting");
		expect(newSession?.agentName).toBe("coordinator");
		// The new session should have a different ID than the dead one
		expect(newSession?.id).not.toBe("session-dead-coordinator");
	});
});

describe("stopCoordinator", () => {
	test("marks session as completed after stopping", async () => {
		const session = makeCoordinatorSession({ state: "working" });
		saveSessionsToDb([session]);

		// Tmux is alive so killSession will be called
		const { deps, calls } = makeDeps({ "overstory-test-project-coordinator": true });

		await captureStdout(() => coordinatorCommand(["stop"], deps));

		// Verify session is now completed
		const sessions = loadSessionsFromDb();
		expect(sessions).toHaveLength(1);
		expect(sessions[0]?.state).toBe("completed");

		// Verify killSession was called
		expect(calls.killSession).toHaveLength(1);
		expect(calls.killSession[0]?.name).toBe("overstory-test-project-coordinator");
	});

	test("--json outputs JSON with stopped flag", async () => {
		const session = makeCoordinatorSession({ state: "working" });
		saveSessionsToDb([session]);
		const { deps } = makeDeps({ "overstory-test-project-coordinator": true });

		const output = await captureStdout(() => coordinatorCommand(["stop", "--json"], deps));
		const parsed = JSON.parse(output) as Record<string, unknown>;
		expect(parsed.stopped).toBe(true);
		expect(parsed.sessionId).toBe(session.id);
	});

	test("handles already-dead tmux session gracefully", async () => {
		const session = makeCoordinatorSession({ state: "working" });
		saveSessionsToDb([session]);

		// Tmux is NOT alive — should skip killSession
		const { deps, calls } = makeDeps({ "overstory-test-project-coordinator": false });

		await captureStdout(() => coordinatorCommand(["stop"], deps));

		// Verify session is completed
		const sessions = loadSessionsFromDb();
		expect(sessions[0]?.state).toBe("completed");

		// killSession should NOT have been called since session was already dead
		expect(calls.killSession).toHaveLength(0);
	});

	test("throws AgentError when no coordinator session exists", async () => {
		const { deps } = makeDeps();

		// No sessions.json at all
		await expect(coordinatorCommand(["stop"], deps)).rejects.toThrow(AgentError);

		try {
			await coordinatorCommand(["stop"], deps);
		} catch (err) {
			expect(err).toBeInstanceOf(AgentError);
			const ae = err as AgentError;
			expect(ae.message).toContain("No active coordinator session");
		}
	});

	test("throws AgentError when only completed sessions exist", async () => {
		const completed = makeCoordinatorSession({ state: "completed" });
		saveSessionsToDb([completed]);
		const { deps } = makeDeps();

		await expect(coordinatorCommand(["stop"], deps)).rejects.toThrow(AgentError);
	});
});

describe("stopCoordinator run completion", () => {
	test("coordinator stop auto-completes the active run", async () => {
		// Create a coordinator session
		const session = makeCoordinatorSession({ state: "working" });
		saveSessionsToDb([session]);

		// Create a run in RunStore
		const dbPath = join(overstoryDir, "sessions.db");
		const runStore = createRunStore(dbPath);
		runStore.createRun({
			id: "run-test-123",
			startedAt: new Date().toISOString(),
			coordinatorSessionId: null,
			status: "active",
		});
		runStore.close();

		// Write current-run.txt
		await Bun.write(join(overstoryDir, "current-run.txt"), "run-test-123");

		// Stop coordinator
		const { deps } = makeDeps({ "overstory-test-project-coordinator": true });
		await captureStdout(() => coordinatorCommand(["stop"], deps));

		// Verify run status is "completed"
		const runStoreCheck = createRunStore(dbPath);
		const run = runStoreCheck.getRun("run-test-123");
		runStoreCheck.close();
		expect(run?.status).toBe("completed");

		// Verify current-run.txt is deleted
		const currentRunFile = Bun.file(join(overstoryDir, "current-run.txt"));
		expect(await currentRunFile.exists()).toBe(false);
	});

	test("coordinator stop succeeds when no active run exists", async () => {
		// Create a coordinator session
		const session = makeCoordinatorSession({ state: "working" });
		saveSessionsToDb([session]);

		// No current-run.txt

		// Stop coordinator (should succeed without errors)
		const { deps } = makeDeps({ "overstory-test-project-coordinator": true });
		await expect(captureStdout(() => coordinatorCommand(["stop"], deps))).resolves.toBeDefined();

		// Verify session is completed
		const sessions = loadSessionsFromDb();
		expect(sessions[0]?.state).toBe("completed");
	});

	test("coordinator stop succeeds when current-run.txt is empty", async () => {
		// Create a coordinator session
		const session = makeCoordinatorSession({ state: "working" });
		saveSessionsToDb([session]);

		// Write empty current-run.txt
		await Bun.write(join(overstoryDir, "current-run.txt"), "");

		// Stop coordinator (should succeed without errors)
		const { deps } = makeDeps({ "overstory-test-project-coordinator": true });
		await expect(captureStdout(() => coordinatorCommand(["stop"], deps))).resolves.toBeDefined();

		// Verify session is completed
		const sessions = loadSessionsFromDb();
		expect(sessions[0]?.state).toBe("completed");
	});

	test("--json output includes runCompleted field", async () => {
		// Create a coordinator session
		const session = makeCoordinatorSession({ state: "working" });
		saveSessionsToDb([session]);

		// Create a run in RunStore
		const dbPath = join(overstoryDir, "sessions.db");
		const runStore = createRunStore(dbPath);
		runStore.createRun({
			id: "run-test-456",
			startedAt: new Date().toISOString(),
			coordinatorSessionId: null,
			status: "active",
		});
		runStore.close();

		// Write current-run.txt
		await Bun.write(join(overstoryDir, "current-run.txt"), "run-test-456");

		// Stop coordinator with --json
		const { deps } = makeDeps({ "overstory-test-project-coordinator": true });
		const output = await captureStdout(() => coordinatorCommand(["stop", "--json"], deps));

		// Verify output includes runCompleted: true
		const parsed = JSON.parse(output) as Record<string, unknown>;
		expect(parsed.runCompleted).toBe(true);
	});

	test("--json output includes runCompleted:false when no run", async () => {
		// Create a coordinator session
		const session = makeCoordinatorSession({ state: "working" });
		saveSessionsToDb([session]);

		// No current-run.txt

		// Stop coordinator with --json
		const { deps } = makeDeps({ "overstory-test-project-coordinator": true });
		const output = await captureStdout(() => coordinatorCommand(["stop", "--json"], deps));

		// Verify output includes runCompleted: false
		const parsed = JSON.parse(output) as Record<string, unknown>;
		expect(parsed.runCompleted).toBe(false);
	});
});

describe("statusCoordinator", () => {
	test("shows 'not running' when no session exists", async () => {
		const { deps } = makeDeps();
		const output = await captureStdout(() => coordinatorCommand(["status"], deps));
		expect(output).toContain("not running");
	});

	test("--json shows running:false when no session exists", async () => {
		const { deps } = makeDeps();
		const output = await captureStdout(() => coordinatorCommand(["status", "--json"], deps));
		const parsed = JSON.parse(output) as Record<string, unknown>;
		expect(parsed.running).toBe(false);
	});

	test("shows running state when coordinator is alive", async () => {
		const session = makeCoordinatorSession({ state: "working" });
		saveSessionsToDb([session]);
		const { deps } = makeDeps({ "overstory-test-project-coordinator": true });

		const output = await captureStdout(() => coordinatorCommand(["status"], deps));
		expect(output).toContain("running");
		expect(output).toContain(session.id);
		expect(output).toContain("overstory-test-project-coordinator");
	});

	test("--json shows correct fields when running", async () => {
		const session = makeCoordinatorSession({ state: "working", pid: 99999 });
		saveSessionsToDb([session]);
		const { deps } = makeDeps({ "overstory-test-project-coordinator": true });

		const output = await captureStdout(() => coordinatorCommand(["status", "--json"], deps));
		const parsed = JSON.parse(output) as Record<string, unknown>;
		expect(parsed.running).toBe(true);
		expect(parsed.sessionId).toBe(session.id);
		expect(parsed.state).toBe("working");
		expect(parsed.tmuxSession).toBe("overstory-test-project-coordinator");
		expect(parsed.pid).toBe(99999);
	});

	test("reconciles zombie: updates state when tmux is dead but session says working", async () => {
		const session = makeCoordinatorSession({ state: "working" });
		saveSessionsToDb([session]);

		// Tmux is NOT alive — triggers zombie reconciliation
		const { deps } = makeDeps({ "overstory-test-project-coordinator": false });

		const output = await captureStdout(() => coordinatorCommand(["status", "--json"], deps));
		const parsed = JSON.parse(output) as Record<string, unknown>;
		expect(parsed.running).toBe(false);
		expect(parsed.state).toBe("zombie");

		// Verify sessions.json was updated
		const sessions = loadSessionsFromDb();
		expect(sessions[0]?.state).toBe("zombie");
	});

	test("reconciles zombie for booting state too", async () => {
		const session = makeCoordinatorSession({ state: "booting" });
		saveSessionsToDb([session]);
		const { deps } = makeDeps({ "overstory-test-project-coordinator": false });

		const output = await captureStdout(() => coordinatorCommand(["status", "--json"], deps));
		const parsed = JSON.parse(output) as Record<string, unknown>;
		expect(parsed.state).toBe("zombie");
	});

	test("does not show completed sessions as active", async () => {
		const completed = makeCoordinatorSession({ state: "completed" });
		saveSessionsToDb([completed]);
		const { deps } = makeDeps();

		const output = await captureStdout(() => coordinatorCommand(["status", "--json"], deps));
		const parsed = JSON.parse(output) as Record<string, unknown>;
		expect(parsed.running).toBe(false);
	});
});

describe("buildCoordinatorBeacon", () => {
	test("is a single line (no newlines)", () => {
		const beacon = buildCoordinatorBeacon();
		expect(beacon).not.toContain("\n");
	});

	test("includes coordinator identity in header", () => {
		const beacon = buildCoordinatorBeacon();
		expect(beacon).toContain("[OVERSTORY] coordinator (coordinator)");
	});

	test("includes ISO timestamp", () => {
		const beacon = buildCoordinatorBeacon();
		expect(beacon).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
	});

	test("includes depth and parent info", () => {
		const beacon = buildCoordinatorBeacon();
		expect(beacon).toContain("Depth: 0 | Parent: none");
	});

	test("includes persistent orchestrator role", () => {
		const beacon = buildCoordinatorBeacon();
		expect(beacon).toContain("Role: persistent orchestrator");
	});

	test("includes startup instructions", () => {
		const beacon = buildCoordinatorBeacon();
		expect(beacon).toContain("overstory init");
		expect(beacon).toContain("overstory mail check --agent coordinator");
		expect(beacon).toContain("bd ready if available");
		expect(beacon).toContain("overstory group status");
	});

	test("includes hierarchy enforcement instruction", () => {
		const beacon = buildCoordinatorBeacon();
		expect(beacon).toContain("ONLY spawn leads");
		expect(beacon).toContain("NEVER spawn non-lead agents directly");
	});

	test("includes delegation instruction", () => {
		const beacon = buildCoordinatorBeacon();
		expect(beacon).toContain("DELEGATION");
		expect(beacon).toContain("spawn a lead who will spawn scouts");
	});

	test("parts are joined with em-dash separator", () => {
		const beacon = buildCoordinatorBeacon();
		// Should have exactly 4 " — " separators (5 parts)
		const dashes = beacon.split(" — ");
		expect(dashes).toHaveLength(5);
	});
});

describe("resolveAttach", () => {
	test("--attach flag forces attach regardless of TTY", () => {
		expect(resolveAttach(["--attach"], false)).toBe(true);
		expect(resolveAttach(["--attach"], true)).toBe(true);
	});

	test("--no-attach flag forces no attach regardless of TTY", () => {
		expect(resolveAttach(["--no-attach"], false)).toBe(false);
		expect(resolveAttach(["--no-attach"], true)).toBe(false);
	});

	test("--attach takes precedence when both flags are present", () => {
		expect(resolveAttach(["--attach", "--no-attach"], false)).toBe(true);
		expect(resolveAttach(["--attach", "--no-attach"], true)).toBe(true);
	});

	test("defaults to TTY state when no flag is set", () => {
		expect(resolveAttach([], true)).toBe(true);
		expect(resolveAttach([], false)).toBe(false);
	});

	test("works with other flags present", () => {
		expect(resolveAttach(["--json", "--attach"], false)).toBe(true);
		expect(resolveAttach(["--json", "--no-attach"], true)).toBe(false);
		expect(resolveAttach(["--json"], true)).toBe(true);
	});
});

describe("watchdog integration", () => {
	describe("startCoordinator with --watchdog", () => {
		test("calls watchdog.start() when --watchdog flag is present", async () => {
			const { deps, watchdogCalls } = makeDeps({}, { startSuccess: true });
			const originalSleep = Bun.sleep;
			Bun.sleep = (() => Promise.resolve()) as typeof Bun.sleep;

			try {
				await captureStdout(() => coordinatorCommand(["start", "--watchdog", "--json"], deps));
			} finally {
				Bun.sleep = originalSleep;
			}

			expect(watchdogCalls?.start).toBe(1);
		});

		test("does NOT call watchdog.start() when --watchdog flag is absent", async () => {
			const { deps, watchdogCalls } = makeDeps({}, { startSuccess: true });
			const originalSleep = Bun.sleep;
			Bun.sleep = (() => Promise.resolve()) as typeof Bun.sleep;

			try {
				await captureStdout(() => coordinatorCommand(["start", "--json"], deps));
			} finally {
				Bun.sleep = originalSleep;
			}

			expect(watchdogCalls?.start).toBe(0);
		});

		test("--json output includes watchdog field when --watchdog is present and succeeds", async () => {
			const { deps } = makeDeps({}, { startSuccess: true });
			const originalSleep = Bun.sleep;
			Bun.sleep = (() => Promise.resolve()) as typeof Bun.sleep;

			let output: string;
			try {
				output = await captureStdout(() =>
					coordinatorCommand(["start", "--watchdog", "--json"], deps),
				);
			} finally {
				Bun.sleep = originalSleep;
			}

			const parsed = JSON.parse(output) as Record<string, unknown>;
			expect(parsed.watchdog).toBe(true);
		});

		test("--json output includes watchdog:false when --watchdog is present but start fails", async () => {
			const { deps } = makeDeps({}, { startSuccess: false });
			const originalSleep = Bun.sleep;
			Bun.sleep = (() => Promise.resolve()) as typeof Bun.sleep;

			let output: string;
			try {
				output = await captureStdout(() =>
					coordinatorCommand(["start", "--watchdog", "--json"], deps),
				);
			} finally {
				Bun.sleep = originalSleep;
			}

			const parsed = JSON.parse(output) as Record<string, unknown>;
			expect(parsed.watchdog).toBe(false);
		});

		test("--json output includes watchdog:false when --watchdog is absent", async () => {
			const { deps } = makeDeps({}, { startSuccess: true });
			const originalSleep = Bun.sleep;
			Bun.sleep = (() => Promise.resolve()) as typeof Bun.sleep;

			let output: string;
			try {
				output = await captureStdout(() => coordinatorCommand(["start", "--json"], deps));
			} finally {
				Bun.sleep = originalSleep;
			}

			const parsed = JSON.parse(output) as Record<string, unknown>;
			expect(parsed.watchdog).toBe(false);
		});

		test("text output includes watchdog PID when --watchdog succeeds", async () => {
			const { deps } = makeDeps({}, { startSuccess: true });
			const originalSleep = Bun.sleep;
			Bun.sleep = (() => Promise.resolve()) as typeof Bun.sleep;

			let output: string;
			try {
				output = await captureStdout(() =>
					coordinatorCommand(["start", "--watchdog", "--no-attach"], deps),
				);
			} finally {
				Bun.sleep = originalSleep;
			}

			expect(output).toContain("Watchdog: started (PID 88888)");
		});
	});

	describe("stopCoordinator watchdog cleanup", () => {
		test("always calls watchdog.stop() when stopping coordinator", async () => {
			const session = makeCoordinatorSession({ state: "working" });
			saveSessionsToDb([session]);
			const { deps, watchdogCalls } = makeDeps(
				{ "overstory-test-project-coordinator": true },
				{ stopSuccess: true },
			);

			await captureStdout(() => coordinatorCommand(["stop"], deps));

			expect(watchdogCalls?.stop).toBe(1);
		});

		test("--json output includes watchdogStopped:true when watchdog was running", async () => {
			const session = makeCoordinatorSession({ state: "working" });
			saveSessionsToDb([session]);
			const { deps } = makeDeps(
				{ "overstory-test-project-coordinator": true },
				{ stopSuccess: true },
			);

			const output = await captureStdout(() => coordinatorCommand(["stop", "--json"], deps));
			const parsed = JSON.parse(output) as Record<string, unknown>;
			expect(parsed.watchdogStopped).toBe(true);
		});

		test("--json output includes watchdogStopped:false when no watchdog was running", async () => {
			const session = makeCoordinatorSession({ state: "working" });
			saveSessionsToDb([session]);
			const { deps } = makeDeps(
				{ "overstory-test-project-coordinator": true },
				{ stopSuccess: false },
			);

			const output = await captureStdout(() => coordinatorCommand(["stop", "--json"], deps));
			const parsed = JSON.parse(output) as Record<string, unknown>;
			expect(parsed.watchdogStopped).toBe(false);
		});

		test("text output shows 'Watchdog stopped' when watchdog was running", async () => {
			const session = makeCoordinatorSession({ state: "working" });
			saveSessionsToDb([session]);
			const { deps } = makeDeps(
				{ "overstory-test-project-coordinator": true },
				{ stopSuccess: true },
			);

			const output = await captureStdout(() => coordinatorCommand(["stop"], deps));
			expect(output).toContain("Watchdog stopped");
		});

		test("text output shows 'No watchdog running' when no watchdog was running", async () => {
			const session = makeCoordinatorSession({ state: "working" });
			saveSessionsToDb([session]);
			const { deps } = makeDeps(
				{ "overstory-test-project-coordinator": true },
				{ stopSuccess: false },
			);

			const output = await captureStdout(() => coordinatorCommand(["stop"], deps));
			expect(output).toContain("No watchdog running");
		});
	});

	describe("statusCoordinator watchdog state", () => {
		test("includes watchdogRunning in JSON output when coordinator is running", async () => {
			const session = makeCoordinatorSession({ state: "working" });
			saveSessionsToDb([session]);
			const { deps } = makeDeps({ "overstory-test-project-coordinator": true }, { running: true });

			const output = await captureStdout(() => coordinatorCommand(["status", "--json"], deps));
			const parsed = JSON.parse(output) as Record<string, unknown>;
			expect(parsed.watchdogRunning).toBe(true);
		});

		test("includes watchdogRunning:false in JSON output when watchdog is not running", async () => {
			const session = makeCoordinatorSession({ state: "working" });
			saveSessionsToDb([session]);
			const { deps } = makeDeps({ "overstory-test-project-coordinator": true }, { running: false });

			const output = await captureStdout(() => coordinatorCommand(["status", "--json"], deps));
			const parsed = JSON.parse(output) as Record<string, unknown>;
			expect(parsed.watchdogRunning).toBe(false);
		});

		test("text output shows watchdog status when coordinator is running", async () => {
			const session = makeCoordinatorSession({ state: "working" });
			saveSessionsToDb([session]);
			const { deps } = makeDeps({ "overstory-test-project-coordinator": true }, { running: true });

			const output = await captureStdout(() => coordinatorCommand(["status"], deps));
			expect(output).toContain("Watchdog:  running");
		});

		test("text output shows 'not running' when watchdog is not running", async () => {
			const session = makeCoordinatorSession({ state: "working" });
			saveSessionsToDb([session]);
			const { deps } = makeDeps({ "overstory-test-project-coordinator": true }, { running: false });

			const output = await captureStdout(() => coordinatorCommand(["status"], deps));
			expect(output).toContain("Watchdog:  not running");
		});

		test("includes watchdogRunning in JSON output when coordinator is not running", async () => {
			const { deps } = makeDeps({}, { running: true });

			const output = await captureStdout(() => coordinatorCommand(["status", "--json"], deps));
			const parsed = JSON.parse(output) as Record<string, unknown>;
			expect(parsed.running).toBe(false);
			expect(parsed.watchdogRunning).toBe(true);
		});
	});

	describe("COORDINATOR_HELP", () => {
		test("help text includes --watchdog flag", async () => {
			const output = await captureStdout(() => coordinatorCommand(["--help"]));
			expect(output).toContain("--watchdog");
			expect(output).toContain("Auto-start watchdog daemon with coordinator");
		});
	});
});

describe("monitor integration", () => {
	describe("startCoordinator with --monitor", () => {
		test("calls monitor.start() when --monitor flag is present", async () => {
			const { deps, monitorCalls } = makeDeps({}, undefined, { startSuccess: true });
			const originalSleep = Bun.sleep;
			Bun.sleep = (() => Promise.resolve()) as typeof Bun.sleep;

			try {
				await captureStdout(() => coordinatorCommand(["start", "--monitor", "--json"], deps));
			} finally {
				Bun.sleep = originalSleep;
			}

			expect(monitorCalls?.start).toBe(1);
		});

		test("does NOT call monitor.start() when --monitor flag is absent", async () => {
			const { deps, monitorCalls } = makeDeps({}, undefined, { startSuccess: true });
			const originalSleep = Bun.sleep;
			Bun.sleep = (() => Promise.resolve()) as typeof Bun.sleep;

			try {
				await captureStdout(() => coordinatorCommand(["start", "--json"], deps));
			} finally {
				Bun.sleep = originalSleep;
			}

			expect(monitorCalls?.start).toBe(0);
		});

		test("--json output includes monitor field when --monitor is present and succeeds", async () => {
			const { deps } = makeDeps({}, undefined, { startSuccess: true });
			const originalSleep = Bun.sleep;
			Bun.sleep = (() => Promise.resolve()) as typeof Bun.sleep;

			let output: string;
			try {
				output = await captureStdout(() =>
					coordinatorCommand(["start", "--monitor", "--json"], deps),
				);
			} finally {
				Bun.sleep = originalSleep;
			}

			const parsed = JSON.parse(output) as Record<string, unknown>;
			expect(parsed.monitor).toBe(true);
		});

		test("--json output includes monitor:false when --monitor is present but start fails", async () => {
			const { deps } = makeDeps({}, undefined, { startSuccess: false });
			const originalSleep = Bun.sleep;
			Bun.sleep = (() => Promise.resolve()) as typeof Bun.sleep;

			let output: string;
			try {
				output = await captureStdout(() =>
					coordinatorCommand(["start", "--monitor", "--json"], deps),
				);
			} finally {
				Bun.sleep = originalSleep;
			}

			const parsed = JSON.parse(output) as Record<string, unknown>;
			expect(parsed.monitor).toBe(false);
		});

		test("--json output includes monitor:false when --monitor is absent", async () => {
			const { deps } = makeDeps({}, undefined, { startSuccess: true });
			const originalSleep = Bun.sleep;
			Bun.sleep = (() => Promise.resolve()) as typeof Bun.sleep;

			let output: string;
			try {
				output = await captureStdout(() => coordinatorCommand(["start", "--json"], deps));
			} finally {
				Bun.sleep = originalSleep;
			}

			const parsed = JSON.parse(output) as Record<string, unknown>;
			expect(parsed.monitor).toBe(false);
		});

		test("text output includes monitor PID when --monitor succeeds", async () => {
			const { deps } = makeDeps({}, undefined, { startSuccess: true });
			const originalSleep = Bun.sleep;
			Bun.sleep = (() => Promise.resolve()) as typeof Bun.sleep;

			let output: string;
			try {
				output = await captureStdout(() =>
					coordinatorCommand(["start", "--monitor", "--no-attach"], deps),
				);
			} finally {
				Bun.sleep = originalSleep;
			}

			expect(output).toContain("Monitor:  started (PID 77777)");
		});

		test("does NOT call monitor.start() when tier2Enabled is false", async () => {
			// Override config with tier2Enabled: false
			await Bun.write(
				join(overstoryDir, "config.yaml"),
				[
					"project:",
					"  name: test-project",
					`  root: ${tempDir}`,
					"  canonicalBranch: main",
					"watchdog:",
					"  tier2Enabled: false",
				].join("\n"),
			);
			const { deps, monitorCalls } = makeDeps({}, undefined, { startSuccess: true });
			const originalSleep = Bun.sleep;
			Bun.sleep = (() => Promise.resolve()) as typeof Bun.sleep;

			try {
				await captureStdout(() => coordinatorCommand(["start", "--monitor", "--json"], deps));
			} finally {
				Bun.sleep = originalSleep;
			}

			expect(monitorCalls?.start).toBe(0);
		});

		test("text output shows skipped message when tier2Enabled is false", async () => {
			// Override config with tier2Enabled: false
			await Bun.write(
				join(overstoryDir, "config.yaml"),
				[
					"project:",
					"  name: test-project",
					`  root: ${tempDir}`,
					"  canonicalBranch: main",
					"watchdog:",
					"  tier2Enabled: false",
				].join("\n"),
			);
			const { deps } = makeDeps({}, undefined, { startSuccess: true });
			const originalSleep = Bun.sleep;
			Bun.sleep = (() => Promise.resolve()) as typeof Bun.sleep;

			let stderrOutput = "";
			const origStderrWrite = process.stderr.write.bind(process.stderr);
			process.stderr.write = (chunk: string | Uint8Array) => {
				stderrOutput += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
				return true;
			};

			try {
				await captureStdout(() => coordinatorCommand(["start", "--monitor", "--no-attach"], deps));
			} finally {
				Bun.sleep = originalSleep;
				process.stderr.write = origStderrWrite;
			}

			expect(stderrOutput).toContain("skipped");
		});
	});

	describe("stopCoordinator monitor cleanup", () => {
		test("always calls monitor.stop() when stopping coordinator", async () => {
			const session = makeCoordinatorSession({ state: "working" });
			saveSessionsToDb([session]);
			const { deps, monitorCalls } = makeDeps(
				{ "overstory-test-project-coordinator": true },
				undefined,
				{ stopSuccess: true },
			);

			await captureStdout(() => coordinatorCommand(["stop"], deps));

			expect(monitorCalls?.stop).toBe(1);
		});

		test("--json output includes monitorStopped:true when monitor was running", async () => {
			const session = makeCoordinatorSession({ state: "working" });
			saveSessionsToDb([session]);
			const { deps } = makeDeps({ "overstory-test-project-coordinator": true }, undefined, {
				stopSuccess: true,
			});

			const output = await captureStdout(() => coordinatorCommand(["stop", "--json"], deps));
			const parsed = JSON.parse(output) as Record<string, unknown>;
			expect(parsed.monitorStopped).toBe(true);
		});

		test("--json output includes monitorStopped:false when no monitor was running", async () => {
			const session = makeCoordinatorSession({ state: "working" });
			saveSessionsToDb([session]);
			const { deps } = makeDeps({ "overstory-test-project-coordinator": true }, undefined, {
				stopSuccess: false,
			});

			const output = await captureStdout(() => coordinatorCommand(["stop", "--json"], deps));
			const parsed = JSON.parse(output) as Record<string, unknown>;
			expect(parsed.monitorStopped).toBe(false);
		});

		test("text output shows 'Monitor stopped' when monitor was running", async () => {
			const session = makeCoordinatorSession({ state: "working" });
			saveSessionsToDb([session]);
			const { deps } = makeDeps({ "overstory-test-project-coordinator": true }, undefined, {
				stopSuccess: true,
			});

			const output = await captureStdout(() => coordinatorCommand(["stop"], deps));
			expect(output).toContain("Monitor stopped");
		});

		test("text output shows 'No monitor running' when no monitor was running", async () => {
			const session = makeCoordinatorSession({ state: "working" });
			saveSessionsToDb([session]);
			const { deps } = makeDeps({ "overstory-test-project-coordinator": true }, undefined, {
				stopSuccess: false,
			});

			const output = await captureStdout(() => coordinatorCommand(["stop"], deps));
			expect(output).toContain("No monitor running");
		});
	});

	describe("statusCoordinator monitor state", () => {
		test("includes monitorRunning in JSON output when coordinator is running", async () => {
			const session = makeCoordinatorSession({ state: "working" });
			saveSessionsToDb([session]);
			const { deps } = makeDeps({ "overstory-test-project-coordinator": true }, undefined, {
				running: true,
			});

			const output = await captureStdout(() => coordinatorCommand(["status", "--json"], deps));
			const parsed = JSON.parse(output) as Record<string, unknown>;
			expect(parsed.monitorRunning).toBe(true);
		});

		test("includes monitorRunning:false in JSON output when monitor is not running", async () => {
			const session = makeCoordinatorSession({ state: "working" });
			saveSessionsToDb([session]);
			const { deps } = makeDeps({ "overstory-test-project-coordinator": true }, undefined, {
				running: false,
			});

			const output = await captureStdout(() => coordinatorCommand(["status", "--json"], deps));
			const parsed = JSON.parse(output) as Record<string, unknown>;
			expect(parsed.monitorRunning).toBe(false);
		});

		test("text output shows monitor status when coordinator is running", async () => {
			const session = makeCoordinatorSession({ state: "working" });
			saveSessionsToDb([session]);
			const { deps } = makeDeps({ "overstory-test-project-coordinator": true }, undefined, {
				running: true,
			});

			const output = await captureStdout(() => coordinatorCommand(["status"], deps));
			expect(output).toContain("Monitor:   running");
		});

		test("text output shows 'not running' when monitor is not running", async () => {
			const session = makeCoordinatorSession({ state: "working" });
			saveSessionsToDb([session]);
			const { deps } = makeDeps({ "overstory-test-project-coordinator": true }, undefined, {
				running: false,
			});

			const output = await captureStdout(() => coordinatorCommand(["status"], deps));
			expect(output).toContain("Monitor:   not running");
		});

		test("includes monitorRunning in JSON output when coordinator is not running", async () => {
			const { deps } = makeDeps({}, undefined, { running: true });

			const output = await captureStdout(() => coordinatorCommand(["status", "--json"], deps));
			const parsed = JSON.parse(output) as Record<string, unknown>;
			expect(parsed.running).toBe(false);
			expect(parsed.monitorRunning).toBe(true);
		});
	});

	describe("COORDINATOR_HELP", () => {
		test("help text includes --monitor flag", async () => {
			const output = await captureStdout(() => coordinatorCommand(["--help"]));
			expect(output).toContain("--monitor");
			expect(output).toContain("Auto-start monitor agent (Tier 2) with coordinator");
		});
	});
});

describe("SessionStore round-trip", () => {
	test("returns empty array when no sessions exist", () => {
		const sessions = loadSessionsFromDb();
		expect(sessions).toEqual([]);
	});

	test("save then load round-trips correctly", () => {
		const original = [makeCoordinatorSession()];
		saveSessionsToDb(original);
		const loaded = loadSessionsFromDb();

		expect(loaded).toHaveLength(1);
		expect(loaded[0]?.agentName).toBe("coordinator");
		expect(loaded[0]?.capability).toBe("coordinator");
	});

	test("sessions.db is created after save", () => {
		saveSessionsToDb([makeCoordinatorSession()]);
		const dbPath = join(overstoryDir, "sessions.db");
		const exists = Bun.file(dbPath).size > 0;
		expect(exists).toBe(true);
	});
});

describe("isRunningAsRoot (imported from sling)", () => {
	test("is accessible from coordinator test file", () => {
		expect(isRunningAsRoot(() => 0)).toBe(true);
		expect(isRunningAsRoot(() => 1000)).toBe(false);
	});
});

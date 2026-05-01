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
import { createMailStore } from "../mail/store.ts";
import { openSessionStore } from "../sessions/compat.ts";
import { createRunStore, createSessionStore } from "../sessions/store.ts";
import { cleanupTempDir, createTempGitRepo } from "../test-helpers.ts";
import type { AgentSession } from "../types.ts";
import {
	askCoordinator,
	buildCoordinatorBeacon,
	type CoordinatorDeps,
	checkComplete,
	coordinatorCommand,
	createCoordinatorCommand,
	resolveAttach,
	startCoordinatorSession,
} from "./coordinator.ts";
import {
	buildOrchestratorBeacon,
	createOrchestratorCommand,
	orchestratorCommand,
} from "./orchestrator.ts";

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
	checkSessionState: Array<{ name: string; result: "alive" | "dead" | "no_server" }>;
	killSession: Array<{ name: string }>;
	sendKeys: Array<{ name: string; keys: string }>;
	waitForTuiReady: Array<{ name: string }>;
	ensureTmuxAvailable: number;
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
function makeFakeTmux(
	sessionAliveMap: Record<string, boolean> = {},
	options: {
		waitForTuiReadyResult?: boolean;
		ensureTmuxAvailableError?: Error;
		checkSessionStateMap?: Record<string, "alive" | "dead" | "no_server">;
	} = {},
): {
	tmux: NonNullable<CoordinatorDeps["_tmux"]>;
	calls: TmuxCallTracker;
} {
	const calls: TmuxCallTracker = {
		createSession: [],
		isSessionAlive: [],
		checkSessionState: [],
		killSession: [],
		sendKeys: [],
		waitForTuiReady: [],
		ensureTmuxAvailable: 0,
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
		checkSessionState: async (name: string): Promise<"alive" | "dead" | "no_server"> => {
			const stateMap = options.checkSessionStateMap ?? {};
			// Default: derive from sessionAliveMap for backwards compat
			const state = stateMap[name] ?? (sessionAliveMap[name] ? "alive" : "dead");
			calls.checkSessionState.push({ name, result: state });
			return state;
		},
		killSession: async (name: string): Promise<void> => {
			calls.killSession.push({ name });
		},
		sendKeys: async (name: string, keys: string): Promise<void> => {
			calls.sendKeys.push({ name, keys });
		},
		waitForTuiReady: async (name: string): Promise<boolean> => {
			calls.waitForTuiReady.push({ name });
			return options.waitForTuiReadyResult ?? true;
		},
		ensureTmuxAvailable: async (): Promise<void> => {
			calls.ensureTmuxAvailable++;
			if (options.ensureTmuxAvailableError) {
				throw options.ensureTmuxAvailableError;
			}
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
			orchestrator: {
				file: "orchestrator.md",
				model: "opus",
				tools: ["Read", "Bash"],
				capabilities: ["orchestrate", "coordinate"],
				canSpawn: true,
				constraints: [],
			},
		},
		capabilityIndex: {
			coordinate: ["coordinator", "orchestrator"],
			orchestrate: ["orchestrator"],
		},
	};
	await Bun.write(
		join(overstoryDir, "agent-manifest.json"),
		`${JSON.stringify(manifest, null, "\t")}\n`,
	);
	await Bun.write(join(agentDefsDir, "coordinator.md"), "# Coordinator\n");
	await Bun.write(join(agentDefsDir, "orchestrator.md"), "# Orchestrator\n");

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
		taskId: "",
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
		transcriptPath: null,
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
	tmuxOptions?: {
		waitForTuiReadyResult?: boolean;
		ensureTmuxAvailableError?: Error;
		checkSessionStateMap?: Record<string, "alive" | "dead" | "no_server">;
	},
): {
	deps: CoordinatorDeps;
	calls: TmuxCallTracker;
	watchdogCalls: WatchdogCallTracker;
	monitorCalls: MonitorCallTracker;
} {
	const { tmux, calls } = makeFakeTmux(sessionAliveMap, tmuxOptions);
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
		expect(output).toContain("coordinator");
		expect(output).toContain("start");
		expect(output).toContain("stop");
		expect(output).toContain("status");
	});

	test("start --help includes --attach and --no-attach flags", async () => {
		const cmd = createCoordinatorCommand({});
		for (const sub of cmd.commands) {
			sub.exitOverride();
		}
		const output = await captureStdout(async () => {
			await cmd.parseAsync(["start", "--help"], { from: "user" }).catch(() => {});
		});
		expect(output).toContain("--attach");
		expect(output).toContain("--no-attach");
	});

	test("-h outputs help text", async () => {
		const output = await captureStdout(() => coordinatorCommand(["-h"]));
		expect(output).toContain("coordinator");
	});

	test("empty args outputs help text", async () => {
		const output = await captureStdout(() => coordinatorCommand([]));
		expect(output).toContain("coordinator");
		expect(output).toContain("Commands:");
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
		expect(session?.taskId).toBe("");
		expect(session?.branchName).toBe("main");
		expect(session?.worktreePath).toBe(tempDir);
		expect(session?.id).toMatch(/^session-\d+-coordinator$/);

		// Verify the session has a runId set (not null)
		expect(session?.runId).not.toBeNull();
		expect(session?.runId).toMatch(/^run-/);

		// Verify tmux createSession was called
		expect(calls.createSession).toHaveLength(1);
		expect(calls.createSession[0]?.name).toBe("overstory-test-project-coordinator");
		expect(calls.createSession[0]?.cwd).toBe(tempDir);

		// Verify sendKeys was called (beacon + follow-up Enter)
		expect(calls.sendKeys.length).toBeGreaterThanOrEqual(1);
	});

	test("creates a run record with coordinatorName set", async () => {
		const { deps } = makeDeps();
		const originalSleep = Bun.sleep;
		Bun.sleep = (() => Promise.resolve()) as typeof Bun.sleep;

		try {
			await captureStdout(() => coordinatorCommand(["start", "--no-attach"], deps));
		} finally {
			Bun.sleep = originalSleep;
		}

		const runStore = createRunStore(join(overstoryDir, "sessions.db"));
		try {
			const run = runStore.getActiveRunForCoordinator("coordinator");
			expect(run).not.toBeNull();
			expect(run?.coordinatorName).toBe("coordinator");
			expect(run?.status).toBe("active");
			expect(run?.coordinatorSessionId).toMatch(/^session-\d+-coordinator$/);
		} finally {
			runStore.close();
		}
	});

	test("writes current-run.txt for backward compatibility", async () => {
		const { deps } = makeDeps();
		const originalSleep = Bun.sleep;
		Bun.sleep = (() => Promise.resolve()) as typeof Bun.sleep;

		try {
			await captureStdout(() => coordinatorCommand(["start", "--no-attach"], deps));
		} finally {
			Bun.sleep = originalSleep;
		}

		const currentRunFile = Bun.file(join(overstoryDir, "current-run.txt"));
		expect(await currentRunFile.exists()).toBe(true);
		const runId = (await currentRunFile.text()).trim();
		expect(runId).toMatch(/^run-/);
	});

	test("run ID in current-run.txt matches session runId", async () => {
		const { deps } = makeDeps();
		const originalSleep = Bun.sleep;
		Bun.sleep = (() => Promise.resolve()) as typeof Bun.sleep;

		try {
			await captureStdout(() => coordinatorCommand(["start", "--no-attach"], deps));
		} finally {
			Bun.sleep = originalSleep;
		}

		const sessions = loadSessionsFromDb();
		const session = sessions[0];
		expect(session?.runId).toBeDefined();

		const currentRunFile = Bun.file(join(overstoryDir, "current-run.txt"));
		const fileRunId = (await currentRunFile.text()).trim();

		expect(session?.runId).toBe(fileRunId);
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
		// File path is passed via $(cat ...) instead of inlining content (overstory#45)
		expect(cmd).toContain("$(cat '");
		expect(cmd).toContain("agent-defs/coordinator.md");
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
		expect(parsed.success).toBe(true);
		expect(parsed.command).toBe("coordinator start");
		expect(parsed.agentName).toBe("coordinator");
		expect(parsed.capability).toBe("coordinator");
		expect(parsed.tmuxSession).toBe("overstory-test-project-coordinator");
		expect(parsed.pid).toBe(99999);
		expect(parsed.projectRoot).toBe(tempDir);
	});

	test("rejects duplicate when coordinator is already running", async () => {
		// Write an existing active coordinator session
		const existing = makeCoordinatorSession({ state: "working", pid: process.pid });
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

	test("rejects duplicate when pid is null but tmux session is alive", async () => {
		// Session has null pid (e.g. migrated from older schema) but tmux is alive.
		// Cannot prove it's a zombie without a pid, so treat as active.
		const existing = makeCoordinatorSession({ state: "working", pid: null });
		saveSessionsToDb([existing]);

		const { deps } = makeDeps(
			{ "overstory-test-project-coordinator": true },
			undefined,
			undefined,
			{ checkSessionStateMap: { "overstory-test-project-coordinator": "alive" } },
		);

		try {
			await coordinatorCommand(["start"], deps);
			expect(true).toBe(false); // Should have thrown
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

	test("cleans up zombie session when tmux alive but PID dead", async () => {
		// Session is "working" in DB, tmux session exists, but the PID is dead
		const zombieSession = makeCoordinatorSession({
			id: "session-zombie-coordinator",
			state: "working",
			pid: 999999, // Non-existent PID
		});
		saveSessionsToDb([zombieSession]);

		// Tmux session is alive (pane exists) but PID 999999 is not running
		const { deps } = makeDeps(
			{ "overstory-test-project-coordinator": true },
			undefined,
			undefined,
			{ checkSessionStateMap: { "overstory-test-project-coordinator": "alive" } },
		);

		const originalSleep = Bun.sleep;
		Bun.sleep = (() => Promise.resolve()) as typeof Bun.sleep;

		try {
			await captureStdout(() => coordinatorCommand(["start"], deps));
		} finally {
			Bun.sleep = originalSleep;
		}

		// Zombie session should be cleaned up and new one created
		const sessions = loadSessionsFromDb();
		expect(sessions).toHaveLength(1);
		const newSession = sessions[0];
		expect(newSession?.state).toBe("booting");
		expect(newSession?.id).not.toBe("session-zombie-coordinator");
	});

	test("cleans up stale session when tmux server is not running", async () => {
		// Session is "booting" in DB but tmux server crashed
		const staleSession = makeCoordinatorSession({
			id: "session-stale-coordinator",
			state: "booting",
		});
		saveSessionsToDb([staleSession]);

		// checkSessionState returns no_server
		const { deps } = makeDeps(
			{ "overstory-test-project-coordinator": false },
			undefined,
			undefined,
			{ checkSessionStateMap: { "overstory-test-project-coordinator": "no_server" } },
		);

		const originalSleep = Bun.sleep;
		Bun.sleep = (() => Promise.resolve()) as typeof Bun.sleep;

		try {
			await captureStdout(() => coordinatorCommand(["start"], deps));
		} finally {
			Bun.sleep = originalSleep;
		}

		// Stale session cleaned up, new one created
		const sessions = loadSessionsFromDb();
		expect(sessions).toHaveLength(1);
		const newSession = sessions[0];
		expect(newSession?.state).toBe("booting");
		expect(newSession?.id).not.toBe("session-stale-coordinator");
	});

	test("respects shellInitDelayMs config before polling TUI readiness", async () => {
		// Append shellInitDelayMs to existing config (preserve tier2Enabled etc.)
		const configPath = join(tempDir, ".overstory", "config.yaml");
		const existing = await Bun.file(configPath).text();
		await Bun.write(configPath, `${existing}\nruntime:\n  shellInitDelayMs: 500\n`);

		const { deps } = makeDeps();

		const sleepCalls: number[] = [];
		const originalSleep = Bun.sleep;
		Bun.sleep = ((ms: number | Date) => {
			if (typeof ms === "number") sleepCalls.push(ms);
			return Promise.resolve();
		}) as typeof Bun.sleep;

		try {
			await captureStdout(() => coordinatorCommand(["start"], deps));
		} finally {
			Bun.sleep = originalSleep;
		}

		// The 500ms shell init delay should appear in the sleep calls
		expect(sleepCalls).toContain(500);
	});

	test("throws AgentError when tmux is not available", async () => {
		const { deps } = makeDeps({}, undefined, undefined, {
			ensureTmuxAvailableError: new AgentError(
				"tmux is not installed or not on PATH. Install tmux to use overstory agent orchestration.",
			),
		});

		await expect(coordinatorCommand(["start"], deps)).rejects.toThrow(AgentError);
	});

	test("AgentError message mentions tmux not installed when tmux unavailable", async () => {
		const { deps } = makeDeps({}, undefined, undefined, {
			ensureTmuxAvailableError: new AgentError(
				"tmux is not installed or not on PATH. Install tmux to use overstory agent orchestration.",
			),
		});

		try {
			await coordinatorCommand(["start"], deps);
			expect(true).toBe(false); // Should have thrown
		} catch (err: unknown) {
			expect(err).toBeInstanceOf(AgentError);
			const agentErr = err as AgentError;
			expect(agentErr.message).toContain("tmux is not installed");
		}
	});

	test("throws AgentError when session dies during startup", async () => {
		// waitForTuiReady returns false AND isSessionAlive returns false — session died
		const { deps } = makeDeps(
			{ "overstory-test-project-coordinator": false },
			undefined,
			undefined,
			{ waitForTuiReadyResult: false },
		);

		await expect(coordinatorCommand(["start"], deps)).rejects.toThrow(AgentError);
	});

	test("AgentError message mentions session dying when session dies during startup", async () => {
		const { deps } = makeDeps(
			{ "overstory-test-project-coordinator": false },
			undefined,
			undefined,
			{ waitForTuiReadyResult: false },
		);

		try {
			await coordinatorCommand(["start"], deps);
			expect(true).toBe(false); // Should have thrown
		} catch (err: unknown) {
			expect(err).toBeInstanceOf(AgentError);
			const agentErr = err as AgentError;
			expect(agentErr.message).toContain("died during startup");
		}
	});

	test("kills the coordinator and throws when waitForTuiReady times out but session is still alive", async () => {
		// waitForTuiReady returns false (timeout) and the session is still alive,
		// so startup should fail explicitly instead of sending the beacon blindly.
		const { deps, calls } = makeDeps(
			{ "overstory-test-project-coordinator": true },
			undefined,
			undefined,
			{ waitForTuiReadyResult: false },
		);

		const originalSleep = Bun.sleep;
		Bun.sleep = (() => Promise.resolve()) as typeof Bun.sleep;

		let thrownError: unknown;
		try {
			await captureStdout(() => coordinatorCommand(["start"], deps));
		} catch (err: unknown) {
			thrownError = err;
		} finally {
			Bun.sleep = originalSleep;
		}

		expect(thrownError).toBeInstanceOf(AgentError);
		const agentErr = thrownError as AgentError;
		expect(agentErr.message).toContain("did not become ready during startup");
		expect(calls.killSession).toHaveLength(1);
		expect(calls.killSession[0]?.name).toBe("overstory-test-project-coordinator");
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
		expect(parsed.success).toBe(true);
		expect(parsed.command).toBe("coordinator stop");
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
		expect(parsed.success).toBe(true);
		expect(parsed.command).toBe("coordinator status");
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
		expect(parsed.success).toBe(true);
		expect(parsed.command).toBe("coordinator status");
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
		expect(beacon).toContain("mulch prime");
		expect(beacon).toContain("ov mail check --agent coordinator");
		expect(beacon).toContain("bd ready");
		expect(beacon).toContain("ov group status");
	});

	test("defaults to bd ready when no cliName provided", () => {
		const beacon = buildCoordinatorBeacon();
		expect(beacon).toContain("bd ready");
	});

	test("uses sd ready when cliName is sd", () => {
		const beacon = buildCoordinatorBeacon("sd");
		expect(beacon).toContain("sd ready");
		expect(beacon).not.toContain("bd ready");
	});

	test("includes hierarchy enforcement instruction", () => {
		const beacon = buildCoordinatorBeacon();
		expect(beacon).toContain("Default to leads");
		expect(beacon).toContain("spawn scout/builder directly");
		expect(beacon).toContain("NEVER spawn reviewer or merger directly");
	});

	test("includes delegation instruction", () => {
		const beacon = buildCoordinatorBeacon();
		expect(beacon).toContain("DELEGATION");
		expect(beacon).toContain("spawn a lead who will handle scouts/builders/reviewers");
		expect(beacon).toContain("--dispatch-max-agents 1/2");
	});

	test("parts are joined with em-dash separator", () => {
		const beacon = buildCoordinatorBeacon();
		// Should have exactly 4 " — " separators (5 parts)
		const dashes = beacon.split(" — ");
		expect(dashes).toHaveLength(5);
	});
});

describe("orchestratorCommand", () => {
	test("help shows orchestrator command name", async () => {
		const output = await captureStdout(() => orchestratorCommand(["--help"]));
		expect(output).toContain("orchestrator");
	});

	test("start creates orchestrator session with orchestrator capability", async () => {
		const { deps, calls } = makeDeps({ "overstory-test-project-orchestrator": true });
		const originalSleep = Bun.sleep;
		Bun.sleep = (() => Promise.resolve()) as typeof Bun.sleep;

		try {
			const output = await captureStdout(() =>
				orchestratorCommand(["start", "--no-attach", "--json"], deps),
			);
			const parsed = JSON.parse(output) as Record<string, unknown>;

			expect(parsed.agentName).toBe("orchestrator");
			expect(parsed.capability).toBe("orchestrator");
			expect(parsed.tmuxSession).toBe("overstory-test-project-orchestrator");
			expect(calls.createSession[0]?.name).toBe("overstory-test-project-orchestrator");
			expect(calls.createSession[0]?.command).toContain("orchestrator.md");

			const session = loadSessionsFromDb().find((entry) => entry.agentName === "orchestrator");
			expect(session?.capability).toBe("orchestrator");
		} finally {
			Bun.sleep = originalSleep;
		}
	});

	test("command registration includes orchestrator start/stop/status", () => {
		const cmd = createOrchestratorCommand({});
		const subcommandNames = cmd.commands.map((c) => c.name());
		expect(subcommandNames).toContain("start");
		expect(subcommandNames).toContain("stop");
		expect(subcommandNames).toContain("status");
		expect(subcommandNames).not.toContain("check-complete");
	});
});

describe("buildOrchestratorBeacon", () => {
	test("includes orchestrator identity in header", () => {
		const beacon = buildOrchestratorBeacon();
		expect(beacon).toContain("[OVERSTORY] orchestrator (orchestrator)");
	});

	test("includes ecosystem startup instructions", () => {
		const beacon = buildOrchestratorBeacon("sd");
		expect(beacon).toContain("ov mail check --agent orchestrator");
		expect(beacon).toContain("sd ready");
		expect(beacon).toContain("inspect ecosystem status");
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

			expect(output).toContain("Watchdog started");
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
		test("start help text includes --watchdog flag", async () => {
			const cmd = createCoordinatorCommand({});
			for (const sub of cmd.commands) {
				sub.exitOverride();
			}
			const output = await captureStdout(async () => {
				await cmd.parseAsync(["start", "--help"], { from: "user" }).catch(() => {});
			});
			expect(output).toContain("--watchdog");
			expect(output).toContain("watchdog");
		});

		test("start help text includes --accept-existing-watchdog flag", async () => {
			const cmd = createCoordinatorCommand({});
			for (const sub of cmd.commands) {
				sub.exitOverride();
			}
			const output = await captureStdout(async () => {
				await cmd.parseAsync(["start", "--help"], { from: "user" }).catch(() => {});
			});
			expect(output).toContain("--accept-existing-watchdog");
		});
	});

	// overstory-3f0c: detect leftover watchdog from a previous session before
	// spawning, so operators do not get unexpected watchdog supervision.
	describe("preexisting watchdog detection", () => {
		test("rejects start with no flags when watchdog is already running", async () => {
			const { deps, watchdogCalls } = makeDeps({}, { running: true });
			const originalSleep = Bun.sleep;
			Bun.sleep = (() => Promise.resolve()) as typeof Bun.sleep;

			try {
				await expect(coordinatorCommand(["start", "--json"], deps)).rejects.toThrow(
					ValidationError,
				);
			} finally {
				Bun.sleep = originalSleep;
			}

			// Detection ran, but no spawn or auto-start happened.
			expect(watchdogCalls?.isRunning).toBeGreaterThanOrEqual(1);
			expect(watchdogCalls?.start).toBe(0);
		});

		test("error message names the offending flags so operator can act", async () => {
			const { deps } = makeDeps({}, { running: true });
			const originalSleep = Bun.sleep;
			Bun.sleep = (() => Promise.resolve()) as typeof Bun.sleep;

			try {
				await coordinatorCommand(["start", "--json"], deps);
				expect.unreachable("should have thrown");
			} catch (err) {
				expect(err).toBeInstanceOf(ValidationError);
				const ve = err as ValidationError;
				expect(ve.message).toContain("Watchdog");
				expect(ve.message).toContain("--watchdog");
				expect(ve.message).toContain("--accept-existing-watchdog");
			} finally {
				Bun.sleep = originalSleep;
			}
		});

		test("--watchdog acknowledges preexisting daemon and does NOT double-start", async () => {
			const { deps, watchdogCalls } = makeDeps({}, { running: true, startSuccess: true });
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

			expect(watchdogCalls?.start).toBe(0);
			const parsed = JSON.parse(output) as Record<string, unknown>;
			expect(parsed.watchdog).toBe(true);
			expect(parsed.watchdogPreexisting).toBe(true);
		});

		test("--accept-existing-watchdog allows start without auto-managing the daemon", async () => {
			const { deps, watchdogCalls } = makeDeps({}, { running: true });
			const originalSleep = Bun.sleep;
			Bun.sleep = (() => Promise.resolve()) as typeof Bun.sleep;

			let output: string;
			try {
				output = await captureStdout(() =>
					coordinatorCommand(["start", "--accept-existing-watchdog", "--json"], deps),
				);
			} finally {
				Bun.sleep = originalSleep;
			}

			expect(watchdogCalls?.start).toBe(0);
			const parsed = JSON.parse(output) as Record<string, unknown>;
			expect(parsed.watchdog).toBe(true);
			expect(parsed.watchdogPreexisting).toBe(true);
		});

		test("watchdogPreexisting:false in JSON when no daemon was running", async () => {
			const { deps } = makeDeps({}, { running: false });
			const originalSleep = Bun.sleep;
			Bun.sleep = (() => Promise.resolve()) as typeof Bun.sleep;

			let output: string;
			try {
				output = await captureStdout(() => coordinatorCommand(["start", "--json"], deps));
			} finally {
				Bun.sleep = originalSleep;
			}

			const parsed = JSON.parse(output) as Record<string, unknown>;
			expect(parsed.watchdogPreexisting).toBe(false);
			expect(parsed.watchdog).toBe(false);
		});

		test("orchestrator inherits the same preexisting-watchdog detection", async () => {
			const { deps, watchdogCalls } = makeDeps({}, { running: true });
			const originalSleep = Bun.sleep;
			Bun.sleep = (() => Promise.resolve()) as typeof Bun.sleep;

			try {
				await expect(orchestratorCommand(["start", "--json"], deps)).rejects.toThrow(
					ValidationError,
				);
			} finally {
				Bun.sleep = originalSleep;
			}

			expect(watchdogCalls?.start).toBe(0);
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

			expect(output).toContain("Monitor started");
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

			let output: string;
			try {
				output = await captureStdout(() =>
					coordinatorCommand(["start", "--monitor", "--no-attach"], deps),
				);
			} finally {
				Bun.sleep = originalSleep;
			}

			expect(output).toContain("skipped");
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
		test("start help text includes --monitor flag", async () => {
			const cmd = createCoordinatorCommand({});
			for (const sub of cmd.commands) {
				sub.exitOverride();
			}
			const output = await captureStdout(async () => {
				await cmd.parseAsync(["start", "--help"], { from: "user" }).catch(() => {});
			});
			expect(output).toContain("--monitor");
			expect(output).toContain("monitor");
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

// --- Helpers for send/output tests ---

/** Read all messages from the mail store at mail.db for assertions. */
function loadMailMessages() {
	const mailDbPath = join(overstoryDir, "mail.db");
	const mailStore = createMailStore(mailDbPath);
	try {
		return mailStore.getAll();
	} finally {
		mailStore.close();
	}
}

describe("sendCoordinator", () => {
	test("send succeeds with running coordinator — mail is in DB", async () => {
		const session = makeCoordinatorSession({ state: "working" });
		saveSessionsToDb([session]);

		let nudgeCalled = false;
		const { deps } = makeDeps({ "overstory-test-project-coordinator": true });
		deps._nudge = async () => {
			nudgeCalled = true;
			return { delivered: true };
		};

		await captureStdout(() => coordinatorCommand(["send", "--body", "hello world"], deps));

		const messages = loadMailMessages();
		expect(messages).toHaveLength(1);
		expect(messages[0]?.from).toBe("operator");
		expect(messages[0]?.to).toBe("coordinator");
		expect(messages[0]?.body).toBe("hello world");
		expect(messages[0]?.type).toBe("dispatch");
		expect(nudgeCalled).toBe(true);
	});

	test("send fails when no coordinator running", async () => {
		const { deps } = makeDeps();

		await expect(coordinatorCommand(["send", "--body", "hello"], deps)).rejects.toThrow(AgentError);
	});

	test("send fails when coordinator tmux is dead — state updated to zombie", async () => {
		const session = makeCoordinatorSession({ state: "working" });
		saveSessionsToDb([session]);

		const { deps } = makeDeps({ "overstory-test-project-coordinator": false });

		await expect(coordinatorCommand(["send", "--body", "hello"], deps)).rejects.toThrow(AgentError);

		const sessions = loadSessionsFromDb();
		expect(sessions[0]?.state).toBe("zombie");
	});

	test("send --json outputs JSON with id and nudged fields", async () => {
		const session = makeCoordinatorSession({ state: "working" });
		saveSessionsToDb([session]);

		const { deps } = makeDeps({ "overstory-test-project-coordinator": true });
		deps._nudge = async () => ({ delivered: true });

		const output = await captureStdout(() =>
			coordinatorCommand(["send", "--body", "hello", "--json"], deps),
		);
		const parsed = JSON.parse(output) as Record<string, unknown>;
		expect(typeof parsed.id).toBe("string");
		expect(parsed.nudged).toBe(true);
	});

	test("send with custom --subject uses subject in mail", async () => {
		const session = makeCoordinatorSession({ state: "working" });
		saveSessionsToDb([session]);

		const { deps } = makeDeps({ "overstory-test-project-coordinator": true });
		deps._nudge = async () => ({ delivered: false });

		await captureStdout(() =>
			coordinatorCommand(
				["send", "--body", "build feature X", "--subject", "Deploy feature X"],
				deps,
			),
		);

		const messages = loadMailMessages();
		expect(messages[0]?.subject).toBe("Deploy feature X");
	});
});

describe("outputCoordinator", () => {
	test("output shows pane content", async () => {
		const session = makeCoordinatorSession({ state: "working" });
		saveSessionsToDb([session]);

		const { deps } = makeDeps({ "overstory-test-project-coordinator": true });
		deps._capturePaneContent = async () => "Hello from coordinator pane\n";

		const output = await captureStdout(() => coordinatorCommand(["output"], deps));
		expect(output).toContain("Hello from coordinator pane");
	});

	test("output fails when no coordinator running", async () => {
		const { deps } = makeDeps();

		await expect(coordinatorCommand(["output"], deps)).rejects.toThrow(AgentError);
	});

	test("output fails when coordinator tmux is dead — state updated to zombie", async () => {
		const session = makeCoordinatorSession({ state: "working" });
		saveSessionsToDb([session]);

		const { deps } = makeDeps({ "overstory-test-project-coordinator": false });

		await expect(coordinatorCommand(["output"], deps)).rejects.toThrow(AgentError);

		const sessions = loadSessionsFromDb();
		expect(sessions[0]?.state).toBe("zombie");
	});

	test("output --json wraps content in JSON", async () => {
		const session = makeCoordinatorSession({ state: "working" });
		saveSessionsToDb([session]);

		const { deps } = makeDeps({ "overstory-test-project-coordinator": true });
		deps._capturePaneContent = async () => "some output";

		const output = await captureStdout(() => coordinatorCommand(["output", "--json"], deps));
		const parsed = JSON.parse(output) as Record<string, unknown>;
		expect(parsed.content).toBe("some output");
		expect(typeof parsed.lines).toBe("number");
	});

	test("output --lines passes lines parameter to capturePaneContent", async () => {
		const session = makeCoordinatorSession({ state: "working" });
		saveSessionsToDb([session]);

		let capturedLines: number | undefined;
		const { deps } = makeDeps({ "overstory-test-project-coordinator": true });
		deps._capturePaneContent = async (_name: string, lines?: number) => {
			capturedLines = lines;
			return "output";
		};

		await captureStdout(() => coordinatorCommand(["output", "--lines", "100"], deps));
		expect(capturedLines).toBe(100);
	});
});

describe("askCoordinator", () => {
	test("sends mail and returns reply body on stdout", async () => {
		const session = makeCoordinatorSession({ state: "working" });
		saveSessionsToDb([session]);

		const { deps } = makeDeps({ "overstory-test-project-coordinator": true });
		deps._nudge = async () => ({ delivered: true });
		deps._pollIntervalMs = 50; // Fast polling for test

		const mailDbPath = join(overstoryDir, "mail.db");
		const outputChunks: string[] = [];
		const originalWrite = process.stdout.write;
		process.stdout.write = ((chunk: string) => {
			outputChunks.push(chunk);
			return true;
		}) as typeof process.stdout.write;

		try {
			// Start ask without awaiting — lets us insert the reply concurrently
			const askPromise = askCoordinator(
				"what is the status",
				{ subject: "status check", timeout: 10, json: false },
				deps,
			);

			// Wait for the ask to complete setup and send mail, then insert a reply
			await Bun.sleep(300);
			const replyStore = createMailStore(mailDbPath);
			try {
				const messages = replyStore.getAll({ from: "operator", to: "coordinator" });
				const sent = messages[0];
				if (sent) {
					replyStore.insert({
						id: "",
						from: "coordinator",
						to: "operator",
						subject: `Re: ${sent.subject}`,
						body: "Here is your answer",
						type: "status",
						priority: "normal",
						threadId: sent.id,
						payload: JSON.stringify({
							correlationId: JSON.parse(sent.payload ?? "{}").correlationId,
						}),
					});
				}
			} finally {
				replyStore.close();
			}

			await askPromise;
		} finally {
			process.stdout.write = originalWrite;
		}

		expect(outputChunks.join("")).toBe("Here is your answer\n");
	});

	test("times out when no reply arrives", async () => {
		const session = makeCoordinatorSession({ state: "working" });
		saveSessionsToDb([session]);

		const { deps } = makeDeps({ "overstory-test-project-coordinator": true });
		deps._nudge = async () => ({ delivered: false });
		deps._pollIntervalMs = 50; // Fast polling so the 1s timeout exhausts quickly

		let caughtError: unknown;
		try {
			await askCoordinator(
				"will you answer?",
				{ subject: "timeout test", timeout: 1, json: false },
				deps,
			);
		} catch (err) {
			caughtError = err;
		}

		expect(caughtError).toBeInstanceOf(AgentError);
		const ae = caughtError as AgentError;
		expect(ae.message).toContain("Timed out");
	});

	test("throws when coordinator is not running", async () => {
		// No session in DB
		const { deps } = makeDeps();

		let caughtError: unknown;
		try {
			await askCoordinator("hello", { subject: "test", timeout: 5, json: false }, deps);
		} catch (err) {
			caughtError = err;
		}

		expect(caughtError).toBeInstanceOf(AgentError);
		const ae = caughtError as AgentError;
		expect(ae.message).toContain("No active coordinator");
	});

	test("throws when coordinator tmux session is dead", async () => {
		const session = makeCoordinatorSession({ state: "working" });
		saveSessionsToDb([session]);

		// Tmux reports session as dead
		const { deps } = makeDeps({ "overstory-test-project-coordinator": false });

		let caughtError: unknown;
		try {
			await askCoordinator("hello", { subject: "test", timeout: 5, json: false }, deps);
		} catch (err) {
			caughtError = err;
		}

		expect(caughtError).toBeInstanceOf(AgentError);
		const ae = caughtError as AgentError;
		expect(ae.message).toContain("not alive");

		// Session state should be updated to zombie
		const sessions = loadSessionsFromDb();
		expect(sessions[0]?.state).toBe("zombie");
	});

	test("JSON output includes correlationId and reply details", async () => {
		const session = makeCoordinatorSession({ state: "working" });
		saveSessionsToDb([session]);

		const { deps } = makeDeps({ "overstory-test-project-coordinator": true });
		deps._nudge = async () => ({ delivered: true });
		deps._pollIntervalMs = 50;

		const mailDbPath = join(overstoryDir, "mail.db");
		let output = "";

		const askPromise = captureStdout(async () => {
			const innerAskPromise = askCoordinator(
				"report status",
				{ subject: "status", timeout: 10, json: true },
				deps,
			);

			// Insert reply while ask is polling
			await Bun.sleep(300);
			const replyStore = createMailStore(mailDbPath);
			try {
				const messages = replyStore.getAll({ from: "operator", to: "coordinator" });
				const sent = messages[0];
				if (sent) {
					replyStore.insert({
						id: "",
						from: "coordinator",
						to: "operator",
						subject: `Re: ${sent.subject}`,
						body: "Status: all good",
						type: "status",
						priority: "normal",
						threadId: sent.id,
						payload: JSON.stringify({
							correlationId: JSON.parse(sent.payload ?? "{}").correlationId,
						}),
					});
				}
			} finally {
				replyStore.close();
			}

			await innerAskPromise;
		});

		output = await askPromise;

		const parsed = JSON.parse(output) as Record<string, unknown>;
		expect(parsed.success).toBe(true);
		expect(parsed.command).toBe("coordinator ask");
		expect(typeof parsed.correlationId).toBe("string");
		expect(typeof parsed.sentId).toBe("string");
		expect(typeof parsed.replyId).toBe("string");
		expect(parsed.body).toBe("Status: all good");
	});

	test("command registration — createCoordinatorCommand has ask subcommand", () => {
		const cmd = createCoordinatorCommand({});
		const subcommandNames = cmd.commands.map((c) => c.name());
		expect(subcommandNames).toContain("ask");
	});
});

// ─── checkComplete ─────────────────────────────────────────────────────────

describe("checkComplete", () => {
	test("all triggers disabled → complete: false", async () => {
		// Default config has no coordinator section → all triggers default to false
		const result = await checkComplete({ json: false });
		expect(result.complete).toBe(false);
		expect(result.triggers.allAgentsDone.enabled).toBe(false);
		expect(result.triggers.taskTrackerEmpty.enabled).toBe(false);
		expect(result.triggers.onShutdownSignal.enabled).toBe(false);
	});

	test("allAgentsDone met when all non-coordinator agents completed", async () => {
		// Enable allAgentsDone in config
		await Bun.write(
			join(overstoryDir, "config.yaml"),
			[
				"project:",
				"  name: test-project",
				`  root: ${tempDir}`,
				"  canonicalBranch: main",
				"coordinator:",
				"  exitTriggers:",
				"    allAgentsDone: true",
				"    taskTrackerEmpty: false",
				"    onShutdownSignal: false",
			].join("\n"),
		);

		// Write current-run.txt
		const runId = `run-${Date.now()}`;
		await Bun.write(join(overstoryDir, "current-run.txt"), runId);

		// Create sessions.db with two completed agents
		const store = createSessionStore(join(overstoryDir, "sessions.db"));
		try {
			const base: AgentSession = {
				id: "s1",
				agentName: "builder-1",
				capability: "builder",
				worktreePath: tempDir,
				branchName: "feat/x",
				taskId: "t1",
				tmuxSession: "tmux-1",
				state: "completed",
				pid: null,
				parentAgent: "coordinator",
				depth: 1,
				runId,
				startedAt: new Date().toISOString(),
				lastActivity: new Date().toISOString(),
				escalationLevel: 0,
				stalledSince: null,
				transcriptPath: null,
			};
			store.upsert(base);
			store.upsert({ ...base, id: "s2", agentName: "builder-2" });
		} finally {
			store.close();
		}

		const result = await checkComplete({ json: false });
		expect(result.triggers.allAgentsDone.enabled).toBe(true);
		expect(result.triggers.allAgentsDone.met).toBe(true);
		expect(result.complete).toBe(true);
	});

	test("allAgentsDone not met when agents still working", async () => {
		await Bun.write(
			join(overstoryDir, "config.yaml"),
			[
				"project:",
				"  name: test-project",
				`  root: ${tempDir}`,
				"  canonicalBranch: main",
				"coordinator:",
				"  exitTriggers:",
				"    allAgentsDone: true",
				"    taskTrackerEmpty: false",
				"    onShutdownSignal: false",
			].join("\n"),
		);

		const runId = `run-${Date.now()}`;
		await Bun.write(join(overstoryDir, "current-run.txt"), runId);

		const store = createSessionStore(join(overstoryDir, "sessions.db"));
		try {
			const session: AgentSession = {
				id: "s1",
				agentName: "builder-1",
				capability: "builder",
				worktreePath: tempDir,
				branchName: "feat/x",
				taskId: "t1",
				tmuxSession: "tmux-1",
				state: "working",
				pid: null,
				parentAgent: "coordinator",
				depth: 1,
				runId,
				startedAt: new Date().toISOString(),
				lastActivity: new Date().toISOString(),
				escalationLevel: 0,
				stalledSince: null,
				transcriptPath: null,
			};
			store.upsert(session);
		} finally {
			store.close();
		}

		const result = await checkComplete({ json: false });
		expect(result.triggers.allAgentsDone.enabled).toBe(true);
		expect(result.triggers.allAgentsDone.met).toBe(false);
		expect(result.complete).toBe(false);
	});

	test("allAgentsDone filters out coordinator session", async () => {
		await Bun.write(
			join(overstoryDir, "config.yaml"),
			[
				"project:",
				"  name: test-project",
				`  root: ${tempDir}`,
				"  canonicalBranch: main",
				"coordinator:",
				"  exitTriggers:",
				"    allAgentsDone: true",
				"    taskTrackerEmpty: false",
				"    onShutdownSignal: false",
			].join("\n"),
		);

		const runId = `run-${Date.now()}`;
		await Bun.write(join(overstoryDir, "current-run.txt"), runId);

		const store = createSessionStore(join(overstoryDir, "sessions.db"));
		try {
			// coordinator session (should be excluded)
			store.upsert({
				id: "coord",
				agentName: "coordinator",
				capability: "coordinator",
				worktreePath: tempDir,
				branchName: "main",
				taskId: "",
				tmuxSession: "tmux-coord",
				state: "working",
				pid: null,
				parentAgent: null,
				depth: 0,
				runId,
				startedAt: new Date().toISOString(),
				lastActivity: new Date().toISOString(),
				escalationLevel: 0,
				stalledSince: null,
				transcriptPath: null,
			});
			// worker session that is completed
			store.upsert({
				id: "worker",
				agentName: "builder-1",
				capability: "builder",
				worktreePath: tempDir,
				branchName: "feat/x",
				taskId: "t1",
				tmuxSession: "tmux-w",
				state: "completed",
				pid: null,
				parentAgent: "coordinator",
				depth: 1,
				runId,
				startedAt: new Date().toISOString(),
				lastActivity: new Date().toISOString(),
				escalationLevel: 0,
				stalledSince: null,
				transcriptPath: null,
			});
		} finally {
			store.close();
		}

		const result = await checkComplete({ json: false });
		expect(result.triggers.allAgentsDone.enabled).toBe(true);
		// coordinator is filtered out; only the builder counts → all done
		expect(result.triggers.allAgentsDone.met).toBe(true);
		expect(result.complete).toBe(true);
	});

	test("onShutdownSignal met when shutdown mail exists", async () => {
		await Bun.write(
			join(overstoryDir, "config.yaml"),
			[
				"project:",
				"  name: test-project",
				`  root: ${tempDir}`,
				"  canonicalBranch: main",
				"coordinator:",
				"  exitTriggers:",
				"    allAgentsDone: false",
				"    taskTrackerEmpty: false",
				"    onShutdownSignal: true",
			].join("\n"),
		);

		// Insert a shutdown message into mail.db
		const mailStore = createMailStore(join(overstoryDir, "mail.db"));
		try {
			mailStore.insert({
				id: "",
				from: "greenhouse",
				to: "coordinator",
				subject: "shutdown",
				body: "All work done, please shutdown",
				type: "status",
				priority: "normal",
				threadId: null,
				payload: null,
			});
		} finally {
			mailStore.close();
		}

		const result = await checkComplete({ json: false });
		expect(result.triggers.onShutdownSignal.enabled).toBe(true);
		expect(result.triggers.onShutdownSignal.met).toBe(true);
		expect(result.complete).toBe(true);
	});

	test("overall complete false when only one of two enabled triggers is met", async () => {
		// Enable allAgentsDone + onShutdownSignal; satisfy only onShutdownSignal
		await Bun.write(
			join(overstoryDir, "config.yaml"),
			[
				"project:",
				"  name: test-project",
				`  root: ${tempDir}`,
				"  canonicalBranch: main",
				"coordinator:",
				"  exitTriggers:",
				"    allAgentsDone: true",
				"    taskTrackerEmpty: false",
				"    onShutdownSignal: true",
			].join("\n"),
		);

		// Write current-run.txt but no sessions → allAgentsDone not met (empty run)
		const runId = `run-${Date.now()}`;
		await Bun.write(join(overstoryDir, "current-run.txt"), runId);
		// Sessions DB will be created empty — no agents → allAgentsDone.met = false (length === 0)

		// Insert shutdown mail so onShutdownSignal is met
		const mailStore = createMailStore(join(overstoryDir, "mail.db"));
		try {
			mailStore.insert({
				id: "",
				from: "operator",
				to: "coordinator",
				subject: "shutdown now",
				body: "Please shutdown",
				type: "status",
				priority: "normal",
				threadId: null,
				payload: null,
			});
		} finally {
			mailStore.close();
		}

		const result = await checkComplete({ json: false });
		expect(result.triggers.allAgentsDone.enabled).toBe(true);
		expect(result.triggers.allAgentsDone.met).toBe(false);
		expect(result.triggers.onShutdownSignal.enabled).toBe(true);
		expect(result.triggers.onShutdownSignal.met).toBe(true);
		// Both must be met → false
		expect(result.complete).toBe(false);
	});

	test("allAgentsDone false when merge queue has pending branches", async () => {
		await Bun.write(
			join(overstoryDir, "config.yaml"),
			[
				"project:",
				"  name: test-project",
				`  root: ${tempDir}`,
				"  canonicalBranch: main",
				"coordinator:",
				"  exitTriggers:",
				"    allAgentsDone: true",
				"    taskTrackerEmpty: false",
				"    onShutdownSignal: false",
			].join("\n"),
		);

		const runId = `run-${Date.now()}`;
		await Bun.write(join(overstoryDir, "current-run.txt"), runId);

		// All agent sessions completed
		const store = createSessionStore(join(overstoryDir, "sessions.db"));
		try {
			store.upsert({
				id: "s1",
				agentName: "lead-1",
				capability: "lead",
				worktreePath: tempDir,
				branchName: "overstory/lead-1/task-1",
				taskId: "task-1",
				tmuxSession: "tmux-1",
				state: "completed",
				pid: null,
				parentAgent: "coordinator",
				depth: 1,
				runId,
				startedAt: new Date().toISOString(),
				lastActivity: new Date().toISOString(),
				escalationLevel: 0,
				stalledSince: null,
				transcriptPath: null,
			});
		} finally {
			store.close();
		}

		// Merge queue has a pending entry — lead branch not yet merged
		const { createMergeQueue } = await import("../merge/queue.ts");
		const queue = createMergeQueue(join(overstoryDir, "merge-queue.db"));
		try {
			queue.enqueue({
				branchName: "overstory/lead-1/task-1",
				taskId: "task-1",
				agentName: "lead-1",
				filesModified: ["src/foo.ts"],
			});
		} finally {
			queue.close();
		}

		const result = await checkComplete({ json: false });
		expect(result.triggers.allAgentsDone.enabled).toBe(true);
		expect(result.triggers.allAgentsDone.met).toBe(false);
		expect(result.triggers.allAgentsDone.detail).toInclude("pending merge");
		expect(result.triggers.allAgentsDone.detail).toInclude("overstory/lead-1/task-1");
		expect(result.complete).toBe(false);
	});

	test("allAgentsDone true when all agents completed and merge queue is empty", async () => {
		await Bun.write(
			join(overstoryDir, "config.yaml"),
			[
				"project:",
				"  name: test-project",
				`  root: ${tempDir}`,
				"  canonicalBranch: main",
				"coordinator:",
				"  exitTriggers:",
				"    allAgentsDone: true",
				"    taskTrackerEmpty: false",
				"    onShutdownSignal: false",
			].join("\n"),
		);

		const runId = `run-${Date.now()}`;
		await Bun.write(join(overstoryDir, "current-run.txt"), runId);

		const store = createSessionStore(join(overstoryDir, "sessions.db"));
		try {
			store.upsert({
				id: "s1",
				agentName: "lead-1",
				capability: "lead",
				worktreePath: tempDir,
				branchName: "overstory/lead-1/task-1",
				taskId: "task-1",
				tmuxSession: "tmux-1",
				state: "completed",
				pid: null,
				parentAgent: "coordinator",
				depth: 1,
				runId,
				startedAt: new Date().toISOString(),
				lastActivity: new Date().toISOString(),
				escalationLevel: 0,
				stalledSince: null,
				transcriptPath: null,
			});
		} finally {
			store.close();
		}

		// Merge queue exists but all entries are already merged (no pending)
		const { createMergeQueue } = await import("../merge/queue.ts");
		const queue = createMergeQueue(join(overstoryDir, "merge-queue.db"));
		try {
			const entry = queue.enqueue({
				branchName: "overstory/lead-1/task-1",
				taskId: "task-1",
				agentName: "lead-1",
				filesModified: ["src/foo.ts"],
			});
			queue.updateStatus(entry.branchName, "merged", "clean-merge");
		} finally {
			queue.close();
		}

		const result = await checkComplete({ json: false });
		expect(result.triggers.allAgentsDone.enabled).toBe(true);
		expect(result.triggers.allAgentsDone.met).toBe(true);
		expect(result.complete).toBe(true);
	});

	test("command registration — createCoordinatorCommand has check-complete subcommand", () => {
		const cmd = createCoordinatorCommand({});
		const subcommandNames = cmd.commands.map((c) => c.name());
		expect(subcommandNames).toContain("check-complete");
	});
});

describe("startCoordinatorSession headless", () => {
	test("with headless: true, calls spawnHeadlessAgent and skips tmux", async () => {
		const { tmux, calls: tmuxCalls } = makeFakeTmux();
		const { watchdog } = makeFakeWatchdog();
		const { monitor } = makeFakeMonitor();

		const spawnCalls: Array<{
			argv: string[];
			cwd: string;
			agentName?: string;
		}> = [];
		const writes: string[] = [];

		const fakeSpawn = async (
			argv: string[],
			opts: { cwd: string; env: Record<string, string>; agentName?: string },
		): Promise<{
			pid: number;
			stdin: { write(data: string | Uint8Array): number | Promise<number> };
			stdout: ReadableStream<Uint8Array> | null;
		}> => {
			spawnCalls.push({ argv, cwd: opts.cwd, agentName: opts.agentName });
			return {
				pid: 55555,
				stdin: {
					write(data: string | Uint8Array): number {
						writes.push(typeof data === "string" ? data : new TextDecoder().decode(data));
						return 0;
					},
				},
				stdout: null,
			};
		};

		const deps: CoordinatorDeps = {
			_tmux: tmux,
			_watchdog: watchdog,
			_monitor: monitor,
			_spawnHeadless: fakeSpawn,
		};

		await captureStdout(async () => {
			await startCoordinatorSession(
				{
					json: true,
					attach: false,
					watchdog: false,
					monitor: false,
					headless: true,
				},
				deps,
			);
		});

		// spawnHeadlessAgent was called exactly once with agentName: "coordinator"
		expect(spawnCalls.length).toBe(1);
		expect(spawnCalls[0]?.agentName).toBe("coordinator");
		expect(spawnCalls[0]?.cwd).toBe(tempDir);

		// initial stdin prompt was written
		expect(writes.length).toBeGreaterThanOrEqual(1);

		// tmux helpers were never called for the headless path
		expect(tmuxCalls.createSession.length).toBe(0);
		expect(tmuxCalls.sendKeys.length).toBe(0);
		expect(tmuxCalls.waitForTuiReady.length).toBe(0);
		expect(tmuxCalls.ensureTmuxAvailable).toBe(0);

		// Session row records empty tmuxSession + the headless spawn pid
		const sessions = loadSessionsFromDb();
		expect(sessions.length).toBe(1);
		expect(sessions[0]?.agentName).toBe("coordinator");
		expect(sessions[0]?.tmuxSession).toBe("");
		expect(sessions[0]?.pid).toBe(55555);
		expect(sessions[0]?.state).toBe("booting");

		// current-run.txt was written for downstream consumers
		const runFile = Bun.file(join(overstoryDir, "current-run.txt"));
		expect(await runFile.exists()).toBe(true);
	});

	test("rejects when runtime has no buildDirectSpawn", async () => {
		// Override config to route the coordinator capability to a runtime that
		// lacks buildDirectSpawn (e.g. cursor). The headless path must reject.
		await Bun.write(
			join(overstoryDir, "config.yaml"),
			[
				"project:",
				"  name: test-project",
				`  root: ${tempDir}`,
				"  canonicalBranch: main",
				"watchdog:",
				"  tier2Enabled: true",
				"runtime:",
				"  capabilities:",
				"    coordinator: cursor",
			].join("\n"),
		);

		const { tmux } = makeFakeTmux();
		const { watchdog } = makeFakeWatchdog();
		const { monitor } = makeFakeMonitor();
		const deps: CoordinatorDeps = {
			_tmux: tmux,
			_watchdog: watchdog,
			_monitor: monitor,
			_spawnHeadless: async () => {
				throw new Error("should not be called");
			},
		};

		await expect(
			startCoordinatorSession(
				{
					json: true,
					attach: false,
					watchdog: false,
					monitor: false,
					headless: true,
				},
				deps,
			),
		).rejects.toThrow(ValidationError);
	});
});

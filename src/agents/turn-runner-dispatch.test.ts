import { describe, expect, test } from "bun:test";
import type { AgentRuntime } from "../runtimes/types.ts";
import type { AgentManifest, AgentSession, OverstoryConfig } from "../types.ts";
import { buildRunTurnOptsFactory, isSpawnPerTurnAgent } from "./turn-runner-dispatch.ts";

function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
	return {
		id: "session-1",
		agentName: "build-agent-1",
		capability: "builder",
		worktreePath: "/tmp/wt-build",
		branchName: "overstory/b/task-1",
		taskId: "task-1",
		tmuxSession: "",
		state: "working",
		pid: 12345,
		parentAgent: "lead-1",
		depth: 1,
		runId: "run-abc",
		startedAt: new Date().toISOString(),
		lastActivity: new Date().toISOString(),
		escalationLevel: 0,
		stalledSince: null,
		transcriptPath: null,
		...overrides,
	};
}

function makeConfig(overrides: Partial<OverstoryConfig> = {}): OverstoryConfig {
	const base: OverstoryConfig = {
		project: {
			name: "test",
			root: "/tmp/proj",
			canonicalBranch: "main",
		},
		agents: {
			baseDir: "agents",
			manifestPath: ".overstory/agent-manifest.json",
			maxConcurrent: 5,
			maxSessionsPerRun: 0,
			maxAgentsPerLead: 5,
			maxDepth: 2,
			staggerDelayMs: 0,
			autoNudgeOnMail: false,
		},
		worktrees: { baseDir: ".overstory/worktrees" },
		merge: { mode: "manual" },
		mulch: { enabled: false, domains: {} },
		canopy: { enabled: false },
		taskTracker: { backend: "seeds", enabled: true },
		watchdog: {
			tier0Enabled: false,
			tier0IntervalMs: 30_000,
			tier1Enabled: false,
			maxEscalationLevel: 3,
		},
		models: {},
		logging: { verbose: false, redactSecrets: true },
		runtime: {
			default: "claude",
		},
		providers: {},
	} as unknown as OverstoryConfig;
	return { ...base, ...overrides } as OverstoryConfig;
}

function makeManifest(): AgentManifest {
	return {
		version: "1",
		agents: {
			builder: {
				file: "builder.md",
				model: "claude-sonnet",
				tools: [],
				capabilities: ["build"],
				canSpawn: false,
				constraints: [],
			},
		},
		capabilityIndex: { build: ["builder"] },
	} as AgentManifest;
}

function fakeRuntime(overrides: Partial<AgentRuntime> = {}): AgentRuntime {
	return {
		id: "claude",
		stability: "stable",
		instructionPath: ".claude/CLAUDE.md",
		buildSpawnCommand: () => "",
		buildPrintCommand: () => [],
		deployConfig: async () => {},
		buildEnv: () => ({}),
		buildDirectSpawn: () => ["claude"],
		parseEvents: async function* () {},
		...overrides,
	} as unknown as AgentRuntime;
}

describe("buildRunTurnOptsFactory", () => {
	test("threads session metadata + project paths into runTurn opts", () => {
		const session = makeSession();
		const config = makeConfig();
		const manifest = makeManifest();
		const runtime = fakeRuntime();

		const factory = buildRunTurnOptsFactory({
			session,
			config,
			manifest,
			overstoryDir: "/tmp/proj/.overstory",
			_getRuntime: () => runtime,
			_resolveModel: () => ({ model: "claude-sonnet", isExplicitOverride: false }),
		});

		const opts = factory.build('{"type":"user"}\n');
		expect(opts.agentName).toBe("build-agent-1");
		expect(opts.worktreePath).toBe("/tmp/wt-build");
		expect(opts.taskId).toBe("task-1");
		expect(opts.runId).toBe("run-abc");
		expect(opts.projectRoot).toBe("/tmp/proj");
		expect(opts.mailDbPath).toBe("/tmp/proj/.overstory/mail.db");
		expect(opts.eventsDbPath).toBe("/tmp/proj/.overstory/events.db");
		expect(opts.sessionsDbPath).toBe("/tmp/proj/.overstory/sessions.db");
		expect(opts.userTurnNdjson).toBe('{"type":"user"}\n');
		expect(opts.runtime).toBe(runtime);
	});
});

describe("isSpawnPerTurnAgent", () => {
	const runtime = fakeRuntime();

	test("returns true for builder + flag on + non-terminal + claude runtime", () => {
		const ok = isSpawnPerTurnAgent(
			makeSession({ capability: "builder", state: "working" }),
			makeConfig({ runtime: { default: "claude", claudeSpawnPerTurn: true } }),
			runtime,
		);
		expect(ok).toBe(true);
	});

	test("returns false when flag is off", () => {
		const off = isSpawnPerTurnAgent(
			makeSession(),
			makeConfig({ runtime: { default: "claude", claudeSpawnPerTurn: false } }),
			runtime,
		);
		expect(off).toBe(false);
	});

	test("returns false for non-builder capabilities", () => {
		const scout = isSpawnPerTurnAgent(
			makeSession({ capability: "scout" }),
			makeConfig({ runtime: { default: "claude", claudeSpawnPerTurn: true } }),
			runtime,
		);
		expect(scout).toBe(false);
	});

	test("returns false for terminal states (completed, zombie)", () => {
		const config = makeConfig({ runtime: { default: "claude", claudeSpawnPerTurn: true } });
		expect(isSpawnPerTurnAgent(makeSession({ state: "completed" }), config, runtime)).toBe(false);
		expect(isSpawnPerTurnAgent(makeSession({ state: "zombie" }), config, runtime)).toBe(false);
	});

	test("returns false when runtime cannot direct-spawn", () => {
		const noDirectSpawn = fakeRuntime({ buildDirectSpawn: undefined });
		const result = isSpawnPerTurnAgent(
			makeSession(),
			makeConfig({ runtime: { default: "claude", claudeSpawnPerTurn: true } }),
			noDirectSpawn,
		);
		expect(result).toBe(false);
	});

	test("returns false when runtime cannot parseEvents", () => {
		const noParser = fakeRuntime({ parseEvents: undefined });
		const result = isSpawnPerTurnAgent(
			makeSession(),
			makeConfig({ runtime: { default: "claude", claudeSpawnPerTurn: true } }),
			noParser,
		);
		expect(result).toBe(false);
	});
});

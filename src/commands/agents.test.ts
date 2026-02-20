/**
 * Tests for the agents command.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionStore } from "../sessions/store.ts";
import type { AgentSession } from "../types.ts";
import { agentsCommand, discoverAgents, extractFileScope } from "./agents.ts";

describe("extractFileScope", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "overstory-test-"));
	});

	it("should return empty array when overlay doesn't exist", async () => {
		const scope = await extractFileScope(tempDir);
		expect(scope).toEqual([]);
	});

	it("should return empty array when 'No file scope restrictions'", async () => {
		const overlayPath = join(tempDir, ".claude", "CLAUDE.md");
		const content = `# Agent Overlay

## File Scope (exclusive ownership)

No file scope restrictions. You may modify any file in the worktree.

## Expertise

Some expertise here.
`;
		await Bun.write(overlayPath, content);
		const scope = await extractFileScope(tempDir);
		expect(scope).toEqual([]);
	});

	it("should extract file paths from valid overlay", async () => {
		const overlayPath = join(tempDir, ".claude", "CLAUDE.md");
		const content = `# Agent Overlay

## File Scope (exclusive ownership)

These files are yours to modify:

- \`src/commands/agents.ts\`
- \`src/commands/agents.test.ts\`
- \`src/index.ts\`

## Expertise

Some expertise here.
`;
		await Bun.write(overlayPath, content);
		const scope = await extractFileScope(tempDir);
		expect(scope).toEqual([
			"src/commands/agents.ts",
			"src/commands/agents.test.ts",
			"src/index.ts",
		]);
	});

	it("should extract file paths from AGENTS.md when custom instructions path is provided", async () => {
		const overlayPath = join(tempDir, "AGENTS.md");
		const content = `# Agent Overlay

## File Scope (exclusive ownership)

These files are yours to modify:

- \`src/codex/one.ts\`
- \`src/codex/two.ts\`

## Expertise
`;
		await Bun.write(overlayPath, content);
		const scope = await extractFileScope(tempDir, "AGENTS.md");
		expect(scope).toEqual(["src/codex/one.ts", "src/codex/two.ts"]);
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});
});

describe("discoverAgents", () => {
	let tempDir: string;
	let dbPath: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "overstory-test-"));
		const overstoryDir = join(tempDir, ".overstory");
		await Bun.write(join(overstoryDir, ".gitkeep"), "");
		dbPath = join(overstoryDir, "sessions.db");
	});

	it("should return empty when no sessions", async () => {
		const store = createSessionStore(dbPath);
		store.close();

		const agents = await discoverAgents(tempDir);
		expect(agents).toEqual([]);
	});

	it("should return active agents", async () => {
		const store = createSessionStore(dbPath);

		const session: AgentSession = {
			id: "session-1",
			agentName: "builder-test",
			capability: "builder",
			worktreePath: join(tempDir, ".overstory", "worktrees", "builder-test"),
			branchName: "overstory/builder-test/task-123",
			beadId: "task-123",
			tmuxSession: "overstory-test-builder",
			state: "working",
			pid: 12345,
			parentAgent: null,
			depth: 0,
			runId: "run-1",
			startedAt: "2024-01-01T00:00:00Z",
			lastActivity: "2024-01-01T00:01:00Z",
			escalationLevel: 0,
			stalledSince: null,
		};

		store.upsert(session);
		store.close();

		const agents = await discoverAgents(tempDir);
		expect(agents).toHaveLength(1);
		expect(agents[0]?.agentName).toBe("builder-test");
		expect(agents[0]?.capability).toBe("builder");
		expect(agents[0]?.state).toBe("working");
	});

	it("should filter by capability", async () => {
		const store = createSessionStore(dbPath);

		const builder: AgentSession = {
			id: "session-1",
			agentName: "builder-test",
			capability: "builder",
			worktreePath: join(tempDir, ".overstory", "worktrees", "builder-test"),
			branchName: "overstory/builder-test/task-123",
			beadId: "task-123",
			tmuxSession: "overstory-test-builder",
			state: "working",
			pid: 12345,
			parentAgent: null,
			depth: 0,
			runId: "run-1",
			startedAt: "2024-01-01T00:00:00Z",
			lastActivity: "2024-01-01T00:01:00Z",
			escalationLevel: 0,
			stalledSince: null,
		};

		const scout: AgentSession = {
			id: "session-2",
			agentName: "scout-test",
			capability: "scout",
			worktreePath: join(tempDir, ".overstory", "worktrees", "scout-test"),
			branchName: "overstory/scout-test/task-456",
			beadId: "task-456",
			tmuxSession: "overstory-test-scout",
			state: "working",
			pid: 12346,
			parentAgent: null,
			depth: 0,
			runId: "run-1",
			startedAt: "2024-01-01T00:00:00Z",
			lastActivity: "2024-01-01T00:01:00Z",
			escalationLevel: 0,
			stalledSince: null,
		};

		store.upsert(builder);
		store.upsert(scout);
		store.close();

		const agents = await discoverAgents(tempDir, { capability: "builder" });
		expect(agents).toHaveLength(1);
		expect(agents[0]?.agentName).toBe("builder-test");
		expect(agents[0]?.capability).toBe("builder");
	});

	it("should includeAll returns completed agents too", async () => {
		const store = createSessionStore(dbPath);

		const working: AgentSession = {
			id: "session-1",
			agentName: "builder-working",
			capability: "builder",
			worktreePath: join(tempDir, ".overstory", "worktrees", "builder-working"),
			branchName: "overstory/builder-working/task-123",
			beadId: "task-123",
			tmuxSession: "overstory-test-working",
			state: "working",
			pid: 12345,
			parentAgent: null,
			depth: 0,
			runId: "run-1",
			startedAt: "2024-01-01T00:00:00Z",
			lastActivity: "2024-01-01T00:01:00Z",
			escalationLevel: 0,
			stalledSince: null,
		};

		const completed: AgentSession = {
			id: "session-2",
			agentName: "builder-completed",
			capability: "builder",
			worktreePath: join(tempDir, ".overstory", "worktrees", "builder-completed"),
			branchName: "overstory/builder-completed/task-456",
			beadId: "task-456",
			tmuxSession: "overstory-test-completed",
			state: "completed",
			pid: null,
			parentAgent: null,
			depth: 0,
			runId: "run-1",
			startedAt: "2024-01-01T00:00:00Z",
			lastActivity: "2024-01-01T00:02:00Z",
			escalationLevel: 0,
			stalledSince: null,
		};

		store.upsert(working);
		store.upsert(completed);
		store.close();

		// Without includeAll, only active agents
		const activeAgents = await discoverAgents(tempDir);
		expect(activeAgents).toHaveLength(1);
		expect(activeAgents[0]?.agentName).toBe("builder-working");

		// With includeAll, both working and completed
		const allAgents = await discoverAgents(tempDir, { includeAll: true });
		expect(allAgents).toHaveLength(2);
		const names = allAgents.map((a) => a.agentName);
		expect(names).toContain("builder-working");
		expect(names).toContain("builder-completed");
	});

	it("should use custom instructions path when discovering file scope", async () => {
		const worktreePath = join(tempDir, ".overstory", "worktrees", "builder-codex");
		await mkdir(worktreePath, { recursive: true });
		await Bun.write(
			join(worktreePath, "AGENTS.md"),
			`## File Scope (exclusive ownership)\n\n- \`src/codex.ts\`\n\n## Expertise\n`,
		);

		const store = createSessionStore(dbPath);
		const session: AgentSession = {
			id: "session-codex",
			agentName: "builder-codex",
			capability: "builder",
			worktreePath,
			branchName: "overstory/builder-codex/task-123",
			beadId: "task-123",
			tmuxSession: "overstory-test-builder-codex",
			state: "working",
			pid: 12345,
			parentAgent: null,
			depth: 0,
			runId: "run-1",
			startedAt: "2024-01-01T00:00:00Z",
			lastActivity: "2024-01-01T00:01:00Z",
			escalationLevel: 0,
			stalledSince: null,
		};
		store.upsert(session);
		store.close();

		const agents = await discoverAgents(tempDir, { instructionsPath: "AGENTS.md" });
		expect(agents).toHaveLength(1);
		expect(agents[0]?.fileScope).toEqual(["src/codex.ts"]);
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});
});

describe("agentsCommand", () => {
	let tempDir: string;
	let originalCwd: string;
	let originalStdoutWrite: typeof process.stdout.write;
	let stdoutBuffer: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "overstory-test-"));
		const overstoryDir = join(tempDir, ".overstory");

		// Create config.yaml
		const configContent = `project:
  name: test-project
  root: ${tempDir}
  canonicalBranch: main
agents:
  manifestPath: .overstory/agent-manifest.json
  baseDir: agents
  maxConcurrent: 5
  staggerDelayMs: 100
  maxDepth: 2
worktrees:
  baseDir: .overstory/worktrees
beads:
  enabled: true
mulch:
  enabled: true
  domains: []
  primeFormat: markdown
merge:
  aiResolveEnabled: false
  reimagineEnabled: false
watchdog:
  tier0Enabled: false
  tier0IntervalMs: 30000
  tier1Enabled: false
  tier2Enabled: false
  staleThresholdMs: 300000
  zombieThresholdMs: 600000
  nudgeIntervalMs: 60000
logging:
  verbose: false
  redactSecrets: true
`;
		await Bun.write(join(overstoryDir, "config.yaml"), configContent);

		// Create sessions.db
		const dbPath = join(overstoryDir, "sessions.db");
		const store = createSessionStore(dbPath);
		store.close();

		// Mock stdout.write
		stdoutBuffer = "";
		originalStdoutWrite = process.stdout.write;
		process.stdout.write = mock((chunk: unknown) => {
			stdoutBuffer += String(chunk);
			return true;
		});

		// Change to temp dir
		originalCwd = process.cwd();
		process.chdir(tempDir);
	});

	it("should show help with --help flag", async () => {
		await agentsCommand(["--help"]);
		expect(stdoutBuffer).toContain("overstory agents");
		expect(stdoutBuffer).toContain("discover");
	});

	it("should show help with no subcommand", async () => {
		await agentsCommand([]);
		expect(stdoutBuffer).toContain("overstory agents");
		expect(stdoutBuffer).toContain("discover");
	});

	it("should error on unknown subcommand", async () => {
		await expect(agentsCommand(["unknown"])).rejects.toThrow("Unknown subcommand");
	});

	afterEach(async () => {
		process.stdout.write = originalStdoutWrite;
		process.chdir(originalCwd);
		await rm(tempDir, { recursive: true, force: true });
	});
});

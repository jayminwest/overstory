import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession } from "../types.ts";
import { primeCommand } from "./prime.ts";

/**
 * Tests for `overstory prime` command.
 *
 * Uses real filesystem (temp directories) and process.stdout spy to test
 * the prime command end-to-end.
 */

describe("primeCommand", () => {
	let chunks: string[];
	let originalWrite: typeof process.stdout.write;
	let originalStderrWrite: typeof process.stderr.write;
	let stderrChunks: string[];
	let tempDir: string;
	let originalCwd: string;

	beforeEach(async () => {
		// Spy on stdout
		chunks = [];
		originalWrite = process.stdout.write;
		process.stdout.write = ((chunk: string) => {
			chunks.push(chunk);
			return true;
		}) as typeof process.stdout.write;

		// Spy on stderr
		stderrChunks = [];
		originalStderrWrite = process.stderr.write;
		process.stderr.write = ((chunk: string) => {
			stderrChunks.push(chunk);
			return true;
		}) as typeof process.stderr.write;

		// Create temp dir with .overstory/config.yaml structure
		tempDir = await mkdtemp(join(tmpdir(), "prime-test-"));
		const overstoryDir = join(tempDir, ".overstory");
		await Bun.write(
			join(overstoryDir, "config.yaml"),
			`project:\n  name: test-project\n  root: ${tempDir}\n  canonicalBranch: main\nmulch:\n  enabled: false\n`,
		);

		// Change to temp dir so loadConfig() works
		originalCwd = process.cwd();
		process.chdir(tempDir);
	});

	afterEach(async () => {
		process.stdout.write = originalWrite;
		process.stderr.write = originalStderrWrite;
		process.chdir(originalCwd);
		await rm(tempDir, { recursive: true, force: true });
	});

	function output(): string {
		return chunks.join("");
	}

	function stderr(): string {
		return stderrChunks.join("");
	}

	describe("Help", () => {
		test("--help shows help text", async () => {
			await primeCommand(["--help"]);
			const out = output();

			expect(out).toContain("overstory prime");
			expect(out).toContain("--agent");
			expect(out).toContain("--compact");
		});

		test("-h shows help text", async () => {
			await primeCommand(["-h"]);
			const out = output();

			expect(out).toContain("overstory prime");
			expect(out).toContain("--agent");
			expect(out).toContain("--compact");
		});
	});

	describe("parseArgs validation", () => {
		test("--agent without a name throws AgentError", async () => {
			await expect(primeCommand(["--agent"])).rejects.toThrow("--agent requires a name argument");
		});

		test("--agent followed by another flag throws AgentError", async () => {
			await expect(primeCommand(["--agent", "--compact"])).rejects.toThrow(
				"--agent requires a name argument",
			);
		});
	});

	describe("Orchestrator priming (no --agent flag)", () => {
		test("default prime outputs project context", async () => {
			await primeCommand([]);
			const out = output();

			expect(out).toContain("# Overstory Context");
			expect(out).toContain("## Project: test-project");
			expect(out).toContain("Canonical branch: main");
			expect(out).toContain("Max concurrent agents:");
			expect(out).toContain("Max depth:");
		});

		test("includes agent manifest section", async () => {
			await primeCommand([]);
			const out = output();

			expect(out).toContain("## Agent Manifest");
			// Without manifest file, should show fallback message
			expect(out).toContain("No agent manifest found.");
		});

		test("without metrics.db shows no recent sessions message", async () => {
			await primeCommand([]);
			const out = output();

			expect(out).toContain("## Recent Activity");
			expect(out).toContain("No recent sessions.");
		});

		test("--compact skips Recent Activity and Expertise sections", async () => {
			await primeCommand(["--compact"]);
			const out = output();

			// Should still have project basics
			expect(out).toContain("# Overstory Context");
			expect(out).toContain("## Project: test-project");

			// Should NOT have these sections
			expect(out).not.toContain("## Recent Activity");
			expect(out).not.toContain("## Expertise");
		});
	});

	describe("Agent priming (--agent <name>)", () => {
		test("unknown agent outputs basic context and warns", async () => {
			await primeCommand(["--agent", "unknown-agent"]);
			const out = output();
			const err = stderr();

			expect(out).toContain("# Agent Context: unknown-agent");
			expect(out).toContain("## Identity");
			expect(out).toContain("New agent - no prior sessions");
			expect(err).toContain('Warning: agent "unknown-agent" not found');
		});

		test("agent with identity.yaml shows identity details", async () => {
			// Write identity.yaml
			const agentDir = join(tempDir, ".overstory", "agents", "my-builder");
			await Bun.write(
				join(agentDir, "identity.yaml"),
				`name: my-builder
capability: builder
created: "2026-01-01T00:00:00Z"
sessionsCompleted: 3
expertiseDomains:
  - typescript
  - testing
recentTasks:
  - beadId: task-001
    summary: "Implemented feature X"
    completedAt: "2026-01-10T12:00:00Z"
`,
			);

			await primeCommand(["--agent", "my-builder"]);
			const out = output();

			expect(out).toContain("# Agent Context: my-builder");
			expect(out).toContain("Name: my-builder");
			expect(out).toContain("Capability: builder");
			expect(out).toContain("Sessions completed: 3");
			expect(out).toContain("Expertise: typescript, testing");
			expect(out).toContain("Recent tasks:");
			expect(out).toContain("task-001: Implemented feature X");
		});

		test("agent with active session shows Activation section", async () => {
			// Write sessions.json with active session
			const sessions: AgentSession[] = [
				{
					id: "session-001",
					agentName: "active-builder",
					capability: "builder",
					worktreePath: join(tempDir, ".overstory", "worktrees", "active-builder"),
					branchName: "overstory/active-builder/task-001",
					beadId: "task-001",
					tmuxSession: "overstory-active-builder",
					state: "working",
					pid: 12345,
					parentAgent: null,
					depth: 0,
					startedAt: new Date().toISOString(),
					lastActivity: new Date().toISOString(),
					escalationLevel: 0,
					stalledSince: null,
				},
			];

			await Bun.write(
				join(tempDir, ".overstory", "sessions.json"),
				`${JSON.stringify(sessions, null, 2)}\n`,
			);

			await primeCommand(["--agent", "active-builder"]);
			const out = output();

			expect(out).toContain("# Agent Context: active-builder");
			expect(out).toContain("## Activation");
			expect(out).toContain("You have a bound task: **task-001**");
			expect(out).toContain("begin working immediately");
		});

		test("agent with completed session does NOT show Activation", async () => {
			// Write sessions.json with completed session
			const sessions: AgentSession[] = [
				{
					id: "session-002",
					agentName: "completed-builder",
					capability: "builder",
					worktreePath: join(tempDir, ".overstory", "worktrees", "completed-builder"),
					branchName: "overstory/completed-builder/task-002",
					beadId: "task-002",
					tmuxSession: "overstory-completed-builder",
					state: "completed",
					pid: null,
					parentAgent: null,
					depth: 0,
					startedAt: new Date(Date.now() - 3600000).toISOString(),
					lastActivity: new Date().toISOString(),
					escalationLevel: 0,
					stalledSince: null,
				},
			];

			await Bun.write(
				join(tempDir, ".overstory", "sessions.json"),
				`${JSON.stringify(sessions, null, 2)}\n`,
			);

			await primeCommand(["--agent", "completed-builder"]);
			const out = output();

			expect(out).toContain("# Agent Context: completed-builder");
			expect(out).not.toContain("## Activation");
			expect(out).not.toContain("bound task");
		});

		test("--compact with checkpoint.json shows Session Recovery", async () => {
			// Write checkpoint.json
			const agentDir = join(tempDir, ".overstory", "agents", "recovery-agent");
			await Bun.write(
				join(agentDir, "checkpoint.json"),
				`${JSON.stringify(
					{
						agentName: "recovery-agent",
						beadId: "task-003",
						sessionId: "session-003",
						timestamp: new Date().toISOString(),
						progressSummary: "Implemented initial tests for prime command",
						filesModified: ["src/commands/prime.test.ts"],
						currentBranch: "overstory/recovery-agent/task-003",
						pendingWork: "Add tests for edge cases",
						mulchDomains: ["typescript", "testing"],
					},
					null,
					2,
				)}\n`,
			);

			// Also need identity to avoid warning
			await Bun.write(
				join(agentDir, "identity.yaml"),
				`name: recovery-agent
capability: builder
created: "2026-01-01T00:00:00Z"
sessionsCompleted: 0
expertiseDomains: []
recentTasks: []
`,
			);

			await primeCommand(["--agent", "recovery-agent", "--compact"]);
			const out = output();

			expect(out).toContain("# Agent Context: recovery-agent");
			expect(out).toContain("## Session Recovery");
			expect(out).toContain("Progress so far:** Implemented initial tests for prime command");
			expect(out).toContain("Files modified:** src/commands/prime.test.ts");
			expect(out).toContain("Pending work:** Add tests for edge cases");
			expect(out).toContain("Branch:** overstory/recovery-agent/task-003");
		});

		test("--compact skips Expertise section", async () => {
			// Write identity with expertise
			const agentDir = join(tempDir, ".overstory", "agents", "compact-agent");
			await Bun.write(
				join(agentDir, "identity.yaml"),
				`name: compact-agent
capability: builder
created: "2026-01-01T00:00:00Z"
sessionsCompleted: 1
expertiseDomains:
  - typescript
recentTasks: []
`,
			);

			await primeCommand(["--agent", "compact-agent", "--compact"]);
			const out = output();

			expect(out).toContain("# Agent Context: compact-agent");
			expect(out).not.toContain("## Expertise");
		});
	});
});

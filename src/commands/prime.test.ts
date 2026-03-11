import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTempDir, createTempGitRepo } from "../test-helpers.ts";
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
		await cleanupTempDir(tempDir);
	});

	function output(): string {
		return chunks.join("");
	}

	describe("Orchestrator priming (no --agent flag)", () => {
		test("default prime outputs project context", async () => {
			await primeCommand({});
			const out = output();

			expect(out).toContain("# Overstory Context");
			expect(out).toContain("## Project: test-project");
			expect(out).toContain("Canonical branch: main");
			expect(out).toContain("Max concurrent agents:");
			expect(out).toContain("Max depth:");
		});

		test("includes agent manifest section", async () => {
			await primeCommand({});
			const out = output();

			expect(out).toContain("## Agent Manifest");
			// Without manifest file, should show fallback message
			expect(out).toContain("No agent manifest found.");
		});

		test("without metrics.db shows no recent sessions message", async () => {
			await primeCommand({});
			const out = output();

			expect(out).toContain("## Recent Activity");
			expect(out).toContain("No recent sessions.");
		});

		test("--compact skips Recent Activity and Expertise sections", async () => {
			await primeCommand({ compact: true });
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
			await primeCommand({ agent: "unknown-agent" });
			const out = output();

			expect(out).toContain("# Agent Context: unknown-agent");
			expect(out).toContain("## Identity");
			expect(out).toContain("New agent - no prior sessions");
			expect(out).toContain('agent "unknown-agent" not found');
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
  - taskId: task-001
    summary: "Implemented feature X"
    completedAt: "2026-01-10T12:00:00Z"
`,
			);

			await primeCommand({ agent: "my-builder" });
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
					runtime: "claude",
					worktreePath: join(tempDir, ".overstory", "worktrees", "active-builder"),
					branchName: "overstory/active-builder/task-001",
					taskId: "task-001",
					tmuxSession: "overstory-active-builder",
					state: "working",
					pid: 12345,
					parentAgent: null,
					depth: 0,
					runId: null,
					startedAt: new Date().toISOString(),
					lastActivity: new Date().toISOString(),
					escalationLevel: 0,
					stalledSince: null,
					rateLimitedSince: null,
					transcriptPath: null,
				},
			];

			await Bun.write(
				join(tempDir, ".overstory", "sessions.json"),
				`${JSON.stringify(sessions, null, 2)}\n`,
			);

			await primeCommand({ agent: "active-builder" });
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
					runtime: "claude",
					worktreePath: join(tempDir, ".overstory", "worktrees", "completed-builder"),
					branchName: "overstory/completed-builder/task-002",
					taskId: "task-002",
					tmuxSession: "overstory-completed-builder",
					state: "completed",
					pid: null,
					parentAgent: null,
					depth: 0,
					runId: null,
					startedAt: new Date(Date.now() - 3600000).toISOString(),
					lastActivity: new Date().toISOString(),
					escalationLevel: 0,
					stalledSince: null,
					rateLimitedSince: null,
					transcriptPath: null,
				},
			];

			await Bun.write(
				join(tempDir, ".overstory", "sessions.json"),
				`${JSON.stringify(sessions, null, 2)}\n`,
			);

			await primeCommand({ agent: "completed-builder" });
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
						taskId: "task-003",
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

			await primeCommand({ agent: "recovery-agent", compact: true });
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

			await primeCommand({ agent: "compact-agent", compact: true });
			const out = output();

			expect(out).toContain("# Agent Context: compact-agent");
			expect(out).not.toContain("## Expertise");
		});
	});

	describe("Session branch capture", () => {
		test("orchestrator prime writes session-branch.txt with current git branch", async () => {
			// Need a real git repo for branch detection
			const gitRepoDir = await createTempGitRepo();
			try {
				const overstoryDir = join(gitRepoDir, ".overstory");
				await mkdir(overstoryDir, { recursive: true });
				await Bun.write(
					join(overstoryDir, "config.yaml"),
					`project:\n  name: branch-test\n  root: ${gitRepoDir}\n  canonicalBranch: main\nmulch:\n  enabled: false\n`,
				);

				// Save and change cwd to the git repo
				process.chdir(gitRepoDir);

				await primeCommand({});
				const out = output();

				expect(out).toContain("# Overstory Context");

				// Verify session-branch.txt was written
				const sessionBranchPath = join(overstoryDir, "session-branch.txt");
				const content = await Bun.file(sessionBranchPath).text();
				expect(content.trim()).toBe("main");
			} finally {
				process.chdir(originalCwd);
				await cleanupTempDir(gitRepoDir);
			}
		});

		test("shows session branch in context when different from canonical", async () => {
			const gitRepoDir = await createTempGitRepo();
			try {
				// Create and switch to a feature branch
				const proc = Bun.spawn(["git", "checkout", "-b", "feature/my-work"], {
					cwd: gitRepoDir,
					stdout: "pipe",
					stderr: "pipe",
				});
				await proc.exited;

				const overstoryDir = join(gitRepoDir, ".overstory");
				await mkdir(overstoryDir, { recursive: true });
				await Bun.write(
					join(overstoryDir, "config.yaml"),
					`project:\n  name: branch-test\n  root: ${gitRepoDir}\n  canonicalBranch: main\nmulch:\n  enabled: false\n`,
				);

				process.chdir(gitRepoDir);

				await primeCommand({});
				const out = output();

				expect(out).toContain("Session branch: feature/my-work (merge target)");

				// Verify session-branch.txt was written with the feature branch
				const sessionBranchPath = join(overstoryDir, "session-branch.txt");
				const content = await Bun.file(sessionBranchPath).text();
				expect(content.trim()).toBe("feature/my-work");
			} finally {
				process.chdir(originalCwd);
				await cleanupTempDir(gitRepoDir);
			}
		});
	});

	describe("Gitignore auto-heal", () => {
		const expectedGitignore = `# Wildcard+whitelist: ignore everything, whitelist tracked files
# Auto-healed by ov prime on each session start
*
!.gitignore
!config.yaml
!agent-manifest.json
!hooks.json
!groups.json
!agent-defs/
!agent-defs/**
!README.md
`;

		test("creates .overstory/.gitignore if missing", async () => {
			// The beforeEach creates .overstory/config.yaml but not .gitignore
			const gitignorePath = join(tempDir, ".overstory", ".gitignore");

			// Verify it doesn't exist
			const existsBefore = await Bun.file(gitignorePath).exists();
			expect(existsBefore).toBe(false);

			// Run primeCommand
			await primeCommand({});

			// Verify .gitignore was created with correct content
			const content = await Bun.file(gitignorePath).text();
			expect(content).toBe(expectedGitignore);
		});

		test("overwrites stale .overstory/.gitignore with current template", async () => {
			// Write an old-style deny-list gitignore
			const gitignorePath = join(tempDir, ".overstory", ".gitignore");
			const staleContent = `# Old deny-list format
worktrees/
logs/
mail.db
sessions.db
`;
			await Bun.write(gitignorePath, staleContent);

			// Verify stale content is present
			const contentBefore = await Bun.file(gitignorePath).text();
			expect(contentBefore).toBe(staleContent);

			// Run primeCommand
			await primeCommand({});

			// Verify .gitignore now has the wildcard+whitelist content
			const contentAfter = await Bun.file(gitignorePath).text();
			expect(contentAfter).toBe(expectedGitignore);
		});

		test("does not overwrite .overstory/.gitignore if already correct", async () => {
			// Write the correct OVERSTORY_GITIGNORE content
			const gitignorePath = join(tempDir, ".overstory", ".gitignore");
			await Bun.write(gitignorePath, expectedGitignore);

			// Get file stat before
			const statBefore = await Bun.file(gitignorePath).stat();
			const mtimeBefore = statBefore?.mtime;

			// Wait a tiny bit to ensure mtime would change if file is rewritten
			await new Promise((resolve) => setTimeout(resolve, 10));

			// Run primeCommand
			await primeCommand({});

			// Verify content is still correct
			const contentAfter = await Bun.file(gitignorePath).text();
			expect(contentAfter).toBe(expectedGitignore);

			// Verify mtime is unchanged (file was not rewritten)
			const statAfter = await Bun.file(gitignorePath).stat();
			const mtimeAfter = statAfter?.mtime;
			expect(mtimeAfter).toEqual(mtimeBefore);
		});
	});
});

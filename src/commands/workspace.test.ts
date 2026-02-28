import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSessionStore } from "../sessions/compat.ts";
import { cleanupTempDir, createTempGitRepo } from "../test-helpers.ts";
import type { AgentSession } from "../types.ts";
import { WORKSPACE_CONFIG_FILENAME, WORKSPACE_DIR } from "../workspace/config.ts";
import {
	createWorkspaceCommand,
	serializeWorkspaceYaml,
	startWorkspace,
	type WorkspaceDeps,
	workspaceAddCommand,
	workspaceInitCommand,
	workspaceListCommand,
	workspaceRemoveCommand,
	workspaceStatusCommand,
} from "./workspace.ts";

// === Test state ===

let tmpDirs: string[] = [];
let originalCwd: string;

beforeEach(() => {
	tmpDirs = [];
	originalCwd = process.cwd();
});

afterEach(async () => {
	process.chdir(originalCwd);
	await Promise.all(tmpDirs.map((d) => cleanupTempDir(d)));
	tmpDirs = [];
});

// === Helpers ===

async function makeTempDir(): Promise<string> {
	const d = await mkdtemp(join(tmpdir(), "ov-ws-cmd-test-"));
	tmpDirs.push(d);
	return d;
}

async function makeTempGitRepo(): Promise<string> {
	const d = await createTempGitRepo();
	tmpDirs.push(d);
	return d;
}

/** Create a workspace dir with a yaml config at root. */
async function setupWorkspace(root: string, yaml?: string): Promise<void> {
	await mkdir(join(root, WORKSPACE_DIR), { recursive: true });
	const content = yaml ?? serializeWorkspaceYaml(basename(root), []);
	await writeFile(join(root, WORKSPACE_DIR, WORKSPACE_CONFIG_FILENAME), content, "utf8");
}

function basename(p: string): string {
	return p.split("/").filter(Boolean).pop() ?? p;
}

// === serializeWorkspaceYaml ===

describe("serializeWorkspaceYaml", () => {
	it("produces projects: [] for empty projects array", () => {
		const yaml = serializeWorkspaceYaml("my-ws", []);
		expect(yaml).toContain("name: my-ws");
		expect(yaml).toContain("projects: []");
	});

	it("serializes projects correctly", () => {
		const yaml = serializeWorkspaceYaml("my-ws", [
			{ name: "frontend", root: "/home/user/frontend", canonicalBranch: "main" },
		]);
		expect(yaml).toContain("name: my-ws");
		expect(yaml).toContain("  - name: frontend");
		expect(yaml).toContain("    root: /home/user/frontend");
		expect(yaml).toContain("    canonicalBranch: main");
	});
});

// === workspaceInitCommand ===

describe("workspaceInitCommand", () => {
	it("creates directory structure and workspace.yaml", async () => {
		const dir = await makeTempDir();
		process.chdir(dir);

		await workspaceInitCommand({ name: "test-workspace" });

		const { existsSync } = await import("node:fs");
		expect(existsSync(join(dir, WORKSPACE_DIR))).toBe(true);
		expect(existsSync(join(dir, WORKSPACE_DIR, "agents"))).toBe(true);
		expect(existsSync(join(dir, WORKSPACE_DIR, "agent-defs"))).toBe(true);
		expect(existsSync(join(dir, WORKSPACE_DIR, "pending-nudges"))).toBe(true);
		expect(existsSync(join(dir, WORKSPACE_DIR, WORKSPACE_CONFIG_FILENAME))).toBe(true);
		expect(existsSync(join(dir, WORKSPACE_DIR, ".gitignore"))).toBe(true);
	});

	it("uses --name option for workspace name", async () => {
		const dir = await makeTempDir();
		process.chdir(dir);

		await workspaceInitCommand({ name: "custom-name" });

		const content = await Bun.file(join(dir, WORKSPACE_DIR, WORKSPACE_CONFIG_FILENAME)).text();
		expect(content).toContain("name: custom-name");
	});

	it("defaults workspace name to directory basename", async () => {
		const dir = await makeTempDir();
		process.chdir(dir);

		await workspaceInitCommand({});

		const content = await Bun.file(join(dir, WORKSPACE_DIR, WORKSPACE_CONFIG_FILENAME)).text();
		// Should use the basename of the temp dir
		const dirBasename = dir.split("/").filter(Boolean).pop() ?? "";
		expect(content).toContain(`name: ${dirBasename}`);
	});

	it("writes projects: [] in workspace.yaml skeleton", async () => {
		const dir = await makeTempDir();
		process.chdir(dir);

		await workspaceInitCommand({ name: "my-ws" });

		const content = await Bun.file(join(dir, WORKSPACE_DIR, WORKSPACE_CONFIG_FILENAME)).text();
		expect(content).toContain("projects: []");
	});

	it("warns and returns without error if workspace already exists", async () => {
		const dir = await makeTempDir();
		process.chdir(dir);

		await workspaceInitCommand({ name: "my-ws" });
		// Second call should not throw
		await expect(workspaceInitCommand({ name: "my-ws" })).resolves.toBeUndefined();

		// Directory should still be there
		const { existsSync } = await import("node:fs");
		expect(existsSync(join(dir, WORKSPACE_DIR))).toBe(true);
	});
});

// === workspaceAddCommand ===

describe("workspaceAddCommand", () => {
	it("adds a project with .git and .overstory", async () => {
		const wsDir = await makeTempDir();
		const repo = await makeTempGitRepo();

		// Create .overstory in the repo
		await mkdir(join(repo, ".overstory"), { recursive: true });

		await setupWorkspace(wsDir);
		process.chdir(wsDir);

		await workspaceAddCommand(repo, { name: "my-project" });

		const content = await Bun.file(join(wsDir, WORKSPACE_DIR, WORKSPACE_CONFIG_FILENAME)).text();
		expect(content).toContain("name: my-project");
		expect(content).toContain(`root: ${repo}`);
	});

	it("auto-detects name from basename when --name not provided", async () => {
		const wsDir = await makeTempDir();
		const repo = await makeTempGitRepo();

		await mkdir(join(repo, ".overstory"), { recursive: true });
		await setupWorkspace(wsDir);
		process.chdir(wsDir);

		await workspaceAddCommand(repo, {});

		const content = await Bun.file(join(wsDir, WORKSPACE_DIR, WORKSPACE_CONFIG_FILENAME)).text();
		const repoBasename = repo.split("/").filter(Boolean).pop() ?? "";
		expect(content).toContain(`name: ${repoBasename}`);
	});

	it("errors when path has no .git", async () => {
		const wsDir = await makeTempDir();
		const notGit = await makeTempDir();

		await setupWorkspace(wsDir);
		process.chdir(wsDir);

		await expect(workspaceAddCommand(notGit, { name: "proj" })).rejects.toThrow(
			/not a git repository/,
		);
	});

	it("errors when path has no .overstory", async () => {
		const wsDir = await makeTempDir();
		const repo = await makeTempGitRepo();

		// repo has .git but no .overstory
		await setupWorkspace(wsDir);
		process.chdir(wsDir);

		await expect(workspaceAddCommand(repo, { name: "proj" })).rejects.toThrow(
			/Run ov init there first/,
		);
	});

	it("errors on duplicate project name", async () => {
		const wsDir = await makeTempDir();
		const repo1 = await makeTempGitRepo();
		const repo2 = await makeTempGitRepo();

		await mkdir(join(repo1, ".overstory"), { recursive: true });
		await mkdir(join(repo2, ".overstory"), { recursive: true });

		// Set up workspace with repo1 already added
		await setupWorkspace(
			wsDir,
			serializeWorkspaceYaml("test-ws", [
				{ name: "same-name", root: repo1, canonicalBranch: "main" },
			]),
		);
		process.chdir(wsDir);

		await expect(workspaceAddCommand(repo2, { name: "same-name" })).rejects.toThrow(
			/Duplicate project name/,
		);
	});

	it("errors on duplicate project root", async () => {
		const wsDir = await makeTempDir();
		const repo = await makeTempGitRepo();

		await mkdir(join(repo, ".overstory"), { recursive: true });

		// Set up workspace with repo already added
		await setupWorkspace(
			wsDir,
			serializeWorkspaceYaml("test-ws", [
				{ name: "existing", root: repo, canonicalBranch: "main" },
			]),
		);
		process.chdir(wsDir);

		await expect(workspaceAddCommand(repo, { name: "different-name" })).rejects.toThrow(
			/already registered/,
		);
	});
});

// === workspaceRemoveCommand ===

describe("workspaceRemoveCommand", () => {
	it("removes an existing project by name", async () => {
		const wsDir = await makeTempDir();
		const repo = await makeTempGitRepo();

		await setupWorkspace(
			wsDir,
			serializeWorkspaceYaml("test-ws", [
				{ name: "my-project", root: repo, canonicalBranch: "main" },
			]),
		);
		process.chdir(wsDir);

		await workspaceRemoveCommand("my-project");

		const content = await Bun.file(join(wsDir, WORKSPACE_DIR, WORKSPACE_CONFIG_FILENAME)).text();
		expect(content).not.toContain("my-project");
		expect(content).toContain("projects: []");
	});

	it("errors on unknown project name", async () => {
		const wsDir = await makeTempDir();
		const repo = await makeTempGitRepo();

		await setupWorkspace(
			wsDir,
			serializeWorkspaceYaml("test-ws", [
				{ name: "real-project", root: repo, canonicalBranch: "main" },
			]),
		);
		process.chdir(wsDir);

		await expect(workspaceRemoveCommand("nonexistent")).rejects.toThrow(/Project not found/);
	});

	it("handles removal of last project (writes projects: [])", async () => {
		const wsDir = await makeTempDir();
		const repo = await makeTempGitRepo();

		await setupWorkspace(
			wsDir,
			serializeWorkspaceYaml("test-ws", [
				{ name: "only-project", root: repo, canonicalBranch: "main" },
			]),
		);
		process.chdir(wsDir);

		await workspaceRemoveCommand("only-project");

		const content = await Bun.file(join(wsDir, WORKSPACE_DIR, WORKSPACE_CONFIG_FILENAME)).text();
		expect(content).toContain("projects: []");
	});
});

// === workspaceListCommand ===

describe("workspaceListCommand", () => {
	it("lists registered projects", async () => {
		const wsDir = await makeTempDir();
		const repo = await makeTempGitRepo();

		await setupWorkspace(
			wsDir,
			serializeWorkspaceYaml("test-ws", [
				{ name: "my-project", root: repo, canonicalBranch: "main" },
			]),
		);
		process.chdir(wsDir);

		// Capture stdout
		const lines: string[] = [];
		const orig = process.stdout.write.bind(process.stdout);
		process.stdout.write = (s: string) => {
			lines.push(s);
			return true;
		};

		try {
			await workspaceListCommand();
		} finally {
			process.stdout.write = orig;
		}

		const output = lines.join("");
		expect(output).toContain("my-project");
		expect(output).toContain(repo);
	});

	it("handles empty projects gracefully", async () => {
		const wsDir = await makeTempDir();
		await setupWorkspace(wsDir, serializeWorkspaceYaml("test-ws", []));
		process.chdir(wsDir);

		const lines: string[] = [];
		const orig = process.stdout.write.bind(process.stdout);
		process.stdout.write = (s: string) => {
			lines.push(s);
			return true;
		};

		try {
			await workspaceListCommand();
		} finally {
			process.stdout.write = orig;
		}

		const output = lines.join("");
		expect(output).toContain("No projects registered");
	});
});

// === workspaceStatusCommand ===

describe("workspaceStatusCommand", () => {
	it("shows human-readable status", async () => {
		const wsDir = await makeTempDir();
		const repo = await makeTempGitRepo();

		await setupWorkspace(
			wsDir,
			serializeWorkspaceYaml("test-ws", [
				{ name: "my-project", root: repo, canonicalBranch: "main" },
			]),
		);
		process.chdir(wsDir);

		const lines: string[] = [];
		const orig = process.stdout.write.bind(process.stdout);
		process.stdout.write = (s: string) => {
			lines.push(s);
			return true;
		};

		try {
			await workspaceStatusCommand({});
		} finally {
			process.stdout.write = orig;
		}

		const output = lines.join("");
		expect(output).toContain("Workspace: test-ws");
		expect(output).toContain("my-project");
	});

	it("outputs JSON when --json flag is set", async () => {
		const wsDir = await makeTempDir();
		const repo = await makeTempGitRepo();

		await setupWorkspace(
			wsDir,
			serializeWorkspaceYaml("test-ws", [
				{ name: "my-project", root: repo, canonicalBranch: "main" },
			]),
		);
		process.chdir(wsDir);

		const lines: string[] = [];
		const orig = process.stdout.write.bind(process.stdout);
		process.stdout.write = (s: string) => {
			lines.push(s);
			return true;
		};

		try {
			await workspaceStatusCommand({ json: true });
		} finally {
			process.stdout.write = orig;
		}

		const output = lines.join("");
		const parsed = JSON.parse(output) as {
			workspace: string;
			projects: Array<{ name: string }>;
		};
		expect(parsed.workspace).toBe("test-ws");
		expect(parsed.projects).toHaveLength(1);
		expect(parsed.projects[0]?.name).toBe("my-project");
	});

	it("handles empty projects gracefully", async () => {
		const wsDir = await makeTempDir();
		await setupWorkspace(wsDir, serializeWorkspaceYaml("test-ws", []));
		process.chdir(wsDir);

		const lines: string[] = [];
		const orig = process.stdout.write.bind(process.stdout);
		process.stdout.write = (s: string) => {
			lines.push(s);
			return true;
		};

		try {
			await workspaceStatusCommand({});
		} finally {
			process.stdout.write = orig;
		}

		const output = lines.join("");
		expect(output).toContain("Workspace: test-ws");
		expect(output).toContain("(no projects registered)");
	});

	it("JSON output includes empty projects array when none registered", async () => {
		const wsDir = await makeTempDir();
		await setupWorkspace(wsDir, serializeWorkspaceYaml("empty-ws", []));
		process.chdir(wsDir);

		const lines: string[] = [];
		const orig = process.stdout.write.bind(process.stdout);
		process.stdout.write = (s: string) => {
			lines.push(s);
			return true;
		};

		try {
			await workspaceStatusCommand({ json: true });
		} finally {
			process.stdout.write = orig;
		}

		const output = lines.join("");
		const parsed = JSON.parse(output) as { projects: unknown[] };
		expect(parsed.projects).toHaveLength(0);
	});
});

// === workspaceRemoveCommand (C4 — active session guard) ===

describe("workspaceRemoveCommand active session guard", () => {
	it("throws ValidationError when project has active sessions", async () => {
		const wsDir = await makeTempDir();
		const repo = await makeTempGitRepo();

		await setupWorkspace(
			wsDir,
			serializeWorkspaceYaml("test-ws", [
				{ name: "active-project", root: repo, canonicalBranch: "main" },
			]),
		);
		process.chdir(wsDir);

		// Seed an active session into the shared workspace session store.
		// In workspace mode, all sessions live in .overstory-workspace/, not
		// in each project's local .overstory/. Pass the project name as the
		// second arg to upsert() so it is stored with the correct project_id.
		const { store } = openSessionStore(join(wsDir, WORKSPACE_DIR));
		try {
				const activeSession: AgentSession = {
				id: "session-123-builder",
				agentName: "builder",
				capability: "builder",
				worktreePath: join(repo, ".overstory", "worktrees", "builder"),
				branchName: "overstory/builder/task-1",
				taskId: "task-1",
				tmuxSession: "overstory-builder",
				state: "working",
				pid: 12345,
				parentAgent: null,
				depth: 1,
				runId: null,
				projectId: "active-project",
				startedAt: new Date().toISOString(),
				lastActivity: new Date().toISOString(),
					escalationLevel: 0,
					stalledSince: null,
					transcriptPath: null,
				};
			store.upsert(activeSession, "active-project");
		} finally {
			store.close();
		}

		await expect(workspaceRemoveCommand("active-project")).rejects.toThrow(
			/Cannot remove project "active-project": 1 active agent\(s\)/,
		);
	});

	it("succeeds when project has only completed/zombie sessions", async () => {
		const wsDir = await makeTempDir();
		const repo = await makeTempGitRepo();

		await setupWorkspace(
			wsDir,
			serializeWorkspaceYaml("test-ws", [
				{ name: "done-project", root: repo, canonicalBranch: "main" },
			]),
		);
		process.chdir(wsDir);

		// Seed a completed session into the shared workspace session store
		const { store } = openSessionStore(join(wsDir, WORKSPACE_DIR));
		try {
				const completedSession: AgentSession = {
				id: "session-1-builder",
				agentName: "builder",
				capability: "builder",
				worktreePath: join(repo, ".overstory", "worktrees", "builder"),
				branchName: "overstory/builder/task-1",
				taskId: "task-1",
				tmuxSession: "overstory-builder",
				state: "completed",
				pid: 11111,
				parentAgent: null,
				depth: 1,
				runId: null,
				projectId: "done-project",
				startedAt: new Date().toISOString(),
				lastActivity: new Date().toISOString(),
					escalationLevel: 0,
					stalledSince: null,
					transcriptPath: null,
				};
			store.upsert(completedSession, "done-project");
		} finally {
			store.close();
		}

		// Should succeed — no active agents
		await expect(workspaceRemoveCommand("done-project")).resolves.toBeUndefined();

		// Config should no longer contain the project
		const content = await Bun.file(join(wsDir, WORKSPACE_DIR, WORKSPACE_CONFIG_FILENAME)).text();
		expect(content).not.toContain("done-project");
	});
});

// === workspaceInitCommand — mail-check-state.json (H5) ===

describe("workspaceInitCommand mail-check-state.json", () => {
	it("creates mail-check-state.json in workspace dir", async () => {
		const dir = await makeTempDir();
		process.chdir(dir);

		await workspaceInitCommand({ name: "mail-check-ws" });

		const { existsSync } = await import("node:fs");
		expect(existsSync(join(dir, WORKSPACE_DIR, "mail-check-state.json"))).toBe(true);

		const content = await Bun.file(join(dir, WORKSPACE_DIR, "mail-check-state.json")).text();
		expect(content).toBe("{}");
	});
});

// === BUG 1: workspace status --json — Commander integration ===

describe("Commander integration — workspace status --json", () => {
	it("workspace status --json produces valid JSON via parseAsync", async () => {
		const wsDir = await makeTempDir();
		const repo = await makeTempGitRepo();

		await setupWorkspace(
			wsDir,
			serializeWorkspaceYaml("cmd-test-ws", [
				{ name: "proj", root: repo, canonicalBranch: "main" },
			]),
		);
		process.chdir(wsDir);

		const lines: string[] = [];
		const orig = process.stdout.write.bind(process.stdout);
		process.stdout.write = (s: string) => {
			lines.push(s);
			return true;
		};

		try {
			const cmd = createWorkspaceCommand();
			// Prevent Commander from calling process.exit on errors
			cmd.exitOverride();
			await cmd.parseAsync(["status", "--json"], { from: "user" });
		} finally {
			process.stdout.write = orig;
		}

		const output = lines.join("");
		const parsed = JSON.parse(output) as {
			workspace: string;
			projects: Array<{ name: string }>;
		};
		expect(parsed.workspace).toBe("cmd-test-ws");
		expect(parsed.projects).toHaveLength(1);
		expect(parsed.projects[0]?.name).toBe("proj");
	});

	it("workspace status without --json produces human text via parseAsync", async () => {
		const wsDir = await makeTempDir();
		await setupWorkspace(wsDir, serializeWorkspaceYaml("human-ws", []));
		process.chdir(wsDir);

		const lines: string[] = [];
		const orig = process.stdout.write.bind(process.stdout);
		process.stdout.write = (s: string) => {
			lines.push(s);
			return true;
		};

		try {
			const cmd = createWorkspaceCommand();
			cmd.exitOverride();
			await cmd.parseAsync(["status"], { from: "user" });
		} finally {
			process.stdout.write = orig;
		}

		const output = lines.join("");
		expect(output).toContain("Workspace: human-ws");
		expect(() => JSON.parse(output)).toThrow();
	});
});

// === BUG 2: loadConfigOrEmpty respects maxDepth/maxConcurrentTotal ===

describe("loadConfigOrEmpty maxDepth/maxConcurrentTotal for empty-projects workspace", () => {
	it("respects custom maxDepth in empty-projects workspace", async () => {
		const wsDir = await makeTempDir();
		await setupWorkspace(
			wsDir,
			`# Overstory workspace configuration\nname: depth-ws\nprojects: []\nmaxDepth: 5\n`,
		);
		process.chdir(wsDir);

		const lines: string[] = [];
		const orig = process.stdout.write.bind(process.stdout);
		process.stdout.write = (s: string) => {
			lines.push(s);
			return true;
		};

		try {
			await workspaceStatusCommand({ json: true });
		} finally {
			process.stdout.write = orig;
		}

		const parsed = JSON.parse(lines.join("")) as { maxDepth: number };
		expect(parsed.maxDepth).toBe(5);
	});

	it("respects custom maxConcurrentTotal in empty-projects workspace", async () => {
		const wsDir = await makeTempDir();
		await setupWorkspace(
			wsDir,
			`# Overstory workspace configuration\nname: concurrent-ws\nprojects: []\nmaxConcurrentTotal: 10\n`,
		);
		process.chdir(wsDir);

		const lines: string[] = [];
		const orig = process.stdout.write.bind(process.stdout);
		process.stdout.write = (s: string) => {
			lines.push(s);
			return true;
		};

		try {
			await workspaceStatusCommand({ json: true });
		} finally {
			process.stdout.write = orig;
		}

		const parsed = JSON.parse(lines.join("")) as { maxConcurrentTotal: number };
		expect(parsed.maxConcurrentTotal).toBe(10);
	});

	it("throws on maxDepth < 3 in empty-projects workspace", async () => {
		const wsDir = await makeTempDir();
		await setupWorkspace(
			wsDir,
			`# Overstory workspace configuration\nname: bad-depth-ws\nprojects: []\nmaxDepth: 2\n`,
		);
		process.chdir(wsDir);

		await expect(workspaceStatusCommand({})).rejects.toThrow(/maxDepth must be >= 3/);
	});

	it("throws on maxConcurrentTotal <= 0 in empty-projects workspace", async () => {
		const wsDir = await makeTempDir();
		await setupWorkspace(
			wsDir,
			`# Overstory workspace configuration\nname: bad-concurrent-ws\nprojects: []\nmaxConcurrentTotal: 0\n`,
		);
		process.chdir(wsDir);

		await expect(workspaceStatusCommand({})).rejects.toThrow(
			/maxConcurrentTotal must be a positive integer/,
		);
	});

	it("uses defaults (maxDepth=4, maxConcurrentTotal=25) when not specified", async () => {
		const wsDir = await makeTempDir();
		await setupWorkspace(wsDir, serializeWorkspaceYaml("default-ws", []));
		process.chdir(wsDir);

		const lines: string[] = [];
		const orig = process.stdout.write.bind(process.stdout);
		process.stdout.write = (s: string) => {
			lines.push(s);
			return true;
		};

		try {
			await workspaceStatusCommand({ json: true });
		} finally {
			process.stdout.write = orig;
		}

		const parsed = JSON.parse(lines.join("")) as {
			maxDepth: number;
			maxConcurrentTotal: number;
		};
		expect(parsed.maxDepth).toBe(4);
		expect(parsed.maxConcurrentTotal).toBe(25);
	});
});

// === BUG 3: workspace status tolerates deleted project directories ===

describe("workspaceStatusCommand — deleted project directory", () => {
	it("does not crash when project root is deleted; shows [-] marker", async () => {
		const wsDir = await makeTempDir();
		const repo = await makeTempGitRepo();

		await setupWorkspace(
			wsDir,
			serializeWorkspaceYaml("deleted-dir-ws", [
				{ name: "gone-project", root: repo, canonicalBranch: "main" },
			]),
		);
		process.chdir(wsDir);

		// Delete the repo directory to simulate a missing project
		rmSync(repo, { recursive: true, force: true });

		const lines: string[] = [];
		const orig = process.stdout.write.bind(process.stdout);
		process.stdout.write = (s: string) => {
			lines.push(s);
			return true;
		};

		try {
			// Must NOT throw
			await expect(workspaceStatusCommand({})).resolves.toBeUndefined();
		} finally {
			process.stdout.write = orig;
		}

		const output = lines.join("");
		expect(output).toContain("gone-project");
		// [-] marker: hasOverstory=false since dir doesn't exist
		expect(output).toContain("[-]");
	});

	it("status --json includes project with hasOverstory=false for deleted directory", async () => {
		const wsDir = await makeTempDir();
		const repo = await makeTempGitRepo();

		await setupWorkspace(
			wsDir,
			serializeWorkspaceYaml("deleted-json-ws", [
				{ name: "missing-proj", root: repo, canonicalBranch: "main" },
			]),
		);
		process.chdir(wsDir);

		rmSync(repo, { recursive: true, force: true });

		const lines: string[] = [];
		const orig = process.stdout.write.bind(process.stdout);
		process.stdout.write = (s: string) => {
			lines.push(s);
			return true;
		};

		try {
			await expect(workspaceStatusCommand({ json: true })).resolves.toBeUndefined();
		} finally {
			process.stdout.write = orig;
		}

		const parsed = JSON.parse(lines.join("")) as {
			projects: Array<{ name: string; hasOverstory: boolean }>;
		};
		expect(parsed.projects).toHaveLength(1);
		expect(parsed.projects[0]?.name).toBe("missing-proj");
		expect(parsed.projects[0]?.hasOverstory).toBe(false);
	});
});

// === BUG 4: workspaceInitCommand creates metrics.db ===

describe("workspaceInitCommand — metrics.db creation", () => {
	it("creates metrics.db in workspace dir", async () => {
		const dir = await makeTempDir();
		process.chdir(dir);

		await workspaceInitCommand({ name: "metrics-ws" });

		expect(existsSync(join(dir, WORKSPACE_DIR, "metrics.db"))).toBe(true);
	});
});

// === startWorkspace — overlay template rendering (H3) ===

describe("startWorkspace overlay rendering", () => {
	/** Build a fake tmux DI object. */
	function makeFakeTmux(): WorkspaceDeps["_tmux"] {
		return {
			createSession: async () => 99999,
			isSessionAlive: async () => false,
			killSession: async () => {},
			sendKeys: async () => {},
			waitForTuiReady: async () => true,
			ensureTmuxAvailable: async () => {},
		};
	}

	it("renders workspace-overlay.md.tmpl to .claude/CLAUDE.md", async () => {
		const wsDir = await makeTempDir();
		await setupWorkspace(wsDir, serializeWorkspaceYaml("overlay-test-ws", []));
		process.chdir(wsDir);

		const originalSleep = Bun.sleep;
		Bun.sleep = (() => Promise.resolve()) as typeof Bun.sleep;
		try {
			await startWorkspace({ json: false, attach: false }, { _tmux: makeFakeTmux() });
		} finally {
			Bun.sleep = originalSleep;
		}

		const { existsSync } = await import("node:fs");
		expect(existsSync(join(wsDir, ".claude", "CLAUDE.md"))).toBe(true);

		const content = await Bun.file(join(wsDir, ".claude", "CLAUDE.md")).text();
		expect(content).toContain(wsDir);
		expect(content).not.toContain("{{WORKSPACE_ROOT}}");
		expect(content).not.toContain("{{PROJECTS_LIST}}");
	});

	it("overlay contains project list when projects are registered", async () => {
		const wsDir = await makeTempDir();
		const repo = await makeTempGitRepo();

		await setupWorkspace(
			wsDir,
			serializeWorkspaceYaml("overlay-proj-ws", [
				{ name: "my-repo", root: repo, canonicalBranch: "main" },
			]),
		);
		process.chdir(wsDir);

		const originalSleep = Bun.sleep;
		Bun.sleep = (() => Promise.resolve()) as typeof Bun.sleep;
		try {
			await startWorkspace({ json: false, attach: false }, { _tmux: makeFakeTmux() });
		} finally {
			Bun.sleep = originalSleep;
		}

		const content = await Bun.file(join(wsDir, ".claude", "CLAUDE.md")).text();
		expect(content).toContain("my-repo");
		expect(content).toContain(repo);
		expect(content).toContain("main");
	});
});

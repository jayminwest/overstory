import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorktreeError } from "../errors.ts";
import {
	cleanupTempDir,
	commitFile,
	createTempGitRepo,
	getDefaultBranch,
	runGitInDir,
} from "../test-helpers.ts";
import {
	createWorktree,
	isBranchMerged,
	listWorktrees,
	removeWorktree,
	rollbackWorktree,
	validateWorktreeCreation,
} from "./manager.ts";

/**
 * Run a git command in a directory and return stdout. Throws on non-zero exit.
 */
async function git(cwd: string, args: string[]): Promise<string> {
	const proc = Bun.spawn(["git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});

	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);

	if (exitCode !== 0) {
		throw new Error(`git ${args.join(" ")} failed (exit ${exitCode}): ${stderr.trim()}`);
	}

	return stdout;
}

describe("createWorktree", () => {
	let repoDir: string;
	let worktreesDir: string;
	let defaultBranch: string;

	beforeEach(async () => {
		// realpathSync resolves macOS /var -> /private/var symlink so paths match git output
		repoDir = realpathSync(await createTempGitRepo());
		defaultBranch = await getDefaultBranch(repoDir);
		worktreesDir = join(repoDir, ".overstory", "worktrees");
		await mkdir(worktreesDir, { recursive: true });
	});

	afterEach(async () => {
		await cleanupTempDir(repoDir);
	});

	test("returns correct path and branch name", async () => {
		const result = await createWorktree({
			repoRoot: repoDir,
			baseDir: worktreesDir,
			agentName: "auth-login",
			baseBranch: defaultBranch,
			taskId: "bead-abc123",
		});

		expect(result.path).toBe(join(worktreesDir, "auth-login"));
		expect(result.branch).toBe("overstory/auth-login/bead-abc123");
	});

	test("creates worktree directory on disk", async () => {
		const result = await createWorktree({
			repoRoot: repoDir,
			baseDir: worktreesDir,
			agentName: "auth-login",
			baseBranch: defaultBranch,
			taskId: "bead-abc123",
		});

		expect(existsSync(result.path)).toBe(true);
		// The worktree should contain a .git file (not a directory, since it's a linked worktree)
		expect(existsSync(join(result.path, ".git"))).toBe(true);
	});

	test("creates the branch in the repo", async () => {
		await createWorktree({
			repoRoot: repoDir,
			baseDir: worktreesDir,
			agentName: "auth-login",
			baseBranch: defaultBranch,
			taskId: "bead-abc123",
		});

		const branchList = await git(repoDir, ["branch", "--list"]);
		expect(branchList).toContain("overstory/auth-login/bead-abc123");
	});

	test("throws WorktreeError when creating same worktree twice", async () => {
		await createWorktree({
			repoRoot: repoDir,
			baseDir: worktreesDir,
			agentName: "auth-login",
			baseBranch: defaultBranch,
			taskId: "bead-abc123",
		});

		await expect(
			createWorktree({
				repoRoot: repoDir,
				baseDir: worktreesDir,
				agentName: "auth-login",
				baseBranch: defaultBranch,
				taskId: "bead-abc123",
			}),
		).rejects.toThrow(WorktreeError);
	});

	test("WorktreeError includes worktree path and branch name", async () => {
		// Create once to occupy the branch name
		await createWorktree({
			repoRoot: repoDir,
			baseDir: worktreesDir,
			agentName: "auth-login",
			baseBranch: defaultBranch,
			taskId: "bead-abc123",
		});

		try {
			await createWorktree({
				repoRoot: repoDir,
				baseDir: worktreesDir,
				agentName: "auth-login",
				baseBranch: defaultBranch,
				taskId: "bead-abc123",
			});
			// Should not reach here
			expect(true).toBe(false);
		} catch (err: unknown) {
			expect(err).toBeInstanceOf(WorktreeError);
			const wtErr = err as WorktreeError;
			expect(wtErr.worktreePath).toBe(join(worktreesDir, "auth-login"));
			expect(wtErr.branchName).toBe("overstory/auth-login/bead-abc123");
		}
	});

	test("rejects creation when target branch is already checked out elsewhere", async () => {
		// Pre-check should fail-fast with a precise diagnostic before git
		// worktree add runs, so the operator sees the actual cause rather
		// than git's generic "already exists" error or, worse, a silently
		// half-built worktree (overstory-6878).
		const first = await createWorktree({
			repoRoot: repoDir,
			baseDir: worktreesDir,
			agentName: "auth-login",
			baseBranch: defaultBranch,
			taskId: "bead-abc123",
		});

		try {
			await createWorktree({
				repoRoot: repoDir,
				baseDir: worktreesDir,
				agentName: "auth-login",
				baseBranch: defaultBranch,
				taskId: "bead-abc123",
			});
			expect(true).toBe(false);
		} catch (err: unknown) {
			expect(err).toBeInstanceOf(WorktreeError);
			const wtErr = err as WorktreeError;
			expect(wtErr.message).toContain("already checked out");
			expect(wtErr.message).toContain(first.path);
			expect(wtErr.branchName).toBe("overstory/auth-login/bead-abc123");
		}

		// The original worktree must remain intact — the pre-check rejected
		// before any state-mutating git command ran.
		expect(existsSync(first.path)).toBe(true);
		const entries = await listWorktrees(repoDir);
		expect(entries.some((e) => e.path === first.path)).toBe(true);
	});

	test("post-creation: new worktree is registered and contains tracked files", async () => {
		const { path: wtPath } = await createWorktree({
			repoRoot: repoDir,
			baseDir: worktreesDir,
			agentName: "auth-login",
			baseBranch: defaultBranch,
			taskId: "bead-files",
		});

		// Registration check — listWorktrees must include the new path
		const entries = await listWorktrees(repoDir);
		expect(entries.map((e) => e.path)).toContain(wtPath);

		// File-presence check — git ls-files inside the worktree must be non-empty
		const lsFiles = await git(wtPath, ["ls-files"]);
		expect(lsFiles.trim().length).toBeGreaterThan(0);
	});
});

describe("listWorktrees", () => {
	let repoDir: string;
	let worktreesDir: string;
	let defaultBranch: string;

	beforeEach(async () => {
		repoDir = realpathSync(await createTempGitRepo());
		defaultBranch = await getDefaultBranch(repoDir);
		worktreesDir = join(repoDir, ".overstory", "worktrees");
		await mkdir(worktreesDir, { recursive: true });
	});

	afterEach(async () => {
		await cleanupTempDir(repoDir);
	});

	test("lists main worktree when no additional worktrees exist", async () => {
		const entries = await listWorktrees(repoDir);

		expect(entries.length).toBeGreaterThanOrEqual(1);
		// The first entry should be the main repo
		const mainEntry = entries[0];
		expect(mainEntry?.path).toBe(repoDir);
		expect(mainEntry?.branch).toMatch(/^(main|master)$/);
		expect(mainEntry?.head).toMatch(/^[a-f0-9]{40}$/);
	});

	test("lists multiple worktrees after creation", async () => {
		await createWorktree({
			repoRoot: repoDir,
			baseDir: worktreesDir,
			agentName: "auth-login",
			baseBranch: defaultBranch,
			taskId: "bead-abc",
		});

		await createWorktree({
			repoRoot: repoDir,
			baseDir: worktreesDir,
			agentName: "data-sync",
			baseBranch: defaultBranch,
			taskId: "bead-xyz",
		});

		const entries = await listWorktrees(repoDir);

		// Main worktree + 2 created = 3
		expect(entries).toHaveLength(3);

		const paths = entries.map((e) => e.path);
		expect(paths).toContain(repoDir);
		expect(paths).toContain(join(worktreesDir, "auth-login"));
		expect(paths).toContain(join(worktreesDir, "data-sync"));

		const branches = entries.map((e) => e.branch);
		expect(branches).toContain("overstory/auth-login/bead-abc");
		expect(branches).toContain("overstory/data-sync/bead-xyz");
	});

	test("strips refs/heads/ prefix from branch names", async () => {
		await createWorktree({
			repoRoot: repoDir,
			baseDir: worktreesDir,
			agentName: "feature-worker",
			baseBranch: defaultBranch,
			taskId: "bead-123",
		});

		const entries = await listWorktrees(repoDir);
		const worktreeEntry = entries.find((e) => e.path === join(worktreesDir, "feature-worker"));

		expect(worktreeEntry?.branch).toBe("overstory/feature-worker/bead-123");
		// Ensure no refs/heads/ prefix leaked through
		expect(worktreeEntry?.branch).not.toContain("refs/heads/");
	});

	test("each entry has a valid HEAD commit hash", async () => {
		await createWorktree({
			repoRoot: repoDir,
			baseDir: worktreesDir,
			agentName: "auth-login",
			baseBranch: defaultBranch,
			taskId: "bead-abc",
		});

		const entries = await listWorktrees(repoDir);

		for (const entry of entries) {
			expect(entry.head).toMatch(/^[a-f0-9]{40}$/);
		}
	});

	test("throws WorktreeError for non-git directory", async () => {
		// Use a separate temp dir outside the git repo so git won't find a parent .git
		const tmpDir = realpathSync(await mkdtemp(join(tmpdir(), "overstory-notgit-")));
		try {
			await expect(listWorktrees(tmpDir)).rejects.toThrow(WorktreeError);
		} finally {
			await cleanupTempDir(tmpDir);
		}
	});
});

describe("isBranchMerged", () => {
	let repoDir: string;
	let worktreesDir: string;
	let defaultBranch: string;

	beforeEach(async () => {
		repoDir = realpathSync(await createTempGitRepo());
		defaultBranch = await getDefaultBranch(repoDir);
		worktreesDir = join(repoDir, ".overstory", "worktrees");
		await mkdir(worktreesDir, { recursive: true });
	});

	afterEach(async () => {
		await cleanupTempDir(repoDir);
	});

	test("returns true for a branch that has been merged via git merge", async () => {
		const { path: wtPath, branch } = await createWorktree({
			repoRoot: repoDir,
			baseDir: worktreesDir,
			agentName: "feature-agent",
			baseBranch: defaultBranch,
			taskId: "bead-merged",
		});

		// Add a commit to the feature branch
		await commitFile(wtPath, "feature.ts", "export const x = 1;", "add feature");

		// Merge the feature branch into defaultBranch
		await git(repoDir, ["merge", "--no-ff", branch, "-m", "merge feature"]);

		const merged = await isBranchMerged(repoDir, branch, defaultBranch);
		expect(merged).toBe(true);
	});

	test("returns false for a branch with unmerged commits", async () => {
		const { path: wtPath, branch } = await createWorktree({
			repoRoot: repoDir,
			baseDir: worktreesDir,
			agentName: "feature-agent",
			baseBranch: defaultBranch,
			taskId: "bead-unmerged",
		});

		// Add a commit to the feature branch (not merged)
		await commitFile(wtPath, "feature.ts", "export const x = 1;", "add feature");

		const merged = await isBranchMerged(repoDir, branch, defaultBranch);
		expect(merged).toBe(false);
	});

	test("returns true for an identical branch (same commit, no additional commits)", async () => {
		// A freshly created worktree branch has the same HEAD as the base branch
		const { branch } = await createWorktree({
			repoRoot: repoDir,
			baseDir: worktreesDir,
			agentName: "feature-agent",
			baseBranch: defaultBranch,
			taskId: "bead-same",
		});

		// The branch was created from defaultBranch with no additional commits,
		// so its tip is an ancestor of (equal to) defaultBranch
		const merged = await isBranchMerged(repoDir, branch, defaultBranch);
		expect(merged).toBe(true);
	});
});

describe("removeWorktree", () => {
	let repoDir: string;
	let worktreesDir: string;
	let defaultBranch: string;

	beforeEach(async () => {
		repoDir = realpathSync(await createTempGitRepo());
		defaultBranch = await getDefaultBranch(repoDir);
		worktreesDir = join(repoDir, ".overstory", "worktrees");
		await mkdir(worktreesDir, { recursive: true });
	});

	afterEach(async () => {
		await cleanupTempDir(repoDir);
	});

	test("removes worktree directory from disk", async () => {
		const { path: wtPath } = await createWorktree({
			repoRoot: repoDir,
			baseDir: worktreesDir,
			agentName: "auth-login",
			baseBranch: defaultBranch,
			taskId: "bead-abc",
		});

		expect(existsSync(wtPath)).toBe(true);

		await removeWorktree(repoDir, wtPath);

		expect(existsSync(wtPath)).toBe(false);
	});

	test("deletes the associated branch after removal", async () => {
		const { path: wtPath } = await createWorktree({
			repoRoot: repoDir,
			baseDir: worktreesDir,
			agentName: "auth-login",
			baseBranch: defaultBranch,
			taskId: "bead-abc",
		});

		await removeWorktree(repoDir, wtPath);

		const branchList = await git(repoDir, ["branch", "--list"]);
		expect(branchList).not.toContain("overstory/auth-login/bead-abc");
	});

	test("worktree no longer appears in listWorktrees after removal", async () => {
		const { path: wtPath } = await createWorktree({
			repoRoot: repoDir,
			baseDir: worktreesDir,
			agentName: "auth-login",
			baseBranch: defaultBranch,
			taskId: "bead-abc",
		});

		await removeWorktree(repoDir, wtPath);

		const entries = await listWorktrees(repoDir);
		const paths = entries.map((e) => e.path);
		expect(paths).not.toContain(wtPath);
	});

	test("force flag removes worktree with uncommitted changes", async () => {
		const { path: wtPath } = await createWorktree({
			repoRoot: repoDir,
			baseDir: worktreesDir,
			agentName: "auth-login",
			baseBranch: defaultBranch,
			taskId: "bead-abc",
		});

		// Create an untracked file in the worktree
		await Bun.write(join(wtPath, "untracked.txt"), "some content");

		// Without force, git worktree remove may fail on dirty worktrees.
		// With force, it should succeed.
		await removeWorktree(repoDir, wtPath, { force: true, forceBranch: true });

		expect(existsSync(wtPath)).toBe(false);
	});

	test("forceBranch deletes unmerged branch", async () => {
		const { path: wtPath } = await createWorktree({
			repoRoot: repoDir,
			baseDir: worktreesDir,
			agentName: "auth-login",
			baseBranch: defaultBranch,
			taskId: "bead-abc",
		});

		// Add a commit in the worktree so the branch diverges (making it "unmerged")
		await commitFile(wtPath, "new-file.ts", "export const x = 1;", "add new file");

		// forceBranch uses -D instead of -d, so even unmerged branches get deleted
		await removeWorktree(repoDir, wtPath, { force: true, forceBranch: true });

		const branchList = await git(repoDir, ["branch", "--list"]);
		expect(branchList).not.toContain("overstory/auth-login/bead-abc");
	});

	test("without forceBranch, unmerged branch deletion is silently ignored", async () => {
		const { path: wtPath } = await createWorktree({
			repoRoot: repoDir,
			baseDir: worktreesDir,
			agentName: "auth-login",
			baseBranch: defaultBranch,
			taskId: "bead-abc",
		});

		// Add a commit to make the branch unmerged
		await commitFile(wtPath, "new-file.ts", "export const x = 1;", "add new file");

		// Without forceBranch, branch -d will fail because it's not merged, but
		// removeWorktree should not throw (it catches the error)
		await removeWorktree(repoDir, wtPath, { force: true });

		// Worktree is gone
		expect(existsSync(wtPath)).toBe(false);

		// But branch still exists because -d failed silently
		const branchList = await git(repoDir, ["branch", "--list"]);
		expect(branchList).toContain("overstory/auth-login/bead-abc");
	});
});

describe("rollbackWorktree", () => {
	let repoDir: string;
	let worktreesDir: string;
	let defaultBranch: string;

	beforeEach(async () => {
		repoDir = realpathSync(await createTempGitRepo());
		defaultBranch = await getDefaultBranch(repoDir);
		worktreesDir = join(repoDir, ".overstory", "worktrees");
		await mkdir(worktreesDir, { recursive: true });
	});

	afterEach(async () => {
		await cleanupTempDir(repoDir);
	});

	test("removes worktree directory and branch", async () => {
		const { path: wtPath, branch } = await createWorktree({
			repoRoot: repoDir,
			baseDir: worktreesDir,
			agentName: "auth-login",
			baseBranch: defaultBranch,
			taskId: "bead-abc",
		});

		expect(existsSync(wtPath)).toBe(true);

		await rollbackWorktree(repoDir, wtPath, branch);

		expect(existsSync(wtPath)).toBe(false);
		const branchList = await git(repoDir, ["branch", "--list"]);
		expect(branchList).not.toContain("overstory/auth-login/bead-abc");
	});

	test("does not throw for a non-existent worktree path", async () => {
		const fakePath = join(worktreesDir, "does-not-exist");
		await expect(rollbackWorktree(repoDir, fakePath, "")).resolves.toBeUndefined();
	});

	test("skips branch deletion when branchName is empty", async () => {
		const { path: wtPath } = await createWorktree({
			repoRoot: repoDir,
			baseDir: worktreesDir,
			agentName: "auth-login",
			baseBranch: defaultBranch,
			taskId: "bead-abc",
		});

		// Pass empty branch — should not throw and worktree should still be removed
		await rollbackWorktree(repoDir, wtPath, "");

		expect(existsSync(wtPath)).toBe(false);
		// Branch still exists (we didn't delete it)
		const branchList = await git(repoDir, ["branch", "--list"]);
		expect(branchList).toContain("overstory/auth-login/bead-abc");
	});
});

describe("validateWorktreeCreation", () => {
	let repoDir: string;
	let worktreesDir: string;
	let defaultBranch: string;

	beforeEach(async () => {
		repoDir = realpathSync(await createTempGitRepo());
		defaultBranch = await getDefaultBranch(repoDir);
		worktreesDir = join(repoDir, ".overstory", "worktrees");
		await mkdir(worktreesDir, { recursive: true });
	});

	afterEach(async () => {
		await cleanupTempDir(repoDir);
	});

	test("passes for a normally created worktree", async () => {
		const { path: wtPath, branch } = await createWorktree({
			repoRoot: repoDir,
			baseDir: worktreesDir,
			agentName: "feature-agent",
			baseBranch: defaultBranch,
			taskId: "bead-ok",
		});

		// Re-running validation against the live worktree should be a no-op
		await expect(
			validateWorktreeCreation({
				repoRoot: repoDir,
				worktreePath: wtPath,
				branchName: branch,
			}),
		).resolves.toBeUndefined();
	});

	test("throws when worktree path is not registered with git", async () => {
		const fakePath = join(worktreesDir, "ghost-agent");

		try {
			await validateWorktreeCreation({
				repoRoot: repoDir,
				worktreePath: fakePath,
				branchName: "overstory/ghost-agent/bead-missing",
			});
			expect(true).toBe(false);
		} catch (err: unknown) {
			expect(err).toBeInstanceOf(WorktreeError);
			const wtErr = err as WorktreeError;
			expect(wtErr.worktreePath).toBe(fakePath);
			expect(wtErr.branchName).toBe("overstory/ghost-agent/bead-missing");
			expect(wtErr.message).toContain("not registered with git");
		}
	});

	test("rolls back the dangling branch when validation fails", async () => {
		// Create a real branch that's not attached to any worktree, then ask
		// validation to check a path it can't possibly be registered at.
		await runGitInDir(repoDir, ["branch", "overstory/orphan-agent/bead-x", defaultBranch]);
		const fakePath = join(worktreesDir, "orphan-agent");

		await expect(
			validateWorktreeCreation({
				repoRoot: repoDir,
				worktreePath: fakePath,
				branchName: "overstory/orphan-agent/bead-x",
			}),
		).rejects.toThrow(WorktreeError);

		// rollbackWorktree should have force-deleted the orphan branch
		const branchList = await git(repoDir, ["branch", "--list"]);
		expect(branchList).not.toContain("overstory/orphan-agent/bead-x");
	});

	test("throws when worktree contains zero tracked files", async () => {
		// Build a base branch that points at an empty tree, then create a
		// worktree from it. git happily registers the worktree, but ls-files
		// returns nothing — the exact silent-failure shape from overstory-6878.
		const emptyTree = (
			await runGitInDir(repoDir, ["hash-object", "-t", "tree", "/dev/null"])
		).trim();
		const emptyCommit = (
			await runGitInDir(repoDir, ["commit-tree", emptyTree, "-m", "empty base"])
		).trim();
		await runGitInDir(repoDir, ["branch", "empty-base", emptyCommit]);

		const wtPath = join(worktreesDir, "empty-agent");
		const branchName = "overstory/empty-agent/bead-empty";
		await runGitInDir(repoDir, ["worktree", "add", "-b", branchName, wtPath, "empty-base"]);

		try {
			await validateWorktreeCreation({
				repoRoot: repoDir,
				worktreePath: wtPath,
				branchName,
			});
			expect(true).toBe(false);
		} catch (err: unknown) {
			expect(err).toBeInstanceOf(WorktreeError);
			const wtErr = err as WorktreeError;
			expect(wtErr.worktreePath).toBe(wtPath);
			expect(wtErr.branchName).toBe(branchName);
			expect(wtErr.message).toContain("zero tracked files");
		}

		// Rollback removed both worktree and branch
		expect(existsSync(wtPath)).toBe(false);
		const branchList = await git(repoDir, ["branch", "--list"]);
		expect(branchList).not.toContain(branchName);
	});

	test("createWorktree rejects when base branch has no tracked files", async () => {
		// End-to-end: createWorktree should surface the same error and clean
		// up after itself, so sling never sees a half-built worktree.
		const emptyTree = (
			await runGitInDir(repoDir, ["hash-object", "-t", "tree", "/dev/null"])
		).trim();
		const emptyCommit = (
			await runGitInDir(repoDir, ["commit-tree", emptyTree, "-m", "empty base"])
		).trim();
		await runGitInDir(repoDir, ["branch", "empty-base", emptyCommit]);

		await expect(
			createWorktree({
				repoRoot: repoDir,
				baseDir: worktreesDir,
				agentName: "empty-agent",
				baseBranch: "empty-base",
				taskId: "bead-empty",
			}),
		).rejects.toThrow(WorktreeError);

		// Caller observes a clean repo: no worktree dir, no leaked branch
		expect(existsSync(join(worktreesDir, "empty-agent"))).toBe(false);
		const branchList = await git(repoDir, ["branch", "--list"]);
		expect(branchList).not.toContain("overstory/empty-agent/bead-empty");
	});

	test("createWorktree rejects when target dir pre-exists with files", async () => {
		// Simulates the witnessed scenario: a stale directory survives at the
		// target path from a previous run. createWorktree must surface a
		// WorktreeError rather than returning a path that points at non-git
		// state — the contract that protects the agent from being trapped.
		const wtPath = join(worktreesDir, "preexisting-agent");
		await mkdir(wtPath, { recursive: true });
		await Bun.write(join(wtPath, "stale.txt"), "leftover from a previous run");

		await expect(
			createWorktree({
				repoRoot: repoDir,
				baseDir: worktreesDir,
				agentName: "preexisting-agent",
				baseBranch: defaultBranch,
				taskId: "bead-pre",
			}),
		).rejects.toThrow(WorktreeError);

		await rm(wtPath, { recursive: true, force: true });
	});
});

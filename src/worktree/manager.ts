import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { WorktreeError } from "../errors.ts";

/**
 * Run a git command and return stdout. Throws WorktreeError on non-zero exit.
 */
async function runGit(
	repoRoot: string,
	args: string[],
	context?: { worktreePath?: string; branchName?: string },
): Promise<string> {
	const proc = Bun.spawn(["git", ...args], {
		cwd: repoRoot,
		stdout: "pipe",
		stderr: "pipe",
	});

	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);

	if (exitCode !== 0) {
		throw new WorktreeError(
			`git ${args.join(" ")} failed (exit ${exitCode}): ${stderr.trim() || stdout.trim()}`,
			{
				worktreePath: context?.worktreePath,
				branchName: context?.branchName,
			},
		);
	}

	return stdout;
}

/**
 * Create a new git worktree for an agent.
 *
 * Creates a worktree at `{baseDir}/{agentName}` with a new branch
 * named `overstory/{agentName}/{taskId}` based on `baseBranch`.
 *
 * After `git worktree add` returns, validates that the worktree is
 * actually registered with git AND contains tracked files. If either
 * check fails, rolls back and throws — sling has previously hit edge
 * cases where the dir exists but git did not populate it (overstory-6878),
 * trapping the agent in a non-worktree directory.
 *
 * @returns The absolute worktree path and branch name.
 */
export async function createWorktree(options: {
	repoRoot: string;
	baseDir: string;
	agentName: string;
	baseBranch: string;
	taskId: string;
}): Promise<{ path: string; branch: string }> {
	const { repoRoot, baseDir, agentName, baseBranch, taskId } = options;

	const worktreePath = join(baseDir, agentName);
	const branchName = `overstory/${agentName}/${taskId}`;

	await runGit(repoRoot, ["worktree", "add", "-b", branchName, worktreePath, baseBranch], {
		worktreePath,
		branchName,
	});

	await validateWorktreeCreation({ repoRoot, worktreePath, branchName });

	return { path: worktreePath, branch: branchName };
}

/**
 * Verify that a freshly created worktree is registered with git and contains
 * tracked files. Throws WorktreeError with a precise diagnostic on failure
 * and rolls back the worktree + branch so callers don't leak state.
 *
 * Exported for direct testing of edge cases (empty base branches, racy
 * cleanup) that are awkward to provoke through createWorktree end-to-end.
 */
export async function validateWorktreeCreation(opts: {
	repoRoot: string;
	worktreePath: string;
	branchName: string;
}): Promise<void> {
	const { repoRoot, worktreePath, branchName } = opts;

	const entries = await listWorktrees(repoRoot);
	const registered = entries.some((entry) => entry.path === worktreePath);
	if (!registered) {
		await rollbackWorktree(repoRoot, worktreePath, branchName);
		throw new WorktreeError(
			`Worktree creation reported success but path is not registered with git: ${worktreePath}. Possible causes: pre-existing directory, branch already checked out elsewhere, or git worktree add failed silently.`,
			{ worktreePath, branchName },
		);
	}

	const lsFiles = await runGit(worktreePath, ["ls-files"], { worktreePath, branchName });
	const fileCount = lsFiles.split("\n").filter((line) => line.length > 0).length;
	if (fileCount === 0) {
		await rollbackWorktree(repoRoot, worktreePath, branchName);
		throw new WorktreeError(
			`Worktree was registered but contains zero tracked files: ${worktreePath}. The base branch may be empty or the working tree was not populated.`,
			{ worktreePath, branchName },
		);
	}
}

/**
 * Roll back a worktree and its associated branch after a failed spawn.
 *
 * Best-effort cleanup: errors are swallowed because the caller's original
 * error is more important. Always call this inside a catch block.
 */
export async function rollbackWorktree(
	repoRoot: string,
	worktreePath: string,
	branchName: string,
): Promise<void> {
	try {
		const removeProc = Bun.spawn(["git", "worktree", "remove", "--force", worktreePath], {
			cwd: repoRoot,
			stdout: "pipe",
			stderr: "pipe",
		});
		await removeProc.exited;
	} catch {
		// Best-effort
	}

	if (branchName.length > 0) {
		try {
			const branchProc = Bun.spawn(["git", "branch", "-D", branchName], {
				cwd: repoRoot,
				stdout: "pipe",
				stderr: "pipe",
			});
			await branchProc.exited;
		} catch {
			// Best-effort
		}
	}
}

/**
 * Parsed representation of a single worktree entry from `git worktree list --porcelain`.
 */
interface WorktreeEntry {
	path: string;
	branch: string;
	head: string;
}

/**
 * Parse the output of `git worktree list --porcelain` into structured entries.
 *
 * Porcelain format example:
 * ```
 * worktree /path/to/main
 * HEAD abc123
 * branch refs/heads/main
 *
 * worktree /path/to/wt
 * HEAD def456
 * branch refs/heads/overstory/agent/bead
 * ```
 */
function parseWorktreeOutput(output: string): WorktreeEntry[] {
	const entries: WorktreeEntry[] = [];
	const blocks = output.trim().split("\n\n");

	for (const block of blocks) {
		if (block.trim() === "") continue;

		let path = "";
		let head = "";
		let branch = "";

		const lines = block.trim().split("\n");
		for (const line of lines) {
			if (line.startsWith("worktree ")) {
				path = line.slice("worktree ".length);
			} else if (line.startsWith("HEAD ")) {
				head = line.slice("HEAD ".length);
			} else if (line.startsWith("branch ")) {
				// Strip refs/heads/ prefix to get the short branch name
				const ref = line.slice("branch ".length);
				branch = ref.replace(/^refs\/heads\//, "");
			}
		}

		if (path.length > 0) {
			entries.push({ path, head, branch });
		}
	}

	return entries;
}

/**
 * List all git worktrees in the repository.
 *
 * @returns Array of worktree entries with path, branch name, and HEAD commit.
 */
export async function listWorktrees(
	repoRoot: string,
): Promise<Array<{ path: string; branch: string; head: string }>> {
	const stdout = await runGit(repoRoot, ["worktree", "list", "--porcelain"]);
	return parseWorktreeOutput(stdout);
}

/**
 * Check if a branch has been merged into a target branch.
 * Uses `git merge-base --is-ancestor` which returns exit 0 if merged, 1 if not.
 */
export async function isBranchMerged(
	repoRoot: string,
	branch: string,
	targetBranch: string,
): Promise<boolean> {
	const proc = Bun.spawn(["git", "merge-base", "--is-ancestor", branch, targetBranch], {
		cwd: repoRoot,
		stdout: "pipe",
		stderr: "pipe",
	});

	const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);

	if (exitCode === 0) return true;
	if (exitCode === 1) return false;

	throw new WorktreeError(
		`git merge-base --is-ancestor failed (exit ${exitCode}): ${stderr.trim()}`,
		{ branchName: branch },
	);
}

/**
 * Remove a git worktree and delete its associated branch.
 *
 * Runs `git worktree remove {path}` to remove the worktree, then
 * deletes the branch. With `forceBranch: true`, uses `git branch -D`
 * to force-delete even unmerged branches. Otherwise uses `git branch -d`
 * which only deletes merged branches.
 */
export async function removeWorktree(
	repoRoot: string,
	path: string,
	options?: { force?: boolean; forceBranch?: boolean },
): Promise<void> {
	// First, figure out which branch this worktree is on so we can clean it up
	const worktrees = await listWorktrees(repoRoot);
	const entry = worktrees.find((wt) => wt.path === path);
	const branchName = entry?.branch ?? "";

	// Remove the worktree (--force handles untracked files and uncommitted changes)
	const removeArgs = ["worktree", "remove", path];
	if (options?.force) {
		removeArgs.push("--force");
	}
	await runGit(repoRoot, removeArgs, {
		worktreePath: path,
		branchName,
	});

	// Delete the associated branch after worktree removal.
	// Use -D (force) when forceBranch is set, since the branch may not have
	// been merged yet. Use -d (safe) otherwise, which only deletes merged branches.
	if (branchName.length > 0) {
		const deleteFlag = options?.forceBranch ? "-D" : "-d";
		try {
			await runGit(repoRoot, ["branch", deleteFlag, branchName], { branchName });
		} catch {
			// Branch deletion failed — may be unmerged (with -d) or checked out elsewhere.
			// This is best-effort; the worktree itself is already removed.
		}
	}
}

/**
 * Preserve .seeds/ changes from a branch into the canonical branch.
 *
 * Lead agent branches are never merged via the normal merge pipeline, so
 * any .seeds/ issue files they create would be lost when the worktree is
 * cleaned. This function extracts only the .seeds/ diff from the branch
 * and applies it to the canonical branch via a patch.
 *
 * @returns `{ preserved: true }` if changes were found and committed,
 *          `{ preserved: false }` if there were no .seeds/ changes,
 *          `{ preserved: false, error: "..." }` if something went wrong.
 */
export async function preserveSeedsChanges(
	repoRoot: string,
	branch: string,
	canonicalBranch: string,
	agentName: string,
): Promise<{ preserved: boolean; error?: string }> {
	// Step 1: Get the .seeds/ diff between canonical and the branch (three-dot diff).
	// Three-dot diff shows changes introduced on branch since it diverged from canonicalBranch.
	let diff: string;
	try {
		diff = await runGit(repoRoot, ["diff", `${canonicalBranch}...${branch}`, "--", ".seeds/"]);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return { preserved: false, error: `Failed to compute .seeds/ diff: ${msg}` };
	}

	if (diff.trim() === "") {
		// No .seeds/ changes on this branch
		return { preserved: false };
	}

	// Step 2: Verify the repo root is currently on canonicalBranch.
	let currentBranch: string;
	try {
		currentBranch = (await runGit(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return { preserved: false, error: `Failed to determine current branch: ${msg}` };
	}

	if (currentBranch !== canonicalBranch) {
		return {
			preserved: false,
			error: `Repo root is on '${currentBranch}', expected '${canonicalBranch}'. Cannot apply patch.`,
		};
	}

	// Step 3: Check that .seeds/ is clean in the canonical branch.
	let statusOutput: string;
	try {
		statusOutput = await runGit(repoRoot, ["status", "--porcelain", "--", ".seeds/"]);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return { preserved: false, error: `Failed to check .seeds/ status: ${msg}` };
	}

	if (statusOutput.trim() !== "") {
		return {
			preserved: false,
			error: `.seeds/ has uncommitted changes in canonical branch. Cannot apply patch safely.`,
		};
	}

	// Step 4: Write diff to a temp file.
	const tmpFile = join(repoRoot, ".overstory", `_seeds-patch-${Date.now()}.diff`);
	try {
		await Bun.write(tmpFile, diff);

		// Step 5: Apply the patch with --index (stages changes).
		try {
			await runGit(repoRoot, ["apply", "--index", tmpFile]);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			// Revert any partial changes
			try {
				await runGit(repoRoot, ["reset", "HEAD", "--", ".seeds/"]);
				await runGit(repoRoot, ["checkout", "--", ".seeds/"]);
			} catch {
				// Best-effort revert
			}
			return { preserved: false, error: `Failed to apply .seeds/ patch: ${msg}` };
		}

		// Step 6: Commit the changes.
		try {
			await runGit(repoRoot, [
				"commit",
				"-m",
				`chore: preserve .seeds/ changes from lead ${agentName}`,
			]);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			// Revert any staged changes
			try {
				await runGit(repoRoot, ["reset", "HEAD", "--", ".seeds/"]);
				await runGit(repoRoot, ["checkout", "--", ".seeds/"]);
			} catch {
				// Best-effort revert
			}
			return { preserved: false, error: `Failed to commit .seeds/ changes: ${msg}` };
		}

		return { preserved: true };
	} finally {
		// Step 8: Always clean up the temp file.
		try {
			await unlink(tmpFile);
		} catch {
			// Ignore cleanup errors
		}
	}
}

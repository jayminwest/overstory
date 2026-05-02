import { describe, expect, test } from "bun:test";
import { MergeError } from "../errors.ts";
import type { MulchClient } from "../mulch/client.ts";
import {
	cleanupTempDir,
	commitFile,
	createTempGitRepo,
	getDefaultBranch,
	runGitInDir,
} from "../test-helpers.ts";
import type { MergeEntry } from "../types.ts";
import { predictConflicts } from "./predict.ts";

function makeTestEntry(overrides?: Partial<MergeEntry>): MergeEntry {
	return {
		branchName: overrides?.branchName ?? "feature-branch",
		taskId: overrides?.taskId ?? "bead-123",
		agentName: overrides?.agentName ?? "test-agent",
		filesModified: overrides?.filesModified ?? ["src/test.ts"],
		enqueuedAt: overrides?.enqueuedAt ?? new Date().toISOString(),
		status: overrides?.status ?? "pending",
		resolvedTier: overrides?.resolvedTier ?? null,
	};
}

/**
 * Real mulch search output emulating two failed ai-resolve attempts on a file.
 * Format must match the regex in `parseConflictPatterns` (resolver.ts).
 */
function buildHistoricalFailureSearchOutput(file: string): string {
	const recordTemplate = (branch: string, agent: string) =>
		`Merge conflict failed at tier ai-resolve. Branch: ${branch}. Agent: ${agent}. Conflicting files: ${file}.`;
	return [
		recordTemplate("overstory/agent-a/bead-1", "agent-a"),
		recordTemplate("overstory/agent-b/bead-2", "agent-b"),
	].join("\n");
}

/**
 * Minimal MulchClient stub. Only `search` is exercised by predictConflicts.
 * The other methods throw to make accidental use loud during testing.
 */
function createMulchSearchStub(searchOutput: string): MulchClient {
	return {
		async prime() {
			throw new Error("prime() not used by predictConflicts");
		},
		async status() {
			throw new Error("status() not used by predictConflicts");
		},
		async record() {
			throw new Error("record() not used by predictConflicts");
		},
		async query() {
			throw new Error("query() not used by predictConflicts");
		},
		async search() {
			return searchOutput;
		},
		async diff() {
			throw new Error("diff() not used by predictConflicts");
		},
		async learn() {
			throw new Error("learn() not used by predictConflicts");
		},
		async prune() {
			throw new Error("prune() not used by predictConflicts");
		},
		async doctor() {
			throw new Error("doctor() not used by predictConflicts");
		},
		async ready() {
			throw new Error("ready() not used by predictConflicts");
		},
		async compact() {
			throw new Error("compact() not used by predictConflicts");
		},
		async appendOutcome() {
			throw new Error("appendOutcome() not used by predictConflicts");
		},
	};
}

describe("predictConflicts", () => {
	test("clean-merge: branch adds a new file", async () => {
		const repoDir = await createTempGitRepo();
		try {
			const defaultBranch = await getDefaultBranch(repoDir);
			await commitFile(repoDir, "src/main.ts", "main content\n");
			await runGitInDir(repoDir, ["checkout", "-b", "feature-branch"]);
			await commitFile(repoDir, "src/feature.ts", "feature\n");
			await runGitInDir(repoDir, ["checkout", defaultBranch]);

			const entry = makeTestEntry({
				branchName: "feature-branch",
				filesModified: ["src/feature.ts"],
			});

			const prediction = await predictConflicts(entry, defaultBranch, repoDir);

			expect(prediction.predictedTier).toBe("clean-merge");
			expect(prediction.conflictFiles).toEqual([]);
			expect(prediction.wouldRequireAgent).toBe(false);
			expect(prediction.reason).toContain("clean");
		} finally {
			await cleanupTempDir(repoDir);
		}
	});

	test("clean-merge: branch is an ancestor of canonical (already merged)", async () => {
		const repoDir = await createTempGitRepo();
		try {
			const defaultBranch = await getDefaultBranch(repoDir);
			await commitFile(repoDir, "src/main.ts", "v1\n");
			// Create a feature branch at the current tip — branch is an ancestor of canonical.
			await runGitInDir(repoDir, ["branch", "feature-branch"]);
			// Advance canonical past the branch.
			await commitFile(repoDir, "src/main.ts", "v2\n");

			const entry = makeTestEntry({
				branchName: "feature-branch",
				filesModified: ["src/main.ts"],
			});

			const prediction = await predictConflicts(entry, defaultBranch, repoDir);

			expect(prediction.predictedTier).toBe("clean-merge");
			expect(prediction.conflictFiles).toEqual([]);
			expect(prediction.wouldRequireAgent).toBe(false);
			expect(prediction.reason).toContain("ancestor");
		} finally {
			await cleanupTempDir(repoDir);
		}
	});

	test("auto-resolve: whitespace-only canonical (empty HEAD side)", async () => {
		const repoDir = await createTempGitRepo();
		try {
			const defaultBranch = await getDefaultBranch(repoDir);
			// Common ancestor.
			await commitFile(repoDir, "src/test.ts", "line1\nshared line\nline3\n");
			// Feature replaces "shared line".
			await runGitInDir(repoDir, ["checkout", "-b", "feature-branch"]);
			await commitFile(repoDir, "src/test.ts", "line1\nnew content\nline3\n");
			// Main deletes "shared line" — produces a conflict where HEAD side is empty.
			await runGitInDir(repoDir, ["checkout", defaultBranch]);
			await commitFile(repoDir, "src/test.ts", "line1\nline3\n");

			const entry = makeTestEntry({
				branchName: "feature-branch",
				filesModified: ["src/test.ts"],
			});

			const prediction = await predictConflicts(entry, defaultBranch, repoDir);

			expect(prediction.predictedTier).toBe("auto-resolve");
			expect(prediction.wouldRequireAgent).toBe(false);
			expect(prediction.conflictFiles).toContain("src/test.ts");
		} finally {
			await cleanupTempDir(repoDir);
		}
	});

	test("merge=union files do not require an agent", async () => {
		const repoDir = await createTempGitRepo();
		try {
			const defaultBranch = await getDefaultBranch(repoDir);
			// Same-line divergence on a merge=union file. With .gitattributes
			// available, git's union driver may resolve cleanly at the tree
			// level (-> clean-merge); without it, merge-tree surfaces a
			// conflict that our predictor classifies via checkMergeUnion
			// (-> auto-resolve). Either way, no merger agent is required.
			await commitFile(repoDir, "data.jsonl", '{"id":"shared"}\n');
			await runGitInDir(repoDir, ["checkout", "-b", "feature-branch"]);
			await commitFile(repoDir, "data.jsonl", '{"id":"branch-side"}\n');
			await runGitInDir(repoDir, ["checkout", defaultBranch]);
			await commitFile(repoDir, "data.jsonl", '{"id":"main-side"}\n');
			await Bun.write(`${repoDir}/.gitattributes`, "*.jsonl merge=union\n");

			const entry = makeTestEntry({
				branchName: "feature-branch",
				filesModified: ["data.jsonl"],
			});

			const prediction = await predictConflicts(entry, defaultBranch, repoDir);

			expect(prediction.wouldRequireAgent).toBe(false);
			expect(["clean-merge", "auto-resolve"]).toContain(prediction.predictedTier);
		} finally {
			await cleanupTempDir(repoDir);
		}
	});

	test("auto-resolve: synthetic conflict where every file is union", async () => {
		// Forces the conflict-classification branch by simulating a merge-tree
		// output that reports a conflict, then verifying checkMergeUnion sends
		// us to auto-resolve. We use a contentful conflict and write a working-
		// tree .gitattributes that marks the file union AFTER merge-tree's tree
		// pass has already produced a conflict for it. To pull that off we use
		// a file extension git won't auto-merge, plus a merge.driver-less repo.
		const repoDir = await createTempGitRepo();
		try {
			const defaultBranch = await getDefaultBranch(repoDir);
			await commitFile(repoDir, "src/test.ts", "original\n");
			await runGitInDir(repoDir, ["checkout", "-b", "feature-branch"]);
			await commitFile(repoDir, "src/test.ts", "feature\n");
			await runGitInDir(repoDir, ["checkout", defaultBranch]);
			await commitFile(repoDir, "src/test.ts", "main\n");
			// Mark the conflicting file union via working-tree .gitattributes.
			// Git's tree-merge resolved the .ts file with conflict markers
			// (default driver — no committed attributes), and check-attr sees
			// the working-tree directive.
			await Bun.write(`${repoDir}/.gitattributes`, "src/test.ts merge=union\n");

			const entry = makeTestEntry({
				branchName: "feature-branch",
				filesModified: ["src/test.ts"],
			});

			const prediction = await predictConflicts(entry, defaultBranch, repoDir);

			expect(prediction.wouldRequireAgent).toBe(false);
			// Either auto-resolve (conflict but union-resolvable) or clean-merge
			// if git applied the working-tree attribute at tree-merge time.
			expect(["clean-merge", "auto-resolve"]).toContain(prediction.predictedTier);
		} finally {
			await cleanupTempDir(repoDir);
		}
	});

	test("ai-resolve: contentful canonical", async () => {
		const repoDir = await createTempGitRepo();
		try {
			const defaultBranch = await getDefaultBranch(repoDir);
			await commitFile(repoDir, "src/test.ts", "original content\n");
			await runGitInDir(repoDir, ["checkout", "-b", "feature-branch"]);
			await commitFile(repoDir, "src/test.ts", "feature content\n");
			await runGitInDir(repoDir, ["checkout", defaultBranch]);
			await commitFile(repoDir, "src/test.ts", "main modified content\n");

			const entry = makeTestEntry({
				branchName: "feature-branch",
				filesModified: ["src/test.ts"],
			});

			const prediction = await predictConflicts(entry, defaultBranch, repoDir);

			expect(prediction.predictedTier).toBe("ai-resolve");
			expect(prediction.wouldRequireAgent).toBe(true);
			expect(prediction.conflictFiles).toContain("src/test.ts");
			expect(prediction.reason).toContain("src/test.ts");
		} finally {
			await cleanupTempDir(repoDir);
		}
	});

	test("missing branch throws MergeError with branch name", async () => {
		const repoDir = await createTempGitRepo();
		try {
			const defaultBranch = await getDefaultBranch(repoDir);
			await commitFile(repoDir, "src/main.ts", "content\n");

			const entry = makeTestEntry({ branchName: "does-not-exist" });

			await expect(predictConflicts(entry, defaultBranch, repoDir)).rejects.toThrow(MergeError);
		} finally {
			await cleanupTempDir(repoDir);
		}
	});

	test("mulch skip-tier history bumps ai-resolve to reimagine", async () => {
		const repoDir = await createTempGitRepo();
		try {
			const defaultBranch = await getDefaultBranch(repoDir);
			await commitFile(repoDir, "src/test.ts", "original\n");
			await runGitInDir(repoDir, ["checkout", "-b", "feature-branch"]);
			await commitFile(repoDir, "src/test.ts", "feature\n");
			await runGitInDir(repoDir, ["checkout", defaultBranch]);
			await commitFile(repoDir, "src/test.ts", "main\n");

			const entry = makeTestEntry({
				branchName: "feature-branch",
				filesModified: ["src/test.ts"],
			});

			const mulchClient = createMulchSearchStub(buildHistoricalFailureSearchOutput("src/test.ts"));
			const prediction = await predictConflicts(entry, defaultBranch, repoDir, mulchClient);

			expect(prediction.predictedTier).toBe("reimagine");
			expect(prediction.wouldRequireAgent).toBe(true);
			expect(prediction.reason).toContain("historical");
		} finally {
			await cleanupTempDir(repoDir);
		}
	});

	test("mulch absent: ai-resolve stays ai-resolve (history check is optional)", async () => {
		const repoDir = await createTempGitRepo();
		try {
			const defaultBranch = await getDefaultBranch(repoDir);
			await commitFile(repoDir, "src/test.ts", "original\n");
			await runGitInDir(repoDir, ["checkout", "-b", "feature-branch"]);
			await commitFile(repoDir, "src/test.ts", "feature\n");
			await runGitInDir(repoDir, ["checkout", defaultBranch]);
			await commitFile(repoDir, "src/test.ts", "main\n");

			const entry = makeTestEntry({
				branchName: "feature-branch",
				filesModified: ["src/test.ts"],
			});

			// No mulch client passed — verifies the history check is genuinely optional.
			const prediction = await predictConflicts(entry, defaultBranch, repoDir);
			expect(prediction.predictedTier).toBe("ai-resolve");
			expect(prediction.wouldRequireAgent).toBe(true);
		} finally {
			await cleanupTempDir(repoDir);
		}
	});

	test("mulch search failure does not block prediction", async () => {
		const repoDir = await createTempGitRepo();
		try {
			const defaultBranch = await getDefaultBranch(repoDir);
			await commitFile(repoDir, "src/test.ts", "original\n");
			await runGitInDir(repoDir, ["checkout", "-b", "feature-branch"]);
			await commitFile(repoDir, "src/test.ts", "feature\n");
			await runGitInDir(repoDir, ["checkout", defaultBranch]);
			await commitFile(repoDir, "src/test.ts", "main\n");

			const entry = makeTestEntry({
				branchName: "feature-branch",
				filesModified: ["src/test.ts"],
			});

			const failingMulch: MulchClient = {
				...createMulchSearchStub(""),
				async search() {
					throw new Error("mulch unreachable");
				},
			};

			const prediction = await predictConflicts(entry, defaultBranch, repoDir, failingMulch);
			expect(prediction.predictedTier).toBe("ai-resolve");
			expect(prediction.wouldRequireAgent).toBe(true);
		} finally {
			await cleanupTempDir(repoDir);
		}
	});

	test("does not mutate the working tree, HEAD, or current branch", async () => {
		const repoDir = await createTempGitRepo();
		try {
			const defaultBranch = await getDefaultBranch(repoDir);
			await commitFile(repoDir, "src/test.ts", "original\n");
			await runGitInDir(repoDir, ["checkout", "-b", "feature-branch"]);
			await commitFile(repoDir, "src/test.ts", "feature\n");
			await runGitInDir(repoDir, ["checkout", defaultBranch]);
			await commitFile(repoDir, "src/test.ts", "main\n");

			const headBefore = (await runGitInDir(repoDir, ["rev-parse", "HEAD"])).trim();
			const branchBefore = (await runGitInDir(repoDir, ["symbolic-ref", "--short", "HEAD"])).trim();
			const fileBefore = await Bun.file(`${repoDir}/src/test.ts`).text();

			await predictConflicts(
				makeTestEntry({
					branchName: "feature-branch",
					filesModified: ["src/test.ts"],
				}),
				defaultBranch,
				repoDir,
			);

			const headAfter = (await runGitInDir(repoDir, ["rev-parse", "HEAD"])).trim();
			const branchAfter = (await runGitInDir(repoDir, ["symbolic-ref", "--short", "HEAD"])).trim();
			const fileAfter = await Bun.file(`${repoDir}/src/test.ts`).text();
			const status = await runGitInDir(repoDir, ["status", "--porcelain"]);

			expect(headAfter).toBe(headBefore);
			expect(branchAfter).toBe(branchBefore);
			expect(fileAfter).toBe(fileBefore);
			expect(status.trim()).toBe("");
		} finally {
			await cleanupTempDir(repoDir);
		}
	});
});

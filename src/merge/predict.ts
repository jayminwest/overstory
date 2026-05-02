/**
 * Side-effect-free conflict prediction for `ov merge --dry-run`.
 *
 * Uses `git merge-tree --write-tree --merge-base=<base> <ours> <theirs>` to
 * compute the conflict set without mutating HEAD, the working tree, or the
 * merge lock. Each conflict file is classified into a predicted resolution
 * tier by reusing the same primitives that the actual resolver uses
 * (`hasContentfulCanonical`, `checkMergeUnion`), so prediction stays in lock
 * step with how `ov merge` would actually behave at runtime.
 *
 * Requires git >= 2.38 for `merge-tree --write-tree`.
 */

import { MergeError } from "../errors.ts";
import type { MulchClient } from "../mulch/client.ts";
import type { ConflictPrediction, MergeEntry } from "../types.ts";
import {
	buildConflictHistory,
	checkMergeUnion,
	hasContentfulCanonical,
	parseConflictPatterns,
} from "./resolver.ts";

/** Run a git command in the given repo root. Returns stdout, stderr, exit code. */
async function runGit(
	repoRoot: string,
	args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
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
	return { stdout, stderr, exitCode };
}

/** Resolve a ref to its commit OID. Throws MergeError when the ref is missing. */
async function resolveRef(repoRoot: string, ref: string): Promise<string> {
	const { stdout, stderr, exitCode } = await runGit(repoRoot, ["rev-parse", "--verify", ref]);
	if (exitCode !== 0) {
		throw new MergeError(`Failed to resolve ref "${ref}": ${stderr.trim()}`, {
			branchName: ref,
		});
	}
	return stdout.trim();
}

/**
 * Find the merge-base of two refs.
 * Returns the merge-base OID, or null when the refs share no history.
 */
async function findMergeBase(
	repoRoot: string,
	ours: string,
	theirs: string,
): Promise<string | null> {
	const { stdout, exitCode } = await runGit(repoRoot, ["merge-base", ours, theirs]);
	if (exitCode !== 0) return null;
	const oid = stdout.trim();
	return oid.length > 0 ? oid : null;
}

interface MergeTreeOutput {
	treeOid: string;
	conflictPaths: string[];
	exitCode: number;
}

/**
 * Run `git merge-tree --write-tree` and parse the conflict info section.
 *
 * Output format (per git-merge-tree(1) --write-tree):
 *   <tree-oid>
 *   <Conflicted file info>*
 *   <blank line>
 *   <Informational messages>*
 *
 * Each conflicted file info line is `<mode> <object> <stage>\t<path>`.
 */
async function runMergeTree(
	repoRoot: string,
	base: string,
	ours: string,
	theirs: string,
): Promise<MergeTreeOutput> {
	const { stdout, stderr, exitCode } = await runGit(repoRoot, [
		"merge-tree",
		"--write-tree",
		`--merge-base=${base}`,
		ours,
		theirs,
	]);

	if (exitCode > 1) {
		throw new MergeError(
			`git merge-tree failed (exit ${exitCode}): ${stderr.trim() || "no error output"}`,
			{ branchName: theirs },
		);
	}

	const lines = stdout.split("\n");
	const treeOid = (lines[0] ?? "").trim();
	if (treeOid.length === 0) {
		throw new MergeError(`git merge-tree returned empty output for ${ours} vs ${theirs}`, {
			branchName: theirs,
		});
	}

	const conflictPaths = new Set<string>();
	// Conflict info section lives between line 1 and the first blank line.
	for (let i = 1; i < lines.length; i++) {
		const line = lines[i];
		if (line === undefined || line === "") break;
		const tabIdx = line.indexOf("\t");
		if (tabIdx === -1) continue;
		const path = line.substring(tabIdx + 1);
		if (path.length > 0) conflictPaths.add(path);
	}

	return {
		treeOid,
		conflictPaths: [...conflictPaths],
		exitCode,
	};
}

/** Read a file's content from a tree OID. Returns "" when the file is absent. */
async function readFromTree(repoRoot: string, treeOid: string, path: string): Promise<string> {
	const { stdout, exitCode } = await runGit(repoRoot, ["show", `${treeOid}:${path}`]);
	if (exitCode !== 0) return "";
	return stdout;
}

/**
 * Predict how `ov merge` would resolve `entry.branchName` into `canonicalBranch`.
 *
 * Side-effect-free: runs `git merge-tree --write-tree` against committed refs.
 * Does not touch HEAD, the working tree, or the merge lock.
 *
 * @param entry The merge entry under consideration. Only `branchName` is used here.
 * @param canonicalBranch The target branch (e.g. "main").
 * @param repoRoot Absolute path to the repo.
 * @param mulchClient Optional. When provided, mulch history is consulted for
 *   skip-tier escalation: if `ai-resolve` has historical failures for any
 *   overlapping conflict file, the prediction bumps to `reimagine`.
 */
export async function predictConflicts(
	entry: MergeEntry,
	canonicalBranch: string,
	repoRoot: string,
	mulchClient?: MulchClient,
): Promise<ConflictPrediction> {
	// Validate refs upfront so a missing branch produces a clear error
	// instead of a confusing merge-base or merge-tree failure.
	const oursOid = await resolveRef(repoRoot, canonicalBranch);
	const theirsOid = await resolveRef(repoRoot, entry.branchName);

	const baseOid = await findMergeBase(repoRoot, oursOid, theirsOid);
	if (baseOid === null) {
		throw new MergeError(`No common ancestor between ${canonicalBranch} and ${entry.branchName}`, {
			branchName: entry.branchName,
		});
	}

	// Already-merged ancestor: branch tip is reachable from canonical.
	// merge-tree would also report clean here, but short-circuiting avoids
	// the extra spawn and produces a more informative reason string.
	if (baseOid === theirsOid) {
		return {
			predictedTier: "clean-merge",
			conflictFiles: [],
			wouldRequireAgent: false,
			reason: `${entry.branchName} is already an ancestor of ${canonicalBranch}`,
		};
	}

	const mergeOutput = await runMergeTree(repoRoot, baseOid, oursOid, theirsOid);

	if (mergeOutput.exitCode === 0 || mergeOutput.conflictPaths.length === 0) {
		return {
			predictedTier: "clean-merge",
			conflictFiles: [],
			wouldRequireAgent: false,
			reason: "no conflicts: merge-tree reports clean merge",
		};
	}

	const conflictFiles = mergeOutput.conflictPaths;
	const blockingFiles: string[] = [];

	for (const file of conflictFiles) {
		// merge=union files are auto-resolvable by Tier 2's union driver even
		// when merge-tree surfaces them as conflicts (the .gitattributes may
		// only exist in the working tree; check-attr respects that).
		if (await checkMergeUnion(repoRoot, file)) continue;

		const merged = await readFromTree(repoRoot, mergeOutput.treeOid, file);
		if (hasContentfulCanonical(merged)) {
			blockingFiles.push(file);
		}
	}

	if (blockingFiles.length === 0) {
		return {
			predictedTier: "auto-resolve",
			conflictFiles,
			wouldRequireAgent: false,
			reason: "all conflict files are merge=union or have whitespace-only canonical",
		};
	}

	const baseReason =
		blockingFiles.length === 1
			? `${blockingFiles[0]} has contentful canonical`
			: `${blockingFiles.length} files have contentful canonical (e.g. ${blockingFiles[0]})`;

	let prediction: ConflictPrediction = {
		predictedTier: "ai-resolve",
		conflictFiles,
		wouldRequireAgent: true,
		reason: baseReason,
	};

	if (mulchClient) {
		try {
			const searchOutput = await mulchClient.search("merge-conflict", { sortByScore: true });
			const patterns = parseConflictPatterns(searchOutput);
			const history = buildConflictHistory(patterns, conflictFiles);
			if (history.skipTiers.includes("ai-resolve")) {
				prediction = {
					predictedTier: "reimagine",
					conflictFiles,
					wouldRequireAgent: true,
					reason: `ai-resolve has historical failures for these files; ${baseReason}`,
				};
			}
		} catch {
			// Mulch failures must never block prediction — fall through with the
			// base ai-resolve prediction.
		}
	}

	return prediction;
}

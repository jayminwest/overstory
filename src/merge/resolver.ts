/**
 * Tiered conflict resolution for merging agent branches.
 *
 * Implements a 4-tier escalation strategy:
 *   1. Clean merge — git merge with no conflicts
 *   2. Auto-resolve — parse conflict markers, keep incoming (agent) changes
 *   3. AI-resolve — use Claude to resolve remaining conflicts
 *   4. Re-imagine — abort merge and reimplement changes from scratch
 *
 * Each tier is attempted in order. If a tier fails, the next is tried.
 * Disabled tiers are skipped. Uses Bun.spawn for all subprocess calls.
 */

import { unlinkSync } from "node:fs";
import { MergeError } from "../errors.ts";
import type { MulchClient } from "../mulch/client.ts";
import { getRuntime } from "../runtimes/registry.ts";
import type {
	ConflictHistory,
	MergeEntry,
	MergeResult,
	OverstoryConfig,
	ParsedConflictPattern,
	ResolutionTier,
} from "../types.ts";

export interface MergeResolver {
	/** Attempt to merge the entry's branch into the canonical branch with tiered resolution. */
	resolve(entry: MergeEntry, canonicalBranch: string, repoRoot: string): Promise<MergeResult>;
}

/**
 * Run a git command in the given repo root. Returns stdout, stderr, and exit code.
 */
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

/**
 * os-eco runtime state path prefixes and exact filenames.
 * Files matching these are bookkeeping artifacts that change during normal
 * orchestration and should be auto-committed rather than blocking merges.
 */
const OS_ECO_STATE_PREFIXES = [
	".seeds/",
	".overstory/",
	".greenhouse/",
	".mulch/",
	".canopy/",
	".claude/",
];
const OS_ECO_STATE_FILES = ["CLAUDE.md"];

/**
 * Returns true if a file path is an os-eco runtime state file
 * (issue tracker, groups, expertise, prompts, etc.).
 */
function isOsEcoStateFile(filePath: string): boolean {
	if (OS_ECO_STATE_FILES.includes(filePath)) return true;
	return OS_ECO_STATE_PREFIXES.some((prefix) => filePath.startsWith(prefix));
}

/**
 * Get the list of tracked files with uncommitted changes (unstaged or staged).
 * Returns deduplicated list of file paths. An empty list means the working tree is clean.
 */
async function checkDirtyWorkingTree(repoRoot: string): Promise<string[]> {
	const { stdout: unstaged } = await runGit(repoRoot, ["diff", "--name-only"]);
	const { stdout: staged } = await runGit(repoRoot, ["diff", "--name-only", "--cached"]);
	const files = [
		...unstaged
			.trim()
			.split("\n")
			.filter((l) => l.length > 0),
		...staged
			.trim()
			.split("\n")
			.filter((l) => l.length > 0),
	];
	return [...new Set(files)];
}

/**
 * Auto-commit os-eco runtime state files so they don't block merges.
 * Returns true if a commit was made, false if there was nothing to commit.
 */
async function autoCommitStateFiles(repoRoot: string, stateFiles: string[]): Promise<boolean> {
	if (stateFiles.length === 0) return false;

	const { exitCode: addCode } = await runGit(repoRoot, ["add", ...stateFiles]);
	if (addCode !== 0) return false;

	const { exitCode: commitCode } = await runGit(repoRoot, [
		"commit",
		"-m",
		"chore: sync os-eco runtime state",
	]);
	return commitCode === 0;
}

/**
 * Get the list of conflicted files from `git diff --name-only --diff-filter=U`.
 */
async function getConflictedFiles(repoRoot: string): Promise<string[]> {
	const { stdout } = await runGit(repoRoot, ["diff", "--name-only", "--diff-filter=U"]);
	return stdout
		.trim()
		.split("\n")
		.filter((line) => line.length > 0);
}

/**
 * Parse conflict markers in file content and keep the incoming (agent) changes.
 *
 * A conflict block looks like:
 * ```
 * <<<<<<< HEAD
 * canonical content
 * =======
 * incoming content
 * >>>>>>> branch
 * ```
 *
 * This function replaces each conflict block with only the incoming content.
 * Returns the resolved content, or null if no conflict markers were found.
 */
function resolveConflictsKeepIncoming(content: string): string | null {
	const conflictPattern = /^<{7} .+\n([\s\S]*?)^={7}\n([\s\S]*?)^>{7} .+\n?/gm;

	if (!conflictPattern.test(content)) {
		return null;
	}

	// Reset regex lastIndex after test()
	conflictPattern.lastIndex = 0;

	return content.replace(conflictPattern, (_match, _canonical: string, incoming: string) => {
		return incoming;
	});
}

/**
 * Parse conflict markers in file content and keep ALL lines from both sides.
 * Used when the file has `merge=union` gitattribute — dedup-on-read handles duplicates.
 *
 * A conflict block looks like:
 * ```
 * <<<<<<< HEAD
 * canonical content
 * =======
 * incoming content
 * >>>>>>> branch
 * ```
 *
 * This function replaces each conflict block with canonical + incoming content concatenated.
 * Returns the resolved content, or null if no conflict markers were found.
 */
export function resolveConflictsUnion(content: string): string | null {
	const conflictPattern = /^<{7} .+\n([\s\S]*?)^={7}\n([\s\S]*?)^>{7} .+\n?/gm;

	if (!conflictPattern.test(content)) {
		return null;
	}

	// Reset regex lastIndex after test()
	conflictPattern.lastIndex = 0;

	return content.replace(conflictPattern, (_match, canonical: string, incoming: string) => {
		return canonical + incoming;
	});
}

/**
 * Detect if any conflict block has non-whitespace content on the canonical (HEAD) side.
 * Returns true if auto-resolving with keep-incoming would silently discard canonical content.
 * Use this before calling resolveConflictsKeepIncoming to prevent data loss.
 */
export function hasContentfulCanonical(content: string): boolean {
	const conflictPattern = /^<{7} .+\n([\s\S]*?)^={7}\n([\s\S]*?)^>{7} .+\n?/gm;
	let match = conflictPattern.exec(content);
	while (match !== null) {
		const canonical = match[1] ?? "";
		if (canonical.trim().length > 0) {
			return true;
		}
		match = conflictPattern.exec(content);
	}
	return false;
}

/**
 * Check if a file has the `merge=union` gitattribute set.
 * Returns true if `git check-attr merge -- <file>` ends with ": merge: union".
 */
export async function checkMergeUnion(repoRoot: string, filePath: string): Promise<boolean> {
	const { stdout, exitCode } = await runGit(repoRoot, ["check-attr", "merge", "--", filePath]);
	if (exitCode !== 0) return false;
	return stdout.trim().endsWith(": merge: union");
}

/**
 * Read a file's content using Bun.file().
 */
async function readFile(filePath: string): Promise<string> {
	const file = Bun.file(filePath);
	return file.text();
}

/**
 * Write content to a file using Bun.write().
 */
async function writeFile(filePath: string, content: string): Promise<void> {
	await Bun.write(filePath, content);
}

/**
 * Tier 1: Attempt a clean merge (git merge --no-edit).
 * Returns true if the merge succeeds with no conflicts.
 */
async function tryCleanMerge(
	entry: MergeEntry,
	repoRoot: string,
): Promise<{ success: boolean; conflictFiles: string[] }> {
	const { exitCode } = await runGit(repoRoot, ["merge", "--no-edit", entry.branchName]);

	if (exitCode === 0) {
		return { success: true, conflictFiles: [] };
	}

	// Merge failed — get the list of conflicted files
	const conflictFiles = await getConflictedFiles(repoRoot);
	return { success: false, conflictFiles };
}

/**
 * Tier 2: Auto-resolve conflicts by keeping incoming (agent) changes.
 * Parses conflict markers and keeps the content between ======= and >>>>>>>.
 * Skips files where the canonical side has non-whitespace content to prevent
 * silent data loss — those files are escalated to higher tiers.
 */
async function tryAutoResolve(
	conflictFiles: string[],
	repoRoot: string,
): Promise<{ success: boolean; remainingConflicts: string[]; contentDropWarnings: string[] }> {
	const remainingConflicts: string[] = [];
	const contentDropWarnings: string[] = [];

	for (const file of conflictFiles) {
		const filePath = `${repoRoot}/${file}`;

		try {
			const content = await readFile(filePath);
			const isUnion = await checkMergeUnion(repoRoot, file);

			// For non-union files, check if the canonical side has content.
			// If it does, auto-resolving would silently discard that content.
			// Escalate to a higher tier instead.
			if (!isUnion && hasContentfulCanonical(content)) {
				contentDropWarnings.push(
					`auto-resolve skipped for ${file}: canonical side has content that would be discarded`,
				);
				remainingConflicts.push(file);
				continue;
			}

			const resolved = isUnion
				? resolveConflictsUnion(content)
				: resolveConflictsKeepIncoming(content);

			if (resolved === null) {
				// No conflict markers found (shouldn't happen but be defensive)
				remainingConflicts.push(file);
				continue;
			}

			await writeFile(filePath, resolved);
			const { exitCode } = await runGit(repoRoot, ["add", file]);
			if (exitCode !== 0) {
				remainingConflicts.push(file);
			}
		} catch {
			remainingConflicts.push(file);
		}
	}

	if (remainingConflicts.length > 0) {
		return { success: false, remainingConflicts, contentDropWarnings };
	}

	// All files resolved — commit
	const { exitCode } = await runGit(repoRoot, ["commit", "--no-edit"]);
	return { success: exitCode === 0, remainingConflicts, contentDropWarnings };
}

/**
 * Check if text looks like conversational prose rather than code.
 * Returns true if the output is likely prose from the LLM rather than resolved code.
 */
export function looksLikeProse(text: string): boolean {
	const trimmed = text.trim();
	if (trimmed.length === 0) return true;

	// Common conversational opening patterns from LLMs
	const prosePatterns = [
		/^(I |I'[a-z]+ |Here |Here's |The |This |Let me |Sure|Unfortunately|Apologies|Sorry)/i,
		/^(To resolve|Looking at|Based on|After reviewing|The conflict)/i,
		/^```/m, // Markdown fencing — the model wrapped the code
		/I need permission/i,
		/I cannot/i,
		/I don't have/i,
	];

	for (const pattern of prosePatterns) {
		if (pattern.test(trimmed)) return true;
	}

	return false;
}

/**
 * Tier 3: AI-assisted conflict resolution using Claude.
 * Spawns `claude --print` for each conflicted file with the conflict content.
 * Validates that output looks like code, not conversational prose.
 */
async function tryAiResolve(
	conflictFiles: string[],
	repoRoot: string,
	pastResolutions?: string[],
	config?: OverstoryConfig,
): Promise<{ success: boolean; remainingConflicts: string[] }> {
	const remainingConflicts: string[] = [];

	for (const file of conflictFiles) {
		const filePath = `${repoRoot}/${file}`;

		try {
			const content = await readFile(filePath);
			const historyContext =
				pastResolutions && pastResolutions.length > 0
					? `\n\nHistorical context from past merges:\n${pastResolutions.join("\n")}\n`
					: "";
			const prompt = [
				"You are a merge conflict resolver. Output ONLY the resolved file content.",
				"Rules: NO explanation, NO markdown fencing, NO conversation, NO preamble.",
				"Output the raw file content as it should appear on disk.",
				"Choose the best combination of both sides of this conflict:",
				historyContext,
				"\n\n",
				content,
			].join(" ");

			const runtime = getRuntime(config?.runtime?.printCommand ?? config?.runtime?.default, config);
			const argv = runtime.buildPrintCommand(prompt);
			const proc = Bun.spawn(argv, {
				cwd: repoRoot,
				stdout: "pipe",
				stderr: "pipe",
			});

			const [resolved, , exitCode] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);

			if (exitCode !== 0 || resolved.trim() === "") {
				remainingConflicts.push(file);
				continue;
			}

			// Validate output is code, not prose — fall back to next tier if not
			if (looksLikeProse(resolved)) {
				remainingConflicts.push(file);
				continue;
			}

			await writeFile(filePath, resolved);
			const { exitCode: addExitCode } = await runGit(repoRoot, ["add", file]);
			if (addExitCode !== 0) {
				remainingConflicts.push(file);
			}
		} catch {
			remainingConflicts.push(file);
		}
	}

	if (remainingConflicts.length > 0) {
		return { success: false, remainingConflicts };
	}

	// All files resolved — commit
	const { exitCode } = await runGit(repoRoot, ["commit", "--no-edit"]);
	return { success: exitCode === 0, remainingConflicts };
}

/**
 * Tier 4: Re-imagine — abort the merge and reimplement changes from scratch.
 * Uses Claude to reimplement the agent's changes on top of the canonical version.
 */
async function tryReimagine(
	entry: MergeEntry,
	canonicalBranch: string,
	repoRoot: string,
	config?: OverstoryConfig,
): Promise<{ success: boolean }> {
	// Abort the current merge
	await runGit(repoRoot, ["merge", "--abort"]);

	for (const file of entry.filesModified) {
		try {
			// Get the canonical version
			const { stdout: canonicalContent, exitCode: catCanonicalCode } = await runGit(repoRoot, [
				"show",
				`${canonicalBranch}:${file}`,
			]);

			// Get the branch version
			const { stdout: branchContent, exitCode: catBranchCode } = await runGit(repoRoot, [
				"show",
				`${entry.branchName}:${file}`,
			]);

			if (catCanonicalCode !== 0 || catBranchCode !== 0) {
				return { success: false };
			}

			const prompt = [
				"You are a merge conflict resolver. Output ONLY the final file content.",
				"Rules: NO explanation, NO markdown fencing, NO conversation, NO preamble.",
				"Output the raw file content as it should appear on disk.",
				"Reimplement the changes from the branch version onto the canonical version.",
				`\n\n=== CANONICAL VERSION (${canonicalBranch}) ===\n`,
				canonicalContent,
				`\n\n=== BRANCH VERSION (${entry.branchName}) ===\n`,
				branchContent,
			].join("");

			const runtime = getRuntime(config?.runtime?.printCommand ?? config?.runtime?.default, config);
			const argv = runtime.buildPrintCommand(prompt);
			const proc = Bun.spawn(argv, {
				cwd: repoRoot,
				stdout: "pipe",
				stderr: "pipe",
			});

			const [reimagined, , exitCode] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);

			if (exitCode !== 0 || reimagined.trim() === "") {
				return { success: false };
			}

			// Validate output is code, not prose
			if (looksLikeProse(reimagined)) {
				return { success: false };
			}

			const filePath = `${repoRoot}/${file}`;
			await writeFile(filePath, reimagined);
			const { exitCode: addExitCode } = await runGit(repoRoot, ["add", file]);
			if (addExitCode !== 0) {
				return { success: false };
			}
		} catch {
			return { success: false };
		}
	}

	// Commit the reimagined changes
	const { exitCode } = await runGit(repoRoot, [
		"commit",
		"-m",
		`Reimagine merge: ${entry.branchName} onto ${canonicalBranch}`,
	]);

	return { success: exitCode === 0 };
}

/**
 * Parse mulch search output for conflict patterns.
 * Extracts structured data from pattern descriptions recorded by recordConflictPattern().
 */
export function parseConflictPatterns(searchOutput: string): ParsedConflictPattern[] {
	const patterns: ParsedConflictPattern[] = [];
	// Simple approach: match to end of line/sentence and manually strip trailing period
	const regex =
		/Merge conflict (resolved|failed) at tier (clean-merge|auto-resolve|ai-resolve|reimagine)\.\s*Branch:\s*(\S+)\.\s*Agent:\s*(\S+)\.\s*Conflicting files:\s*(.+?)(?=\.(?:\s|$))/g;

	let match = regex.exec(searchOutput);
	while (match !== null) {
		const outcome = match[1];
		const tier = match[2];
		const branch = match[3];
		const agent = match[4];
		const filesStr = match[5];

		if (!outcome || !tier || !branch || !agent || !filesStr) {
			match = regex.exec(searchOutput);
			continue;
		}

		patterns.push({
			tier: tier as ResolutionTier,
			success: outcome === "resolved",
			files: filesStr
				.split(",")
				.map((f) => f.trim())
				.filter((f) => f.length > 0),
			agent: agent.trim(),
			branch: branch.trim(),
		});

		match = regex.exec(searchOutput);
	}

	return patterns;
}

/**
 * Build conflict history from parsed patterns, scoped to the files in the current merge entry.
 *
 * Skip-tier logic: if a tier has failed >= 2 times for any overlapping file
 * and never succeeded for those files, add it to skipTiers.
 *
 * Past resolutions: collect descriptions of successful resolutions involving
 * overlapping files to enrich AI prompts.
 *
 * Predicted conflicts: files from historical patterns that overlap with the
 * current entry files.
 */
export function buildConflictHistory(
	patterns: ParsedConflictPattern[],
	entryFiles: string[],
): ConflictHistory {
	const entryFileSet = new Set(entryFiles);

	// Filter patterns to those that share files with the current entry
	const relevantPatterns = patterns.filter((p) => p.files.some((f) => entryFileSet.has(f)));

	if (relevantPatterns.length === 0) {
		return { skipTiers: [], pastResolutions: [], predictedConflictFiles: [] };
	}

	// Build tier success/failure counts
	const tierCounts = new Map<ResolutionTier, { successes: number; failures: number }>();
	for (const p of relevantPatterns) {
		const counts = tierCounts.get(p.tier) ?? { successes: 0, failures: 0 };
		if (p.success) {
			counts.successes++;
		} else {
			counts.failures++;
		}
		tierCounts.set(p.tier, counts);
	}

	// Skip tiers that have failed >= 2 times and never succeeded
	const skipTiers: ResolutionTier[] = [];
	for (const [tier, counts] of tierCounts) {
		if (counts.failures >= 2 && counts.successes === 0) {
			skipTiers.push(tier);
		}
	}

	// Collect past successful resolutions
	const pastResolutions: string[] = [];
	for (const p of relevantPatterns) {
		if (p.success) {
			pastResolutions.push(
				`Previously resolved at tier ${p.tier} for files: ${p.files.join(", ")}`,
			);
		}
	}

	// Predict conflict files: all files from relevant historical patterns
	const predictedFileSet = new Set<string>();
	for (const p of relevantPatterns) {
		for (const f of p.files) {
			predictedFileSet.add(f);
		}
	}
	const predictedConflictFiles = [...predictedFileSet].sort();

	return { skipTiers, pastResolutions, predictedConflictFiles };
}

/**
 * Query mulch for historical conflict patterns related to the merge entry.
 * Returns empty history if mulch is unavailable or search fails (fire-and-forget).
 */
async function queryConflictHistory(
	mulchClient: MulchClient,
	entry: MergeEntry,
): Promise<ConflictHistory> {
	try {
		const searchOutput = await mulchClient.search("merge-conflict", { sortByScore: true });
		const patterns = parseConflictPatterns(searchOutput);
		return buildConflictHistory(patterns, entry.filesModified);
	} catch {
		return { skipTiers: [], pastResolutions: [], predictedConflictFiles: [] };
	}
}

/**
 * Record a merge conflict pattern to mulch for future learning.
 * Uses fire-and-forget (try/catch swallowing errors) so recording
 * never blocks or fails the merge itself.
 */
function recordConflictPattern(
	mulchClient: MulchClient,
	entry: MergeEntry,
	tier: ResolutionTier,
	conflictFiles: string[],
	success: boolean,
): void {
	const outcome = success ? "resolved" : "failed";
	const description = [
		`Merge conflict ${outcome} at tier ${tier}.`,
		`Branch: ${entry.branchName}.`,
		`Agent: ${entry.agentName}.`,
		`Conflicting files: ${conflictFiles.join(", ")}.`,
	].join(" ");

	// Fire-and-forget per convention mx-09e10f
	mulchClient
		.record("architecture", {
			type: "pattern",
			description,
			tags: ["merge-conflict"],
			evidenceBead: entry.taskId,
		})
		.catch(() => {});
}

/**
 * Create a MergeResolver with configurable tier enablement.
 *
 * @param options.aiResolveEnabled - Enable tier 3 (AI-assisted resolution)
 * @param options.reimagineEnabled - Enable tier 4 (full reimagine)
 * @param options.mulchClient - Optional MulchClient for conflict pattern recording
 */
export function createMergeResolver(options: {
	aiResolveEnabled: boolean;
	reimagineEnabled: boolean;
	mulchClient?: MulchClient;
	config?: OverstoryConfig;
	onMergeSuccess?: (entry: MergeEntry) => Promise<void>;
}): MergeResolver {
	return {
		async resolve(
			entry: MergeEntry,
			canonicalBranch: string,
			repoRoot: string,
		): Promise<MergeResult> {
			// Check current branch — skip checkout if already on canonical.
			// Avoids "already checked out" error when worktrees exist.
			const { stdout: currentRef, exitCode: refCode } = await runGit(repoRoot, [
				"symbolic-ref",
				"--short",
				"HEAD",
			]);
			const needsCheckout = refCode !== 0 || currentRef.trim() !== canonicalBranch;

			if (needsCheckout) {
				const { exitCode: checkoutCode, stderr: checkoutErr } = await runGit(repoRoot, [
					"checkout",
					canonicalBranch,
				]);
				if (checkoutCode !== 0) {
					throw new MergeError(`Failed to checkout ${canonicalBranch}: ${checkoutErr.trim()}`, {
						branchName: canonicalBranch,
					});
				}
			}

			// Pre-check: auto-commit os-eco state files, stash any remaining dirty tracked files.
			// When dirty tracked files exist, git merge refuses to start (exit 1, no conflict markers),
			// causing all tiers to cascade with empty conflict lists and a misleading final error.
			const dirtyFiles = await checkDirtyWorkingTree(repoRoot);
			if (dirtyFiles.length > 0) {
				const stateFiles = dirtyFiles.filter(isOsEcoStateFile);

				// Auto-commit os-eco runtime state files so they don't block merges
				if (stateFiles.length > 0) {
					await autoCommitStateFiles(repoRoot, stateFiles);
				}
			}

			// Re-check after auto-commit: any remaining dirty tracked files get stashed
			// so clean-merge-eligible branches can proceed without manual intervention.
			let didStash = false;
			const remainingDirty = await checkDirtyWorkingTree(repoRoot);
			if (remainingDirty.length > 0) {
				const { exitCode: stashCode } = await runGit(repoRoot, [
					"stash",
					"push",
					"-m",
					"ov-merge: auto-stash dirty files",
				]);
				if (stashCode !== 0) {
					throw new MergeError(
						`Working tree has uncommitted changes to tracked files: ${remainingDirty.join(", ")}. Commit or stash changes before running ov merge.`,
						{ branchName: entry.branchName },
					);
				}
				didStash = true;
			}

			const warnings: string[] = [];
			let lastTier: ResolutionTier = "clean-merge";
			let conflictFiles: string[] = [];

			try {
				// Delete untracked files overlapping entry.filesModified before merging.
				// git merge refuses to run if untracked files in the working tree would
				// be overwritten by the incoming branch. Deleting them lets the merge
				// proceed and bring in the branch version.
				const { stdout: untrackedOut } = await runGit(repoRoot, [
					"ls-files",
					"--others",
					"--exclude-standard",
				]);
				const untrackedFiles = untrackedOut
					.trim()
					.split("\n")
					.filter((f) => f.length > 0);
				const entryFileSet = new Set(entry.filesModified);
				const overlappingUntracked = untrackedFiles.filter((f) => entryFileSet.has(f));
				for (const file of overlappingUntracked) {
					const filePath = `${repoRoot}/${file}`;
					try {
						if (await Bun.file(filePath).exists()) {
							unlinkSync(filePath);
						}
						warnings.push(
							`untracked file deleted before merge: ${file} (branch version will be used)`,
						);
					} catch {
						// Ignore errors removing untracked files
					}
				}

				// Tier 1: Clean merge
				const cleanResult = await tryCleanMerge(entry, repoRoot);
				if (cleanResult.success) {
					if (options.onMergeSuccess) {
						try {
							await options.onMergeSuccess({
								...entry,
								status: "merged",
								resolvedTier: "clean-merge",
							});
						} catch {
							// callback failures must not fail the merge
						}
					}
					return {
						entry: { ...entry, status: "merged", resolvedTier: "clean-merge" },
						success: true,
						tier: "clean-merge",
						conflictFiles: [],
						errorMessage: null,
						warnings,
					};
				}
				conflictFiles = cleanResult.conflictFiles;

				// Query conflict history (if mulchClient available)
				let history: ConflictHistory = {
					skipTiers: [],
					pastResolutions: [],
					predictedConflictFiles: [],
				};
				if (options.mulchClient) {
					history = await queryConflictHistory(options.mulchClient, entry);
				}

				// Tier 2: Auto-resolve (keep incoming)
				if (!history.skipTiers.includes("auto-resolve")) {
					lastTier = "auto-resolve";
					const autoResult = await tryAutoResolve(conflictFiles, repoRoot);
					if (autoResult.contentDropWarnings.length > 0) {
						warnings.push(...autoResult.contentDropWarnings);
					}
					if (autoResult.success) {
						if (options.mulchClient) {
							recordConflictPattern(
								options.mulchClient,
								entry,
								"auto-resolve",
								conflictFiles,
								true,
							);
						}
						if (options.onMergeSuccess) {
							try {
								await options.onMergeSuccess({
									...entry,
									status: "merged",
									resolvedTier: "auto-resolve",
								});
							} catch {
								// callback failures must not fail the merge
							}
						}
						return {
							entry: { ...entry, status: "merged", resolvedTier: "auto-resolve" },
							success: true,
							tier: "auto-resolve",
							conflictFiles,
							errorMessage: null,
							warnings,
						};
					}
					conflictFiles = autoResult.remainingConflicts;
				} // If skipped, fall through to next tier

				// Tier 3: AI-resolve
				if (options.aiResolveEnabled && !history.skipTiers.includes("ai-resolve")) {
					lastTier = "ai-resolve";
					const aiResult = await tryAiResolve(
						conflictFiles,
						repoRoot,
						history.pastResolutions,
						options.config,
					);
					if (aiResult.success) {
						if (options.mulchClient) {
							recordConflictPattern(options.mulchClient, entry, "ai-resolve", conflictFiles, true);
						}
						if (options.onMergeSuccess) {
							try {
								await options.onMergeSuccess({
									...entry,
									status: "merged",
									resolvedTier: "ai-resolve",
								});
							} catch {
								// callback failures must not fail the merge
							}
						}
						return {
							entry: { ...entry, status: "merged", resolvedTier: "ai-resolve" },
							success: true,
							tier: "ai-resolve",
							conflictFiles,
							errorMessage: null,
							warnings,
						};
					}
					conflictFiles = aiResult.remainingConflicts;
				}

				// Tier 4: Re-imagine
				if (options.reimagineEnabled && !history.skipTiers.includes("reimagine")) {
					lastTier = "reimagine";
					const reimagineResult = await tryReimagine(
						entry,
						canonicalBranch,
						repoRoot,
						options.config,
					);
					if (reimagineResult.success) {
						if (options.mulchClient) {
							recordConflictPattern(options.mulchClient, entry, "reimagine", conflictFiles, true);
						}
						if (options.onMergeSuccess) {
							try {
								await options.onMergeSuccess({
									...entry,
									status: "merged",
									resolvedTier: "reimagine",
								});
							} catch {
								// callback failures must not fail the merge
							}
						}
						return {
							entry: { ...entry, status: "merged", resolvedTier: "reimagine" },
							success: true,
							tier: "reimagine",
							conflictFiles: [],
							errorMessage: null,
							warnings,
						};
					}
				}

				// All enabled tiers failed — abort any in-progress merge
				try {
					await runGit(repoRoot, ["merge", "--abort"]);
				} catch {
					// merge --abort may fail if there's no merge in progress (e.g., after reimagine)
				}

				if (options.mulchClient) {
					recordConflictPattern(options.mulchClient, entry, lastTier, conflictFiles, false);
				}

				return {
					entry: { ...entry, status: "failed", resolvedTier: null },
					success: false,
					tier: lastTier,
					conflictFiles,
					errorMessage: `All enabled resolution tiers failed (last attempted: ${lastTier})`,
					warnings,
				};
			} finally {
				if (didStash) {
					await runGit(repoRoot, ["stash", "pop"]);
				}
			}
		},
	};
}

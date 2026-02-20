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

import { MergeError } from "../errors.ts";
import type { MulchClient } from "../mulch/client.ts";
import type {
	ConflictHistory,
	MergeEntry,
	MergeResult,
	ParsedConflictPattern,
	ResolutionTier,
} from "../types.ts";

export interface MergeResolver {
	/** Attempt to merge the entry's branch into the canonical branch with tiered resolution. */
	resolve(entry: MergeEntry, canonicalBranch: string, repoRoot: string): Promise<MergeResult>;
}

/** Result from an AI one-shot resolution run. */
export interface AiRunnerResult {
	output: string;
	exitCode: number;
}

/** One-shot AI runner abstraction for conflict tiers 3 and 4. */
export type AiRunner = (prompt: string, repoRoot: string) => Promise<AiRunnerResult>;

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
 * Default AI runner uses Claude CLI one-shot mode.
 * Kept as a standalone function so alternate CLIs can be wired in later.
 */
export const runClaudePrompt: AiRunner = async (prompt, repoRoot) => {
	const proc = Bun.spawn(["claude", "--print", "-p", prompt], {
		cwd: repoRoot,
		stdout: "pipe",
		stderr: "pipe",
	});

	const [output, , exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);

	return { output, exitCode };
};

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
 */
async function tryAutoResolve(
	conflictFiles: string[],
	repoRoot: string,
): Promise<{ success: boolean; remainingConflicts: string[] }> {
	const remainingConflicts: string[] = [];

	for (const file of conflictFiles) {
		const filePath = `${repoRoot}/${file}`;

		try {
			const content = await readFile(filePath);
			const resolved = resolveConflictsKeepIncoming(content);

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
		return { success: false, remainingConflicts };
	}

	// All files resolved — commit
	const { exitCode } = await runGit(repoRoot, ["commit", "--no-edit"]);
	return { success: exitCode === 0, remainingConflicts };
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
	aiRunner: AiRunner,
	pastResolutions?: string[],
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

			const { output: resolved, exitCode } = await aiRunner(prompt, repoRoot);

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
	aiRunner: AiRunner,
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

			const { output: reimagined, exitCode } = await aiRunner(prompt, repoRoot);

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
		const searchOutput = await mulchClient.search("merge-conflict");
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
			evidenceBead: entry.beadId,
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
	aiRunner?: AiRunner;
}): MergeResolver {
	const aiRunner = options.aiRunner ?? runClaudePrompt;

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

			let lastTier: ResolutionTier = "clean-merge";
			let conflictFiles: string[] = [];

			// Tier 1: Clean merge
			const cleanResult = await tryCleanMerge(entry, repoRoot);
			if (cleanResult.success) {
				return {
					entry: { ...entry, status: "merged", resolvedTier: "clean-merge" },
					success: true,
					tier: "clean-merge",
					conflictFiles: [],
					errorMessage: null,
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
				if (autoResult.success) {
					if (options.mulchClient) {
						recordConflictPattern(options.mulchClient, entry, "auto-resolve", conflictFiles, true);
					}
					return {
						entry: { ...entry, status: "merged", resolvedTier: "auto-resolve" },
						success: true,
						tier: "auto-resolve",
						conflictFiles,
						errorMessage: null,
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
					aiRunner,
					history.pastResolutions,
				);
				if (aiResult.success) {
					if (options.mulchClient) {
						recordConflictPattern(options.mulchClient, entry, "ai-resolve", conflictFiles, true);
					}
					return {
						entry: { ...entry, status: "merged", resolvedTier: "ai-resolve" },
						success: true,
						tier: "ai-resolve",
						conflictFiles,
						errorMessage: null,
					};
				}
				conflictFiles = aiResult.remainingConflicts;
			}

			// Tier 4: Re-imagine
			if (options.reimagineEnabled && !history.skipTiers.includes("reimagine")) {
				lastTier = "reimagine";
				const reimagineResult = await tryReimagine(entry, canonicalBranch, repoRoot, aiRunner);
				if (reimagineResult.success) {
					if (options.mulchClient) {
						recordConflictPattern(options.mulchClient, entry, "reimagine", conflictFiles, true);
					}
					return {
						entry: { ...entry, status: "merged", resolvedTier: "reimagine" },
						success: true,
						tier: "reimagine",
						conflictFiles: [],
						errorMessage: null,
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
			};
		},
	};
}

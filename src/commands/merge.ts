/**
 * CLI command: overstory merge
 *
 * Merges agent branches back to the canonical branch using
 * the merge queue and tiered conflict resolver.
 *
 * Usage:
 *   overstory merge --branch <name>   Merge a specific branch
 *   overstory merge --all             Merge all pending branches
 *   overstory merge --dry-run         Check for conflicts without merging
 *   overstory merge --json            Output results as JSON
 */

import { join } from "node:path";
import { resolveCliBase } from "../cli-base.ts";
import { loadConfig } from "../config.ts";
import { MergeError, ValidationError } from "../errors.ts";
import { createMergeQueue } from "../merge/queue.ts";
import { createMergeResolver } from "../merge/resolver.ts";
import { createMulchClient } from "../mulch/client.ts";
import type { MergeEntry, MergeResult } from "../types.ts";

/**
 * Parse a named flag value from an args array.
 * Returns the value after the flag, or undefined if not present.
 */
function getFlag(args: string[], flag: string): string | undefined {
	const idx = args.indexOf(flag);
	if (idx === -1 || idx + 1 >= args.length) {
		return undefined;
	}
	return args[idx + 1];
}

/** Check if a boolean flag is present in the args. */
function hasFlag(args: string[], flag: string): boolean {
	return args.includes(flag);
}

/**
 * Extract agent name from a branch following the overstory naming convention.
 * Pattern: overstory/{agentName}/{beadId}
 * Falls back to "unknown" if the pattern does not match.
 */
function parseAgentName(branchName: string): string {
	const parts = branchName.split("/");
	if (parts[0] === "overstory" && parts[1] !== undefined) {
		return parts[1];
	}
	return "unknown";
}

/**
 * Extract bead ID from a branch following the overstory naming convention.
 * Pattern: overstory/{agentName}/{beadId}
 * Falls back to "unknown" if the pattern does not match.
 */
function parseBeadId(branchName: string): string {
	const parts = branchName.split("/");
	if (parts[0] === "overstory" && parts[2] !== undefined) {
		return parts[2];
	}
	return "unknown";
}

/**
 * Detect modified files between a branch and the canonical branch using git diff.
 * Returns an array of file paths that differ.
 */
async function detectModifiedFiles(
	repoRoot: string,
	canonicalBranch: string,
	branchName: string,
): Promise<string[]> {
	const proc = Bun.spawn(["git", "diff", "--name-only", `${canonicalBranch}...${branchName}`], {
		cwd: repoRoot,
		stdout: "pipe",
		stderr: "pipe",
	});
	const exitCode = await proc.exited;

	if (exitCode !== 0) {
		const stderr = await new Response(proc.stderr).text();
		throw new MergeError(
			`Failed to detect modified files for branch "${branchName}": ${stderr.trim()}`,
			{ branchName },
		);
	}

	const stdout = await new Response(proc.stdout).text();
	return stdout
		.trim()
		.split("\n")
		.filter((line) => line.length > 0);
}

/** Format a single merge result for human-readable output. */
function formatResult(result: MergeResult): string {
	const statusIcon = result.success ? "Merged" : "Failed";
	const lines: string[] = [
		`Merging branch: ${result.entry.branchName}`,
		`   Agent: ${result.entry.agentName} | Task: ${result.entry.beadId}`,
		`   Files: ${result.entry.filesModified.length} modified`,
		`   Result: ${statusIcon} (tier: ${result.tier})`,
	];

	if (result.conflictFiles.length > 0) {
		lines.push(`   Conflicts: ${result.conflictFiles.join(", ")}`);
	}

	if (result.errorMessage) {
		lines.push(`   Error: ${result.errorMessage}`);
	}

	return lines.join("\n");
}

/** Format a dry-run report for a merge entry. */
function formatDryRun(entry: MergeEntry): string {
	const lines: string[] = [
		`[dry-run] Branch: ${entry.branchName}`,
		`   Agent: ${entry.agentName} | Task: ${entry.beadId}`,
		`   Status: ${entry.status}`,
		`   Files: ${entry.filesModified.length} modified`,
	];

	if (entry.filesModified.length > 0) {
		for (const f of entry.filesModified) {
			lines.push(`     - ${f}`);
		}
	}

	return lines.join("\n");
}

/**
 * Entry point for `overstory merge [flags]`.
 *
 * Flags:
 *   --branch <name>  Merge a specific branch
 *   --all            Merge all pending branches in the queue
 *   --dry-run        Check for conflicts without actually merging
 *   --json           Output results as JSON
 */
const MERGE_HELP = `overstory merge — Merge agent branches into canonical

Usage: overstory merge --branch <name> | --all [--into <branch>] [--dry-run] [--json]

Options:
  --branch <name>   Merge a specific branch
  --all             Merge all pending branches in the queue
  --into <branch>   Target branch to merge into (default: config canonicalBranch)
  --dry-run         Check for conflicts without actually merging
  --json            Output results as JSON
  --help, -h        Show this help`;

export async function mergeCommand(args: string[]): Promise<void> {
	if (args.includes("--help") || args.includes("-h")) {
		process.stdout.write(`${MERGE_HELP}\n`);
		return;
	}

	const branchName = getFlag(args, "--branch");
	const all = hasFlag(args, "--all");
	const into = getFlag(args, "--into");
	const dryRun = hasFlag(args, "--dry-run");
	const json = hasFlag(args, "--json");

	if (!branchName && !all) {
		throw new ValidationError("Either --branch <name> or --all is required for overstory merge", {
			field: "branch|all",
		});
	}

	const cwd = process.cwd();
	const config = await loadConfig(cwd);

	// Resolution chain: --into flag > session-start branch > config canonicalBranch
	let sessionBranch: string | null = null;
	if (into === undefined) {
		const sessionBranchPath = join(config.project.root, ".overstory", "session-branch.txt");
		const sessionBranchFile = Bun.file(sessionBranchPath);
		if (await sessionBranchFile.exists()) {
			const content = (await sessionBranchFile.text()).trim();
			if (content) {
				sessionBranch = content;
			}
		}
	}
	const targetBranch = into ?? sessionBranch ?? config.project.canonicalBranch;
	const queuePath = join(config.project.root, ".overstory", "merge-queue.db");
	const queue = createMergeQueue(queuePath);
	const mulchClient = createMulchClient(config.project.root);
	const cliBase = resolveCliBase(config);
	const allowClaudeAiMergeTiers = cliBase === "claude";
	const resolver = createMergeResolver({
		aiResolveEnabled: config.merge.aiResolveEnabled && allowClaudeAiMergeTiers,
		reimagineEnabled: config.merge.reimagineEnabled && allowClaudeAiMergeTiers,
		mulchClient,
	});

	if (branchName) {
		await handleBranch(branchName, queue, resolver, config, targetBranch, dryRun, json);
	} else {
		await handleAll(queue, resolver, config, targetBranch, dryRun, json);
	}
}

/**
 * Handle merging a specific branch.
 * If the branch is not in the queue, creates a new entry by detecting
 * agent name, bead ID, and modified files from git.
 */
async function handleBranch(
	branchName: string,
	queue: ReturnType<typeof createMergeQueue>,
	resolver: ReturnType<typeof createMergeResolver>,
	config: Awaited<ReturnType<typeof loadConfig>>,
	targetBranch: string,
	dryRun: boolean,
	json: boolean,
): Promise<void> {
	const canonicalBranch = targetBranch;
	const repoRoot = config.project.root;

	// Look for existing entry in the queue
	const allEntries = queue.list();
	let entry = allEntries.find((e) => e.branchName === branchName) ?? null;

	// If not in queue, create one by detecting info from the branch
	if (entry === null) {
		// Validate that the branch exists before attempting any git operations
		const verifyProc = Bun.spawn(["git", "rev-parse", "--verify", `refs/heads/${branchName}`], {
			cwd: repoRoot,
			stdout: "pipe",
			stderr: "pipe",
		});
		const verifyExit = await verifyProc.exited;
		if (verifyExit !== 0) {
			throw new ValidationError(`Branch "${branchName}" not found`, {
				field: "branch",
				value: branchName,
			});
		}

		const agentName = parseAgentName(branchName);
		const beadId = parseBeadId(branchName);
		const filesModified = await detectModifiedFiles(repoRoot, canonicalBranch, branchName);

		entry = queue.enqueue({
			branchName,
			beadId,
			agentName,
			filesModified,
		});
	}

	if (dryRun) {
		if (json) {
			process.stdout.write(`${JSON.stringify(entry)}\n`);
		} else {
			process.stdout.write(`${formatDryRun(entry)}\n`);
		}
		return;
	}

	// Perform the actual merge
	const result = await resolver.resolve(entry, canonicalBranch, repoRoot);

	// Update queue status based on result
	queue.updateStatus(branchName, result.success ? "merged" : "conflict", result.tier);

	if (json) {
		process.stdout.write(`${JSON.stringify(result)}\n`);
	} else {
		process.stdout.write(`${formatResult(result)}\n`);
	}

	if (!result.success) {
		throw new MergeError(result.errorMessage ?? `Merge failed for branch "${branchName}"`, {
			branchName,
			conflictFiles: result.conflictFiles,
		});
	}
}

/**
 * Handle merging all pending branches in the queue.
 * Processes entries sequentially in FIFO order.
 */
async function handleAll(
	queue: ReturnType<typeof createMergeQueue>,
	resolver: ReturnType<typeof createMergeResolver>,
	config: Awaited<ReturnType<typeof loadConfig>>,
	targetBranch: string,
	dryRun: boolean,
	json: boolean,
): Promise<void> {
	const canonicalBranch = targetBranch;
	const repoRoot = config.project.root;

	const pendingEntries = queue.list("pending");

	if (pendingEntries.length === 0) {
		if (json) {
			process.stdout.write(`${JSON.stringify({ results: [], count: 0 })}\n`);
		} else {
			process.stdout.write("No pending branches to merge.\n");
		}
		return;
	}

	if (dryRun) {
		if (json) {
			process.stdout.write(`${JSON.stringify(pendingEntries)}\n`);
		} else {
			process.stdout.write(
				`${pendingEntries.length} pending branch${pendingEntries.length === 1 ? "" : "es"}:\n\n`,
			);
			for (const entry of pendingEntries) {
				process.stdout.write(`${formatDryRun(entry)}\n\n`);
			}
		}
		return;
	}

	const results: MergeResult[] = [];
	let successCount = 0;
	let failCount = 0;

	for (const entry of pendingEntries) {
		const result = await resolver.resolve(entry, canonicalBranch, repoRoot);

		queue.updateStatus(entry.branchName, result.success ? "merged" : "conflict", result.tier);

		results.push(result);

		if (result.success) {
			successCount++;
		} else {
			failCount++;
		}

		if (!json) {
			process.stdout.write(`${formatResult(result)}\n\n`);
		}
	}

	if (json) {
		process.stdout.write(
			`${JSON.stringify({ results, count: results.length, successCount, failCount })}\n`,
		);
	} else {
		process.stdout.write(
			`Done: ${successCount} merged, ${failCount} failed out of ${results.length} total.\n`,
		);
	}
}

/**
 * CLI command: ov merge
 *
 * Merges agent branches back to the canonical branch using
 * the merge queue and tiered conflict resolver.
 *
 * Usage:
 *   ov merge --branch <name>   Merge a specific branch
 *   ov merge --all             Merge all pending branches
 *   ov merge --dry-run         Check for conflicts without merging
 *   ov merge --json            Output results as JSON
 */

import { join } from "node:path";
import { loadConfig } from "../config.ts";
import { MergeError, ValidationError } from "../errors.ts";
import { jsonOutput } from "../json.ts";
import { accent, printHint } from "../logging/color.ts";
import { createMergeQueue } from "../merge/queue.ts";
import { createMergeResolver } from "../merge/resolver.ts";
import { createMulchClient } from "../mulch/client.ts";
import type { MergeEntry, MergeResult } from "../types.ts";
import { resolveContext } from "../workspace/resolver.ts";

export interface MergeOptions {
	branch?: string;
	all?: boolean;
	into?: string;
	dryRun?: boolean;
	json?: boolean;
	project?: string;
}

/**
 * Extract --project / -p flag from process.argv (global option parsed by parent Commander).
 */
function extractProjectFlag(): string | undefined {
	const args = process.argv;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--project" || arg === "-p") {
			return args[i + 1];
		}
		if (arg?.startsWith("--project=")) {
			return arg.slice("--project=".length);
		}
	}
	return undefined;
}

/**
 * Extract agent name from a branch following the overstory naming convention.
 * Pattern: overstory/{agentName}/{taskId}
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
 * Extract task ID from a branch following the overstory naming convention.
 * Pattern: overstory/{agentName}/{taskId}
 * Falls back to "unknown" if the pattern does not match.
 */
function parseTaskId(branchName: string): string {
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
		`Merging branch: ${accent(result.entry.branchName)}`,
		`   Agent: ${accent(result.entry.agentName)} | Task: ${accent(result.entry.taskId)}`,
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
		`[dry-run] Branch: ${accent(entry.branchName)}`,
		`   Agent: ${accent(entry.agentName)} | Task: ${accent(entry.taskId)}`,
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
 * Entry point for `ov merge [flags]`.
 *
 * @param opts - Command options
 */
export async function mergeCommand(opts: MergeOptions): Promise<void> {
	const branchName = opts.branch;
	const all = opts.all ?? false;
	const into = opts.into;
	const dryRun = opts.dryRun ?? false;
	const json = opts.json ?? false;

	if (!branchName && !all) {
		throw new ValidationError("Either --branch <name> or --all is required for ov merge", {
			field: "branch|all",
		});
	}

	const cwd = process.cwd();
	const config = await loadConfig(cwd);
	const project = opts.project ?? extractProjectFlag();
	const ctx = await resolveContext({ project, requireProject: true });
	const repoRoot = ctx.projectRoot;

	// Resolution chain: --into flag > session-start branch > config canonicalBranch
	let sessionBranch: string | null = null;
	if (into === undefined) {
		const sessionBranchPath = join(ctx.overstoryDir, "session-branch.txt");
		const sessionBranchFile = Bun.file(sessionBranchPath);
		if (await sessionBranchFile.exists()) {
			const content = (await sessionBranchFile.text()).trim();
			if (content) {
				sessionBranch = content;
			}
		}
	}
	const targetBranch = into ?? sessionBranch ?? config.project.canonicalBranch;
	const queuePath = join(ctx.overstoryDir, "merge-queue.db");
	const queue = createMergeQueue(queuePath);
	const mulchClient = createMulchClient(repoRoot);
	const resolver = createMergeResolver({
		aiResolveEnabled: config.merge.aiResolveEnabled,
		reimagineEnabled: config.merge.reimagineEnabled,
		mulchClient,
	});

	if (branchName) {
		await handleBranch(branchName, queue, resolver, repoRoot, targetBranch, dryRun, json);
	} else {
		await handleAll(queue, resolver, repoRoot, targetBranch, dryRun, json);
	}
}

/**
 * Handle merging a specific branch.
 * If the branch is not in the queue, creates a new entry by detecting
 * agent name, task ID, and modified files from git.
 */
async function handleBranch(
	branchName: string,
	queue: ReturnType<typeof createMergeQueue>,
	resolver: ReturnType<typeof createMergeResolver>,
	repoRoot: string,
	targetBranch: string,
	dryRun: boolean,
	json: boolean,
): Promise<void> {
	const canonicalBranch = targetBranch;

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
		const taskId = parseTaskId(branchName);
		const filesModified = await detectModifiedFiles(repoRoot, canonicalBranch, branchName);

		entry = queue.enqueue({
			branchName,
			taskId,
			agentName,
			filesModified,
		});
	}

	if (dryRun) {
		if (json) {
			jsonOutput("merge", { ...entry });
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
		jsonOutput("merge", { ...result });
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
	repoRoot: string,
	targetBranch: string,
	dryRun: boolean,
	json: boolean,
): Promise<void> {
	const canonicalBranch = targetBranch;

	const pendingEntries = queue.list("pending");

	if (pendingEntries.length === 0) {
		if (json) {
			jsonOutput("merge", { results: [], count: 0 });
		} else {
			printHint("No pending branches to merge");
		}
		return;
	}

	if (dryRun) {
		if (json) {
			jsonOutput("merge", { entries: pendingEntries });
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
		jsonOutput("merge", { results, count: results.length, successCount, failCount });
	} else {
		process.stdout.write(
			`Done: ${successCount} merged, ${failCount} failed out of ${results.length} total.\n`,
		);
	}
}

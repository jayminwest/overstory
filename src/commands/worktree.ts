/**
 * CLI command: ov worktree list | clean [--completed] [--all]
 *
 * List shows worktrees with agent status.
 * Clean removes worktree dirs, branch refs (if merged), and tmux sessions.
 * Logs are never auto-deleted.
 */

import { join } from "node:path";
import { Command } from "commander";
import { loadConfig } from "../config.ts";
import { ValidationError } from "../errors.ts";
import { jsonOutput } from "../json.ts";
import { printHint, printSuccess, printWarning } from "../logging/color.ts";
import { createMailStore } from "../mail/store.ts";
import { openSessionStore } from "../sessions/compat.ts";
import type { AgentSession } from "../types.ts";
import {
	isBranchMerged,
	listWorktrees,
	preserveSeedsChanges,
	removeWorktree,
} from "../worktree/manager.ts";
import { getSessionManager } from "../worktree/session-factory.ts";

/**
 * Handle `ov worktree list`.
 */
async function handleList(root: string, json: boolean): Promise<void> {
	const worktrees = await listWorktrees(root);
	const overstoryDir = join(root, ".overstory");
	const { store } = openSessionStore(overstoryDir);
	let sessions: AgentSession[];
	try {
		sessions = store.getAll();
	} finally {
		store.close();
	}

	const overstoryWts = worktrees.filter((wt) => wt.branch.startsWith("overstory/"));

	if (json) {
		const entries = overstoryWts.map((wt) => {
			const session = sessions.find((s) => s.worktreePath === wt.path);
			return {
				path: wt.path,
				branch: wt.branch,
				head: wt.head,
				agentName: session?.agentName ?? null,
				state: session?.state ?? null,
				taskId: session?.taskId ?? null,
			};
		});
		jsonOutput("worktree list", { worktrees: entries });
		return;
	}

	if (overstoryWts.length === 0) {
		printHint("No agent worktrees found");
		return;
	}

	process.stdout.write(`Agent worktrees: ${overstoryWts.length}\n\n`);
	for (const wt of overstoryWts) {
		const session = sessions.find((s) => s.worktreePath === wt.path);
		const state = session?.state ?? "unknown";
		const agent = session?.agentName ?? "?";
		const bead = session?.taskId ?? "?";
		process.stdout.write(`  ${wt.branch}\n`);
		process.stdout.write(`    Agent: ${agent} | State: ${state} | Task: ${bead}\n`);
		process.stdout.write(`    Path: ${wt.path}\n\n`);
	}
}

/**
 * Handle `ov worktree clean [--completed] [--all] [--force]`.
 */
async function handleClean(
	opts: { all: boolean; force: boolean; completedOnly: boolean },
	root: string,
	json: boolean,
	canonicalBranch: string,
): Promise<void> {
	const { force, completedOnly } = opts;

	const worktrees = await listWorktrees(root);
	const overstoryDir = join(root, ".overstory");
	const { store } = openSessionStore(overstoryDir);

	let sessions: AgentSession[];
	try {
		sessions = store.getAll();
	} catch {
		store.close();
		return;
	}

	const overstoryWts = worktrees.filter((wt) => wt.branch.startsWith("overstory/"));
	const cleaned: string[] = [];
	const failed: string[] = [];
	const skipped: string[] = [];
	const seedsPreserved: string[] = [];

	try {
		for (const wt of overstoryWts) {
			const session = sessions.find((s) => s.worktreePath === wt.path);

			// If --completed (default), only clean worktrees whose agent is done/zombie
			if (completedOnly && session && session.state !== "completed" && session.state !== "zombie") {
				continue;
			}

			// Lead branches are never merged via the normal pipeline — skip merge check for leads.
			const isLead = session?.capability === "lead";

			// Check if the branch has been merged into the canonical branch (unless --force or lead)
			if (!force && !isLead && wt.branch.length > 0) {
				let merged = false;
				try {
					merged = await isBranchMerged(root, wt.branch, canonicalBranch);
				} catch {
					// If we can't determine merge status, treat as unmerged (safe default)
					merged = false;
				}

				if (!merged) {
					skipped.push(wt.branch);
					continue;
				}
			}

			// If --all, clean everything
			// Kill tmux session if still alive
			if (session?.tmuxSession) {
				const sm = await getSessionManager();
				const alive = await sm.isSessionAlive(session.tmuxSession);
				if (alive) {
					try {
						await sm.killSession(session.tmuxSession);
					} catch {
						// Best effort
					}
				}
			}

			// Warn about force-deleting unmerged branch (non-lead only)
			if (force && !isLead && wt.branch.length > 0) {
				let merged = false;
				try {
					merged = await isBranchMerged(root, wt.branch, canonicalBranch);
				} catch {
					merged = false;
				}
				if (!merged && !json) {
					printWarning("Force-deleting unmerged branch", wt.branch);
				}
			}

			// Preserve .seeds/ changes from lead worktrees before removal.
			// Lead branches are never merged, so .seeds/ files would otherwise be lost.
			if (isLead && wt.branch.length > 0) {
				const result = await preserveSeedsChanges(
					root,
					wt.branch,
					canonicalBranch,
					session?.agentName ?? "unknown-lead",
				);
				if (result.preserved) {
					seedsPreserved.push(wt.branch);
					if (!json) {
						printSuccess("Preserved .seeds/ changes", session?.agentName ?? "unknown-lead");
					}
				} else if (result.error) {
					printWarning(`Failed to preserve .seeds/ from ${wt.branch}`, result.error);
				}
			}

			// Remove worktree and its branch.
			// Always force worktree removal since deployed .claude/ files create untracked
			// files that cause non-forced removal to fail.
			// Always force-delete the branch since we're cleaning up finished/zombie agents
			// whose branches are typically unmerged.
			try {
				await removeWorktree(root, wt.path, { force: true, forceBranch: true });
				cleaned.push(wt.branch);

				if (!json) {
					printSuccess("Removed", wt.branch);
				}
			} catch (err) {
				failed.push(wt.branch);
				if (!json) {
					const msg = err instanceof Error ? err.message : String(err);
					printWarning(`Failed to remove ${wt.branch}`, msg);
				}
			}
		}

		// Purge mail for cleaned agents
		let mailPurged = 0;
		if (cleaned.length > 0) {
			const mailDbPath = join(root, ".overstory", "mail.db");
			const mailDbFile = Bun.file(mailDbPath);
			if (await mailDbFile.exists()) {
				const mailStore = createMailStore(mailDbPath);
				try {
					for (const branch of cleaned) {
						const session = sessions.find((s) => s.branchName === branch);
						if (session) {
							mailPurged += mailStore.purge({ agent: session.agentName });
						}
					}
				} finally {
					mailStore.close();
				}
			}
		}

		// Mark cleaned sessions as zombie in the SessionStore
		for (const branch of cleaned) {
			const session = sessions.find((s) => s.branchName === branch);
			if (session) {
				store.updateState(session.agentName, "zombie");
			}
		}

		// Prune zombie entries whose worktree paths no longer exist on disk.
		// This prevents the session store from growing unbounded with stale entries.
		const remainingWorktrees = await listWorktrees(root);
		const worktreePaths = new Set(remainingWorktrees.map((wt) => wt.path));
		let pruneCount = 0;

		// Re-read sessions after state updates to get current zombie list
		const currentSessions = store.getAll();
		for (const session of currentSessions) {
			if (session.state === "zombie" && !worktreePaths.has(session.worktreePath)) {
				store.remove(session.agentName);
				pruneCount++;
			}
		}

		if (json) {
			jsonOutput("worktree clean", {
				cleaned,
				failed,
				skipped,
				pruned: pruneCount,
				mailPurged,
				seedsPreserved,
			});
		} else if (
			cleaned.length === 0 &&
			pruneCount === 0 &&
			failed.length === 0 &&
			skipped.length === 0 &&
			seedsPreserved.length === 0
		) {
			printHint("No worktrees to clean");
		} else {
			if (cleaned.length > 0) {
				printSuccess(`Cleaned ${cleaned.length} worktree${cleaned.length === 1 ? "" : "s"}`);
			}
			if (failed.length > 0) {
				printWarning(`Failed to clean ${failed.length} worktree${failed.length === 1 ? "" : "s"}`);
			}
			if (mailPurged > 0) {
				printSuccess(
					`Purged ${mailPurged} mail message${mailPurged === 1 ? "" : "s"} from cleaned agents`,
				);
			}
			if (pruneCount > 0) {
				printSuccess(
					`Pruned ${pruneCount} zombie session${pruneCount === 1 ? "" : "s"} from store`,
				);
			}
			if (seedsPreserved.length > 0) {
				printSuccess(
					`Preserved .seeds/ from ${seedsPreserved.length} lead${seedsPreserved.length === 1 ? "" : "s"}`,
				);
			}
			if (skipped.length > 0) {
				printWarning(
					`Skipped ${skipped.length} worktree${skipped.length === 1 ? "" : "s"} with unmerged branches`,
				);
				for (const branch of skipped) {
					process.stdout.write(`  ${branch}\n`);
				}
				printHint("Use --force to delete unmerged branches");
			}
		}
	} finally {
		store.close();
	}
}

export function createWorktreeCommand(): Command {
	const cmd = new Command("worktree").description("Manage agent worktrees");

	cmd
		.command("list")
		.description("List worktrees with agent status")
		.option("--json", "Output as JSON")
		.action(async (opts: { json?: boolean }) => {
			const cwd = process.cwd();
			const config = await loadConfig(cwd);
			await handleList(config.project.root, opts.json ?? false);
		});

	cmd
		.command("clean")
		.description("Remove completed worktrees")
		.option("--completed", "Only finished agents (default)")
		.option("--all", "Force remove all worktrees")
		.option("--force", "Delete even if branches are unmerged")
		.option("--json", "Output as JSON")
		.action(
			async (opts: { completed?: boolean; all?: boolean; force?: boolean; json?: boolean }) => {
				const cwd = process.cwd();
				const config = await loadConfig(cwd);
				const all = opts.all ?? false;
				await handleClean(
					{
						all,
						force: opts.force ?? false,
						completedOnly: opts.completed ?? !all,
					},
					config.project.root,
					opts.json ?? false,
					config.project.canonicalBranch,
				);
			},
		);

	return cmd;
}

/**
 * Entry point for `ov worktree <subcommand> [flags]`.
 *
 * Subcommands: list, clean.
 */
export async function worktreeCommand(args: string[]): Promise<void> {
	const cmd = createWorktreeCommand();
	cmd.exitOverride();

	if (args.length === 0) {
		process.stdout.write(cmd.helpInformation());
		return;
	}

	try {
		await cmd.parseAsync(args, { from: "user" });
	} catch (err: unknown) {
		if (err && typeof err === "object" && "code" in err) {
			const code = (err as { code: string }).code;
			if (code === "commander.helpDisplayed" || code === "commander.version") {
				return;
			}
			if (code === "commander.unknownCommand") {
				const message = err instanceof Error ? err.message : String(err);
				throw new ValidationError(message, { field: "subcommand" });
			}
		}
		throw err;
	}
}

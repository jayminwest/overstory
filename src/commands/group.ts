/**
 * CLI command: ov group create|status|add|remove|list
 *
 * Manages TaskGroups for batch work coordination. Groups track collections
 * of issues and auto-close when all member issues are closed.
 *
 * Storage: `.overstory/groups.json` (array of TaskGroup objects).
 */

import { join } from "node:path";
import { Command } from "commander";
import { loadConfig } from "../config.ts";
import { GroupError, ValidationError } from "../errors.ts";
import { jsonOutput } from "../json.ts";
import { accent, printHint, printSuccess } from "../logging/color.ts";
import { createTrackerClient, resolveBackend, type TrackerClient } from "../tracker/factory.ts";
import type { TaskGroup, TaskGroupProgress } from "../types.ts";

/**
 * Resolve the groups.json path from the project root.
 */
function groupsPath(projectRoot: string): string {
	return join(projectRoot, ".overstory", "groups.json");
}

/**
 * Load groups from .overstory/groups.json.
 * @internal Exported for testing.
 */
export async function loadGroups(projectRoot: string): Promise<TaskGroup[]> {
	const path = groupsPath(projectRoot);
	const file = Bun.file(path);
	if (!(await file.exists())) {
		return [];
	}
	try {
		const text = await file.text();
		return JSON.parse(text) as TaskGroup[];
	} catch {
		return [];
	}
}

/**
 * Save groups to .overstory/groups.json.
 */
async function saveGroups(projectRoot: string, groups: TaskGroup[]): Promise<void> {
	const path = groupsPath(projectRoot);
	await Bun.write(path, `${JSON.stringify(groups, null, "\t")}\n`);
}

/**
 * Query a tracker issue status via the tracker client.
 * Returns the status string, or null if the issue cannot be found.
 */
async function getIssueStatus(id: string, tracker: TrackerClient): Promise<string | null> {
	try {
		const issue = await tracker.show(id);
		return issue.status ?? null;
	} catch {
		return null;
	}
}

/**
 * Validate that a tracker issue exists.
 */
async function validateIssueExists(id: string, tracker: TrackerClient): Promise<void> {
	const status = await getIssueStatus(id, tracker);
	if (status === null) {
		throw new GroupError(`Issue "${id}" not found in tracker`, { groupId: id });
	}
}

/**
 * Generate a group ID.
 */
function generateGroupId(): string {
	return `group-${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * Resolve a group by ID or name.
 *
 * Names are not enforced unique by `createGroup`, so live `groups.json` files
 * contain duplicate names — a naive name lookup would silently pick the wrong
 * group. Resolution precedence:
 *   1. Exact ID match wins (UUIDs are unambiguous).
 *   2. Otherwise filter by name. If exactly one match, return it.
 *   3. If multiple name matches, prefer a single `active` one. If still
 *      ambiguous, throw with the matching IDs so the caller can disambiguate
 *      by passing the UUID.
 *
 * @internal Exported for testing.
 */
export function resolveGroup(groups: TaskGroup[], identifier: string): TaskGroup {
	const byId = groups.find((g) => g.id === identifier);
	if (byId) return byId;

	const byName = groups.filter((g) => g.name === identifier);
	if (byName.length === 1) {
		const only = byName[0];
		if (only) return only;
	}
	if (byName.length > 1) {
		const active = byName.filter((g) => g.status === "active");
		if (active.length === 1) {
			const only = active[0];
			if (only) return only;
		}
		const ids = byName.map((g) => g.id).join(", ");
		throw new GroupError(
			`Group name "${identifier}" is ambiguous (matches: ${ids}). Use the group ID.`,
			{ groupId: identifier },
		);
	}
	throw new GroupError(`Group "${identifier}" not found`, { groupId: identifier });
}

/**
 * Create a new task group.
 * @internal Exported for testing.
 */
export async function createGroup(
	projectRoot: string,
	name: string,
	issueIds: string[],
	skipValidation = false,
	tracker?: TrackerClient,
): Promise<TaskGroup> {
	if (!name || name.trim().length === 0) {
		throw new ValidationError("Group name is required", { field: "name" });
	}
	if (issueIds.length === 0) {
		throw new ValidationError("At least one issue ID is required", { field: "issueIds" });
	}

	// Validate all issues exist
	if (!skipValidation && tracker) {
		for (const id of issueIds) {
			await validateIssueExists(id, tracker);
		}
	}

	// Check for duplicate issue IDs in the input
	const unique = new Set(issueIds);
	if (unique.size !== issueIds.length) {
		throw new ValidationError("Duplicate issue IDs provided", { field: "issueIds" });
	}

	const groups = await loadGroups(projectRoot);
	const group: TaskGroup = {
		id: generateGroupId(),
		name: name.trim(),
		memberIssueIds: issueIds,
		status: "active",
		createdAt: new Date().toISOString(),
		completedAt: null,
	};
	groups.push(group);
	await saveGroups(projectRoot, groups);
	return group;
}

/**
 * Add issues to an existing group.
 * @internal Exported for testing.
 */
export async function addToGroup(
	projectRoot: string,
	groupId: string,
	issueIds: string[],
	skipValidation = false,
	tracker?: TrackerClient,
): Promise<TaskGroup> {
	if (issueIds.length === 0) {
		throw new ValidationError("At least one issue ID is required", { field: "issueIds" });
	}

	const groups = await loadGroups(projectRoot);
	const group = resolveGroup(groups, groupId);

	// Check for duplicates against existing members
	for (const id of issueIds) {
		if (group.memberIssueIds.includes(id)) {
			throw new GroupError(`Issue "${id}" is already a member of group "${group.id}"`, {
				groupId: group.id,
			});
		}
	}

	// Validate issues exist
	if (!skipValidation && tracker) {
		for (const id of issueIds) {
			await validateIssueExists(id, tracker);
		}
	}

	group.memberIssueIds.push(...issueIds);

	// If group was completed, reopen it
	if (group.status === "completed") {
		group.status = "active";
		group.completedAt = null;
	}

	await saveGroups(projectRoot, groups);
	return group;
}

/**
 * Remove issues from an existing group.
 * @internal Exported for testing.
 */
export async function removeFromGroup(
	projectRoot: string,
	groupId: string,
	issueIds: string[],
): Promise<TaskGroup> {
	if (issueIds.length === 0) {
		throw new ValidationError("At least one issue ID is required", { field: "issueIds" });
	}

	const groups = await loadGroups(projectRoot);
	const group = resolveGroup(groups, groupId);

	// Validate all issues are members
	for (const id of issueIds) {
		if (!group.memberIssueIds.includes(id)) {
			throw new GroupError(`Issue "${id}" is not a member of group "${group.id}"`, {
				groupId: group.id,
			});
		}
	}

	// Check that removal won't empty the group
	const remaining = group.memberIssueIds.filter((id) => !issueIds.includes(id));
	if (remaining.length === 0) {
		throw new GroupError("Cannot remove all issues from a group", { groupId: group.id });
	}

	group.memberIssueIds = remaining;
	await saveGroups(projectRoot, groups);
	return group;
}

/**
 * Get progress for a single group. Queries the tracker for member issue statuses.
 * Auto-closes the group if all members are closed.
 * @internal Exported for testing.
 */
export async function getGroupProgress(
	projectRoot: string,
	group: TaskGroup,
	groups: TaskGroup[],
	tracker?: TrackerClient,
): Promise<TaskGroupProgress> {
	let completed = 0;
	let inProgress = 0;
	let blocked = 0;
	let open = 0;

	for (const id of group.memberIssueIds) {
		const status = tracker ? await getIssueStatus(id, tracker) : null;
		switch (status) {
			case "closed":
				completed++;
				break;
			case "in_progress":
				inProgress++;
				break;
			case "blocked":
				blocked++;
				break;
			default:
				open++;
				break;
		}
	}

	const total = group.memberIssueIds.length;

	// Auto-close: if all members are closed and group is still active
	if (completed === total && total > 0 && group.status === "active") {
		group.status = "completed";
		group.completedAt = new Date().toISOString();
		await saveGroups(projectRoot, groups);
		process.stdout.write(
			`Group "${group.name}" (${accent(group.id)}) auto-closed: all issues done\n`,
		);

		// Notify coordinator via mail (best-effort)
		try {
			const mailDbPath = join(projectRoot, ".overstory", "mail.db");
			const mailDbFile = Bun.file(mailDbPath);
			if (await mailDbFile.exists()) {
				const { createMailStore } = await import("../mail/store.ts");
				const mailStore = createMailStore(mailDbPath);
				try {
					mailStore.insert({
						id: "",
						from: "system",
						to: "coordinator",
						subject: `Group auto-closed: ${group.name}`,
						body: `Task group ${group.id} ("${group.name}") completed. All ${total} member issues are closed.`,
						type: "status",
						priority: "normal",
						threadId: null,
					});
				} finally {
					mailStore.close();
				}
			}
		} catch {
			// Non-fatal: mail notification is best-effort
		}
	}

	return { group, total, completed, inProgress, blocked, open };
}

/**
 * Print a group's progress in human-readable format.
 * @internal Exported for testing.
 */
export function printGroupProgress(progress: TaskGroupProgress): void {
	const w = process.stdout.write.bind(process.stdout);
	const { group, total, completed, inProgress, blocked, open } = progress;
	const status = group.status === "completed" ? "[completed]" : "[active]";
	w(`${group.name} (${accent(group.id)}) ${status}\n`);
	w(`  Issues: ${total} total`);
	w(` | ${completed} completed`);
	w(` | ${inProgress} in_progress`);
	w(` | ${blocked} blocked`);
	w(` | ${open} open\n`);
	if (group.status === "completed" && group.completedAt) {
		w(`  Completed: ${group.completedAt}\n`);
	}
}

/**
 * Create the Commander command for `ov group`.
 */
export function createGroupCommand(): Command {
	const cmd = new Command("group").description("Manage task groups for batch coordination");

	cmd
		.command("create")
		.description("Create a new task group")
		.argument("<name>", "Group name")
		.argument("<ids...>", "Issue IDs to include")
		.option("--json", "Output as JSON")
		.option("--skip-validation", "Skip task validation (for offline use)")
		.action(
			async (name: string, ids: string[], opts: { json?: boolean; skipValidation?: boolean }) => {
				const config = await loadConfig(process.cwd());
				const projectRoot = config.project.root;
				const resolvedBackend = await resolveBackend(config.taskTracker.backend, projectRoot);
				const tracker = createTrackerClient(resolvedBackend, projectRoot);

				const group = await createGroup(
					projectRoot,
					name,
					ids,
					opts.skipValidation ?? false,
					tracker,
				);
				if (opts.json) {
					jsonOutput("group create", { ...group });
				} else {
					printSuccess("Created group", group.name);
					process.stdout.write(
						`  Members: ${group.memberIssueIds.map((id) => accent(id)).join(", ")}\n`,
					);
				}
			},
		);

	cmd
		.command("status")
		.description("Show progress for one or all groups")
		.argument("[group-id-or-name]", "Group ID or name (optional, shows all if omitted)")
		.option("--json", "Output as JSON")
		.option("--skip-validation", "Skip task validation (for offline use)")
		.action(
			async (groupId: string | undefined, opts: { json?: boolean; skipValidation?: boolean }) => {
				const config = await loadConfig(process.cwd());
				const projectRoot = config.project.root;
				const resolvedBackend = await resolveBackend(config.taskTracker.backend, projectRoot);
				const tracker = createTrackerClient(resolvedBackend, projectRoot);
				const json = opts.json ?? false;

				const groups = await loadGroups(projectRoot);

				if (groupId) {
					const group = resolveGroup(groups, groupId);
					const progress = await getGroupProgress(projectRoot, group, groups, tracker);
					if (json) {
						jsonOutput("group status", { ...progress });
					} else {
						printGroupProgress(progress);
					}
				} else {
					const activeGroups = groups.filter((g) => g.status === "active");
					if (activeGroups.length === 0) {
						if (json) {
							jsonOutput("group status", { groups: [] });
						} else {
							printHint("No active groups");
						}
						return;
					}
					const progressList: TaskGroupProgress[] = [];
					for (const group of activeGroups) {
						const progress = await getGroupProgress(projectRoot, group, groups, tracker);
						progressList.push(progress);
					}
					if (json) {
						jsonOutput("group status", { groups: progressList });
					} else {
						for (const progress of progressList) {
							printGroupProgress(progress);
							process.stdout.write("\n");
						}
					}
				}
			},
		);

	cmd
		.command("add")
		.description("Add issues to a group")
		.argument("<group-id-or-name>", "Group ID or name")
		.argument("<ids...>", "Issue IDs to add")
		.option("--json", "Output as JSON")
		.option("--skip-validation", "Skip task validation (for offline use)")
		.action(
			async (
				groupId: string,
				ids: string[],
				opts: { json?: boolean; skipValidation?: boolean },
			) => {
				const config = await loadConfig(process.cwd());
				const projectRoot = config.project.root;
				const resolvedBackend = await resolveBackend(config.taskTracker.backend, projectRoot);
				const tracker = createTrackerClient(resolvedBackend, projectRoot);

				const group = await addToGroup(
					projectRoot,
					groupId,
					ids,
					opts.skipValidation ?? false,
					tracker,
				);
				if (opts.json) {
					jsonOutput("group add", { ...group });
				} else {
					printSuccess("Added to group", group.name);
					process.stdout.write(
						`  Members: ${group.memberIssueIds.map((id) => accent(id)).join(", ")}\n`,
					);
				}
			},
		);

	cmd
		.command("remove")
		.description("Remove issues from a group")
		.argument("<group-id-or-name>", "Group ID or name")
		.argument("<ids...>", "Issue IDs to remove")
		.option("--json", "Output as JSON")
		.action(async (groupId: string, ids: string[], opts: { json?: boolean }) => {
			const config = await loadConfig(process.cwd());
			const projectRoot = config.project.root;

			const group = await removeFromGroup(projectRoot, groupId, ids);
			if (opts.json) {
				jsonOutput("group remove", { ...group });
			} else {
				printSuccess("Removed from group", group.name);
				process.stdout.write(
					`  Members: ${group.memberIssueIds.map((id) => accent(id)).join(", ")}\n`,
				);
			}
		});

	cmd
		.command("list")
		.description("List all groups (summary)")
		.option("--json", "Output as JSON")
		.action(async (opts: { json?: boolean }) => {
			const config = await loadConfig(process.cwd());
			const projectRoot = config.project.root;

			const groups = await loadGroups(projectRoot);
			if (groups.length === 0) {
				if (opts.json) {
					process.stdout.write("[]\n");
				} else {
					printHint("No groups");
				}
				return;
			}
			if (opts.json) {
				jsonOutput("group list", { groups });
			} else {
				for (const group of groups) {
					const status = group.status === "completed" ? "[completed]" : "[active]";
					process.stdout.write(
						`${accent(group.id)} ${status} "${group.name}" (${group.memberIssueIds.length} issues)\n`,
					);
				}
			}
		});

	return cmd;
}

/**
 * Entry point for `ov group <subcommand>`.
 */
export async function groupCommand(args: string[]): Promise<void> {
	const cmd = createGroupCommand();
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

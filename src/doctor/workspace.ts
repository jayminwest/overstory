import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadWorkspaceConfig, resolveWorkspaceRoot, WORKSPACE_DIR } from "../workspace/config.ts";
import type { DoctorCheck, DoctorCheckFn } from "./types.ts";

/**
 * Workspace health checks.
 * In single-repo mode (no workspace), returns a single PASS noting checks are skipped.
 * In workspace mode, validates workspace.yaml, registered projects, shared DBs,
 * project_id consistency, and basic mail connectivity.
 */
export const checkWorkspace: DoctorCheckFn = async (
	_config,
	_overstoryDir,
): Promise<DoctorCheck[]> => {
	const workspaceRoot = resolveWorkspaceRoot(process.cwd());

	if (workspaceRoot === null) {
		return [
			{
				name: "workspace mode",
				category: "workspace",
				status: "pass",
				message: "Workspace checks skipped (single-repo mode)",
			},
		];
	}

	const checks: DoctorCheck[] = [];
	const dbRoot = join(workspaceRoot, WORKSPACE_DIR);

	// 1. workspace-config: validate workspace.yaml is parseable and passes validation
	let registeredProjects: string[] = [];
	try {
		const wsConfig = await loadWorkspaceConfig(workspaceRoot);
		registeredProjects = wsConfig.projects.map((p) => p.name);
		checks.push({
			name: "workspace-config",
			category: "workspace",
			status: "pass",
			message: `Workspace config valid (${wsConfig.projects.length} project${wsConfig.projects.length === 1 ? "" : "s"} registered)`,
		});

		// 2. workspace-projects: each registered project root exists, is git, has .overstory/
		const projectIssues: string[] = [];
		for (const project of wsConfig.projects) {
			if (!existsSync(project.root)) {
				projectIssues.push(`${project.name}: root does not exist (${project.root})`);
				continue;
			}
			if (!existsSync(join(project.root, ".git"))) {
				projectIssues.push(`${project.name}: not a git repository (${project.root})`);
				continue;
			}
			if (!existsSync(join(project.root, ".overstory"))) {
				projectIssues.push(
					`${project.name}: .overstory/ not initialized (run 'ov init' in ${project.root})`,
				);
			}
		}

		if (projectIssues.length > 0) {
			checks.push({
				name: "workspace-projects",
				category: "workspace",
				status: "fail",
				message: `${projectIssues.length} project${projectIssues.length === 1 ? "" : "s"} have issues`,
				details: projectIssues,
				fixable: false,
			});
		} else {
			checks.push({
				name: "workspace-projects",
				category: "workspace",
				status: "pass",
				message: `All ${wsConfig.projects.length} registered project${wsConfig.projects.length === 1 ? "" : "s"} are valid`,
			});
		}
	} catch (err) {
		checks.push({
			name: "workspace-config",
			category: "workspace",
			status: "fail",
			message: "Failed to load or validate workspace.yaml",
			details: [err instanceof Error ? err.message : String(err)],
			fixable: false,
		});
	}

	// 3. workspace-databases: check shared DBs exist and are readable
	const sharedDbs = ["mail.db", "sessions.db", "events.db", "metrics.db"];
	const missingDbs: string[] = [];
	const unreadableDbs: string[] = [];

	for (const dbName of sharedDbs) {
		const dbPath = join(dbRoot, dbName);
		if (!existsSync(dbPath)) {
			missingDbs.push(dbName);
			continue;
		}
		let db: Database | null = null;
		try {
			db = new Database(dbPath, { readonly: true });
			db.prepare("SELECT 1").get();
			db.close();
		} catch (err) {
			if (db) {
				try {
					db.close();
				} catch {
					/* ignore */
				}
			}
			unreadableDbs.push(`${dbName}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	if (missingDbs.length > 0 || unreadableDbs.length > 0) {
		const details: string[] = [];
		if (missingDbs.length > 0) {
			details.push(`Missing: ${missingDbs.join(", ")}`);
		}
		for (const issue of unreadableDbs) {
			details.push(issue);
		}
		checks.push({
			name: "workspace-databases",
			category: "workspace",
			status: missingDbs.length > 0 ? "fail" : "warn",
			message: "Workspace shared database issues detected",
			details,
		});
	} else {
		checks.push({
			name: "workspace-databases",
			category: "workspace",
			status: "pass",
			message: "All workspace shared databases are accessible",
		});
	}

	// 4. workspace-project-id-consistency: query sessions.db for unknown project_ids
	if (registeredProjects.length > 0) {
		const sessionsDbPath = join(dbRoot, "sessions.db");
		if (existsSync(sessionsDbPath)) {
			let db: Database | null = null;
			try {
				db = new Database(sessionsDbPath, { readonly: true });

				// Check if project_id column exists in sessions table
				const columns = db.prepare<{ name: string }, []>("PRAGMA table_info(sessions)").all();
				const hasProjectId = columns.some((c) => c.name === "project_id");

				if (hasProjectId) {
					const rows = db
						.prepare<{ project_id: string }, []>(
							"SELECT DISTINCT project_id FROM sessions WHERE project_id IS NOT NULL AND project_id != '_default' AND project_id != '_workspace'",
						)
						.all();

					const orphaned = rows
						.map((r) => r.project_id)
						.filter((id) => !registeredProjects.includes(id));

					if (orphaned.length > 0) {
						checks.push({
							name: "workspace-project-id-consistency",
							category: "workspace",
							status: "warn",
							message: `${orphaned.length} orphaned project_id${orphaned.length === 1 ? "" : "s"} found in sessions.db`,
							details: orphaned.map((id) => `Unknown project_id: '${id}'`),
						});
					} else {
						checks.push({
							name: "workspace-project-id-consistency",
							category: "workspace",
							status: "pass",
							message: "All project_ids in sessions.db match registered projects",
						});
					}
				} else {
					checks.push({
						name: "workspace-project-id-consistency",
						category: "workspace",
						status: "warn",
						message: "sessions.db does not have project_id column (schema may need migration)",
					});
				}

				db.close();
			} catch (err) {
				if (db) {
					try {
						db.close();
					} catch {
						/* ignore */
					}
				}
				checks.push({
					name: "workspace-project-id-consistency",
					category: "workspace",
					status: "warn",
					message: "Could not check project_id consistency in sessions.db",
					details: [err instanceof Error ? err.message : String(err)],
				});
			}
		} else {
			checks.push({
				name: "workspace-project-id-consistency",
				category: "workspace",
				status: "warn",
				message: "sessions.db not found — skipping project_id consistency check",
			});
		}
	}

	// 5. workspace-mail-connectivity: check mail.db has messages with known project_ids
	if (registeredProjects.length > 0) {
		const mailDbPath = join(dbRoot, "mail.db");
		if (existsSync(mailDbPath)) {
			let db: Database | null = null;
			try {
				db = new Database(mailDbPath, { readonly: true });

				// Check if project_id column exists
				const columns = db.prepare<{ name: string }, []>("PRAGMA table_info(messages)").all();
				const hasProjectId = columns.some((c) => c.name === "project_id");

				if (hasProjectId) {
					const rows = db
						.prepare<{ project_id: string }, []>(
							"SELECT DISTINCT project_id FROM messages WHERE project_id IS NOT NULL AND project_id != '_default' AND project_id != '_workspace'",
						)
						.all();

					const knownIds = rows
						.map((r) => r.project_id)
						.filter((id) => registeredProjects.includes(id));

					if (knownIds.length > 0) {
						checks.push({
							name: "workspace-mail-connectivity",
							category: "workspace",
							status: "pass",
							message: `Mail connectivity confirmed for ${knownIds.length} project${knownIds.length === 1 ? "" : "s"}`,
							details: knownIds.map((id) => `Project '${id}' has mail activity`),
						});
					} else {
						checks.push({
							name: "workspace-mail-connectivity",
							category: "workspace",
							status: "warn",
							message:
								"No mail messages found for registered projects (workspace may be newly initialized)",
						});
					}
				} else {
					checks.push({
						name: "workspace-mail-connectivity",
						category: "workspace",
						status: "warn",
						message: "mail.db does not have project_id column (schema may need migration)",
					});
				}

				db.close();
			} catch (err) {
				if (db) {
					try {
						db.close();
					} catch {
						/* ignore */
					}
				}
				checks.push({
					name: "workspace-mail-connectivity",
					category: "workspace",
					status: "warn",
					message: "Could not check mail connectivity",
					details: [err instanceof Error ? err.message : String(err)],
				});
			}
		} else {
			checks.push({
				name: "workspace-mail-connectivity",
				category: "workspace",
				status: "warn",
				message: "mail.db not found — skipping connectivity check",
			});
		}
	}

	return checks;
};

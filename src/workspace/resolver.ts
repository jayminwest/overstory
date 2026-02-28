import { existsSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { resolveProjectRoot } from "../config.ts";
import { ValidationError } from "../errors.ts";
import {
	DEFAULT_PROJECT_ID,
	loadWorkspaceConfig,
	type WorkspaceConfig,
	WORKSPACE_PROJECT_ID,
	resolveWorkspaceRoot,
	WORKSPACE_DIR,
} from "./config.ts";

export interface ResolvedContext {
	mode: "single-repo" | "workspace";
	projectId: string;
	projectRoot: string;
	overstoryDir: string;
	dbRoot: string;
	workspaceRoot: string | null;
	workspaceConfig: WorkspaceConfig | null;
}

export interface ResolveContextOptions {
	project?: string;
	cwd?: string;
	requireProject?: boolean;
}

export async function resolveContext(opts?: ResolveContextOptions): Promise<ResolvedContext> {
	const startDir = opts?.cwd ?? process.cwd();
	const workspaceRoot = resolveWorkspaceRoot(startDir);

	if (workspaceRoot !== null) {
		return resolveWorkspaceContext(startDir, workspaceRoot, opts);
	}

	return resolveSingleRepoContext(startDir, opts);
}

async function resolveWorkspaceContext(
	startDir: string,
	workspaceRoot: string,
	opts?: ResolveContextOptions,
): Promise<ResolvedContext> {
	const workspaceConfig = await loadWorkspaceConfig(workspaceRoot);
	const available = workspaceConfig.projects.map((p) => p.name).join(", ");

	let projectRoot: string;
	let projectId: string;

	if (opts?.project !== undefined) {
		const found = workspaceConfig.projects.find((p) => p.name === opts.project);
		if (!found) {
			throw new ValidationError(`Unknown project: "${opts.project}". Available: ${available}`, {
				field: "project",
				value: opts.project,
			});
		}
		projectRoot = found.root;
		projectId = found.name;
	} else {
		const matches = workspaceConfig.projects.filter((p) => isContainedIn(startDir, p.root));
		if (matches.length === 1) {
			const match = matches[0]!;
			projectRoot = match.root;
			projectId = match.name;
		} else if (matches.length > 1) {
			const deepest = matches.reduce((a, b) => (a.root.length >= b.root.length ? a : b));
			projectRoot = deepest.root;
			projectId = deepest.name;
		} else {
			if (opts?.requireProject) {
				throw new ValidationError(
					`Cannot determine project from cwd. Use --project <name>. Available: ${available}`,
					{ field: "project", value: undefined },
				);
			}
			return {
				mode: "workspace",
				projectId: WORKSPACE_PROJECT_ID,
				projectRoot: workspaceRoot,
				overstoryDir: join(workspaceRoot, ".overstory"),
				dbRoot: join(workspaceRoot, WORKSPACE_DIR),
				workspaceRoot,
				workspaceConfig,
			};
		}
	}

	if (!existsSync(join(projectRoot, ".overstory"))) {
		throw new ValidationError(
			`Project "${projectId}" has no .overstory/ directory. Run ov init in ${projectRoot} first.`,
			{ field: "project", value: projectId },
		);
	}

	return {
		mode: "workspace",
		projectId,
		projectRoot,
		overstoryDir: join(projectRoot, ".overstory"),
		dbRoot: join(workspaceRoot, WORKSPACE_DIR),
		workspaceRoot,
		workspaceConfig,
	};
}

async function resolveSingleRepoContext(
	startDir: string,
	opts?: ResolveContextOptions,
): Promise<ResolvedContext> {
	if (opts?.project !== undefined) {
		console.warn(`Warning: --project flag ignored (no workspace detected at or above ${startDir})`);
	}
	const projectRoot = await resolveProjectRoot(startDir);

	if (!existsSync(join(projectRoot, ".overstory"))) {
		throw new ValidationError(
			`No .overstory/ directory found at ${projectRoot}. Run \`ov init\` first.`,
			{ field: "projectRoot", value: projectRoot },
		);
	}

	return {
		mode: "single-repo",
		projectId: DEFAULT_PROJECT_ID,
		projectRoot,
		overstoryDir: join(projectRoot, ".overstory"),
		dbRoot: join(projectRoot, ".overstory"),
		workspaceRoot: null,
		workspaceConfig: null,
	};
}

function isContainedIn(candidatePath: string, ancestorPath: string): boolean {
	const candidate = resolve(candidatePath);
	const ancestor = resolve(ancestorPath);
	const rel = relative(ancestor, candidate);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

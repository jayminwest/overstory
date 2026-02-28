import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTempDir, createTempGitRepo, runGitInDir } from "../test-helpers.ts";
import { WORKSPACE_DIR } from "./config.ts";
import { resolveContext } from "./resolver.ts";

async function initGitRepo(dir: string): Promise<void> {
	await runGitInDir(".", ["init", "-b", "main", dir]);
}

async function createWorkspace(
	workspaceRoot: string,
	projects: Array<{ name: string; root: string; canonicalBranch?: string }>,
): Promise<void> {
	const wsDir = join(workspaceRoot, WORKSPACE_DIR);
	await mkdir(wsDir, { recursive: true });

	const projectEntries = projects
		.map(
			(p) =>
				`  - name: ${p.name}\n    root: ${p.root}\n    canonicalBranch: ${p.canonicalBranch ?? "main"}`,
		)
		.join("\n");

	const yaml = `name: test-workspace\nprojects:\n${projectEntries}\n`;
	await writeFile(join(wsDir, "workspace.yaml"), yaml);
}

let tmpDirs: string[] = [];

beforeEach(() => {
	tmpDirs = [];
});

afterEach(async () => {
	await Promise.all(tmpDirs.map((d) => cleanupTempDir(d)));
	tmpDirs = [];
});

async function trackTemp(prefix: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	tmpDirs.push(dir);
	return dir;
}

describe("resolveContext - single-repo mode", () => {
	test("returns single-repo mode with _default projectId and dbRoot=.overstory", async () => {
		const rootDir = await createTempGitRepo();
		tmpDirs.push(rootDir);
		await mkdir(join(rootDir, ".overstory"), { recursive: true });

		const ctx = await resolveContext({ cwd: rootDir });
		expect(ctx.mode).toBe("single-repo");
		expect(ctx.projectId).toBe("_default");
		expect(ctx.projectRoot).toBe(rootDir);
		expect(ctx.overstoryDir).toBe(join(rootDir, ".overstory"));
		expect(ctx.dbRoot).toBe(join(rootDir, ".overstory"));
		expect(ctx.workspaceRoot).toBeNull();
		expect(ctx.workspaceConfig).toBeNull();
	});

	test("warns when --project is used in single-repo mode", async () => {
		const rootDir = await createTempGitRepo();
		tmpDirs.push(rootDir);
		await mkdir(join(rootDir, ".overstory"), { recursive: true });

		const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
		try {
			const ctx = await resolveContext({ cwd: rootDir, project: "ignored" });
			expect(ctx.mode).toBe("single-repo");
			expect(ctx.projectId).toBe("_default");
			expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("--project flag ignored"));
		} finally {
			warnSpy.mockRestore();
		}
	});

	test("throws when .overstory/ is missing in single-repo mode", async () => {
		const noInitDir = await createTempGitRepo();
		tmpDirs.push(noInitDir);
		await expect(resolveContext({ cwd: noInitDir })).rejects.toThrow("No .overstory/ directory found");
	});
});

describe("resolveContext - workspace mode", () => {
	test("resolves explicit --project and uses workspace dbRoot", async () => {
		const workspaceRoot = await trackTemp("overstory-ws-");
		const projectADir = join(workspaceRoot, "frontend");
		const projectBDir = join(workspaceRoot, "backend");
		await mkdir(projectADir, { recursive: true });
		await mkdir(projectBDir, { recursive: true });
		await initGitRepo(projectADir);
		await initGitRepo(projectBDir);
		await mkdir(join(projectADir, ".overstory"), { recursive: true });
		await mkdir(join(projectBDir, ".overstory"), { recursive: true });
		await createWorkspace(workspaceRoot, [
			{ name: "frontend", root: projectADir },
			{ name: "backend", root: projectBDir },
		]);

		const ctx = await resolveContext({ cwd: workspaceRoot, project: "frontend" });
		expect(ctx.mode).toBe("workspace");
		expect(ctx.projectId).toBe("frontend");
		expect(ctx.projectRoot).toBe(projectADir);
		expect(ctx.dbRoot).toBe(join(workspaceRoot, ".overstory-workspace"));
	});

	test("auto-detects project when cwd is inside project", async () => {
		const workspaceRoot = await trackTemp("overstory-ws-");
		const projectDir = join(workspaceRoot, "frontend");
		await mkdir(projectDir, { recursive: true });
		await initGitRepo(projectDir);
		await mkdir(join(projectDir, ".overstory"), { recursive: true });
		await createWorkspace(workspaceRoot, [{ name: "frontend", root: projectDir }]);
		const subDir = join(projectDir, "src");
		await mkdir(subDir, { recursive: true });

		const ctx = await resolveContext({ cwd: subDir });
		expect(ctx.mode).toBe("workspace");
		expect(ctx.projectId).toBe("frontend");
		expect(ctx.projectRoot).toBe(projectDir);
	});

	test("returns _workspace when cwd is not inside any project", async () => {
		const workspaceRoot = await trackTemp("overstory-ws-");
		const projectDir = join(workspaceRoot, "frontend");
		await mkdir(projectDir, { recursive: true });
		await initGitRepo(projectDir);
		await mkdir(join(projectDir, ".overstory"), { recursive: true });
		await createWorkspace(workspaceRoot, [{ name: "frontend", root: projectDir }]);

		const ctx = await resolveContext({ cwd: workspaceRoot, requireProject: false });
		expect(ctx.mode).toBe("workspace");
		expect(ctx.projectId).toBe("_workspace");
		expect(ctx.projectRoot).toBe(workspaceRoot);
		expect(ctx.dbRoot).toBe(join(workspaceRoot, ".overstory-workspace"));
	});

	test("throws with available project names when requireProject=true", async () => {
		const workspaceRoot = await trackTemp("overstory-ws-");
		const projectDir = join(workspaceRoot, "frontend");
		await mkdir(projectDir, { recursive: true });
		await initGitRepo(projectDir);
		await mkdir(join(projectDir, ".overstory"), { recursive: true });
		await createWorkspace(workspaceRoot, [{ name: "frontend", root: projectDir }]);

		await expect(resolveContext({ cwd: workspaceRoot, requireProject: true })).rejects.toThrow(
			"Cannot determine project from cwd. Use --project <name>. Available: frontend",
		);
	});

	test("throws for unknown project name", async () => {
		const workspaceRoot = await trackTemp("overstory-ws-");
		const projectDir = join(workspaceRoot, "frontend");
		await mkdir(projectDir, { recursive: true });
		await initGitRepo(projectDir);
		await mkdir(join(projectDir, ".overstory"), { recursive: true });
		await createWorkspace(workspaceRoot, [{ name: "frontend", root: projectDir }]);

		await expect(resolveContext({ cwd: workspaceRoot, project: "backend" })).rejects.toThrow(
			'Unknown project: "backend". Available: frontend',
		);
	});

	test("throws when project has no .overstory/ directory", async () => {
		const workspaceRoot = await trackTemp("overstory-ws-");
		const projectDir = join(workspaceRoot, "frontend");
		await mkdir(projectDir, { recursive: true });
		await initGitRepo(projectDir);
		await createWorkspace(workspaceRoot, [{ name: "frontend", root: projectDir }]);

		await expect(resolveContext({ cwd: workspaceRoot, project: "frontend" })).rejects.toThrow(
			'Project "frontend" has no .overstory/ directory.',
		);
	});

	test("deepest match wins for nested projects", async () => {
		const workspaceRoot = await trackTemp("overstory-nested-ws-");
		const parentDir = join(workspaceRoot, "parent");
		const childDir = join(parentDir, "packages", "child");
		await mkdir(parentDir, { recursive: true });
		await mkdir(childDir, { recursive: true });
		await initGitRepo(parentDir);
		await initGitRepo(childDir);
		await mkdir(join(parentDir, ".overstory"), { recursive: true });
		await mkdir(join(childDir, ".overstory"), { recursive: true });
		await createWorkspace(workspaceRoot, [
			{ name: "parent", root: parentDir },
			{ name: "child", root: childDir },
		]);

		const deepCwd = join(childDir, "src");
		await mkdir(deepCwd, { recursive: true });

		const ctx = await resolveContext({ cwd: deepCwd });
		expect(ctx.projectId).toBe("child");
		expect(ctx.projectRoot).toBe(childDir);
	});
});

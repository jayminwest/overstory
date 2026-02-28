import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTempDir, createTempGitRepo, runGitInDir } from "../test-helpers.ts";
import {
	DEFAULT_PROJECT_ID,
	isWorkspaceMode,
	loadWorkspaceConfig,
	resolveWorkspaceRoot,
	WORKSPACE_CONFIG_FILENAME,
	WORKSPACE_DIR,
	WORKSPACE_PROJECT_ID,
} from "./config.ts";

async function createWorkspaceDir(root: string): Promise<void> {
	await mkdir(join(root, WORKSPACE_DIR), { recursive: true });
}

async function writeWorkspaceYaml(root: string, content: string): Promise<void> {
	await writeFile(join(root, WORKSPACE_DIR, WORKSPACE_CONFIG_FILENAME), content, "utf8");
}

function makeValidYaml(
	workspaceName: string,
	projects: Array<{ name: string; root: string; canonicalBranch?: string }>,
	extra?: string,
): string {
	const projectLines = projects
		.map(
			(p) =>
				`  - name: ${p.name}\n    root: ${p.root}\n    canonicalBranch: ${p.canonicalBranch ?? "main"}`,
		)
		.join("\n");
	return `name: ${workspaceName}\nprojects:\n${projectLines}\n${extra ?? ""}`;
}

let tmpDirs: string[] = [];

beforeEach(() => {
	tmpDirs = [];
});

afterEach(async () => {
	await Promise.all(tmpDirs.map((d) => cleanupTempDir(d)));
	tmpDirs = [];
});

async function makeTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "ov-ws-test-"));
	tmpDirs.push(dir);
	return dir;
}

async function makeTempGitRepo(): Promise<string> {
	const dir = await createTempGitRepo();
	tmpDirs.push(dir);
	return dir;
}

describe("resolveWorkspaceRoot", () => {
	it("returns null when no .overstory-workspace/ exists", async () => {
		const dir = await makeTempDir();
		expect(resolveWorkspaceRoot(dir)).toBeNull();
	});

	it("finds workspace root when .overstory-workspace/ exists in current dir", async () => {
		const dir = await makeTempDir();
		await createWorkspaceDir(dir);
		expect(resolveWorkspaceRoot(dir)).toBe(dir);
	});

	it("finds workspace root when .overstory-workspace/ exists in a parent dir", async () => {
		const dir = await makeTempDir();
		await createWorkspaceDir(dir);
		const child = join(dir, "subdir", "nested");
		await mkdir(child, { recursive: true });
		expect(resolveWorkspaceRoot(child)).toBe(dir);
	});
});

describe("loadWorkspaceConfig", () => {
	it("parses a valid workspace.yaml correctly", async () => {
		const wsRoot = await makeTempDir();
		const repoA = await makeTempGitRepo();
		const repoB = await makeTempGitRepo();

		await createWorkspaceDir(wsRoot);
		await writeWorkspaceYaml(
			wsRoot,
			`${makeValidYaml("my-workspace", [
				{ name: "frontend", root: repoA, canonicalBranch: "main" },
				{ name: "backend", root: repoB, canonicalBranch: "develop" },
			])}maxConcurrentTotal: 10\nmaxDepth: 5\n`,
		);

		const cfg = await loadWorkspaceConfig(wsRoot);
		expect(cfg.name).toBe("my-workspace");
		expect(cfg.projects).toHaveLength(2);
		expect(cfg.projects[0]?.name).toBe("frontend");
		expect(cfg.projects[1]?.name).toBe("backend");
		expect(cfg.maxConcurrentTotal).toBe(10);
		expect(cfg.maxDepth).toBe(5);
	});

	it("resolves relative root paths relative to workspaceRoot", async () => {
		const wsRoot = await makeTempDir();
		const repoDir = join(wsRoot, "my-project");
		await mkdir(repoDir, { recursive: true });
		await runGitInDir(".", ["init", "-b", "main", repoDir]);

		await createWorkspaceDir(wsRoot);
		await writeWorkspaceYaml(
			wsRoot,
			`name: test-ws\nprojects:\n  - name: proj\n    root: ./my-project\n    canonicalBranch: main\n`,
		);

		const cfg = await loadWorkspaceConfig(wsRoot);
		expect(cfg.projects[0]?.root).toBe(repoDir);
	});

	it("throws on missing workspace.yaml", async () => {
		const wsRoot = await makeTempDir();
		await createWorkspaceDir(wsRoot);
		await expect(loadWorkspaceConfig(wsRoot)).rejects.toThrow(/not found/);
	});

	it("throws on duplicate project names", async () => {
		const wsRoot = await makeTempDir();
		const repoA = await makeTempGitRepo();
		const repoB = await makeTempGitRepo();

		await createWorkspaceDir(wsRoot);
		await writeWorkspaceYaml(
			wsRoot,
			makeValidYaml("test-ws", [
				{ name: "same-name", root: repoA },
				{ name: "same-name", root: repoB },
			]),
		);

		await expect(loadWorkspaceConfig(wsRoot)).rejects.toThrow(/duplicate project name/);
	});

	it("throws on project root that is not a git repo", async () => {
		const wsRoot = await makeTempDir();
		const nonGitDir = await makeTempDir();

		await createWorkspaceDir(wsRoot);
		await writeWorkspaceYaml(
			wsRoot,
			`name: test-ws\nprojects:\n  - name: proj\n    root: ${nonGitDir}\n    canonicalBranch: main\n`,
		);

		await expect(loadWorkspaceConfig(wsRoot)).rejects.toThrow(/not a git repository/);
	});

	it("lenient mode skips git and existence checks", async () => {
		const wsRoot = await makeTempDir();
		await createWorkspaceDir(wsRoot);
		await writeWorkspaceYaml(
			wsRoot,
			`name: test-ws\nprojects:\n  - name: proj\n    root: ./missing-dir\n    canonicalBranch: main\n`,
		);

		const cfg = await loadWorkspaceConfig(wsRoot, { lenient: true });
		expect(cfg.projects[0]?.name).toBe("proj");
		expect(cfg.projects[0]?.root).toBe(join(wsRoot, "missing-dir"));
	});
});

describe("isWorkspaceMode", () => {
	it("returns false when no workspace exists", async () => {
		const dir = await makeTempDir();
		expect(isWorkspaceMode(dir)).toBe(false);
	});

	it("returns true when workspace exists", async () => {
		const dir = await makeTempDir();
		await createWorkspaceDir(dir);
		expect(isWorkspaceMode(dir)).toBe(true);
	});
});

describe("exported constants", () => {
	it("exports expected workspace constants", () => {
		expect(WORKSPACE_DIR).toBe(".overstory-workspace");
		expect(WORKSPACE_CONFIG_FILENAME).toBe("workspace.yaml");
		expect(DEFAULT_PROJECT_ID).toBe("_default");
		expect(WORKSPACE_PROJECT_ID).toBe("_workspace");
	});
});

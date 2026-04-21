import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Git environment variables for test repos.
 * Using env vars instead of per-repo `git config` eliminates 2 subprocess
 * spawns per repo creation.
 */
const GIT_TEST_ENV = {
	GIT_AUTHOR_NAME: "Overstory Test",
	GIT_AUTHOR_EMAIL: "test@overstory.dev",
	GIT_COMMITTER_NAME: "Overstory Test",
	GIT_COMMITTER_EMAIL: "test@overstory.dev",
};

/** Env var: absolute path to `sh.exe` if Git’s default relative layout does not apply. */
export const OVERSTORY_TEST_POSIX_SH = "OVERSTORY_TEST_POSIX_SH";

let cachedPosixSh: string | undefined;

/** First existing `sh.exe` next to a Git for Windows `git.exe`, or `undefined`.
 * Prefers `Git\bin\sh.exe` (PATH for `sed`, `grep`, etc.) then `Git\usr\bin\sh.exe`. */
export function posixShExeNextToGitExe(gitExe: string): string | undefined {
	const root = dirname(gitExe);
	const candidates = [
		join(root, "..", "bin", "sh.exe"),
		join(root, "..", "usr", "bin", "sh.exe"),
	];
	for (const p of candidates) {
		if (existsSync(p)) return p;
	}
	return undefined;
}

function resolvePosixShExecutable(): string {
	const override = process.env[OVERSTORY_TEST_POSIX_SH]?.trim();
	if (override) {
		if (existsSync(override)) return override;
		throw new Error(
			`${OVERSTORY_TEST_POSIX_SH} is set to "${override}" but that path does not exist.`,
		);
	}
	if (process.platform !== "win32") {
		return "sh";
	}
	// find where the git for windows executable is, we will use this to find the sh.exe next to it
	const r = spawnSync("where.exe", ["git"], { encoding: "utf8", windowsHide: true });
	if (r.status !== 0 || !r.stdout?.trim()) {
		throw new Error(
			"`where.exe git` failed; install Git for Windows and ensure `git` is on PATH, or set " +
				`${OVERSTORY_TEST_POSIX_SH} to the full path of sh.exe.`,
		);
	}
	for (const line of r.stdout.split(/\r?\n/)) {
		const gitExe = line.trim();
		if (!gitExe) continue;
		const candidate = posixShExeNextToGitExe(gitExe);
		if (candidate) return candidate;
	}
	throw new Error(
		`Could not find bin\\sh.exe or usr\\bin\\sh.exe relative to Git for Windows. Set ${OVERSTORY_TEST_POSIX_SH}.`,
	);
}

/**
 * POSIX shell executable for tests: `sh` on Unix, or Git for Windows `bin\sh.exe` (preferred) / `usr\bin\sh.exe`.
 *
 * On Windows: `where.exe git`, then existing `..\bin\sh.exe` or `..\usr\bin\sh.exe` from each `git.exe`.
 * Override with {@link OVERSTORY_TEST_POSIX_SH}.
 */
export function posixShExecutable(): string {
	if (!cachedPosixSh) {
		cachedPosixSh = resolvePosixShExecutable();
	}
	return cachedPosixSh;
}

/** Cached template repo path. Created lazily on first call. */
let _templateDir: string | null = null;

/**
 * Get or create a template git repo with an initial commit.
 * All test repos clone from this template (1 subprocess instead of 5).
 */
async function getTemplateRepo(): Promise<string> {
	if (_templateDir) return _templateDir;

	const dir = await mkdtemp(join(tmpdir(), "overstory-template-"));
	await runGitInDir(dir, ["init", "-b", "main"]);
	await Bun.write(join(dir, ".gitkeep"), "");
	await runGitInDir(dir, ["add", ".gitkeep"]);
	await runGitInDir(dir, ["commit", "-m", "initial commit"]);

	_templateDir = dir;
	return dir;
}

/**
 * Create a temporary directory with a real git repo initialized.
 * Includes an initial commit so branches can be created immediately.
 *
 * Uses a cached template repo + `git clone --local` for speed:
 * 1 subprocess per call instead of 5.
 *
 * @returns The absolute path to the temp git repo.
 */
export async function createTempGitRepo(): Promise<string> {
	const template = await getTemplateRepo();
	const dir = await mkdtemp(join(tmpdir(), "overstory-test-"));
	// Clone into the empty dir. Avoid --local (hardlinks trigger EFAULT in Bun's rm).
	await runGitInDir(".", ["clone", template, dir]);
	// Set git identity at repo level so code that doesn't use GIT_TEST_ENV
	// (e.g., resolver's runGit) can still commit. Locally this is covered by
	// ~/.gitconfig, but CI runners have no global git identity.
	await runGitInDir(dir, ["config", "user.name", "Overstory Test"]);
	await runGitInDir(dir, ["config", "user.email", "test@overstory.dev"]);
	return dir;
}

/**
 * Add and commit a file to a git repo.
 *
 * @param repoDir - Absolute path to the git repo
 * @param filePath - Relative path within the repo (e.g. "src/foo.ts")
 * @param content - File content to write
 * @param message - Commit message (defaults to "add {filePath}")
 */
export async function commitFile(
	repoDir: string,
	filePath: string,
	content: string,
	message?: string,
): Promise<void> {
	const fullPath = join(repoDir, filePath);

	// Ensure parent directories exist
	const parentDir = join(fullPath, "..");
	const { mkdir } = await import("node:fs/promises");
	await mkdir(parentDir, { recursive: true });

	await Bun.write(fullPath, content);
	await runGitInDir(repoDir, ["add", filePath]);
	await runGitInDir(repoDir, ["commit", "-m", message ?? `add ${filePath}`]);
}

/**
 * Get the default branch name of a git repo (e.g., "main" or "master").
 * Uses `git symbolic-ref --short HEAD` to read the current branch.
 *
 * Useful in tests to avoid hardcoding "main" -- CI runners may default to "master".
 */
export async function getDefaultBranch(repoDir: string): Promise<string> {
	const stdout = await runGitInDir(repoDir, ["symbolic-ref", "--short", "HEAD"]);
	return stdout.trim();
}

/**
 * Remove a temp directory. Safe to call even if the directory doesn't exist.
 *
 * On Windows, SQLite WAL/SHM file handles may linger briefly after db.close(),
 * causing EBUSY errors on immediate rm(). Retries with exponential backoff
 * (up to ~1.5s total) to handle this OS-level timing issue.
 */
export async function cleanupTempDir(dir: string): Promise<void> {
	const maxRetries = process.platform === "win32" ? 5 : 0;
	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		try {
			await rm(dir, { recursive: true, force: true });
			return;
		} catch (err: unknown) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code === "EBUSY" && attempt < maxRetries) {
				// Exponential backoff: 50, 100, 200, 400, 800ms
				await Bun.sleep(50 * 2 ** attempt);
				continue;
			}
			// Non-EBUSY or final attempt: swallow (temp dirs are cleaned by OS anyway)
			if (code !== "ENOENT") return;
		}
	}
}

/**
 * Run a git command in the given directory. Throws on non-zero exit.
 * Passes GIT_AUTHOR/COMMITTER env vars so repos don't need per-repo config.
 */
export async function runGitInDir(cwd: string, args: string[]): Promise<string> {
	const proc = Bun.spawn(["git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, ...GIT_TEST_ENV },
	});

	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);

	if (exitCode !== 0) {
		throw new Error(`git ${args.join(" ")} failed (exit ${exitCode}): ${stderr.trim()}`);
	}

	return stdout;
}

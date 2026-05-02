/**
 * Scope-violation detection for builder/merger turns (overstory-9f4d).
 *
 * Surfaces a soft, advisory signal when an agent's modified files exceed its
 * declared FILE_SCOPE without an `expansion_reason:` justification. The
 * turn-runner consumes this on terminal-mail observation; the lead reads the
 * `events.db` record during merge verification.
 *
 * This is observability only — never a hard block. All errors are swallowed.
 */

/**
 * Capabilities allowed to modify files. Mirrors the set in
 * `src/agents/hooks-deployer.ts`. Read-only roles (scout, reviewer) do not
 * commit work, so scope detection is a no-op for them. Lead is excluded for
 * the same reason — leads delegate, they don't touch files directly.
 */
export const IMPLEMENTATION_CAPABILITIES: ReadonlySet<string> = new Set(["builder", "merger"]);

/**
 * Synchronous git runner contract. Accepts argv (without the `git` prefix) and
 * a working directory; returns combined stdout. Tests inject a stub; production
 * calls `Bun.spawnSync(["git", ...args], { cwd })`.
 */
export type GitRunner = (args: string[], cwd: string) => string;

const defaultGitRunner: GitRunner = (args, cwd) => {
	const proc = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	if (proc.exitCode !== 0) {
		return "";
	}
	return proc.stdout.toString();
};

/**
 * Return the subset of `modifiedFiles` not covered by any FILE_SCOPE entry.
 *
 * - Empty `fileScope` is treated as unrestricted: returns `[]`.
 * - A file is in scope when any scope entry matches it literally OR when
 *   `new Bun.Glob(entry).match(file)` returns true.
 */
export function findScopeViolations(modifiedFiles: string[], fileScope: string[]): string[] {
	if (fileScope.length === 0) return [];

	const globs: Array<{ entry: string; glob: Bun.Glob }> = [];
	for (const entry of fileScope) {
		try {
			globs.push({ entry, glob: new Bun.Glob(entry) });
		} catch {
			// malformed glob — fall back to literal-only match for this entry
			globs.push({ entry, glob: new Bun.Glob(entry.replace(/[*?[\]{}]/g, "\\$&")) });
		}
	}

	const violations: string[] = [];
	for (const file of modifiedFiles) {
		let matched = false;
		for (const { entry, glob } of globs) {
			if (entry === file) {
				matched = true;
				break;
			}
			try {
				if (glob.match(file)) {
					matched = true;
					break;
				}
			} catch {
				// ignore malformed pattern; continue
			}
		}
		if (!matched) violations.push(file);
	}
	return violations;
}

/**
 * Case-insensitive check for `expansion_reason:` followed by at least one
 * non-whitespace character before the next newline.
 *
 * - Matches `expansion_reason: foo`, `Expansion_Reason: bar`, `EXPANSION_REASON: baz quux`.
 * - Rejects `expansion_reason:` (empty value) and `expansion-reason: foo` (different separator).
 */
export function hasExpansionReason(message: string): boolean {
	return /expansion_reason:[^\S\n]*\S+/i.test(message);
}

/**
 * Parse `expansion_reason:` values from the output of `git log --format=%B <range>`.
 * Returns each value (trimmed) in encounter order. Commits without the marker
 * are ignored.
 */
export function parseExpansionReasonsFromGitLog(log: string): string[] {
	const reasons: string[] = [];
	const re = /expansion_reason:[^\S\n]*([^\n]*\S)/gi;
	let m: RegExpExecArray | null = re.exec(log);
	while (m !== null) {
		const value = m[1]?.trim();
		if (value && value.length > 0) reasons.push(value);
		m = re.exec(log);
	}
	return reasons;
}

export interface DetectScopeViolationOpts {
	worktreePath: string;
	baseRef: string;
	fileScope: string[];
	/** Test injection — replaces `Bun.spawnSync` for git calls. */
	gitRunner?: GitRunner;
}

export interface ScopeViolationResult {
	violations: string[];
	expansionReasons: string[];
}

/**
 * Detect scope violations for a worktree at HEAD relative to `baseRef`.
 *
 * - Runs `git diff --name-only baseRef...HEAD` to enumerate modified files.
 * - Runs `git log --format=%B baseRef..HEAD` and parses `expansion_reason:`
 *   markers from commit bodies.
 *
 * Always returns. Any failure (git error, parse failure) yields
 * `{ violations: [], expansionReasons: [] }` — this is an advisory signal and
 * must never break the runner.
 */
export function detectScopeViolation(opts: DetectScopeViolationOpts): ScopeViolationResult {
	const runner = opts.gitRunner ?? defaultGitRunner;
	try {
		const diffOut = runner(["diff", "--name-only", `${opts.baseRef}...HEAD`], opts.worktreePath);
		const modifiedFiles = diffOut
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0);

		const logOut = runner(["log", "--format=%B", `${opts.baseRef}..HEAD`], opts.worktreePath);
		const expansionReasons = parseExpansionReasonsFromGitLog(logOut);

		const violations = findScopeViolations(modifiedFiles, opts.fileScope);
		return { violations, expansionReasons };
	} catch {
		return { violations: [], expansionReasons: [] };
	}
}

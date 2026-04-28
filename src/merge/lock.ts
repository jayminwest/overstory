/**
 * Sentinel-file lock to prevent concurrent `ov merge` runs against the same
 * canonical (target) branch.
 *
 * Two parallel merges into the same canonical branch can produce a misleading
 * transient view: one merge runs the git operations while the second observes
 * conflict markers mid-merge and reports a false failure. See seeds issue
 * overstory-9610 for the original incident.
 *
 * The lock is a single JSON file at `.overstory/merge-{sanitized-target}.lock`
 * created atomically with `writeFileSync(..., { flag: "wx" })`. If the file
 * already exists, the holder PID is checked: live → fail fast, dead → take
 * over. Released on exit via the returned handle.
 */

import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MergeError } from "../errors.ts";
import { isProcessAlive } from "../worktree/tmux.ts";

export interface MergeLockHandle {
	/** Path to the lock file on disk (useful for diagnostics / tests). */
	readonly path: string;
	/** Release the lock. Idempotent — safe to call multiple times. */
	release(): void;
}

interface LockPayload {
	pid: number;
	acquiredAt: string;
	targetBranch: string;
}

/**
 * Sanitize a branch name for use in a filename.
 * Replaces "/", "\\", and ":" with "-" so `feature/foo` becomes `feature-foo`.
 */
export function sanitizeBranchForFilename(branch: string): string {
	return branch.replace(/[/\\:]/g, "-");
}

/** Compute the lock file path for a given target branch. */
export function mergeLockPath(overstoryDir: string, targetBranch: string): string {
	return join(overstoryDir, `merge-${sanitizeBranchForFilename(targetBranch)}.lock`);
}

/**
 * Acquire the merge lock for a given target branch. Throws `MergeError` if
 * another live `ov merge` is already running against this target. Stale locks
 * (PID no longer alive) are taken over automatically.
 *
 * The caller MUST call `release()` on the returned handle when done.
 */
export function acquireMergeLock(overstoryDir: string, targetBranch: string): MergeLockHandle {
	const path = mergeLockPath(overstoryDir, targetBranch);
	const payload: LockPayload = {
		pid: process.pid,
		acquiredAt: new Date().toISOString(),
		targetBranch,
	};
	const serialized = JSON.stringify(payload);

	const tryCreate = (): boolean => {
		try {
			writeFileSync(path, serialized, { flag: "wx" });
			return true;
		} catch (err: unknown) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code === "EEXIST") return false;
			throw err;
		}
	};

	if (tryCreate()) {
		return makeHandle(path);
	}

	// Lock file exists. Inspect the holder before failing.
	const existing = readLockPayload(path);
	const holderPid = existing?.pid;
	const holderAlive = typeof holderPid === "number" && isProcessAlive(holderPid);

	if (holderAlive) {
		const since = existing?.acquiredAt ?? "unknown time";
		throw new MergeError(
			`Another ov merge is already running for "${targetBranch}" (pid ${holderPid}, acquired ${since}). Wait for it to finish, or remove ${path} if you are sure it is stale.`,
			{ branchName: targetBranch },
		);
	}

	// Stale or unparseable lock — remove and retry once. If a third process
	// won the race in between, surface that as a clear retry-soon error.
	try {
		unlinkSync(path);
	} catch {
		// File may have just been removed by another cleanup — fine.
	}
	if (tryCreate()) {
		return makeHandle(path);
	}

	throw new MergeError(
		`Another ov merge raced to acquire the lock for "${targetBranch}". Retry shortly.`,
		{ branchName: targetBranch },
	);
}

function readLockPayload(path: string): LockPayload | null {
	try {
		const content = readFileSync(path, "utf8");
		const parsed = JSON.parse(content) as unknown;
		if (
			parsed !== null &&
			typeof parsed === "object" &&
			"pid" in parsed &&
			typeof (parsed as { pid: unknown }).pid === "number"
		) {
			return parsed as LockPayload;
		}
		return null;
	} catch {
		return null;
	}
}

function makeHandle(path: string): MergeLockHandle {
	let released = false;
	return {
		path,
		release(): void {
			if (released) return;
			released = true;
			try {
				unlinkSync(path);
			} catch {
				// File may already be gone — not an error.
			}
		},
	};
}

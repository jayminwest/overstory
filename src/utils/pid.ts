/**
 * PID file management for daemon processes.
 */
import { randomUUID } from "node:crypto";
import { link, mkdir, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Read the PID from a PID file.
 * Returns null if the file doesn't exist or can't be parsed.
 */
export async function readPidFile(pidFilePath: string): Promise<number | null> {
	const file = Bun.file(pidFilePath);
	const exists = await file.exists();
	if (!exists) {
		return null;
	}

	try {
		const text = await file.text();
		const pid = Number.parseInt(text.trim(), 10);
		if (Number.isNaN(pid) || pid <= 0) {
			return null;
		}
		return pid;
	} catch {
		return null;
	}
}

/**
 * Write a PID to a PID file.
 */
export async function writePidFile(pidFilePath: string, pid: number): Promise<void> {
	await Bun.write(pidFilePath, `${pid}\n`);
}

/**
 * Remove a PID file.
 */
export async function removePidFile(pidFilePath: string): Promise<void> {
	try {
		await unlink(pidFilePath);
	} catch {
		// File may already be gone — not an error
	}
}

/**
 * Result of acquirePidLock.
 *
 * `acquired: true` — caller owns the lock and is responsible for removing the
 * PID file on shutdown.
 *
 * `acquired: false` — a live foreign process already owns the lock; caller
 * must not start. `existingPid` is the live owner. `existingPid === -1` means
 * the lock file existed but was unreadable and could not be reclaimed.
 */
export type AcquirePidLockResult = { acquired: true } | { acquired: false; existingPid: number };

/**
 * Atomically acquire a PID-file lock.
 *
 * Uses the write-temp-then-link pattern so the lock file appears at its final
 * path with PID contents already present (no empty-file window): a competing
 * reader can never observe an in-flight write. Behavior:
 *
 * - Lock file does not exist → atomic create via link(). Caller owns the lock.
 * - Lock file exists, contains the caller's own PID → idempotent acquire
 *   (caller already owns it; e.g. background-mode parent wrote child.pid
 *   before spawn).
 * - Lock file exists with a live foreign PID → refuse; return existingPid.
 * - Lock file exists with a dead PID (or unreadable) → reclaim by unlinking
 *   and retrying once. If the retry races and loses to a live foreign
 *   watchdog, the call returns acquired=false with that foreign PID.
 *
 * Parent directory is created if missing (matches the implicit Bun.write
 * behavior the legacy writePidFile relied on).
 */
export async function acquirePidLock(
	pidFilePath: string,
	pid: number,
	isAlive: (pid: number) => boolean,
): Promise<AcquirePidLockResult> {
	await mkdir(dirname(pidFilePath), { recursive: true });

	// Stage the PID content at a unique temp path. After link() succeeds, the
	// lock path appears with full content already present.
	const tempPath = `${pidFilePath}.tmp.${pid}.${randomUUID()}`;
	await writeFile(tempPath, `${pid}\n`);

	try {
		// Two attempts: first try, then one stale-lock reclaim retry. A second
		// EEXIST after reclaim means a live foreign process raced in.
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				await link(tempPath, pidFilePath);
				return { acquired: true };
			} catch (err: unknown) {
				const code = (err as NodeJS.ErrnoException | undefined)?.code;
				if (code !== "EEXIST") {
					throw err;
				}
				const existing = await readPidFile(pidFilePath);
				if (existing === null) {
					// Unreadable/corrupted lock file — treat as stale.
					await removePidFile(pidFilePath);
					continue;
				}
				if (existing === pid) {
					// Idempotent: caller already owns it (parent pre-wrote child PID).
					return { acquired: true };
				}
				if (isAlive(existing)) {
					return { acquired: false, existingPid: existing };
				}
				// Stale: reclaim and retry once.
				await removePidFile(pidFilePath);
			}
		}

		// Two stale-then-retry attempts both failed. Another writer raced in
		// between our reclaim and our retry — they own the lock now.
		const existing = await readPidFile(pidFilePath);
		return { acquired: false, existingPid: existing ?? -1 };
	} finally {
		// Drop the temp inode link (lock path retains the data via the second link).
		await unlink(tempPath).catch(() => {});
	}
}

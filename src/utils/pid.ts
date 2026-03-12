/**
 * PID file management for daemon processes.
 */
import { unlink } from "node:fs/promises";

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

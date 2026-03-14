/**
 * Filesystem utility functions for cleanup and state management.
 */
import { readdir, rm, unlink } from "node:fs/promises";
import { join } from "node:path";

/**
 * Delete a SQLite database file and its WAL/SHM companions.
 */
export async function wipeSqliteDb(dbPath: string): Promise<boolean> {
	const extensions = ["", "-wal", "-shm"];
	let wiped = false;
	for (const ext of extensions) {
		try {
			await unlink(`${dbPath}${ext}`);
			if (ext === "") wiped = true;
		} catch {
			// File may not exist
		}
	}
	return wiped;
}

/**
 * Reset a JSON file to an empty array.
 */
export async function resetJsonFile(path: string): Promise<boolean> {
	const file = Bun.file(path);
	if (await file.exists()) {
		await Bun.write(path, "[]\n");
		return true;
	}
	return false;
}

/**
 * Clear all entries inside a directory but keep the directory itself.
 */
export async function clearDirectory(dirPath: string): Promise<boolean> {
	try {
		const entries = await readdir(dirPath);
		for (const entry of entries) {
			await rm(join(dirPath, entry), { recursive: true, force: true });
		}
		return entries.length > 0;
	} catch {
		// Directory may not exist
		return false;
	}
}

/**
 * Delete a single file if it exists.
 */
export async function deleteFile(path: string): Promise<boolean> {
	try {
		await unlink(path);
		return true;
	} catch {
		return false;
	}
}

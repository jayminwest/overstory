import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTempDir } from "../test-helpers.ts";
import { clearDirectory, deleteFile, resetJsonFile, wipeSqliteDb } from "./fs.ts";

let tempDir: string;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), "ov-fs-test-"));
});

afterEach(async () => {
	await cleanupTempDir(tempDir);
});

describe("wipeSqliteDb", () => {
	test("deletes main db and WAL/SHM companion files", async () => {
		const dbPath = join(tempDir, "test-wipe.db");
		const { Database } = await import("bun:sqlite");
		const db = new Database(dbPath);
		db.exec("PRAGMA journal_mode=WAL");
		db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
		db.exec("INSERT INTO t VALUES (1)");
		db.close();

		expect(existsSync(dbPath)).toBe(true);

		const result = await wipeSqliteDb(dbPath);
		expect(result).toBe(true);

		expect(existsSync(dbPath)).toBe(false);
		expect(existsSync(`${dbPath}-wal`)).toBe(false);
		expect(existsSync(`${dbPath}-shm`)).toBe(false);
	});

	test("returns false when db file does not exist", async () => {
		const dbPath = join(tempDir, "nonexistent.db");
		const result = await wipeSqliteDb(dbPath);
		expect(result).toBe(false);
	});
});

describe("resetJsonFile", () => {
	test("resets existing JSON file to empty array", async () => {
		const filePath = join(tempDir, "test-reset.json");
		await Bun.write(filePath, '[{"id":"1"},{"id":"2"}]');

		const result = await resetJsonFile(filePath);
		expect(result).toBe(true);

		const content = await Bun.file(filePath).text();
		expect(content).toBe("[]\n");
	});

	test("returns false for nonexistent file", async () => {
		const filePath = join(tempDir, "nonexistent.json");
		const result = await resetJsonFile(filePath);
		expect(result).toBe(false);
	});
});

describe("clearDirectory", () => {
	test("clears files from a directory", async () => {
		const dirPath = join(tempDir, "clear-test");
		await mkdir(dirPath, { recursive: true });
		await writeFile(join(dirPath, "file1.txt"), "hello");
		await writeFile(join(dirPath, "file2.txt"), "world");

		const result = await clearDirectory(dirPath);
		expect(result).toBe(true);

		const entries = await readdir(dirPath);
		expect(entries).toHaveLength(0);
	});

	test("returns false for empty directory", async () => {
		const dirPath = join(tempDir, "empty-dir");
		await mkdir(dirPath, { recursive: true });

		const result = await clearDirectory(dirPath);
		expect(result).toBe(false);
	});

	test("returns false for nonexistent directory", async () => {
		const result = await clearDirectory(join(tempDir, "no-such-dir"));
		expect(result).toBe(false);
	});

	test("recursively removes subdirectories", async () => {
		const dirPath = join(tempDir, "nested-clear");
		await mkdir(join(dirPath, "sub", "deep"), { recursive: true });
		await writeFile(join(dirPath, "sub", "deep", "file.txt"), "data");

		const result = await clearDirectory(dirPath);
		expect(result).toBe(true);

		const entries = await readdir(dirPath);
		expect(entries).toHaveLength(0);
	});
});

describe("deleteFile", () => {
	test("deletes an existing file", async () => {
		const filePath = join(tempDir, "to-delete.txt");
		await writeFile(filePath, "delete me");

		const result = await deleteFile(filePath);
		expect(result).toBe(true);
		expect(existsSync(filePath)).toBe(false);
	});

	test("returns false for nonexistent file", async () => {
		const result = await deleteFile(join(tempDir, "no-such-file.txt"));
		expect(result).toBe(false);
	});
});

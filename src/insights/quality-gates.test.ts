import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	cleanupTempDir,
	commitFile,
	createTempGitRepo,
	getDefaultBranch,
} from "../test-helpers.ts";
import type { QualityGate } from "../types.ts";
import { hasWorkToVerify, runQualityGates } from "./quality-gates.ts";

describe("runQualityGates", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "qg-test-"));
	});

	afterEach(async () => {
		await cleanupTempDir(tempDir);
	});

	test("returns null when gates list is empty", async () => {
		const result = await runQualityGates([], tempDir);
		expect(result).toBeNull();
	});

	test("status is 'success' when all gates exit 0", async () => {
		const gates: QualityGate[] = [
			{ name: "True", command: "true", description: "always passes" },
			{ name: "Echo", command: "echo ok", description: "always passes" },
		];
		const result = await runQualityGates(gates, tempDir);
		expect(result).not.toBeNull();
		expect(result?.status).toBe("success");
		expect(result?.results).toHaveLength(2);
		expect(result?.results.every((r) => r.passed)).toBe(true);
	});

	test("status is 'failure' when no gates exit 0", async () => {
		const gates: QualityGate[] = [
			{ name: "False1", command: "false", description: "always fails" },
			{ name: "False2", command: "false", description: "always fails" },
		];
		const result = await runQualityGates(gates, tempDir);
		expect(result).not.toBeNull();
		expect(result?.status).toBe("failure");
		expect(result?.results.every((r) => !r.passed)).toBe(true);
	});

	test("status is 'partial' on mixed exit codes", async () => {
		const gates: QualityGate[] = [
			{ name: "Pass", command: "true", description: "passes" },
			{ name: "Fail", command: "false", description: "fails" },
		];
		const result = await runQualityGates(gates, tempDir);
		expect(result).not.toBeNull();
		expect(result?.status).toBe("partial");
		expect(result?.results.filter((r) => r.passed)).toHaveLength(1);
		expect(result?.results.filter((r) => !r.passed)).toHaveLength(1);
	});

	test("a gate that hangs past the timeout is treated as failed", async () => {
		const gates: QualityGate[] = [
			{ name: "Sleeper", command: "sleep 5", description: "intentionally slow" },
		];
		const result = await runQualityGates(gates, tempDir, { timeoutMs: 200 });
		expect(result).not.toBeNull();
		expect(result?.status).toBe("failure");
		expect(result?.results[0]?.passed).toBe(false);
		expect(result?.results[0]?.exitCode).toBe(-1);
		// Should return well before the 5s the gate would otherwise take
		expect(result?.totalDurationMs).toBeLessThan(2_000);
	});

	test("captures per-gate duration and exit code", async () => {
		const gates: QualityGate[] = [{ name: "Quick", command: "true", description: "passes fast" }];
		const result = await runQualityGates(gates, tempDir);
		expect(result?.results[0]?.exitCode).toBe(0);
		expect(result?.results[0]?.durationMs).toBeGreaterThanOrEqual(0);
		expect(result?.totalDurationMs).toBeGreaterThanOrEqual(result?.results[0]?.durationMs ?? 0);
	});
});

describe("hasWorkToVerify", () => {
	let repoDir: string;

	beforeEach(async () => {
		repoDir = await createTempGitRepo();
	});

	afterEach(async () => {
		await cleanupTempDir(repoDir);
	});

	test("returns false on a fresh repo with no commits past base and a clean tree", async () => {
		const branch = await getDefaultBranch(repoDir);
		const result = await hasWorkToVerify(repoDir, branch);
		expect(result).toBe(false);
	});

	test("returns true when worktree has uncommitted changes", async () => {
		const branch = await getDefaultBranch(repoDir);
		await Bun.write(join(repoDir, "dirty.txt"), "uncommitted content");
		const result = await hasWorkToVerify(repoDir, branch);
		expect(result).toBe(true);
	});

	test("returns true when there are commits past base", async () => {
		// Pin a "base-ref" branch at the initial commit, then add a new commit
		// on the working branch so HEAD is one commit ahead of base-ref.
		const proc = Bun.spawn(["git", "branch", "base-ref", "HEAD"], { cwd: repoDir });
		await proc.exited;
		await commitFile(repoDir, "new-file.txt", "second commit", "second commit");

		const result = await hasWorkToVerify(repoDir, "base-ref");
		expect(result).toBe(true);
	});

	test("returns true when base ref cannot be resolved (fail open)", async () => {
		const result = await hasWorkToVerify(repoDir, "definitely-not-a-real-ref");
		expect(result).toBe(true);
	});

	test("defaults baseRef to 'main' when not provided", async () => {
		// On a clean repo with default branch 'main' the function should resolve
		// 'main' successfully and report no work to verify.
		const branch = await getDefaultBranch(repoDir);
		// Skip this assertion if the default branch isn't 'main' (e.g., master on
		// some CI runners) — fall back to passing the explicit branch.
		if (branch === "main") {
			const result = await hasWorkToVerify(repoDir);
			expect(result).toBe(false);
		} else {
			const result = await hasWorkToVerify(repoDir, branch);
			expect(result).toBe(false);
		}
	});
});

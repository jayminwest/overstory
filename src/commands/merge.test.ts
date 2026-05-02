import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { MergeError, ValidationError } from "../errors.ts";
import { mergeLockPath } from "../merge/lock.ts";
import { createMergeQueue } from "../merge/queue.ts";
import {
	cleanupTempDir,
	commitFile,
	createTempGitRepo,
	getDefaultBranch,
	runGitInDir,
} from "../test-helpers.ts";
import { mergeCommand } from "./merge.ts";

describe("mergeCommand", () => {
	let repoDir: string;
	let defaultBranch: string;
	let originalCwd: string;

	beforeEach(async () => {
		originalCwd = process.cwd();
		repoDir = await createTempGitRepo();
		defaultBranch = await getDefaultBranch(repoDir);
		process.chdir(repoDir);
	});

	afterEach(async () => {
		process.chdir(originalCwd);
		await cleanupTempDir(repoDir);
	});

	/**
	 * Setup helper: Create .overstory/ dir and write config.yaml with project canonicalBranch.
	 */
	async function setupProject(dir: string, canonicalBranch: string): Promise<void> {
		const overstoryDir = join(dir, ".overstory");
		await mkdir(overstoryDir);

		const configYaml = `project:
  canonicalBranch: ${canonicalBranch}
  root: ${dir}

merge:
  aiResolveEnabled: false
  reimagineEnabled: false
`;
		await Bun.write(join(overstoryDir, "config.yaml"), configYaml);
	}

	/**
	 * Setup helper: Create a clean feature branch with a committed file.
	 * Commits a base file (if not exists), creates a new branch, commits a feature file, then switches back to defaultBranch.
	 */
	async function createCleanFeatureBranch(dir: string, branchName: string): Promise<void> {
		// Only commit base file if it doesn't exist
		const baseFilePath = join(dir, "src/base.ts");
		const baseFileExists = await Bun.file(baseFilePath).exists();
		if (!baseFileExists) {
			await commitFile(dir, "src/base.ts", "base content");
		}
		await runGitInDir(dir, ["checkout", "-b", branchName]);
		await commitFile(dir, `src/${branchName}.ts`, "feature content");
		await runGitInDir(dir, ["checkout", defaultBranch]);
	}

	describe("validation", () => {
		test("no branch/all throws ValidationError mentioning '--branch' and '--all'", async () => {
			await setupProject(repoDir, defaultBranch);

			try {
				await mergeCommand({});
				expect(true).toBe(false); // Should not reach here
			} catch (err: unknown) {
				expect(err).toBeInstanceOf(ValidationError);
				const validationErr = err as ValidationError;
				expect(validationErr.message).toContain("--branch");
				expect(validationErr.message).toContain("--all");
			}
		});
	});

	describe("--branch with real git repo", () => {
		test("nonexistent branch throws ValidationError", async () => {
			await setupProject(repoDir, defaultBranch);

			try {
				await mergeCommand({ branch: "nonexistent-branch" });
				expect(true).toBe(false); // Should not reach here
			} catch (err: unknown) {
				expect(err).toBeInstanceOf(ValidationError);
				const validationErr = err as ValidationError;
				expect(validationErr.message).toContain("nonexistent-branch");
			}
		});

		test("--dry-run shows branch info without merging (verify still on defaultBranch after)", async () => {
			await setupProject(repoDir, defaultBranch);
			const branchName = "overstory/test-agent/bead-123";
			await createCleanFeatureBranch(repoDir, branchName);

			let output = "";
			const originalWrite = process.stdout.write.bind(process.stdout);
			process.stdout.write = (chunk: unknown): boolean => {
				output += String(chunk);
				return true;
			};

			try {
				await mergeCommand({ branch: branchName, dryRun: true });
			} finally {
				process.stdout.write = originalWrite;
			}

			expect(output).toContain(branchName);
			expect(output).toContain("pending");

			// Verify still on defaultBranch
			const currentBranch = await getDefaultBranch(repoDir);
			expect(currentBranch).toBe(defaultBranch);
		});

		test("--dry-run --json outputs JSON with branchName and status:pending", async () => {
			await setupProject(repoDir, defaultBranch);
			const branchName = "overstory/test-agent/bead-456";
			await createCleanFeatureBranch(repoDir, branchName);

			let output = "";
			const originalWrite = process.stdout.write.bind(process.stdout);
			process.stdout.write = (chunk: unknown): boolean => {
				output += String(chunk);
				return true;
			};

			try {
				await mergeCommand({ branch: branchName, dryRun: true, json: true });
			} finally {
				process.stdout.write = originalWrite;
			}

			const parsed = JSON.parse(output);
			expect(parsed.branchName).toBe(branchName);
			expect(parsed.status).toBe("pending");
		});

		test("merges a clean branch successfully (verify feature file exists after)", async () => {
			await setupProject(repoDir, defaultBranch);
			const branchName = "overstory/builder/bead-789";
			await createCleanFeatureBranch(repoDir, branchName);

			const originalWrite = process.stdout.write.bind(process.stdout);
			process.stdout.write = (): boolean => {
				return true;
			};

			try {
				await mergeCommand({ branch: branchName });
			} finally {
				process.stdout.write = originalWrite;
			}

			// Verify feature file exists after merge
			const featureFilePath = join(repoDir, `src/${branchName}.ts`);
			const featureFile = await Bun.file(featureFilePath).text();
			expect(featureFile).toBe("feature content");
		});

		test("--json outputs JSON with success:true and tier:clean-merge", async () => {
			await setupProject(repoDir, defaultBranch);
			const branchName = "overstory/builder/bead-abc";
			await createCleanFeatureBranch(repoDir, branchName);

			let output = "";
			const originalWrite = process.stdout.write.bind(process.stdout);
			process.stdout.write = (chunk: unknown): boolean => {
				output += String(chunk);
				return true;
			};

			try {
				await mergeCommand({ branch: branchName, json: true });
			} finally {
				process.stdout.write = originalWrite;
			}

			const parsed = JSON.parse(output);
			expect(parsed.success).toBe(true);
			expect(parsed.tier).toBe("clean-merge");
		});

		test("parses agent name from overstory/my-builder/bead-abc convention (use --dry-run)", async () => {
			await setupProject(repoDir, defaultBranch);
			const branchName = "overstory/my-builder/bead-xyz";
			await createCleanFeatureBranch(repoDir, branchName);

			let output = "";
			const originalWrite = process.stdout.write.bind(process.stdout);
			process.stdout.write = (chunk: unknown): boolean => {
				output += String(chunk);
				return true;
			};

			try {
				await mergeCommand({ branch: branchName, dryRun: true, json: true });
			} finally {
				process.stdout.write = originalWrite;
			}

			const parsed = JSON.parse(output);
			expect(parsed.agentName).toBe("my-builder");
			expect(parsed.taskId).toBe("bead-xyz");
		});
	});

	describe("--all with real git repo", () => {
		test("prints 'No pending' when queue empty", async () => {
			await setupProject(repoDir, defaultBranch);

			let output = "";
			const originalWrite = process.stdout.write.bind(process.stdout);
			process.stdout.write = (chunk: unknown): boolean => {
				output += String(chunk);
				return true;
			};

			try {
				await mergeCommand({ all: true });
			} finally {
				process.stdout.write = originalWrite;
			}

			expect(output).toContain("No pending");
		});

		test("--json shows empty results", async () => {
			await setupProject(repoDir, defaultBranch);

			let output = "";
			const originalWrite = process.stdout.write.bind(process.stdout);
			process.stdout.write = (chunk: unknown): boolean => {
				output += String(chunk);
				return true;
			};

			try {
				await mergeCommand({ all: true, json: true });
			} finally {
				process.stdout.write = originalWrite;
			}

			const parsed = JSON.parse(output);
			expect(parsed.results).toEqual([]);
			expect(parsed.count).toBe(0);
		});

		test("--all --dry-run lists pending entries from merge-queue.json", async () => {
			await setupProject(repoDir, defaultBranch);
			const branch1 = "overstory/agent1/bead-001";
			const branch2 = "overstory/agent2/bead-002";
			await createCleanFeatureBranch(repoDir, branch1);
			await createCleanFeatureBranch(repoDir, branch2);

			// Enqueue entries via createMergeQueue
			const queuePath = join(repoDir, ".overstory", "merge-queue.db");
			const queue = createMergeQueue(queuePath);
			queue.enqueue({
				branchName: branch1,
				taskId: "bead-001",
				agentName: "agent1",
				filesModified: [`src/${branch1}.ts`],
			});
			queue.enqueue({
				branchName: branch2,
				taskId: "bead-002",
				agentName: "agent2",
				filesModified: [`src/${branch2}.ts`],
			});
			queue.close();

			let output = "";
			const originalWrite = process.stdout.write.bind(process.stdout);
			process.stdout.write = (chunk: unknown): boolean => {
				output += String(chunk);
				return true;
			};

			try {
				await mergeCommand({ all: true, dryRun: true });
			} finally {
				process.stdout.write = originalWrite;
			}

			expect(output).toContain("2 pending");
			expect(output).toContain(branch1);
			expect(output).toContain(branch2);
		});

		test("--all merges multiple pending entries (write merge-queue.json with entries, verify counts)", async () => {
			await setupProject(repoDir, defaultBranch);
			const branch1 = "overstory/builder1/bead-100";
			const branch2 = "overstory/builder2/bead-200";
			await createCleanFeatureBranch(repoDir, branch1);
			await createCleanFeatureBranch(repoDir, branch2);

			// Enqueue entries via createMergeQueue
			const queuePath = join(repoDir, ".overstory", "merge-queue.db");
			const queue = createMergeQueue(queuePath);
			queue.enqueue({
				branchName: branch1,
				taskId: "bead-100",
				agentName: "builder1",
				filesModified: [`src/${branch1}.ts`],
			});
			queue.enqueue({
				branchName: branch2,
				taskId: "bead-200",
				agentName: "builder2",
				filesModified: [`src/${branch2}.ts`],
			});
			queue.close();

			let output = "";
			const originalWrite = process.stdout.write.bind(process.stdout);
			process.stdout.write = (chunk: unknown): boolean => {
				output += String(chunk);
				return true;
			};

			try {
				await mergeCommand({ all: true });
			} finally {
				process.stdout.write = originalWrite;
			}

			expect(output).toContain("Done");
			expect(output).toContain("2 merged");

			// Verify both feature files exist after merge
			const file1 = await Bun.file(join(repoDir, `src/${branch1}.ts`)).text();
			const file2 = await Bun.file(join(repoDir, `src/${branch2}.ts`)).text();
			expect(file1).toBe("feature content");
			expect(file2).toBe("feature content");
		});

		test("--all --json reports successCount and failCount", async () => {
			await setupProject(repoDir, defaultBranch);
			const branch1 = "overstory/builder3/bead-300";
			await createCleanFeatureBranch(repoDir, branch1);

			// Enqueue entry via createMergeQueue
			const queuePath = join(repoDir, ".overstory", "merge-queue.db");
			const queue = createMergeQueue(queuePath);
			queue.enqueue({
				branchName: branch1,
				taskId: "bead-300",
				agentName: "builder3",
				filesModified: [`src/${branch1}.ts`],
			});
			queue.close();

			let output = "";
			const originalWrite = process.stdout.write.bind(process.stdout);
			process.stdout.write = (chunk: unknown): boolean => {
				output += String(chunk);
				return true;
			};

			try {
				await mergeCommand({ all: true, json: true });
			} finally {
				process.stdout.write = originalWrite;
			}

			const parsed = JSON.parse(output);
			expect(parsed.successCount).toBe(1);
			expect(parsed.failCount).toBe(0);
			expect(parsed.count).toBe(1);
		});
	});

	describe("--into flag", () => {
		test("merges into a non-default target branch", async () => {
			await setupProject(repoDir, defaultBranch);

			// Create a target branch (not the default/canonical branch)
			await commitFile(repoDir, "src/base.ts", "base content");
			await runGitInDir(repoDir, ["checkout", "-b", "develop"]);
			await commitFile(repoDir, "src/develop-marker.ts", "develop marker");
			await runGitInDir(repoDir, ["checkout", defaultBranch]);

			// Create a feature branch off defaultBranch
			const branchName = "overstory/builder/bead-into-test";
			await runGitInDir(repoDir, ["checkout", "-b", branchName]);
			await commitFile(repoDir, `src/${branchName}.ts`, "feature for develop");
			await runGitInDir(repoDir, ["checkout", defaultBranch]);

			let output = "";
			const originalWrite = process.stdout.write.bind(process.stdout);
			process.stdout.write = (chunk: unknown): boolean => {
				output += String(chunk);
				return true;
			};

			try {
				await mergeCommand({ branch: branchName, into: "develop", json: true });
			} finally {
				process.stdout.write = originalWrite;
			}

			const parsed = JSON.parse(output);
			expect(parsed.success).toBe(true);
			expect(parsed.tier).toBe("clean-merge");

			// Verify we ended up on the develop branch after merge
			const currentBranch = await runGitInDir(repoDir, ["symbolic-ref", "--short", "HEAD"]);
			expect(currentBranch.trim()).toBe("develop");

			// Verify feature file exists on develop
			const featureFile = await Bun.file(join(repoDir, `src/${branchName}.ts`)).text();
			expect(featureFile).toBe("feature for develop");

			// Verify defaultBranch was NOT modified (switch back and check)
			await runGitInDir(repoDir, ["checkout", defaultBranch]);
			const featureOnDefault = await Bun.file(join(repoDir, `src/${branchName}.ts`)).exists();
			expect(featureOnDefault).toBe(false);
		});

		test("--into with --all merges all pending into target branch", async () => {
			await setupProject(repoDir, defaultBranch);

			// Create a target branch
			await commitFile(repoDir, "src/base.ts", "base content");
			await runGitInDir(repoDir, ["checkout", "-b", "staging"]);
			await commitFile(repoDir, "src/staging-marker.ts", "staging marker");
			await runGitInDir(repoDir, ["checkout", defaultBranch]);

			// Create feature branches
			const branch1 = "overstory/agent1/bead-into-all-1";
			await runGitInDir(repoDir, ["checkout", "-b", branch1]);
			await commitFile(repoDir, `src/${branch1}.ts`, "feature 1");
			await runGitInDir(repoDir, ["checkout", defaultBranch]);

			const branch2 = "overstory/agent2/bead-into-all-2";
			await runGitInDir(repoDir, ["checkout", "-b", branch2]);
			await commitFile(repoDir, `src/${branch2}.ts`, "feature 2");
			await runGitInDir(repoDir, ["checkout", defaultBranch]);

			// Enqueue entries
			const queuePath = join(repoDir, ".overstory", "merge-queue.db");
			const queue = createMergeQueue(queuePath);
			queue.enqueue({
				branchName: branch1,
				taskId: "bead-into-all-1",
				agentName: "agent1",
				filesModified: [`src/${branch1}.ts`],
			});
			queue.enqueue({
				branchName: branch2,
				taskId: "bead-into-all-2",
				agentName: "agent2",
				filesModified: [`src/${branch2}.ts`],
			});
			queue.close();

			let output = "";
			const originalWrite = process.stdout.write.bind(process.stdout);
			process.stdout.write = (chunk: unknown): boolean => {
				output += String(chunk);
				return true;
			};

			try {
				await mergeCommand({ all: true, into: "staging", json: true });
			} finally {
				process.stdout.write = originalWrite;
			}

			const parsed = JSON.parse(output);
			expect(parsed.successCount).toBe(2);
			expect(parsed.failCount).toBe(0);

			// Verify we're on staging, not defaultBranch
			const currentBranch = await runGitInDir(repoDir, ["symbolic-ref", "--short", "HEAD"]);
			expect(currentBranch.trim()).toBe("staging");
		});

		test("defaults to canonicalBranch when --into and session-branch.txt are absent", async () => {
			await setupProject(repoDir, defaultBranch);
			const branchName = "overstory/builder/bead-default-target";
			await createCleanFeatureBranch(repoDir, branchName);

			let output = "";
			const originalWrite = process.stdout.write.bind(process.stdout);
			process.stdout.write = (chunk: unknown): boolean => {
				output += String(chunk);
				return true;
			};

			try {
				await mergeCommand({ branch: branchName, json: true });
			} finally {
				process.stdout.write = originalWrite;
			}

			const parsed = JSON.parse(output);
			expect(parsed.success).toBe(true);

			// Verify we ended up on the default branch (the canonical branch)
			const currentBranch = await runGitInDir(repoDir, ["symbolic-ref", "--short", "HEAD"]);
			expect(currentBranch.trim()).toBe(defaultBranch);
		});

		test("reads session-branch.txt as default when --into is not specified", async () => {
			await setupProject(repoDir, defaultBranch);

			// Create a target branch
			await commitFile(repoDir, "src/base.ts", "base content");
			await runGitInDir(repoDir, ["checkout", "-b", "feature/session-work"]);
			await commitFile(repoDir, "src/session-marker.ts", "session marker");
			await runGitInDir(repoDir, ["checkout", defaultBranch]);

			// Write session-branch.txt pointing to the feature branch
			await Bun.write(join(repoDir, ".overstory", "session-branch.txt"), "feature/session-work\n");

			// Create a feature branch to merge
			const branchName = "overstory/builder/bead-session-branch";
			await runGitInDir(repoDir, ["checkout", "-b", branchName]);
			await commitFile(repoDir, `src/${branchName}.ts`, "feature for session branch");
			await runGitInDir(repoDir, ["checkout", defaultBranch]);

			let output = "";
			const originalWrite = process.stdout.write.bind(process.stdout);
			process.stdout.write = (chunk: unknown): boolean => {
				output += String(chunk);
				return true;
			};

			try {
				// No --into flag — should read session-branch.txt
				await mergeCommand({ branch: branchName, json: true });
			} finally {
				process.stdout.write = originalWrite;
			}

			const parsed = JSON.parse(output);
			expect(parsed.success).toBe(true);

			// Verify merge went to session branch, not defaultBranch
			const currentBranch = await runGitInDir(repoDir, ["symbolic-ref", "--short", "HEAD"]);
			expect(currentBranch.trim()).toBe("feature/session-work");

			// Verify feature file exists on the session branch
			const featureFile = await Bun.file(join(repoDir, `src/${branchName}.ts`)).text();
			expect(featureFile).toBe("feature for session branch");
		});

		test("--into flag overrides session-branch.txt", async () => {
			await setupProject(repoDir, defaultBranch);

			// Create two target branches
			await commitFile(repoDir, "src/base.ts", "base content");
			await runGitInDir(repoDir, ["checkout", "-b", "session-branch-target"]);
			await commitFile(repoDir, "src/session-marker.ts", "session marker");
			await runGitInDir(repoDir, ["checkout", defaultBranch]);
			await runGitInDir(repoDir, ["checkout", "-b", "explicit-target"]);
			await commitFile(repoDir, "src/explicit-marker.ts", "explicit marker");
			await runGitInDir(repoDir, ["checkout", defaultBranch]);

			// Write session-branch.txt pointing to session-branch-target
			await Bun.write(join(repoDir, ".overstory", "session-branch.txt"), "session-branch-target\n");

			// Create a feature branch to merge
			const branchName = "overstory/builder/bead-override-test";
			await runGitInDir(repoDir, ["checkout", "-b", branchName]);
			await commitFile(repoDir, `src/${branchName}.ts`, "feature content");
			await runGitInDir(repoDir, ["checkout", defaultBranch]);

			let output = "";
			const originalWrite = process.stdout.write.bind(process.stdout);
			process.stdout.write = (chunk: unknown): boolean => {
				output += String(chunk);
				return true;
			};

			try {
				// --into overrides session-branch.txt
				await mergeCommand({ branch: branchName, into: "explicit-target", json: true });
			} finally {
				process.stdout.write = originalWrite;
			}

			const parsed = JSON.parse(output);
			expect(parsed.success).toBe(true);

			// Verify merge went to explicit-target, not session-branch-target
			const currentBranch = await runGitInDir(repoDir, ["symbolic-ref", "--short", "HEAD"]);
			expect(currentBranch.trim()).toBe("explicit-target");
		});
	});

	describe("concurrent-merge lock", () => {
		test("refuses to start when another live ov merge holds the lock for the same target", async () => {
			await setupProject(repoDir, defaultBranch);
			const branchName = "overstory/builder/bead-lock-1";
			await createCleanFeatureBranch(repoDir, branchName);

			// Simulate another live ov merge by writing a lock file with this
			// process's own PID — it is guaranteed alive, so the lock-holder check
			// must treat it as an in-flight merge.
			const lockPath = mergeLockPath(join(repoDir, ".overstory"), defaultBranch);
			writeFileSync(
				lockPath,
				JSON.stringify({
					pid: process.pid,
					acquiredAt: new Date().toISOString(),
					targetBranch: defaultBranch,
				}),
			);

			const originalWrite = process.stdout.write.bind(process.stdout);
			process.stdout.write = (): boolean => true;

			try {
				await mergeCommand({ branch: branchName });
				expect(true).toBe(false); // should not reach here
			} catch (err: unknown) {
				expect(err).toBeInstanceOf(MergeError);
				const msg = (err as MergeError).message;
				expect(msg).toContain("Another ov merge is already running");
				expect(msg).toContain(defaultBranch);
			} finally {
				process.stdout.write = originalWrite;
			}
		});

		test("releases the lock after a successful merge so a second run can proceed", async () => {
			await setupProject(repoDir, defaultBranch);
			const branchName = "overstory/builder/bead-lock-2";
			await createCleanFeatureBranch(repoDir, branchName);

			const originalWrite = process.stdout.write.bind(process.stdout);
			process.stdout.write = (): boolean => true;

			try {
				await mergeCommand({ branch: branchName, json: true });
			} finally {
				process.stdout.write = originalWrite;
			}

			// After release, a fresh `ov merge --dry-run` for an unrelated branch
			// (which doesn't take a lock) should still see no leftover lock file.
			const lockPath = mergeLockPath(join(repoDir, ".overstory"), defaultBranch);
			expect(await Bun.file(lockPath).exists()).toBe(false);
		});

		test("--dry-run does not acquire the lock", async () => {
			await setupProject(repoDir, defaultBranch);
			const branchName = "overstory/builder/bead-lock-dry";
			await createCleanFeatureBranch(repoDir, branchName);

			const originalWrite = process.stdout.write.bind(process.stdout);
			process.stdout.write = (): boolean => true;

			try {
				await mergeCommand({ branch: branchName, dryRun: true, json: true });
			} finally {
				process.stdout.write = originalWrite;
			}

			const lockPath = mergeLockPath(join(repoDir, ".overstory"), defaultBranch);
			expect(await Bun.file(lockPath).exists()).toBe(false);
		});

		test("steals a stale lock (dead PID) and proceeds", async () => {
			await setupProject(repoDir, defaultBranch);
			const branchName = "overstory/builder/bead-lock-stale";
			await createCleanFeatureBranch(repoDir, branchName);

			// PID 2147483647 (INT_MAX) is virtually never assigned — treat as dead.
			const lockPath = mergeLockPath(join(repoDir, ".overstory"), defaultBranch);
			writeFileSync(
				lockPath,
				JSON.stringify({
					pid: 2147483647,
					acquiredAt: new Date(Date.now() - 10 * 60_000).toISOString(),
					targetBranch: defaultBranch,
				}),
			);

			let output = "";
			const originalWrite = process.stdout.write.bind(process.stdout);
			process.stdout.write = (chunk: unknown): boolean => {
				output += String(chunk);
				return true;
			};

			try {
				await mergeCommand({ branch: branchName, json: true });
			} finally {
				process.stdout.write = originalWrite;
			}

			const parsed = JSON.parse(output);
			expect(parsed.success).toBe(true);
			// Lock should be released after success.
			expect(await Bun.file(lockPath).exists()).toBe(false);
		});
	});

	describe("--dry-run conflict prediction", () => {
		test("--dry-run --json includes prediction.wouldRequireAgent for contentful-canonical conflict", async () => {
			await setupProject(repoDir, defaultBranch);

			// Build a real contentful-canonical conflict on src/shared.ts.
			await commitFile(repoDir, "src/shared.ts", "shared base\n");
			const branchName = "overstory/builder/bead-predict-1";
			await runGitInDir(repoDir, ["checkout", "-b", branchName]);
			await commitFile(repoDir, "src/shared.ts", "feature side\n");
			await runGitInDir(repoDir, ["checkout", defaultBranch]);
			await commitFile(repoDir, "src/shared.ts", "main side\n");

			let output = "";
			const originalWrite = process.stdout.write.bind(process.stdout);
			process.stdout.write = (chunk: unknown): boolean => {
				output += String(chunk);
				return true;
			};

			try {
				await mergeCommand({ branch: branchName, dryRun: true, json: true });
			} finally {
				process.stdout.write = originalWrite;
			}

			const parsed = JSON.parse(output);
			expect(parsed.prediction).toBeDefined();
			expect(parsed.prediction.wouldRequireAgent).toBe(true);
			expect(parsed.prediction.predictedTier).toBe("ai-resolve");
			expect(parsed.prediction.conflictFiles).toContain("src/shared.ts");
			expect(typeof parsed.prediction.reason).toBe("string");

			// Existing dry-run fields must still be present.
			expect(parsed.branchName).toBe(branchName);
			expect(parsed.status).toBe("pending");
		});

		test("--dry-run --json reports clean-merge prediction for non-conflicting branch", async () => {
			await setupProject(repoDir, defaultBranch);
			const branchName = "overstory/builder/bead-predict-2";
			await createCleanFeatureBranch(repoDir, branchName);

			let output = "";
			const originalWrite = process.stdout.write.bind(process.stdout);
			process.stdout.write = (chunk: unknown): boolean => {
				output += String(chunk);
				return true;
			};

			try {
				await mergeCommand({ branch: branchName, dryRun: true, json: true });
			} finally {
				process.stdout.write = originalWrite;
			}

			const parsed = JSON.parse(output);
			expect(parsed.prediction.predictedTier).toBe("clean-merge");
			expect(parsed.prediction.wouldRequireAgent).toBe(false);
			expect(parsed.prediction.conflictFiles).toEqual([]);
		});

		test("--all --dry-run --json attaches prediction to each entry", async () => {
			await setupProject(repoDir, defaultBranch);
			const cleanBranch = "overstory/builder/bead-predict-all-clean";
			await createCleanFeatureBranch(repoDir, cleanBranch);

			// Add a contentful-canonical conflict branch.
			await commitFile(repoDir, "src/shared.ts", "shared base\n");
			const conflictBranch = "overstory/builder/bead-predict-all-conflict";
			await runGitInDir(repoDir, ["checkout", "-b", conflictBranch]);
			await commitFile(repoDir, "src/shared.ts", "feature side\n");
			await runGitInDir(repoDir, ["checkout", defaultBranch]);
			await commitFile(repoDir, "src/shared.ts", "main side\n");

			const queuePath = join(repoDir, ".overstory", "merge-queue.db");
			const queue = createMergeQueue(queuePath);
			queue.enqueue({
				branchName: cleanBranch,
				taskId: "bead-predict-all-clean",
				agentName: "builder",
				filesModified: [`src/${cleanBranch}.ts`],
			});
			queue.enqueue({
				branchName: conflictBranch,
				taskId: "bead-predict-all-conflict",
				agentName: "builder",
				filesModified: ["src/shared.ts"],
			});
			queue.close();

			let output = "";
			const originalWrite = process.stdout.write.bind(process.stdout);
			process.stdout.write = (chunk: unknown): boolean => {
				output += String(chunk);
				return true;
			};

			try {
				await mergeCommand({ all: true, dryRun: true, json: true });
			} finally {
				process.stdout.write = originalWrite;
			}

			const parsed = JSON.parse(output);
			expect(parsed.entries).toHaveLength(2);
			const cleanEntry = parsed.entries.find(
				(e: { branchName: string }) => e.branchName === cleanBranch,
			);
			const conflictEntry = parsed.entries.find(
				(e: { branchName: string }) => e.branchName === conflictBranch,
			);
			expect(cleanEntry.prediction.predictedTier).toBe("clean-merge");
			expect(cleanEntry.prediction.wouldRequireAgent).toBe(false);
			expect(conflictEntry.prediction.predictedTier).toBe("ai-resolve");
			expect(conflictEntry.prediction.wouldRequireAgent).toBe(true);
		});
	});

	describe("conflict handling", () => {
		test("content conflict auto-resolves: same file modified on both branches, verify incoming content wins", async () => {
			await setupProject(repoDir, defaultBranch);

			// Create a conflict: modify same file on both branches
			await commitFile(repoDir, "src/shared.ts", "base content");

			// Modify on default branch
			await commitFile(repoDir, "src/shared.ts", "default branch content");

			// Create feature branch and modify the same file
			const branchName = "overstory/builder-conflict/bead-999";
			await runGitInDir(repoDir, ["checkout", "-b", branchName]);
			await commitFile(repoDir, "src/shared.ts", "feature branch content");
			await runGitInDir(repoDir, ["checkout", defaultBranch]);

			const originalWrite = process.stdout.write.bind(process.stdout);
			process.stdout.write = (): boolean => {
				return true;
			};

			try {
				await mergeCommand({ branch: branchName });
			} finally {
				process.stdout.write = originalWrite;
			}

			// Verify incoming (feature branch) content wins
			const sharedFile = await Bun.file(join(repoDir, "src/shared.ts")).text();
			expect(sharedFile).toBe("feature branch content");
		});
	});
});

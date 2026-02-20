import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { ValidationError } from "../errors.ts";
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
	async function setupProject(
		dir: string,
		canonicalBranch: string,
		options?: {
			aiResolveEnabled?: boolean;
			reimagineEnabled?: boolean;
			cliBase?: "claude" | "codex";
		},
	): Promise<void> {
		const overstoryDir = join(dir, ".overstory");
		await mkdir(overstoryDir);

		const aiResolveEnabled = options?.aiResolveEnabled ?? false;
		const reimagineEnabled = options?.reimagineEnabled ?? false;
		const cliBase = options?.cliBase;

		const configYaml = `project:
  canonicalBranch: ${canonicalBranch}
  root: ${dir}

merge:
  aiResolveEnabled: ${aiResolveEnabled}
  reimagineEnabled: ${reimagineEnabled}
${cliBase ? `\ncli:\n  base: ${cliBase}\n` : ""}`;
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

	async function commitBinaryFile(
		dir: string,
		filePath: string,
		content: Uint8Array,
		message: string,
	): Promise<void> {
		await Bun.write(join(dir, filePath), content);
		await runGitInDir(dir, ["add", filePath]);
		await runGitInDir(dir, ["commit", "-m", message]);
	}

	async function createBinaryConflictBranch(dir: string, branchName: string): Promise<void> {
		const binaryPath = "src/conflict.bin";
		await mkdir(join(dir, "src"), { recursive: true });

		await commitBinaryFile(dir, binaryPath, new Uint8Array([0, 1, 2, 3]), "add binary base");

		await runGitInDir(dir, ["checkout", "-b", branchName]);
		await commitBinaryFile(
			dir,
			binaryPath,
			new Uint8Array([11, 12, 13, 14]),
			"update binary on feature",
		);

		await runGitInDir(dir, ["checkout", defaultBranch]);
		await commitBinaryFile(
			dir,
			binaryPath,
			new Uint8Array([21, 22, 23, 24]),
			"update binary on default",
		);
	}

	describe("help and validation", () => {
		test("--help prints help containing 'overstory merge', '--branch', '--all', '--dry-run', '--into'", async () => {
			let output = "";
			const originalWrite = process.stdout.write.bind(process.stdout);
			process.stdout.write = (chunk: unknown): boolean => {
				output += String(chunk);
				return true;
			};

			try {
				await mergeCommand(["--help"]);
			} finally {
				process.stdout.write = originalWrite;
			}

			expect(output).toContain("overstory merge");
			expect(output).toContain("--branch");
			expect(output).toContain("--all");
			expect(output).toContain("--dry-run");
			expect(output).toContain("--into");
		});

		test("-h prints help", async () => {
			let output = "";
			const originalWrite = process.stdout.write.bind(process.stdout);
			process.stdout.write = (chunk: unknown): boolean => {
				output += String(chunk);
				return true;
			};

			try {
				await mergeCommand(["-h"]);
			} finally {
				process.stdout.write = originalWrite;
			}

			expect(output).toContain("overstory merge");
		});

		test("no flags throws ValidationError mentioning '--branch' and '--all'", async () => {
			await setupProject(repoDir, defaultBranch);

			try {
				await mergeCommand([]);
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
				await mergeCommand(["--branch", "nonexistent-branch"]);
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
				await mergeCommand(["--branch", branchName, "--dry-run"]);
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
				await mergeCommand(["--branch", branchName, "--dry-run", "--json"]);
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
				await mergeCommand(["--branch", branchName]);
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
				await mergeCommand(["--branch", branchName, "--json"]);
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
				await mergeCommand(["--branch", branchName, "--dry-run", "--json"]);
			} finally {
				process.stdout.write = originalWrite;
			}

			const parsed = JSON.parse(output);
			expect(parsed.agentName).toBe("my-builder");
			expect(parsed.beadId).toBe("bead-xyz");
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
				await mergeCommand(["--all"]);
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
				await mergeCommand(["--all", "--json"]);
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
				beadId: "bead-001",
				agentName: "agent1",
				filesModified: [`src/${branch1}.ts`],
			});
			queue.enqueue({
				branchName: branch2,
				beadId: "bead-002",
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
				await mergeCommand(["--all", "--dry-run"]);
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
				beadId: "bead-100",
				agentName: "builder1",
				filesModified: [`src/${branch1}.ts`],
			});
			queue.enqueue({
				branchName: branch2,
				beadId: "bead-200",
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
				await mergeCommand(["--all"]);
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
				beadId: "bead-300",
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
				await mergeCommand(["--all", "--json"]);
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
				await mergeCommand(["--branch", branchName, "--into", "develop", "--json"]);
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
				beadId: "bead-into-all-1",
				agentName: "agent1",
				filesModified: [`src/${branch1}.ts`],
			});
			queue.enqueue({
				branchName: branch2,
				beadId: "bead-into-all-2",
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
				await mergeCommand(["--all", "--into", "staging", "--json"]);
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
				await mergeCommand(["--branch", branchName, "--json"]);
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
				await mergeCommand(["--branch", branchName, "--json"]);
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
				await mergeCommand(["--branch", branchName, "--into", "explicit-target", "--json"]);
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
				await mergeCommand(["--branch", branchName]);
			} finally {
				process.stdout.write = originalWrite;
			}

			// Verify incoming (feature branch) content wins
			const sharedFile = await Bun.file(join(repoDir, "src/shared.ts")).text();
			expect(sharedFile).toBe("feature branch content");
		});

		test("codex mode skips Claude AI tiers even when merge.aiResolveEnabled is true", async () => {
			await setupProject(repoDir, defaultBranch, {
				aiResolveEnabled: true,
				reimagineEnabled: false,
				cliBase: "codex",
			});
			const branchName = "overstory/codex/bead-binary";
			await createBinaryConflictBranch(repoDir, branchName);

			const originalSpawn = Bun.spawn;
			let claudeCalled = false;
			const selectiveMock = (...args: unknown[]): ReturnType<typeof Bun.spawn> => {
				const [cmd, options] = args as [string[] | { cmd: string[] }, { cwd?: string } | undefined];
				const cmdArray = Array.isArray(cmd) ? cmd : cmd.cmd;
				if (!cmdArray) {
					return originalSpawn(...(args as Parameters<typeof Bun.spawn>));
				}
				if (cmdArray[0] === "claude") {
					claudeCalled = true;
					return originalSpawn(["sh", "-c", "echo 'mock claude failure' 1>&2; exit 1"], {
						cwd: options?.cwd,
						stdout: "pipe",
						stderr: "pipe",
					});
				}
				return originalSpawn(...(args as Parameters<typeof Bun.spawn>));
			};
			const spawnSpy = spyOn(Bun, "spawn").mockImplementation(
				selectiveMock as unknown as typeof Bun.spawn,
			);

			let output = "";
			const originalWrite = process.stdout.write.bind(process.stdout);
			process.stdout.write = (chunk: unknown): boolean => {
				output += String(chunk);
				return true;
			};

			try {
				await expect(mergeCommand(["--branch", branchName, "--json"])).rejects.toThrow();
			} finally {
				process.stdout.write = originalWrite;
				spawnSpy.mockRestore();
			}

			expect(claudeCalled).toBe(false);
			const parsed = JSON.parse(output);
			expect(parsed.success).toBe(false);
			expect(parsed.tier).toBe("auto-resolve");
		});

		test("claude mode still attempts Claude AI tier when merge.aiResolveEnabled is true", async () => {
			await setupProject(repoDir, defaultBranch, {
				aiResolveEnabled: true,
				reimagineEnabled: false,
				cliBase: "claude",
			});
			const branchName = "overstory/claude/bead-binary";
			await createBinaryConflictBranch(repoDir, branchName);

			const originalSpawn = Bun.spawn;
			let claudeCalled = false;
			const selectiveMock = (...args: unknown[]): ReturnType<typeof Bun.spawn> => {
				const [cmd, options] = args as [string[] | { cmd: string[] }, { cwd?: string } | undefined];
				const cmdArray = Array.isArray(cmd) ? cmd : cmd.cmd;
				if (!cmdArray) {
					return originalSpawn(...(args as Parameters<typeof Bun.spawn>));
				}
				if (cmdArray[0] === "claude") {
					claudeCalled = true;
					return originalSpawn(["sh", "-c", "echo 'mock claude failure' 1>&2; exit 1"], {
						cwd: options?.cwd,
						stdout: "pipe",
						stderr: "pipe",
					});
				}
				return originalSpawn(...(args as Parameters<typeof Bun.spawn>));
			};
			const spawnSpy = spyOn(Bun, "spawn").mockImplementation(
				selectiveMock as unknown as typeof Bun.spawn,
			);

			let output = "";
			const originalWrite = process.stdout.write.bind(process.stdout);
			process.stdout.write = (chunk: unknown): boolean => {
				output += String(chunk);
				return true;
			};

			try {
				await expect(mergeCommand(["--branch", branchName, "--json"])).rejects.toThrow();
			} finally {
				process.stdout.write = originalWrite;
				spawnSpy.mockRestore();
			}

			expect(claudeCalled).toBe(true);
			const parsed = JSON.parse(output);
			expect(parsed.success).toBe(false);
			expect(parsed.tier).toBe("ai-resolve");
		});
	});
});

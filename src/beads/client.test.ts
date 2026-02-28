import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { realpathSync } from "node:fs";
import { AgentError } from "../errors.ts";
import { cleanupTempDir, createTempGitRepo } from "../test-helpers.ts";
import { type BeadsClient, createBeadsClient } from "./client.ts";

/**
 * Check if the bd CLI is available on this machine (synchronous).
 * Uses Bun.spawnSync so the result is available at test registration time
 * for use with test.skipIf().
 */
function isBdAvailable(): boolean {
	try {
		const result = Bun.spawnSync(["bd", "--version"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		return result.exitCode === 0;
	} catch {
		return false;
	}
}

/**
 * Initialize beads in a git repo directory.
 */
async function initBeads(cwd: string): Promise<void> {
	const proc = Bun.spawn(["bd", "init"], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		const stderr = await new Response(proc.stderr).text();
		throw new Error(`bd init failed: ${stderr}`);
	}
}

const bdAvailable = isBdAvailable();

// Beads integration setup can exceed Bun's default 5s on loaded machines
// (bd init + pre-created issues + Dolt warmup), causing flaky hook timeouts.
setDefaultTimeout(30_000);

/**
 * Optimized test suite: uses a single shared repo (beforeAll) instead of
 * creating a fresh repo per test. All 16 original tests share one repo
 * since they create issues with unique IDs and use toContain/not.toContain
 * assertions. This reduces setup from ~96 subprocess spawns to ~6.
 */
describe("createBeadsClient (integration)", () => {
	let tempDir: string;
	let client: BeadsClient;

	// Pre-created issue IDs for tests that need existing issues
	let openIssueId: string;
	let claimedIssueId: string;
	let closedIssueId: string;

	beforeAll(async () => {
		if (!bdAvailable) return;
		// realpathSync resolves macOS /var -> /private/var symlink so paths match
		tempDir = realpathSync(await createTempGitRepo());
		await initBeads(tempDir);
		client = createBeadsClient(tempDir);

		// Pre-create issues used by read-only tests (list, ready, show)
		openIssueId = await client.create("Pre-created open issue");
		claimedIssueId = await client.create("Pre-created claimed issue");
		await client.claim(claimedIssueId);
		closedIssueId = await client.create("Pre-created closed issue");
		await client.close(closedIssueId);
	});

	afterAll(async () => {
		if (!bdAvailable) return;
		await cleanupTempDir(tempDir);
	});

	describe("create", () => {
		test.skipIf(!bdAvailable)("returns an issue ID", async () => {
			const id = await client.create("Integration test issue");

			expect(typeof id).toBe("string");
			expect(id.length).toBeGreaterThan(0);
		});

		test.skipIf(!bdAvailable)("returns ID with type and priority options", async () => {
			const id = await client.create("Typed issue", {
				type: "bug",
				priority: 1,
			});

			expect(typeof id).toBe("string");
			expect(id.length).toBeGreaterThan(0);
		});

		test.skipIf(!bdAvailable)("returns ID with description option", async () => {
			const id = await client.create("Described issue", {
				description: "A detailed description",
			});

			expect(typeof id).toBe("string");
			expect(id.length).toBeGreaterThan(0);
		});
	});

	describe("show", () => {
		test.skipIf(!bdAvailable)("returns issue details for a valid ID", async () => {
			const id = await client.create("Show test issue", {
				type: "task",
				priority: 2,
			});

			const issue = await client.show(id);

			expect(issue.id).toBe(id);
			expect(issue.title).toBe("Show test issue");
			expect(issue.status).toBe("open");
			expect(issue.priority).toBe(2);
			expect(issue.type).toBe("task");
		});
	});

	describe("claim", () => {
		test.skipIf(!bdAvailable)("changes issue status to in_progress and returns void", async () => {
			const id = await client.create("Claim test issue");

			const result = await client.claim(id);
			expect(result).toBeUndefined();

			const issue = await client.show(id);
			expect(issue.status).toBe("in_progress");
		});
	});

	describe("close", () => {
		test.skipIf(!bdAvailable)("closes issues with and without reason", async () => {
			const id1 = await client.create("Close test issue");
			const id2 = await client.create("Close reason test");

			await client.close(id1);
			await client.close(id2, "Completed all acceptance criteria");

			const issue1 = await client.show(id1);
			expect(issue1.status).toBe("closed");

			const issue2 = await client.show(id2);
			expect(issue2.status).toBe("closed");
		});
	});

	describe("list", () => {
		test.skipIf(!bdAvailable)("returns all issues", async () => {
			const issues = await client.list();

			// Pre-created issues should be present (plus any from other tests)
			expect(issues.length).toBeGreaterThanOrEqual(3);
			const titles = issues.map((i) => i.title);
			expect(titles).toContain("Pre-created open issue");
			expect(titles).toContain("Pre-created claimed issue");
		});

		test.skipIf(!bdAvailable)("filters by status", async () => {
			const openIssues = await client.list({ status: "open" });
			const openIds = openIssues.map((i) => i.id);
			expect(openIds).toContain(openIssueId);
			expect(openIds).not.toContain(claimedIssueId);
			expect(openIds).not.toContain(closedIssueId);

			const inProgressIssues = await client.list({ status: "in_progress" });
			const inProgressIds = inProgressIssues.map((i) => i.id);
			expect(inProgressIds).toContain(claimedIssueId);
			expect(inProgressIds).not.toContain(openIssueId);
		});

		test.skipIf(!bdAvailable)("respects limit option", async () => {
			const limited = await client.list({ limit: 1 });
			expect(limited).toHaveLength(1);
		});
	});

	describe("ready", () => {
		test.skipIf(!bdAvailable)(
			"returns open unblocked issues but not claimed or closed",
			async () => {
				const readyIssues = await client.ready();
				const readyIds = readyIssues.map((i) => i.id);

				// Open issue should appear in ready
				expect(readyIds).toContain(openIssueId);
				// Claimed issue should not appear in ready
				expect(readyIds).not.toContain(claimedIssueId);
				// Closed issue should not appear in ready
				expect(readyIds).not.toContain(closedIssueId);
			},
		);
	});

	describe("error handling", () => {
		test.skipIf(!bdAvailable)("show throws AgentError for nonexistent ID", async () => {
			await expect(client.show("nonexistent-id")).rejects.toThrow(AgentError);
		});

		test.skipIf(!bdAvailable)(
			"throws AgentError when bd is run without beads initialized",
			async () => {
				// Create a git repo without bd init — independent from shared repo
				const bareDir = realpathSync(await createTempGitRepo());
				const bareClient = createBeadsClient(bareDir);

				try {
					await expect(bareClient.list()).rejects.toThrow(AgentError);
				} finally {
					await cleanupTempDir(bareDir);
				}
			},
		);
	});
});

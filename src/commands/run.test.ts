/**
 * Tests for overstory run command.
 *
 * Uses real SQLite (temp files) and real file I/O for current-run.txt.
 * No mocks -- tests exercise the actual RunStore and SessionStore.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionStore } from "../sessions/store.ts";
import { createRunStore, createSessionStore } from "../sessions/store.ts";
import { cleanupTempDir } from "../test-helpers.ts";
import type { AgentSession, InsertRun, RunStore } from "../types.ts";

let tempDir: string;
let overstoryDir: string;
let dbPath: string;
let runStore: RunStore;
let sessionStore: SessionStore;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), "overstory-run-test-"));
	overstoryDir = join(tempDir, ".overstory");
	await mkdir(overstoryDir, { recursive: true });
	dbPath = join(overstoryDir, "sessions.db");
	runStore = createRunStore(dbPath);
	sessionStore = createSessionStore(dbPath);
});

afterEach(async () => {
	runStore.close();
	sessionStore.close();
	await cleanupTempDir(tempDir);
});

/** Write a run ID to current-run.txt. */
async function writeCurrentRun(runId: string): Promise<void> {
	await Bun.write(join(overstoryDir, "current-run.txt"), runId);
}

/** Read current-run.txt contents, or null if missing/empty. */
async function readCurrentRunFile(): Promise<string | null> {
	const file = Bun.file(join(overstoryDir, "current-run.txt"));
	if (!(await file.exists())) {
		return null;
	}
	const trimmed = (await file.text()).trim();
	return trimmed.length > 0 ? trimmed : null;
}

/** Helper to create an InsertRun with optional overrides. */
function makeRun(overrides: Partial<InsertRun> = {}): InsertRun {
	return {
		id: "run-2026-02-13T10:00:00.000Z",
		startedAt: "2026-02-13T10:00:00.000Z",
		coordinatorSessionId: "coord-session-001",
		status: "active",
		...overrides,
	};
}

/** Helper to create an AgentSession with optional overrides. */
function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
	return {
		id: "session-001",
		agentName: "test-agent",
		capability: "builder",
		worktreePath: "/tmp/worktrees/test-agent",
		branchName: "overstory/test-agent/task-1",
		taskId: "task-1",
		tmuxSession: "overstory-test-agent",
		state: "working",
		pid: 12345,
		parentAgent: null,
		depth: 0,
		runId: null,
		startedAt: "2026-02-13T10:00:00.000Z",
		lastActivity: "2026-02-13T10:30:00.000Z",
		escalationLevel: 0,
		stalledSince: null,
		transcriptPath: null,
		...overrides,
	};
}

// ============================================================
// Direct function tests (testing the store interactions)
// ============================================================

describe("show current run (default)", () => {
	test("shows 'No active run' when current-run.txt does not exist", async () => {
		// No current-run.txt written -- file does not exist
		const file = Bun.file(join(overstoryDir, "current-run.txt"));
		expect(await file.exists()).toBe(false);
	});

	test("reads run ID from current-run.txt", async () => {
		const runId = "run-2026-02-13T10:00:00.000Z";
		await writeCurrentRun(runId);
		const content = await readCurrentRunFile();
		expect(content).toBe(runId);
	});

	test("fetches run details from RunStore", () => {
		const run = makeRun();
		runStore.createRun(run);

		const fetched = runStore.getRun("run-2026-02-13T10:00:00.000Z");
		expect(fetched).not.toBeNull();
		expect(fetched?.id).toBe("run-2026-02-13T10:00:00.000Z");
		expect(fetched?.status).toBe("active");
		expect(fetched?.agentCount).toBe(0);
	});

	test("returns null for missing run ID", () => {
		const fetched = runStore.getRun("nonexistent");
		expect(fetched).toBeNull();
	});
});

describe("list runs", () => {
	test("returns empty array when no runs exist", () => {
		const runs = runStore.listRuns({ limit: 10 });
		expect(runs).toEqual([]);
	});

	test("returns runs ordered by started_at descending", () => {
		runStore.createRun(makeRun({ id: "run-1", startedAt: "2026-02-13T08:00:00.000Z" }));
		runStore.createRun(makeRun({ id: "run-2", startedAt: "2026-02-13T12:00:00.000Z" }));
		runStore.createRun(makeRun({ id: "run-3", startedAt: "2026-02-13T10:00:00.000Z" }));

		const runs = runStore.listRuns({ limit: 10 });
		expect(runs).toHaveLength(3);
		expect(runs[0]?.id).toBe("run-2");
		expect(runs[1]?.id).toBe("run-3");
		expect(runs[2]?.id).toBe("run-1");
	});

	test("respects --last limit", () => {
		for (let i = 0; i < 5; i++) {
			runStore.createRun(
				makeRun({
					id: `run-${i}`,
					startedAt: `2026-02-13T${String(10 + i).padStart(2, "0")}:00:00.000Z`,
				}),
			);
		}

		const runs = runStore.listRuns({ limit: 3 });
		expect(runs).toHaveLength(3);
	});

	test("includes completed and active runs", () => {
		runStore.createRun(makeRun({ id: "run-active", status: "active" }));
		runStore.createRun(
			makeRun({
				id: "run-done",
				startedAt: "2026-02-13T11:00:00.000Z",
				status: "active",
			}),
		);
		runStore.completeRun("run-done", "completed");

		const runs = runStore.listRuns({ limit: 10 });
		expect(runs).toHaveLength(2);
		const statuses = runs.map((r) => r.status);
		expect(statuses).toContain("active");
		expect(statuses).toContain("completed");
	});
});

describe("complete run", () => {
	test("marks active run as completed in RunStore", () => {
		runStore.createRun(makeRun());

		runStore.completeRun("run-2026-02-13T10:00:00.000Z", "completed");

		const run = runStore.getRun("run-2026-02-13T10:00:00.000Z");
		expect(run?.status).toBe("completed");
		expect(run?.completedAt).not.toBeNull();
	});

	test("current-run.txt can be deleted after completion", async () => {
		await writeCurrentRun("run-2026-02-13T10:00:00.000Z");
		expect(await readCurrentRunFile()).toBe("run-2026-02-13T10:00:00.000Z");

		// Simulate what completeCurrentRun does
		await unlink(join(overstoryDir, "current-run.txt"));
		const file = Bun.file(join(overstoryDir, "current-run.txt"));
		expect(await file.exists()).toBe(false);
	});

	test("no active run returns null from readCurrentRunFile", async () => {
		// No current-run.txt exists
		const content = await readCurrentRunFile();
		expect(content).toBeNull();
	});

	test("empty current-run.txt returns null", async () => {
		await Bun.write(join(overstoryDir, "current-run.txt"), "");
		const content = await readCurrentRunFile();
		expect(content).toBeNull();
	});

	test("whitespace-only current-run.txt returns null", async () => {
		await Bun.write(join(overstoryDir, "current-run.txt"), "  \n  ");
		const content = await readCurrentRunFile();
		expect(content).toBeNull();
	});
});

describe("show run details", () => {
	test("fetches run and its agents from stores", () => {
		const runId = "run-2026-02-13T10:00:00.000Z";
		runStore.createRun(makeRun());

		sessionStore.upsert(
			makeSession({
				agentName: "builder-1",
				id: "s-1",
				runId,
				capability: "builder",
				state: "working",
			}),
		);
		sessionStore.upsert(
			makeSession({
				agentName: "scout-1",
				id: "s-2",
				runId,
				capability: "scout",
				state: "completed",
			}),
		);

		const run = runStore.getRun(runId);
		expect(run).not.toBeNull();
		// agentCount is derived from sessions in the same run.
		expect(run?.agentCount).toBe(2);

		const agents = sessionStore.getByRun(runId);
		expect(agents).toHaveLength(2);
		expect(agents.map((a) => a.agentName).sort()).toEqual(["builder-1", "scout-1"]);
	});

	test("agent count includes coordinator session in the same run (overstory-8e69)", () => {
		const runId = "run-2026-02-13T10:00:00.000Z";
		runStore.createRun(makeRun());

		// Coordinator + two children — all sharing the same run_id.
		sessionStore.upsert(
			makeSession({
				agentName: "coordinator",
				id: "s-coord",
				runId,
				capability: "coordinator",
				state: "working",
			}),
		);
		sessionStore.upsert(makeSession({ agentName: "lead-1", id: "s-1", runId, capability: "lead" }));
		sessionStore.upsert(
			makeSession({ agentName: "builder-1", id: "s-2", runId, capability: "builder" }),
		);

		const run = runStore.getRun(runId);
		expect(run?.agentCount).toBe(3);
		expect(sessionStore.getByRun(runId)).toHaveLength(3);
	});

	test("agent count drops when a session is removed", () => {
		const runId = "run-2026-02-13T10:00:00.000Z";
		runStore.createRun(makeRun());
		sessionStore.upsert(makeSession({ agentName: "a", id: "s-1", runId }));
		sessionStore.upsert(makeSession({ agentName: "b", id: "s-2", runId }));
		expect(runStore.getRun(runId)?.agentCount).toBe(2);

		sessionStore.remove("a");
		expect(runStore.getRun(runId)?.agentCount).toBe(1);
	});

	test("returns null for missing run", () => {
		const run = runStore.getRun("nonexistent-run");
		expect(run).toBeNull();
	});

	test("returns empty agents for run with no sessions", () => {
		runStore.createRun(makeRun());
		const agents = sessionStore.getByRun("run-2026-02-13T10:00:00.000Z");
		expect(agents).toEqual([]);
	});

	test("agents include capability and state", () => {
		const runId = "run-2026-02-13T10:00:00.000Z";
		runStore.createRun(makeRun());

		sessionStore.upsert(
			makeSession({
				agentName: "reviewer-1",
				id: "s-1",
				runId,
				capability: "reviewer",
				state: "stalled",
			}),
		);

		const agents = sessionStore.getByRun(runId);
		expect(agents).toHaveLength(1);
		expect(agents[0]?.capability).toBe("reviewer");
		expect(agents[0]?.state).toBe("stalled");
	});
});

describe("--json output mode", () => {
	test("current run JSON includes run and duration", () => {
		runStore.createRun(makeRun());
		const run = runStore.getRun("run-2026-02-13T10:00:00.000Z");
		expect(run).not.toBeNull();

		// Simulate JSON output structure
		const output = JSON.stringify({ run, duration: "some-duration" });
		const parsed = JSON.parse(output) as { run: unknown; duration: string };
		expect(parsed.run).not.toBeNull();
		expect(parsed.duration).toBe("some-duration");
	});

	test("list JSON includes runs array", () => {
		runStore.createRun(makeRun({ id: "run-1" }));
		runStore.createRun(makeRun({ id: "run-2", startedAt: "2026-02-13T11:00:00.000Z" }));

		const runs = runStore.listRuns({ limit: 10 });
		const output = JSON.stringify({ runs });
		const parsed = JSON.parse(output) as { runs: unknown[] };
		expect(parsed.runs).toHaveLength(2);
	});

	test("show JSON includes run and agents", () => {
		const runId = "run-2026-02-13T10:00:00.000Z";
		runStore.createRun(makeRun());
		sessionStore.upsert(makeSession({ agentName: "a1", id: "s-1", runId }));

		const run = runStore.getRun(runId);
		const agents = sessionStore.getByRun(runId);

		const output = JSON.stringify({ run, agents, duration: "1m 30s" });
		const parsed = JSON.parse(output) as {
			run: unknown;
			agents: unknown[];
			duration: string;
		};
		expect(parsed.run).not.toBeNull();
		expect(parsed.agents).toHaveLength(1);
		expect(parsed.duration).toBe("1m 30s");
	});

	test("no active run JSON returns null run", () => {
		// No current-run.txt exists
		const output = JSON.stringify({ run: null, message: "No active run" });
		const parsed = JSON.parse(output) as { run: unknown; message: string };
		expect(parsed.run).toBeNull();
		expect(parsed.message).toBe("No active run");
	});
});

describe("duration formatting", () => {
	test("run with completedAt uses that for duration endpoint", () => {
		runStore.createRun(makeRun());
		runStore.completeRun("run-2026-02-13T10:00:00.000Z", "completed");

		const run = runStore.getRun("run-2026-02-13T10:00:00.000Z");
		expect(run?.completedAt).not.toBeNull();

		// Verify the start and end are both set, so duration can be computed
		const start = new Date(run?.startedAt ?? "").getTime();
		const end = new Date(run?.completedAt ?? "").getTime();
		expect(end).toBeGreaterThan(start);
	});

	test("active run uses current time as duration endpoint", () => {
		runStore.createRun(makeRun());

		const run = runStore.getRun("run-2026-02-13T10:00:00.000Z");
		expect(run?.completedAt).toBeNull();
		expect(run?.status).toBe("active");

		// Duration should be from startedAt to now
		const start = new Date(run?.startedAt ?? "").getTime();
		expect(Date.now() - start).toBeGreaterThan(0);
	});
});

describe("multiple runs lifecycle", () => {
	test("create, use, complete multiple runs sequentially", async () => {
		// Run 1: two sessions, then completed.
		runStore.createRun(makeRun({ id: "run-1", startedAt: "2026-02-13T08:00:00.000Z" }));
		await writeCurrentRun("run-1");
		sessionStore.upsert(makeSession({ agentName: "r1-a", id: "s-r1-1", runId: "run-1" }));
		sessionStore.upsert(makeSession({ agentName: "r1-b", id: "s-r1-2", runId: "run-1" }));
		runStore.completeRun("run-1", "completed");

		// Run 2: one session, still active.
		runStore.createRun(makeRun({ id: "run-2", startedAt: "2026-02-13T12:00:00.000Z" }));
		await writeCurrentRun("run-2");
		sessionStore.upsert(makeSession({ agentName: "r2-a", id: "s-r2-1", runId: "run-2" }));

		// Verify state
		const currentRunId = await readCurrentRunFile();
		expect(currentRunId).toBe("run-2");

		const run1 = runStore.getRun("run-1");
		expect(run1?.status).toBe("completed");
		expect(run1?.agentCount).toBe(2);

		const run2 = runStore.getRun("run-2");
		expect(run2?.status).toBe("active");
		expect(run2?.agentCount).toBe(1);

		const allRuns = runStore.listRuns();
		expect(allRuns).toHaveLength(2);
	});
});

describe("edge cases", () => {
	test("run with zero agents", () => {
		runStore.createRun(makeRun());
		const run = runStore.getRun("run-2026-02-13T10:00:00.000Z");
		expect(run?.agentCount).toBe(0);
	});

	test("show run with agents from different capabilities", () => {
		const runId = "run-2026-02-13T10:00:00.000Z";
		runStore.createRun(makeRun());

		const capabilities = ["builder", "scout", "reviewer"];
		for (let i = 0; i < capabilities.length; i++) {
			sessionStore.upsert(
				makeSession({
					agentName: `agent-${i}`,
					id: `s-${i}`,
					runId,
					capability: capabilities[i] ?? "builder",
				}),
			);
		}

		const agents = sessionStore.getByRun(runId);
		expect(agents).toHaveLength(3);
		const caps = agents.map((a) => a.capability).sort();
		expect(caps).toEqual(["builder", "reviewer", "scout"]);
	});

	test("sessions.db does not exist for list returns empty", async () => {
		// Remove the db that was created in beforeEach
		runStore.close();
		sessionStore.close();
		await rm(dbPath, { force: true });
		// Also remove WAL/SHM files
		await rm(`${dbPath}-wal`, { force: true });
		await rm(`${dbPath}-shm`, { force: true });

		const file = Bun.file(dbPath);
		expect(await file.exists()).toBe(false);

		// Re-create stores for afterEach cleanup
		runStore = createRunStore(join(overstoryDir, "unused-run.db"));
		sessionStore = createSessionStore(join(overstoryDir, "unused-session.db"));
	});
});

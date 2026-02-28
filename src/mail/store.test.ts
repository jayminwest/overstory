import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { MailError } from "../errors.ts";
import { cleanupTempDir } from "../test-helpers.ts";
import type { MailMessage } from "../types.ts";
import { createMailStore, type MailStore } from "./store.ts";

describe("createMailStore", () => {
	let tempDir: string;
	let store: MailStore;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "overstory-mail-test-"));
		store = createMailStore(join(tempDir, "mail.db"));
	});

	afterEach(async () => {
		store.close();
		await cleanupTempDir(tempDir);
	});

	describe("insert", () => {
		test("inserts a message and returns it with generated id and timestamp", () => {
			const msg = store.insert({
				id: "",
				from: "agent-a",
				to: "orchestrator",
				subject: "status update",
				body: "All tests passing",
				type: "status",
				priority: "normal",
				threadId: null,
			});

			expect(msg.id).toMatch(/^msg-[a-z0-9]{12}$/);
			expect(msg.from).toBe("agent-a");
			expect(msg.to).toBe("orchestrator");
			expect(msg.subject).toBe("status update");
			expect(msg.body).toBe("All tests passing");
			expect(msg.type).toBe("status");
			expect(msg.priority).toBe("normal");
			expect(msg.threadId).toBeNull();
			expect(msg.read).toBe(false);
			expect(msg.createdAt).toBeTruthy();
		});

		test("uses provided id if non-empty", () => {
			const msg = store.insert({
				id: "custom-id-123",
				from: "agent-a",
				to: "orchestrator",
				subject: "test",
				body: "test body",
				type: "status",
				priority: "normal",
				threadId: null,
			});

			expect(msg.id).toBe("custom-id-123");
		});

		test("throws MailError on duplicate id", () => {
			store.insert({
				id: "dupe-id",
				from: "agent-a",
				to: "orchestrator",
				subject: "first",
				body: "first message",
				type: "status",
				priority: "normal",
				threadId: null,
			});

			expect(() =>
				store.insert({
					id: "dupe-id",
					from: "agent-b",
					to: "orchestrator",
					subject: "second",
					body: "second message",
					type: "status",
					priority: "normal",
					threadId: null,
				}),
			).toThrow(MailError);
		});
	});

	describe("getById", () => {
		test("returns message by id", () => {
			store.insert({
				id: "msg-test-001",
				from: "agent-a",
				to: "orchestrator",
				subject: "test",
				body: "body",
				type: "status",
				priority: "normal",
				threadId: null,
			});

			const msg = store.getById("msg-test-001");
			expect(msg).not.toBeNull();
			expect(msg?.id).toBe("msg-test-001");
			expect(msg?.from).toBe("agent-a");
		});

		test("returns null for non-existent id", () => {
			const msg = store.getById("nonexistent");
			expect(msg).toBeNull();
		});
	});

	describe("getUnread", () => {
		test("returns unread messages for a specific agent", () => {
			store.insert({
				id: "",
				from: "agent-a",
				to: "orchestrator",
				subject: "msg1",
				body: "body1",
				type: "status",
				priority: "normal",
				threadId: null,
			});
			store.insert({
				id: "",
				from: "agent-b",
				to: "orchestrator",
				subject: "msg2",
				body: "body2",
				type: "status",
				priority: "normal",
				threadId: null,
			});
			store.insert({
				id: "",
				from: "agent-a",
				to: "agent-c",
				subject: "msg3",
				body: "body3",
				type: "status",
				priority: "normal",
				threadId: null,
			});

			const unread = store.getUnread("orchestrator");
			expect(unread).toHaveLength(2);
			expect(unread[0]?.subject).toBe("msg1");
			expect(unread[1]?.subject).toBe("msg2");
		});

		test("returns empty array when no unread messages", () => {
			const unread = store.getUnread("orchestrator");
			expect(unread).toHaveLength(0);
		});

		test("does not return already-read messages", () => {
			const msg = store.insert({
				id: "",
				from: "agent-a",
				to: "orchestrator",
				subject: "test",
				body: "body",
				type: "status",
				priority: "normal",
				threadId: null,
			});
			store.markRead(msg.id);

			const unread = store.getUnread("orchestrator");
			expect(unread).toHaveLength(0);
		});

		test("returns messages in chronological order (ASC)", () => {
			store.insert({
				id: "msg-first",
				from: "agent-a",
				to: "orchestrator",
				subject: "first",
				body: "body",
				type: "status",
				priority: "normal",
				threadId: null,
			});
			store.insert({
				id: "msg-second",
				from: "agent-b",
				to: "orchestrator",
				subject: "second",
				body: "body",
				type: "status",
				priority: "normal",
				threadId: null,
			});

			const unread = store.getUnread("orchestrator");
			expect(unread[0]?.id).toBe("msg-first");
			expect(unread[1]?.id).toBe("msg-second");
		});
	});

	describe("markRead", () => {
		test("marks a message as read", () => {
			const msg = store.insert({
				id: "msg-to-read",
				from: "agent-a",
				to: "orchestrator",
				subject: "test",
				body: "body",
				type: "status",
				priority: "normal",
				threadId: null,
			});

			store.markRead(msg.id);

			const fetched = store.getById(msg.id);
			expect(fetched?.read).toBe(true);
		});

		test("is idempotent (marking already-read message does not error)", () => {
			const msg = store.insert({
				id: "msg-idempotent",
				from: "agent-a",
				to: "orchestrator",
				subject: "test",
				body: "body",
				type: "status",
				priority: "normal",
				threadId: null,
			});

			store.markRead(msg.id);
			store.markRead(msg.id);

			const fetched = store.getById(msg.id);
			expect(fetched?.read).toBe(true);
		});
	});

	describe("getAll", () => {
		test("returns all messages without filters", () => {
			store.insert({
				id: "",
				from: "agent-a",
				to: "orchestrator",
				subject: "msg1",
				body: "body1",
				type: "status",
				priority: "normal",
				threadId: null,
			});
			store.insert({
				id: "",
				from: "agent-b",
				to: "agent-c",
				subject: "msg2",
				body: "body2",
				type: "question",
				priority: "high",
				threadId: null,
			});

			const all = store.getAll();
			expect(all).toHaveLength(2);
		});

		test("filters by from", () => {
			store.insert({
				id: "",
				from: "agent-a",
				to: "orchestrator",
				subject: "msg1",
				body: "body1",
				type: "status",
				priority: "normal",
				threadId: null,
			});
			store.insert({
				id: "",
				from: "agent-b",
				to: "orchestrator",
				subject: "msg2",
				body: "body2",
				type: "status",
				priority: "normal",
				threadId: null,
			});

			const filtered = store.getAll({ from: "agent-a" });
			expect(filtered).toHaveLength(1);
			expect(filtered[0]?.from).toBe("agent-a");
		});

		test("filters by to", () => {
			store.insert({
				id: "",
				from: "agent-a",
				to: "orchestrator",
				subject: "msg1",
				body: "body1",
				type: "status",
				priority: "normal",
				threadId: null,
			});
			store.insert({
				id: "",
				from: "agent-a",
				to: "agent-b",
				subject: "msg2",
				body: "body2",
				type: "status",
				priority: "normal",
				threadId: null,
			});

			const filtered = store.getAll({ to: "agent-b" });
			expect(filtered).toHaveLength(1);
			expect(filtered[0]?.to).toBe("agent-b");
		});

		test("filters by unread", () => {
			const msg1 = store.insert({
				id: "",
				from: "agent-a",
				to: "orchestrator",
				subject: "msg1",
				body: "body1",
				type: "status",
				priority: "normal",
				threadId: null,
			});
			store.insert({
				id: "",
				from: "agent-b",
				to: "orchestrator",
				subject: "msg2",
				body: "body2",
				type: "status",
				priority: "normal",
				threadId: null,
			});
			store.markRead(msg1.id);

			const unreadOnly = store.getAll({ unread: true });
			expect(unreadOnly).toHaveLength(1);
			expect(unreadOnly[0]?.subject).toBe("msg2");

			const readOnly = store.getAll({ unread: false });
			expect(readOnly).toHaveLength(1);
			expect(readOnly[0]?.subject).toBe("msg1");
		});

		test("respects limit option", () => {
			for (let i = 1; i <= 5; i++) {
				store.insert({
					id: "",
					from: "agent-a",
					to: "orchestrator",
					subject: `msg${i}`,
					body: `body${i}`,
					type: "status",
					priority: "normal",
					threadId: null,
				});
			}

			const limited = store.getAll({ limit: 3 });
			expect(limited).toHaveLength(3);
		});

		test("limit combined with filter", () => {
			for (let i = 1; i <= 4; i++) {
				store.insert({
					id: "",
					from: "agent-a",
					to: "orchestrator",
					subject: `a-msg${i}`,
					body: `body`,
					type: "status",
					priority: "normal",
					threadId: null,
				});
			}
			store.insert({
				id: "",
				from: "agent-b",
				to: "orchestrator",
				subject: "b-msg",
				body: "body",
				type: "status",
				priority: "normal",
				threadId: null,
			});

			const limited = store.getAll({ from: "agent-a", limit: 2 });
			expect(limited).toHaveLength(2);
			expect(limited.every((m) => m.from === "agent-a")).toBe(true);
		});

		test("combines multiple filters", () => {
			store.insert({
				id: "",
				from: "agent-a",
				to: "orchestrator",
				subject: "msg1",
				body: "body1",
				type: "status",
				priority: "normal",
				threadId: null,
			});
			store.insert({
				id: "",
				from: "agent-a",
				to: "agent-b",
				subject: "msg2",
				body: "body2",
				type: "status",
				priority: "normal",
				threadId: null,
			});
			store.insert({
				id: "",
				from: "agent-b",
				to: "orchestrator",
				subject: "msg3",
				body: "body3",
				type: "status",
				priority: "normal",
				threadId: null,
			});

			const filtered = store.getAll({ from: "agent-a", to: "orchestrator" });
			expect(filtered).toHaveLength(1);
			expect(filtered[0]?.subject).toBe("msg1");
		});
	});

	describe("getByThread", () => {
		test("returns messages in the same thread", () => {
			store.insert({
				id: "msg-thread-1",
				from: "agent-a",
				to: "orchestrator",
				subject: "question",
				body: "first message",
				type: "question",
				priority: "normal",
				threadId: "thread-123",
			});
			store.insert({
				id: "msg-thread-2",
				from: "orchestrator",
				to: "agent-a",
				subject: "Re: question",
				body: "reply",
				type: "status",
				priority: "normal",
				threadId: "thread-123",
			});
			store.insert({
				id: "msg-other",
				from: "agent-b",
				to: "orchestrator",
				subject: "unrelated",
				body: "different thread",
				type: "status",
				priority: "normal",
				threadId: "thread-456",
			});

			const thread = store.getByThread("thread-123");
			expect(thread).toHaveLength(2);
			expect(thread[0]?.id).toBe("msg-thread-1");
			expect(thread[1]?.id).toBe("msg-thread-2");
		});

		test("returns empty array for non-existent thread", () => {
			const thread = store.getByThread("nonexistent");
			expect(thread).toHaveLength(0);
		});
	});

	describe("WAL mode and concurrent access", () => {
		test("second store instance can read while first is writing", () => {
			const store2 = createMailStore(join(tempDir, "mail.db"));

			store.insert({
				id: "msg-concurrent",
				from: "agent-a",
				to: "orchestrator",
				subject: "test",
				body: "concurrent",
				type: "status",
				priority: "normal",
				threadId: null,
			});

			const msg = store2.getById("msg-concurrent");
			expect(msg).not.toBeNull();
			expect(msg?.body).toBe("concurrent");

			store2.close();
		});
	});

	describe("CHECK constraints", () => {
		test("rejects invalid type at DB level", () => {
			expect(() =>
				store.insert({
					id: "msg-bad-type",
					from: "agent-a",
					to: "orchestrator",
					subject: "test",
					body: "body",
					type: "invalid_type" as MailMessage["type"],
					priority: "normal",
					threadId: null,
				}),
			).toThrow();
		});

		test("rejects invalid priority at DB level", () => {
			expect(() =>
				store.insert({
					id: "msg-bad-prio",
					from: "agent-a",
					to: "orchestrator",
					subject: "test",
					body: "body",
					type: "status",
					priority: "invalid_prio" as MailMessage["priority"],
					threadId: null,
				}),
			).toThrow();
		});

		test("accepts all valid type values including protocol types", () => {
			const types: MailMessage["type"][] = [
				"status",
				"question",
				"result",
				"error",
				"worker_done",
				"merge_ready",
				"merged",
				"merge_failed",
				"escalation",
				"health_check",
				"dispatch",
				"assign",
			];
			for (const type of types) {
				const msg = store.insert({
					id: "",
					from: "agent-a",
					to: "orchestrator",
					subject: `type-${type}`,
					body: "body",
					type,
					priority: "normal",
					threadId: null,
				});
				expect(msg.type).toBe(type);
			}
		});

		test("accepts all valid priority values", () => {
			const priorities: MailMessage["priority"][] = ["low", "normal", "high", "urgent"];
			for (const priority of priorities) {
				const msg = store.insert({
					id: "",
					from: "agent-a",
					to: "orchestrator",
					subject: `prio-${priority}`,
					body: "body",
					type: "status",
					priority,
					threadId: null,
				});
				expect(msg.priority).toBe(priority);
			}
		});

		test("migrates existing table to add payload column and protocol types", () => {
			// Create a second store to verify migration works on an existing DB
			// The beforeEach already created the DB with constraints,
			// so this tests that reopening is safe
			const store2 = createMailStore(join(tempDir, "mail.db"));
			const msg = store2.insert({
				id: "msg-after-migration",
				from: "agent-a",
				to: "orchestrator",
				subject: "migration test",
				body: "body",
				type: "status",
				priority: "normal",
				threadId: null,
			});
			expect(msg.id).toBe("msg-after-migration");

			// Invalid values should still be rejected
			expect(() =>
				store2.insert({
					id: "msg-bad-after",
					from: "agent-a",
					to: "orchestrator",
					subject: "test",
					body: "body",
					type: "bogus" as MailMessage["type"],
					priority: "normal",
					threadId: null,
				}),
			).toThrow();

			store2.close();
		});
	});

	describe("project_id support", () => {
		test("insert defaults project_id to '_default'", () => {
			const msg = store.insert({
				id: "msg-default-proj",
				from: "agent-a",
				to: "orchestrator",
				subject: "test",
				body: "body",
				type: "status",
				priority: "normal",
				threadId: null,
			});

			expect(msg.projectId).toBe("_default");

			const fetched = store.getById(msg.id);
			expect(fetched?.projectId).toBe("_default");
		});

		test("insert with explicit project_id stores it correctly", () => {
			const msg = store.insert({
				id: "msg-proj-a",
				from: "agent-a",
				to: "orchestrator",
				subject: "test",
				body: "body",
				type: "status",
				priority: "normal",
				threadId: null,
				projectId: "project-alpha",
			});

			expect(msg.projectId).toBe("project-alpha");

			const fetched = store.getById(msg.id);
			expect(fetched?.projectId).toBe("project-alpha");
		});

		test("getUnread filters by project_id when provided", () => {
			store.insert({
				id: "msg-proj-1",
				from: "agent-a",
				to: "orchestrator",
				subject: "alpha msg",
				body: "body",
				type: "status",
				priority: "normal",
				threadId: null,
				projectId: "project-alpha",
			});
			store.insert({
				id: "msg-proj-2",
				from: "agent-b",
				to: "orchestrator",
				subject: "beta msg",
				body: "body",
				type: "status",
				priority: "normal",
				threadId: null,
				projectId: "project-beta",
			});

			const alphaUnread = store.getUnread("orchestrator", "project-alpha");
			expect(alphaUnread).toHaveLength(1);
			expect(alphaUnread[0]?.subject).toBe("alpha msg");

			const betaUnread = store.getUnread("orchestrator", "project-beta");
			expect(betaUnread).toHaveLength(1);
			expect(betaUnread[0]?.subject).toBe("beta msg");
		});

		test("getUnread returns all projects when projectId omitted (backward compat)", () => {
			store.insert({
				id: "msg-all-1",
				from: "agent-a",
				to: "orchestrator",
				subject: "alpha msg",
				body: "body",
				type: "status",
				priority: "normal",
				threadId: null,
				projectId: "project-alpha",
			});
			store.insert({
				id: "msg-all-2",
				from: "agent-b",
				to: "orchestrator",
				subject: "beta msg",
				body: "body",
				type: "status",
				priority: "normal",
				threadId: null,
				projectId: "project-beta",
			});

			const allUnread = store.getUnread("orchestrator");
			expect(allUnread).toHaveLength(2);
		});

		test("getAll filters by project_id when provided", () => {
			store.insert({
				id: "msg-filter-1",
				from: "agent-a",
				to: "orchestrator",
				subject: "alpha",
				body: "body",
				type: "status",
				priority: "normal",
				threadId: null,
				projectId: "project-alpha",
			});
			store.insert({
				id: "msg-filter-2",
				from: "agent-b",
				to: "orchestrator",
				subject: "beta",
				body: "body",
				type: "status",
				priority: "normal",
				threadId: null,
				projectId: "project-beta",
			});
			store.insert({
				id: "msg-filter-3",
				from: "agent-c",
				to: "orchestrator",
				subject: "also alpha",
				body: "body",
				type: "status",
				priority: "normal",
				threadId: null,
				projectId: "project-alpha",
			});

			const alphaAll = store.getAll({ projectId: "project-alpha" });
			expect(alphaAll).toHaveLength(2);
			for (const m of alphaAll) {
				expect(m.projectId).toBe("project-alpha");
			}
		});

		test("migration: create old DB without project_id column, reopen, verify migration adds it", async () => {
			const oldDbDir = await mkdtemp(join(tmpdir(), "overstory-mail-migrate-"));
			const oldDbPath = join(oldDbDir, "mail.db");

			try {
				// Create an old-style DB manually (without project_id)
				const rawDb = new Database(oldDbPath);
				rawDb.exec("PRAGMA journal_mode = WAL");
				rawDb.exec(`
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  from_agent TEXT NOT NULL,
  to_agent TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'status' CHECK(type IN ('status','question','result','error','worker_done','merge_ready','merged','merge_failed','escalation','health_check','dispatch','assign')),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('low','normal','high','urgent')),
  thread_id TEXT,
  payload TEXT,
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);
				rawDb.exec(
					`INSERT INTO messages (id, from_agent, to_agent, subject, body) VALUES ('old-msg-1', 'a', 'b', 'sub', 'bod')`,
				);
				rawDb.close();

				// Reopen via createMailStore — should trigger migration
				const migratedStore = createMailStore(oldDbPath);

				// Existing message should have '_default' project_id after migration
				const msg = migratedStore.getById("old-msg-1");
				expect(msg).not.toBeNull();
				expect(msg?.projectId).toBe("_default");

				// New inserts should work with project_id
				const newMsg = migratedStore.insert({
					id: "new-after-migrate",
					from: "agent-a",
					to: "orchestrator",
					subject: "new",
					body: "body",
					type: "status",
					priority: "normal",
					threadId: null,
					projectId: "project-x",
				});
				expect(newMsg.projectId).toBe("project-x");

				migratedStore.close();
			} finally {
				await rm(oldDbDir, { recursive: true, force: true });
			}
		});
	});

	describe("payload column", () => {
		test("stores null payload by default when not provided", () => {
			const msg = store.insert({
				id: "msg-no-payload",
				from: "agent-a",
				to: "orchestrator",
				subject: "test",
				body: "body",
				type: "status",
				priority: "normal",
				threadId: null,
			});

			const fetched = store.getById(msg.id);
			expect(fetched?.payload).toBeNull();
		});

		test("stores JSON payload string", () => {
			const payload = JSON.stringify({
				taskId: "beads-abc",
				branch: "agent/builder-1",
				exitCode: 0,
				filesModified: ["src/foo.ts"],
			});
			const msg = store.insert({
				id: "msg-with-payload",
				from: "builder-1",
				to: "lead-1",
				subject: "Task complete",
				body: "Implementation finished",
				type: "worker_done",
				priority: "normal",
				threadId: null,
				payload,
			});

			const fetched = store.getById(msg.id);
			expect(fetched?.payload).toBe(payload);
			expect(fetched?.type).toBe("worker_done");
		});

		test("returns payload in getUnread results", () => {
			const payload = JSON.stringify({ severity: "critical", taskId: null, context: "OOM" });
			store.insert({
				id: "msg-escalation",
				from: "builder-1",
				to: "orchestrator",
				subject: "Escalation",
				body: "Out of memory",
				type: "escalation",
				priority: "urgent",
				threadId: null,
				payload,
			});

			const unread = store.getUnread("orchestrator");
			expect(unread).toHaveLength(1);
			expect(unread[0]?.payload).toBe(payload);
		});

		test("returns payload in getAll results", () => {
			const payload = JSON.stringify({
				branch: "agent/b1",
				taskId: "beads-xyz",
				tier: "clean-merge",
			});
			store.insert({
				id: "msg-merged",
				from: "merger-1",
				to: "lead-1",
				subject: "Merged",
				body: "Branch merged",
				type: "merged",
				priority: "normal",
				threadId: null,
				payload,
			});

			const all = store.getAll();
			expect(all).toHaveLength(1);
			expect(all[0]?.payload).toBe(payload);
		});
	});
});

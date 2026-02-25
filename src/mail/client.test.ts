import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MailError } from "../errors.ts";
import { cleanupTempDir } from "../test-helpers.ts";
import type { WorkerDonePayload } from "../types.ts";
import { createMailClient, type MailClient, parseAddress, parsePayload } from "./client.ts";
import { createMailStore, type MailStore } from "./store.ts";

describe("parseAddress", () => {
	test("plain agent name returns null projectId", () => {
		const result = parseAddress("scout-1");
		expect(result).toEqual({ projectId: null, agentName: "scout-1" });
	});

	test("project:agent returns parsed projectId and agentName", () => {
		const result = parseAddress("frontend:scout-1");
		expect(result).toEqual({ projectId: "frontend", agentName: "scout-1" });
	});

	test("group addresses pass through without parsing", () => {
		const result = parseAddress("@all");
		expect(result).toEqual({ projectId: null, agentName: "@all" });
	});

	test("@workspace passes through as group address", () => {
		const result = parseAddress("@workspace");
		expect(result).toEqual({ projectId: null, agentName: "@workspace" });
	});

	test("only first colon is treated as separator", () => {
		const result = parseAddress("proj:agent:extra");
		expect(result).toEqual({ projectId: "proj", agentName: "agent:extra" });
	});

	test("colon at start is not treated as separator", () => {
		const result = parseAddress(":agent");
		expect(result).toEqual({ projectId: null, agentName: ":agent" });
	});

	test("trailing colon is not treated as separator", () => {
		const result = parseAddress("project:");
		expect(result).toEqual({ projectId: null, agentName: "project:" });
	});

	test("workspace as plain agent name works", () => {
		const result = parseAddress("workspace");
		expect(result).toEqual({ projectId: null, agentName: "workspace" });
	});
});

describe("createMailClient", () => {
	let tempDir: string;
	let store: MailStore;
	let client: MailClient;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "overstory-mail-client-test-"));
		store = createMailStore(join(tempDir, "mail.db"));
		client = createMailClient(store);
	});

	afterEach(async () => {
		client.close();
		await cleanupTempDir(tempDir);
	});

	describe("send", () => {
		test("returns a message ID", () => {
			const id = client.send({
				from: "agent-a",
				to: "orchestrator",
				subject: "Status update",
				body: "All tests passing",
			});

			expect(id).toMatch(/^msg-[a-z0-9]{12}$/);
		});

		test("defaults type to 'status' when not provided", () => {
			const id = client.send({
				from: "agent-a",
				to: "orchestrator",
				subject: "Update",
				body: "Done",
			});

			const msg = store.getById(id);
			expect(msg).not.toBeNull();
			expect(msg?.type).toBe("status");
		});

		test("defaults priority to 'normal' when not provided", () => {
			const id = client.send({
				from: "agent-a",
				to: "orchestrator",
				subject: "Update",
				body: "Done",
			});

			const msg = store.getById(id);
			expect(msg).not.toBeNull();
			expect(msg?.priority).toBe("normal");
		});

		test("uses provided type and priority", () => {
			const id = client.send({
				from: "agent-a",
				to: "orchestrator",
				subject: "Help needed",
				body: "Blocked on dependency",
				type: "question",
				priority: "high",
			});

			const msg = store.getById(id);
			expect(msg).not.toBeNull();
			expect(msg?.type).toBe("question");
			expect(msg?.priority).toBe("high");
		});

		test("stores all message fields correctly", () => {
			const id = client.send({
				from: "builder-1",
				to: "lead-1",
				subject: "Task complete",
				body: "Implementation finished",
				type: "result",
				priority: "low",
				threadId: "thread-abc",
			});

			const msg = store.getById(id);
			expect(msg).not.toBeNull();
			expect(msg?.from).toBe("builder-1");
			expect(msg?.to).toBe("lead-1");
			expect(msg?.subject).toBe("Task complete");
			expect(msg?.body).toBe("Implementation finished");
			expect(msg?.threadId).toBe("thread-abc");
			expect(msg?.read).toBe(false);
		});

		test("uses defaultProjectId when no cross-project prefix", () => {
			const projectClient = createMailClient(store, "backend");
			const id = projectClient.send({
				from: "agent-a",
				to: "orchestrator",
				subject: "test",
				body: "body",
			});
			const msg = store.getById(id);
			expect(msg?.projectId).toBe("backend");
		});

		test("cross-project prefix overrides defaultProjectId", () => {
			const projectClient = createMailClient(store, "backend");
			const id = projectClient.send({
				from: "agent-a",
				to: "frontend:scout-1",
				subject: "cross-project",
				body: "hello",
			});
			const msg = store.getById(id);
			expect(msg?.to).toBe("scout-1");
			expect(msg?.projectId).toBe("frontend");
		});

		test("falls back to _default when no prefix and no defaultProjectId", () => {
			const id = client.send({
				from: "agent-a",
				to: "orchestrator",
				subject: "test",
				body: "body",
			});
			const msg = store.getById(id);
			expect(msg?.projectId).toBe("_default");
		});
	});

	describe("check", () => {
		test("returns unread messages for the agent", () => {
			client.send({
				from: "agent-a",
				to: "orchestrator",
				subject: "msg1",
				body: "body1",
			});
			client.send({
				from: "agent-b",
				to: "orchestrator",
				subject: "msg2",
				body: "body2",
			});

			const messages = client.check("orchestrator");
			expect(messages).toHaveLength(2);
			expect(messages[0]?.subject).toBe("msg1");
			expect(messages[1]?.subject).toBe("msg2");
		});

		test("marks returned messages as read", () => {
			client.send({
				from: "agent-a",
				to: "orchestrator",
				subject: "msg1",
				body: "body1",
			});

			const firstCheck = client.check("orchestrator");
			expect(firstCheck).toHaveLength(1);

			// Second check should return empty since messages are now read
			const secondCheck = client.check("orchestrator");
			expect(secondCheck).toHaveLength(0);
		});

		test("returns empty array when no unread messages", () => {
			const messages = client.check("orchestrator");
			expect(messages).toHaveLength(0);
		});

		test("only returns messages addressed to the specified agent", () => {
			client.send({
				from: "agent-a",
				to: "orchestrator",
				subject: "for-orch",
				body: "body",
			});
			client.send({
				from: "agent-a",
				to: "agent-b",
				subject: "for-b",
				body: "body",
			});

			const messages = client.check("orchestrator");
			expect(messages).toHaveLength(1);
			expect(messages[0]?.subject).toBe("for-orch");
		});
	});

	describe("checkInject", () => {
		test("returns empty string when no unread messages", () => {
			const result = client.checkInject("orchestrator");
			expect(result).toBe("");
		});

		test("formats single message with count of 1", () => {
			client.send({
				from: "agent-a",
				to: "orchestrator",
				subject: "Build complete",
				body: "All 42 tests pass",
			});

			const result = client.checkInject("orchestrator");
			expect(result).toContain("1 new message");
			expect(result).not.toContain("messages:");
		});

		test("includes sender name in formatted output", () => {
			client.send({
				from: "builder-1",
				to: "orchestrator",
				subject: "Done",
				body: "Finished implementation",
			});

			const result = client.checkInject("orchestrator");
			expect(result).toContain("From: builder-1");
		});

		test("includes subject in formatted output", () => {
			client.send({
				from: "agent-a",
				to: "orchestrator",
				subject: "Important Update",
				body: "Details here",
			});

			const result = client.checkInject("orchestrator");
			expect(result).toContain("Subject: Important Update");
		});

		test("includes message body in formatted output", () => {
			client.send({
				from: "agent-a",
				to: "orchestrator",
				subject: "Update",
				body: "The implementation is complete and all tests pass.",
			});

			const result = client.checkInject("orchestrator");
			expect(result).toContain("The implementation is complete and all tests pass.");
		});

		test("includes reply command with message id", () => {
			const id = client.send({
				from: "agent-a",
				to: "orchestrator",
				subject: "Question",
				body: "Need clarification",
			});

			const result = client.checkInject("orchestrator");
			expect(result).toContain(`ov mail reply ${id}`);
		});

		test("formats multiple messages with correct count", () => {
			client.send({
				from: "agent-a",
				to: "orchestrator",
				subject: "msg1",
				body: "body1",
			});
			client.send({
				from: "agent-b",
				to: "orchestrator",
				subject: "msg2",
				body: "body2",
			});
			client.send({
				from: "agent-c",
				to: "orchestrator",
				subject: "msg3",
				body: "body3",
			});

			const result = client.checkInject("orchestrator");
			expect(result).toContain("3 new messages");
			expect(result).toContain("From: agent-a");
			expect(result).toContain("From: agent-b");
			expect(result).toContain("From: agent-c");
		});

		test("shows priority tag for high priority", () => {
			client.send({
				from: "agent-a",
				to: "orchestrator",
				subject: "Urgent matter",
				body: "Need help now",
				priority: "high",
			});

			const result = client.checkInject("orchestrator");
			expect(result).toContain("[HIGH]");
		});

		test("shows priority tag for urgent priority", () => {
			client.send({
				from: "agent-a",
				to: "orchestrator",
				subject: "Critical failure",
				body: "Build broken",
				priority: "urgent",
			});

			const result = client.checkInject("orchestrator");
			expect(result).toContain("[URGENT]");
		});

		test("shows priority tag for low priority", () => {
			client.send({
				from: "agent-a",
				to: "orchestrator",
				subject: "FYI",
				body: "Minor note",
				priority: "low",
			});

			const result = client.checkInject("orchestrator");
			expect(result).toContain("[LOW]");
		});

		test("does not show priority tag for normal priority", () => {
			client.send({
				from: "agent-a",
				to: "orchestrator",
				subject: "Update",
				body: "Regular update",
				priority: "normal",
			});

			const result = client.checkInject("orchestrator");
			expect(result).not.toContain("[NORMAL]");
		});

		test("marks messages as read after injection", () => {
			client.send({
				from: "agent-a",
				to: "orchestrator",
				subject: "msg1",
				body: "body1",
			});

			const first = client.checkInject("orchestrator");
			expect(first).not.toBe("");

			// Second call should return empty since messages are marked read
			const second = client.checkInject("orchestrator");
			expect(second).toBe("");
		});
	});

	describe("list", () => {
		test("returns all messages without filters", () => {
			client.send({
				from: "agent-a",
				to: "orchestrator",
				subject: "msg1",
				body: "body1",
			});
			client.send({
				from: "agent-b",
				to: "agent-c",
				subject: "msg2",
				body: "body2",
			});

			const messages = client.list();
			expect(messages).toHaveLength(2);
		});

		test("filters by from", () => {
			client.send({
				from: "agent-a",
				to: "orchestrator",
				subject: "msg1",
				body: "body1",
			});
			client.send({
				from: "agent-b",
				to: "orchestrator",
				subject: "msg2",
				body: "body2",
			});

			const messages = client.list({ from: "agent-a" });
			expect(messages).toHaveLength(1);
			expect(messages[0]?.from).toBe("agent-a");
		});

		test("filters by to", () => {
			client.send({
				from: "agent-a",
				to: "orchestrator",
				subject: "msg1",
				body: "body1",
			});
			client.send({
				from: "agent-a",
				to: "agent-b",
				subject: "msg2",
				body: "body2",
			});

			const messages = client.list({ to: "agent-b" });
			expect(messages).toHaveLength(1);
			expect(messages[0]?.to).toBe("agent-b");
		});

		test("filters by unread status", () => {
			client.send({
				from: "agent-a",
				to: "orchestrator",
				subject: "msg1",
				body: "body1",
			});
			const id2 = client.send({
				from: "agent-b",
				to: "orchestrator",
				subject: "msg2",
				body: "body2",
			});
			client.markRead(id2);

			const unread = client.list({ unread: true });
			expect(unread).toHaveLength(1);
			expect(unread[0]?.subject).toBe("msg1");
		});
	});

	describe("markRead", () => {
		test("marks a message as read", () => {
			const id = client.send({
				from: "agent-a",
				to: "orchestrator",
				subject: "test",
				body: "body",
			});

			client.markRead(id);

			const msg = store.getById(id);
			expect(msg).not.toBeNull();
			expect(msg?.read).toBe(true);
		});

		test("throws MailError when message does not exist", () => {
			expect(() => client.markRead("nonexistent-id")).toThrow(MailError);
		});

		test("MailError includes the missing message ID", () => {
			try {
				client.markRead("bad-msg-id");
				expect(true).toBe(false);
			} catch (err) {
				expect(err).toBeInstanceOf(MailError);
				expect((err as MailError).message).toContain("bad-msg-id");
			}
		});
	});

	describe("reply", () => {
		test("creates a reply addressed to original sender", () => {
			const originalId = client.send({
				from: "agent-a",
				to: "orchestrator",
				subject: "Question about API",
				body: "How do I use the merge endpoint?",
				type: "question",
				priority: "normal",
			});

			const replyId = client.reply(originalId, "Use POST /merge with branch param", "orchestrator");

			const replyMsg = store.getById(replyId);
			expect(replyMsg).not.toBeNull();
			expect(replyMsg?.from).toBe("orchestrator");
			expect(replyMsg?.to).toBe("agent-a");
		});

		test("sets subject to 'Re: {original subject}'", () => {
			const originalId = client.send({
				from: "agent-a",
				to: "orchestrator",
				subject: "Build Status",
				body: "Tests failing",
			});

			const replyId = client.reply(originalId, "Looking into it", "orchestrator");

			const replyMsg = store.getById(replyId);
			expect(replyMsg).not.toBeNull();
			expect(replyMsg?.subject).toBe("Re: Build Status");
		});

		test("uses original message id as threadId when original has no threadId", () => {
			const originalId = client.send({
				from: "agent-a",
				to: "orchestrator",
				subject: "New thread",
				body: "Starting conversation",
			});

			const replyId = client.reply(originalId, "Reply here", "orchestrator");

			const replyMsg = store.getById(replyId);
			expect(replyMsg).not.toBeNull();
			expect(replyMsg?.threadId).toBe(originalId);
		});

		test("preserves threadId from original message when present", () => {
			const originalId = client.send({
				from: "agent-a",
				to: "orchestrator",
				subject: "In-thread message",
				body: "Part of existing thread",
				threadId: "thread-root-123",
			});

			const replyId = client.reply(originalId, "Continuing thread", "orchestrator");

			const replyMsg = store.getById(replyId);
			expect(replyMsg).not.toBeNull();
			expect(replyMsg?.threadId).toBe("thread-root-123");
		});

		test("preserves original message type in reply", () => {
			const originalId = client.send({
				from: "agent-a",
				to: "orchestrator",
				subject: "Error report",
				body: "Something broke",
				type: "error",
			});

			const replyId = client.reply(originalId, "Fixed", "orchestrator");

			const replyMsg = store.getById(replyId);
			expect(replyMsg).not.toBeNull();
			expect(replyMsg?.type).toBe("error");
		});

		test("preserves original priority in reply", () => {
			const originalId = client.send({
				from: "agent-a",
				to: "orchestrator",
				subject: "Urgent",
				body: "Need help",
				priority: "urgent",
			});

			const replyId = client.reply(originalId, "On it", "orchestrator");

			const replyMsg = store.getById(replyId);
			expect(replyMsg).not.toBeNull();
			expect(replyMsg?.priority).toBe("urgent");
		});

		test("returns the reply message ID", () => {
			const originalId = client.send({
				from: "agent-a",
				to: "orchestrator",
				subject: "Test",
				body: "Test body",
			});

			const replyId = client.reply(originalId, "Reply body", "orchestrator");
			expect(replyId).toMatch(/^msg-[a-z0-9]{12}$/);
		});

		test("throws MailError when original message not found", () => {
			expect(() => client.reply("nonexistent-id", "reply body", "orchestrator")).toThrow(MailError);
		});

		test("MailError includes the missing message ID", () => {
			try {
				client.reply("bad-msg-id", "reply body", "orchestrator");
				expect(true).toBe(false);
			} catch (err) {
				expect(err).toBeInstanceOf(MailError);
				expect((err as MailError).message).toContain("bad-msg-id");
			}
		});

		test("reply to own sent message goes to original recipient, not back to sender", () => {
			// Scenario: orchestrator sends to status-builder, then replies to that same message
			const originalId = client.send({
				from: "orchestrator",
				to: "status-builder",
				subject: "Task assignment",
				body: "Please implement feature X",
			});

			// Orchestrator replies to their own sent message
			const replyId = client.reply(originalId, "Actually, also do Y", "orchestrator");

			const replyMsg = store.getById(replyId);
			expect(replyMsg).not.toBeNull();
			expect(replyMsg?.from).toBe("orchestrator");
			// Reply should go to status-builder (original.to), not orchestrator (original.from)
			expect(replyMsg?.to).toBe("status-builder");
		});

		test("reply from a third party goes to original sender", () => {
			// Scenario: agent-a sends to agent-b, but agent-c replies (edge case)
			const originalId = client.send({
				from: "agent-a",
				to: "agent-b",
				subject: "Question",
				body: "Need info",
			});

			// agent-c is neither sender nor recipient of original
			const replyId = client.reply(originalId, "I can help", "agent-c");

			const replyMsg = store.getById(replyId);
			expect(replyMsg).not.toBeNull();
			expect(replyMsg?.from).toBe("agent-c");
			// Third-party reply goes to original sender
			expect(replyMsg?.to).toBe("agent-a");
		});

		test("reply preserves original message projectId", () => {
			const projectClient = createMailClient(store, "frontend");
			const originalId = projectClient.send({
				from: "agent-a",
				to: "orchestrator",
				subject: "Question",
				body: "Help?",
			});
			const otherClient = createMailClient(store, "backend");
			const replyId = otherClient.reply(originalId, "Sure", "orchestrator");
			const replyMsg = store.getById(replyId);
			expect(replyMsg?.projectId).toBe("frontend");
		});
	});

	describe("sendProtocol", () => {
		test("sends a worker_done message with serialized payload", () => {
			const payload: WorkerDonePayload = {
				taskId: "beads-abc",
				branch: "agent/builder-1",
				exitCode: 0,
				filesModified: ["src/foo.ts", "src/bar.ts"],
			};
			const id = client.sendProtocol({
				from: "builder-1",
				to: "lead-1",
				subject: "Task complete",
				body: "Implementation finished, all tests pass",
				type: "worker_done",
				payload,
			});

			const msg = store.getById(id);
			expect(msg).not.toBeNull();
			expect(msg?.type).toBe("worker_done");
			expect(msg?.payload).toBe(JSON.stringify(payload));
		});

		test("defaults priority to normal", () => {
			const id = client.sendProtocol({
				from: "merger-1",
				to: "lead-1",
				subject: "Merged",
				body: "Branch merged",
				type: "merged",
				payload: { branch: "agent/b1", taskId: "beads-xyz", tier: "clean-merge" as const },
			});

			const msg = store.getById(id);
			expect(msg?.priority).toBe("normal");
		});

		test("respects provided priority", () => {
			const id = client.sendProtocol({
				from: "builder-1",
				to: "orchestrator",
				subject: "Escalation",
				body: "Build failing",
				type: "escalation",
				priority: "urgent",
				payload: { severity: "critical" as const, taskId: null, context: "OOM" },
			});

			const msg = store.getById(id);
			expect(msg?.priority).toBe("urgent");
		});

		test("preserves threadId", () => {
			const id = client.sendProtocol({
				from: "lead-1",
				to: "builder-1",
				subject: "Assign task",
				body: "Please implement feature X",
				type: "assign",
				threadId: "thread-dispatch-1",
				payload: {
					taskId: "beads-123",
					specPath: ".overstory/specs/beads-123.md",
					workerName: "builder-1",
					branch: "agent/builder-1",
				},
			});

			const msg = store.getById(id);
			expect(msg?.threadId).toBe("thread-dispatch-1");
		});
	});

	describe("parsePayload", () => {
		test("parses a valid JSON payload", () => {
			const payload: WorkerDonePayload = {
				taskId: "beads-abc",
				branch: "agent/builder-1",
				exitCode: 0,
				filesModified: ["src/foo.ts"],
			};
			const id = client.sendProtocol({
				from: "builder-1",
				to: "lead-1",
				subject: "Done",
				body: "Done",
				type: "worker_done",
				payload,
			});

			const msg = store.getById(id);
			if (msg === null) throw new Error("expected message");
			const parsed = parsePayload(msg, "worker_done");
			expect(parsed).toEqual(payload);
		});

		test("returns null for message with no payload", () => {
			const id = client.send({
				from: "agent-a",
				to: "orchestrator",
				subject: "Status",
				body: "All good",
			});

			const msg = store.getById(id);
			if (msg === null) throw new Error("expected message");
			const parsed = parsePayload(msg, "worker_done");
			expect(parsed).toBeNull();
		});

		test("returns null for invalid JSON payload", () => {
			// Manually insert a message with malformed payload via store
			const msg = store.insert({
				projectId: "_default",
				id: "msg-bad-json",
				from: "agent-a",
				to: "orchestrator",
				subject: "Bad",
				body: "Bad payload",
				type: "worker_done",
				priority: "normal",
				threadId: null,
				payload: "not valid json{{{",
			});

			const parsed = parsePayload(msg, "worker_done");
			expect(parsed).toBeNull();
		});
	});

	describe("checkInject with protocol messages", () => {
		test("includes payload in injection output for protocol messages", () => {
			const payload: WorkerDonePayload = {
				taskId: "beads-abc",
				branch: "agent/builder-1",
				exitCode: 0,
				filesModified: ["src/foo.ts"],
			};
			client.sendProtocol({
				from: "builder-1",
				to: "orchestrator",
				subject: "Task complete",
				body: "Implementation done",
				type: "worker_done",
				payload,
			});

			const result = client.checkInject("orchestrator");
			expect(result).toContain("worker_done");
			expect(result).toContain("Payload:");
			expect(result).toContain("beads-abc");
		});

		test("does not include payload line for semantic messages", () => {
			client.send({
				from: "agent-a",
				to: "orchestrator",
				subject: "Status",
				body: "All good",
			});

			const result = client.checkInject("orchestrator");
			expect(result).not.toContain("Payload:");
		});
	});

	describe("close", () => {
		test("closes without error", () => {
			// Create a separate client/store to test close independently
			const tempStore = createMailStore(join(tempDir, "mail-close-test.db"));
			const tempClient = createMailClient(tempStore);

			// Should not throw
			tempClient.close();
		});
	});
});

describe("createMailClient projectId filtering", () => {
	let tempDir: string;
	let store: MailStore;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "overstory-mail-projectid-test-"));
		store = createMailStore(join(tempDir, "mail.db"));
	});

	afterEach(async () => {
		store.close();
		await rm(tempDir, { recursive: true, force: true });
	});

	describe("check() projectId filtering", () => {
		test("returns only same-project messages when defaultProjectId is set", () => {
			const frontendClient = createMailClient(store, "frontend");
			const backendClient = createMailClient(store, "backend");
			frontendClient.send({
				from: "agent-a",
				to: "orchestrator",
				subject: "frontend msg",
				body: "body",
			});
			backendClient.send({
				from: "agent-b",
				to: "orchestrator",
				subject: "backend msg",
				body: "body",
			});

			const messages = frontendClient.check("orchestrator");
			expect(messages).toHaveLength(1);
			expect(messages[0]?.subject).toBe("frontend msg");
		});

		test("returns all messages when no defaultProjectId set", () => {
			const noProjectClient = createMailClient(store);
			const projectClient = createMailClient(store, "frontend");
			projectClient.send({ from: "agent-a", to: "orchestrator", subject: "msg1", body: "body" });
			noProjectClient.send({ from: "agent-b", to: "orchestrator", subject: "msg2", body: "body" });

			const messages = noProjectClient.check("orchestrator");
			expect(messages).toHaveLength(2);
		});
	});

	describe("checkInject() projectId filtering", () => {
		test("returns only same-project messages when defaultProjectId is set", () => {
			const frontendClient = createMailClient(store, "frontend");
			const backendClient = createMailClient(store, "backend");
			frontendClient.send({
				from: "agent-a",
				to: "orchestrator",
				subject: "frontend msg",
				body: "body",
			});
			backendClient.send({
				from: "agent-b",
				to: "orchestrator",
				subject: "backend msg",
				body: "body",
			});

			const result = frontendClient.checkInject("orchestrator");
			expect(result).toContain("frontend msg");
			expect(result).not.toContain("backend msg");
		});
	});

	describe("list() projectId filtering", () => {
		test("filters by defaultProjectId", () => {
			const frontendClient = createMailClient(store, "frontend");
			const backendClient = createMailClient(store, "backend");
			frontendClient.send({
				from: "agent-a",
				to: "orchestrator",
				subject: "frontend",
				body: "body",
			});
			backendClient.send({ from: "agent-b", to: "orchestrator", subject: "backend", body: "body" });

			const messages = frontendClient.list();
			expect(messages).toHaveLength(1);
			expect(messages[0]?.subject).toBe("frontend");
		});

		test("explicit projectId in filters overrides defaultProjectId", () => {
			const frontendClient = createMailClient(store, "frontend");
			const backendClient = createMailClient(store, "backend");
			frontendClient.send({
				from: "agent-a",
				to: "orchestrator",
				subject: "frontend",
				body: "body",
			});
			backendClient.send({ from: "agent-b", to: "orchestrator", subject: "backend", body: "body" });

			const messages = frontendClient.list({ projectId: "backend" });
			expect(messages).toHaveLength(1);
			expect(messages[0]?.subject).toBe("backend");
		});
	});
});

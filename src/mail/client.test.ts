import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MailError } from "../errors.ts";
import { type MailClient, createMailClient } from "./client.ts";
import { type MailStore, createMailStore } from "./store.ts";

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
		await rm(tempDir, { recursive: true, force: true });
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
			expect(result).toContain(`overstory mail reply ${id}`);
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

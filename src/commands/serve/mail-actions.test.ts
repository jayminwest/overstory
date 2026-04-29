/**
 * Unit tests for the operator mail action helpers.
 *
 * Uses real SQLite stores in temp directories — no mocks. Each test gets a
 * fresh mail.db / sessions.db pair so tests are fully isolated.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ValidationError } from "../../errors.ts";
import type { MailStore } from "../../mail/store.ts";
import { createMailStore } from "../../mail/store.ts";
import type { SessionStore } from "../../sessions/store.ts";
import { createSessionStore } from "../../sessions/store.ts";
import type { AgentSession } from "../../types.ts";
import { deleteMail, replyMail, sendMail } from "./mail-actions.ts";

interface TestContext {
	tempDir: string;
	mail: MailStore;
	session: SessionStore;
}

function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
	const id = `sess-${Math.random().toString(36).slice(2)}`;
	return {
		id,
		agentName: overrides.agentName ?? `agent-${Math.random().toString(36).slice(2)}`,
		capability: overrides.capability ?? "builder",
		worktreePath: "/tmp/wt",
		branchName: "branch",
		taskId: "task-1",
		tmuxSession: "tmux-sess",
		state: overrides.state ?? "working",
		pid: null,
		parentAgent: null,
		depth: 0,
		runId: null,
		startedAt: overrides.startedAt ?? new Date().toISOString(),
		lastActivity: new Date().toISOString(),
		escalationLevel: 0,
		stalledSince: null,
		transcriptPath: null,
		...overrides,
	};
}

describe("mail-actions", () => {
	let ctx: TestContext;

	beforeEach(() => {
		const tempDir = mkdtempSync(join(tmpdir(), "overstory-mail-actions-"));
		const mail = createMailStore(join(tempDir, "mail.db"));
		const session = createSessionStore(join(tempDir, "sessions.db"));
		ctx = { tempDir, mail, session };
	});

	afterEach(() => {
		ctx.mail.close();
		ctx.session.close();
		rmSync(ctx.tempDir, { recursive: true, force: true });
	});

	// ─── sendMail ─────────────────────────────────────────────────────────────

	describe("sendMail", () => {
		test("writes a row for a concrete recipient", () => {
			ctx.session.upsert(makeSession({ agentName: "alice", capability: "builder" }));

			const result = sendMail(ctx, {
				to: "alice",
				subject: "hi",
				body: "hello",
			});

			expect(result).toHaveProperty("messageId");
			const id = (result as { messageId: string }).messageId;
			const row = ctx.mail.getById(id);
			expect(row).not.toBeNull();
			expect(row?.to).toBe("alice");
			expect(row?.subject).toBe("hi");
			expect(row?.body).toBe("hello");
		});

		test("defaults from to 'operator' and type to 'status'", () => {
			ctx.session.upsert(makeSession({ agentName: "bob" }));

			const result = sendMail(ctx, { to: "bob", subject: "s", body: "b" });
			const id = (result as { messageId: string }).messageId;
			const row = ctx.mail.getById(id);

			expect(row?.from).toBe("operator");
			expect(row?.type).toBe("status");
			expect(row?.priority).toBe("normal");
		});

		test("accepts an explicit from override", () => {
			ctx.session.upsert(makeSession({ agentName: "carol" }));

			const result = sendMail(ctx, {
				to: "carol",
				from: "alice",
				subject: "s",
				body: "b",
			});
			const id = (result as { messageId: string }).messageId;
			expect(ctx.mail.getById(id)?.from).toBe("alice");
		});

		test("rejects unknown type with ValidationError", () => {
			ctx.session.upsert(makeSession({ agentName: "dora" }));

			expect(() => sendMail(ctx, { to: "dora", subject: "s", body: "b", type: "bogus" })).toThrow(
				ValidationError,
			);
		});

		test("rejects unknown priority with ValidationError", () => {
			ctx.session.upsert(makeSession({ agentName: "eve" }));

			expect(() => sendMail(ctx, { to: "eve", subject: "s", body: "b", priority: "huge" })).toThrow(
				ValidationError,
			);
		});

		test("rejects unknown recipient with ValidationError", () => {
			expect(() => sendMail(ctx, { to: "ghost", subject: "s", body: "b" })).toThrow(
				ValidationError,
			);
		});

		test("rejects missing required fields", () => {
			expect(() => sendMail(ctx, { subject: "s", body: "b" })).toThrow(ValidationError);
			expect(() => sendMail(ctx, { to: "x", body: "b" })).toThrow(ValidationError);
			expect(() => sendMail(ctx, { to: "x", subject: "s" })).toThrow(ValidationError);
			expect(() => sendMail(ctx, { to: "x", subject: "s", body: "" })).toThrow(ValidationError);
		});

		test("resolves @builders to all active builders and fans out", () => {
			ctx.session.upsert(makeSession({ agentName: "b1", capability: "builder" }));
			ctx.session.upsert(makeSession({ agentName: "b2", capability: "builder" }));
			ctx.session.upsert(makeSession({ agentName: "s1", capability: "scout" }));

			const result = sendMail(ctx, {
				to: "@builders",
				subject: "ping",
				body: "all builders",
			});

			expect(result).toHaveProperty("messageIds");
			const ids = (result as { messageIds: string[] }).messageIds;
			expect(ids.length).toBe(2);
			const recipients = ids.map((id) => ctx.mail.getById(id)?.to).sort();
			expect(recipients).toEqual(["b1", "b2"]);
		});

		test("rejects @unknown group with ValidationError", () => {
			ctx.session.upsert(makeSession({ agentName: "z1", capability: "builder" }));

			expect(() => sendMail(ctx, { to: "@nope", subject: "s", body: "b" })).toThrow(
				ValidationError,
			);
		});

		test("rejects @builders when there are no active builders", () => {
			ctx.session.upsert(makeSession({ agentName: "s1", capability: "scout" }));

			expect(() => sendMail(ctx, { to: "@builders", subject: "s", body: "b" })).toThrow(
				ValidationError,
			);
		});

		test("excludes sender from group fan-out", () => {
			ctx.session.upsert(makeSession({ agentName: "b1", capability: "builder" }));
			ctx.session.upsert(makeSession({ agentName: "b2", capability: "builder" }));

			const result = sendMail(ctx, {
				to: "@builders",
				from: "b1",
				subject: "s",
				body: "b",
			});

			const ids = (result as { messageIds: string[] }).messageIds;
			expect(ids.length).toBe(1);
			expect(ctx.mail.getById(ids[0] ?? "")?.to).toBe("b2");
		});

		test("persists payload when provided", () => {
			ctx.session.upsert(makeSession({ agentName: "alice" }));

			const payload = JSON.stringify({ foo: 1 });
			const result = sendMail(ctx, {
				to: "alice",
				subject: "s",
				body: "b",
				payload,
			});
			const id = (result as { messageId: string }).messageId;
			expect(ctx.mail.getById(id)?.payload).toBe(payload);
		});

		test("accepts a completed session as a known historical recipient", () => {
			ctx.session.upsert(makeSession({ agentName: "ghost-of-builders-past", state: "completed" }));

			const result = sendMail(ctx, {
				to: "ghost-of-builders-past",
				subject: "s",
				body: "b",
			});
			expect(result).toHaveProperty("messageId");
		});
	});

	// ─── replyMail ────────────────────────────────────────────────────────────

	describe("replyMail", () => {
		test("writes a reply on the thread and returns the new id", () => {
			const original = ctx.mail.insert({
				id: "msg-orig",
				from: "alice",
				to: "operator",
				subject: "Hi",
				body: "first",
				type: "status",
				priority: "normal",
				threadId: null,
			});

			const result = replyMail(ctx, original.id, { body: "thanks" });

			expect(result.messageId).toBeTruthy();
			const reply = ctx.mail.getById(result.messageId);
			expect(reply?.from).toBe("operator");
			expect(reply?.to).toBe("alice");
			expect(reply?.body).toBe("thanks");
			expect(reply?.threadId).toBe(original.id);
			expect(reply?.subject).toBe("Re: Hi");
		});

		test("ignores type and priority in the reply payload (forward compat)", () => {
			const original = ctx.mail.insert({
				id: "msg-orig-2",
				from: "alice",
				to: "operator",
				subject: "Hi",
				body: "first",
				type: "question",
				priority: "high",
				threadId: null,
			});

			const result = replyMail(ctx, original.id, {
				body: "ack",
				type: "bogus",
				priority: "huge",
			});

			const reply = ctx.mail.getById(result.messageId);
			// Reply inherits type/priority from the original — body fields are ignored.
			expect(reply?.type).toBe("question");
			expect(reply?.priority).toBe("high");
		});

		test("throws ValidationError when message not found", () => {
			expect(() => replyMail(ctx, "msg-missing", { body: "x" })).toThrow(ValidationError);
		});

		test("rejects empty body with ValidationError", () => {
			const original = ctx.mail.insert({
				id: "msg-3",
				from: "alice",
				to: "operator",
				subject: "Hi",
				body: "first",
				type: "status",
				priority: "normal",
				threadId: null,
			});

			expect(() => replyMail(ctx, original.id, { body: "" })).toThrow(ValidationError);
			expect(() => replyMail(ctx, original.id, {})).toThrow(ValidationError);
		});
	});

	// ─── deleteMail ───────────────────────────────────────────────────────────

	describe("deleteMail", () => {
		test("happy path returns { deleted: true } and removes the row", () => {
			const msg = ctx.mail.insert({
				id: "msg-del",
				from: "a",
				to: "b",
				subject: "s",
				body: "b",
				type: "status",
				priority: "normal",
				threadId: null,
			});

			const result = deleteMail(ctx, msg.id);
			expect(result).toEqual({ id: msg.id, deleted: true });
			expect(ctx.mail.getById(msg.id)).toBeNull();
		});

		test("returns null when row is absent", () => {
			expect(deleteMail(ctx, "msg-nope")).toBeNull();
		});
	});
});

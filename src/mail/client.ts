/**
 * Mail client for inter-agent messaging.
 *
 * Wraps the low-level MailStore with higher-level operations:
 * send, check, checkInject (hook format), list, markRead, reply.
 * Synchronous by design (bun:sqlite is sync, ~1-5ms per query).
 */

import { MailError } from "../errors.ts";
import type { MailMessage } from "../types.ts";
import type { MailStore } from "./store.ts";

export interface MailClient {
	/** Send a new message. Returns the assigned message ID. */
	send(msg: {
		from: string;
		to: string;
		subject: string;
		body: string;
		type?: MailMessage["type"];
		priority?: MailMessage["priority"];
		threadId?: string;
	}): string;

	/** Get unread messages for an agent. Marks them as read. */
	check(agentName: string): MailMessage[];

	/** Get unread messages formatted for hook injection (human-readable string). */
	checkInject(agentName: string): string;

	/** List messages with optional filters. */
	list(filters?: { from?: string; to?: string; unread?: boolean }): MailMessage[];

	/** Mark a message as read by ID. Returns whether the message was already read. */
	markRead(id: string): { alreadyRead: boolean };

	/** Reply to a message. Returns the new message ID. */
	reply(messageId: string, body: string, from: string): string;

	/** Close the underlying store. */
	close(): void;
}

/**
 * Format messages for hook injection.
 *
 * Produces a human-readable block that gets injected into the agent's
 * context via the UserPromptSubmit hook.
 */
function formatForInjection(messages: MailMessage[]): string {
	if (messages.length === 0) {
		return "";
	}

	const lines: string[] = [
		`📬 You have ${messages.length} new message${messages.length === 1 ? "" : "s"}:`,
		"",
	];

	for (const msg of messages) {
		const priorityTag = msg.priority !== "normal" ? ` [${msg.priority.toUpperCase()}]` : "";
		lines.push(`--- From: ${msg.from}${priorityTag} (${msg.type}) ---`);
		lines.push(`Subject: ${msg.subject}`);
		lines.push(msg.body);
		lines.push(`[Reply with: overstory mail reply ${msg.id} --body "..."]`);
		lines.push("");
	}

	return lines.join("\n");
}

/**
 * Create a MailClient wrapping the given MailStore.
 *
 * @param store - The underlying MailStore for persistence
 * @returns A MailClient with send, check, checkInject, list, markRead, reply
 */
export function createMailClient(store: MailStore): MailClient {
	return {
		send(msg): string {
			const message = store.insert({
				id: "",
				from: msg.from,
				to: msg.to,
				subject: msg.subject,
				body: msg.body,
				type: msg.type ?? "status",
				priority: msg.priority ?? "normal",
				threadId: msg.threadId ?? null,
			});
			return message.id;
		},

		check(agentName): MailMessage[] {
			const messages = store.getUnread(agentName);
			for (const msg of messages) {
				store.markRead(msg.id);
			}
			return messages;
		},

		checkInject(agentName): string {
			const messages = store.getUnread(agentName);
			for (const msg of messages) {
				store.markRead(msg.id);
			}
			return formatForInjection(messages);
		},

		list(filters): MailMessage[] {
			return store.getAll(filters);
		},

		markRead(id): { alreadyRead: boolean } {
			const msg = store.getById(id);
			if (!msg) {
				throw new MailError(`Message not found: ${id}`, {
					messageId: id,
				});
			}
			if (msg.read) {
				return { alreadyRead: true };
			}
			store.markRead(id);
			return { alreadyRead: false };
		},

		reply(messageId, body, from): string {
			const original = store.getById(messageId);
			if (!original) {
				throw new MailError(`Message not found: ${messageId}`, {
					messageId,
				});
			}

			const threadId = original.threadId ?? original.id;

			// Determine the correct recipient: reply goes to "the other side"
			// If the replier is the original sender, reply goes to the original recipient.
			// If the replier is the original recipient (or anyone else), reply goes to the original sender.
			const to = from === original.from ? original.to : original.from;

			const reply = store.insert({
				id: "",
				from,
				to,
				subject: `Re: ${original.subject}`,
				body,
				type: original.type,
				priority: original.priority,
				threadId,
			});
			return reply.id;
		},

		close(): void {
			store.close();
		},
	};
}

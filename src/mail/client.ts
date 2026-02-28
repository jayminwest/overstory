/**
 * Mail client for inter-agent messaging.
 *
 * Wraps the low-level MailStore with higher-level operations:
 * send, check, checkInject (hook format), list, markRead, reply.
 * Synchronous by design (bun:sqlite is sync, ~1-5ms per query).
 */

import { MailError } from "../errors.ts";
import type { MailMessage, MailPayloadMap, MailProtocolType } from "../types.ts";
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
		payload?: string;
	}): string;

	/** Send a typed protocol message with structured payload. Returns the message ID. */
	sendProtocol<T extends MailProtocolType>(msg: {
		from: string;
		to: string;
		subject: string;
		body: string;
		type: T;
		priority?: MailMessage["priority"];
		threadId?: string;
		payload: MailPayloadMap[T];
	}): string;

	/** Get unread messages for an agent. Marks them as read. */
	check(agentName: string, projectId?: string): MailMessage[];

	/** Get unread messages formatted for hook injection (human-readable string). */
	checkInject(agentName: string, projectId?: string): string;

	/** List messages with optional filters. */
	list(filters?: {
		from?: string;
		to?: string;
		unread?: boolean;
		projectId?: string;
	}): MailMessage[];

	/** Mark a message as read by ID. Returns whether the message was already read. */
	markRead(id: string): { alreadyRead: boolean };

	/** Reply to a message. Returns the new message ID. */
	reply(messageId: string, body: string, from: string): string;

	/** Close the underlying store. */
	close(): void;
}

/**
 * Parse a JSON payload from a mail message, returning the typed object.
 * Returns null if the message has no payload or if parsing fails.
 */
export function parsePayload<T extends MailProtocolType>(
	message: MailMessage,
	_expectedType: T,
): MailPayloadMap[T] | null {
	if (message.payload === null) {
		return null;
	}
	try {
		return JSON.parse(message.payload) as MailPayloadMap[T];
	} catch {
		return null;
	}
}

/**
 * Parse an address in optional "project:agent" form.
 * Group addresses and invalid separator forms are returned unchanged.
 */
export function parseAddress(address: string): { projectId: string | null; agentName: string } {
	if (address.startsWith("@")) {
		return { projectId: null, agentName: address };
	}
	const sep = address.indexOf(":");
	if (sep <= 0 || sep === address.length - 1) {
		return { projectId: null, agentName: address };
	}
	return {
		projectId: address.slice(0, sep),
		agentName: address.slice(sep + 1),
	};
}

/** Protocol types that represent structured coordination messages. */
const PROTOCOL_TYPES = new Set<string>([
	"worker_done",
	"merge_ready",
	"merged",
	"merge_failed",
	"escalation",
	"health_check",
	"dispatch",
	"assign",
]);

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
		`You have ${messages.length} new message${messages.length === 1 ? "" : "s"}:`,
		"",
	];

	for (const msg of messages) {
		const priorityTag = msg.priority !== "normal" ? ` [${msg.priority.toUpperCase()}]` : "";
		lines.push(`--- From: ${msg.from}${priorityTag} (${msg.type}) ---`);
		lines.push(`Subject: ${msg.subject}`);
		lines.push(msg.body);
		if (msg.payload !== null && PROTOCOL_TYPES.has(msg.type)) {
			lines.push(`Payload: ${msg.payload}`);
		}
		lines.push(`[Reply with: ov mail reply ${msg.id} --body "..."]`);
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
export function createMailClient(store: MailStore, defaultProjectId?: string): MailClient {
	return {
		send(msg): string {
			const fromParsed = parseAddress(msg.from);
			const toParsed = parseAddress(msg.to);
			const resolvedProjectId =
				toParsed.projectId ?? fromParsed.projectId ?? defaultProjectId ?? "_default";
			const message = store.insert({
				id: "",
				from: fromParsed.agentName,
				to: toParsed.agentName,
				subject: msg.subject,
				body: msg.body,
				type: msg.type ?? "status",
				priority: msg.priority ?? "normal",
				threadId: msg.threadId ?? null,
				payload: msg.payload ?? null,
				projectId: resolvedProjectId,
			});
			return message.id;
		},

		sendProtocol(msg): string {
			const fromParsed = parseAddress(msg.from);
			const toParsed = parseAddress(msg.to);
			const resolvedProjectId =
				toParsed.projectId ?? fromParsed.projectId ?? defaultProjectId ?? "_default";
			const message = store.insert({
				id: "",
				from: fromParsed.agentName,
				to: toParsed.agentName,
				subject: msg.subject,
				body: msg.body,
				type: msg.type,
				priority: msg.priority ?? "normal",
				threadId: msg.threadId ?? null,
				payload: JSON.stringify(msg.payload),
				projectId: resolvedProjectId,
			});
			return message.id;
		},

		check(agentName, projectId): MailMessage[] {
			const resolvedProjectId = projectId ?? defaultProjectId;
			const messages = store.getUnread(agentName, resolvedProjectId);
			for (const msg of messages) {
				store.markRead(msg.id);
			}
			return messages;
		},

		checkInject(agentName, projectId): string {
			const resolvedProjectId = projectId ?? defaultProjectId;
			const messages = store.getUnread(agentName, resolvedProjectId);
			for (const msg of messages) {
				store.markRead(msg.id);
			}
			return formatForInjection(messages);
		},

		list(filters): MailMessage[] {
			const projectId = filters?.projectId ?? defaultProjectId;
			return store.getAll({ ...filters, projectId });
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
				payload: null,
				projectId: original.projectId ?? defaultProjectId,
			});
			return reply.id;
		},

		close(): void {
			store.close();
		},
	};
}

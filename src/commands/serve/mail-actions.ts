/**
 * Pure-logic mail action helpers for the operator console REST API.
 *
 * Handlers in rest.ts parse JSON bodies and call these helpers, which
 * validate input, resolve group addresses, and write to the mail store.
 * Errors are signalled via {@link OverstoryError} subclasses so the route
 * dispatcher can map them to HTTP status codes.
 */

import { ValidationError } from "../../errors.ts";
import { isGroupAddress, resolveGroupAddress } from "../../mail/broadcast.ts";
import { createMailClient } from "../../mail/client.ts";
import type { MailStore } from "../../mail/store.ts";
import type { SessionStore } from "../../sessions/store.ts";
import type { MailMessage, MailMessageType } from "../../types.ts";
import { MAIL_MESSAGE_TYPES } from "../../types.ts";

export interface MailActionStores {
	mail: MailStore;
	session: SessionStore;
}

const VALID_TYPES: ReadonlySet<string> = new Set(MAIL_MESSAGE_TYPES);
const VALID_PRIORITIES: ReadonlySet<string> = new Set(["low", "normal", "high", "urgent"]);
type MailPriority = MailMessage["priority"];

export interface SendMailInput {
	to?: unknown;
	from?: unknown;
	subject?: unknown;
	body?: unknown;
	type?: unknown;
	priority?: unknown;
	payload?: unknown;
}

export interface ReplyMailInput {
	from?: unknown;
	body?: unknown;
	// Accepted for forward compatibility; reply inherits these from the original.
	type?: unknown;
	priority?: unknown;
}

export type SendMailResult = { messageId: string } | { messageIds: string[] };

function requireString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new ValidationError(`Missing or empty field: ${field}`, { field, value });
	}
	return value;
}

function optionalString(value: unknown, field: string, fallback: string): string {
	if (value === undefined || value === null || value === "") return fallback;
	if (typeof value !== "string") {
		throw new ValidationError(`Field "${field}" must be a string`, { field, value });
	}
	return value;
}

/**
 * Send a new mail message. If `to` is a group address (`@all`, `@builders`, ...)
 * the message is fanned out to one row per resolved recipient.
 */
export function sendMail(stores: MailActionStores, input: SendMailInput): SendMailResult {
	const to = requireString(input.to, "to");
	const subject = requireString(input.subject, "subject");
	const body = requireString(input.body, "body");
	const from = optionalString(input.from, "from", "operator");

	const type = optionalString(input.type, "type", "status");
	if (!VALID_TYPES.has(type)) {
		throw new ValidationError(
			`Invalid type: "${type}". Must be one of: ${MAIL_MESSAGE_TYPES.join(", ")}`,
			{ field: "type", value: type },
		);
	}

	const priority = optionalString(input.priority, "priority", "normal");
	if (!VALID_PRIORITIES.has(priority)) {
		throw new ValidationError(
			`Invalid priority: "${priority}". Must be one of: low, normal, high, urgent`,
			{ field: "priority", value: priority },
		);
	}

	let payload: string | undefined;
	if (input.payload !== undefined && input.payload !== null && input.payload !== "") {
		if (typeof input.payload !== "string") {
			throw new ValidationError(`Field "payload" must be a string`, {
				field: "payload",
				value: input.payload,
			});
		}
		payload = input.payload;
	}

	const client = createMailClient(stores.mail);
	const sendOne = (recipient: string): string =>
		client.send({
			from,
			to: recipient,
			subject,
			body,
			type: type as MailMessageType,
			priority: priority as MailPriority,
			payload,
		});

	if (isGroupAddress(to)) {
		let recipients: string[];
		try {
			recipients = resolveGroupAddress(to, stores.session.getActive(), from);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			throw new ValidationError(msg, { field: "to", value: to });
		}
		const ids = recipients.map(sendOne);
		return { messageIds: ids };
	}

	if (stores.session.getByName(to) === null) {
		throw new ValidationError(`Unknown recipient: "${to}"`, { field: "to", value: to });
	}

	return { messageId: sendOne(to) };
}

/**
 * Reply to an existing message. Recipient, thread, type, and priority are
 * inherited from the original via {@link MailClient.reply}.
 *
 * Throws {@link ValidationError} when the original is missing. The route
 * handler also performs an upfront null-check so the HTTP response is 404,
 * but this guard keeps the action safe to call programmatically.
 */
export function replyMail(
	stores: MailActionStores,
	id: string,
	input: ReplyMailInput,
): { messageId: string } {
	const body = requireString(input.body, "body");
	const from = optionalString(input.from, "from", "operator");

	const original = stores.mail.getById(id);
	if (original === null) {
		throw new ValidationError(`Message not found: ${id}`, { field: "id", value: id });
	}

	const client = createMailClient(stores.mail);
	const messageId = client.reply(id, body, from);
	return { messageId };
}

/**
 * Delete a single message. Returns `null` when the row is absent so the route
 * handler can map that case to HTTP 404.
 */
export function deleteMail(
	stores: MailActionStores,
	id: string,
): { id: string; deleted: true } | null {
	const deleted = stores.mail.deleteById(id);
	if (!deleted) return null;
	return { id, deleted: true };
}

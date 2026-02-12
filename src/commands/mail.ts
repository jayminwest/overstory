/**
 * CLI command: overstory mail send/check/list/read/reply
 *
 * Parses CLI args and delegates to the mail client.
 * Supports --inject for hook context injection, --json for machine output,
 * and various filters for listing messages.
 */

import { join } from "node:path";
import { resolveProjectRoot } from "../config.ts";
import { MailError, ValidationError } from "../errors.ts";
import { createMailClient } from "../mail/client.ts";
import { createMailStore } from "../mail/store.ts";
import type { MailMessage } from "../types.ts";

/**
 * Parse a named flag value from an args array.
 * Returns the value after the flag, or undefined if not present.
 */
function getFlag(args: string[], flag: string): string | undefined {
	const idx = args.indexOf(flag);
	if (idx === -1 || idx + 1 >= args.length) {
		return undefined;
	}
	return args[idx + 1];
}

/** Check if a boolean flag is present in the args. */
function hasFlag(args: string[], flag: string): boolean {
	return args.includes(flag);
}

/** Format a single message for human-readable output. */
function formatMessage(msg: MailMessage): string {
	const readMarker = msg.read ? " " : "*";
	const priorityTag = msg.priority !== "normal" ? ` [${msg.priority.toUpperCase()}]` : "";
	const lines: string[] = [
		`${readMarker} ${msg.id}  From: ${msg.from} → To: ${msg.to}${priorityTag}`,
		`  Subject: ${msg.subject}  (${msg.type})`,
		`  ${msg.body}`,
		`  ${msg.createdAt}`,
	];
	return lines.join("\n");
}

/**
 * Open a mail store connected to the project's mail.db.
 * Resolves the path relative to cwd/.overstory/mail.db.
 */
function openStore(cwd: string) {
	const dbPath = join(cwd, ".overstory", "mail.db");
	return createMailStore(dbPath);
}

/**
 * Open a mail client connected to the project's mail.db.
 * Resolves the path relative to cwd/.overstory/mail.db.
 */
function openClient(cwd: string) {
	const store = openStore(cwd);
	const client = createMailClient(store);
	return client;
}

/** overstory mail send */
function handleSend(args: string[], cwd: string): void {
	const to = getFlag(args, "--to");
	const subject = getFlag(args, "--subject");
	const body = getFlag(args, "--body");
	const from = getFlag(args, "--agent") ?? getFlag(args, "--from") ?? "orchestrator";
	const VALID_TYPES = ["status", "question", "result", "error"] as const;
	const VALID_PRIORITIES = ["low", "normal", "high", "urgent"] as const;

	const rawType = getFlag(args, "--type") ?? "status";
	const rawPriority = getFlag(args, "--priority") ?? "normal";

	if (!VALID_TYPES.includes(rawType as MailMessage["type"])) {
		throw new ValidationError(
			`Invalid --type "${rawType}". Must be one of: ${VALID_TYPES.join(", ")}`,
			{ field: "type", value: rawType },
		);
	}
	if (!VALID_PRIORITIES.includes(rawPriority as MailMessage["priority"])) {
		throw new ValidationError(
			`Invalid --priority "${rawPriority}". Must be one of: ${VALID_PRIORITIES.join(", ")}`,
			{ field: "priority", value: rawPriority },
		);
	}

	const type = rawType as MailMessage["type"];
	const priority = rawPriority as MailMessage["priority"];

	if (!to) {
		throw new ValidationError("--to is required for mail send", { field: "to" });
	}
	if (!subject) {
		throw new ValidationError("--subject is required for mail send", { field: "subject" });
	}
	if (!body) {
		throw new ValidationError("--body is required for mail send", { field: "body" });
	}

	const client = openClient(cwd);
	try {
		const id = client.send({ from, to, subject, body, type, priority });

		if (hasFlag(args, "--json")) {
			process.stdout.write(`${JSON.stringify({ id })}\n`);
		} else {
			process.stdout.write(`✉️  Sent message ${id} to ${to}\n`);
		}
	} finally {
		client.close();
	}
}

/** overstory mail check */
function handleCheck(args: string[], cwd: string): void {
	const agent = getFlag(args, "--agent") ?? "orchestrator";
	const inject = hasFlag(args, "--inject");
	const json = hasFlag(args, "--json");

	const client = openClient(cwd);
	try {
		if (inject) {
			const output = client.checkInject(agent);
			if (output.length > 0) {
				process.stdout.write(output);
			}
			return;
		}

		const messages = client.check(agent);

		if (json) {
			process.stdout.write(`${JSON.stringify(messages)}\n`);
		} else if (messages.length === 0) {
			process.stdout.write("No new messages.\n");
		} else {
			process.stdout.write(
				`📬 ${messages.length} new message${messages.length === 1 ? "" : "s"}:\n\n`,
			);
			for (const msg of messages) {
				process.stdout.write(`${formatMessage(msg)}\n\n`);
			}
		}
	} finally {
		client.close();
	}
}

/** overstory mail list */
function handleList(args: string[], cwd: string): void {
	const from = getFlag(args, "--from");
	// --agent is an alias for --to, providing agent-scoped perspective (like mail check)
	const to = getFlag(args, "--to") ?? getFlag(args, "--agent");
	const unread = hasFlag(args, "--unread") ? true : undefined;
	const json = hasFlag(args, "--json");

	const client = openClient(cwd);
	try {
		const messages = client.list({ from, to, unread });

		if (json) {
			process.stdout.write(`${JSON.stringify(messages)}\n`);
		} else if (messages.length === 0) {
			process.stdout.write("No messages found.\n");
		} else {
			for (const msg of messages) {
				process.stdout.write(`${formatMessage(msg)}\n\n`);
			}
			process.stdout.write(
				`Total: ${messages.length} message${messages.length === 1 ? "" : "s"}\n`,
			);
		}
	} finally {
		client.close();
	}
}

/** overstory mail read */
function handleRead(args: string[], cwd: string): void {
	const id = args.find((a) => !a.startsWith("--"));
	if (!id) {
		throw new ValidationError("Message ID is required for mail read", { field: "id" });
	}

	const client = openClient(cwd);
	try {
		const { alreadyRead } = client.markRead(id);
		if (alreadyRead) {
			process.stdout.write(`Message ${id} was already read.\n`);
		} else {
			process.stdout.write(`Marked ${id} as read.\n`);
		}
	} finally {
		client.close();
	}
}

/** overstory mail reply */
function handleReply(args: string[], cwd: string): void {
	const id = args.find((a) => !a.startsWith("--"));
	const body = getFlag(args, "--body");
	const from = getFlag(args, "--agent") ?? getFlag(args, "--from") ?? "orchestrator";

	if (!id) {
		throw new ValidationError("Message ID is required for mail reply", { field: "id" });
	}
	if (!body) {
		throw new ValidationError("--body is required for mail reply", { field: "body" });
	}

	const client = openClient(cwd);
	try {
		const replyId = client.reply(id, body, from);

		if (hasFlag(args, "--json")) {
			process.stdout.write(`${JSON.stringify({ id: replyId })}\n`);
		} else {
			process.stdout.write(`✉️  Reply sent: ${replyId}\n`);
		}
	} finally {
		client.close();
	}
}

/** overstory mail purge */
function handlePurge(args: string[], cwd: string): void {
	const all = hasFlag(args, "--all");
	const daysStr = getFlag(args, "--days");
	const agent = getFlag(args, "--agent");
	const json = hasFlag(args, "--json");

	if (!all && daysStr === undefined && agent === undefined) {
		throw new ValidationError(
			"mail purge requires at least one filter: --all, --days <n>, or --agent <name>",
			{ field: "purge" },
		);
	}

	let olderThanMs: number | undefined;
	if (daysStr !== undefined) {
		const days = Number.parseInt(daysStr, 10);
		if (Number.isNaN(days) || days <= 0) {
			throw new ValidationError("--days must be a positive integer", {
				field: "days",
				value: daysStr,
			});
		}
		olderThanMs = days * 24 * 60 * 60 * 1000;
	}

	const store = openStore(cwd);
	try {
		const purged = store.purge({ all, olderThanMs, agent });

		if (json) {
			process.stdout.write(`${JSON.stringify({ purged })}\n`);
		} else {
			process.stdout.write(`Purged ${purged} message${purged === 1 ? "" : "s"}.\n`);
		}
	} finally {
		store.close();
	}
}

/**
 * Entry point for `overstory mail <subcommand> [args...]`.
 *
 * Subcommands: send, check, list, read, reply, purge.
 */
const MAIL_HELP = `overstory mail — Agent messaging system

Usage: overstory mail <subcommand> [args...]

Subcommands:
  send     Send a message
             --to <agent>  --subject <text>  --body <text>
             [--from <name>] [--agent <name> (alias for --from)]
             [--type <status|question|result|error>]
             [--priority <low|normal|high|urgent>] [--json]
  check    Check inbox (unread messages)
             [--agent <name>] [--inject] [--json]
  list     List messages with filters
             [--from <name>] [--to <name>] [--agent <name> (alias for --to)]
             [--unread] [--json]
  read     Mark a message as read
             <message-id>
  reply    Reply to a message
             <message-id> --body <text> [--from <name>]
             [--agent <name> (alias for --from)] [--json]
  purge    Delete old messages
             --all | --days <n> | --agent <name>
             [--json]

Options:
  --help, -h   Show this help`;

export async function mailCommand(args: string[]): Promise<void> {
	if (args.includes("--help") || args.includes("-h")) {
		process.stdout.write(`${MAIL_HELP}\n`);
		return;
	}

	const subcommand = args[0];
	const subArgs = args.slice(1);

	// Resolve the actual project root (handles git worktrees).
	// Mail commands may run from agent worktrees via hooks, so we must
	// resolve up to the main project root where .overstory/mail.db lives.
	const root = await resolveProjectRoot(process.cwd());

	switch (subcommand) {
		case "send":
			handleSend(subArgs, root);
			break;
		case "check":
			handleCheck(subArgs, root);
			break;
		case "list":
			handleList(subArgs, root);
			break;
		case "read":
			handleRead(subArgs, root);
			break;
		case "reply":
			handleReply(subArgs, root);
			break;
		case "purge":
			handlePurge(subArgs, root);
			break;
		default:
			throw new MailError(
				`Unknown mail subcommand: ${subcommand ?? "(none)"}. Use: send, check, list, read, reply, purge`,
			);
	}
}

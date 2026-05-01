/**
 * CLI command: overstory mail send/check/list/read/reply
 *
 * Parses CLI args via Commander.js and delegates to the mail client.
 * Supports --inject for hook context injection, --json for machine output,
 * and various filters for listing messages.
 */

import { join } from "node:path";
import { Command, CommanderError } from "commander";
import { resolveProjectRoot } from "../config.ts";
import { MailError, ValidationError } from "../errors.ts";
import { createEventStore } from "../events/store.ts";
import { jsonOutput } from "../json.ts";
import { accent, printHint, printSuccess } from "../logging/color.ts";
import { isGroupAddress, resolveGroupAddress } from "../mail/broadcast.ts";
import { createMailClient } from "../mail/client.ts";
import { createMailStore } from "../mail/store.ts";
import { openSessionStore } from "../sessions/compat.ts";
import type { MailMessage, MailMessageType } from "../types.ts";
import { MAIL_MESSAGE_TYPES } from "../types.ts";

/**
 * Protocol message types that require immediate recipient attention.
 * These trigger auto-nudge regardless of priority level.
 */
export const AUTO_NUDGE_TYPES: ReadonlySet<MailMessageType> = new Set([
	"worker_done",
	"merge_ready",
	"error",
	"escalation",
	"merge_failed",
]);

/**
 * Check if a message type/priority combination should trigger a pending nudge.
 * Exported for testability.
 */
export function shouldAutoNudge(type: MailMessageType, priority: MailMessage["priority"]): boolean {
	return priority === "urgent" || priority === "high" || AUTO_NUDGE_TYPES.has(type);
}

/**
 * Check if a message type should trigger an immediate tmux dispatch nudge.
 * Dispatch nudges target newly spawned agents at the welcome screen.
 * Exported for testability.
 */
export function isDispatchNudge(type: MailMessageType): boolean {
	return type === "dispatch";
}

/** Format a single message for human-readable output. */
function formatMessage(msg: MailMessage): string {
	const readMarker = msg.read ? " " : "*";
	const priorityTag = msg.priority !== "normal" ? ` [${msg.priority.toUpperCase()}]` : "";
	const lines: string[] = [
		`${readMarker} ${accent(msg.id)}  From: ${accent(msg.from)} → To: ${accent(msg.to)}${priorityTag}`,
		`  Subject: ${msg.subject}  (${msg.type})`,
		`  ${msg.body}`,
	];
	if (msg.payload !== null) {
		lines.push(`  Payload: ${msg.payload}`);
	}
	lines.push(`  ${msg.createdAt}`);
	return lines.join("\n");
}

/**
 * Open a mail store connected to the project's mail.db.
 * The cwd must already be resolved to the canonical project root.
 */
function openStore(cwd: string) {
	const dbPath = join(cwd, ".overstory", "mail.db");
	return createMailStore(dbPath);
}

// === Pending Nudge Markers ===
//
// Instead of sending tmux keys (which corrupt tool I/O), auto-nudge writes
// a JSON marker file per agent. The `mail check --inject` flow reads and
// clears these markers, prepending a priority banner to the injected output.

/** Directory where pending nudge markers are stored. */
function pendingNudgeDir(cwd: string): string {
	return join(cwd, ".overstory", "pending-nudges");
}

/** Shape of a pending nudge marker file. */
interface PendingNudge {
	from: string;
	reason: string;
	subject: string;
	messageId: string;
	createdAt: string;
}

/**
 * Write a pending nudge marker for an agent.
 *
 * Creates `.overstory/pending-nudges/{agent}.json` so that the next
 * `mail check --inject` call surfaces a priority banner for this message.
 * Overwrites any existing marker (only the latest nudge matters).
 */
async function writePendingNudge(
	cwd: string,
	agentName: string,
	nudge: Omit<PendingNudge, "createdAt">,
): Promise<void> {
	const dir = pendingNudgeDir(cwd);
	const { mkdir } = await import("node:fs/promises");
	await mkdir(dir, { recursive: true });

	const marker: PendingNudge = {
		...nudge,
		createdAt: new Date().toISOString(),
	};
	const filePath = join(dir, `${agentName}.json`);
	await Bun.write(filePath, `${JSON.stringify(marker, null, "\t")}\n`);
}

/**
 * Read and clear pending nudge markers for an agent.
 *
 * Returns the pending nudge (if any) and removes the marker file.
 * Called by `mail check --inject` to prepend a priority banner.
 */
async function readAndClearPendingNudge(
	cwd: string,
	agentName: string,
): Promise<PendingNudge | null> {
	const filePath = join(pendingNudgeDir(cwd), `${agentName}.json`);
	const file = Bun.file(filePath);
	if (!(await file.exists())) {
		return null;
	}
	try {
		const text = await file.text();
		const nudge = JSON.parse(text) as PendingNudge;
		const { unlink } = await import("node:fs/promises");
		await unlink(filePath);
		return nudge;
	} catch {
		// Corrupt or race condition — clear it and move on
		try {
			const { unlink } = await import("node:fs/promises");
			await unlink(filePath);
		} catch {
			// Already gone
		}
		return null;
	}
}

// === Mail Check Debounce ===
//
// Prevents excessive mail checking by tracking the last check timestamp per agent.
// When --debounce flag is provided, mail check will skip if called within the
// debounce window.

/**
 * Path to the mail check debounce state file.
 */
function mailCheckStatePath(cwd: string): string {
	return join(cwd, ".overstory", "mail-check-state.json");
}

/**
 * Check if a mail check for this agent is within the debounce window.
 *
 * @param cwd - Project root directory
 * @param agentName - Agent name
 * @param debounceMs - Debounce interval in milliseconds
 * @returns true if the last check was within the debounce window
 */
async function isMailCheckDebounced(
	cwd: string,
	agentName: string,
	debounceMs: number,
): Promise<boolean> {
	const statePath = mailCheckStatePath(cwd);
	const file = Bun.file(statePath);
	if (!(await file.exists())) {
		return false;
	}
	try {
		const text = await file.text();
		const state = JSON.parse(text) as Record<string, number>;
		const lastCheck = state[agentName];
		if (lastCheck === undefined) {
			return false;
		}
		return Date.now() - lastCheck < debounceMs;
	} catch {
		return false;
	}
}

/**
 * Record a mail check timestamp for debounce tracking.
 *
 * @param cwd - Project root directory
 * @param agentName - Agent name
 */
async function recordMailCheck(cwd: string, agentName: string): Promise<void> {
	const statePath = mailCheckStatePath(cwd);
	let state: Record<string, number> = {};
	const file = Bun.file(statePath);
	if (await file.exists()) {
		try {
			const text = await file.text();
			state = JSON.parse(text) as Record<string, number>;
		} catch {
			// Corrupt state file — start fresh
		}
	}
	state[agentName] = Date.now();
	await Bun.write(statePath, `${JSON.stringify(state, null, "\t")}\n`);
}

/**
 * Open a mail client connected to the project's mail.db.
 * The cwd must already be resolved to the canonical project root.
 */
function openClient(cwd: string) {
	const store = openStore(cwd);
	const client = createMailClient(store);
	return client;
}

// === Typed option interfaces for each subcommand ===

interface SendOpts {
	to: string;
	subject: string;
	body: string;
	from?: string;
	agent?: string;
	type?: string;
	priority?: string;
	payload?: string;
	json?: boolean;
}

interface CheckOpts {
	agent?: string;
	inject?: boolean;
	json?: boolean;
	debounce?: string;
}

interface ListOpts {
	from?: string;
	to?: string;
	agent?: string;
	unread?: boolean;
	type?: string;
	json?: boolean;
}

interface ReplyOpts {
	body: string;
	from?: string;
	agent?: string;
	json?: boolean;
}

interface PurgeOpts {
	all?: boolean;
	days?: string;
	agent?: string;
	json?: boolean;
}

/** overstory mail send */
async function handleSend(opts: SendOpts, cwd: string): Promise<void> {
	const { to, subject, body } = opts;
	const from = opts.agent ?? opts.from ?? "orchestrator";
	const rawPayload = opts.payload;
	const VALID_PRIORITIES = ["low", "normal", "high", "urgent"] as const;

	const rawType = opts.type ?? "status";
	const rawPriority = opts.priority ?? "normal";

	if (!MAIL_MESSAGE_TYPES.includes(rawType as MailMessage["type"])) {
		throw new ValidationError(
			`Invalid --type "${rawType}". Must be one of: ${MAIL_MESSAGE_TYPES.join(", ")}`,
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

	// Validate JSON payload if provided
	let payload: string | undefined;
	if (rawPayload !== undefined) {
		try {
			JSON.parse(rawPayload);
			payload = rawPayload;
		} catch {
			throw new ValidationError("--payload must be valid JSON", {
				field: "payload",
				value: rawPayload,
			});
		}
	}

	// Handle broadcast messages (group addresses)
	if (isGroupAddress(to)) {
		const overstoryDir = join(cwd, ".overstory");
		const { store: sessionStore } = openSessionStore(overstoryDir);

		try {
			const activeSessions = sessionStore.getActive();
			const recipients = resolveGroupAddress(to, activeSessions, from);

			const client = openClient(cwd);
			const messageIds: string[] = [];

			try {
				// Fan out: send individual message to each recipient
				for (const recipient of recipients) {
					const id = client.send({ from, to: recipient, subject, body, type, priority, payload });
					messageIds.push(id);

					// Record mail_sent event for each individual message (fire-and-forget)
					try {
						const eventsDbPath = join(cwd, ".overstory", "events.db");
						const eventStore = createEventStore(eventsDbPath);
						try {
							let runId: string | null = null;
							const runIdPath = join(cwd, ".overstory", "current-run.txt");
							const runIdFile = Bun.file(runIdPath);
							if (await runIdFile.exists()) {
								const text = await runIdFile.text();
								const trimmed = text.trim();
								if (trimmed.length > 0) {
									runId = trimmed;
								}
							}
							eventStore.insert({
								runId,
								agentName: from,
								sessionId: null,
								eventType: "mail_sent",
								toolName: null,
								toolArgs: null,
								toolDurationMs: null,
								level: "info",
								data: JSON.stringify({
									to: recipient,
									subject,
									type,
									priority,
									messageId: id,
									broadcast: true,
								}),
							});
						} finally {
							eventStore.close();
						}
					} catch {
						// Event recording failure is non-fatal
					}

					// Auto-nudge for each individual message
					const shouldNudge =
						priority === "urgent" || priority === "high" || AUTO_NUDGE_TYPES.has(type);
					if (shouldNudge) {
						const nudgeReason = AUTO_NUDGE_TYPES.has(type) ? type : `${priority} priority`;
						await writePendingNudge(cwd, recipient, {
							from,
							reason: nudgeReason,
							subject,
							messageId: id,
						});
					}
				}
			} finally {
				client.close();
			}

			// Output broadcast summary
			if (opts.json) {
				jsonOutput("mail send", { messageIds, recipientCount: recipients.length });
			} else {
				process.stdout.write(
					`Broadcast sent to ${recipients.length} recipient${recipients.length === 1 ? "" : "s"} (${to})\n`,
				);
				for (let i = 0; i < recipients.length; i++) {
					const recipient = recipients[i];
					const msgId = messageIds[i];
					process.stdout.write(`   → ${accent(recipient)} (${accent(msgId)})\n`);
				}
			}

			return; // Early return — broadcast handled
		} finally {
			sessionStore.close();
		}
	}

	// Reject sends to agents in a terminal state (completed/zombie).
	// `installMailInjectors` reaps the per-agent dispatch loop the moment a
	// session lands in a terminal state (serve.ts:378), so any mail addressed
	// after that point would sit unread forever with no way to surface it.
	// Sessions with no row at all (orchestrator, coordinator, operator roles)
	// fall through — we only know about agents tracked in SessionStore.
	// Group addresses already skip terminal agents via `getActive()`.
	{
		const overstoryDir = join(cwd, ".overstory");
		const { store: sessionStore } = openSessionStore(overstoryDir);
		try {
			const recipient = sessionStore.getByName(to);
			if (recipient && (recipient.state === "completed" || recipient.state === "zombie")) {
				throw new MailError(
					`Recipient "${to}" is in terminal state (${recipient.state}); message not sent. ` +
						`The agent is no longer running, so this message would never be delivered.`,
					{ agentName: to },
				);
			}
		} finally {
			sessionStore.close();
		}
	}

	// Single-recipient message (existing logic)
	const client = openClient(cwd);
	try {
		const id = client.send({ from, to, subject, body, type, priority, payload });

		// Record mail_sent event to EventStore (fire-and-forget)
		try {
			const eventsDbPath = join(cwd, ".overstory", "events.db");
			const eventStore = createEventStore(eventsDbPath);
			try {
				let runId: string | null = null;
				const runIdPath = join(cwd, ".overstory", "current-run.txt");
				const runIdFile = Bun.file(runIdPath);
				if (await runIdFile.exists()) {
					const text = await runIdFile.text();
					const trimmed = text.trim();
					if (trimmed.length > 0) {
						runId = trimmed;
					}
				}
				eventStore.insert({
					runId,
					agentName: from,
					sessionId: null,
					eventType: "mail_sent",
					toolName: null,
					toolArgs: null,
					toolDurationMs: null,
					level: "info",
					data: JSON.stringify({ to, subject, type, priority, messageId: id }),
				});
			} finally {
				eventStore.close();
			}
		} catch {
			// Event recording failure is non-fatal
		}

		if (opts.json) {
			jsonOutput("mail send", { id });
		} else {
			printSuccess("Sent message", id);
		}

		// Auto-nudge: write a pending nudge marker instead of sending tmux keys.
		// Direct tmux sendKeys during tool execution corrupts the agent's I/O,
		// causing SIGKILL (exit 137) and "request interrupted" errors (overstory-ii1o).
		// The message is already in the DB — the UserPromptSubmit hook's
		// `mail check --inject` will surface it on the next prompt cycle.
		// The pending nudge marker ensures the message gets a priority banner.
		const shouldNudge = priority === "urgent" || priority === "high" || AUTO_NUDGE_TYPES.has(type);
		if (shouldNudge) {
			const nudgeReason = AUTO_NUDGE_TYPES.has(type) ? type : `${priority} priority`;
			await writePendingNudge(cwd, to, {
				from,
				reason: nudgeReason,
				subject,
				messageId: id,
			});
			if (!opts.json) {
				process.stdout.write(
					`Queued nudge for "${to}" (${nudgeReason}, delivered on next prompt)\n`,
				);
			}
		}

		// For dispatch messages, also send an immediate tmux nudge.
		// Dispatch targets newly spawned agents that may be idle at the welcome
		// screen where file-based nudges can't reach (no hook fires on idle agents).
		// The I/O corruption concern (overstory-ii1o) only applies during active
		// tool execution — newly spawned agents are idle, so sendKeys is safe.
		if (type === "dispatch") {
			try {
				const { nudgeAgent } = await import("./nudge.ts");
				const nudgeMessage = `[DISPATCH] ${subject}: ${body.slice(0, 500)}`;
				// Small delay to let the agent's TUI stabilize after sling
				await Bun.sleep(3_000);
				await nudgeAgent(cwd, to, nudgeMessage, true); // force=true to skip debounce
			} catch {
				// Non-fatal: the file-based nudge is the fallback
			}
		}

		// Reviewer coverage check for merge_ready (advisory warning)
		if (type === "merge_ready") {
			try {
				const overstoryDir = join(cwd, ".overstory");
				const { store: sessionStore } = openSessionStore(overstoryDir);
				try {
					const allSessions = sessionStore.getAll();
					const myBuilders = allSessions.filter(
						(s) => s.parentAgent === from && s.capability === "builder",
					);
					const myReviewers = allSessions.filter(
						(s) => s.parentAgent === from && s.capability === "reviewer",
					);
					if (myBuilders.length > 0 && myReviewers.length === 0) {
						process.stderr.write(
							`\nWarning: merge_ready sent but NO reviewer sessions found for "${from}".\n` +
								`${myBuilders.length} builder(s) completed without review. This violates the review-before-merge requirement.\n` +
								`Spawn reviewers for each builder before merge. See REVIEW_SKIP in agents/lead.md.\n\n`,
						);
					} else if (myReviewers.length > 0 && myReviewers.length < myBuilders.length) {
						process.stderr.write(
							`\nNote: Only ${myReviewers.length} reviewer(s) for ${myBuilders.length} builder(s). Ensure all builder work is review-verified.\n\n`,
						);
					}
				} finally {
					sessionStore.close();
				}
			} catch {
				// Reviewer check failure is non-fatal — do not block mail send
			}
		}
	} finally {
		client.close();
	}
}

/** overstory mail check */
async function handleCheck(opts: CheckOpts, cwd: string): Promise<void> {
	const agent = opts.agent ?? "orchestrator";
	const inject = opts.inject ?? false;
	const json = opts.json ?? false;
	const debounceFlag = opts.debounce;

	// Parse debounce interval if provided
	let debounceMs: number | undefined;
	if (debounceFlag !== undefined) {
		const parsed = Number.parseInt(debounceFlag, 10);
		if (Number.isNaN(parsed) || parsed < 0) {
			throw new ValidationError(
				`--debounce must be a non-negative integer (milliseconds), got: ${debounceFlag}`,
				{ field: "debounce", value: debounceFlag },
			);
		}
		debounceMs = parsed;
	}

	// Check debounce if enabled
	if (debounceMs !== undefined) {
		const debounced = await isMailCheckDebounced(cwd, agent, debounceMs);
		if (debounced) {
			// Silent skip — no output when debounced
			return;
		}
	}

	const client = openClient(cwd);
	try {
		if (inject) {
			// Check for pending nudge markers (written by auto-nudge instead of tmux keys)
			const pendingNudge = await readAndClearPendingNudge(cwd, agent);
			const output = client.checkInject(agent);

			// Prepend a priority banner if there's a pending nudge
			if (pendingNudge) {
				const banner = `PRIORITY: ${pendingNudge.reason} message from ${pendingNudge.from} — "${pendingNudge.subject}"\n\n`;
				process.stdout.write(banner);
			}

			if (output.length > 0) {
				process.stdout.write(output);
			}
		} else {
			const messages = client.check(agent);

			if (json) {
				jsonOutput("mail check", { messages });
			} else if (messages.length === 0) {
				printHint("No new messages");
			} else {
				process.stdout.write(
					`${messages.length} new message${messages.length === 1 ? "" : "s"}:\n\n`,
				);
				for (const msg of messages) {
					process.stdout.write(`${formatMessage(msg)}\n\n`);
				}
			}
		}

		// Record this check for debounce tracking (only if debounce is enabled)
		if (debounceMs !== undefined) {
			await recordMailCheck(cwd, agent);
		}
	} finally {
		client.close();
	}
}

/** overstory mail list */
function handleList(opts: ListOpts, cwd: string): void {
	const from = opts.from;
	// --to takes precedence over --agent (agent is an alias for recipient filtering)
	const to = opts.to ?? opts.agent;
	const unread = opts.unread ? true : undefined;
	const json = opts.json ?? false;

	let type: MailMessageType | undefined;
	if (opts.type !== undefined) {
		if (!MAIL_MESSAGE_TYPES.includes(opts.type as MailMessageType)) {
			throw new ValidationError(
				`Invalid --type "${opts.type}". Must be one of: ${MAIL_MESSAGE_TYPES.join(", ")}`,
				{ field: "type", value: opts.type },
			);
		}
		type = opts.type as MailMessageType;
	}

	const client = openClient(cwd);
	try {
		const messages = client.list({ from, to, unread, type });

		if (json) {
			jsonOutput("mail list", { messages });
		} else if (messages.length === 0) {
			printHint("No messages found");
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
function handleRead(id: string, cwd: string): void {
	const client = openClient(cwd);
	try {
		const { alreadyRead } = client.markRead(id);
		if (alreadyRead) {
			printHint(`Message ${accent(id)} was already read`);
		} else {
			printSuccess("Marked as read", id);
		}
	} finally {
		client.close();
	}
}

/** overstory mail reply */
function handleReply(id: string, opts: ReplyOpts, cwd: string): void {
	const body = opts.body;
	const from = opts.agent ?? opts.from ?? "orchestrator";

	const client = openClient(cwd);
	try {
		const replyId = client.reply(id, body, from);

		if (opts.json) {
			jsonOutput("mail reply", { id: replyId });
		} else {
			printSuccess("Reply sent", replyId);
		}
	} finally {
		client.close();
	}
}

/** overstory mail purge */
function handlePurge(opts: PurgeOpts, cwd: string): void {
	const all = opts.all ?? false;
	const daysStr = opts.days;
	const agent = opts.agent;
	const json = opts.json ?? false;

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
			jsonOutput("mail purge", { purged });
		} else {
			printSuccess(`Purged ${purged} message(s)`);
		}
	} finally {
		store.close();
	}
}

/**
 * Entry point for `overstory mail <subcommand> [args...]`.
 *
 * Subcommands: send, check, list, read, reply, purge.
 * Uses Commander.js for subcommand routing and option parsing.
 */
export async function mailCommand(args: string[]): Promise<void> {
	// Resolve the actual project root (handles git worktrees).
	// Mail commands may run from agent worktrees via hooks, so we must
	// resolve up to the main project root where .overstory/mail.db lives.
	const root = await resolveProjectRoot(process.cwd());

	const program = new Command();
	program.name("ov mail").description("Agent messaging system").exitOverride();

	program
		.command("send")
		.description("Send a message")
		.requiredOption("--to <agent>", "Recipient agent name")
		.requiredOption("--subject <text>", "Message subject")
		.requiredOption("--body <text>", "Message body")
		.option("--from <name>", "Sender name")
		.option("--agent <name>", "Alias for --from")
		.option("--type <type>", "Message type", "status")
		.option("--priority <level>", "Priority level", "normal")
		.option("--payload <json>", "Structured JSON payload")
		.option("--json", "Output as JSON")
		.exitOverride()
		.action(async (opts: SendOpts) => {
			await handleSend(opts, root);
		});

	program
		.command("check")
		.description("Check inbox for one agent and mark unread as read (per-agent scope)")
		.option("--agent <name>", "Agent name (default: orchestrator)")
		.option("--inject", "Inject format for hook context")
		.option("--json", "Output as JSON")
		.option("--debounce <ms>", "Debounce interval in milliseconds")
		.exitOverride()
		.action(async (opts: CheckOpts) => {
			await handleCheck(opts, root);
		});

	program
		.command("list")
		.description("List messages with filters (system-wide unless --to/--agent given)")
		.option("--from <name>", "Filter by sender")
		.option("--to <name>", "Filter by recipient (scopes to one agent)")
		.option("--agent <name>", "Alias for --to (filter by recipient)")
		.option("--unread", "Show only unread messages (does NOT mark them read)")
		.option("--type <type>", "Filter by message type")
		.option("--json", "Output as JSON")
		.exitOverride()
		.action((opts: ListOpts) => {
			handleList(opts, root);
		});

	program
		.command("read")
		.description("Mark a message as read")
		.argument("<message-id>", "Message ID")
		.exitOverride()
		.action((id: string) => {
			handleRead(id, root);
		});

	program
		.command("reply")
		.description("Reply to a message")
		.argument("<message-id>", "Message ID to reply to")
		.requiredOption("--body <text>", "Reply body")
		.option("--from <name>", "Sender name")
		.option("--agent <name>", "Alias for --from")
		.option("--json", "Output as JSON")
		.exitOverride()
		.action((id: string, opts: ReplyOpts) => {
			handleReply(id, opts, root);
		});

	program
		.command("purge")
		.description("Delete old messages")
		.option("--all", "Purge all messages")
		.option("--days <n>", "Purge messages older than N days")
		.option("--agent <name>", "Purge messages for specific agent")
		.option("--json", "Output as JSON")
		.exitOverride()
		.action((opts: PurgeOpts) => {
			handlePurge(opts, root);
		});

	try {
		await program.parseAsync(["node", "overstory-mail", ...args]);
	} catch (err) {
		// `exitOverride()` turns Commander's help paths into thrown
		// CommanderErrors after the help text was already written to stdout.
		// Swallow both the explicit `--help` path (commander.helpDisplayed,
		// exitCode 0) and the missing-subcommand path (commander.help,
		// exitCode 1) — the user got what they asked for.
		if (
			err instanceof CommanderError &&
			(err.code === "commander.helpDisplayed" || err.code === "commander.help")
		) {
			if (err.exitCode !== 0) {
				process.exitCode = err.exitCode;
			}
			return;
		}
		throw err;
	}
}

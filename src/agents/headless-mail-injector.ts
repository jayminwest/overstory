/**
 * Server-side mail injection loop for headless Claude Code agents.
 *
 * In tmux mode, the UserPromptSubmit hook fires `ov mail check --inject` before
 * each prompt, delivering new mail to the agent. In headless mode, there is no
 * hook mechanism — the orchestrator must write mail as user turns to the agent's
 * stdin instead.
 *
 * This module provides startMailInjectionLoop(), which polls the mail store and
 * delivers unread messages as stream-json user turns via a caller-provided write
 * function. The caller (typically `ov serve`) plugs in a write function backed
 * by the agent's per-agent stdin FIFO (see src/agents/headless-stdin.ts).
 */

import { createMailStore } from "../mail/store.ts";
import { encodeUserTurn } from "./headless-prompt.ts";

/**
 * Result returned by the caller-provided write function.
 *
 * - "delivered": payload was accepted; messages will be marked read on next tick
 * - "no-reader": agent is gone (e.g., FIFO has no readers). The loop should
 *   stop polling and let the caller clean up.
 */
export type InjectionWriteResult = "delivered" | "no-reader" | "broken-pipe";

/** Function that delivers a stream-json user turn to a single headless agent. */
export type InjectionWriter = (data: string | Uint8Array) => InjectionWriteResult;

/**
 * Start a server-side mail injection loop for a headless agent.
 *
 * Polls the mail store every intervalMs milliseconds. When unread messages are
 * found, formats them as a single user turn and calls the writer. Multiple
 * pending messages are batched into one turn to avoid the agent responding to
 * each individually before it can act.
 *
 * The writer's return value drives the loop's lifecycle:
 *   - "delivered": continue polling
 *   - "no-reader" or "broken-pipe": stop the loop. The caller is responsible
 *     for any FIFO/state cleanup (the loop just stops invoking the writer).
 *
 * The caller may also stop the loop explicitly by calling the returned cleanup
 * function — used for graceful server shutdown.
 *
 * @param agentName - Overstory agent name (used as mail inbox address)
 * @param writer - Function that writes a single stream-json envelope to the agent
 * @param mailStorePath - Absolute path to the project's mail.db
 * @param intervalMs - Poll interval in milliseconds (default: 2000)
 * @returns Cleanup function that stops the injection loop
 */
export function startMailInjectionLoop(
	agentName: string,
	writer: InjectionWriter,
	mailStorePath: string,
	intervalMs = 2000,
): () => void {
	let stopped = false;
	const timer = setInterval(() => {
		if (stopped) return;
		const store = createMailStore(mailStorePath);
		try {
			const messages = store.getUnread(agentName);
			if (messages.length === 0) return;

			const text = messages
				.map(
					(m) =>
						`[MAIL] From: ${m.from} | Subject: ${m.subject} | Priority: ${m.priority}\n\n${m.body}`,
				)
				.join("\n\n---\n\n");

			const result = writer(encodeUserTurn(text));
			if (result === "no-reader" || result === "broken-pipe") {
				// Agent gone — stop polling. Leave messages unread so a revived
				// agent (or human triage) can still see them.
				stopped = true;
				clearInterval(timer);
				return;
			}
			// Mark read only on successful delivery to avoid losing messages
			// when the writer reports a transient failure.
			for (const msg of messages) {
				store.markRead(msg.id);
			}
		} finally {
			store.close();
		}
	}, intervalMs);

	return () => {
		stopped = true;
		clearInterval(timer);
	};
}

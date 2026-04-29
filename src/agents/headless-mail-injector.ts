/**
 * Server-side mail injection loop for headless Claude Code agents.
 *
 * In tmux mode, the UserPromptSubmit hook fires `ov mail check --inject` before
 * each prompt, delivering new mail to the agent. In headless mode, there is no
 * hook mechanism — the orchestrator must write mail as user turns to the agent's
 * stdin instead.
 *
 * This module provides startMailInjectionLoop(), which polls the mail store and
 * writes unread messages as stream-json user turns to the agent's stdin. It is
 * intended to be called by ov serve (or a coordinator-owned process registry)
 * that holds the stdin handle for the lifetime of the agent session.
 */

import { createMailClient } from "../mail/client.ts";
import { createMailStore } from "../mail/store.ts";
import { encodeUserTurn } from "./headless-prompt.ts";

/**
 * Start a server-side mail injection loop for a headless agent.
 *
 * Polls the mail store every intervalMs milliseconds. When unread messages are
 * found, formats them as a single user turn and writes to the agent's stdin.
 * Multiple pending messages are batched into one turn to avoid the agent
 * responding to each individually before it can act.
 *
 * The caller (ov serve or coordinator) is responsible for stopping the loop
 * when the agent session ends by calling the returned cleanup function.
 *
 * @param agentName - Overstory agent name (used as mail inbox address)
 * @param stdin - Writable sink for the headless agent process stdin
 * @param mailStorePath - Absolute path to the project's mail.db
 * @param intervalMs - Poll interval in milliseconds (default: 2000)
 * @returns Cleanup function that stops the injection loop
 */
export function startMailInjectionLoop(
	agentName: string,
	stdin: { write(data: string | Uint8Array): number | Promise<number> },
	mailStorePath: string,
	intervalMs = 2000,
): () => void {
	const timer = setInterval(() => {
		const store = createMailStore(mailStorePath);
		try {
			const mailClient = createMailClient(store);
			const messages = mailClient.check(agentName);
			if (messages.length === 0) return;

			const text = messages
				.map(
					(m) =>
						`[MAIL] From: ${m.from} | Subject: ${m.subject} | Priority: ${m.priority}\n\n${m.body}`,
				)
				.join("\n\n---\n\n");

			void stdin.write(encodeUserTurn(text));
		} finally {
			store.close();
		}
	}, intervalMs);

	return () => clearInterval(timer);
}

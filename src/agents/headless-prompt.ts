/**
 * Build the initial stdin prompt for a headless Claude Code agent.
 *
 * In headless mode (--input-format stream-json), the orchestrator owns stdin.
 * Rather than relying on SessionStart hooks (which don't fire in headless mode),
 * the orchestrator writes the prime context, pending dispatch mail, and activation
 * beacon as the agent's first user turn immediately after spawn.
 */

/**
 * Encode text as a stream-json user turn for Claude Code's --input-format stream-json.
 *
 * Format matches the Claude Code headless stdin protocol:
 * {"type":"user","message":{"role":"user","content":[{"type":"text","text":"..."}]}}
 */
export function encodeUserTurn(text: string): string {
	const message = {
		type: "user",
		message: { role: "user", content: [{ type: "text", text }] },
	};
	return `${JSON.stringify(message)}\n`;
}

/**
 * Build the initial stdin prompt for a headless Claude agent.
 *
 * Combines prime context (mulch expertise, session state), pending dispatch mail,
 * and the activation beacon into a single user turn. Replaces the SessionStart
 * hook equivalents (ov prime + ov mail check --inject) for headless agents.
 *
 * Sections are separated by "---" dividers. Empty sections are omitted.
 *
 * @param primeContext - Output of `ov prime --agent <name>` (may be empty/undefined)
 * @param dispatchMail - Pre-formatted dispatch mail body (may be empty/undefined)
 * @param beacon - Activation phrase sent via tmux send-keys in interactive mode
 * @returns NDJSON line ready to write to the agent's stdin
 */
export function buildInitialHeadlessPrompt(
	primeContext: string | undefined,
	dispatchMail: string | undefined,
	beacon: string,
): string {
	const parts: string[] = [];
	if (primeContext) parts.push(primeContext);
	if (dispatchMail) parts.push(dispatchMail);
	parts.push(beacon);

	const text = parts.join("\n\n---\n\n");
	return encodeUserTurn(text);
}

/**
 * Format a list of pending mail messages as a dispatch mail section.
 *
 * Used to inline pending inbox messages into the initial stdin prompt so
 * the agent starts with all pre-dispatch mail already in context.
 */
export function formatMailSection(
	messages: ReadonlyArray<{ from: string; subject: string; priority: string; body: string }>,
): string {
	if (messages.length === 0) return "";
	return messages
		.map(
			(m) =>
				`[MAIL] From: ${m.from} | Subject: ${m.subject} | Priority: ${m.priority}\n\n${m.body}`,
		)
		.join("\n\n---\n\n");
}

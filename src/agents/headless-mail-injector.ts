/**
 * Server-side mail dispatcher for spawn-per-turn headless agents.
 *
 * In tmux mode, the UserPromptSubmit hook fires `ov mail check --inject` before
 * each prompt, delivering new mail to the agent. In headless spawn-per-turn
 * mode there is no persistent process — `ov serve` polls the mail store and,
 * when unread mail appears for an agent, drives a fresh `runTurn` that spawns
 * claude with `--resume <session-id>`, writes the batched user turn to a real
 * stdin pipe, and exits when claude does.
 *
 * This module exports `startTurnRunnerMailLoop` (the dispatcher loop) and
 * `_runTurnRunnerTick` (a single-tick variant for deterministic tests).
 *
 * State authority (overstory-3087): this module does NOT write session state.
 * The turn-runner (`src/agents/turn-runner.ts`) is the sole authority for
 * `in_turn` ↔ `between_turns` transitions — it writes `in_turn` on the first
 * parser event of a turn and settles to `between_turns` at end-of-turn when
 * the agent did not deliver a terminal mail. Adding a duplicate writer here
 * would race with the turn-runner under the per-agent turn lock and make
 * the substate non-deterministic.
 */

import { createMailStore } from "../mail/store.ts";
import type { MailMessage } from "../types.ts";
import { encodeUserTurn } from "./headless-prompt.ts";
import type { RunTurnOpts, TurnResult } from "./turn-runner.ts";

/**
 * Escape characters that would otherwise corrupt the `[MAIL] From: ... | Subject: ... |
 * Priority: ...\n\n<body>` framing. `|` is the field delimiter and `\n\n` separates
 * metadata from body, so an unescaped pipe or newline in a metadata value would let a
 * crafted subject inject a fake field or smuggle a fake body. Backslash is escaped
 * first so the escape sequence itself is unambiguous (overstory-2231).
 */
function escapeMailMetadata(value: string): string {
	return value
		.replace(/\\/g, "\\\\")
		.replace(/\|/g, "\\|")
		.replace(/\r/g, "\\r")
		.replace(/\n/g, "\\n");
}

/**
 * Format a batch of unread messages into the user-turn text the agent receives.
 * Metadata values are escaped so a hostile or human-authored subject can't break
 * the line framing.
 */
export function formatMailBatch(messages: readonly MailMessage[]): string {
	return messages
		.map(
			(m) =>
				`[MAIL] From: ${escapeMailMetadata(m.from)} | Subject: ${escapeMailMetadata(
					m.subject,
				)} | Priority: ${escapeMailMetadata(m.priority)}\n\n${m.body}`,
		)
		.join("\n\n---\n\n");
}

/**
 * Build the runTurn opts for delivering a user turn (Phase 2 builder dispatcher).
 *
 * The injector polls mail for a single agent and only knows the agent name,
 * the user-turn payload, and the mail database path. The remaining fields
 * (worktree path, runtime, model, run id, etc.) are provided by the caller
 * (typically `ov serve`) once at install time. This factory produces a
 * `RunTurnOpts` for each batch by combining the static caller-provided
 * fields with the per-batch payload.
 */
export type TurnRunnerOptsFactory = (userTurnNdjson: string) => RunTurnOpts;

/** Function that drives a single agent turn end-to-end. Production passes `runTurn`. */
export type TurnRunnerFn = (opts: RunTurnOpts) => Promise<TurnResult>;

/**
 * Outcome of a single dispatcher tick. Returned for testability so callers
 * can assert delivery behavior without inspecting the runner internals.
 */
export type TurnRunnerTickResult =
	| { kind: "idle" }
	| { kind: "in-flight" }
	| { kind: "delivered"; result: TurnResult; messageIds: string[] }
	| { kind: "error"; error: unknown; messageIds: string[] };

/**
 * Start a server-side mail dispatcher that drives the spawn-per-turn engine.
 *
 * Phase 2 builder path. Polls the mail store every intervalMs milliseconds,
 * batches unread messages into a single stream-json user turn, and invokes
 * `runTurn(...)` to spawn one claude turn that consumes them. While a turn
 * is in flight, subsequent ticks short-circuit — they never spawn a second
 * claude process for the same agent. Per-agent serialization is also enforced
 * cross-process by the turn-lock inside `runTurn`.
 *
 * Mark-as-read happens AFTER the runTurn returns successfully (`exitCode === 0`
 * and no thrown error). On any failure, messages remain unread and will be
 * retried on the next tick.
 *
 * @param agentName - Overstory agent name (mail inbox address)
 * @param optsFactory - Builds the RunTurnOpts from the per-batch user turn payload
 * @param runTurnFn - Function that drives one turn (typically `runTurn` from turn-runner.ts)
 * @param mailStorePath - Absolute path to the project's mail.db
 * @param intervalMs - Poll interval in milliseconds (default: 2000)
 * @param isAgentLive - Optional per-tick predicate. When provided and it returns
 *   false, the loop short-circuits (no mail dispatch) and self-terminates.
 *   This closes the gap between `ov stop` writing state=completed and the
 *   serve.ts rescan timer reaping this loop, which would otherwise keep
 *   ticking and dispatch a new turn against a stopped agent (overstory-eb7c).
 * @returns Cleanup function that stops the dispatcher
 */
export function startTurnRunnerMailLoop(
	agentName: string,
	optsFactory: TurnRunnerOptsFactory,
	runTurnFn: TurnRunnerFn,
	mailStorePath: string,
	intervalMs = 2000,
	isAgentLive?: () => boolean,
): () => void {
	let stopped = false;
	let inFlight = false;
	let timer: ReturnType<typeof setInterval> | null = null;

	const stop = (): void => {
		stopped = true;
		if (timer !== null) {
			clearInterval(timer);
			timer = null;
		}
	};

	const tick = async (): Promise<TurnRunnerTickResult> => {
		if (stopped) return { kind: "idle" };
		if (inFlight) return { kind: "in-flight" };
		// Per-tick state guard. `ov stop` flips state=completed and kills the
		// in-flight claude, but until the rescan reaps this loop the next tick
		// would otherwise dispatch a fresh turn against the stopped agent.
		if (isAgentLive && !isAgentLive()) {
			stop();
			return { kind: "idle" };
		}
		const store = createMailStore(mailStorePath);
		let messages: ReturnType<typeof store.getUnread>;
		try {
			messages = store.getUnread(agentName);
		} finally {
			store.close();
		}
		if (messages.length === 0) return { kind: "idle" };

		const userTurnNdjson = encodeUserTurn(formatMailBatch(messages));
		const ids = messages.map((m) => m.id);

		inFlight = true;
		try {
			const result = await runTurnFn(optsFactory(userTurnNdjson));
			// Mark read only on a clean turn — exit code 0 (or null on abort with
			// no error) AND no thrown error. Failed turns leave messages unread
			// so the next tick retries cleanly.
			if (result.exitCode === 0) {
				const markStore = createMailStore(mailStorePath);
				try {
					for (const id of ids) markStore.markRead(id);
				} finally {
					markStore.close();
				}
			}
			return { kind: "delivered", result, messageIds: ids };
		} catch (error) {
			return { kind: "error", error, messageIds: ids };
		} finally {
			inFlight = false;
		}
	};

	timer = setInterval(() => {
		// Errors and rejections are absorbed inside tick; this layer just
		// prevents an unhandled-rejection if tick itself throws synchronously.
		tick().catch(() => {});
	}, intervalMs);

	return stop;
}

/**
 * Internal: run a single dispatcher tick. Exported for tests so they can
 * drive the loop deterministically without setInterval timing.
 */
export async function _runTurnRunnerTick(
	agentName: string,
	optsFactory: TurnRunnerOptsFactory,
	runTurnFn: TurnRunnerFn,
	mailStorePath: string,
): Promise<TurnRunnerTickResult> {
	const store = createMailStore(mailStorePath);
	let messages: ReturnType<typeof store.getUnread>;
	try {
		messages = store.getUnread(agentName);
	} finally {
		store.close();
	}
	if (messages.length === 0) return { kind: "idle" };

	const userTurnNdjson = encodeUserTurn(formatMailBatch(messages));
	const ids = messages.map((m) => m.id);

	try {
		const result = await runTurnFn(optsFactory(userTurnNdjson));
		if (result.exitCode === 0) {
			const markStore = createMailStore(mailStorePath);
			try {
				for (const id of ids) markStore.markRead(id);
			} finally {
				markStore.close();
			}
		}
		return { kind: "delivered", result, messageIds: ids };
	} catch (error) {
		return { kind: "error", error, messageIds: ids };
	}
}

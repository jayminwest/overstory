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
import type { RunTurnOpts, TurnResult } from "./turn-runner.ts";

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
 * @returns Cleanup function that stops the dispatcher
 */
export function startTurnRunnerMailLoop(
	agentName: string,
	optsFactory: TurnRunnerOptsFactory,
	runTurnFn: TurnRunnerFn,
	mailStorePath: string,
	intervalMs = 2000,
): () => void {
	let stopped = false;
	let inFlight = false;

	const tick = async (): Promise<TurnRunnerTickResult> => {
		if (stopped) return { kind: "idle" };
		if (inFlight) return { kind: "in-flight" };
		const store = createMailStore(mailStorePath);
		let messages: ReturnType<typeof store.getUnread>;
		try {
			messages = store.getUnread(agentName);
		} finally {
			store.close();
		}
		if (messages.length === 0) return { kind: "idle" };

		const text = messages
			.map(
				(m) =>
					`[MAIL] From: ${m.from} | Subject: ${m.subject} | Priority: ${m.priority}\n\n${m.body}`,
			)
			.join("\n\n---\n\n");

		const userTurnNdjson = encodeUserTurn(text);
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

	const timer = setInterval(() => {
		// Errors and rejections are absorbed inside tick; this layer just
		// prevents an unhandled-rejection if tick itself throws synchronously.
		tick().catch(() => {});
	}, intervalMs);

	return () => {
		stopped = true;
		clearInterval(timer);
	};
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

	const text = messages
		.map(
			(m) =>
				`[MAIL] From: ${m.from} | Subject: ${m.subject} | Priority: ${m.priority}\n\n${m.body}`,
		)
		.join("\n\n---\n\n");

	const userTurnNdjson = encodeUserTurn(text);
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

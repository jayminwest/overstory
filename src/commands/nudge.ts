/**
 * CLI command: overstory nudge <agent-name> [message]
 *
 * Sends a text nudge to an agent's interactive Claude Code session via
 * tmux send-keys. Used to notify agents of new mail or relay urgent
 * instructions mid-conversation.
 *
 * Includes retry logic (3 attempts) and debounce (500ms) to prevent
 * rapid-fire nudges to the same agent.
 */

import { join } from "node:path";
import { Command } from "commander";
import { encodeUserTurn } from "../agents/headless-prompt.ts";
import { createManifestLoader } from "../agents/manifest.ts";
import { type RunTurnOpts, runTurn, type TurnResult } from "../agents/turn-runner.ts";
import { buildRunTurnOptsFactory, isSpawnPerTurnAgent } from "../agents/turn-runner-dispatch.ts";
import { loadConfig } from "../config.ts";
import { AgentError } from "../errors.ts";
import { createEventStore } from "../events/store.ts";
import { jsonOutput } from "../json.ts";
import { printSuccess } from "../logging/color.ts";
import { getConnection } from "../runtimes/connections.ts";
import { hasNudge } from "../runtimes/headless-connection.ts";
import { openSessionStore } from "../sessions/compat.ts";
import type { AgentSession, EventStore } from "../types.ts";
import { capturePaneContent, isSessionAlive, sendKeys } from "../worktree/tmux.ts";

const DEFAULT_MESSAGE = "Check your mail inbox for new messages.";
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 500;
const DEBOUNCE_MS = 500;

/**
 * Maximum total time (ms) to wait for a busy pane to become idle before
 * giving up and reporting the nudge as deferred. Sized to ride out short
 * tool calls without blocking long-running thinks.
 */
const IDLE_WAIT_MS = 3000;
const IDLE_POLL_INTERVAL_MS = 250;

/**
 * Heuristic: does the captured pane content indicate the agent is mid-think?
 *
 * Claude Code's TUI shows "esc to interrupt" alongside the streaming token
 * counter while a turn is in flight. The phrase is absent in idle state, when
 * tool output is rendered, and on the trust dialog — so its presence is a
 * reliable busy signal. Returns true when the agent appears busy and a nudge
 * sent via tmux send-keys would be queued into the in-flight prompt instead
 * of starting a fresh user turn. (overstory-8ff4)
 */
export function paneAppearsBusy(paneContent: string): boolean {
	return paneContent.includes("esc to interrupt");
}

/**
 * Wait briefly for a tmux pane to leave the mid-think state.
 *
 * Polls capture-pane until the busy heuristic clears or the deadline elapses.
 * Returns true if the pane became idle, false if it remained busy or pane
 * capture failed throughout. Capture failures count as "not idle" so the
 * caller defers the nudge rather than blasting send-keys into an unknown
 * state. (overstory-8ff4)
 */
async function waitForPaneIdle(
	tmuxSession: string,
	maxWaitMs: number = IDLE_WAIT_MS,
	pollIntervalMs: number = IDLE_POLL_INTERVAL_MS,
): Promise<boolean> {
	const deadline = Date.now() + maxWaitMs;
	while (true) {
		const content = await capturePaneContent(tmuxSession, 20);
		if (content !== null && !paneAppearsBusy(content)) {
			return true;
		}
		if (Date.now() >= deadline) {
			return false;
		}
		await Bun.sleep(pollIntervalMs);
	}
}

/**
 * Load the orchestrator's registered tmux session name.
 *
 * Written by `overstory prime` at SessionStart when the orchestrator
 * is running inside tmux. Enables agents to nudge the orchestrator
 * even though it's not tracked in the SessionStore.
 */
async function loadOrchestratorTmuxSession(projectRoot: string): Promise<string | null> {
	const regPath = join(projectRoot, ".overstory", "orchestrator-tmux.json");
	const file = Bun.file(regPath);
	if (!(await file.exists())) {
		return null;
	}
	try {
		const text = await file.text();
		const reg = JSON.parse(text) as { tmuxSession?: string };
		return reg.tmuxSession ?? null;
	} catch {
		return null;
	}
}

/**
 * Resolve the tmux session name for an agent.
 *
 * For regular agents, looks up the SessionStore.
 * For "orchestrator", falls back to the orchestrator-tmux.json registration
 * file written by `overstory prime`.
 *
 * Returns the tmux session name on success, or a structured `null` result that
 * captures the terminal-state diagnosis so callers can surface a helpful
 * recovery hint instead of a generic "no active session" error (overstory-629f).
 */
type ResolveTargetResult =
	| { kind: "found"; tmuxSession: string }
	| { kind: "missing" }
	| { kind: "terminal"; state: "completed" | "zombie"; capability: string; taskId: string };

async function resolveTargetSession(
	projectRoot: string,
	agentName: string,
): Promise<ResolveTargetResult> {
	const overstoryDir = join(projectRoot, ".overstory");
	const { store } = openSessionStore(overstoryDir);
	let terminal: ResolveTargetResult | null = null;
	try {
		const session = store.getByName(agentName);
		if (session) {
			if (session.state !== "zombie" && session.state !== "completed") {
				return { kind: "found", tmuxSession: session.tmuxSession };
			}
			terminal = {
				kind: "terminal",
				state: session.state,
				capability: session.capability,
				taskId: session.taskId,
			};
		}
	} finally {
		store.close();
	}

	// Fallback for orchestrator: check orchestrator-tmux.json
	if (agentName === "orchestrator") {
		const orchestratorTmux = await loadOrchestratorTmuxSession(projectRoot);
		if (orchestratorTmux !== null) {
			return { kind: "found", tmuxSession: orchestratorTmux };
		}
	}

	return terminal ?? { kind: "missing" };
}

/**
 * Build the operator-facing failure reason when a nudge cannot find a live
 * session. Terminal-state agents get a recovery hint pointing at
 * `ov sling --recover`; missing agents keep the generic message. (overstory-629f)
 */
export function buildMissingSessionReason(
	agentName: string,
	resolution: ResolveTargetResult,
): string {
	if (resolution.kind === "terminal") {
		return (
			`No active session for agent "${agentName}" (state: ${resolution.state}). ` +
			`The agent has exited; re-dispatch with ` +
			`'ov sling ${resolution.taskId} --capability ${resolution.capability} --recover'.`
		);
	}
	return `No active session for agent "${agentName}"`;
}

/**
 * Check debounce state for an agent. Returns true if a nudge was sent
 * within the debounce window and should be skipped.
 */
async function isDebounced(statePath: string, agentName: string): Promise<boolean> {
	const file = Bun.file(statePath);
	if (!(await file.exists())) {
		return false;
	}
	try {
		const text = await file.text();
		const state = JSON.parse(text) as Record<string, number>;
		const lastNudge = state[agentName];
		if (lastNudge === undefined) {
			return false;
		}
		return Date.now() - lastNudge < DEBOUNCE_MS;
	} catch {
		return false;
	}
}

/**
 * Record a nudge timestamp for debounce tracking.
 */
async function recordNudge(statePath: string, agentName: string): Promise<void> {
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

/** Outcome of a tmux nudge attempt. */
type SendNudgeResult =
	| { kind: "delivered" }
	| { kind: "deferred"; reason: string }
	| { kind: "failed" };

/**
 * Send a nudge to an agent's tmux session with retry logic.
 *
 * @param tmuxSession - The tmux session name
 * @param message - The text to send
 * @returns delivered on success, deferred when the agent stays mid-think
 *          beyond the idle window, failed when send-keys exhausts retries.
 */
async function sendNudgeWithRetry(tmuxSession: string, message: string): Promise<SendNudgeResult> {
	// Guard: never send-keys into a mid-think pane. Without this check, the
	// nudge text is queued as input and corrupts the in-flight prompt.
	// (overstory-8ff4)
	const idle = await waitForPaneIdle(tmuxSession);
	if (!idle) {
		return {
			kind: "deferred",
			reason: "Agent is mid-think (esc-to-interrupt visible) — nudge deferred",
		};
	}

	for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
		try {
			await sendKeys(tmuxSession, message);
			// Follow-up Enter after a short delay to ensure submission.
			// Claude Code's TUI may consume the first Enter during re-render/focus
			// events, leaving text visible but unsubmitted (overstory-t62v).
			// Same workaround as sling.ts and coordinator.ts.
			await Bun.sleep(500);
			await sendKeys(tmuxSession, "");
			return { kind: "delivered" };
		} catch {
			if (attempt < MAX_RETRIES) {
				await Bun.sleep(RETRY_DELAY_MS);
			}
		}
	}
	return { kind: "failed" };
}

/**
 * Read the current run ID from current-run.txt, or null if no active run.
 */
async function readCurrentRunId(overstoryDir: string): Promise<string | null> {
	const path = join(overstoryDir, "current-run.txt");
	const file = Bun.file(path);
	if (!(await file.exists())) {
		return null;
	}
	try {
		const text = await file.text();
		const trimmed = text.trim();
		return trimmed.length > 0 ? trimmed : null;
	} catch {
		return null;
	}
}

/**
 * Fire-and-forget: record a nudge event to EventStore. Never throws.
 */
function recordNudgeEvent(
	eventStore: EventStore,
	opts: {
		runId: string | null;
		agentName: string;
		from: string;
		message: string;
		delivered: boolean;
	},
): void {
	try {
		eventStore.insert({
			runId: opts.runId,
			agentName: opts.agentName,
			sessionId: null,
			eventType: "custom",
			toolName: null,
			toolArgs: null,
			toolDurationMs: null,
			level: "info",
			data: JSON.stringify({
				type: "nudge",
				from: opts.from,
				message: opts.message,
				delivered: opts.delivered,
			}),
		});
	} catch {
		// Fire-and-forget: event recording must never break nudge delivery
	}
}

/** Test-only injection point for the spawn-per-turn dispatch path. */
export interface NudgeAgentDeps {
	_runTurnFn?: (opts: RunTurnOpts) => Promise<TurnResult>;
	_loadConfig?: typeof loadConfig;
}

/**
 * Look up the agent's session row. Returns null when missing or terminal.
 * Terminal sessions are filtered here so the spawn-per-turn dispatch path
 * never re-spawns a completed builder.
 */
function loadActiveSessionForNudge(projectRoot: string, agentName: string): AgentSession | null {
	const overstoryDir = join(projectRoot, ".overstory");
	try {
		const { store } = openSessionStore(overstoryDir);
		try {
			const session = store.getByName(agentName);
			if (!session) return null;
			if (session.state === "completed" || session.state === "zombie") return null;
			return session;
		} finally {
			store.close();
		}
	} catch {
		return null;
	}
}

/** Best-effort: insert a nudge event into events.db. Never throws. */
function recordNudgeEventBestEffort(
	overstoryDir: string,
	agentName: string,
	message: string,
	delivered: boolean,
): void {
	try {
		const eventsDbPath = join(overstoryDir, "events.db");
		const eventStore = createEventStore(eventsDbPath);
		try {
			void readCurrentRunId(overstoryDir).then((runId) => {
				try {
					recordNudgeEvent(eventStore, {
						runId,
						agentName,
						from: "orchestrator",
						message,
						delivered,
					});
				} finally {
					try {
						eventStore.close();
					} catch {
						// already closed
					}
				}
			});
		} catch {
			try {
				eventStore.close();
			} catch {
				// already closed
			}
		}
	} catch {
		// non-fatal
	}
}

interface TryNudgeViaTurnRunnerInput {
	agentName: string;
	message: string;
	overstoryDir: string;
	projectRoot: string;
	statePath: string;
	deps: NudgeAgentDeps;
}

/**
 * If the target agent is a Phase 2 spawn-per-turn builder, deliver `message`
 * as a single user turn through `runTurn` and return the delivery result.
 *
 * Returns `null` when the agent is not eligible (flag off, non-builder,
 * terminal state, missing session, runtime cannot direct-spawn). The caller
 * falls back to the legacy FIFO/connection/tmux paths.
 *
 * The runTurn call is awaited synchronously: that lets the in-process
 * turn-lock serialize against the mail dispatcher running in `ov serve`.
 * Failures throw — the caller treats them as a delivery error.
 */
async function tryNudgeViaTurnRunner(
	input: TryNudgeViaTurnRunnerInput,
): Promise<{ delivered: boolean; queued?: boolean; reason?: string } | null> {
	const session = loadActiveSessionForNudge(input.projectRoot, input.agentName);
	if (!session) return null;

	const _load = input.deps._loadConfig ?? loadConfig;
	let config: Awaited<ReturnType<typeof loadConfig>>;
	try {
		config = await _load(input.projectRoot);
	} catch {
		return null;
	}

	const manifestLoader = createManifestLoader(
		join(config.project.root, config.agents.manifestPath),
		join(config.project.root, config.agents.baseDir),
	);
	let manifest: Awaited<ReturnType<typeof manifestLoader.load>>;
	try {
		manifest = await manifestLoader.load();
	} catch {
		return null;
	}

	let factory: ReturnType<typeof buildRunTurnOptsFactory>;
	try {
		factory = buildRunTurnOptsFactory({
			session,
			config,
			manifest,
			overstoryDir: input.overstoryDir,
		});
	} catch {
		return null;
	}

	if (!isSpawnPerTurnAgent(session, config, factory.runtime)) return null;

	const runTurnFn = input.deps._runTurnFn ?? runTurn;
	const opts = factory.build(encodeUserTurn(input.message));

	try {
		const result = await runTurnFn(opts);
		await recordNudge(input.statePath, input.agentName);
		// Mirror the FIFO branch's queued semantics: the message has been
		// consumed by claude inside this turn, but follow-up turns may still
		// observe it as "queued" if the agent didn't act on it immediately.
		return {
			delivered: true,
			queued: result.cleanResult !== true,
		};
	} catch (err) {
		return {
			delivered: false,
			reason: `Spawn-per-turn dispatch failed: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
}

/**
 * Core nudge function. Exported for use by mail send auto-nudge.
 *
 * Routes through the registered RuntimeConnection when available (headless agents),
 * or falls back to the tmux send-keys path (interactive agents).
 *
 * Headless nudges return queued=true because Claude Code does not reliably poll
 * stdin while an API stream is in flight — the message sits in the pipe buffer
 * until the current turn completes.
 *
 * For task-scoped headless Claude (Phase 3 spawn-per-turn), the nudge becomes
 * a single user-turn delivered via `runTurn`. The call awaits the turn
 * synchronously so the in-process turn-lock can serialize against concurrent
 * mail dispatchers.
 *
 * @param projectRoot - Absolute path to the project root
 * @param agentName - Name of the agent to nudge
 * @param message - Text to send (defaults to mail check prompt)
 * @param force - Skip debounce check
 * @returns Object with delivery status; queued=true when headless and buffered
 */
export async function nudgeAgent(
	projectRoot: string,
	agentName: string,
	message: string = DEFAULT_MESSAGE,
	force = false,
	deps: NudgeAgentDeps = {},
): Promise<{ delivered: boolean; queued?: boolean; reason?: string }> {
	let result: { delivered: boolean; queued?: boolean; reason?: string } | undefined;

	const statePath = join(projectRoot, ".overstory", "nudge-state.json");

	// Check debounce early — applies to both headless and tmux paths
	if (!force) {
		const debounced = await isDebounced(statePath, agentName);
		if (debounced) {
			return { delivered: false, reason: "Debounced: nudge sent too recently" };
		}
	}

	const overstoryDir = join(projectRoot, ".overstory");

	// Runtime-agnostic delivery preference (mx-17830a):
	//   1. Live in-process RuntimeConnection (Sapling RPC) → conn.nudge()
	//   2. Spawn-per-turn task-scoped Claude → runTurn() (no live connection)
	//   3. Tmux interactive agent → tmux send-keys
	const inProcConn = getConnection(agentName);
	if (inProcConn !== undefined && hasNudge(inProcConn)) {
		// In-process RPC path (Sapling and friends).
		const nudgeResult = await inProcConn.nudge(message);
		await recordNudge(statePath, agentName);
		result = { delivered: true, queued: nudgeResult.status === "Queued" };
	} else {
		// Spawn-per-turn dispatch for task-scoped headless Claude. When the
		// agent is eligible, deliver the nudge as a user turn through `runTurn`.
		// Returns null when ineligible (terminal state, persistent capability,
		// flag off, etc.) and we fall through to the tmux path.
		const spawnPerTurnResult = await tryNudgeViaTurnRunner({
			agentName,
			message,
			overstoryDir,
			projectRoot,
			statePath,
			deps,
		});
		if (spawnPerTurnResult !== null) {
			recordNudgeEventBestEffort(overstoryDir, agentName, message, spawnPerTurnResult.delivered);
			return spawnPerTurnResult;
		}
		// No live connection AND no spawn-per-turn eligibility — try tmux.
	}

	if (result === undefined) {
		// Tmux path: resolve session name from SessionStore / orchestrator-tmux.json
		const resolution = await resolveTargetSession(projectRoot, agentName);

		if (resolution.kind !== "found") {
			result = {
				delivered: false,
				reason: buildMissingSessionReason(agentName, resolution),
			};
		} else {
			const tmuxSessionName = resolution.tmuxSession;
			// Verify tmux session is alive
			const alive = await isSessionAlive(tmuxSessionName);
			if (!alive) {
				result = {
					delivered: false,
					reason: `Tmux session "${tmuxSessionName}" is not alive`,
				};
			} else {
				// Send with retry — sendNudgeWithRetry waits for an idle pane
				// before attempting send-keys (overstory-8ff4). It distinguishes
				// "deferred" (agent mid-think) from "failed" (transient errors).
				const sendResult = await sendNudgeWithRetry(tmuxSessionName, message);
				if (sendResult.kind === "delivered") {
					await recordNudge(statePath, agentName);
					result = { delivered: true };
				} else if (sendResult.kind === "deferred") {
					result = { delivered: false, reason: sendResult.reason };
				} else {
					result = {
						delivered: false,
						reason: `Failed to send after ${MAX_RETRIES} attempts`,
					};
				}
			}
		}
	}

	// Record event to EventStore (fire-and-forget)
	try {
		const eventsDbPath = join(overstoryDir, "events.db");
		const eventStore = createEventStore(eventsDbPath);
		try {
			const runId = await readCurrentRunId(overstoryDir);
			recordNudgeEvent(eventStore, {
				runId,
				agentName,
				from: "orchestrator",
				message,
				delivered: result.delivered,
			});
		} finally {
			eventStore.close();
		}
	} catch {
		// Event recording failure is non-fatal
	}

	return result;
}

/**
 * Entry point for `overstory nudge <agent-name> [message]`.
 */
export async function nudgeCommand(args: string[]): Promise<void> {
	const program = new Command();
	program
		.name("ov nudge")
		.description("Send a text nudge to an agent")
		.argument("<agent-name>", "Name of the agent to nudge")
		.argument("[message...]", "Text to send (default: check mail prompt)")
		.option("--from <name>", "Sender name", "orchestrator")
		.option("--force", "Skip debounce check")
		.option("--json", "Output result as JSON")
		.exitOverride()
		.action(
			async (
				agentName: string,
				messageParts: string[],
				opts: { from: string; force?: boolean; json?: boolean },
			) => {
				// Build the nudge message: prefix with sender, use custom or default text
				const customMessage = messageParts.join(" ");
				const rawMessage = customMessage.length > 0 ? customMessage : DEFAULT_MESSAGE;
				const message = `[NUDGE from ${opts.from}] ${rawMessage}`;

				// Resolve project root
				const { resolveProjectRoot } = await import("../config.ts");
				const projectRoot = await resolveProjectRoot(process.cwd());

				const result = await nudgeAgent(projectRoot, agentName, message, opts.force ?? false);

				if (opts.json) {
					jsonOutput("nudge", {
						agentName,
						delivered: result.delivered,
						queued: result.queued,
						reason: result.reason,
					});
				} else if (result.delivered) {
					if (result.queued) {
						printSuccess("Nudge queued (headless — will process after current turn)", agentName);
					} else {
						printSuccess("Nudge delivered", agentName);
					}
				} else {
					throw new AgentError(`Nudge failed: ${result.reason}`, { agentName });
				}
			},
		);

	await program.parseAsync(["node", "overstory-nudge", ...args]);
}

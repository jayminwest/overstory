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
import { AgentError } from "../errors.ts";
import { createEventStore } from "../events/store.ts";
import { jsonOutput } from "../json.ts";
import { printSuccess } from "../logging/color.ts";
import { openSessionStore } from "../sessions/compat.ts";
import type { EventStore } from "../types.ts";
import { getSessionManager } from "../worktree/session-factory.ts";

const DEFAULT_MESSAGE = "Check your mail inbox for new messages.";
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 500;
const DEBOUNCE_MS = 500;

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
 */
async function resolveTargetSession(
	projectRoot: string,
	agentName: string,
): Promise<string | null> {
	const overstoryDir = join(projectRoot, ".overstory");
	const { store } = openSessionStore(overstoryDir);
	try {
		const session = store.getByName(agentName);
		if (session && session.state !== "zombie" && session.state !== "completed") {
			return session.tmuxSession;
		}
	} finally {
		store.close();
	}

	// Fallback for orchestrator: check orchestrator-tmux.json
	if (agentName === "orchestrator") {
		return await loadOrchestratorTmuxSession(projectRoot);
	}

	return null;
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

/**
 * Send a nudge to an agent's tmux session with retry logic.
 *
 * @param tmuxSession - The tmux session name
 * @param message - The text to send
 * @returns true if the nudge was delivered, false if all retries failed
 */
async function sendNudgeWithRetry(tmuxSession: string, message: string): Promise<boolean> {
	const sm = await getSessionManager();
	for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
		try {
			await sm.sendKeys(tmuxSession, message);
			// Follow-up Enter after a short delay to ensure submission.
			// Claude Code's TUI may consume the first Enter during re-render/focus
			// events, leaving text visible but unsubmitted (overstory-t62v).
			// Same workaround as sling.ts and coordinator.ts.
			await Bun.sleep(500);
			await sm.sendKeys(tmuxSession, "");
			return true;
		} catch {
			if (attempt < MAX_RETRIES) {
				await Bun.sleep(RETRY_DELAY_MS);
			}
		}
	}
	return false;
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

/**
 * Core nudge function. Exported for use by mail send auto-nudge.
 *
 * @param projectRoot - Absolute path to the project root
 * @param agentName - Name of the agent to nudge
 * @param message - Text to send (defaults to mail check prompt)
 * @param force - Skip debounce check
 * @returns Object with delivery status
 */
export async function nudgeAgent(
	projectRoot: string,
	agentName: string,
	message: string = DEFAULT_MESSAGE,
	force = false,
): Promise<{ delivered: boolean; reason?: string }> {
	let result: { delivered: boolean; reason?: string };

	// Resolve tmux session (SessionStore for agents, orchestrator-tmux.json for orchestrator)
	const tmuxSessionName = await resolveTargetSession(projectRoot, agentName);

	if (!tmuxSessionName) {
		result = { delivered: false, reason: `No active session for agent "${agentName}"` };
	} else {
		// Check debounce (unless forced)
		let debounced = false;
		if (!force) {
			const statePath = join(projectRoot, ".overstory", "nudge-state.json");
			debounced = await isDebounced(statePath, agentName);
		}

		if (debounced) {
			result = { delivered: false, reason: "Debounced: nudge sent too recently" };
		} else {
			// Verify tmux session is alive
			const sm = await getSessionManager();
			const alive = await sm.isSessionAlive(tmuxSessionName);
			if (!alive) {
				result = {
					delivered: false,
					reason: `Tmux session "${tmuxSessionName}" is not alive`,
				};
			} else {
				// Send with retry
				const delivered = await sendNudgeWithRetry(tmuxSessionName, message);

				if (delivered) {
					// Record nudge for debounce tracking
					const statePath = join(projectRoot, ".overstory", "nudge-state.json");
					await recordNudge(statePath, agentName);
					result = { delivered: true };
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
		const overstoryDir = join(projectRoot, ".overstory");
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
					jsonOutput("nudge", { agentName, delivered: result.delivered, reason: result.reason });
				} else if (result.delivered) {
					printSuccess("Nudge delivered", agentName);
				} else {
					throw new AgentError(`Nudge failed: ${result.reason}`, { agentName });
				}
			},
		);

	await program.parseAsync(["node", "overstory-nudge", ...args]);
}

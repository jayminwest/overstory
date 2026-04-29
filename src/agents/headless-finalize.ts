/**
 * Finalization for headless agent sessions on subprocess exit.
 *
 * Headless mode (overstory-e24b) deploys only PreToolUse security guards — the
 * Stop hook that calls `ov log session-end` is absent. Without it, SessionStore
 * stays at 'working' forever once the agent's subprocess dies. The detached
 * watcher spawned by `ov sling` calls `finalizeHeadlessSession` to close that
 * gap (overstory-267e).
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createEventStore } from "../events/store.ts";
import { openSessionStore } from "../sessions/compat.ts";
import { removeAgentFifo } from "./headless-stdin.ts";

/**
 * Mark a headless agent's session as completed and emit a session_end event.
 *
 * Behaviour:
 *  1. Transition SessionStore state -> "completed" and refresh lastActivity.
 *     For a true process exit this applies regardless of capability — leads
 *     and persistent-style headless agents only have ONE session-end signal
 *     (the process dying), unlike tmux mode where Stop fires per turn.
 *  2. Write a session_end event to events.db so trace/feed/dashboard show the
 *     terminal moment.
 *  3. Reap the per-agent stdin FIFO so out-of-process writers (mail injector,
 *     nudge) drop their delivery loops cleanly.
 *  4. For lead agents, drop a pending-nudge marker for the coordinator —
 *     mirrors the auto-nudge that `ov stop` writes when terminating a lead.
 *
 * Idempotent: callers may invoke this multiple times. All writes silence
 * their own errors so a partial failure can't crash the watcher subprocess.
 */
export async function finalizeHeadlessSession(
	overstoryDir: string,
	agentName: string,
): Promise<void> {
	let capability: string | null = null;
	let alreadyCompleted = false;

	try {
		const { store } = openSessionStore(overstoryDir);
		try {
			const session = store.getByName(agentName);
			if (session) {
				capability = session.capability;
				if (session.state === "completed") {
					alreadyCompleted = true;
				} else {
					store.updateState(agentName, "completed");
					store.updateLastActivity(agentName);
				}
			}
		} finally {
			store.close();
		}
	} catch {
		// Non-fatal: SessionStore may be locked or absent
	}

	if (!alreadyCompleted) {
		try {
			const eventStore = createEventStore(join(overstoryDir, "events.db"));
			try {
				eventStore.insert({
					runId: null,
					agentName,
					sessionId: null,
					eventType: "session_end",
					toolName: null,
					toolArgs: null,
					toolDurationMs: null,
					level: "info",
					data: JSON.stringify({ source: "headless-exit-watcher" }),
				});
			} finally {
				eventStore.close();
			}
		} catch {
			// Non-fatal
		}
	}

	if (capability === "lead" && !alreadyCompleted) {
		try {
			const nudgesDir = join(overstoryDir, "pending-nudges");
			await mkdir(nudgesDir, { recursive: true });
			const markerPath = join(nudgesDir, "coordinator.json");
			const marker = {
				from: agentName,
				reason: "lead_completed",
				subject: `Lead ${agentName} completed — check mail for merge_ready/worker_done`,
				messageId: `auto-nudge-${agentName}-${Date.now()}`,
				createdAt: new Date().toISOString(),
			};
			await Bun.write(markerPath, `${JSON.stringify(marker, null, "\t")}\n`);
		} catch {
			// Non-fatal: nudge marker is a convenience, not a correctness signal
		}
	}

	try {
		removeAgentFifo(overstoryDir, agentName);
	} catch {
		// Non-fatal: FIFO may already be gone
	}
}

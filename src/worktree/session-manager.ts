/**
 * SessionManager interface — platform-agnostic agent session lifecycle.
 *
 * Abstracts the 10 tmux functions into an interface with two backends:
 * - TmuxSessionManager (Unix): delegates to tmux CLI
 * - WindowsSessionManager (Windows): uses Bun.spawn with stdin/stdout pipes
 *
 * Callers use getSessionManager() from session-factory.ts to get the
 * platform-appropriate implementation.
 */

import type { ReadyState } from "../runtimes/types.ts";

/**
 * Detailed session state for distinguishing failure modes.
 *
 * - `"alive"` — session exists and is reachable
 * - `"dead"` — session manager is running but session does not exist
 * - `"no_server"` — session manager itself is not running (tmux: no server; Windows: n/a)
 */
export type SessionState = "alive" | "dead" | "no_server";

/**
 * Platform-agnostic agent session lifecycle manager.
 *
 * Each method corresponds to a tmux operation used by overstory commands.
 * Implementations must be safe to call from multiple concurrent `ov` invocations
 * (e.g., orchestrator + watchdog polling simultaneously).
 */
export interface SessionManager {
	/**
	 * Create a new detached session running the given command.
	 *
	 * @param name - Unique session name (e.g., "overstory-myproject-auth-login")
	 * @param cwd - Working directory for the session
	 * @param command - Shell command to execute
	 * @param env - Optional environment variables to set in the session
	 * @returns The PID of the main process in the session
	 */
	createSession(
		name: string,
		cwd: string,
		command: string,
		env?: Record<string, string>,
	): Promise<number>;

	/**
	 * Send text input to a running session (simulates typing + Enter).
	 *
	 * @param name - Session name
	 * @param keys - Text to send (newlines flattened to spaces)
	 */
	sendKeys(name: string, keys: string): Promise<void>;

	/**
	 * Capture recent output from a session.
	 *
	 * @param name - Session name
	 * @param lines - Number of recent lines to capture (default 50)
	 * @returns The captured content, or null if the session doesn't exist
	 */
	capturePaneContent(name: string, lines?: number): Promise<string | null>;

	/**
	 * Check whether a session is alive (simple boolean).
	 */
	isSessionAlive(name: string): Promise<boolean>;

	/**
	 * Check session state with detailed failure mode reporting.
	 */
	checkSessionState(name: string): Promise<SessionState>;

	/**
	 * Kill a session and its entire process tree.
	 */
	killSession(name: string): Promise<void>;

	/**
	 * List all active sessions managed by this backend.
	 */
	listSessions(): Promise<Array<{ name: string; pid: number }>>;

	/**
	 * Get the PID of the main process in a session.
	 */
	getPanePid(name: string): Promise<number | null>;

	/**
	 * Wait for a session's TUI to become ready for input.
	 *
	 * Polls capturePaneContent and calls detectReady on each snapshot.
	 * When detectReady returns `{ phase: "dialog" }`, sends Enter to dismiss.
	 * When it returns `{ phase: "ready" }`, returns true.
	 *
	 * @returns true if ready before timeout, false on timeout or dead session
	 */
	waitForTuiReady(
		name: string,
		detectReady: (content: string) => ReadyState,
		timeoutMs?: number,
		pollIntervalMs?: number,
	): Promise<boolean>;

	/**
	 * Get the current session name (if running inside a managed session).
	 * Returns null if not running inside a session.
	 */
	getCurrentSessionName(): Promise<string | null>;

	/**
	 * Verify that the backend's prerequisites are available.
	 * Throws AgentError if prerequisites are missing (e.g., tmux not installed).
	 */
	ensureAvailable(): Promise<void>;
}

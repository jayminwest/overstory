/**
 * TmuxSessionManager — Unix backend for SessionManager.
 *
 * Pure delegation to existing tmux.ts functions, wrapped in the
 * SessionManager interface. No behavior changes from the original.
 */

import type { ReadyState } from "../runtimes/types.ts";
import type { SessionManager, SessionState } from "./session-manager.ts";
import {
	ensureTmuxAvailable,
	capturePaneContent as tmuxCapturePaneContent,
	checkSessionState as tmuxCheckSessionState,
	createSession as tmuxCreateSession,
	getCurrentSessionName as tmuxGetCurrentSessionName,
	getPanePid as tmuxGetPanePid,
	isSessionAlive as tmuxIsSessionAlive,
	killSession as tmuxKillSession,
	listSessions as tmuxListSessions,
	sendKeys as tmuxSendKeys,
	waitForTuiReady as tmuxWaitForTuiReady,
} from "./tmux.ts";

/**
 * SessionManager implementation backed by tmux.
 *
 * Used on Unix (Linux, macOS). Each agent session is a detached tmux session.
 * All operations delegate directly to the existing tmux.ts functions.
 */
export class TmuxSessionManager implements SessionManager {
	async createSession(
		name: string,
		cwd: string,
		command: string,
		env?: Record<string, string>,
	): Promise<number> {
		return tmuxCreateSession(name, cwd, command, env);
	}

	async sendKeys(name: string, keys: string): Promise<void> {
		return tmuxSendKeys(name, keys);
	}

	async capturePaneContent(name: string, lines?: number): Promise<string | null> {
		return tmuxCapturePaneContent(name, lines);
	}

	async isSessionAlive(name: string): Promise<boolean> {
		return tmuxIsSessionAlive(name);
	}

	async checkSessionState(name: string): Promise<SessionState> {
		return tmuxCheckSessionState(name);
	}

	async killSession(name: string): Promise<void> {
		return tmuxKillSession(name);
	}

	async listSessions(): Promise<Array<{ name: string; pid: number }>> {
		return tmuxListSessions();
	}

	async getPanePid(name: string): Promise<number | null> {
		return tmuxGetPanePid(name);
	}

	async waitForTuiReady(
		name: string,
		detectReady: (content: string) => ReadyState,
		timeoutMs?: number,
		pollIntervalMs?: number,
	): Promise<boolean> {
		return tmuxWaitForTuiReady(name, detectReady, timeoutMs, pollIntervalMs);
	}

	async getCurrentSessionName(): Promise<string | null> {
		return tmuxGetCurrentSessionName();
	}

	async ensureAvailable(): Promise<void> {
		return ensureTmuxAvailable();
	}
}

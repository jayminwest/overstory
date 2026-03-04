/**
 * Platform-detecting factory for SessionManager instances.
 *
 * Returns TmuxSessionManager on Unix, WindowsSessionManager on Windows.
 * Singleton — the same instance is returned for the lifetime of the process.
 */

import type { SessionManager } from "./session-manager.ts";

let _instance: SessionManager | null = null;

/**
 * Get the platform-appropriate SessionManager singleton.
 *
 * On Unix (Linux, macOS): returns TmuxSessionManager (wraps tmux CLI).
 * On Windows: returns WindowsSessionManager (Bun.spawn + stdin/stdout pipes).
 *
 * Lazy-loads the implementation module to avoid importing tmux code on Windows
 * or Windows code on Unix.
 */
export async function getSessionManager(): Promise<SessionManager> {
	if (_instance) return _instance;

	if (process.platform === "win32") {
		const { WindowsSessionManager } = await import("./windows-session-manager.ts");
		_instance = new WindowsSessionManager();
	} else {
		const { TmuxSessionManager } = await import("./tmux-session-manager.ts");
		_instance = new TmuxSessionManager();
	}

	return _instance;
}

/**
 * Reset the singleton instance (for testing only).
 */
export function resetSessionManager(): void {
	_instance = null;
}

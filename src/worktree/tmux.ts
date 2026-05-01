/**
 * Tmux session management for overstory agent workers.
 *
 * All operations use Bun.spawn to call the tmux CLI directly.
 * Session naming convention: `overstory-{projectName}-{agentName}`.
 * The project name prefix prevents cross-project tmux session collisions
 * and enables project-scoped cleanup (overstory-pcef).
 */

import { dirname, resolve } from "node:path";
import { AgentError } from "../errors.ts";
import type { ReadyState } from "../runtimes/types.ts";

/**
 * Dedicated tmux server socket name for agent session isolation.
 *
 * All overstory agent sessions use `tmux -L overstory` so they run on a
 * separate server from the user's personal tmux. This prevents user tmux
 * config (themes, plugins, keybindings) from interfering with agent spawn.
 * See GitHub #93.
 */
export const TMUX_SOCKET = "overstory";

/**
 * Sanitize a name component for use in tmux session names.
 *
 * Tmux interprets dots (.) as session.window.pane separators and colons (:)
 * as session:window separators in target strings (`-t`). If a project name
 * contains these characters (e.g., "consulting.jayminwest.com"), the session
 * is created fine but subsequent lookups via `-t` parse the dots as delimiters
 * and fail to find the session. Replace both with underscores.
 */
export function sanitizeTmuxName(name: string): string {
	return name.replace(/[.:]/g, "_");
}

/**
 * Build a tmux command array with the dedicated server socket.
 * All agent session operations should use this to ensure isolation.
 */
function tmuxCmd(...args: string[]): string[] {
	return ["tmux", "-L", TMUX_SOCKET, ...args];
}

/**
 * Detect the directory containing the overstory binary.
 *
 * Tries `which ov` first (the short alias), then falls back to
 * `which overstory` (the original name). Both are registered in
 * package.json bin, but depending on how the tool was installed
 * (bun link, npm link, global install), only one may be on PATH.
 *
 * Returns null if detection fails.
 */
async function detectOverstoryBinDir(): Promise<string | null> {
	// Try both command names — the alias migration may leave only one resolvable
	for (const cmdName of ["ov", "overstory"]) {
		try {
			const proc = Bun.spawn(["which", cmdName], {
				stdout: "pipe",
				stderr: "pipe",
			});
			const exitCode = await proc.exited;
			if (exitCode === 0) {
				const binPath = (await new Response(proc.stdout).text()).trim();
				if (binPath.length > 0) {
					return dirname(resolve(binPath));
				}
			}
		} catch {
			// which not available or command not on PATH — try next
		}
	}

	// Fallback: if process.argv[1] points to overstory's own entry point (src/index.ts),
	// derive the bin dir from the bun binary that's running it
	const scriptPath = process.argv[1];
	if (scriptPath?.includes("overstory")) {
		const bunPath = process.argv[0];
		if (bunPath) {
			return dirname(resolve(bunPath));
		}
	}

	return null;
}

/**
 * Run a shell command and capture its output.
 */
async function runCommand(
	cmd: string[],
	cwd?: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const proc = Bun.spawn(cmd, {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	const exitCode = await proc.exited;
	return { stdout, stderr, exitCode };
}

/**
 * Create a new detached tmux session running the given command.
 *
 * @param name - Session name (e.g., "overstory-myproject-auth-login")
 * @param cwd - Working directory for the session
 * @param command - Command to execute inside the session
 * @param env - Optional environment variables to export in the session
 * @returns The PID of the tmux server process for this session
 * @throws AgentError if tmux is not installed or session creation fails
 */
export async function createSession(
	name: string,
	cwd: string,
	command: string,
	env?: Record<string, string>,
	maxRetries = 3,
): Promise<number> {
	// Build environment exports for the tmux session
	const exports: string[] = [];

	// Ensure PATH includes the overstory binary directory
	// so that hooks calling `overstory` inside the session can find it
	const overstoryBinDir = await detectOverstoryBinDir();
	if (overstoryBinDir) {
		exports.push(`export PATH="${overstoryBinDir}:$PATH"`);
	}

	// Clear Claude Code nesting guard so child agents can start.
	// Claude Code >=2.1.66 sets CLAUDECODE=1 and refuses to launch when it's present.
	// Overstory's agent spawning is intentional, not accidental nesting.
	exports.push("unset CLAUDECODE CLAUDE_CODE_SSE_PORT CLAUDE_CODE_ENTRYPOINT");

	// Add any additional environment variables
	if (env) {
		for (const [key, value] of Object.entries(env)) {
			exports.push(`export ${key}="${value}"`);
		}
	}

	// Build the startup script using bash syntax (export/unset).
	// Then wrap it in `/bin/bash -c '...'` so it always runs in bash,
	// regardless of the user's $SHELL. Without this, tmux uses the user's
	// default shell (e.g. fish), which rejects bash export/unset syntax and
	// causes the session to die instantly. Single-quote wrapping with escaped
	// single quotes prevents any intermediate shell from expanding variables
	// before bash receives them. (GitHub #86)
	//
	// The `exec` prefix replaces the bash wrapper with the spawned command
	// so there is no separate wrapper PID to orphan if the tmux server dies
	// externally. Without exec, bash receives SIGHUP on tmux teardown but its
	// claude child gets reparented to init and continues running. With exec,
	// the wrapper IS the command — SIGHUP is delivered directly to claude.
	// (overstory-505d)
	const startupScript =
		exports.length > 0 ? `${exports.join(" && ")} && exec ${command}` : `exec ${command}`;
	const wrappedCommand = `/bin/bash -c '${startupScript.replace(/'/g, "'\\''")}'`;

	const { exitCode, stderr } = await runCommand(
		tmuxCmd("new-session", "-d", "-s", name, "-c", cwd, wrappedCommand),
		cwd,
	);

	if (exitCode !== 0) {
		throw new AgentError(`Failed to create tmux session "${name}": ${stderr.trim()}`, {
			agentName: name,
		});
	}

	// Retrieve the actual PID of the process running inside the tmux pane.
	// Retry up to maxRetries times with backoff for WSL2 race conditions where
	// the session exists but the pane hasn't been registered yet (#73).
	let pidResult: { stdout: string; stderr: string; exitCode: number } | undefined;
	for (let attempt = 0; attempt < maxRetries; attempt++) {
		pidResult = await runCommand(tmuxCmd("list-panes", "-t", name, "-F", "#{pane_pid}"));
		if (pidResult.exitCode === 0) break;
		await Bun.sleep(250 * (attempt + 1));
	}

	if (!pidResult || pidResult.exitCode !== 0) {
		throw new AgentError(
			`Created tmux session "${name}" but failed to retrieve PID: ${pidResult?.stderr.trim() ?? "unknown error"}`,
			{ agentName: name },
		);
	}

	const pidStr = pidResult.stdout.trim().split("\n")[0];
	if (pidStr) {
		const pid = Number.parseInt(pidStr, 10);
		if (!Number.isNaN(pid)) {
			return pid;
		}
	}

	throw new AgentError(`Created tmux session "${name}" but could not find its pane PID`, {
		agentName: name,
	});
}

/**
 * List all active tmux sessions.
 *
 * @returns Array of session name/pid pairs
 * @throws AgentError if tmux is not installed
 */
export async function listSessions(): Promise<Array<{ name: string; pid: number }>> {
	const { exitCode, stdout, stderr } = await runCommand(
		tmuxCmd("list-sessions", "-F", "#{session_name}:#{pid}"),
	);

	// Exit code 1 with "no server running" means no sessions exist — not an error
	if (exitCode !== 0) {
		if (stderr.includes("no server running") || stderr.includes("no sessions")) {
			return [];
		}
		throw new AgentError(`Failed to list tmux sessions: ${stderr.trim()}`);
	}

	const sessions: Array<{ name: string; pid: number }> = [];
	const lines = stdout.trim().split("\n");

	for (const line of lines) {
		if (line.trim() === "") continue;
		const sepIndex = line.indexOf(":");
		if (sepIndex === -1) continue;

		const name = line.slice(0, sepIndex);
		const pidStr = line.slice(sepIndex + 1);
		if (name && pidStr) {
			const pid = Number.parseInt(pidStr, 10);
			if (!Number.isNaN(pid)) {
				sessions.push({ name, pid });
			}
		}
	}

	return sessions;
}

/**
 * Grace period (ms) between SIGTERM and SIGKILL during process cleanup.
 */
const KILL_GRACE_PERIOD_MS = 2000;

/**
 * Get the pane PID for a tmux session.
 *
 * @param name - Tmux session name
 * @returns The PID of the process running in the session's pane, or null if
 *          the session doesn't exist or the PID can't be determined
 */
export async function getPanePid(name: string): Promise<number | null> {
	const { exitCode, stdout } = await runCommand(
		tmuxCmd("display-message", "-p", "-t", name, "#{pane_pid}"),
	);

	if (exitCode !== 0) {
		return null;
	}

	const pidStr = stdout.trim();
	if (pidStr.length === 0) {
		return null;
	}

	const pid = Number.parseInt(pidStr, 10);
	return Number.isNaN(pid) ? null : pid;
}

/**
 * Recursively collect all descendant PIDs of a given process.
 *
 * Uses `pgrep -P <pid>` to find direct children, then recurses into each child.
 * Returns PIDs in depth-first order (deepest descendants first), which is the
 * correct order for sending signals — kill children before parents so processes
 * don't get reparented to init (PID 1).
 *
 * @param pid - The root process PID to walk from
 * @returns Array of descendant PIDs, deepest-first
 */
export async function getDescendantPids(pid: number): Promise<number[]> {
	const { exitCode, stdout } = await runCommand(["pgrep", "-P", String(pid)]);

	// pgrep exits 1 when no children found — not an error
	if (exitCode !== 0 || stdout.trim().length === 0) {
		return [];
	}

	const childPids: number[] = [];
	for (const line of stdout.trim().split("\n")) {
		const childPid = Number.parseInt(line.trim(), 10);
		if (!Number.isNaN(childPid)) {
			childPids.push(childPid);
		}
	}

	// Recurse into each child to get their descendants first (depth-first)
	const allDescendants: number[] = [];
	for (const childPid of childPids) {
		const grandchildren = await getDescendantPids(childPid);
		allDescendants.push(...grandchildren);
	}

	// Append the direct children after their descendants (deepest-first order)
	allDescendants.push(...childPids);

	return allDescendants;
}

/**
 * Check if a process is still alive.
 *
 * @param pid - Process ID to check
 * @returns true if the process exists, false otherwise
 */
export function isProcessAlive(pid: number): boolean {
	try {
		// signal 0 doesn't send a signal but checks if the process exists
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * Kill a process tree: SIGTERM deepest-first, wait grace period, SIGKILL survivors.
 *
 * Follows gastown's KillSessionWithProcesses pattern:
 * 1. Walk descendant tree from the root PID
 * 2. Send SIGTERM to all descendants (deepest-first so children die before parents)
 * 3. Wait a grace period for processes to clean up
 * 4. Send SIGKILL to any survivors
 *
 * Handles edge cases:
 * - Already-dead processes (ESRCH) — silently ignored
 * - Reparented processes (PPID=1) — caught in the initial tree walk
 * - Permission errors — silently ignored (process belongs to another user)
 *
 * @param rootPid - The root PID whose descendants should be killed
 * @param gracePeriodMs - Time to wait between SIGTERM and SIGKILL (default 2000ms)
 */
export async function killProcessTree(
	rootPid: number,
	gracePeriodMs: number = KILL_GRACE_PERIOD_MS,
): Promise<void> {
	const descendants = await getDescendantPids(rootPid);

	if (descendants.length === 0) {
		// No descendants — just try to kill the root process
		sendSignal(rootPid, "SIGTERM");
		return;
	}

	// Phase 1: SIGTERM all descendants (deepest-first, then root)
	for (const pid of descendants) {
		sendSignal(pid, "SIGTERM");
	}
	sendSignal(rootPid, "SIGTERM");

	// Phase 2: Wait grace period for processes to clean up
	await Bun.sleep(gracePeriodMs);

	// Phase 3: SIGKILL any survivors (same order: deepest-first, then root)
	for (const pid of descendants) {
		if (isProcessAlive(pid)) {
			sendSignal(pid, "SIGKILL");
		}
	}
	if (isProcessAlive(rootPid)) {
		sendSignal(rootPid, "SIGKILL");
	}
}

/**
 * Send a signal to a process, ignoring errors for already-dead or inaccessible processes.
 *
 * @param pid - Process ID to signal
 * @param signal - Signal name (e.g., "SIGTERM", "SIGKILL")
 */
function sendSignal(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
	try {
		process.kill(pid, signal);
	} catch {
		// Process already dead (ESRCH), permission denied (EPERM), or invalid PID — all OK
	}
}

/**
 * Kill a tmux session by name, with proper process tree cleanup.
 *
 * Before killing the tmux session, walks the descendant process tree from the
 * pane PID, sends SIGTERM to all descendants (deepest-first), waits a grace
 * period, then sends SIGKILL to survivors. This ensures child processes
 * (git, bun test, biome, etc.) are properly cleaned up rather than being
 * orphaned or reparented to init.
 *
 * @param name - Session name to kill
 * @throws AgentError if the tmux session cannot be killed (process cleanup
 *         failures are silently handled since the goal is best-effort cleanup)
 */
export async function killSession(name: string): Promise<void> {
	// Defense in depth: an empty session name passed to `tmux -t` is prefix-matched
	// against every session in the server, wildcard-killing the entire overstory
	// swarm (overstory-74ce). Reject empty names at the boundary so a regression in
	// any caller surfaces loudly instead of silently nuking the tmux server.
	if (name === "") {
		throw new AgentError(
			"killSession called with empty session name (would wildcard-kill all tmux sessions due to prefix matching)",
			{ agentName: name },
		);
	}

	// Step 1: Get the pane PID before killing the tmux session
	const panePid = await getPanePid(name);

	// Step 2: If we have a pane PID, walk and kill the process tree
	if (panePid !== null) {
		await killProcessTree(panePid);
	}

	// Step 3: Kill the tmux session itself
	const { exitCode, stderr } = await runCommand(tmuxCmd("kill-session", "-t", name));

	if (exitCode !== 0) {
		// If the session is already gone (e.g., died during process cleanup), that's fine
		if (stderr.includes("session not found") || stderr.includes("can't find session")) {
			return;
		}
		throw new AgentError(`Failed to kill tmux session "${name}": ${stderr.trim()}`, {
			agentName: name,
		});
	}
}

/**
 * Detect the current tmux session name.
 *
 * Returns the session name if running inside tmux, null otherwise.
 * Used by `overstory prime` to register the orchestrator's tmux session
 * so agents can nudge the orchestrator when they have results.
 */
export async function getCurrentSessionName(): Promise<string | null> {
	if (!process.env.TMUX) {
		return null;
	}
	const { exitCode, stdout } = await runCommand([
		"tmux",
		"display-message",
		"-p",
		"#{session_name}",
	]);
	if (exitCode !== 0) {
		return null;
	}
	const name = stdout.trim();
	return name.length > 0 ? name : null;
}

/**
 * Check whether a tmux session is still alive.
 *
 * @param name - Session name to check
 * @returns true if the session exists, false otherwise
 */
export async function isSessionAlive(name: string): Promise<boolean> {
	// Defense in depth: an empty `-t` argument is prefix-matched against every
	// session, so `has-session` would return true whenever any overstory session
	// exists. Treat empty as "not alive" without contacting tmux (overstory-74ce).
	if (name === "") {
		return false;
	}
	const { exitCode } = await runCommand(tmuxCmd("has-session", "-t", name));
	return exitCode === 0;
}

/**
 * Detailed session state for distinguishing failure modes.
 *
 * - `"alive"` -- tmux session exists and is reachable.
 * - `"dead"` -- tmux server is running but the session does not exist.
 * - `"no_server"` -- tmux server is not running at all.
 */
export type SessionState = "alive" | "dead" | "no_server";

/**
 * Check tmux session state with detailed failure mode reporting.
 *
 * Unlike `isSessionAlive()` which returns a simple boolean, this function
 * distinguishes between three states:
 * - `"alive"`: session exists -- the agent may still be running.
 * - `"dead"`: tmux server is running but session is gone -- agent exited or was killed.
 * - `"no_server"`: tmux server itself is not running -- all sessions are gone.
 *
 * Callers can use this to provide targeted error messages and decide whether
 * stale session records should be cleaned up vs flagged as errors.
 *
 * @param name - Session name to check
 * @returns The session state
 */
export async function checkSessionState(name: string): Promise<SessionState> {
	const { exitCode, stderr } = await runCommand(tmuxCmd("has-session", "-t", name));
	if (exitCode === 0) return "alive";
	if (stderr.includes("no server running") || stderr.includes("no sessions")) {
		return "no_server";
	}
	return "dead";
}

/**
 * Capture the visible content of a tmux session's pane.
 *
 * @param name - Session name to capture from
 * @param lines - Number of history lines to capture (default 50)
 * @returns The trimmed pane content, or null if capture fails
 */
export async function capturePaneContent(name: string, lines = 50): Promise<string | null> {
	const { exitCode, stdout } = await runCommand(
		tmuxCmd("capture-pane", "-t", name, "-p", "-S", `-${lines}`),
	);
	if (exitCode !== 0) {
		return null;
	}
	const content = stdout.trim();
	return content.length > 0 ? content : null;
}

/**
 * Wait for a tmux session's TUI to become ready for input.
 *
 * Delegates all readiness detection to the provided `detectReady` callback,
 * making this function runtime-agnostic. The callback inspects pane content
 * and returns a ReadyState phase: "loading" (keep waiting), "dialog" (send
 * the requested action, then continue), or "ready" (return true).
 *
 * Dialog actions that type raw text (for example Claude Code's `type:2`
 * bypass confirmation) are retried if the same dialog is still visible on
 * later polls. This avoids one-shot startup flakes when tmux or the TUI drops
 * the first keypress during initialization.
 *
 * @param name - Tmux session name to poll
 * @param detectReady - Callback that inspects pane content and returns ReadyState
 * @param timeoutMs - Maximum time to wait before giving up (default 30s)
 * @param pollIntervalMs - Time between polls (default 500ms)
 * @returns true once detectReady returns { phase: "ready" }, false on timeout or dead session
 */
export async function waitForTuiReady(
	name: string,
	detectReady: (paneContent: string) => ReadyState,
	timeoutMs = 30_000,
	pollIntervalMs = 500,
): Promise<boolean> {
	const maxAttempts = Math.ceil(timeoutMs / pollIntervalMs);
	const handledDialogs = new Map<string, number>();
	const typedDialogRetryPolls = Math.max(2, Math.ceil(1_000 / pollIntervalMs));

	for (let i = 0; i < maxAttempts; i++) {
		const content = await capturePaneContent(name);
		if (content !== null) {
			const state = detectReady(content);

			if (state.phase === "dialog") {
				const lastHandledAttempt = handledDialogs.get(state.action);
				const shouldRetryTypedDialog =
					state.action.startsWith("type:") &&
					lastHandledAttempt !== undefined &&
					i - lastHandledAttempt >= typedDialogRetryPolls;
				const shouldHandleDialog = lastHandledAttempt === undefined || shouldRetryTypedDialog;

				if (shouldHandleDialog) {
					await handleDialogAction(name, state.action, pollIntervalMs);
					handledDialogs.set(state.action, i);
					await Bun.sleep(pollIntervalMs);
					continue;
				}
			}

			if (state.phase === "ready") {
				return true;
			}
		}

		const alive = await isSessionAlive(name);
		if (!alive) {
			return false;
		}
		await Bun.sleep(pollIntervalMs);
	}
	return false;
}

/**
 * Verify that tmux is installed and executable.
 * Throws AgentError with a clear message if tmux is not available.
 */
export async function ensureTmuxAvailable(): Promise<void> {
	const { exitCode } = await runCommand(["tmux", "-V"]);
	if (exitCode !== 0) {
		throw new AgentError(
			"tmux is not installed or not on PATH. Install tmux to use overstory agent orchestration.",
		);
	}
}

/**
 * Send keys to a tmux session, with retry for WSL2 pane registration race.
 *
 * On WSL2, tmux occasionally reports "can't find pane" immediately after session
 * creation even though the session exists. This is a timing issue where the pane
 * hasn't been fully registered yet. We retry with backoff to handle this.
 *
 * @param name - Session name to send keys to
 * @param keys - The keys/text to send
 * @param maxRetries - Maximum retry attempts for transient pane errors (default 3)
 * @throws AgentError if the session does not exist or send fails after retries
 */
export async function sendKeys(name: string, keys: string, maxRetries = 3): Promise<void> {
	// Flatten newlines to spaces — multiline text via tmux send-keys causes
	// Claude Code's TUI to receive embedded Enter keystrokes which prevent
	// the final "Enter" from triggering message submission (overstory-y2ob).
	const flatKeys = keys.replace(/\n/g, " ");

	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		const { exitCode, stderr } = await runCommand(
			tmuxCmd("send-keys", "-t", name, flatKeys, "Enter"),
		);

		if (exitCode === 0) {
			return;
		}

		const trimmedStderr = stderr.trim();

		if (trimmedStderr.includes("no server running")) {
			throw new AgentError(
				`Tmux server is not running (cannot reach session "${name}"). This often happens when running as root (UID 0) or when tmux crashed. Original error: ${trimmedStderr}`,
				{ agentName: name },
			);
		}

		// "can't find pane" is a transient race condition on WSL2 — the session
		// exists but the pane hasn't been fully registered yet. Retry with backoff.
		if (trimmedStderr.includes("can't find pane") || trimmedStderr.includes("cant find pane")) {
			if (attempt < maxRetries) {
				const delayMs = 250 * (attempt + 1);
				await Bun.sleep(delayMs);
				continue;
			}
			// Exhausted retries — report as pane-specific error
			throw new AgentError(
				`Tmux pane for session "${name}" not found after ${maxRetries + 1} attempts. On WSL2, this can indicate a tmux startup race condition. Try increasing the retry count or adding a delay after session creation.`,
				{ agentName: name },
			);
		}

		if (
			trimmedStderr.includes("session not found") ||
			trimmedStderr.includes("can't find session") ||
			trimmedStderr.includes("cant find session")
		) {
			throw new AgentError(
				`Tmux session "${name}" does not exist. The agent may have crashed or been killed before receiving input.`,
				{ agentName: name },
			);
		}

		throw new AgentError(`Failed to send keys to tmux session "${name}": ${trimmedStderr}`, {
			agentName: name,
		});
	}
}

async function sendRawKeys(name: string, keys: string): Promise<void> {
	const flatKeys = keys.replace(/\n/g, " ");
	const { exitCode, stderr } = await runCommand(tmuxCmd("send-keys", "-t", name, flatKeys));

	if (exitCode !== 0) {
		const trimmedStderr = stderr.trim();

		if (trimmedStderr.includes("no server running")) {
			throw new AgentError(
				`Tmux server is not running (cannot reach session "${name}"). This often happens when running as root (UID 0) or when tmux crashed. Original error: ${trimmedStderr}`,
				{ agentName: name },
			);
		}

		if (
			trimmedStderr.includes("session not found") ||
			trimmedStderr.includes("can't find session") ||
			trimmedStderr.includes("cant find session")
		) {
			throw new AgentError(
				`Tmux session "${name}" does not exist. The agent may have crashed or been killed before receiving input.`,
				{ agentName: name },
			);
		}

		throw new AgentError(`Failed to send keys to tmux session "${name}": ${trimmedStderr}`, {
			agentName: name,
		});
	}
}

async function handleDialogAction(
	name: string,
	action: string,
	pollIntervalMs: number,
): Promise<void> {
	if (action.startsWith("type:")) {
		await sendRawKeys(name, action.slice("type:".length));
		await Bun.sleep(Math.min(pollIntervalMs, 250));
		await sendKeys(name, "");
		return;
	}

	await sendKeys(name, action === "Enter" ? "" : action);
}

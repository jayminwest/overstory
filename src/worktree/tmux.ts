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

/**
 * Detect the directory containing the overstory binary.
 *
 * Checks process.argv[0] first (the bun/node executable path won't help,
 * but process.argv[1] is the script path for `bun run`), then falls back
 * to `which overstory` to find it on the current PATH.
 *
 * Returns null if detection fails.
 */
async function detectOverstoryBinDir(): Promise<string | null> {
	// process.argv[1] is the script entry point (e.g., /path/to/overstory/src/index.ts)
	// The overstory binary (bun link) resolves to a bin dir
	// Try `which overstory` for the most reliable result
	try {
		const proc = Bun.spawn(["which", "overstory"], {
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
		// which not available or overstory not on PATH
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
): Promise<number> {
	// Build environment exports for the tmux session
	const exports: string[] = [];

	// Ensure PATH includes the overstory binary directory
	// so that hooks calling `overstory` inside the session can find it
	const overstoryBinDir = await detectOverstoryBinDir();
	if (overstoryBinDir) {
		exports.push(`export PATH="${overstoryBinDir}:$PATH"`);
	}

	// Add any additional environment variables
	if (env) {
		for (const [key, value] of Object.entries(env)) {
			exports.push(`export ${key}="${value}"`);
		}
	}

	const wrappedCommand = exports.length > 0 ? `${exports.join(" && ")} && ${command}` : command;

	const { exitCode, stderr } = await runCommand(
		["tmux", "new-session", "-d", "-s", name, "-c", cwd, wrappedCommand],
		cwd,
	);

	if (exitCode !== 0) {
		throw new AgentError(`Failed to create tmux session "${name}": ${stderr.trim()}`, {
			agentName: name,
		});
	}

	// Retrieve the actual PID of the process running inside the tmux pane
	const pidResult = await runCommand(["tmux", "list-panes", "-t", name, "-F", "#{pane_pid}"]);

	if (pidResult.exitCode !== 0) {
		throw new AgentError(
			`Created tmux session "${name}" but failed to retrieve PID: ${pidResult.stderr.trim()}`,
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
	const { exitCode, stdout, stderr } = await runCommand([
		"tmux",
		"list-sessions",
		"-F",
		"#{session_name}:#{pid}",
	]);

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
	const { exitCode, stdout } = await runCommand([
		"tmux",
		"display-message",
		"-p",
		"-t",
		name,
		"#{pane_pid}",
	]);

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
	// Step 1: Get the pane PID before killing the tmux session
	const panePid = await getPanePid(name);

	// Step 2: If we have a pane PID, walk and kill the process tree
	if (panePid !== null) {
		await killProcessTree(panePid);
	}

	// Step 3: Kill the tmux session itself
	const { exitCode, stderr } = await runCommand(["tmux", "kill-session", "-t", name]);

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
 * Used by startup hooks (`overstory init --ensure`) to register the orchestrator's tmux session
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
	const { exitCode } = await runCommand(["tmux", "has-session", "-t", name]);
	return exitCode === 0;
}

/**
 * Send keys to a tmux session.
 *
 * @param name - Session name to send keys to
 * @param keys - The keys/text to send
 * @throws AgentError if the session does not exist or send fails
 */
export async function sendKeys(name: string, keys: string): Promise<void> {
	// Flatten newlines to spaces — multiline text via tmux send-keys causes
	// Claude Code's TUI to receive embedded Enter keystrokes which prevent
	// the final "Enter" from triggering message submission (overstory-y2ob).
	const flatKeys = keys.replace(/\n/g, " ");
	const { exitCode, stderr } = await runCommand([
		"tmux",
		"send-keys",
		"-t",
		name,
		flatKeys,
		"Enter",
	]);

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

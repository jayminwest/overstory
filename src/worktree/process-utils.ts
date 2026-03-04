/**
 * Cross-platform process utilities.
 *
 * Extracted from tmux.ts to be shared by both TmuxSessionManager (Unix)
 * and WindowsSessionManager (Windows). These functions handle process
 * liveness checks, tree killing, and binary detection without depending
 * on tmux.
 */

import { dirname, resolve } from "node:path";
import { AgentError } from "../errors.ts";

/**
 * Grace period (ms) between SIGTERM and SIGKILL during process cleanup.
 */
const KILL_GRACE_PERIOD_MS = 2000;

/**
 * Check if a process is still alive.
 *
 * Uses signal 0 probe — works cross-platform on both Unix and Windows
 * (Node.js/Bun handle the platform differences internally).
 *
 * @param pid - Process ID to check
 * @returns true if the process exists, false otherwise
 */
export function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * Send a signal to a process, ignoring errors for already-dead or inaccessible processes.
 */
function sendSignal(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
	try {
		process.kill(pid, signal);
	} catch {
		// Process already dead (ESRCH), permission denied (EPERM), or invalid PID — all OK
	}
}

/**
 * Run a command and capture its output.
 */
async function runCommand(
	cmd: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const proc = Bun.spawn(cmd, {
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	const exitCode = await proc.exited;
	return { stdout, stderr, exitCode };
}

/**
 * Recursively collect all descendant PIDs of a given process.
 *
 * Platform-specific:
 * - Unix: uses `pgrep -P <pid>` recursively (deepest-first order)
 * - Windows: uses `wmic process where ParentProcessId=<pid> get ProcessId`
 *
 * @param pid - The root process PID to walk from
 * @returns Array of descendant PIDs, deepest-first
 */
export async function getDescendantPids(pid: number): Promise<number[]> {
	if (process.platform === "win32") {
		return getDescendantPidsWindows(pid);
	}
	return getDescendantPidsUnix(pid);
}

async function getDescendantPidsUnix(pid: number): Promise<number[]> {
	const { exitCode, stdout } = await runCommand(["pgrep", "-P", String(pid)]);

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

	const allDescendants: number[] = [];
	for (const childPid of childPids) {
		const grandchildren = await getDescendantPidsUnix(childPid);
		allDescendants.push(...grandchildren);
	}
	allDescendants.push(...childPids);

	return allDescendants;
}

async function getDescendantPidsWindows(pid: number): Promise<number[]> {
	const { exitCode, stdout } = await runCommand([
		"wmic",
		"process",
		"where",
		`ParentProcessId=${pid}`,
		"get",
		"ProcessId",
	]);

	if (exitCode !== 0 || stdout.trim().length === 0) {
		return [];
	}

	const childPids: number[] = [];
	for (const line of stdout.trim().split("\n")) {
		const trimmed = line.trim();
		// Skip header line "ProcessId"
		if (trimmed === "" || trimmed === "ProcessId") continue;
		const childPid = Number.parseInt(trimmed, 10);
		if (!Number.isNaN(childPid)) {
			childPids.push(childPid);
		}
	}

	const allDescendants: number[] = [];
	for (const childPid of childPids) {
		const grandchildren = await getDescendantPidsWindows(childPid);
		allDescendants.push(...grandchildren);
	}
	allDescendants.push(...childPids);

	return allDescendants;
}

/**
 * Kill a process tree: SIGTERM deepest-first, wait grace period, SIGKILL survivors.
 *
 * Platform-specific:
 * - Unix: walks descendant tree with pgrep, sends SIGTERM/SIGKILL
 * - Windows: uses `taskkill /F /T /PID` for recursive tree kill
 *
 * @param rootPid - The root PID whose descendants should be killed
 * @param gracePeriodMs - Time to wait between SIGTERM and SIGKILL (default 2000ms)
 */
export async function killProcessTree(
	rootPid: number,
	gracePeriodMs: number = KILL_GRACE_PERIOD_MS,
): Promise<void> {
	if (process.platform === "win32") {
		return killProcessTreeWindows(rootPid);
	}
	return killProcessTreeUnix(rootPid, gracePeriodMs);
}

async function killProcessTreeUnix(rootPid: number, gracePeriodMs: number): Promise<void> {
	const descendants = await getDescendantPidsUnix(rootPid);

	if (descendants.length === 0) {
		sendSignal(rootPid, "SIGTERM");
		return;
	}

	// Phase 1: SIGTERM all descendants (deepest-first, then root)
	for (const pid of descendants) {
		sendSignal(pid, "SIGTERM");
	}
	sendSignal(rootPid, "SIGTERM");

	// Phase 2: Wait grace period
	await Bun.sleep(gracePeriodMs);

	// Phase 3: SIGKILL survivors
	for (const pid of descendants) {
		if (isProcessAlive(pid)) {
			sendSignal(pid, "SIGKILL");
		}
	}
	if (isProcessAlive(rootPid)) {
		sendSignal(rootPid, "SIGKILL");
	}
}

async function killProcessTreeWindows(rootPid: number): Promise<void> {
	// taskkill /F /T handles the entire tree recursively in one command
	try {
		const proc = Bun.spawn(["taskkill", "/F", "/T", "/PID", String(rootPid)], {
			stdout: "pipe",
			stderr: "pipe",
		});
		await proc.exited;
	} catch {
		// Best effort — process may already be dead
	}
}

/**
 * Detect the directory containing the overstory binary.
 *
 * Tries `which`/`where` for `ov` then `overstory`, falls back to process.argv.
 * Returns null if detection fails.
 */
export async function detectOverstoryBinDir(): Promise<string | null> {
	const findCmd = process.platform === "win32" ? "where" : "which";

	for (const cmdName of ["ov", "overstory"]) {
		try {
			const proc = Bun.spawn([findCmd, cmdName], {
				stdout: "pipe",
				stderr: "pipe",
			});
			const exitCode = await proc.exited;
			if (exitCode === 0) {
				const binPath = (await new Response(proc.stdout).text()).trim();
				// `where` on Windows may return multiple lines; take the first
				const firstLine = binPath.split("\n")[0]?.trim();
				if (firstLine && firstLine.length > 0) {
					return dirname(resolve(firstLine));
				}
			}
		} catch {
			// Command not available or not on PATH — try next
		}
	}

	// Fallback: derive from process.argv
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
 * Ensure the session manager's prerequisites are available.
 *
 * - Unix: checks that tmux is installed
 * - Windows: checks that taskkill is available (always present on Windows)
 *
 * @throws AgentError if prerequisites are missing
 */
export async function ensureSessionPrerequisites(): Promise<void> {
	if (process.platform === "win32") {
		// taskkill is always available on Windows — nothing to check
		return;
	}

	// Unix: check tmux
	const proc = Bun.spawn(["tmux", "-V"], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		throw new AgentError(
			"tmux is not installed or not on PATH. Install tmux to use overstory agent orchestration.",
		);
	}
}

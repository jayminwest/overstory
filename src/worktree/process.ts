/**
 * Headless subprocess management for non-tmux agent runtimes.
 *
 * Used by `ov sling` when runtime.headless === true to bypass tmux entirely.
 * Provides spawnHeadlessAgent() for direct Bun.spawn() invocation of
 * headless agent processes (e.g., Sapling running with --json).
 *
 * Note: isProcessAlive() and killProcessTree() for headless process lifecycle
 * management already exist in src/worktree/tmux.ts — not duplicated here.
 */

import { AgentError } from "../errors.ts";

/**
 * Handle to a spawned headless agent subprocess.
 *
 * Provides the PID for session tracking, stdin for sending input to the
 * agent process, and stdout for consuming NDJSON event output.
 */
export interface HeadlessProcess {
	/** OS-level process ID. Stored in AgentSession.pid for watchdog monitoring. */
	pid: number;
	/** Writable sink for sending input to the process (e.g., RPC messages). */
	stdin: { write(data: string | Uint8Array): number | Promise<number> };
	/** Readable stream of the process stdout — consumed via runtime.parseEvents(). */
	stdout: ReadableStream<Uint8Array>;
}

/**
 * Spawn a headless agent subprocess directly via Bun.spawn().
 *
 * Used by `ov sling` when runtime.headless === true to bypass all tmux
 * session management. The caller is responsible for:
 * - Consuming stdout via runtime.parseEvents() to prevent backpressure
 * - Awaiting process exit (via proc.exited) to collect the exit code
 * - Reporting errors through the mail system
 *
 * The provided env is used as the full subprocess environment (no implicit
 * merging with process.env — callers should merge explicitly if needed).
 *
 * @param argv - Full argv array from runtime.buildDirectSpawn(); first element is the executable
 * @param opts - Working directory and environment for the subprocess
 * @returns HeadlessProcess with pid, stdin, and stdout streams
 * @throws AgentError if argv is empty
 */
export async function spawnHeadlessAgent(
	argv: string[],
	opts: { cwd: string; env: Record<string, string> },
): Promise<HeadlessProcess> {
	const [cmd, ...args] = argv;
	if (!cmd) {
		throw new AgentError("buildDirectSpawn returned empty argv array", {
			agentName: "headless",
		});
	}

	const proc = Bun.spawn([cmd, ...args], {
		cwd: opts.cwd,
		env: opts.env,
		stdout: "pipe",
		stderr: "pipe",
		stdin: "pipe",
	});

	return {
		pid: proc.pid,
		stdin: proc.stdin,
		stdout: proc.stdout,
	};
}

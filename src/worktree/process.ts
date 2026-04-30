/**
 * Headless subprocess management for non-tmux agent runtimes.
 *
 * Used by long-lived headless runtimes that bypass tmux (e.g., Sapling running
 * with --json). Provides spawnHeadlessAgent() for direct Bun.spawn() invocation.
 *
 * Headless Claude Code does NOT use this path — under spawn-per-turn (Phase 3),
 * Claude agents have no persistent process; each turn spawns a fresh claude
 * inside `runTurn` (src/agents/turn-runner.ts). This module remains for
 * runtimes that genuinely need a long-lived RPC channel.
 *
 * Note: isProcessAlive() and killProcessTree() for headless process lifecycle
 * management already exist in src/worktree/tmux.ts — not duplicated here.
 */

import { AgentError } from "../errors.ts";
import { registerHeadlessConnection } from "../runtimes/connections.ts";

/**
 * Handle to a spawned headless agent subprocess.
 *
 * Provides the PID for session tracking, stdin for sending input to the
 * agent process, and stdout for consuming NDJSON event output.
 *
 * stdout is null when the process was spawned with a stdoutFile redirect
 * (file-redirect mode). In that case, stdout is written directly to the
 * log file and no pipe backpressure can occur.
 */
export interface HeadlessProcess {
	/** OS-level process ID. Stored in AgentSession.pid for watchdog monitoring. */
	pid: number;
	/** Writable sink for sending input to the process (e.g., RPC messages). */
	stdin: { write(data: string | Uint8Array): number | Promise<number> };
	/**
	 * Readable stream of the process stdout, or null when stdout was redirected
	 * to a file via stdoutFile. Consumed via runtime.parseEvents() when piped.
	 */
	stdout: ReadableStream<Uint8Array> | null;
}

/**
 * Options for spawning a headless agent subprocess.
 *
 * When stdoutFile or stderrFile are provided, the corresponding stream is
 * redirected to the given file path instead of a pipe. This eliminates
 * backpressure: the child process can write unlimited output without blocking.
 *
 * Log files are useful for post-mortem inspection and do not need to be
 * consumed by the caller.
 */
export interface SpawnHeadlessOptions {
	/** Working directory for the subprocess. */
	cwd: string;
	/** Full environment for the subprocess (no implicit merging with process.env). */
	env: Record<string, string>;
	/**
	 * When set, redirect subprocess stdout to this file path instead of a pipe.
	 * HeadlessProcess.stdout will be null in this case.
	 */
	stdoutFile?: string;
	/**
	 * When set, redirect subprocess stderr to this file path instead of a pipe.
	 */
	stderrFile?: string;
	/**
	 * When set, registers the spawned process as a `RuntimeConnection` keyed by
	 * this agent name (sibling of Sapling's RPC connect() flow). Lets `ov nudge`,
	 * the watchdog's liveness/abort path, etc. find the live process via
	 * `getConnection(agentName)`.
	 *
	 * Same namespace as AgentSession.agentName.
	 */
	agentName?: string;
}

/**
 * Spawn a headless agent subprocess directly via Bun.spawn().
 *
 * Used by `ov sling` when runtime.headless === true to bypass all tmux
 * session management.
 *
 * **Backpressure prevention:** Pass stdoutFile (and stderrFile) to redirect
 * output to log files instead of pipes. This is the recommended mode for
 * `ov sling` — it prevents the OS pipe buffer (~64 KB) from filling up and
 * blocking the child process when the caller does not actively consume stdout.
 *
 * When no file paths are provided (default/legacy mode), stdout is a pipe and
 * the caller is responsible for consuming it to prevent backpressure.
 *
 * The provided env is used as the full subprocess environment (no implicit
 * merging with process.env — callers should merge explicitly if needed).
 *
 * @param argv - Full argv array from runtime.buildDirectSpawn(); first element is the executable
 * @param opts - Working directory, environment, and optional log file paths
 * @returns HeadlessProcess with pid, stdin, and stdout (null if file-redirected)
 * @throws AgentError if argv is empty
 */
export async function spawnHeadlessAgent(
	argv: string[],
	opts: SpawnHeadlessOptions,
): Promise<HeadlessProcess> {
	const [cmd, ...args] = argv;
	if (!cmd) {
		throw new AgentError("buildDirectSpawn returned empty argv array", {
			agentName: "headless",
		});
	}

	const stdoutTarget = opts.stdoutFile ? Bun.file(opts.stdoutFile) : "pipe";
	const stderrTarget = opts.stderrFile ? Bun.file(opts.stderrFile) : "pipe";

	const proc = Bun.spawn([cmd, ...args], {
		cwd: opts.cwd,
		env: opts.env,
		stdout: stdoutTarget,
		stderr: stderrTarget,
		stdin: "pipe",
	});

	const result: HeadlessProcess = {
		pid: proc.pid,
		stdin: proc.stdin as HeadlessProcess["stdin"],
		stdout: opts.stdoutFile ? null : (proc.stdout as ReadableStream<Uint8Array>),
	};

	if (opts.agentName) {
		registerHeadlessConnection(opts.agentName, result);
	}

	return result;
}

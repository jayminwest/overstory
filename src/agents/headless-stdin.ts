/**
 * Per-agent stdin FIFO for cross-process delivery to headless agents.
 *
 * `ov sling` exits after spawning a headless agent, so the agent's stdin pipe
 * loses its only writer. Without a long-lived parent, no other process can
 * deliver post-spawn input — mail injection, nudges, etc. all fail.
 *
 * The FIFO works around this by giving the agent a stdin source that lives on
 * the filesystem, so any process can open and write to it for as long as the
 * agent is alive.
 *
 * Layout:
 *   {overstoryDir}/agents/{agentName}/stdin.fifo
 *
 * Lifecycle:
 *   1. `ov sling` calls createAgentFifo() before spawn. The FIFO is opened
 *      O_RDWR (never blocks, never EOFs) and the fd is passed to Bun.spawn as
 *      the child's stdin. The local fd is closed; the child holds the only
 *      remaining read reference.
 *   2. Any writer (ov serve mail injector, ov nudge, ov mail) opens the FIFO
 *      O_WRONLY | O_NONBLOCK. ENXIO means the agent is gone — drop the
 *      message and let the caller clean up. EPIPE during write means the
 *      reader closed mid-write; same handling.
 *   3. POSIX guarantees writes ≤ PIPE_BUF (4096 on macOS/Linux) are atomic
 *      across concurrent writers. Larger writes may interleave, so callers
 *      use a per-FIFO advisory lock (flock) for safety.
 *   4. removeAgentFifo() unlinks the path on agent termination.
 *
 * POSIX-only (macOS, Linux). FIFOs are not available on Windows; overstory
 * does not target Windows today.
 */

import {
	closeSync,
	constants,
	existsSync,
	mkdirSync,
	openSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { join } from "node:path";
import { AgentError } from "../errors.ts";

// Belt-and-braces: ensure SIGPIPE never kills the host process. The kernel
// delivers SIGPIPE alongside EPIPE on a write to a pipe whose reader vanished;
// our writeToAgentFifo() catches EPIPE explicitly, so we just need the default
// signal action suppressed. Bun and Node typically install SIG_IGN already, but
// installing a no-op handler is cheap and avoids surprising regressions.
process.on("SIGPIPE", () => {});

/**
 * Compute the FIFO path for an agent within an overstoryDir.
 *
 * @param overstoryDir - Absolute path to the project's `.overstory/` directory
 * @param agentName - Overstory agent name (same namespace as AgentSession.agentName)
 */
export function agentFifoPath(overstoryDir: string, agentName: string): string {
	return join(overstoryDir, "agents", agentName, "stdin.fifo");
}

/**
 * Create a FIFO for the agent's stdin and open it O_RDWR.
 *
 * The returned fd is intended to be passed directly to `Bun.spawn({ stdin: fd })`
 * as the child's stdin. After spawn, the caller MUST close its local fd — the
 * child inherits its own dup. Opening O_RDWR avoids the FIFO's normal blocking
 * semantics on open and ensures the agent never sees stdin EOF when no writers
 * are connected.
 *
 * The parent directory `agents/{agentName}/` is created if missing. If a stale
 * FIFO already exists at the path, it is reused — `mkfifo` would fail otherwise
 * and `unlinkSync + mkfifoSync` is racy across simultaneous spawns of the same
 * name (a higher-level invariant the orchestrator already enforces).
 *
 * @param overstoryDir - Absolute path to the project's `.overstory/` directory
 * @param agentName - Overstory agent name
 * @returns The opened RDWR file descriptor — caller MUST close after passing to spawn
 * @throws AgentError on mkfifo failure
 */
export function createAgentFifo(overstoryDir: string, agentName: string): number {
	const path = agentFifoPath(overstoryDir, agentName);
	const dir = join(overstoryDir, "agents", agentName);
	mkdirSync(dir, { recursive: true });

	if (!existsSync(path)) {
		const proc = Bun.spawnSync(["mkfifo", "-m", "0600", path]);
		if (proc.exitCode !== 0) {
			const stderr = new TextDecoder().decode(proc.stderr ?? new Uint8Array());
			throw new AgentError(`mkfifo ${path} failed: ${stderr.trim() || `exit ${proc.exitCode}`}`, {
				agentName,
			});
		}
	}

	return openSync(path, constants.O_RDWR);
}

/**
 * Result of an attempted write to an agent FIFO.
 *
 * - "delivered": bytes were written successfully
 * - "no-reader": the agent is gone (ENXIO on open, or the FIFO file is missing).
 *   Caller should treat this as a signal to clean up state for the agent.
 * - "broken-pipe": the agent died mid-write (EPIPE). Same recovery as "no-reader".
 */
export type FifoWriteResult = "delivered" | "no-reader" | "broken-pipe";

/**
 * Open the agent's stdin FIFO for writing and deliver `data` as a single write,
 * then close. Non-blocking open: if the agent is not currently reading, the
 * call returns "no-reader" rather than blocking.
 *
 * Writes ≤ PIPE_BUF (4096 on macOS/Linux) are atomic against concurrent writers
 * by POSIX. Callers wanting hard ordering for larger payloads should serialize
 * externally (advisory lock or in-process queue).
 *
 * Does NOT throw on agent-gone; returns a status code so callers can react
 * (drop the message, schedule cleanup) without try/catch noise.
 *
 * @param overstoryDir - Absolute path to the project's `.overstory/` directory
 * @param agentName - Overstory agent name
 * @param data - Bytes to write (typically a stream-json envelope ending in `\n`)
 */
export function writeToAgentFifo(
	overstoryDir: string,
	agentName: string,
	data: string | Uint8Array,
): FifoWriteResult {
	const path = agentFifoPath(overstoryDir, agentName);
	if (!existsSync(path)) return "no-reader";

	let fd: number;
	try {
		fd = openSync(path, constants.O_WRONLY | constants.O_NONBLOCK);
	} catch (err: unknown) {
		const e = err as NodeJS.ErrnoException;
		if (e.code === "ENXIO" || e.code === "ENOENT") return "no-reader";
		throw err;
	}

	try {
		const buf = typeof data === "string" ? new TextEncoder().encode(data) : data;
		writeSync(fd, buf);
		return "delivered";
	} catch (err: unknown) {
		const e = err as NodeJS.ErrnoException;
		if (e.code === "EPIPE") return "broken-pipe";
		throw err;
	} finally {
		try {
			closeSync(fd);
		} catch {
			// already closed or invalid — ignore
		}
	}
}

/**
 * Remove the agent's FIFO file. Idempotent.
 *
 * Called when the agent transitions to a terminal state, when its worktree is
 * cleaned, and from `ov clean`. Removing the FIFO does not affect a still-running
 * agent — the kernel keeps the inode alive while fds reference it; the next
 * writer's open will fail, which is the desired signal.
 *
 * @param overstoryDir - Absolute path to the project's `.overstory/` directory
 * @param agentName - Overstory agent name
 */
export function removeAgentFifo(overstoryDir: string, agentName: string): void {
	const path = agentFifoPath(overstoryDir, agentName);
	try {
		unlinkSync(path);
	} catch (err: unknown) {
		const e = err as NodeJS.ErrnoException;
		if (e.code === "ENOENT") return;
		throw err;
	}
}

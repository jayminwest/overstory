/**
 * RuntimeConnection implementation for headless Claude Code subprocesses.
 *
 * Wraps a spawned process handle to provide the RuntimeConnection contract:
 * - sendPrompt / followUp → write to process stdin
 * - getState → poll process liveness via kill(pid, 0)
 * - abort → SIGTERM with SIGKILL escalation after timeout
 *
 * Created by registerHeadlessConnection() in connections.ts when a headless
 * agent is spawned via spawnHeadlessAgent() with an agentName.
 */

import type { ConnectionState, RuntimeConnection } from "./types.ts";

/**
 * RuntimeConnection backed by a headless Claude Code subprocess.
 *
 * Communicates via stdin/stdout using Claude Code's stream-json format.
 * Process liveness is determined by kill(pid, 0) — no tmux required.
 */
export class HeadlessClaudeConnection implements RuntimeConnection {
	readonly #pid: number;
	readonly #stdin: { write(data: string | Uint8Array): number | Promise<number> };
	readonly #sigkillDelayMs: number;

	constructor(
		pid: number,
		stdin: { write(data: string | Uint8Array): number | Promise<number> },
		opts?: { sigkillDelayMs?: number },
	) {
		this.#pid = pid;
		this.#stdin = stdin;
		this.#sigkillDelayMs = opts?.sigkillDelayMs ?? 2000;
	}

	/** OS-level process ID of the underlying subprocess. */
	get pid(): number {
		return this.#pid;
	}

	/**
	 * Send initial prompt to the agent via stdin.
	 * Claude Code headless reads the first stdin line as the prompt.
	 */
	async sendPrompt(text: string): Promise<void> {
		await this.#stdin.write(text);
	}

	/**
	 * Send follow-up message to the agent via stdin.
	 * Replaces tmux send-keys for headless runtimes.
	 */
	async followUp(text: string): Promise<void> {
		await this.#stdin.write(text);
	}

	/**
	 * Terminate the agent process.
	 *
	 * Sends SIGTERM first, then polls every 50ms. If the process has not exited
	 * within sigkillDelayMs (default 2000ms), escalates to SIGKILL.
	 */
	async abort(): Promise<void> {
		try {
			process.kill(this.#pid, "SIGTERM");
		} catch {
			return; // process already exited
		}

		const deadline = Date.now() + this.#sigkillDelayMs;
		while (Date.now() < deadline) {
			await Bun.sleep(50);
			try {
				process.kill(this.#pid, 0);
			} catch {
				return; // exited cleanly after SIGTERM
			}
		}

		try {
			process.kill(this.#pid, "SIGKILL");
		} catch {
			// already exited between last poll and SIGKILL
		}
	}

	/**
	 * Query process state by polling PID liveness.
	 *
	 * Returns { status: "working" } when the process is alive,
	 * { status: "error" } when the PID is no longer running.
	 * Headless processes are either actively working or dead — no idle state.
	 */
	async getState(): Promise<ConnectionState> {
		try {
			process.kill(this.#pid, 0);
			return { status: "working" };
		} catch {
			return { status: "error" };
		}
	}

	/**
	 * Release connection resources.
	 * No-op — the subprocess handle is not retained by this object.
	 * Call abort() first if process termination is needed.
	 */
	close(): void {
		// Nothing to release.
	}
}

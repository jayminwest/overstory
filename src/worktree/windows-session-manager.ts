/**
 * WindowsSessionManager — Windows backend for SessionManager.
 *
 * Uses Bun.spawn with stdin/stdout pipes + an in-memory session registry.
 * Provides equivalent functionality to tmux on Unix for agent lifecycle
 * management, input sending, and output capture.
 *
 * Session registry is persisted to `.overstory/windows-sessions.json` to
 * survive `ov` process restarts. On startup, stale entries (dead PIDs) are
 * pruned automatically.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentError } from "../errors.ts";
import type { ReadyState } from "../runtimes/types.ts";
import { detectOverstoryBinDir, isProcessAlive, killProcessTree } from "./process-utils.ts";
import { drainStreamIntoBuffer, RingBuffer } from "./ring-buffer.ts";
import type { SessionManager, SessionState } from "./session-manager.ts";

/** In-memory state for a Windows agent session. */
interface WindowsSession {
	name: string;
	pid: number;
	proc: {
		stdin: { write(data: string | Uint8Array): number | Promise<number> };
		exited: Promise<number>;
	};
	outputBuffer: RingBuffer;
	/** Promise that resolves when the stdout drain completes. */
	drainPromise: Promise<void>;
}

/** Serialized session entry for disk persistence. */
interface PersistedSession {
	name: string;
	pid: number;
}

/**
 * SessionManager implementation for Windows.
 *
 * Each agent runs as a direct Bun.spawn child process with piped stdin/stdout.
 * Output is continuously drained into a RingBuffer for capture-pane equivalence.
 *
 * Key differences from tmux:
 * - No tmux server — sessions are tracked in an in-memory Map
 * - stdin.write() replaces tmux send-keys
 * - RingBuffer replaces tmux capture-pane
 * - taskkill /F /T replaces tmux kill-session + process tree walk
 * - Registry persisted to disk for cross-invocation discovery
 */
export class WindowsSessionManager implements SessionManager {
	private sessions = new Map<string, WindowsSession>();
	private registryPath: string | null = null;

	/**
	 * Set the path for the persistent session registry.
	 * Called during init or lazily resolved from .overstory/ location.
	 */
	private getRegistryPath(): string | null {
		if (this.registryPath) return this.registryPath;

		// Try to find .overstory/ from cwd
		const overstoryDir = join(process.cwd(), ".overstory");
		if (existsSync(overstoryDir)) {
			this.registryPath = join(overstoryDir, "windows-sessions.json");
			return this.registryPath;
		}
		return null;
	}

	/** Persist session registry to disk. */
	private persistRegistry(): void {
		const path = this.getRegistryPath();
		if (!path) return;

		const entries: PersistedSession[] = [];
		for (const session of this.sessions.values()) {
			entries.push({ name: session.name, pid: session.pid });
		}

		try {
			writeFileSync(path, JSON.stringify(entries, null, "\t"));
		} catch {
			// Best effort — disk write failure is not fatal
		}
	}

	/** Load persisted sessions and prune dead PIDs. */
	private loadRegistry(): void {
		const path = this.getRegistryPath();
		if (!path || !existsSync(path)) return;

		try {
			const content = readFileSync(path, "utf-8");
			const entries = JSON.parse(content) as PersistedSession[];

			for (const entry of entries) {
				// Only track sessions that are still alive and not already in memory
				if (isProcessAlive(entry.pid) && !this.sessions.has(entry.name)) {
					// We can't reconstruct the full WindowsSession (no proc handle),
					// but we can track it for liveness checks and kill operations.
					// Create a stub session for discovery purposes.
					this.sessions.set(entry.name, {
						name: entry.name,
						pid: entry.pid,
						proc: {
							stdin: {
								write: () => {
									throw new AgentError(
										`Cannot send input to restored session "${entry.name}" — process handle was lost on restart`,
										{ agentName: entry.name },
									);
								},
							},
							exited: Promise.resolve(0),
						},
						outputBuffer: new RingBuffer(1),
						drainPromise: Promise.resolve(),
					});
				}
			}
		} catch {
			// Malformed registry — start fresh
		}

		// Prune dead entries and re-persist
		this.persistRegistry();
	}

	async createSession(
		name: string,
		cwd: string,
		command: string,
		env?: Record<string, string>,
	): Promise<number> {
		// Load persisted sessions on first createSession call
		this.loadRegistry();

		if (this.sessions.has(name)) {
			throw new AgentError(`Session "${name}" already exists`, { agentName: name });
		}

		// Build environment: start with current process.env, add ov binary dir,
		// clear Claude Code nesting guards, then add user-provided env vars
		const sessionEnv: Record<string, string> = { ...process.env } as Record<string, string>;

		// Ensure PATH includes overstory binary directory
		const ovBinDir = await detectOverstoryBinDir();
		if (ovBinDir && sessionEnv.PATH) {
			sessionEnv.PATH = `${ovBinDir};${sessionEnv.PATH}`;
		}

		// Clear Claude Code nesting guards
		delete sessionEnv.CLAUDECODE;
		delete sessionEnv.CLAUDE_CODE_SSE_PORT;
		delete sessionEnv.CLAUDE_CODE_ENTRYPOINT;

		// Add user-provided env vars
		if (env) {
			for (const [key, value] of Object.entries(env)) {
				sessionEnv[key] = value;
			}
		}

		// On Windows, spawn via shell to handle complex command strings
		// (e.g., "claude --resume ...")
		const proc = Bun.spawn(["cmd", "/c", command], {
			cwd,
			env: sessionEnv,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});

		const outputBuffer = new RingBuffer(2000);

		// Start draining stdout into the ring buffer
		const drainPromise = proc.stdout
			? drainStreamIntoBuffer(proc.stdout as ReadableStream<Uint8Array>, outputBuffer)
			: Promise.resolve();

		// Also drain stderr into the same buffer (interleaved, like a terminal)
		if (proc.stderr) {
			drainStreamIntoBuffer(proc.stderr as ReadableStream<Uint8Array>, outputBuffer).catch(
				() => {},
			);
		}

		const session: WindowsSession = {
			name,
			pid: proc.pid,
			proc: {
				stdin: proc.stdin,
				exited: proc.exited,
			},
			outputBuffer,
			drainPromise,
		};

		this.sessions.set(name, session);
		this.persistRegistry();

		return proc.pid;
	}

	async sendKeys(name: string, keys: string): Promise<void> {
		const session = this.sessions.get(name);
		if (!session) {
			throw new AgentError(`Session "${name}" does not exist`, { agentName: name });
		}

		if (!isProcessAlive(session.pid)) {
			throw new AgentError(`Session "${name}" process is no longer alive (PID ${session.pid})`, {
				agentName: name,
			});
		}

		// Flatten newlines to spaces (matching tmux behavior)
		const flatKeys = keys.replace(/\n/g, " ");
		const input = `${flatKeys}\n`;

		try {
			await session.proc.stdin.write(new TextEncoder().encode(input));
		} catch (err) {
			throw new AgentError(
				`Failed to send input to session "${name}": ${err instanceof Error ? err.message : String(err)}`,
				{ agentName: name },
			);
		}
	}

	async capturePaneContent(name: string, lines = 50): Promise<string | null> {
		const session = this.sessions.get(name);
		if (!session) return null;

		const captured = session.outputBuffer.getLines(lines);
		if (captured.length === 0) return null;

		const content = captured.join("\n").trim();
		return content.length > 0 ? content : null;
	}

	async isSessionAlive(name: string): Promise<boolean> {
		this.loadRegistry();
		const session = this.sessions.get(name);
		if (!session) return false;
		return isProcessAlive(session.pid);
	}

	async checkSessionState(name: string): Promise<SessionState> {
		this.loadRegistry();
		const session = this.sessions.get(name);
		if (!session) return "dead";
		return isProcessAlive(session.pid) ? "alive" : "dead";
		// Windows has no "no_server" state — there's no separate session server
	}

	async killSession(name: string): Promise<void> {
		this.loadRegistry();
		const session = this.sessions.get(name);
		if (!session) return;

		await killProcessTree(session.pid);

		this.sessions.delete(name);
		this.persistRegistry();
	}

	async listSessions(): Promise<Array<{ name: string; pid: number }>> {
		this.loadRegistry();
		const result: Array<{ name: string; pid: number }> = [];

		for (const session of this.sessions.values()) {
			if (isProcessAlive(session.pid)) {
				result.push({ name: session.name, pid: session.pid });
			}
		}

		return result;
	}

	async getPanePid(name: string): Promise<number | null> {
		const session = this.sessions.get(name);
		if (!session) return null;
		return isProcessAlive(session.pid) ? session.pid : null;
	}

	async waitForTuiReady(
		name: string,
		detectReady: (content: string) => ReadyState,
		timeoutMs = 30_000,
		pollIntervalMs = 500,
	): Promise<boolean> {
		const maxAttempts = Math.ceil(timeoutMs / pollIntervalMs);
		let dialogHandled = false;

		for (let i = 0; i < maxAttempts; i++) {
			const content = await this.capturePaneContent(name);
			if (content !== null) {
				const state = detectReady(content);

				if (state.phase === "dialog" && !dialogHandled) {
					await this.sendKeys(name, "");
					dialogHandled = true;
					await Bun.sleep(pollIntervalMs);
					continue;
				}

				if (state.phase === "ready") {
					return true;
				}
			}

			const alive = await this.isSessionAlive(name);
			if (!alive) return false;

			await Bun.sleep(pollIntervalMs);
		}
		return false;
	}

	async getCurrentSessionName(): Promise<string | null> {
		// On Windows, there's no tmux-like session context.
		// Check if OVERSTORY_AGENT_NAME is set (indicating we're inside an agent session).
		return process.env.OVERSTORY_AGENT_NAME ?? null;
	}

	async ensureAvailable(): Promise<void> {
		// Windows backend has no external prerequisites — Bun.spawn is always available
	}
}

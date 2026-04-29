/**
 * Module-level connection registry for active RuntimeConnection instances.
 *
 * Tracks RPC connections to headless agent processes (e.g., Sapling, headless Claude).
 * Keyed by agent name — same namespace as AgentSession.agentName.
 *
 * Thread safety: single-threaded Bun runtime; no locking needed.
 */

import { HeadlessClaudeConnection } from "./headless-connection.ts";
import type { RuntimeConnection } from "./types.ts";

const connections = new Map<string, RuntimeConnection>();

/** Retrieve the active connection for a given agent, or undefined if none. */
export function getConnection(agentName: string): RuntimeConnection | undefined {
	return connections.get(agentName);
}

/** Register a connection for a given agent. Overwrites any existing entry. */
export function setConnection(agentName: string, conn: RuntimeConnection): void {
	connections.set(agentName, conn);
}

/**
 * Remove the connection for a given agent, calling close() first.
 * Safe to call if no connection exists (no-op).
 */
export function removeConnection(agentName: string): void {
	const conn = connections.get(agentName);
	if (conn) {
		conn.close();
		connections.delete(agentName);
	}
}

/**
 * Create a HeadlessClaudeConnection from a spawned process handle and register it.
 *
 * Called by spawnHeadlessAgent() (process.ts) when an agentName is provided.
 * The registered connection is retrievable via getConnection(agentName) for
 * follow-up delivery, state polling, and abort — all without tmux.
 *
 * This is the sibling registration path to Sapling's connect() flow. It does NOT
 * generalize RpcProcessHandle and does NOT touch other runtime adapters.
 *
 * @param agentName - Unique agent identifier (same namespace as AgentSession.agentName)
 * @param proc - Spawned headless process with pid and stdin
 * @returns The newly created and registered RuntimeConnection
 */
export function registerHeadlessConnection(
	agentName: string,
	proc: { pid: number; stdin: { write(data: string | Uint8Array): number | Promise<number> } },
): RuntimeConnection {
	const conn = new HeadlessClaudeConnection(proc.pid, proc.stdin);
	setConnection(agentName, conn);
	return conn;
}

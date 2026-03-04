/**
 * Environment guard — first check in the overstory guard chain.
 *
 * Replaces the POSIX shell guard: `[ -z "$OVERSTORY_AGENT_NAME" ] && exit 0;`
 *
 * If OVERSTORY_AGENT_NAME is not set, this is not an overstory agent session
 * and the entire guard chain should be skipped (exit 0). When the env var IS
 * set, this guard also exits 0 — it is a pass-through prefix check that gates
 * whether downstream guards should run.
 *
 * Cross-platform TypeScript replacement for the POSIX shell one-liner.
 * Runs under Bun.
 */

const agentName = process.env.OVERSTORY_AGENT_NAME;

if (!agentName) {
	process.exit(0);
}

// Agent name is set — this is an overstory agent session.
// Exit 0 to allow the guard chain to continue.
process.exit(0);

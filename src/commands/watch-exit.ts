/**
 * CLI command: ov __watch-exit --pid <n> --agent <name> [--poll-ms <n>]
 *
 * Detached subprocess spawned by `ov sling` after a headless agent starts.
 * Polls the agent's PID; when the agent dies, finalizes its session in
 * SessionStore and exits.
 *
 * Plugs the gap from overstory-e24b: headless mode deploys only PreToolUse
 * security guards, so the per-turn `ov log session-end` Stop hook never
 * fires, leaving SessionStore stuck at 'working' indefinitely after a
 * headless agent exits cleanly (overstory-267e).
 *
 * The command is hidden from `ov --help`. It is not intended for direct
 * operator use; the underscored name signals "internal".
 */

import { join } from "node:path";
import { Command } from "commander";
import { finalizeHeadlessSession } from "../agents/headless-finalize.ts";
import { loadConfig } from "../config.ts";
import { ValidationError } from "../errors.ts";
import { jsonOutput } from "../json.ts";

const DEFAULT_POLL_MS = 2000;
const MIN_POLL_MS = 100;

export interface WatchExitOptions {
	pid: number;
	agent: string;
	pollMs?: number;
	json?: boolean;
}

/**
 * Check whether a process is still alive without affecting it.
 * Signal 0 only checks for existence + permission to signal.
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
 * Poll a PID until the process is gone, then finalize the agent's session.
 *
 * Exported for testing — production callers go through the CLI subcommand.
 */
export async function runWatchExit(opts: WatchExitOptions): Promise<void> {
	const cwd = process.cwd();
	const config = await loadConfig(cwd);
	const overstoryDir = join(config.project.root, ".overstory");
	const pollMs = Math.max(opts.pollMs ?? DEFAULT_POLL_MS, MIN_POLL_MS);

	while (isProcessAlive(opts.pid)) {
		await Bun.sleep(pollMs);
	}

	await finalizeHeadlessSession(overstoryDir, opts.agent);

	if (opts.json ?? false) {
		jsonOutput("__watch-exit", {
			agentName: opts.agent,
			pid: opts.pid,
			finalized: true,
		});
	}
}

export function createWatchExitCommand(): Command {
	return new Command("__watch-exit")
		.description("(internal) Watch a headless agent PID and finalize on exit")
		.option("--pid <n>", "PID to watch")
		.option("--agent <name>", "Agent name")
		.option("--poll-ms <n>", "Poll interval in ms")
		.option("--json", "JSON output")
		.action(async (opts: { pid?: string; agent?: string; pollMs?: string; json?: boolean }) => {
			const pidNum = opts.pid ? Number.parseInt(opts.pid, 10) : Number.NaN;
			if (Number.isNaN(pidNum) || pidNum <= 0) {
				throw new ValidationError("--pid is required and must be a positive integer", {
					field: "pid",
					value: opts.pid ?? "",
				});
			}
			if (!opts.agent || opts.agent.trim().length === 0) {
				throw new ValidationError("--agent is required", { field: "agent" });
			}
			const pollMsNum = opts.pollMs ? Number.parseInt(opts.pollMs, 10) : undefined;
			await runWatchExit({
				pid: pidNum,
				agent: opts.agent,
				...(pollMsNum !== undefined && !Number.isNaN(pollMsNum) ? { pollMs: pollMsNum } : {}),
				...(opts.json !== undefined ? { json: opts.json } : {}),
			});
		})
		.helpOption(false);
}

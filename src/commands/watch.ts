/**
 * CLI command: overstory watch [--interval <ms>] [--background]
 *
 * Starts the Tier 0 mechanical watchdog daemon. Foreground mode shows real-time status.
 * Background mode spawns a detached process via Bun.spawn and writes a PID file.
 * Interval configurable, default 30000ms.
 */

import { join } from "node:path";
import { Command } from "commander";
import { loadConfig } from "../config.ts";
import { jsonOutput } from "../json.ts";
import { printError, printHint, printSuccess } from "../logging/color.ts";
import type { HealthCheck } from "../types.ts";
import { resolveOverstoryBin } from "../utils/bin.ts";
import {
	type AcquirePidLockResult,
	acquirePidLock,
	readPidFile,
	removePidFile,
} from "../utils/pid.ts";
import { findRunningWatchdogProcesses, type WatchdogProcess } from "../utils/process-scan.ts";
import { startDaemon } from "../watchdog/daemon.ts";
import { isProcessRunning } from "../watchdog/health.ts";

/**
 * Format a health check for display.
 * @internal Exported for testing.
 */
export function formatCheck(check: HealthCheck): string {
	const actionIcon =
		check.action === "terminate"
			? "x"
			: check.action === "escalate"
				? "!"
				: check.action === "investigate"
					? ">"
					: "x";
	const pidLabel = check.pidAlive === null ? "n/a" : check.pidAlive ? "up" : "down";
	let line = `${actionIcon} ${check.agentName}: ${check.state} (tmux=${check.tmuxAlive ? "up" : "down"}, pid=${pidLabel})`;
	if (check.reconciliationNote) {
		line += ` [${check.reconciliationNote}]`;
	}
	return line;
}

/**
 * Format a "lock contested" error consistently across foreground/background.
 */
function formatLockContestedError(existingPid: number, pidFilePath: string): string {
	if (existingPid <= 0) {
		return `Watchdog PID file at ${pidFilePath} is owned by another process (could not read PID). Run 'ov watch --kill-others' or remove the file.`;
	}
	return `Watchdog already running (PID: ${existingPid}). Kill it first, run 'ov watch --kill-others', or remove ${pidFilePath}`;
}

/**
 * Kill running `ov watch` daemons that are NOT the given excludedPid.
 * Returns the list of PIDs killed (after a SIGTERM was issued — not waited).
 */
async function killForeignWatchdogs(
	excludedPid: number | null,
): Promise<{ killed: number[]; surveyed: WatchdogProcess[] }> {
	const surveyed = await findRunningWatchdogProcesses();
	const killed: number[] = [];
	for (const proc of surveyed) {
		if (excludedPid !== null && proc.pid === excludedPid) {
			continue;
		}
		try {
			process.kill(proc.pid, "SIGTERM");
			killed.push(proc.pid);
		} catch {
			// Process already gone — not an error.
		}
	}
	return { killed, surveyed };
}

/**
 * Core implementation for the watch command.
 */
async function runWatch(opts: {
	interval?: string;
	background?: boolean;
	json?: boolean;
	killOthers?: boolean;
}): Promise<void> {
	const cwd = process.cwd();
	const config = await loadConfig(cwd);

	const intervalMs = opts.interval
		? Number.parseInt(opts.interval, 10)
		: config.watchdog.tier0IntervalMs;

	const staleThresholdMs = config.watchdog.staleThresholdMs;
	const zombieThresholdMs = config.watchdog.zombieThresholdMs;
	const pidFilePath = join(config.project.root, ".overstory", "watchdog.pid");

	const useJson = opts.json ?? false;

	// --kill-others: kill any pre-existing `ov watch` daemons before claiming
	// the lock. Useful when an earlier release allowed multi-daemon state.
	if (opts.killOthers) {
		const { killed } = await killForeignWatchdogs(null);

		// Wait for the just-killed processes to actually exit before reclaiming
		// the PID file. Without this, the next acquirePidLock call sees a still-
		// alive PID in the file and refuses, even though we issued SIGTERM
		// nanoseconds earlier. Poll for up to ~2s.
		const killedSet = new Set(killed);
		if (killedSet.size > 0) {
			const deadline = Date.now() + 2000;
			while (Date.now() < deadline) {
				const stillAlive = killed.filter((p) => isProcessRunning(p));
				if (stillAlive.length === 0) break;
				await Bun.sleep(50);
			}
		}

		// Reclaim the PID file if it pointed at a process we just killed (it is
		// either already dead or in flight to dead) or at any other dead PID.
		const existingPid = await readPidFile(pidFilePath);
		if (existingPid !== null) {
			if (killedSet.has(existingPid) || !isProcessRunning(existingPid)) {
				await removePidFile(pidFilePath);
			}
		}

		if (killed.length > 0) {
			if (useJson) {
				jsonOutput("watch", { killed });
			} else {
				printSuccess(`Killed ${killed.length} foreign watchdog process(es): ${killed.join(", ")}`);
			}
		} else if (!useJson) {
			printHint("No foreign watchdog processes found.");
		}
	}

	if (opts.background) {
		// Build the args for the child process, forwarding --interval but not --background
		const childArgs: string[] = ["watch"];
		if (opts.interval) {
			childArgs.push("--interval", opts.interval);
		}

		// Resolve the overstory binary path
		const overstoryBin = await resolveOverstoryBin();

		// Pre-check: surface "already running" before paying the cost of a spawn.
		// This is only for friendly errors — the authoritative exclusion happens
		// in the atomic acquirePidLock call below.
		const existingPid = await readPidFile(pidFilePath);
		if (existingPid !== null && isProcessRunning(existingPid)) {
			if (useJson) {
				jsonOutput("watch", { running: true, pid: existingPid, error: "Watchdog already running" });
			} else {
				printError(formatLockContestedError(existingPid, pidFilePath));
			}
			process.exitCode = 1;
			return;
		}

		// Spawn the detached background daemon (foreground mode in the child).
		const child = Bun.spawn(["bun", "run", overstoryBin, ...childArgs], {
			cwd,
			stdout: "ignore",
			stderr: "ignore",
			stdin: "ignore",
		});

		const childPid = child.pid;

		// Atomically acquire the lock with the child's PID. If another writer
		// raced in between our pre-check and the spawn, we have to kill our
		// child and report contention.
		const lockResult = await acquirePidLock(pidFilePath, childPid, isProcessRunning);
		if (!lockResult.acquired) {
			try {
				child.kill("SIGTERM");
			} catch {
				// Already exited — not an error.
			}
			if (useJson) {
				jsonOutput("watch", {
					running: true,
					pid: lockResult.existingPid,
					error: "Watchdog already running",
				});
			} else {
				printError(formatLockContestedError(lockResult.existingPid, pidFilePath));
			}
			process.exitCode = 1;
			return;
		}

		// Lock is ours. Detach so this parent invocation can exit independently.
		child.unref();

		if (useJson) {
			jsonOutput("watch", { pid: childPid, intervalMs, pidFile: pidFilePath });
		} else {
			printSuccess("Watchdog started in background", `PID: ${childPid}, interval: ${intervalMs}ms`);
			printHint(`PID file: ${pidFilePath}`);
		}
		return;
	}

	// Foreground mode: acquire the lock atomically before announcing anything.
	// In the background-spawn case the parent has already written this PID into
	// the lock file; acquirePidLock detects own-PID and returns acquired=true
	// idempotently.
	const lockResult: AcquirePidLockResult = await acquirePidLock(
		pidFilePath,
		process.pid,
		isProcessRunning,
	);
	if (!lockResult.acquired) {
		if (useJson) {
			jsonOutput("watch", {
				running: true,
				pid: lockResult.existingPid,
				error: "Watchdog already running",
			});
		} else {
			printError(formatLockContestedError(lockResult.existingPid, pidFilePath));
		}
		process.exitCode = 1;
		return;
	}

	if (useJson) {
		jsonOutput("watch", { pid: process.pid, intervalMs, mode: "foreground" });
	} else {
		printSuccess("Watchdog running", `interval: ${intervalMs}ms`);
		printHint("Press Ctrl+C to stop.");
	}

	const { stop } = startDaemon({
		root: config.project.root,
		intervalMs,
		staleThresholdMs,
		zombieThresholdMs,
		nudgeIntervalMs: config.watchdog.nudgeIntervalMs,
		tier1Enabled: config.watchdog.tier1Enabled,
		notifyParentOnDeath: config.watchdog.notifyParentOnDeath ?? true,
		onHealthCheck(check) {
			const timestamp = new Date().toISOString().slice(11, 19);
			process.stdout.write(`[${timestamp}] ${formatCheck(check)}\n`);
		},
	});

	// Keep running until interrupted
	await new Promise<void>((resolve) => {
		process.on("SIGINT", () => {
			stop();
			// Clean up PID file on graceful shutdown
			removePidFile(pidFilePath).finally(() => {
				printSuccess("Watchdog stopped.");
				process.exitCode = 0;
				resolve();
			});
		});
	});
}

export function createWatchCommand(): Command {
	return new Command("watch")
		.description("Start Tier 0 mechanical watchdog daemon")
		.option("--interval <ms>", "Health check interval in milliseconds")
		.option("--background", "Daemonize (run in background)")
		.option(
			"--kill-others",
			"Kill any pre-existing 'ov watch' processes before starting (for cleanup of multi-daemon state)",
		)
		.option("--json", "Output as JSON")
		.action(
			async (opts: {
				interval?: string;
				background?: boolean;
				killOthers?: boolean;
				json?: boolean;
			}) => {
				await runWatch(opts);
			},
		);
}

/**
 * Entry point for `overstory watch [--interval <ms>] [--background]`.
 */
export async function watchCommand(args: string[]): Promise<void> {
	const cmd = createWatchCommand();
	cmd.exitOverride();

	try {
		await cmd.parseAsync(args, { from: "user" });
	} catch (err: unknown) {
		if (err && typeof err === "object" && "code" in err) {
			const code = (err as { code: string }).code;
			if (code === "commander.helpDisplayed" || code === "commander.version") {
				return;
			}
		}
		throw err;
	}
}

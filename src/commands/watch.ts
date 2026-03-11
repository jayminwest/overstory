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
import { OverstoryError } from "../errors.ts";
import { jsonOutput } from "../json.ts";
import { printError, printHint, printSuccess } from "../logging/color.ts";
import type { HealthCheck } from "../types.ts";
import { startDaemon } from "../watchdog/daemon.ts";
import { isProcessRunning } from "../watchdog/health.ts";

/**
 * Format a health check for display.
 */
function formatCheck(check: HealthCheck): string {
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

// isProcessRunning is imported from ../watchdog/health.ts (ZFC shared utility)

/**
 * Read the PID from the watchdog PID file.
 * Returns null if the file doesn't exist or can't be parsed.
 */
async function readPidFile(pidFilePath: string): Promise<number | null> {
	const file = Bun.file(pidFilePath);
	const exists = await file.exists();
	if (!exists) {
		return null;
	}

	try {
		const text = await file.text();
		const pid = Number.parseInt(text.trim(), 10);
		if (Number.isNaN(pid) || pid <= 0) {
			return null;
		}
		return pid;
	} catch {
		return null;
	}
}

/**
 * Write a PID to the watchdog PID file.
 */
async function writePidFile(pidFilePath: string, pid: number): Promise<void> {
	await Bun.write(pidFilePath, `${pid}\n`);
}

/**
 * Remove the watchdog PID file.
 */
async function removePidFile(pidFilePath: string): Promise<void> {
	const { unlink } = await import("node:fs/promises");
	try {
		await unlink(pidFilePath);
	} catch {
		// File may already be gone — not an error
	}
}

/**
 * Resolve the path to the overstory binary for re-launching.
 * Uses `which overstory` first, then falls back to process.argv.
 */
async function resolveOverstoryBin(): Promise<string> {
	try {
		const proc = Bun.spawn(["which", "ov"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const exitCode = await proc.exited;
		if (exitCode === 0) {
			const binPath = (await new Response(proc.stdout).text()).trim();
			if (binPath.length > 0) {
				return binPath;
			}
		}
	} catch {
		// which not available or overstory not on PATH
	}

	// Fallback: use the script that's currently running (process.argv[1])
	const scriptPath = process.argv[1];
	if (scriptPath) {
		return scriptPath;
	}

	throw new OverstoryError(
		"Cannot resolve overstory binary path for background launch",
		"WATCH_ERROR",
	);
}

/**
 * Core implementation for the watch command.
 */
async function runWatch(opts: {
	interval?: string;
	background?: boolean;
	json?: boolean;
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

	if (opts.background) {
		// Check if a watchdog is already running
		const existingPid = await readPidFile(pidFilePath);
		if (existingPid !== null && isProcessRunning(existingPid)) {
			if (useJson) {
				jsonOutput("watch", { running: true, pid: existingPid, error: "Watchdog already running" });
			} else {
				printError(
					`Watchdog already running (PID: ${existingPid}). Kill it first or remove ${pidFilePath}`,
				);
			}
			process.exitCode = 1;
			return;
		}

		// Clean up stale PID file if process is no longer running
		if (existingPid !== null) {
			await removePidFile(pidFilePath);
		}

		// Build the args for the child process, forwarding --interval but not --background
		const childArgs: string[] = ["watch"];
		if (opts.interval) {
			childArgs.push("--interval", opts.interval);
		}

		// Resolve the overstory binary path
		const overstoryBin = await resolveOverstoryBin();

		// Spawn a detached background process running `overstory watch` (without --background)
		const child = Bun.spawn(["bun", "run", overstoryBin, ...childArgs], {
			cwd,
			stdout: "ignore",
			stderr: "ignore",
			stdin: "ignore",
		});

		// Unref the child so the parent can exit without waiting for it
		child.unref();

		const childPid = child.pid;

		// Write PID file for later cleanup
		await writePidFile(pidFilePath, childPid);

		if (useJson) {
			jsonOutput("watch", { pid: childPid, intervalMs, pidFile: pidFilePath });
		} else {
			printSuccess("Watchdog started in background", `PID: ${childPid}, interval: ${intervalMs}ms`);
			printHint(`PID file: ${pidFilePath}`);
		}
		return;
	}

	// Foreground mode: show real-time health checks
	if (useJson) {
		jsonOutput("watch", { pid: process.pid, intervalMs, mode: "foreground" });
	} else {
		printSuccess("Watchdog running", `interval: ${intervalMs}ms`);
		printHint("Press Ctrl+C to stop.");
	}

	// Write PID file so `--background` check and external tools can find us
	await writePidFile(pidFilePath, process.pid);

	const { stop } = startDaemon({
		root: config.project.root,
		intervalMs,
		staleThresholdMs,
		zombieThresholdMs,
		nudgeIntervalMs: config.watchdog.nudgeIntervalMs,
		tier1Enabled: config.watchdog.tier1Enabled,
		config,
		onHealthCheck(check) {
			const timestamp = new Date().toISOString().slice(11, 19);
			process.stdout.write(`[${timestamp}] ${formatCheck(check)}\n`);
		},
	});

	// Keep running until interrupted
	process.on("SIGINT", () => {
		stop();
		// Clean up PID file on graceful shutdown
		removePidFile(pidFilePath).finally(() => {
			printSuccess("Watchdog stopped.");
			process.exit(0);
		});
	});

	// Block forever
	await new Promise(() => {});
}

export function createWatchCommand(): Command {
	return new Command("watch")
		.description("Start Tier 0 mechanical watchdog daemon")
		.option("--interval <ms>", "Health check interval in milliseconds")
		.option("--background", "Daemonize (run in background)")
		.option("--json", "Output as JSON")
		.action(async (opts: { interval?: string; background?: boolean; json?: boolean }) => {
			await runWatch(opts);
		});
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

/**
 * Process-table scanning helpers.
 *
 * Used to detect runaway daemon processes that are not tracked by a PID file —
 * for example, the multi-`ov watch` situation observed on 2026-04-30 where
 * three concurrent watchdogs were running because earlier releases had no
 * PID-file exclusion lock.
 *
 * Implementation note: `ps` is used directly because we only need to find
 * processes by command-line substring, and Bun has no built-in process-table
 * API. The `ps -o pid=,command=` form is portable across macOS (BSD) and
 * Linux (procps) for the columns we read.
 */

export interface WatchdogProcess {
	pid: number;
	/** The full command line as reported by `ps`. */
	command: string;
}

/**
 * Find running processes that look like an `ov watch` daemon.
 *
 * Matches on the command-line substring `ov watch` (the daemon spawn form)
 * and excludes the current process so callers do not accidentally treat
 * themselves as a foreign daemon.
 *
 * Returns an empty list if `ps` is unavailable or fails — callers must not
 * rely on this for correctness, only for diagnostics and `--kill-others`.
 */
export async function findRunningWatchdogProcesses(): Promise<WatchdogProcess[]> {
	const proc = Bun.spawn(["ps", "-A", "-o", "pid=,command="], {
		stdout: "pipe",
		stderr: "ignore",
	});
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		return [];
	}
	const text = await new Response(proc.stdout).text();
	const ownPid = process.pid;
	const out: WatchdogProcess[] = [];

	for (const rawLine of text.split("\n")) {
		const line = rawLine.trim();
		if (line === "") continue;

		// `ps -o pid=,command=` outputs: `   1234 /path/to/binary args...`
		// (leading whitespace is allowed, then PID, then a single space, then
		// the rest of the command).
		const match = line.match(/^(\d+)\s+(.+)$/);
		if (!match) continue;
		const pidStr = match[1];
		const command = match[2];
		if (pidStr === undefined || command === undefined) continue;
		const pid = Number.parseInt(pidStr, 10);
		if (!Number.isFinite(pid) || pid <= 0) continue;
		if (pid === ownPid) continue;

		// Match the spawn form: `bun run /path/to/ov watch`. We also tolerate
		// direct invocation `overstory watch` and `ov watch`.
		if (!isWatchdogCommand(command)) continue;

		out.push({ pid, command });
	}

	return out;
}

function isWatchdogCommand(command: string): boolean {
	// Anchor on a `watch` token preceded by an `ov` or `overstory` token.
	// Avoids false positives like "watch ov.log" or unrelated `watch` commands.
	if (!/\bwatch\b/.test(command)) return false;
	if (/\b(ov|overstory)\b[^\n]*\bwatch\b/.test(command)) return true;
	return false;
}

/**
 * Binary resolution utilities.
 */
import { OverstoryError } from "../errors.ts";

/**
 * Resolve the path to the overstory binary for re-launching.
 * Uses `which ov` first, then falls back to process.argv.
 */
export async function resolveOverstoryBin(): Promise<string> {
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

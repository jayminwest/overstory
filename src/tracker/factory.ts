/**
 * Tracker factory — creates the right backend client based on configuration.
 */

import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { TaskTrackerBackend } from "../types.ts";
import { createBeadsTracker } from "./beads.ts";
import { createBeadsRustTracker } from "./beads-rust.ts";
import { createSeedsTracker } from "./seeds.ts";
import type { TrackerBackend, TrackerClient } from "./types.ts";

/**
 * Create a tracker client for the specified backend.
 *
 * @param backend - Which backend to use ("beads" or "seeds")
 * @param cwd - Working directory for CLI commands
 */
export function createTrackerClient(backend: TrackerBackend, cwd: string): TrackerClient {
	switch (backend) {
		case "beads":
			return createBeadsTracker(cwd);
		case "beads_rust":
			return createBeadsRustTracker(cwd);
		case "seeds":
			return createSeedsTracker(cwd);
		default: {
			const _exhaustive: never = backend;
			throw new Error(`Unknown tracker backend: ${_exhaustive}`);
		}
	}
}

/**
 * Resolve "auto" to a concrete backend by probing the filesystem.
 * Explicit "beads" or "seeds" values pass through unchanged.
 */
export async function resolveBackend(
	configBackend: TaskTrackerBackend,
	cwd: string,
): Promise<TrackerBackend> {
	if (configBackend === "beads") return "beads";
	if (configBackend === "beads_rust") return "beads_rust";
	if (configBackend === "seeds") return "seeds";
	// "auto" detection: check for .beads/ first (never auto-scaffolded by ov init,
	// so its presence signals explicit user setup), then .seeds/.
	const dirExists = async (path: string): Promise<boolean> => {
		try {
			const s = await stat(path);
			return s.isDirectory();
		} catch {
			return false;
		}
	};
	if (await dirExists(join(cwd, ".beads"))) {
		// Distinguish br (beads_rust) from bd (beads) by checking if `br` is available
		if (await isBrAvailable()) return "beads_rust";
		return "beads";
	}
	if (await dirExists(join(cwd, ".seeds"))) return "seeds";
	// Default fallback — seeds is the preferred tracker
	return "seeds";
}

/**
 * Check if the `br` (beads_rust) CLI is available on PATH.
 */
async function isBrAvailable(): Promise<boolean> {
	try {
		const proc = Bun.spawn(["br", "version"], { stdout: "pipe", stderr: "pipe" });
		const exitCode = await proc.exited;
		return exitCode === 0;
	} catch {
		return false;
	}
}

/**
 * Return the CLI tool name for a resolved backend.
 */
export function trackerCliName(backend: TrackerBackend): string {
	switch (backend) {
		case "beads":
			return "bd";
		case "beads_rust":
			return "br";
		case "seeds":
			return "sd";
	}
}

// Re-export types for convenience
export type { TrackerBackend, TrackerClient, TrackerIssue } from "./types.ts";

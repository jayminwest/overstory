/**
 * Shared merge utilities for overstory hooks.
 *
 * Used by both the CLI `hooks install --merge` command and the
 * `deployHooks()` function to merge overstory hooks alongside
 * existing user hooks in .claude/settings.local.json.
 */

/**
 * Returns true if a command string was installed by overstory.
 * Matches commands that reference the overstory or mulch binaries,
 * or use OVERSTORY_ environment variables (e.g. guard scripts).
 */
export function isOverstoryCommand(cmd: string): boolean {
	return cmd.includes("overstory") || cmd.includes("mulch") || cmd.includes("OVERSTORY_");
}

/**
 * Returns a copy of an entry with overstory inner hook commands removed.
 * Returns null if all inner hooks are removed (entry should be dropped).
 */
export function stripOverstoryCommands(entry: unknown): unknown | null {
	if (typeof entry !== "object" || entry === null) return entry;
	const obj = entry as Record<string, unknown>;
	const innerHooks = obj.hooks;
	if (!Array.isArray(innerHooks)) return entry;
	const kept = innerHooks.filter((h) => {
		if (typeof h !== "object" || h === null) return true;
		const cmd = (h as Record<string, unknown>).command;
		return !(typeof cmd === "string" && isOverstoryCommand(cmd));
	});
	if (kept.length === 0) return null;
	return { ...obj, hooks: kept };
}

/**
 * Collect all command strings from a set of entries for deduplication.
 */
export function collectCommands(entries: unknown[]): Set<string> {
	const cmds = new Set<string>();
	for (const entry of entries) {
		if (typeof entry !== "object" || entry === null) continue;
		const inner = (entry as Record<string, unknown>).hooks;
		if (!Array.isArray(inner)) continue;
		for (const h of inner) {
			if (typeof h !== "object" || h === null) continue;
			const cmd = (h as Record<string, unknown>).command;
			if (typeof cmd === "string") cmds.add(cmd);
		}
	}
	return cmds;
}

/**
 * Merge source hook entries into target hook entries for a single event key.
 * Deduplicates by individual command string so only truly new entries are added.
 * Non-overstory entries in target are always preserved.
 */
export function mergeEventHooks(targetEntries: unknown[], sourceEntries: unknown[]): unknown[] {
	const existingCommands = collectCommands(targetEntries);
	const toAdd = sourceEntries.filter((entry) => {
		if (typeof entry !== "object" || entry === null) return true;
		const inner = (entry as Record<string, unknown>).hooks;
		if (!Array.isArray(inner)) return true;
		// Only add this entry if it introduces at least one new command
		return inner.some((h) => {
			if (typeof h !== "object" || h === null) return false;
			const cmd = (h as Record<string, unknown>).command;
			return typeof cmd === "string" && !existingCommands.has(cmd);
		});
	});
	return [...targetEntries, ...toAdd];
}

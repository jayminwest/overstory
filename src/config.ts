import { dirname, join, resolve } from "node:path";
import { ConfigError, ValidationError } from "./errors.ts";
import type { OverstoryConfig } from "./types.ts";

/**
 * Default configuration with all fields populated.
 * Used as the base; file-loaded values are merged on top.
 */
export const DEFAULT_CONFIG: OverstoryConfig = {
	project: {
		name: "",
		root: "",
		canonicalBranch: "main",
	},
	agents: {
		manifestPath: ".overstory/agent-manifest.json",
		baseDir: "agents",
		maxConcurrent: 5,
		staggerDelayMs: 2_000,
		maxDepth: 2,
	},
	worktrees: {
		baseDir: ".overstory/worktrees",
	},
	beads: {
		enabled: true,
	},
	mulch: {
		enabled: true,
		domains: [],
		primeFormat: "markdown",
	},
	merge: {
		aiResolveEnabled: true,
		reimagineEnabled: false,
	},
	watchdog: {
		tier1Enabled: true,
		tier1IntervalMs: 30_000,
		tier2Enabled: false,
		staleThresholdMs: 300_000, // 5 minutes
		zombieThresholdMs: 600_000, // 10 minutes
	},
	logging: {
		verbose: false,
		redactSecrets: true,
	},
};

const CONFIG_FILENAME = "config.yaml";
const OVERSTORY_DIR = ".overstory";

/**
 * Minimal YAML parser that handles the config structure.
 *
 * Supports:
 * - Nested objects via indentation
 * - String, number, boolean values
 * - Arrays using `- item` syntax
 * - Quoted strings (single and double)
 * - Comments (lines starting with #)
 * - Empty lines
 *
 * Does NOT support:
 * - Flow mappings/sequences ({}, [])
 * - Multi-line strings (|, >)
 * - Anchors/aliases
 * - Tags
 */
function parseYaml(text: string): Record<string, unknown> {
	const lines = text.split("\n");
	const root: Record<string, unknown> = {};

	// Stack tracks the current nesting context.
	// Each entry: [indent level, parent object, current key for arrays]
	const stack: Array<{
		indent: number;
		obj: Record<string, unknown>;
	}> = [{ indent: -1, obj: root }];

	for (let i = 0; i < lines.length; i++) {
		const rawLine = lines[i];
		if (rawLine === undefined) continue;

		// Strip comments (but not inside quoted strings)
		const commentFree = stripComment(rawLine);

		// Skip empty lines and comment-only lines
		const trimmed = commentFree.trimEnd();
		if (trimmed.trim() === "") continue;

		const indent = countIndent(trimmed);
		const content = trimmed.trim();

		// Pop stack to find the correct parent for this indent level
		while (stack.length > 1) {
			const top = stack[stack.length - 1];
			if (top && top.indent >= indent) {
				stack.pop();
			} else {
				break;
			}
		}

		const parent = stack[stack.length - 1];
		if (!parent) continue;

		// Array item: "- value"
		if (content.startsWith("- ")) {
			const value = content.slice(2).trim();
			// Find the key this array belongs to - it's the last key set on the parent
			// We need to find which key in the parent obj is an array at this indent
			const lastKey = findLastKey(parent.obj);
			if (lastKey !== null) {
				const existing = parent.obj[lastKey];
				if (Array.isArray(existing)) {
					existing.push(parseValue(value));
				}
			}
			continue;
		}

		// Key: value pair
		const colonIndex = content.indexOf(":");
		if (colonIndex === -1) continue;

		const key = content.slice(0, colonIndex).trim();
		const rawValue = content.slice(colonIndex + 1).trim();

		if (rawValue === "" || rawValue === undefined) {
			// Nested object - create it and push onto stack
			const nested: Record<string, unknown> = {};
			parent.obj[key] = nested;
			stack.push({ indent, obj: nested });
		} else if (rawValue === "[]") {
			// Empty array literal
			parent.obj[key] = [];
		} else {
			parent.obj[key] = parseValue(rawValue);
		}
	}

	return root;
}

/** Count leading spaces (tabs count as 2 spaces for indentation). */
function countIndent(line: string): number {
	let count = 0;
	for (const ch of line) {
		if (ch === " ") count++;
		else if (ch === "\t") count += 2;
		else break;
	}
	return count;
}

/** Strip inline comments that are not inside quoted strings. */
function stripComment(line: string): string {
	let inSingle = false;
	let inDouble = false;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (ch === "'" && !inDouble) inSingle = !inSingle;
		else if (ch === '"' && !inSingle) inDouble = !inDouble;
		else if (ch === "#" && !inSingle && !inDouble) {
			// Ensure it's preceded by whitespace (YAML spec)
			if (i === 0 || line[i - 1] === " " || line[i - 1] === "\t") {
				return line.slice(0, i);
			}
		}
	}
	return line;
}

/** Parse a scalar YAML value into the appropriate JS type. */
function parseValue(raw: string): string | number | boolean | null {
	// Quoted strings
	if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
		return raw.slice(1, -1);
	}

	// Booleans
	if (raw === "true" || raw === "True" || raw === "TRUE") return true;
	if (raw === "false" || raw === "False" || raw === "FALSE") return false;

	// Null
	if (raw === "null" || raw === "~" || raw === "Null" || raw === "NULL") return null;

	// Numbers
	if (/^-?\d+$/.test(raw)) return Number.parseInt(raw, 10);
	if (/^-?\d+\.\d+$/.test(raw)) return Number.parseFloat(raw);
	// Underscore-separated numbers (e.g., 30_000)
	if (/^-?\d[\d_]*\d$/.test(raw)) return Number.parseInt(raw.replace(/_/g, ""), 10);

	// Plain string
	return raw;
}

/** Find the last key added to an object (insertion order). */
function findLastKey(obj: Record<string, unknown>): string | null {
	const keys = Object.keys(obj);
	return keys[keys.length - 1] ?? null;
}

/**
 * Deep merge source into target. Source values override target values.
 * Arrays from source replace (not append) target arrays.
 */
function deepMerge(
	target: Record<string, unknown>,
	source: Record<string, unknown>,
): Record<string, unknown> {
	const result: Record<string, unknown> = { ...target };

	for (const key of Object.keys(source)) {
		const sourceVal = source[key];
		const targetVal = result[key];

		if (
			sourceVal !== null &&
			sourceVal !== undefined &&
			typeof sourceVal === "object" &&
			!Array.isArray(sourceVal) &&
			targetVal !== null &&
			targetVal !== undefined &&
			typeof targetVal === "object" &&
			!Array.isArray(targetVal)
		) {
			result[key] = deepMerge(
				targetVal as Record<string, unknown>,
				sourceVal as Record<string, unknown>,
			);
		} else if (sourceVal !== undefined) {
			result[key] = sourceVal;
		}
	}

	return result;
}

/**
 * Validate that a config object has the required structure and sane values.
 * Throws ValidationError on failure.
 */
function validateConfig(config: OverstoryConfig): void {
	// project.root is required and must be a non-empty string
	if (!config.project.root || typeof config.project.root !== "string") {
		throw new ValidationError("project.root is required and must be a non-empty string", {
			field: "project.root",
			value: config.project.root,
		});
	}

	// project.canonicalBranch must be a non-empty string
	if (!config.project.canonicalBranch || typeof config.project.canonicalBranch !== "string") {
		throw new ValidationError(
			"project.canonicalBranch is required and must be a non-empty string",
			{
				field: "project.canonicalBranch",
				value: config.project.canonicalBranch,
			},
		);
	}

	// agents.maxConcurrent must be a positive integer
	if (!Number.isInteger(config.agents.maxConcurrent) || config.agents.maxConcurrent < 1) {
		throw new ValidationError("agents.maxConcurrent must be a positive integer", {
			field: "agents.maxConcurrent",
			value: config.agents.maxConcurrent,
		});
	}

	// agents.maxDepth must be a non-negative integer
	if (!Number.isInteger(config.agents.maxDepth) || config.agents.maxDepth < 0) {
		throw new ValidationError("agents.maxDepth must be a non-negative integer", {
			field: "agents.maxDepth",
			value: config.agents.maxDepth,
		});
	}

	// agents.staggerDelayMs must be non-negative
	if (config.agents.staggerDelayMs < 0) {
		throw new ValidationError("agents.staggerDelayMs must be non-negative", {
			field: "agents.staggerDelayMs",
			value: config.agents.staggerDelayMs,
		});
	}

	// watchdog intervals must be positive if enabled
	if (config.watchdog.tier1Enabled && config.watchdog.tier1IntervalMs <= 0) {
		throw new ValidationError("watchdog.tier1IntervalMs must be positive when tier1 is enabled", {
			field: "watchdog.tier1IntervalMs",
			value: config.watchdog.tier1IntervalMs,
		});
	}

	if (config.watchdog.staleThresholdMs <= 0) {
		throw new ValidationError("watchdog.staleThresholdMs must be positive", {
			field: "watchdog.staleThresholdMs",
			value: config.watchdog.staleThresholdMs,
		});
	}

	if (config.watchdog.zombieThresholdMs <= config.watchdog.staleThresholdMs) {
		throw new ValidationError("watchdog.zombieThresholdMs must be greater than staleThresholdMs", {
			field: "watchdog.zombieThresholdMs",
			value: config.watchdog.zombieThresholdMs,
		});
	}

	// mulch.primeFormat must be one of the valid options
	const validFormats = ["markdown", "xml", "json"] as const;
	if (!validFormats.includes(config.mulch.primeFormat as (typeof validFormats)[number])) {
		throw new ValidationError(`mulch.primeFormat must be one of: ${validFormats.join(", ")}`, {
			field: "mulch.primeFormat",
			value: config.mulch.primeFormat,
		});
	}
}

/**
 * Resolve the actual project root, handling git worktrees.
 *
 * When running from inside a git worktree (e.g., an agent's worktree at
 * `.overstory/worktrees/{name}/`), the passed directory won't contain
 * `.overstory/config.yaml`. This function detects worktrees using
 * `git rev-parse --git-common-dir` and resolves to the main repository root.
 *
 * @param startDir - The initial directory (usually process.cwd())
 * @returns The resolved project root containing `.overstory/`
 */
export async function resolveProjectRoot(startDir: string): Promise<string> {
	const { existsSync } = require("node:fs") as typeof import("node:fs");

	// If .overstory/config.yaml exists here, we're in the right place
	if (existsSync(join(startDir, OVERSTORY_DIR, CONFIG_FILENAME))) {
		return startDir;
	}

	// We might be inside a git worktree. Find the main repo root
	// via git's common dir (points to the shared .git directory).
	try {
		const proc = Bun.spawn(["git", "rev-parse", "--git-common-dir"], {
			cwd: startDir,
			stdout: "pipe",
			stderr: "pipe",
		});
		const exitCode = await proc.exited;
		if (exitCode === 0) {
			const gitCommonDir = (await new Response(proc.stdout).text()).trim();
			const absGitCommon = resolve(startDir, gitCommonDir);
			// Main repo root is the parent of the .git directory
			const mainRoot = dirname(absGitCommon);
			if (existsSync(join(mainRoot, OVERSTORY_DIR, CONFIG_FILENAME))) {
				return mainRoot;
			}
		}
	} catch {
		// git not available, fall through
	}

	// Fallback to the start directory
	return startDir;
}

/**
 * Load the overstory configuration for a project.
 *
 * Reads `.overstory/config.yaml` from the project root, parses it,
 * merges with defaults, and validates the result.
 *
 * Automatically resolves the project root when running inside a git worktree.
 *
 * @param projectRoot - Absolute path to the target project root (or worktree)
 * @returns Fully populated and validated OverstoryConfig
 * @throws ConfigError if the file cannot be read or parsed
 * @throws ValidationError if the merged config fails validation
 */
export async function loadConfig(projectRoot: string): Promise<OverstoryConfig> {
	// Resolve the actual project root (handles git worktrees)
	const resolvedRoot = await resolveProjectRoot(projectRoot);

	const configPath = join(resolvedRoot, OVERSTORY_DIR, CONFIG_FILENAME);

	// Start with defaults, setting the project root
	const defaults = structuredClone(DEFAULT_CONFIG);
	defaults.project.root = resolvedRoot;
	defaults.project.name = resolvedRoot.split("/").pop() ?? "unknown";

	// Try to read the config file
	const file = Bun.file(configPath);
	const exists = await file.exists();

	if (!exists) {
		// No config file — use defaults (project.root is set, so validation passes)
		validateConfig(defaults);
		return defaults;
	}

	let text: string;
	try {
		text = await file.text();
	} catch (err) {
		throw new ConfigError(`Failed to read config file: ${configPath}`, {
			configPath,
			cause: err instanceof Error ? err : undefined,
		});
	}

	let parsed: Record<string, unknown>;
	try {
		parsed = parseYaml(text);
	} catch (err) {
		throw new ConfigError(`Failed to parse YAML in config file: ${configPath}`, {
			configPath,
			cause: err instanceof Error ? err : undefined,
		});
	}

	// Deep merge parsed config over defaults
	const merged = deepMerge(
		defaults as unknown as Record<string, unknown>,
		parsed,
	) as unknown as OverstoryConfig;

	// Ensure project.root is always set to the resolved project root
	merged.project.root = resolvedRoot;

	validateConfig(merged);

	return merged;
}

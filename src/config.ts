import { dirname, join, resolve } from "node:path";
import { ConfigError, ValidationError } from "./errors.ts";
import type { OverstoryConfig, QualityGate, TaskTrackerBackend } from "./types.ts";

/**
 * Default configuration with all fields populated.
 * Used as the base; file-loaded values are merged on top.
 */
/** Default quality gates used when no qualityGates are configured in config.yaml. */
export const DEFAULT_QUALITY_GATES: QualityGate[] = [
	{ name: "Tests", command: "bun test", description: "all tests must pass" },
	{ name: "Lint", command: "bun run lint", description: "zero errors" },
	{ name: "Typecheck", command: "bun run typecheck", description: "no TypeScript errors" },
];

export const DEFAULT_CONFIG: OverstoryConfig = {
	project: {
		name: "",
		root: "",
		canonicalBranch: "main",
		qualityGates: DEFAULT_QUALITY_GATES,
	},
	agents: {
		manifestPath: ".overstory/agent-manifest.json",
		baseDir: ".overstory/agent-defs",
		maxConcurrent: 25,
		staggerDelayMs: 2_000,
		maxDepth: 2,
		maxSessionsPerRun: 0,
		userAgentDir: "",
		capabilityAliases: {},
	},
	worktrees: {
		baseDir: ".overstory/worktrees",
	},
	taskTracker: {
		backend: "auto" as TaskTrackerBackend,
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
	providers: {
		anthropic: { type: "native" },
	},
	watchdog: {
		tier0Enabled: true, // Tier 0: Mechanical daemon
		tier0IntervalMs: 30_000,
		tier1Enabled: false, // Tier 1: Triage agent (AI analysis)
		tier2Enabled: false, // Tier 2: Monitor agent (continuous patrol)
		staleThresholdMs: 300_000, // 5 minutes
		zombieThresholdMs: 600_000, // 10 minutes
		nudgeIntervalMs: 60_000, // 1 minute between progressive nudge stages
	},
	models: {},
	logging: {
		verbose: false,
		redactSecrets: true,
	},
	slashCommands: [],
	tracking: {
		provider: "builtin",
		externalAgents: {
			trackManager: "",
			dependencyManager: "",
		},
	},
};

const CONFIG_FILENAME = "config.yaml";
const CONFIG_LOCAL_FILENAME = "config.local.yaml";
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

			// Detect object array item: "- key: val" where key is a plain identifier.
			// Quoted scalars (starting with " or ') are not object items.
			const objColonIdx = value.indexOf(":");
			const isObjectItem =
				objColonIdx > 0 &&
				!value.startsWith('"') &&
				!value.startsWith("'") &&
				/^[\w-]+$/.test(value.slice(0, objColonIdx).trim());

			if (isObjectItem) {
				// Parse the first key:value pair of the new object item.
				const itemKey = value.slice(0, objColonIdx).trim();
				const itemVal = value.slice(objColonIdx + 1).trim();
				const newItem: Record<string, unknown> = {};
				if (itemVal !== "") {
					newItem[itemKey] = parseValue(itemVal);
				} else {
					newItem[itemKey] = {};
				}

				// Find the array this item belongs to and push the new item.
				// Case A: parent.obj already has an array as last value.
				const lastKey = findLastKey(parent.obj);
				if (lastKey !== null) {
					const existing = parent.obj[lastKey];
					if (Array.isArray(existing)) {
						existing.push(newItem);
						stack.push({ indent, obj: newItem });
						continue;
					}
				}

				// Case B: grandparent has an empty {} for this array's key — convert it.
				if (stack.length >= 2) {
					const grandparent = stack[stack.length - 2];
					if (grandparent) {
						const gpKey = findLastKey(grandparent.obj);
						if (gpKey !== null) {
							const gpVal = grandparent.obj[gpKey];
							if (
								gpVal !== null &&
								gpVal !== undefined &&
								typeof gpVal === "object" &&
								!Array.isArray(gpVal) &&
								Object.keys(gpVal as Record<string, unknown>).length === 0
							) {
								const arr: unknown[] = [newItem];
								grandparent.obj[gpKey] = arr;
								// Pop the now-stale nested {} so the grandparent becomes parent.
								stack.pop();
								stack.push({ indent, obj: newItem });
								continue;
							}
						}
					}
				}
				continue;
			}

			// Scalar array item.
			// Find the key this array belongs to.
			// First check parent.obj directly (for inline arrays or subsequent items).
			const lastKey = findLastKey(parent.obj);
			if (lastKey !== null) {
				const existing = parent.obj[lastKey];
				if (Array.isArray(existing)) {
					existing.push(parseValue(value));
					continue;
				}
			}

			// Multiline array case: `key:\n  - item` pushes an empty {} onto the
			// stack for the nested object.  The `- ` item's parent is that empty {},
			// which has no keys.  We need to look one level up in the stack to find
			// the key whose value is the empty {} and convert it to [].
			if (stack.length >= 2) {
				const grandparent = stack[stack.length - 2];
				if (grandparent) {
					const gpKey = findLastKey(grandparent.obj);
					if (gpKey !== null) {
						const gpVal = grandparent.obj[gpKey];
						if (
							gpVal !== null &&
							gpVal !== undefined &&
							typeof gpVal === "object" &&
							!Array.isArray(gpVal) &&
							Object.keys(gpVal as Record<string, unknown>).length === 0
						) {
							// Convert {} to [] and push the first item.
							const arr: unknown[] = [parseValue(value)];
							grandparent.obj[gpKey] = arr;
							// Pop the now-stale nested {} from the stack so subsequent
							// `- ` items find the grandparent and the array directly.
							stack.pop();
							continue;
						}
					}
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
 * Migrate deprecated watchdog tier key names in a parsed config object.
 *
 * Phase 4 renamed the watchdog tiers:
 *   - Old "tier1" (mechanical daemon) → New "tier0"
 *   - Old "tier2" (AI triage)         → New "tier1"
 *
 * Detection heuristic: if `tier0Enabled` is absent but `tier1Enabled` is present,
 * this is an old-style config. A new-style config would have `tier0Enabled`.
 *
 * If old key names are present and new key names are absent, this function
 * copies the values to the new keys, removes the old keys (to prevent collision
 * with the renamed tiers), and logs a deprecation warning.
 *
 * Mutates the parsed config object in place.
 */
function migrateDeprecatedWatchdogKeys(parsed: Record<string, unknown>): void {
	const watchdog = parsed.watchdog;
	if (watchdog === null || watchdog === undefined || typeof watchdog !== "object") {
		return;
	}

	const wd = watchdog as Record<string, unknown>;

	// Detect old-style config: tier1Enabled present but tier0Enabled absent.
	// In old naming, tier1 = mechanical daemon. In new naming, tier0 = mechanical daemon.
	const isOldStyle = "tier1Enabled" in wd && !("tier0Enabled" in wd);

	if (!isOldStyle) {
		// New-style config or no tier keys at all — nothing to migrate
		return;
	}

	// Old tier1Enabled → new tier0Enabled (mechanical daemon)
	wd.tier0Enabled = wd.tier1Enabled;
	wd.tier1Enabled = undefined;
	process.stderr.write(
		"[overstory] DEPRECATED: watchdog.tier1Enabled → use watchdog.tier0Enabled\n",
	);

	// Old tier1IntervalMs → new tier0IntervalMs (mechanical daemon)
	if ("tier1IntervalMs" in wd) {
		wd.tier0IntervalMs = wd.tier1IntervalMs;
		wd.tier1IntervalMs = undefined;
		process.stderr.write(
			"[overstory] DEPRECATED: watchdog.tier1IntervalMs → use watchdog.tier0IntervalMs\n",
		);
	}

	// Old tier2Enabled → new tier1Enabled (AI triage)
	if ("tier2Enabled" in wd) {
		wd.tier1Enabled = wd.tier2Enabled;
		wd.tier2Enabled = undefined;
		process.stderr.write(
			"[overstory] DEPRECATED: watchdog.tier2Enabled → use watchdog.tier1Enabled\n",
		);
	}
}

/**
 * Migrate deprecated task tracker key names in a parsed config object.
 *
 * Handles legacy `beads:` and `seeds:` top-level keys, converting them to
 * the unified `taskTracker:` section. If `taskTracker:` already exists, no
 * migration is performed.
 *
 * Mutates the parsed config object in place.
 */
function migrateDeprecatedTaskTrackerKeys(parsed: Record<string, unknown>): void {
	if (parsed.taskTracker !== undefined) return; // Already migrated

	if (parsed.beads !== undefined) {
		const beadsConfig = parsed.beads as Record<string, unknown>;
		parsed.taskTracker = {
			backend: "beads",
			enabled: beadsConfig.enabled ?? true,
		};
		delete parsed.beads;
		process.stderr.write(
			"[overstory] DEPRECATED: beads: -> use taskTracker: { backend: beads, enabled: true }\n",
		);
	} else if (parsed.seeds !== undefined) {
		const seedsConfig = parsed.seeds as Record<string, unknown>;
		parsed.taskTracker = {
			backend: "seeds",
			enabled: seedsConfig.enabled ?? true,
		};
		delete parsed.seeds;
		process.stderr.write(
			"[overstory] DEPRECATED: seeds: -> use taskTracker: { backend: seeds, enabled: true }\n",
		);
	}
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

	// agents.maxSessionsPerRun must be a non-negative integer (0 = unlimited)
	if (!Number.isInteger(config.agents.maxSessionsPerRun) || config.agents.maxSessionsPerRun < 0) {
		throw new ValidationError(
			"agents.maxSessionsPerRun must be a non-negative integer (0 = unlimited)",
			{
				field: "agents.maxSessionsPerRun",
				value: config.agents.maxSessionsPerRun,
			},
		);
	}

	// agents.userAgentDir must be a string (empty string = disabled)
	if (typeof config.agents.userAgentDir !== "string") {
		throw new ValidationError("agents.userAgentDir must be a string (empty string to disable)", {
			field: "agents.userAgentDir",
			value: config.agents.userAgentDir,
		});
	}

	// agents.capabilityAliases must be an object if present
	if (
		config.agents.capabilityAliases !== null &&
		typeof config.agents.capabilityAliases === "object"
	) {
		for (const [cap, alias] of Object.entries(config.agents.capabilityAliases)) {
			if (alias === null || typeof alias !== "object") {
				throw new ValidationError(`agents.capabilityAliases.${cap} must be an object`, {
					field: `agents.capabilityAliases.${cap}`,
					value: alias,
				});
			}
			const a = alias as unknown as Record<string, unknown>;
			if (typeof a.userAgent !== "string" || a.userAgent.length === 0) {
				throw new ValidationError(
					`agents.capabilityAliases.${cap}.userAgent must be a non-empty string`,
					{
						field: `agents.capabilityAliases.${cap}.userAgent`,
						value: a.userAgent,
					},
				);
			}
			if (a.tags !== undefined && !Array.isArray(a.tags)) {
				throw new ValidationError(
					`agents.capabilityAliases.${cap}.tags must be an array if present`,
					{
						field: `agents.capabilityAliases.${cap}.tags`,
						value: a.tags,
					},
				);
			}
		}
	}

	// watchdog intervals must be positive if enabled
	if (config.watchdog.tier0Enabled && config.watchdog.tier0IntervalMs <= 0) {
		throw new ValidationError("watchdog.tier0IntervalMs must be positive when tier0 is enabled", {
			field: "watchdog.tier0IntervalMs",
			value: config.watchdog.tier0IntervalMs,
		});
	}

	if (config.watchdog.nudgeIntervalMs <= 0) {
		throw new ValidationError("watchdog.nudgeIntervalMs must be positive", {
			field: "watchdog.nudgeIntervalMs",
			value: config.watchdog.nudgeIntervalMs,
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

	// taskTracker.backend must be one of the valid options
	const validBackends = ["auto", "seeds", "beads"] as const;
	if (!validBackends.includes(config.taskTracker.backend as (typeof validBackends)[number])) {
		throw new ValidationError(`taskTracker.backend must be one of: ${validBackends.join(", ")}`, {
			field: "taskTracker.backend",
			value: config.taskTracker.backend,
		});
	}

	// providers: validate each entry
	const validProviderTypes = ["native", "gateway"];
	for (const [name, provider] of Object.entries(config.providers)) {
		const p = provider as unknown;
		if (p === null || typeof p !== "object") {
			throw new ValidationError(`providers.${name} must be an object`, {
				field: `providers.${name}`,
				value: p,
			});
		}
		if (!validProviderTypes.includes(provider.type)) {
			throw new ValidationError(
				`providers.${name}.type must be one of: ${validProviderTypes.join(", ")}`,
				{
					field: `providers.${name}.type`,
					value: provider.type,
				},
			);
		}
		if (provider.type === "gateway") {
			if (!provider.baseUrl || typeof provider.baseUrl !== "string") {
				throw new ValidationError(`providers.${name}.baseUrl is required for gateway providers`, {
					field: `providers.${name}.baseUrl`,
					value: provider.baseUrl,
				});
			}
			if (!provider.authTokenEnv || typeof provider.authTokenEnv !== "string") {
				throw new ValidationError(
					`providers.${name}.authTokenEnv is required for gateway providers`,
					{
						field: `providers.${name}.authTokenEnv`,
						value: provider.authTokenEnv,
					},
				);
			}
		}
	}

	// qualityGates: if present, validate each entry
	if (config.project.qualityGates) {
		for (let i = 0; i < config.project.qualityGates.length; i++) {
			const gate = config.project.qualityGates[i];
			if (!gate) continue;
			if (!gate.name || typeof gate.name !== "string") {
				throw new ValidationError(`project.qualityGates[${i}].name must be a non-empty string`, {
					field: `project.qualityGates[${i}].name`,
					value: gate.name,
				});
			}
			if (!gate.command || typeof gate.command !== "string") {
				throw new ValidationError(`project.qualityGates[${i}].command must be a non-empty string`, {
					field: `project.qualityGates[${i}].command`,
					value: gate.command,
				});
			}
			if (!gate.description || typeof gate.description !== "string") {
				throw new ValidationError(
					`project.qualityGates[${i}].description must be a non-empty string`,
					{
						field: `project.qualityGates[${i}].description`,
						value: gate.description,
					},
				);
			}
		}
	}

	// models: validate each value — accepts aliases and provider-prefixed refs
	const validAliases = ["sonnet", "opus", "haiku"];
	const toolHeavyRoles = ["builder", "scout"];
	for (const [role, model] of Object.entries(config.models)) {
		if (model === undefined) continue;
		if (model.includes("/")) {
			// Provider-prefixed ref: validate the provider name exists
			const providerName = model.split("/")[0] ?? "";
			if (!providerName || !(providerName in config.providers)) {
				throw new ValidationError(
					`models.${role} references unknown provider '${providerName}'. Add it to the providers section first.`,
					{
						field: `models.${role}`,
						value: model,
					},
				);
			}
			if (toolHeavyRoles.includes(role)) {
				process.stderr.write(
					`[overstory] WARNING: models.${role} uses non-Anthropic model '${model}'. Tool-use compatibility cannot be verified at config time.\n`,
				);
			}
		} else {
			// Must be a valid alias
			if (!validAliases.includes(model)) {
				throw new ValidationError(
					`models.${role} must be a valid alias (${validAliases.join(", ")}) or a provider-prefixed ref (e.g., openrouter/openai/gpt-4)`,
					{
						field: `models.${role}`,
						value: model,
					},
				);
			}
		}
	}

	// slashCommands: validate each entry if present
	if (config.slashCommands && Array.isArray(config.slashCommands)) {
		for (let i = 0; i < config.slashCommands.length; i++) {
			const cmd = config.slashCommands[i];
			if (!cmd) continue;
			if (!cmd.name || typeof cmd.name !== "string") {
				throw new ValidationError(`slashCommands[${i}].name must be a non-empty string`, {
					field: `slashCommands[${i}].name`,
					value: cmd.name,
				});
			}
			if (!cmd.description || typeof cmd.description !== "string") {
				throw new ValidationError(`slashCommands[${i}].description must be a non-empty string`, {
					field: `slashCommands[${i}].description`,
					value: cmd.description,
				});
			}
			if (!Array.isArray(cmd.availableTo) || cmd.availableTo.length === 0) {
				throw new ValidationError(
					`slashCommands[${i}].availableTo must be a non-empty array of capability names`,
					{
						field: `slashCommands[${i}].availableTo`,
						value: cmd.availableTo,
					},
				);
			}
		}
	}

	// tracking: validate provider and externalAgents
	const validTrackingProviders = ["builtin", "external"];
	if (!validTrackingProviders.includes(config.tracking.provider)) {
		throw new ValidationError(
			`tracking.provider must be one of: ${validTrackingProviders.join(", ")}`,
			{
				field: "tracking.provider",
				value: config.tracking.provider,
			},
		);
	}
	if (config.tracking.provider === "external") {
		if (
			!config.tracking.externalAgents.trackManager ||
			typeof config.tracking.externalAgents.trackManager !== "string"
		) {
			throw new ValidationError(
				"tracking.externalAgents.trackManager must be a non-empty string when provider is 'external'",
				{
					field: "tracking.externalAgents.trackManager",
					value: config.tracking.externalAgents.trackManager,
				},
			);
		}
		if (
			!config.tracking.externalAgents.dependencyManager ||
			typeof config.tracking.externalAgents.dependencyManager !== "string"
		) {
			throw new ValidationError(
				"tracking.externalAgents.dependencyManager must be a non-empty string when provider is 'external'",
				{
					field: "tracking.externalAgents.dependencyManager",
					value: config.tracking.externalAgents.dependencyManager,
				},
			);
		}
	}
}

/**
 * Load and merge config.local.yaml on top of the current config.
 *
 * config.local.yaml is gitignored and provides machine-specific overrides
 * (e.g., maxConcurrent for weaker hardware) without dirtying the worktree.
 *
 * Merge order: DEFAULT_CONFIG <- config.yaml <- config.local.yaml
 */
async function mergeLocalConfig(
	resolvedRoot: string,
	config: OverstoryConfig,
): Promise<OverstoryConfig> {
	const localPath = join(resolvedRoot, OVERSTORY_DIR, CONFIG_LOCAL_FILENAME);
	const localFile = Bun.file(localPath);

	if (!(await localFile.exists())) {
		return config;
	}

	let text: string;
	try {
		text = await localFile.text();
	} catch (err) {
		throw new ConfigError(`Failed to read local config file: ${localPath}`, {
			configPath: localPath,
			cause: err instanceof Error ? err : undefined,
		});
	}

	let parsed: Record<string, unknown>;
	try {
		parsed = parseYaml(text);
	} catch (err) {
		throw new ConfigError(`Failed to parse YAML in local config file: ${localPath}`, {
			configPath: localPath,
			cause: err instanceof Error ? err : undefined,
		});
	}

	migrateDeprecatedWatchdogKeys(parsed);
	migrateDeprecatedTaskTrackerKeys(parsed);

	return deepMerge(
		config as unknown as Record<string, unknown>,
		parsed,
	) as unknown as OverstoryConfig;
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

	// Check git worktree FIRST. When running from an agent worktree
	// (e.g., .overstory/worktrees/{name}/), the worktree may contain
	// tracked copies of .overstory/config.yaml. We must resolve to the
	// main repository root so runtime state (mail.db, metrics.db, etc.)
	// is shared across all agents, not siloed per worktree.
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
			// If mainRoot differs from startDir, we're in a worktree — resolve to canonical root
			if (mainRoot !== startDir && existsSync(join(mainRoot, OVERSTORY_DIR, CONFIG_FILENAME))) {
				return mainRoot;
			}
		}
	} catch {
		// git not available, fall through
	}

	// Not inside a worktree (or git not available).
	// Check if .overstory/config.yaml exists at startDir.
	if (existsSync(join(startDir, OVERSTORY_DIR, CONFIG_FILENAME))) {
		return startDir;
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
		// No config file — use defaults, but still check for local overrides
		let config = defaults;
		config = await mergeLocalConfig(resolvedRoot, config);
		config.project.root = resolvedRoot;
		validateConfig(config);
		return config;
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

	// Backward compatibility: migrate deprecated watchdog tier key names.
	// Old naming: tier1 = mechanical daemon, tier2 = AI triage
	// New naming: tier0 = mechanical daemon, tier1 = AI triage, tier2 = monitor agent
	migrateDeprecatedWatchdogKeys(parsed);
	migrateDeprecatedTaskTrackerKeys(parsed);

	// Deep merge parsed config over defaults
	let merged = deepMerge(
		defaults as unknown as Record<string, unknown>,
		parsed,
	) as unknown as OverstoryConfig;

	// Check for config.local.yaml (local overrides, gitignored)
	merged = await mergeLocalConfig(resolvedRoot, merged);

	// Ensure project.root is always set to the resolved project root
	merged.project.root = resolvedRoot;

	validateConfig(merged);

	return merged;
}

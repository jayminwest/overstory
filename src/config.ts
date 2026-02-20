import { dirname, join, resolve } from "node:path";
import { ConfigError, ValidationError } from "./errors.ts";
import { SUPPORTED_CAPABILITIES } from "./types.ts";
import type { OverstoryConfig, ProviderRuntime } from "./types.ts";

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
		baseDir: ".overstory/agent-defs",
		maxConcurrent: 25,
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
	cli: {
		base: "claude",
	},
	providers: {
		anthropic: { type: "native", runtimes: ["claude"] },
		codex: { type: "native", runtimes: ["codex"] },
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
	roleProfiles: {},
	modelProfiles: {},
	logging: {
		verbose: false,
		redactSecrets: true,
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

	// cli.base must be one of the supported runtime CLIs when configured
	const cliBase = config.cli?.base ?? "claude";
	if (config.cli !== undefined) {
		const validCliBases = ["claude", "codex"] as const;
		if (!validCliBases.includes(config.cli.base)) {
			throw new ValidationError(`cli.base must be one of: ${validCliBases.join(", ")}`, {
				field: "cli.base",
				value: config.cli.base,
			});
		}
	}

	// providers: validate runtime compatibility and gateway requirements.
	if (
		config.providers === null ||
		config.providers === undefined ||
		typeof config.providers !== "object" ||
		Array.isArray(config.providers)
	) {
		throw new ValidationError("providers must be an object", {
			field: "providers",
			value: config.providers,
		});
	}

	const validProviderRuntimes: ProviderRuntime[] = ["claude", "codex"];
	const validProviderRuntimeSet = new Set(validProviderRuntimes);
	for (const [providerName, provider] of Object.entries(config.providers)) {
		if (provider === null || provider === undefined || typeof provider !== "object") {
			throw new ValidationError(`providers.${providerName} must be an object`, {
				field: `providers.${providerName}`,
				value: provider,
			});
		}

		if (provider.type !== "native" && provider.type !== "gateway") {
			throw new ValidationError(`providers.${providerName}.type must be native or gateway`, {
				field: `providers.${providerName}.type`,
				value: provider.type,
			});
		}

		if (!Array.isArray(provider.runtimes) || provider.runtimes.length === 0) {
			throw new ValidationError(`providers.${providerName}.runtimes must be a non-empty array`, {
				field: `providers.${providerName}.runtimes`,
				value: provider.runtimes,
			});
		}

		for (const runtime of provider.runtimes) {
			if (!validProviderRuntimeSet.has(runtime)) {
				throw new ValidationError(
					`providers.${providerName}.runtimes contains invalid runtime "${runtime}"`,
					{
						field: `providers.${providerName}.runtimes`,
						value: runtime,
					},
				);
			}
		}

		if (provider.type === "gateway") {
			if (typeof provider.baseUrl !== "string" || provider.baseUrl.trim().length === 0) {
				throw new ValidationError(
					`providers.${providerName}.baseUrl is required when type=gateway`,
					{
						field: `providers.${providerName}.baseUrl`,
						value: provider.baseUrl,
					},
				);
			}
			if (typeof provider.authTokenEnv !== "string" || provider.authTokenEnv.trim().length === 0) {
				throw new ValidationError(
					`providers.${providerName}.authTokenEnv is required when type=gateway`,
					{
						field: `providers.${providerName}.authTokenEnv`,
						value: provider.authTokenEnv,
					},
				);
			}
		}

		if (provider.adapters === undefined) {
			continue;
		}

		if (
			provider.adapters === null ||
			typeof provider.adapters !== "object" ||
			Array.isArray(provider.adapters)
		) {
			throw new ValidationError(`providers.${providerName}.adapters must be an object`, {
				field: `providers.${providerName}.adapters`,
				value: provider.adapters,
			});
		}

		for (const [runtime, adapter] of Object.entries(provider.adapters)) {
			if (!provider.runtimes.includes(runtime as ProviderRuntime)) {
				throw new ValidationError(
					`providers.${providerName}.adapters.${runtime} is not allowed because runtime "${runtime}" is not declared in providers.${providerName}.runtimes`,
					{
						field: `providers.${providerName}.adapters.${runtime}`,
						value: adapter,
					},
				);
			}

			if (adapter === null || adapter === undefined || typeof adapter !== "object") {
				throw new ValidationError(
					`providers.${providerName}.adapters.${runtime} must be an object`,
					{
						field: `providers.${providerName}.adapters.${runtime}`,
						value: adapter,
					},
				);
			}

			if (adapter.authTokenTargetEnv !== undefined) {
				if (
					typeof adapter.authTokenTargetEnv !== "string" ||
					adapter.authTokenTargetEnv.trim().length === 0
				) {
					throw new ValidationError(
						`providers.${providerName}.adapters.${runtime}.authTokenTargetEnv must be a non-empty string`,
						{
							field: `providers.${providerName}.adapters.${runtime}.authTokenTargetEnv`,
							value: adapter.authTokenTargetEnv,
						},
					);
				}
				if (
					typeof provider.authTokenEnv !== "string" ||
					provider.authTokenEnv.trim().length === 0
				) {
					throw new ValidationError(
						`providers.${providerName}.adapters.${runtime}.authTokenTargetEnv requires providers.${providerName}.authTokenEnv`,
						{
							field: `providers.${providerName}.adapters.${runtime}.authTokenTargetEnv`,
							value: adapter.authTokenTargetEnv,
						},
					);
				}
			}

			if (adapter.baseUrlEnv !== undefined) {
				if (typeof adapter.baseUrlEnv !== "string" || adapter.baseUrlEnv.trim().length === 0) {
					throw new ValidationError(
						`providers.${providerName}.adapters.${runtime}.baseUrlEnv must be a non-empty string`,
						{
							field: `providers.${providerName}.adapters.${runtime}.baseUrlEnv`,
							value: adapter.baseUrlEnv,
						},
					);
				}
				if (typeof provider.baseUrl !== "string" || provider.baseUrl.trim().length === 0) {
					throw new ValidationError(
						`providers.${providerName}.adapters.${runtime}.baseUrlEnv requires providers.${providerName}.baseUrl`,
						{
							field: `providers.${providerName}.adapters.${runtime}.baseUrlEnv`,
							value: adapter.baseUrlEnv,
						},
					);
				}
			}

			if (adapter.staticEnv !== undefined) {
				if (
					adapter.staticEnv === null ||
					typeof adapter.staticEnv !== "object" ||
					Array.isArray(adapter.staticEnv)
				) {
					throw new ValidationError(
						`providers.${providerName}.adapters.${runtime}.staticEnv must be an object`,
						{
							field: `providers.${providerName}.adapters.${runtime}.staticEnv`,
							value: adapter.staticEnv,
						},
					);
				}

				for (const [envKey, envValue] of Object.entries(adapter.staticEnv)) {
					if (typeof envValue !== "string") {
						throw new ValidationError(
							`providers.${providerName}.adapters.${runtime}.staticEnv.${envKey} must be a string`,
							{
								field: `providers.${providerName}.adapters.${runtime}.staticEnv.${envKey}`,
								value: envValue,
							},
						);
					}
				}
			}

			if (adapter.commandArgs !== undefined) {
				if (!Array.isArray(adapter.commandArgs)) {
					throw new ValidationError(
						`providers.${providerName}.adapters.${runtime}.commandArgs must be an array`,
						{
							field: `providers.${providerName}.adapters.${runtime}.commandArgs`,
							value: adapter.commandArgs,
						},
					);
				}

				for (let i = 0; i < adapter.commandArgs.length; i++) {
					const arg = adapter.commandArgs[i];
					if (typeof arg !== "string" || arg.trim().length === 0) {
						throw new ValidationError(
							`providers.${providerName}.adapters.${runtime}.commandArgs[${i}] must be a non-empty string`,
							{
								field: `providers.${providerName}.adapters.${runtime}.commandArgs[${i}]`,
								value: arg,
							},
						);
					}
				}
			}
		}
	}

	const modelProfiles = config.modelProfiles ?? {};
	if (modelProfiles === null || typeof modelProfiles !== "object" || Array.isArray(modelProfiles)) {
		throw new ValidationError("modelProfiles must be an object", {
			field: "modelProfiles",
			value: modelProfiles,
		});
	}

	const modelProfileEntries = Object.entries(modelProfiles);
	for (const [alias, profile] of modelProfileEntries) {
		if (profile === null || profile === undefined || typeof profile !== "object") {
			throw new ValidationError(`modelProfiles.${alias} must be an object`, {
				field: `modelProfiles.${alias}`,
				value: profile,
			});
		}

		if (typeof profile.provider !== "string" || profile.provider.trim().length === 0) {
			throw new ValidationError(`modelProfiles.${alias}.provider must be a non-empty string`, {
				field: `modelProfiles.${alias}.provider`,
				value: profile.provider,
			});
		}

		if (!(profile.provider in config.providers)) {
			throw new ValidationError(
				`modelProfiles.${alias}.provider must reference a configured provider`,
				{
					field: `modelProfiles.${alias}.provider`,
					value: profile.provider,
				},
			);
		}

		if (typeof profile.model !== "string" || profile.model.trim().length === 0) {
			throw new ValidationError(`modelProfiles.${alias}.model must be a non-empty string`, {
				field: `modelProfiles.${alias}.model`,
				value: profile.model,
			});
		}
	}

	const roleProfiles = config.roleProfiles ?? {};
	if (roleProfiles === null || typeof roleProfiles !== "object" || Array.isArray(roleProfiles)) {
		throw new ValidationError("roleProfiles must be an object", {
			field: "roleProfiles",
			value: roleProfiles,
		});
	}

	const roleProfileEntries = Object.entries(roleProfiles);
	if (roleProfileEntries.length > 0 && modelProfileEntries.length === 0) {
		throw new ValidationError(
			"modelProfiles must be a non-empty object when roleProfiles are configured",
			{
				field: "modelProfiles",
				value: modelProfiles,
			},
		);
	}

	const validRoleProfileKeys = new Set<string>(["default", ...SUPPORTED_CAPABILITIES]);
	for (const [role, aliases] of roleProfileEntries) {
		if (!validRoleProfileKeys.has(role)) {
			throw new ValidationError(
				`roleProfiles.${role} is invalid; allowed keys are default or supported capability names`,
				{
					field: `roleProfiles.${role}`,
					value: aliases,
				},
			);
		}

		if (!Array.isArray(aliases) || aliases.length === 0) {
			throw new ValidationError(`roleProfiles.${role} must be a non-empty array`, {
				field: `roleProfiles.${role}`,
				value: aliases,
			});
		}

		for (const alias of aliases) {
			if (typeof alias !== "string" || alias.trim().length === 0) {
				throw new ValidationError(`roleProfiles.${role} must contain non-empty profile aliases`, {
					field: `roleProfiles.${role}`,
					value: aliases,
				});
			}
			if (!(alias in modelProfiles)) {
				throw new ValidationError(
					`roleProfiles.${role} references unknown modelProfiles alias "${alias}"`,
					{
						field: `roleProfiles.${role}`,
						value: aliases,
					},
				);
			}
		}
	}

	// models: in claude mode only aliases are valid; in codex mode any non-empty
	// model id string is allowed (e.g. gpt-5, o3, etc.).
	const validClaudeModels = ["sonnet", "opus", "haiku"];
	const validClaudeModelSet = new Set(validClaudeModels);
	for (const [role, model] of Object.entries(config.models)) {
		if (model === undefined) {
			continue;
		}

		if (typeof model !== "string" || model.trim().length === 0) {
			throw new ValidationError(`models.${role} must be a non-empty string`, {
				field: `models.${role}`,
				value: model,
			});
		}

		if (cliBase === "claude" && !validClaudeModelSet.has(model)) {
			throw new ValidationError(
				`models.${role} must be one of: ${validClaudeModels.join(", ")} when cli.base=claude`,
				{
					field: `models.${role}`,
					value: model,
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

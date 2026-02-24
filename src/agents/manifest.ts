import { join } from "node:path";
import { AgentError } from "../errors.ts";
import type {
	AgentDefinition,
	AgentManifest,
	OverstoryConfig,
	ProviderConfig,
	ResolvedModel,
} from "../types.ts";

/**
 * Interface for loading, querying, and validating an agent manifest.
 */
export interface ManifestLoader {
	/** Load the manifest from disk, parse, validate, and build indexes. */
	load(): Promise<AgentManifest>;
	/** Get an agent definition by name. Returns undefined if not found. */
	getAgent(name: string): AgentDefinition | undefined;
	/** Find all agent names whose capabilities include the given capability. */
	findByCapability(capability: string): AgentDefinition[];
	/** Find all agent definitions whose tags include the given tag. */
	findByTag(tag: string): AgentDefinition[];
	/** Validate the manifest. Returns a list of errors (empty = valid). */
	validate(): string[];
}

/**
 * Raw manifest shape as read from JSON before validation.
 * Used internally to validate structure before casting to AgentManifest.
 */
interface RawManifest {
	version?: unknown;
	agents?: unknown;
	capabilityIndex?: unknown;
}

const MODEL_ALIASES = new Set(["sonnet", "opus", "haiku"]);

/**
 * Validate that a raw parsed object conforms to the AgentDefinition shape.
 * Returns a list of error messages for any violations.
 */
function validateAgentDefinition(name: string, raw: unknown): string[] {
	const errors: string[] = [];

	if (raw === null || typeof raw !== "object") {
		errors.push(`Agent "${name}": definition must be an object`);
		return errors;
	}

	const def = raw as Record<string, unknown>;

	if (typeof def.file !== "string" || def.file.length === 0) {
		errors.push(`Agent "${name}": "file" must be a non-empty string`);
	}

	if (typeof def.model !== "string" || def.model.length === 0) {
		errors.push(`Agent "${name}": "model" must be a non-empty string`);
	}

	if (!Array.isArray(def.tools)) {
		errors.push(`Agent "${name}": "tools" must be an array`);
	} else {
		for (let i = 0; i < def.tools.length; i++) {
			if (typeof def.tools[i] !== "string") {
				errors.push(`Agent "${name}": "tools[${i}]" must be a string`);
			}
		}
	}

	if (!Array.isArray(def.capabilities)) {
		errors.push(`Agent "${name}": "capabilities" must be an array`);
	} else {
		for (let i = 0; i < def.capabilities.length; i++) {
			if (typeof def.capabilities[i] !== "string") {
				errors.push(`Agent "${name}": "capabilities[${i}]" must be a string`);
			}
		}
	}

	if (typeof def.canSpawn !== "boolean") {
		errors.push(`Agent "${name}": "canSpawn" must be a boolean`);
	}

	if (!Array.isArray(def.constraints)) {
		errors.push(`Agent "${name}": "constraints" must be an array`);
	} else {
		for (let i = 0; i < def.constraints.length; i++) {
			if (typeof def.constraints[i] !== "string") {
				errors.push(`Agent "${name}": "constraints[${i}]" must be a string`);
			}
		}
	}

	// Tags are optional — validate only if present
	if (def.tags !== undefined) {
		if (!Array.isArray(def.tags)) {
			errors.push(`Agent "${name}": "tags" must be an array if present`);
		} else {
			for (let i = 0; i < def.tags.length; i++) {
				if (typeof def.tags[i] !== "string") {
					errors.push(`Agent "${name}": "tags[${i}]" must be a string`);
				}
			}
		}
	}

	return errors;
}

/**
 * Build a capability index: maps each capability string to the list of
 * agent names that declare that capability.
 */
function buildCapabilityIndex(agents: Record<string, AgentDefinition>): Record<string, string[]> {
	const index: Record<string, string[]> = {};

	for (const [name, def] of Object.entries(agents)) {
		for (const cap of def.capabilities) {
			const existing = index[cap];
			if (existing) {
				existing.push(name);
			} else {
				index[cap] = [name];
			}
		}
	}

	return index;
}

/**
 * Build a tag index: maps each tag string to the list of
 * agent names that declare that tag.
 */
function buildTagIndex(agents: Record<string, AgentDefinition>): Record<string, string[]> {
	const index: Record<string, string[]> = {};

	for (const [name, def] of Object.entries(agents)) {
		if (!def.tags) continue;
		for (const tag of def.tags) {
			const existing = index[tag];
			if (existing) {
				existing.push(name);
			} else {
				index[tag] = [name];
			}
		}
	}

	return index;
}

/**
 * Create a ManifestLoader that reads from the given manifest JSON path
 * and resolves agent .md files relative to the given base directory.
 *
 * @param manifestPath - Absolute path to the agent-manifest.json file
 * @param agentBaseDir - Absolute path to the directory containing agent .md files
 */
export function createManifestLoader(manifestPath: string, agentBaseDir: string): ManifestLoader {
	let manifest: AgentManifest | null = null;

	return {
		async load(): Promise<AgentManifest> {
			const file = Bun.file(manifestPath);
			const exists = await file.exists();

			if (!exists) {
				throw new AgentError(`Agent manifest not found: ${manifestPath}`);
			}

			let text: string;
			try {
				text = await file.text();
			} catch (err) {
				throw new AgentError(`Failed to read agent manifest: ${manifestPath}`, {
					cause: err instanceof Error ? err : undefined,
				});
			}

			let raw: RawManifest;
			try {
				raw = JSON.parse(text) as RawManifest;
			} catch (err) {
				throw new AgentError(`Failed to parse agent manifest as JSON: ${manifestPath}`, {
					cause: err instanceof Error ? err : undefined,
				});
			}

			// Validate top-level structure
			if (typeof raw.version !== "string" || raw.version.length === 0) {
				throw new AgentError(
					'Agent manifest missing or invalid "version" field (must be a non-empty string)',
				);
			}

			if (raw.agents === null || typeof raw.agents !== "object" || Array.isArray(raw.agents)) {
				throw new AgentError(
					'Agent manifest missing or invalid "agents" field (must be an object)',
				);
			}

			const rawAgents = raw.agents as Record<string, unknown>;

			// Validate each agent definition
			const allErrors: string[] = [];
			for (const [name, def] of Object.entries(rawAgents)) {
				const defErrors = validateAgentDefinition(name, def);
				allErrors.push(...defErrors);
			}

			if (allErrors.length > 0) {
				throw new AgentError(`Agent manifest validation failed:\n${allErrors.join("\n")}`);
			}

			// At this point, all agent definitions have been validated
			const agents = rawAgents as Record<string, AgentDefinition>;

			// Verify that all referenced .md files exist
			for (const [name, def] of Object.entries(agents)) {
				const filePath = join(agentBaseDir, def.file);
				const mdFile = Bun.file(filePath);
				const mdExists = await mdFile.exists();

				if (!mdExists) {
					throw new AgentError(
						`Agent "${name}" references file "${def.file}" which does not exist at: ${filePath}`,
						{ agentName: name },
					);
				}
			}

			// Build indexes
			const capabilityIndex = buildCapabilityIndex(agents);
			const tagIndex = buildTagIndex(agents);

			manifest = {
				version: raw.version,
				agents,
				capabilityIndex,
				tagIndex,
			};

			return manifest;
		},

		getAgent(name: string): AgentDefinition | undefined {
			if (!manifest) {
				return undefined;
			}
			return manifest.agents[name];
		},

		findByCapability(capability: string): AgentDefinition[] {
			if (!manifest) {
				return [];
			}

			const agentNames = manifest.capabilityIndex[capability];
			if (!agentNames) {
				return [];
			}

			const results: AgentDefinition[] = [];
			for (const name of agentNames) {
				const def = manifest.agents[name];
				if (def) {
					results.push(def);
				}
			}
			return results;
		},

		findByTag(tag: string): AgentDefinition[] {
			if (!manifest) {
				return [];
			}

			const agentNames = manifest.tagIndex?.[tag];
			if (!agentNames) {
				return [];
			}

			const results: AgentDefinition[] = [];
			for (const name of agentNames) {
				const def = manifest.agents[name];
				if (def) {
					results.push(def);
				}
			}
			return results;
		},

		validate(): string[] {
			if (!manifest) {
				return ["Manifest not loaded. Call load() first."];
			}

			const errors: string[] = [];

			// Re-validate each agent definition structurally
			for (const [name, def] of Object.entries(manifest.agents)) {
				const defErrors = validateAgentDefinition(name, def);
				errors.push(...defErrors);
			}

			// Verify capability index consistency
			for (const [cap, names] of Object.entries(manifest.capabilityIndex)) {
				for (const name of names) {
					const def = manifest.agents[name];
					if (!def) {
						errors.push(
							`Capability index references agent "${name}" for capability "${cap}", but agent does not exist`,
						);
					} else if (!def.capabilities.includes(cap)) {
						errors.push(
							`Capability index lists agent "${name}" under "${cap}", but agent does not declare that capability`,
						);
					}
				}
			}

			// Check that every agent capability is present in the index
			for (const [name, def] of Object.entries(manifest.agents)) {
				for (const cap of def.capabilities) {
					const indexed = manifest.capabilityIndex[cap];
					if (!indexed || !indexed.includes(name)) {
						errors.push(
							`Agent "${name}" declares capability "${cap}" but is not listed in the capability index`,
						);
					}
				}
			}

			return errors;
		},
	};
}

// === User Agent Resolution ===

/** Parsed frontmatter from a user agent definition file (.md with YAML header). */
export interface UserAgentFrontmatter {
	name?: string;
	description?: string;
	model?: string;
	color?: string;
	tags?: string[];
}

/**
 * Parse YAML frontmatter from a user agent definition file.
 *
 * User agent files use the format:
 * ```
 * ---
 * name: unix-coder
 * description: "..."
 * model: sonnet
 * color: red
 * ---
 * (agent prompt content)
 * ```
 *
 * Returns the parsed frontmatter fields and the body content separately.
 */
export function parseAgentFrontmatter(content: string): {
	frontmatter: UserAgentFrontmatter;
	body: string;
} {
	const trimmed = content.trimStart();
	if (!trimmed.startsWith("---")) {
		return { frontmatter: {}, body: content };
	}

	const endIdx = trimmed.indexOf("---", 3);
	if (endIdx === -1) {
		return { frontmatter: {}, body: content };
	}

	const fmBlock = trimmed.substring(3, endIdx).trim();
	const body = trimmed.substring(endIdx + 3).trimStart();

	const frontmatter: UserAgentFrontmatter = {};

	for (const line of fmBlock.split("\n")) {
		const colonIdx = line.indexOf(":");
		if (colonIdx === -1) continue;

		const key = line.substring(0, colonIdx).trim();
		let value = line.substring(colonIdx + 1).trim();

		// Strip surrounding quotes
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}

		switch (key) {
			case "name":
				frontmatter.name = value;
				break;
			case "model":
				frontmatter.model = value;
				break;
			case "color":
				frontmatter.color = value;
				break;
			case "description":
				frontmatter.description = value;
				break;
		}
	}

	return { frontmatter, body };
}

/**
 * Resolve a user agent file for a capability alias.
 *
 * Searches the user agent directory (and its .lazy/ subdirectory) for
 * the specified agent file. Returns the full file content if found,
 * or null if not found.
 *
 * @param userAgentDir - Absolute path to the user agent directory (e.g., ~/.claude/agents)
 * @param agentFileName - The agent filename to look for (e.g., "unix-coder.md")
 * @returns The file content if found, or null
 */
export async function resolveUserAgent(
	userAgentDir: string,
	agentFileName: string,
): Promise<string | null> {
	// Check directly in the user agent directory
	const directPath = join(userAgentDir, agentFileName);
	const directFile = Bun.file(directPath);
	if (await directFile.exists()) {
		return directFile.text();
	}

	// Check in the .lazy/ subdirectory (Claude Code lazy-loaded agents)
	const lazyPath = join(userAgentDir, ".lazy", agentFileName);
	const lazyFile = Bun.file(lazyPath);
	if (await lazyFile.exists()) {
		return lazyFile.text();
	}

	return null;
}

const DEFAULT_GATEWAY_ALIAS = "sonnet";

/**
 * Resolve provider-specific environment variables for a gateway provider.
 *
 * Returns a record of env vars to inject into the tmux session, or null if the
 * provider is not a gateway or lacks required configuration.
 */
export function resolveProviderEnv(
	providerName: string,
	modelId: string,
	providers: Record<string, ProviderConfig>,
	env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): Record<string, string> | null {
	const provider = providers[providerName];
	if (!provider || provider.type !== "gateway") return null;
	if (!provider.baseUrl) return null;

	const alias = DEFAULT_GATEWAY_ALIAS;
	const aliasUpper = alias.toUpperCase();

	const result: Record<string, string> = {
		ANTHROPIC_BASE_URL: provider.baseUrl,
		ANTHROPIC_API_KEY: "",
		[`ANTHROPIC_DEFAULT_${aliasUpper}_MODEL`]: modelId,
	};

	if (provider.authTokenEnv) {
		const token = env[provider.authTokenEnv];
		if (token) {
			result.ANTHROPIC_AUTH_TOKEN = token;
		}
	}

	return result;
}

/**
 * Resolve the model for an agent role.
 *
 * Resolution order: config.models override > manifest default > fallback.
 *
 * If the model is provider-prefixed (e.g. "openrouter/openai/gpt-5.3") and
 * the named provider is a configured gateway, returns env vars for routing.
 */
export function resolveModel(
	config: OverstoryConfig,
	manifest: AgentManifest,
	role: string,
	fallback: string,
): ResolvedModel {
	const configModel = config.models[role];
	const rawModel = configModel ?? manifest.agents[role]?.model ?? fallback;

	// Simple alias — no provider env needed
	if (MODEL_ALIASES.has(rawModel)) {
		return { model: rawModel };
	}

	// Provider-prefixed: split on first "/" to get provider name and model ID
	const slashIdx = rawModel.indexOf("/");
	if (slashIdx > 0) {
		const providerName = rawModel.substring(0, slashIdx);
		const modelId = rawModel.substring(slashIdx + 1);
		const providerEnv = resolveProviderEnv(providerName, modelId, config.providers);
		if (providerEnv) {
			return { model: DEFAULT_GATEWAY_ALIAS, env: providerEnv };
		}
	}

	// Unknown format — return as-is (may be a direct model string)
	return { model: rawModel };
}

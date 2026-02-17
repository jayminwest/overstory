import { join } from "node:path";
import { AgentError } from "../errors.ts";
import type { AgentDefinition, AgentManifest, OverstoryConfig } from "../types.ts";

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

const VALID_MODELS = new Set(["sonnet", "opus", "haiku"]);

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

	if (typeof def.model !== "string" || !VALID_MODELS.has(def.model)) {
		errors.push(`Agent "${name}": "model" must be one of: sonnet, opus, haiku`);
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

			// Build the capability index
			const capabilityIndex = buildCapabilityIndex(agents);

			manifest = {
				version: raw.version,
				agents,
				capabilityIndex,
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

type ModelName = "sonnet" | "opus" | "haiku";

/**
 * Resolve the model for an agent role.
 *
 * Resolution order: config.models override > manifest default > fallback.
 */
export function resolveModel(
	config: OverstoryConfig,
	manifest: AgentManifest,
	role: string,
	fallback: ModelName,
): ModelName {
	const configModel = config.models[role];
	if (configModel) return configModel;
	const manifestModel = manifest.agents[role]?.model;
	if (manifestModel) return manifestModel;
	return fallback;
}

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { AgentManifest } from "../types.ts";
import type { DoctorCheck, DoctorCheckFn } from "./types.ts";

const VALID_NAME_REGEX = /^[a-zA-Z0-9_-]+$/;

/**
 * Check if a path exists.
 */
async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

/**
 * Parse and validate agent-manifest.json structure.
 */
async function loadAndValidateManifest(
	overstoryDir: string,
): Promise<{ manifest: AgentManifest | null; errors: string[] }> {
	const manifestPath = join(overstoryDir, "agent-manifest.json");
	const errors: string[] = [];

	try {
		const content = await Bun.file(manifestPath).text();
		const raw = JSON.parse(content) as {
			version?: unknown;
			agents?: unknown;
			capabilityIndex?: unknown;
		};

		// Validate top-level fields
		if (typeof raw.version !== "string" || raw.version.length === 0) {
			errors.push('Missing or empty "version" field');
		}

		if (typeof raw.agents !== "object" || raw.agents === null) {
			errors.push('"agents" must be an object');
			return { manifest: null, errors };
		}

		if (typeof raw.capabilityIndex !== "object" || raw.capabilityIndex === null) {
			errors.push('"capabilityIndex" must be an object');
		}

		const agents = raw.agents as Record<string, unknown>;

		// Validate each agent definition
		for (const [name, def] of Object.entries(agents)) {
			if (typeof def !== "object" || def === null) {
				errors.push(`Agent "${name}": definition must be an object`);
				continue;
			}

			const agentDef = def as Record<string, unknown>;

			if (typeof agentDef.file !== "string" || agentDef.file.length === 0) {
				errors.push(`Agent "${name}": "file" must be a non-empty string`);
			}

			if (typeof agentDef.model !== "string" || agentDef.model.length === 0) {
				errors.push(`Agent "${name}": "model" must be a non-empty string`);
			}

			if (!Array.isArray(agentDef.tools)) {
				errors.push(`Agent "${name}": "tools" must be an array`);
			}

			if (!Array.isArray(agentDef.capabilities)) {
				errors.push(`Agent "${name}": "capabilities" must be an array`);
			} else if (agentDef.capabilities.length === 0) {
				errors.push(`Agent "${name}": must have at least one capability`);
			}

			if (typeof agentDef.canSpawn !== "boolean") {
				errors.push(`Agent "${name}": "canSpawn" must be a boolean`);
			}

			if (!Array.isArray(agentDef.constraints)) {
				errors.push(`Agent "${name}": "constraints" must be an array`);
			}
		}

		// Return manifest only if structure is valid
		if (errors.length > 0) {
			return { manifest: null, errors };
		}

		return { manifest: raw as AgentManifest, errors: [] };
	} catch (error) {
		if (error instanceof SyntaxError) {
			errors.push("Invalid JSON syntax");
		} else {
			errors.push(error instanceof Error ? error.message : "Failed to read manifest");
		}
		return { manifest: null, errors };
	}
}

/**
 * Validate capability index bidirectional consistency.
 */
function validateCapabilityIndex(manifest: AgentManifest): string[] {
	const errors: string[] = [];

	// Build expected index from agent definitions
	const expectedIndex: Record<string, string[]> = {};
	for (const [name, def] of Object.entries(manifest.agents)) {
		for (const cap of def.capabilities) {
			const existing = expectedIndex[cap];
			if (existing) {
				existing.push(name);
			} else {
				expectedIndex[cap] = [name];
			}
		}
	}

	// Check that declared index matches expected
	for (const [cap, agentNames] of Object.entries(manifest.capabilityIndex)) {
		const expected = expectedIndex[cap];
		if (!expected) {
			errors.push(`Capability "${cap}" in index but no agents declare it`);
			continue;
		}

		const missing = expected.filter((name) => !agentNames.includes(name));
		const extra = agentNames.filter((name) => !expected.includes(name));

		if (missing.length > 0) {
			errors.push(`Capability "${cap}": missing agents in index: ${missing.join(", ")}`);
		}

		if (extra.length > 0) {
			errors.push(`Capability "${cap}": extra agents in index: ${extra.join(", ")}`);
		}
	}

	// Check for missing capabilities in index
	for (const [cap, agentNames] of Object.entries(expectedIndex)) {
		if (!manifest.capabilityIndex[cap]) {
			errors.push(
				`Capability "${cap}" declared by ${agentNames.join(", ")} but missing from index`,
			);
		}
	}

	// Check for capabilities with zero providers
	for (const [cap, agentNames] of Object.entries(expectedIndex)) {
		if (agentNames.length === 0) {
			errors.push(`Capability "${cap}" has zero providers`);
		}
	}

	return errors;
}

/**
 * Parse a simple YAML identity file.
 */
function parseIdentityYaml(text: string): {
	name?: string;
	capability?: string;
	created?: string;
	sessionsCompleted?: number;
} {
	const lines = text.split("\n");
	const identity: {
		name?: string;
		capability?: string;
		created?: string;
		sessionsCompleted?: number;
	} = {};

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;

		const colonIndex = trimmed.indexOf(":");
		if (colonIndex === -1) continue;

		const key = trimmed.slice(0, colonIndex).trim();
		let value = trimmed.slice(colonIndex + 1).trim();

		// Remove quotes if present
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}

		if (key === "name") {
			identity.name = value;
		} else if (key === "capability") {
			identity.capability = value;
		} else if (key === "created") {
			identity.created = value;
		} else if (key === "sessionsCompleted") {
			identity.sessionsCompleted = Number.parseInt(value, 10);
		}
	}

	return identity;
}

/**
 * Agent state checks.
 * Validates agent definitions, tmux sessions, and agent identity files.
 */
export const checkAgents: DoctorCheckFn = async (_config, overstoryDir): Promise<DoctorCheck[]> => {
	const checks: DoctorCheck[] = [];

	// Check 1: Parse agent-manifest.json
	const { manifest, errors: parseErrors } = await loadAndValidateManifest(overstoryDir);

	if (parseErrors.length > 0) {
		checks.push({
			name: "Manifest parsing",
			category: "agents",
			status: "fail",
			message: `Found ${parseErrors.length} error(s)`,
			details: parseErrors,
			fixable: false,
		});
		return checks; // Can't proceed without valid manifest
	}

	checks.push({
		name: "Manifest parsing",
		category: "agents",
		status: "pass",
		message: "JSON parses successfully",
		fixable: false,
	});

	if (!manifest) {
		return checks;
	}

	// Check 2: Validate referenced .md files exist
	const agentDefsDir = join(overstoryDir, "agent-defs");
	const missingFiles: string[] = [];

	for (const [name, def] of Object.entries(manifest.agents)) {
		const filePath = join(agentDefsDir, def.file);
		const exists = await pathExists(filePath);
		if (!exists) {
			missingFiles.push(`${name}: ${def.file}`);
		}
	}

	checks.push({
		name: "Agent definition files",
		category: "agents",
		status: missingFiles.length === 0 ? "pass" : "fail",
		message:
			missingFiles.length === 0 ? "All .md files found" : `Missing ${missingFiles.length} file(s)`,
		details: missingFiles.length > 0 ? missingFiles : undefined,
		fixable: missingFiles.length > 0,
	});

	// Check 3: Capability index consistency
	const indexErrors = validateCapabilityIndex(manifest);

	checks.push({
		name: "Capability index",
		category: "agents",
		status: indexErrors.length === 0 ? "pass" : "warn",
		message:
			indexErrors.length === 0 ? "Index is consistent" : `Found ${indexErrors.length} issue(s)`,
		details: indexErrors.length > 0 ? indexErrors : undefined,
		fixable: indexErrors.length > 0,
	});

	// Check 4: Validate identity files
	const agentsDir = join(overstoryDir, "agents");
	const agentsDirExists = await pathExists(agentsDir);

	if (!agentsDirExists) {
		checks.push({
			name: "Agent identities",
			category: "agents",
			status: "pass",
			message: "No agent identities yet (agents/ directory missing)",
			fixable: false,
		});
		return checks;
	}

	try {
		const identityErrors: string[] = [];
		const staleIdentities: string[] = [];
		const agentDirs = await readdir(agentsDir, { withFileTypes: true });
		let identityFileCount = 0;

		for (const dir of agentDirs) {
			if (!dir.isDirectory()) continue;

			const agentName = dir.name;
			const identityPath = join(agentsDir, agentName, "identity.yaml");
			const identityExists = await pathExists(identityPath);

			if (!identityExists) {
				continue; // Skip if no identity file
			}

			identityFileCount++;

			// Parse and validate identity
			try {
				const content = await Bun.file(identityPath).text();
				const identity = parseIdentityYaml(content);

				if (!identity.name) {
					identityErrors.push(`${agentName}: missing "name" field`);
				}

				if (!identity.capability) {
					identityErrors.push(`${agentName}: missing "capability" field`);
				}

				if (!identity.created) {
					identityErrors.push(`${agentName}: missing "created" field`);
				} else {
					// Validate ISO timestamp format
					const timestamp = new Date(identity.created);
					if (Number.isNaN(timestamp.getTime())) {
						identityErrors.push(`${agentName}: invalid "created" timestamp`);
					}
				}

				if (typeof identity.sessionsCompleted !== "number" || identity.sessionsCompleted < 0) {
					identityErrors.push(`${agentName}: "sessionsCompleted" must be a non-negative integer`);
				}

				// Identity directories are keyed by runtime agent names (for example
				// lead-foo-1234), not by manifest role names. Validate the recorded
				// role/capability against the manifest instead of the directory name.
				if (identity.capability && !manifest.agents[identity.capability]) {
					staleIdentities.push(`${agentName} (capability: ${identity.capability})`);
				}

				// Validate name is valid identifier
				if (identity.name && !VALID_NAME_REGEX.test(identity.name)) {
					identityErrors.push(
						`${agentName}: name "${identity.name}" contains invalid characters (use alphanumeric, dash, underscore only)`,
					);
				}
			} catch (error) {
				identityErrors.push(
					`${agentName}: ${error instanceof Error ? error.message : "failed to parse YAML"}`,
				);
			}
		}

		if (identityErrors.length > 0) {
			checks.push({
				name: "Identity validation",
				category: "agents",
				status: "warn",
				message: `Found ${identityErrors.length} issue(s)`,
				details: identityErrors,
				fixable: false,
			});
		} else if (identityFileCount > 0) {
			checks.push({
				name: "Identity validation",
				category: "agents",
				status: "pass",
				message: "All identity files are valid",
				fixable: false,
			});
		}

		if (staleIdentities.length > 0) {
			checks.push({
				name: "Stale identities",
				category: "agents",
				status: "warn",
				message: `Found ${staleIdentities.length} stale identity file(s)`,
				details: staleIdentities.map((name) => `${name} (role not present in manifest)`),
				fixable: true,
			});
		}
	} catch {
		// Ignore errors reading agents directory
	}

	return checks;
};

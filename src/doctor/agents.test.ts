/**
 * Tests for agents doctor checks.
 *
 * Uses temp directories with real filesystem operations.
 * No mocks needed -- all operations are cheap and local.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OverstoryConfig } from "../types.ts";
import { checkAgents } from "./agents.ts";

describe("checkAgents", () => {
	let tempDir: string;
	let overstoryDir: string;
	let mockConfig: OverstoryConfig;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "agents-test-"));
		overstoryDir = join(tempDir, ".overstory");
		await mkdir(overstoryDir, { recursive: true });

		mockConfig = {
			project: {
				name: "test-project",
				root: tempDir,
				canonicalBranch: "main",
			},
			agents: {
				manifestPath: ".overstory/agent-manifest.json",
				baseDir: ".overstory/agent-defs",
				maxConcurrent: 5,
				staggerDelayMs: 1000,
				maxDepth: 2,
				maxSessionsPerRun: 0,
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
				aiResolveEnabled: false,
				reimagineEnabled: false,
			},
			providers: {
				anthropic: { type: "native" },
			},
			watchdog: {
				tier0Enabled: true,
				tier0IntervalMs: 30000,
				tier1Enabled: false,
				tier2Enabled: false,
				staleThresholdMs: 300000,
				zombieThresholdMs: 600000,
				nudgeIntervalMs: 60000,
			},
			models: {},
			logging: {
				verbose: false,
				redactSecrets: true,
			},
		};
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	test("fails when manifest is missing", async () => {
		const checks = await checkAgents(mockConfig, overstoryDir);

		const parseCheck = checks.find((c) => c.name === "Manifest parsing");
		expect(parseCheck).toBeDefined();
		expect(parseCheck?.status).toBe("fail");
	});

	test("fails when manifest has invalid JSON", async () => {
		await Bun.write(join(overstoryDir, "agent-manifest.json"), "invalid json{");

		const checks = await checkAgents(mockConfig, overstoryDir);

		const parseCheck = checks.find((c) => c.name === "Manifest parsing");
		expect(parseCheck?.status).toBe("fail");
		expect(parseCheck?.details?.some((d) => d.includes("JSON"))).toBe(true);
	});

	test("passes when manifest is valid", async () => {
		const manifest = {
			version: "1.0",
			agents: {
				scout: {
					file: "scout.md",
					model: "haiku",
					tools: ["Read"],
					capabilities: ["explore"],
					canSpawn: false,
					constraints: [],
				},
			},
			capabilityIndex: {
				explore: ["scout"],
			},
		};

		await mkdir(join(overstoryDir, "agent-defs"), { recursive: true });
		await Bun.write(join(overstoryDir, "agent-manifest.json"), JSON.stringify(manifest, null, 2));
		await Bun.write(join(overstoryDir, "agent-defs", "scout.md"), "# Scout");

		const checks = await checkAgents(mockConfig, overstoryDir);

		const parseCheck = checks.find((c) => c.name === "Manifest parsing");
		expect(parseCheck?.status).toBe("pass");
	});

	test("fails when agent has invalid model", async () => {
		const manifest = {
			version: "1.0",
			agents: {
				scout: {
					file: "scout.md",
					model: "invalid-model",
					tools: ["Read"],
					capabilities: ["explore"],
					canSpawn: false,
					constraints: [],
				},
			},
			capabilityIndex: {
				explore: ["scout"],
			},
		};

		await Bun.write(join(overstoryDir, "agent-manifest.json"), JSON.stringify(manifest, null, 2));

		const checks = await checkAgents(mockConfig, overstoryDir);

		const parseCheck = checks.find((c) => c.name === "Manifest parsing");
		expect(parseCheck?.status).toBe("fail");
		expect(parseCheck?.details?.some((d) => d.includes("model"))).toBe(true);
	});

	test("fails when agent has zero capabilities", async () => {
		const manifest = {
			version: "1.0",
			agents: {
				scout: {
					file: "scout.md",
					model: "haiku",
					tools: ["Read"],
					capabilities: [],
					canSpawn: false,
					constraints: [],
				},
			},
			capabilityIndex: {},
		};

		await Bun.write(join(overstoryDir, "agent-manifest.json"), JSON.stringify(manifest, null, 2));

		const checks = await checkAgents(mockConfig, overstoryDir);

		const parseCheck = checks.find((c) => c.name === "Manifest parsing");
		expect(parseCheck?.status).toBe("fail");
		expect(parseCheck?.details?.some((d) => d.includes("capability"))).toBe(true);
	});

	test("fails when referenced .md file is missing", async () => {
		const manifest = {
			version: "1.0",
			agents: {
				scout: {
					file: "scout.md",
					model: "haiku",
					tools: ["Read"],
					capabilities: ["explore"],
					canSpawn: false,
					constraints: [],
				},
			},
			capabilityIndex: {
				explore: ["scout"],
			},
		};

		await mkdir(join(overstoryDir, "agent-defs"), { recursive: true });
		await Bun.write(join(overstoryDir, "agent-manifest.json"), JSON.stringify(manifest, null, 2));
		// Don't create scout.md

		const checks = await checkAgents(mockConfig, overstoryDir);

		const filesCheck = checks.find((c) => c.name === "Agent definition files");
		expect(filesCheck?.status).toBe("fail");
		expect(filesCheck?.details?.some((d) => d.includes("scout.md"))).toBe(true);
	});

	test("warns when capability index is inconsistent", async () => {
		const manifest = {
			version: "1.0",
			agents: {
				scout: {
					file: "scout.md",
					model: "haiku",
					tools: ["Read"],
					capabilities: ["explore", "research"],
					canSpawn: false,
					constraints: [],
				},
			},
			capabilityIndex: {
				explore: ["scout"],
				// Missing "research" from index
			},
		};

		await mkdir(join(overstoryDir, "agent-defs"), { recursive: true });
		await Bun.write(join(overstoryDir, "agent-manifest.json"), JSON.stringify(manifest, null, 2));
		await Bun.write(join(overstoryDir, "agent-defs", "scout.md"), "# Scout");

		const checks = await checkAgents(mockConfig, overstoryDir);

		const indexCheck = checks.find((c) => c.name === "Capability index");
		expect(indexCheck?.status).toBe("warn");
		expect(indexCheck?.details?.some((d) => d.includes("research"))).toBe(true);
	});

	test("passes when no identity files exist", async () => {
		const manifest = {
			version: "1.0",
			agents: {
				scout: {
					file: "scout.md",
					model: "haiku",
					tools: ["Read"],
					capabilities: ["explore"],
					canSpawn: false,
					constraints: [],
				},
			},
			capabilityIndex: {
				explore: ["scout"],
			},
		};

		await mkdir(join(overstoryDir, "agent-defs"), { recursive: true });
		await Bun.write(join(overstoryDir, "agent-manifest.json"), JSON.stringify(manifest, null, 2));
		await Bun.write(join(overstoryDir, "agent-defs", "scout.md"), "# Scout");

		const checks = await checkAgents(mockConfig, overstoryDir);

		const identityCheck = checks.find((c) => c.name === "Agent identities");
		expect(identityCheck?.status).toBe("pass");
	});

	test("validates identity files correctly", async () => {
		const manifest = {
			version: "1.0",
			agents: {
				scout: {
					file: "scout.md",
					model: "haiku",
					tools: ["Read"],
					capabilities: ["explore"],
					canSpawn: false,
					constraints: [],
				},
			},
			capabilityIndex: {
				explore: ["scout"],
			},
		};

		await mkdir(join(overstoryDir, "agent-defs"), { recursive: true });
		await mkdir(join(overstoryDir, "agents", "scout"), { recursive: true });
		await Bun.write(join(overstoryDir, "agent-manifest.json"), JSON.stringify(manifest, null, 2));
		await Bun.write(join(overstoryDir, "agent-defs", "scout.md"), "# Scout");

		const identity = `name: scout
capability: explore
created: "2024-01-01T00:00:00Z"
sessionsCompleted: 5
expertiseDomains: []
recentTasks: []
`;

		await Bun.write(join(overstoryDir, "agents", "scout", "identity.yaml"), identity);

		const checks = await checkAgents(mockConfig, overstoryDir);

		const identityCheck = checks.find((c) => c.name === "Identity validation");
		expect(identityCheck?.status).toBe("pass");
	});

	test("warns when identity has invalid timestamp", async () => {
		const manifest = {
			version: "1.0",
			agents: {
				scout: {
					file: "scout.md",
					model: "haiku",
					tools: ["Read"],
					capabilities: ["explore"],
					canSpawn: false,
					constraints: [],
				},
			},
			capabilityIndex: {
				explore: ["scout"],
			},
		};

		await mkdir(join(overstoryDir, "agent-defs"), { recursive: true });
		await mkdir(join(overstoryDir, "agents", "scout"), { recursive: true });
		await Bun.write(join(overstoryDir, "agent-manifest.json"), JSON.stringify(manifest, null, 2));
		await Bun.write(join(overstoryDir, "agent-defs", "scout.md"), "# Scout");

		const identity = `name: scout
capability: explore
created: "invalid-timestamp"
sessionsCompleted: 5
`;

		await Bun.write(join(overstoryDir, "agents", "scout", "identity.yaml"), identity);

		const checks = await checkAgents(mockConfig, overstoryDir);

		const identityCheck = checks.find((c) => c.name === "Identity validation");
		expect(identityCheck?.status).toBe("warn");
		expect(identityCheck?.details?.some((d) => d.includes("timestamp"))).toBe(true);
	});

	test("warns when identity has negative sessionsCompleted", async () => {
		const manifest = {
			version: "1.0",
			agents: {
				scout: {
					file: "scout.md",
					model: "haiku",
					tools: ["Read"],
					capabilities: ["explore"],
					canSpawn: false,
					constraints: [],
				},
			},
			capabilityIndex: {
				explore: ["scout"],
			},
		};

		await mkdir(join(overstoryDir, "agent-defs"), { recursive: true });
		await mkdir(join(overstoryDir, "agents", "scout"), { recursive: true });
		await Bun.write(join(overstoryDir, "agent-manifest.json"), JSON.stringify(manifest, null, 2));
		await Bun.write(join(overstoryDir, "agent-defs", "scout.md"), "# Scout");

		const identity = `name: scout
capability: explore
created: "2024-01-01T00:00:00Z"
sessionsCompleted: -5
`;

		await Bun.write(join(overstoryDir, "agents", "scout", "identity.yaml"), identity);

		const checks = await checkAgents(mockConfig, overstoryDir);

		const identityCheck = checks.find((c) => c.name === "Identity validation");
		expect(identityCheck?.status).toBe("warn");
		expect(identityCheck?.details?.some((d) => d.includes("sessionsCompleted"))).toBe(true);
	});

	test("warns about stale identity files", async () => {
		const manifest = {
			version: "1.0",
			agents: {
				scout: {
					file: "scout.md",
					model: "haiku",
					tools: ["Read"],
					capabilities: ["explore"],
					canSpawn: false,
					constraints: [],
				},
			},
			capabilityIndex: {
				explore: ["scout"],
			},
		};

		await mkdir(join(overstoryDir, "agent-defs"), { recursive: true });
		await mkdir(join(overstoryDir, "agents", "old-agent"), { recursive: true });
		await Bun.write(join(overstoryDir, "agent-manifest.json"), JSON.stringify(manifest, null, 2));
		await Bun.write(join(overstoryDir, "agent-defs", "scout.md"), "# Scout");

		const staleIdentity = `name: old-agent
capability: obsolete
created: "2024-01-01T00:00:00Z"
sessionsCompleted: 5
`;

		await Bun.write(join(overstoryDir, "agents", "old-agent", "identity.yaml"), staleIdentity);

		const checks = await checkAgents(mockConfig, overstoryDir);

		const staleCheck = checks.find((c) => c.name === "Stale identities");
		expect(staleCheck?.status).toBe("warn");
		expect(staleCheck?.details?.some((d) => d.includes("old-agent"))).toBe(true);
	});

	test("warns when identity name contains invalid characters", async () => {
		const manifest = {
			version: "1.0",
			agents: {
				scout: {
					file: "scout.md",
					model: "haiku",
					tools: ["Read"],
					capabilities: ["explore"],
					canSpawn: false,
					constraints: [],
				},
			},
			capabilityIndex: {
				explore: ["scout"],
			},
		};

		await mkdir(join(overstoryDir, "agent-defs"), { recursive: true });
		await mkdir(join(overstoryDir, "agents", "scout"), { recursive: true });
		await Bun.write(join(overstoryDir, "agent-manifest.json"), JSON.stringify(manifest, null, 2));
		await Bun.write(join(overstoryDir, "agent-defs", "scout.md"), "# Scout");

		const identity = `name: "scout@invalid!"
capability: explore
created: "2024-01-01T00:00:00Z"
sessionsCompleted: 5
`;

		await Bun.write(join(overstoryDir, "agents", "scout", "identity.yaml"), identity);

		const checks = await checkAgents(mockConfig, overstoryDir);

		const identityCheck = checks.find((c) => c.name === "Identity validation");
		expect(identityCheck?.status).toBe("warn");
		expect(identityCheck?.details?.some((d) => d.includes("invalid characters"))).toBe(true);
	});
});

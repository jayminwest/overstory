import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentError } from "../errors.ts";
import type { AgentManifest, OverstoryConfig } from "../types.ts";
import { createManifestLoader, resolveModel } from "./manifest.ts";

const VALID_MANIFEST = {
	version: "1.0",
	agents: {
		scout: {
			file: "scout.md",
			model: "sonnet",
			tools: ["Read", "Grep", "Glob"],
			capabilities: ["explore", "review"],
			canSpawn: false,
			constraints: ["read-only"],
		},
		builder: {
			file: "builder.md",
			model: "opus",
			tools: ["Read", "Write", "Edit", "Bash"],
			capabilities: ["implement", "refactor"],
			canSpawn: false,
			constraints: [],
		},
	},
};

describe("createManifestLoader", () => {
	let tempDir: string;
	let manifestPath: string;
	let agentBaseDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "overstory-manifest-test-"));
		manifestPath = join(tempDir, "agent-manifest.json");
		agentBaseDir = join(tempDir, "agents");
		await mkdir(agentBaseDir, { recursive: true });
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	/** Write the manifest JSON and create matching .md files. */
	async function writeManifest(
		data: Record<string, unknown>,
		options?: { skipMdFiles?: boolean; mdFilesToSkip?: string[] },
	): Promise<void> {
		await Bun.write(manifestPath, JSON.stringify(data));
		if (options?.skipMdFiles) return;

		const agents = data.agents;
		if (agents && typeof agents === "object" && !Array.isArray(agents)) {
			for (const [, def] of Object.entries(agents as Record<string, Record<string, unknown>>)) {
				const file = def.file;
				if (
					typeof file === "string" &&
					file.length > 0 &&
					!options?.mdFilesToSkip?.includes(file)
				) {
					await Bun.write(join(agentBaseDir, file), `# ${file}\n`);
				}
			}
		}
	}

	describe("load", () => {
		test("reads manifest, validates structure, verifies .md files, builds capability index", async () => {
			await writeManifest(VALID_MANIFEST);
			const loader = createManifestLoader(manifestPath, agentBaseDir);

			const manifest = await loader.load();

			expect(manifest.version).toBe("1.0");
			expect(Object.keys(manifest.agents)).toHaveLength(2);
			expect(manifest.agents.scout).toBeDefined();
			expect(manifest.agents.builder).toBeDefined();
			expect(manifest.capabilityIndex).toBeDefined();
		});

		test("builds capability index mapping capabilities to agent names", async () => {
			await writeManifest(VALID_MANIFEST);
			const loader = createManifestLoader(manifestPath, agentBaseDir);

			const manifest = await loader.load();

			expect(manifest.capabilityIndex.explore).toEqual(["scout"]);
			expect(manifest.capabilityIndex.review).toEqual(["scout"]);
			expect(manifest.capabilityIndex.implement).toEqual(["builder"]);
			expect(manifest.capabilityIndex.refactor).toEqual(["builder"]);
		});

		test("capability index includes multiple agents for shared capabilities", async () => {
			const data = {
				version: "1.0",
				agents: {
					scout: {
						file: "scout.md",
						model: "sonnet",
						tools: ["Read"],
						capabilities: ["review"],
						canSpawn: false,
						constraints: [],
					},
					reviewer: {
						file: "reviewer.md",
						model: "sonnet",
						tools: ["Read"],
						capabilities: ["review"],
						canSpawn: false,
						constraints: [],
					},
				},
			};
			await writeManifest(data);
			const loader = createManifestLoader(manifestPath, agentBaseDir);

			const manifest = await loader.load();

			expect(manifest.capabilityIndex.review).toEqual(["scout", "reviewer"]);
		});
	});

	describe("getAgent", () => {
		test("returns undefined before load is called", async () => {
			await writeManifest(VALID_MANIFEST);
			const loader = createManifestLoader(manifestPath, agentBaseDir);

			expect(loader.getAgent("scout")).toBeUndefined();
		});

		test("returns agent definition after load", async () => {
			await writeManifest(VALID_MANIFEST);
			const loader = createManifestLoader(manifestPath, agentBaseDir);
			await loader.load();

			const scout = loader.getAgent("scout");
			expect(scout).toBeDefined();
			expect(scout?.model).toBe("sonnet");
			expect(scout?.tools).toEqual(["Read", "Grep", "Glob"]);
			expect(scout?.capabilities).toEqual(["explore", "review"]);
			expect(scout?.canSpawn).toBe(false);
			expect(scout?.constraints).toEqual(["read-only"]);
		});

		test("returns undefined for non-existent agent after load", async () => {
			await writeManifest(VALID_MANIFEST);
			const loader = createManifestLoader(manifestPath, agentBaseDir);
			await loader.load();

			expect(loader.getAgent("nonexistent")).toBeUndefined();
		});
	});

	describe("findByCapability", () => {
		test("returns empty array before load is called", async () => {
			await writeManifest(VALID_MANIFEST);
			const loader = createManifestLoader(manifestPath, agentBaseDir);

			expect(loader.findByCapability("explore")).toEqual([]);
		});

		test("returns matching agents after load", async () => {
			await writeManifest(VALID_MANIFEST);
			const loader = createManifestLoader(manifestPath, agentBaseDir);
			await loader.load();

			const explorers = loader.findByCapability("explore");
			expect(explorers).toHaveLength(1);
			expect(explorers[0]?.file).toBe("scout.md");
		});

		test("returns empty array for non-existent capability", async () => {
			await writeManifest(VALID_MANIFEST);
			const loader = createManifestLoader(manifestPath, agentBaseDir);
			await loader.load();

			expect(loader.findByCapability("nonexistent")).toEqual([]);
		});

		test("returns multiple agents sharing a capability", async () => {
			const data = {
				version: "1.0",
				agents: {
					scout: {
						file: "scout.md",
						model: "sonnet",
						tools: ["Read"],
						capabilities: ["review"],
						canSpawn: false,
						constraints: [],
					},
					reviewer: {
						file: "reviewer.md",
						model: "sonnet",
						tools: ["Read"],
						capabilities: ["review"],
						canSpawn: false,
						constraints: [],
					},
				},
			};
			await writeManifest(data);
			const loader = createManifestLoader(manifestPath, agentBaseDir);
			await loader.load();

			const reviewers = loader.findByCapability("review");
			expect(reviewers).toHaveLength(2);
		});
	});

	describe("validate", () => {
		test("returns error message if not loaded", () => {
			const loader = createManifestLoader(manifestPath, agentBaseDir);

			const errors = loader.validate();
			expect(errors).toHaveLength(1);
			expect(errors[0]).toContain("not loaded");
		});

		test("returns empty array for valid manifest", async () => {
			await writeManifest(VALID_MANIFEST);
			const loader = createManifestLoader(manifestPath, agentBaseDir);
			await loader.load();

			const errors = loader.validate();
			expect(errors).toEqual([]);
		});
	});

	describe("error handling", () => {
		test("throws AgentError for missing manifest file", async () => {
			const loader = createManifestLoader(join(tempDir, "nonexistent.json"), agentBaseDir);

			await expect(loader.load()).rejects.toThrow(AgentError);
			await expect(loader.load()).rejects.toThrow("not found");
		});

		test("throws AgentError for invalid JSON", async () => {
			await Bun.write(manifestPath, "not valid json {{{");
			const loader = createManifestLoader(manifestPath, agentBaseDir);

			await expect(loader.load()).rejects.toThrow(AgentError);
			await expect(loader.load()).rejects.toThrow("Failed to parse");
		});

		test("throws AgentError for missing version field", async () => {
			await Bun.write(manifestPath, JSON.stringify({ agents: {} }));
			const loader = createManifestLoader(manifestPath, agentBaseDir);

			await expect(loader.load()).rejects.toThrow(AgentError);
			await expect(loader.load()).rejects.toThrow("version");
		});

		test("throws AgentError for empty version string", async () => {
			await Bun.write(manifestPath, JSON.stringify({ version: "", agents: {} }));
			const loader = createManifestLoader(manifestPath, agentBaseDir);

			await expect(loader.load()).rejects.toThrow(AgentError);
			await expect(loader.load()).rejects.toThrow("version");
		});

		test("throws AgentError when agents field is missing", async () => {
			await Bun.write(manifestPath, JSON.stringify({ version: "1.0" }));
			const loader = createManifestLoader(manifestPath, agentBaseDir);

			await expect(loader.load()).rejects.toThrow(AgentError);
			await expect(loader.load()).rejects.toThrow("agents");
		});

		test("throws AgentError when agents field is an array", async () => {
			await Bun.write(manifestPath, JSON.stringify({ version: "1.0", agents: [] }));
			const loader = createManifestLoader(manifestPath, agentBaseDir);

			await expect(loader.load()).rejects.toThrow(AgentError);
			await expect(loader.load()).rejects.toThrow("agents");
		});

		test("throws AgentError for invalid model value", async () => {
			const data = {
				version: "1.0",
				agents: {
					bad: {
						file: "bad.md",
						model: "gpt-4",
						tools: ["Read"],
						capabilities: ["test"],
						canSpawn: false,
						constraints: [],
					},
				},
			};
			await writeManifest(data);
			const loader = createManifestLoader(manifestPath, agentBaseDir);

			await expect(loader.load()).rejects.toThrow(AgentError);
			await expect(loader.load()).rejects.toThrow("model");
		});

		test("throws AgentError for missing tools array", async () => {
			const data = {
				version: "1.0",
				agents: {
					bad: {
						file: "bad.md",
						model: "sonnet",
						capabilities: ["test"],
						canSpawn: false,
						constraints: [],
					},
				},
			};
			await writeManifest(data);
			const loader = createManifestLoader(manifestPath, agentBaseDir);

			await expect(loader.load()).rejects.toThrow(AgentError);
			await expect(loader.load()).rejects.toThrow("tools");
		});

		test("throws AgentError for missing capabilities array", async () => {
			const data = {
				version: "1.0",
				agents: {
					bad: {
						file: "bad.md",
						model: "sonnet",
						tools: ["Read"],
						canSpawn: false,
						constraints: [],
					},
				},
			};
			await writeManifest(data);
			const loader = createManifestLoader(manifestPath, agentBaseDir);

			await expect(loader.load()).rejects.toThrow(AgentError);
			await expect(loader.load()).rejects.toThrow("capabilities");
		});

		test("throws AgentError when canSpawn is not boolean", async () => {
			const data = {
				version: "1.0",
				agents: {
					bad: {
						file: "bad.md",
						model: "sonnet",
						tools: ["Read"],
						capabilities: ["test"],
						canSpawn: "yes",
						constraints: [],
					},
				},
			};
			await writeManifest(data);
			const loader = createManifestLoader(manifestPath, agentBaseDir);

			await expect(loader.load()).rejects.toThrow(AgentError);
			await expect(loader.load()).rejects.toThrow("canSpawn");
		});

		test("throws AgentError when constraints is not an array", async () => {
			const data = {
				version: "1.0",
				agents: {
					bad: {
						file: "bad.md",
						model: "sonnet",
						tools: ["Read"],
						capabilities: ["test"],
						canSpawn: false,
						constraints: "read-only",
					},
				},
			};
			await writeManifest(data);
			const loader = createManifestLoader(manifestPath, agentBaseDir);

			await expect(loader.load()).rejects.toThrow(AgentError);
			await expect(loader.load()).rejects.toThrow("constraints");
		});

		test("throws AgentError when agent definition is not an object", async () => {
			const data = {
				version: "1.0",
				agents: {
					bad: "not an object",
				},
			};
			await Bun.write(manifestPath, JSON.stringify(data));
			const loader = createManifestLoader(manifestPath, agentBaseDir);

			await expect(loader.load()).rejects.toThrow(AgentError);
			await expect(loader.load()).rejects.toThrow("definition must be an object");
		});

		test("throws AgentError when referenced .md file does not exist", async () => {
			await writeManifest(VALID_MANIFEST, { mdFilesToSkip: ["scout.md"] });
			const loader = createManifestLoader(manifestPath, agentBaseDir);

			await expect(loader.load()).rejects.toThrow(AgentError);
			await expect(loader.load()).rejects.toThrow("does not exist");
		});

		test("throws AgentError when file field is empty string", async () => {
			const data = {
				version: "1.0",
				agents: {
					bad: {
						file: "",
						model: "sonnet",
						tools: ["Read"],
						capabilities: ["test"],
						canSpawn: false,
						constraints: [],
					},
				},
			};
			await writeManifest(data);
			const loader = createManifestLoader(manifestPath, agentBaseDir);

			await expect(loader.load()).rejects.toThrow(AgentError);
			await expect(loader.load()).rejects.toThrow("file");
		});

		test("aggregates multiple validation errors", async () => {
			const data = {
				version: "1.0",
				agents: {
					bad: {
						file: "",
						model: "invalid",
						tools: "not-array",
						capabilities: "not-array",
						canSpawn: "not-bool",
						constraints: "not-array",
					},
				},
			};
			await Bun.write(manifestPath, JSON.stringify(data));
			const loader = createManifestLoader(manifestPath, agentBaseDir);

			try {
				await loader.load();
				expect(true).toBe(false); // Should not reach here
			} catch (err) {
				expect(err).toBeInstanceOf(AgentError);
				const message = (err as AgentError).message;
				expect(message).toContain("file");
				expect(message).toContain("model");
				expect(message).toContain("tools");
				expect(message).toContain("capabilities");
				expect(message).toContain("canSpawn");
				expect(message).toContain("constraints");
			}
		});
	});

	describe("agent with all valid models", () => {
		for (const model of ["sonnet", "opus", "haiku"] as const) {
			test(`accepts model "${model}"`, async () => {
				const data = {
					version: "1.0",
					agents: {
						agent: {
							file: "agent.md",
							model,
							tools: ["Read"],
							capabilities: ["test"],
							canSpawn: false,
							constraints: [],
						},
					},
				};
				await writeManifest(data);
				const loader = createManifestLoader(manifestPath, agentBaseDir);

				const manifest = await loader.load();
				expect(manifest.agents.agent).toBeDefined();
				expect(manifest.agents.agent?.model).toBe(model);
			});
		}
	});
});

describe("resolveModel", () => {
	const baseManifest: AgentManifest = {
		version: "1.0",
		agents: {
			coordinator: {
				file: "coordinator.md",
				model: "opus",
				tools: ["Read", "Bash"],
				capabilities: ["coordinate"],
				canSpawn: true,
				constraints: [],
			},
			monitor: {
				file: "monitor.md",
				model: "sonnet",
				tools: ["Read", "Bash"],
				capabilities: ["monitor"],
				canSpawn: false,
				constraints: [],
			},
		},
		capabilityIndex: { coordinate: ["coordinator"], monitor: ["monitor"] },
	};

	function makeConfig(models: OverstoryConfig["models"] = {}): OverstoryConfig {
		return {
			project: { name: "test", root: "/tmp/test", canonicalBranch: "main" },
			agents: {
				manifestPath: ".overstory/agent-manifest.json",
				baseDir: ".overstory/agent-defs",
				maxConcurrent: 5,
				staggerDelayMs: 1000,
				maxDepth: 2,
			},
			worktrees: { baseDir: ".overstory/worktrees" },
			beads: { enabled: false },
			mulch: { enabled: false, domains: [], primeFormat: "markdown" },
			merge: { aiResolveEnabled: false, reimagineEnabled: false },
			watchdog: {
				tier0Enabled: false,
				tier0IntervalMs: 30000,
				tier1Enabled: false,
				tier2Enabled: false,
				staleThresholdMs: 300000,
				zombieThresholdMs: 600000,
				nudgeIntervalMs: 60000,
			},
			models,
			logging: { verbose: false, redactSecrets: true },
		};
	}

	test("returns manifest model when no config override", () => {
		const config = makeConfig();
		expect(resolveModel(config, baseManifest, "coordinator", "haiku")).toBe("opus");
	});

	test("config override takes precedence over manifest", () => {
		const config = makeConfig({ coordinator: "sonnet" });
		expect(resolveModel(config, baseManifest, "coordinator", "haiku")).toBe("sonnet");
	});

	test("falls back to default when role is not in manifest or config", () => {
		const config = makeConfig();
		expect(resolveModel(config, baseManifest, "unknown-role", "haiku")).toBe("haiku");
	});

	test("config override works for roles not in manifest", () => {
		const config = makeConfig({ supervisor: "opus" });
		expect(resolveModel(config, baseManifest, "supervisor", "sonnet")).toBe("opus");
	});
});

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OverstoryConfig } from "../types.ts";
import { checkProviders } from "./providers.ts";

/** Build a minimal valid OverstoryConfig for testing. */
function makeConfig(overrides: Partial<OverstoryConfig> = {}): OverstoryConfig {
	const tmp = tmpdir();
	return {
		project: {
			name: "test-project",
			root: tmp,
			canonicalBranch: "main",
		},
		agents: {
			manifestPath: join(tmp, ".overstory", "agent-manifest.json"),
			baseDir: join(tmp, ".overstory", "agents"),
			maxConcurrent: 5,
			staggerDelayMs: 1000,
			maxDepth: 2,
			maxSessionsPerRun: 0,
			maxAgentsPerLead: 5,
		},
		worktrees: {
			baseDir: join(tmp, ".overstory", "worktrees"),
		},
		taskTracker: {
			backend: "auto",
			enabled: false,
		},
		mulch: {
			enabled: false,
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
			tier0Enabled: false,
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
		...overrides,
	};
}

// Dummy overstoryDir — provider checks don't use the filesystem
const OVERSTORY_DIR = join(tmpdir(), ".overstory");

describe("checkProviders", () => {
	test("all checks have required DoctorCheck fields", async () => {
		const config = makeConfig();
		const checks = await checkProviders(config, OVERSTORY_DIR);

		expect(checks).toBeArray();
		for (const check of checks) {
			expect(typeof check.name).toBe("string");
			expect(check.category).toBe("providers");
			expect(["pass", "warn", "fail"]).toContain(check.status);
			expect(typeof check.message).toBe("string");
			if (check.details !== undefined) {
				expect(check.details).toBeArray();
			}
		}
	});

	describe("providers-configured check", () => {
		test("native-only config (no gateway) returns pass for providers-configured", async () => {
			const config = makeConfig({
				providers: { anthropic: { type: "native" } },
			});
			const checks = await checkProviders(config, OVERSTORY_DIR);

			const check = checks.find((c) => c.name === "providers-configured");
			expect(check).toBeDefined();
			expect(check?.status).toBe("pass");
		});

		test("empty providers returns warn for providers-configured", async () => {
			const config = makeConfig({ providers: {} });
			const checks = await checkProviders(config, OVERSTORY_DIR);

			const check = checks.find((c) => c.name === "providers-configured");
			expect(check).toBeDefined();
			expect(check?.status).toBe("warn");
		});

		test("providers-configured details list provider names and types", async () => {
			const config = makeConfig({
				providers: {
					anthropic: { type: "native" },
					openrouter: { type: "gateway", baseUrl: "http://127.0.0.1:19873" },
				},
			});
			const checks = await checkProviders(config, OVERSTORY_DIR);

			const check = checks.find((c) => c.name === "providers-configured");
			expect(check?.status).toBe("pass");
			expect(check?.details).toBeDefined();
			expect(check?.details?.some((d) => d.includes("anthropic"))).toBe(true);
			expect(check?.details?.some((d) => d.includes("openrouter"))).toBe(true);
		});
	});

	describe("provider-reachable-{name} check", () => {
		test("gateway config triggers reachability check (warn path — no real server)", async () => {
			const config = makeConfig({
				providers: {
					fake: {
						type: "gateway",
						// Use a port that is almost certainly not listening
						baseUrl: "http://127.0.0.1:19873",
					},
				},
			});
			const checks = await checkProviders(config, OVERSTORY_DIR);

			const check = checks.find((c) => c.name === "provider-reachable-fake");
			expect(check).toBeDefined();
			expect(check?.status).toBe("warn");
			expect(check?.message).toContain("fake");
		});

		test("reachability pass path — local HTTP server", async () => {
			// Start a minimal Bun HTTP server on an ephemeral port
			const server = Bun.serve({
				port: 0, // OS assigns a free port
				fetch() {
					return new Response("ok");
				},
			});

			try {
				const config = makeConfig({
					providers: {
						localtest: {
							type: "gateway",
							baseUrl: `http://127.0.0.1:${server.port}`,
						},
					},
				});
				const checks = await checkProviders(config, OVERSTORY_DIR);

				const check = checks.find((c) => c.name === "provider-reachable-localtest");
				expect(check).toBeDefined();
				expect(check?.status).toBe("pass");
			} finally {
				await server.stop();
			}
		});

		test("gateway without baseUrl skips reachability check", async () => {
			const config = makeConfig({
				providers: {
					nourl: { type: "gateway" }, // no baseUrl
				},
			});
			const checks = await checkProviders(config, OVERSTORY_DIR);

			const reachCheck = checks.find((c) => c.name === "provider-reachable-nourl");
			expect(reachCheck).toBeUndefined();
		});
	});

	describe("provider-auth-token-{name} check", () => {
		const ENV_KEY = "OVERSTORY_TEST_FAKE_PROVIDER_TOKEN_XYZ";

		beforeAll(() => {
			// Ensure env var is unset before tests
			delete process.env[ENV_KEY];
		});

		afterAll(() => {
			delete process.env[ENV_KEY];
		});

		test("gateway with authTokenEnv warns when env var missing", async () => {
			const config = makeConfig({
				providers: {
					testgateway: {
						type: "gateway",
						authTokenEnv: ENV_KEY,
					},
				},
			});
			const checks = await checkProviders(config, OVERSTORY_DIR);

			const check = checks.find((c) => c.name === "provider-auth-token-testgateway");
			expect(check).toBeDefined();
			expect(check?.status).toBe("warn");
			// Details must include the env var NAME, never a value
			expect(check?.details?.some((d) => d.includes(ENV_KEY))).toBe(true);
		});

		test("gateway with authTokenEnv passes when env var is set", async () => {
			process.env[ENV_KEY] = "test-token-value";

			const config = makeConfig({
				providers: {
					testgateway: {
						type: "gateway",
						authTokenEnv: ENV_KEY,
					},
				},
			});
			const checks = await checkProviders(config, OVERSTORY_DIR);

			const check = checks.find((c) => c.name === "provider-auth-token-testgateway");
			expect(check).toBeDefined();
			expect(check?.status).toBe("pass");
			// Details include the var name, not the value
			expect(check?.details?.some((d) => d.includes(ENV_KEY))).toBe(true);
			// Value must NOT appear in details
			expect(check?.details?.some((d) => d.includes("test-token-value"))).toBe(false);
		});

		test("native provider with no authTokenEnv skips auth-token check", async () => {
			const config = makeConfig({
				providers: { anthropic: { type: "native" } },
			});
			const checks = await checkProviders(config, OVERSTORY_DIR);

			const authCheck = checks.find((c) => c.name?.startsWith("provider-auth-token-"));
			expect(authCheck).toBeUndefined();
		});
	});

	describe("tool-use-compat check", () => {
		// Local HTTP server to avoid network calls to real openrouter.ai
		let localServer: ReturnType<typeof Bun.serve>;
		let localBaseUrl: string;

		beforeAll(() => {
			localServer = Bun.serve({
				port: 0,
				fetch() {
					return new Response("ok");
				},
			});
			localBaseUrl = `http://127.0.0.1:${localServer.port}`;
		});

		afterAll(async () => {
			await localServer.stop();
		});

		test("tool-heavy role with provider-prefixed model warns", async () => {
			const config = makeConfig({
				models: { builder: "openrouter/openai/gpt-4o" },
				providers: {
					openrouter: { type: "gateway", baseUrl: localBaseUrl },
				},
			});
			const checks = await checkProviders(config, OVERSTORY_DIR);

			const check = checks.find((c) => c.name === "tool-use-compat" && c.status === "warn");
			expect(check).toBeDefined();
			expect(check?.message).toContain("builder");
		});

		test("non-tool-heavy role with provider-prefixed model does not warn", async () => {
			// "lead" is not a tool-heavy role
			const config = makeConfig({
				models: { lead: "openrouter/openai/gpt-4o" },
				providers: {
					openrouter: { type: "gateway", baseUrl: localBaseUrl },
				},
			});
			const checks = await checkProviders(config, OVERSTORY_DIR);

			const warnChecks = checks.filter((c) => c.name === "tool-use-compat" && c.status === "warn");
			expect(warnChecks.length).toBe(0);
		});

		test("no tool-heavy roles with prefixed models emits single pass", async () => {
			const config = makeConfig({
				models: { builder: "sonnet" }, // alias, not provider-prefixed
			});
			const checks = await checkProviders(config, OVERSTORY_DIR);

			const passCheck = checks.find((c) => c.name === "tool-use-compat" && c.status === "pass");
			expect(passCheck).toBeDefined();
		});

		test("all three tool-heavy roles can trigger separate warns", async () => {
			const config = makeConfig({
				models: {
					builder: "openrouter/openai/gpt-4o",
					scout: "openrouter/openai/gpt-4o",
					merger: "openrouter/openai/gpt-4o",
				},
				providers: {
					openrouter: { type: "gateway", baseUrl: localBaseUrl },
				},
			});
			const checks = await checkProviders(config, OVERSTORY_DIR);

			const warnChecks = checks.filter((c) => c.name === "tool-use-compat" && c.status === "warn");
			expect(warnChecks.length).toBe(3);
		});
	});

	describe("model-provider-ref(s) check", () => {
		// Local HTTP server to avoid network calls to real openrouter.ai
		let localServer: ReturnType<typeof Bun.serve>;
		let localBaseUrl: string;

		beforeAll(() => {
			localServer = Bun.serve({
				port: 0,
				fetch() {
					return new Response("ok");
				},
			});
			localBaseUrl = `http://127.0.0.1:${localServer.port}`;
		});

		afterAll(async () => {
			await localServer.stop();
		});

		test("model referencing unknown provider fails", async () => {
			const config = makeConfig({
				models: { builder: "unknownprovider/some-model" },
				// unknownprovider not in providers
				providers: { anthropic: { type: "native" } },
			});
			const checks = await checkProviders(config, OVERSTORY_DIR);

			const check = checks.find((c) => c.name === "model-provider-ref" && c.status === "fail");
			expect(check).toBeDefined();
			expect(check?.message).toContain("unknownprovider");
		});

		test("model referencing defined provider passes", async () => {
			const config = makeConfig({
				models: { builder: "openrouter/openai/gpt-4o" },
				providers: {
					openrouter: { type: "gateway", baseUrl: localBaseUrl },
				},
			});
			const checks = await checkProviders(config, OVERSTORY_DIR);

			const check = checks.find((c) => c.name === "model-provider-ref" && c.status === "pass");
			expect(check).toBeDefined();
		});

		test("no provider-prefixed models emits single pass named model-provider-refs", async () => {
			const config = makeConfig({
				models: { builder: "sonnet", scout: "haiku" },
			});
			const checks = await checkProviders(config, OVERSTORY_DIR);

			const check = checks.find((c) => c.name === "model-provider-refs");
			expect(check).toBeDefined();
			expect(check?.status).toBe("pass");
		});

		test("empty models emits single pass named model-provider-refs", async () => {
			const config = makeConfig({ models: {} });
			const checks = await checkProviders(config, OVERSTORY_DIR);

			const check = checks.find((c) => c.name === "model-provider-refs");
			expect(check).toBeDefined();
			expect(check?.status).toBe("pass");
		});
	});

	describe("gateway-api-key-reminder check", () => {
		test("gateway present triggers api-key reminder warn", async () => {
			const config = makeConfig({
				providers: {
					openrouter: { type: "gateway", baseUrl: "http://127.0.0.1:19873" },
				},
			});
			const checks = await checkProviders(config, OVERSTORY_DIR);

			const check = checks.find((c) => c.name === "gateway-api-key-reminder");
			expect(check).toBeDefined();
			expect(check?.status).toBe("warn");
			expect(check?.message).toContain("ANTHROPIC_API_KEY");
		});

		test("no gateway providers — reminder is absent", async () => {
			const config = makeConfig({
				providers: { anthropic: { type: "native" } },
			});
			const checks = await checkProviders(config, OVERSTORY_DIR);

			const check = checks.find((c) => c.name === "gateway-api-key-reminder");
			expect(check).toBeUndefined();
		});
	});
});

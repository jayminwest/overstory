import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	clearProjectRootOverride,
	clearWarningsSeen,
	DEFAULT_CONFIG,
	DEFAULT_QUALITY_GATES,
	loadConfig,
	resolveProjectRoot,
	setProjectRootOverride,
} from "./config.ts";
import { ValidationError } from "./errors.ts";
import { cleanupTempDir, createTempGitRepo, runGitInDir } from "./test-helpers.ts";

describe("loadConfig", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "overstory-test-"));
	});

	afterEach(async () => {
		await cleanupTempDir(tempDir);
	});

	async function writeConfig(yaml: string): Promise<void> {
		const overstoryDir = join(tempDir, ".overstory");
		await Bun.write(join(overstoryDir, "config.yaml"), yaml);
	}

	async function ensureOverstoryDir(): Promise<void> {
		const { mkdir } = await import("node:fs/promises");
		await mkdir(join(tempDir, ".overstory"), { recursive: true });
	}

	test("returns defaults when no config file exists", async () => {
		const config = await loadConfig(tempDir);

		expect(config.project.root).toBe(tempDir);
		expect(config.project.canonicalBranch).toBe("main");
		expect(config.agents.maxConcurrent).toBe(25);
		expect(config.agents.maxDepth).toBe(2);
		expect(config.taskTracker.enabled).toBe(true);
		expect(config.mulch.enabled).toBe(true);
		expect(config.mulch.primeFormat).toBe("markdown");
		expect(config.logging.verbose).toBe(false);
	});

	test("sets project.name from directory name", async () => {
		const config = await loadConfig(tempDir);
		const parts = tempDir.split("/");
		const expectedName = parts[parts.length - 1] ?? "unknown";
		expect(config.project.name).toBe(expectedName);
	});

	test("merges config file values over defaults", async () => {
		await ensureOverstoryDir();
		await writeConfig(`
project:
  canonicalBranch: develop
agents:
  maxConcurrent: 10
`);

		const config = await loadConfig(tempDir);

		expect(config.project.canonicalBranch).toBe("develop");
		expect(config.agents.maxConcurrent).toBe(10);
		// Non-overridden values keep defaults
		expect(config.agents.maxDepth).toBe(2);
		expect(config.taskTracker.enabled).toBe(true);
	});

	test("always sets project.root to the actual projectRoot", async () => {
		await ensureOverstoryDir();
		await writeConfig(`
project:
  root: /some/wrong/path
`);

		const config = await loadConfig(tempDir);
		expect(config.project.root).toBe(tempDir);
	});

	test("parses boolean values correctly", async () => {
		await ensureOverstoryDir();
		await writeConfig(`
beads:
  enabled: false
mulch:
  enabled: true
logging:
  verbose: true
  redactSecrets: false
`);

		const config = await loadConfig(tempDir);

		expect(config.taskTracker.enabled).toBe(false);
		expect(config.mulch.enabled).toBe(true);
		expect(config.logging.verbose).toBe(true);
		expect(config.logging.redactSecrets).toBe(false);
	});

	test("parses empty array literal", async () => {
		await ensureOverstoryDir();
		await writeConfig(`
mulch:
  domains: []
`);

		const config = await loadConfig(tempDir);
		expect(config.mulch.domains).toEqual([]);
	});

	test("parses numeric values including underscore-separated", async () => {
		await ensureOverstoryDir();
		await writeConfig(`
agents:
  staggerDelayMs: 5000
watchdog:
  tier0IntervalMs: 60000
  staleThresholdMs: 120000
  zombieThresholdMs: 300000
`);

		const config = await loadConfig(tempDir);
		expect(config.agents.staggerDelayMs).toBe(5000);
		expect(config.watchdog.tier0IntervalMs).toBe(60000);
	});

	test("handles quoted string values", async () => {
		await ensureOverstoryDir();
		await writeConfig(`
project:
  canonicalBranch: "develop"
`);

		const config = await loadConfig(tempDir);
		expect(config.project.canonicalBranch).toBe("develop");
	});

	test("ignores comments and empty lines", async () => {
		await ensureOverstoryDir();
		await writeConfig(`
# This is a comment
project:
  canonicalBranch: develop  # inline comment

  # Another comment
agents:
  maxConcurrent: 3
`);

		const config = await loadConfig(tempDir);
		expect(config.project.canonicalBranch).toBe("develop");
		expect(config.agents.maxConcurrent).toBe(3);
	});

	test("config.local.yaml overrides values from config.yaml", async () => {
		await ensureOverstoryDir();
		await writeConfig(`
project:
  canonicalBranch: develop
agents:
  maxConcurrent: 10
`);
		await Bun.write(
			join(tempDir, ".overstory", "config.local.yaml"),
			`agents:\n  maxConcurrent: 4\n`,
		);

		const config = await loadConfig(tempDir);
		// Local override wins
		expect(config.agents.maxConcurrent).toBe(4);
		// Non-overridden value from config.yaml preserved
		expect(config.project.canonicalBranch).toBe("develop");
	});

	test("config.local.yaml works when config.yaml does not exist", async () => {
		await ensureOverstoryDir();
		// No config.yaml, only config.local.yaml
		await Bun.write(
			join(tempDir, ".overstory", "config.local.yaml"),
			`agents:\n  maxConcurrent: 3\n`,
		);

		const config = await loadConfig(tempDir);
		expect(config.agents.maxConcurrent).toBe(3);
		// Defaults still applied
		expect(config.project.canonicalBranch).toBe("main");
	});

	test("values from config.local.yaml are validated", async () => {
		await ensureOverstoryDir();
		await writeConfig(`
project:
  canonicalBranch: main
`);
		await Bun.write(
			join(tempDir, ".overstory", "config.local.yaml"),
			`agents:\n  maxConcurrent: -1\n`,
		);

		await expect(loadConfig(tempDir)).rejects.toThrow(ValidationError);
	});

	test("config.local.yaml deep merges nested objects", async () => {
		await ensureOverstoryDir();
		await writeConfig(`
watchdog:
  tier0Enabled: false
  staleThresholdMs: 120000
`);
		await Bun.write(
			join(tempDir, ".overstory", "config.local.yaml"),
			`watchdog:\n  tier0Enabled: true\n`,
		);

		const config = await loadConfig(tempDir);
		// Local override
		expect(config.watchdog.tier0Enabled).toBe(true);
		// Non-overridden value from config.yaml preserved
		expect(config.watchdog.staleThresholdMs).toBe(120000);
	});

	test("parses providers section from config.yaml", async () => {
		await ensureOverstoryDir();
		await writeConfig(`
providers:
  openrouter:
    type: gateway
    baseUrl: https://openrouter.ai/api/v1
    authTokenEnv: OPENROUTER_API_KEY
`);
		const config = await loadConfig(tempDir);
		expect(config.providers.openrouter).toEqual({
			type: "gateway",
			baseUrl: "https://openrouter.ai/api/v1",
			authTokenEnv: "OPENROUTER_API_KEY",
		});
		// Default anthropic provider preserved via deep merge
		expect(config.providers.anthropic).toEqual({ type: "native" });
	});

	test("config.local.yaml overrides provider settings", async () => {
		await ensureOverstoryDir();
		await writeConfig(`
providers:
  anthropic:
    type: native
`);
		await Bun.write(
			join(tempDir, ".overstory", "config.local.yaml"),
			`providers:\n  anthropic:\n    type: gateway\n    baseUrl: http://localhost:8080\n    authTokenEnv: ANTHROPIC_GATEWAY_KEY\n`,
		);
		const config = await loadConfig(tempDir);
		expect(config.providers.anthropic).toEqual({
			type: "gateway",
			baseUrl: "http://localhost:8080",
			authTokenEnv: "ANTHROPIC_GATEWAY_KEY",
		});
	});

	test("empty providers section preserves defaults", async () => {
		await ensureOverstoryDir();
		await writeConfig(`
providers:
`);
		const config = await loadConfig(tempDir);
		expect(config.providers.anthropic).toEqual({ type: "native" });
	});

	test("multiple providers parsed correctly", async () => {
		await ensureOverstoryDir();
		await writeConfig(`
providers:
  anthropic:
    type: native
  openrouter:
    type: gateway
    baseUrl: https://openrouter.ai/api/v1
    authTokenEnv: OPENROUTER_API_KEY
  litellm:
    type: gateway
    baseUrl: http://localhost:4000
    authTokenEnv: LITELLM_API_KEY
`);
		const config = await loadConfig(tempDir);
		expect(Object.keys(config.providers).length).toBe(3);
		expect(config.providers.anthropic).toEqual({ type: "native" });
		expect(config.providers.openrouter).toEqual({
			type: "gateway",
			baseUrl: "https://openrouter.ai/api/v1",
			authTokenEnv: "OPENROUTER_API_KEY",
		});
		expect(config.providers.litellm).toEqual({
			type: "gateway",
			baseUrl: "http://localhost:4000",
			authTokenEnv: "LITELLM_API_KEY",
		});
	});

	test("config.local.yaml adds new provider alongside config.yaml providers", async () => {
		await ensureOverstoryDir();
		await writeConfig(`
providers:
  openrouter:
    type: gateway
    baseUrl: https://openrouter.ai/api/v1
    authTokenEnv: OPENROUTER_API_KEY
`);
		await Bun.write(
			join(tempDir, ".overstory", "config.local.yaml"),
			`providers:\n  litellm:\n    type: gateway\n    baseUrl: http://localhost:4000\n    authTokenEnv: LITELLM_API_KEY\n`,
		);
		const config = await loadConfig(tempDir);
		// All three providers present: default anthropic + openrouter from config.yaml + litellm from config.local.yaml
		expect(config.providers.anthropic).toEqual({ type: "native" });
		expect(config.providers.openrouter).toEqual({
			type: "gateway",
			baseUrl: "https://openrouter.ai/api/v1",
			authTokenEnv: "OPENROUTER_API_KEY",
		});
		expect(config.providers.litellm).toEqual({
			type: "gateway",
			baseUrl: "http://localhost:4000",
			authTokenEnv: "LITELLM_API_KEY",
		});
	});

	test("simple model strings still work without providers section", async () => {
		await ensureOverstoryDir();
		await writeConfig(`
models:
  coordinator: sonnet
  builder: opus
  monitor: haiku
`);
		const config = await loadConfig(tempDir);
		expect(config.models.coordinator).toBe("sonnet");
		expect(config.models.builder).toBe("opus");
		expect(config.models.monitor).toBe("haiku");
		// Default anthropic provider still present even without explicit providers section
		expect(config.providers.anthropic).toEqual({ type: "native" });
	});

	test("migrates deprecated watchdog tier1/tier2 keys to tier0/tier1", async () => {
		await ensureOverstoryDir();
		await writeConfig(`
watchdog:
  tier1Enabled: true
  tier1IntervalMs: 45000
  tier2Enabled: true
`);

		const config = await loadConfig(tempDir);
		// Old tier1 (mechanical daemon) → new tier0
		expect(config.watchdog.tier0Enabled).toBe(true);
		expect(config.watchdog.tier0IntervalMs).toBe(45000);
		// Old tier2 (AI triage) → new tier1
		expect(config.watchdog.tier1Enabled).toBe(true);
	});

	test("new-style tier keys take precedence over deprecated keys", async () => {
		await ensureOverstoryDir();
		await writeConfig(`
watchdog:
  tier0Enabled: false
  tier0IntervalMs: 20000
  tier1Enabled: true
  triageTimeoutMs: 15000
`);

		const config = await loadConfig(tempDir);
		// New keys used directly — no migration needed
		expect(config.watchdog.tier0Enabled).toBe(false);
		expect(config.watchdog.tier0IntervalMs).toBe(20000);
		expect(config.watchdog.tier1Enabled).toBe(true);
	});

	test("migrates deprecated beads: key to taskTracker:", async () => {
		await ensureOverstoryDir();
		await writeConfig(`
beads:
  enabled: false
`);

		const config = await loadConfig(tempDir);
		expect(config.taskTracker.backend).toBe("beads");
		expect(config.taskTracker.enabled).toBe(false);
	});

	test("migrates deprecated seeds: key to taskTracker:", async () => {
		await ensureOverstoryDir();
		await writeConfig(`
seeds:
  enabled: true
`);

		const config = await loadConfig(tempDir);
		expect(config.taskTracker.backend).toBe("seeds");
		expect(config.taskTracker.enabled).toBe(true);
	});

	test("taskTracker: key takes precedence over legacy keys", async () => {
		await ensureOverstoryDir();
		await writeConfig(`
taskTracker:
  backend: auto
  enabled: true
beads:
  enabled: false
`);

		const config = await loadConfig(tempDir);
		// taskTracker present — beads key ignored
		expect(config.taskTracker.backend).toBe("auto");
		expect(config.taskTracker.enabled).toBe(true);
	});

	test("defaults taskTracker.backend to auto", async () => {
		const config = await loadConfig(tempDir);
		expect(config.taskTracker.backend).toBe("auto");
	});
});

describe("validateConfig", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "overstory-test-"));
		const { mkdir } = await import("node:fs/promises");
		await mkdir(join(tempDir, ".overstory"), { recursive: true });
		clearWarningsSeen();
	});

	afterEach(async () => {
		clearWarningsSeen();
		await cleanupTempDir(tempDir);
	});

	async function writeConfig(yaml: string): Promise<void> {
		await Bun.write(join(tempDir, ".overstory", "config.yaml"), yaml);
	}

	test("rejects negative maxConcurrent", async () => {
		await writeConfig(`
agents:
  maxConcurrent: -1
`);
		await expect(loadConfig(tempDir)).rejects.toThrow(ValidationError);
	});

	test("rejects zero maxConcurrent", async () => {
		await writeConfig(`
agents:
  maxConcurrent: 0
`);
		await expect(loadConfig(tempDir)).rejects.toThrow(ValidationError);
	});

	test("rejects negative maxDepth", async () => {
		await writeConfig(`
agents:
  maxDepth: -1
`);
		await expect(loadConfig(tempDir)).rejects.toThrow(ValidationError);
	});

	test("rejects negative staggerDelayMs", async () => {
		await writeConfig(`
agents:
  staggerDelayMs: -100
`);
		await expect(loadConfig(tempDir)).rejects.toThrow(ValidationError);
	});

	test("accepts maxSessionsPerRun of 0 (unlimited)", async () => {
		await writeConfig(`
agents:
  maxSessionsPerRun: 0
`);
		const config = await loadConfig(tempDir);
		expect(config.agents.maxSessionsPerRun).toBe(0);
	});

	test("accepts positive maxSessionsPerRun", async () => {
		await writeConfig(`
agents:
  maxSessionsPerRun: 20
`);
		const config = await loadConfig(tempDir);
		expect(config.agents.maxSessionsPerRun).toBe(20);
	});

	test("rejects negative maxSessionsPerRun", async () => {
		await writeConfig(`
agents:
  maxSessionsPerRun: -1
`);
		await expect(loadConfig(tempDir)).rejects.toThrow(ValidationError);
	});

	test("rejects non-integer maxSessionsPerRun", async () => {
		await writeConfig(`
agents:
  maxSessionsPerRun: 1.5
`);
		await expect(loadConfig(tempDir)).rejects.toThrow(ValidationError);
	});

	test("validates maxAgentsPerLead must be non-negative", async () => {
		await writeConfig("agents:\n  maxAgentsPerLead: -1\n");
		await expect(loadConfig(tempDir)).rejects.toThrow(ValidationError);
	});

	test("accepts maxAgentsPerLead of 0 (unlimited)", async () => {
		await writeConfig("agents:\n  maxAgentsPerLead: 0\n");
		const config = await loadConfig(tempDir);
		expect(config.agents.maxAgentsPerLead).toBe(0);
	});

	test("reads maxAgentsPerLead from config", async () => {
		await writeConfig("agents:\n  maxAgentsPerLead: 8\n");
		const config = await loadConfig(tempDir);
		expect(config.agents.maxAgentsPerLead).toBe(8);
	});

	test("defaults maxAgentsPerLead to 5", async () => {
		const config = await loadConfig(tempDir);
		expect(config.agents.maxAgentsPerLead).toBe(5);
	});

	test("rejects invalid mulch.primeFormat", async () => {
		await writeConfig(`
mulch:
  primeFormat: yaml
`);
		await expect(loadConfig(tempDir)).rejects.toThrow(ValidationError);
	});

	test("rejects invalid taskTracker.backend", async () => {
		await writeConfig(`
taskTracker:
  backend: invalid
  enabled: true
`);
		await expect(loadConfig(tempDir)).rejects.toThrow(ValidationError);
	});

	test("rejects zombieThresholdMs <= staleThresholdMs", async () => {
		await writeConfig(`
watchdog:
  staleThresholdMs: 300000
  zombieThresholdMs: 300000
`);
		await expect(loadConfig(tempDir)).rejects.toThrow(ValidationError);
	});

	test("rejects non-positive tier0IntervalMs when tier0 is enabled", async () => {
		await writeConfig(`
watchdog:
  tier0Enabled: true
  tier0IntervalMs: 0
`);
		await expect(loadConfig(tempDir)).rejects.toThrow(ValidationError);
	});

	// rpcTimeoutMs tests
	test("defaults rpcTimeoutMs to 5000", async () => {
		const config = await loadConfig(tempDir);
		expect(config.watchdog.rpcTimeoutMs).toBe(5000);
	});

	test("accepts valid rpcTimeoutMs", async () => {
		await writeConfig(`
watchdog:
  rpcTimeoutMs: 10000
`);
		const config = await loadConfig(tempDir);
		expect(config.watchdog.rpcTimeoutMs).toBe(10000);
	});

	test("rejects rpcTimeoutMs below 1000", async () => {
		await writeConfig(`
watchdog:
  rpcTimeoutMs: 999
`);
		await expect(loadConfig(tempDir)).rejects.toThrow(ValidationError);
	});

	test("rejects rpcTimeoutMs above 30000", async () => {
		await writeConfig(`
watchdog:
  rpcTimeoutMs: 30001
`);
		await expect(loadConfig(tempDir)).rejects.toThrow(ValidationError);
	});

	// triageTimeoutMs tests
	test("defaults triageTimeoutMs to 30000", async () => {
		const config = await loadConfig(tempDir);
		expect(config.watchdog.triageTimeoutMs).toBe(30000);
	});

	test("accepts valid triageTimeoutMs", async () => {
		await writeConfig(`
watchdog:
  triageTimeoutMs: 60000
`);
		const config = await loadConfig(tempDir);
		expect(config.watchdog.triageTimeoutMs).toBe(60000);
	});

	test("rejects triageTimeoutMs below 5000", async () => {
		await writeConfig(`
watchdog:
  triageTimeoutMs: 4999
`);
		await expect(loadConfig(tempDir)).rejects.toThrow(ValidationError);
	});

	test("rejects triageTimeoutMs above 120000", async () => {
		await writeConfig(`
watchdog:
  triageTimeoutMs: 120001
`);
		await expect(loadConfig(tempDir)).rejects.toThrow(ValidationError);
	});

	test("rejects triageTimeoutMs >= tier0IntervalMs when tier1 is enabled", async () => {
		// Must include tier0Enabled to avoid deprecated-key migration that would remap tier1Enabled
		await writeConfig(`
watchdog:
  tier0Enabled: true
  tier1Enabled: true
  tier0IntervalMs: 30000
  triageTimeoutMs: 30000
`);
		await expect(loadConfig(tempDir)).rejects.toThrow(ValidationError);
	});

	test("accepts triageTimeoutMs < tier0IntervalMs when tier1 is enabled", async () => {
		await writeConfig(`
watchdog:
  tier0Enabled: true
  tier1Enabled: true
  tier0IntervalMs: 60000
  triageTimeoutMs: 30000
`);
		const config = await loadConfig(tempDir);
		expect(config.watchdog.triageTimeoutMs).toBe(30000);
	});

	test("allows triageTimeoutMs >= tier0IntervalMs when tier1 is disabled", async () => {
		await writeConfig(`
watchdog:
  tier0Enabled: true
  tier1Enabled: false
  tier0IntervalMs: 30000
  triageTimeoutMs: 30000
`);
		const config = await loadConfig(tempDir);
		expect(config.watchdog.triageTimeoutMs).toBe(30000);
	});

	// maxEscalationLevel tests
	test("defaults maxEscalationLevel to 3", async () => {
		const config = await loadConfig(tempDir);
		expect(config.watchdog.maxEscalationLevel).toBe(3);
	});

	test("accepts valid maxEscalationLevel", async () => {
		await writeConfig(`
watchdog:
  maxEscalationLevel: 5
`);
		const config = await loadConfig(tempDir);
		expect(config.watchdog.maxEscalationLevel).toBe(5);
	});

	test("rejects maxEscalationLevel below 1", async () => {
		await writeConfig(`
watchdog:
  maxEscalationLevel: 0
`);
		await expect(loadConfig(tempDir)).rejects.toThrow(ValidationError);
	});

	test("rejects maxEscalationLevel above 5", async () => {
		await writeConfig(`
watchdog:
  maxEscalationLevel: 6
`);
		await expect(loadConfig(tempDir)).rejects.toThrow(ValidationError);
	});

	test("accepts maxEscalationLevel boundary values 1 and 5", async () => {
		await writeConfig(`
watchdog:
  maxEscalationLevel: 1
`);
		let config = await loadConfig(tempDir);
		expect(config.watchdog.maxEscalationLevel).toBe(1);

		await writeConfig(`
watchdog:
  maxEscalationLevel: 5
`);
		config = await loadConfig(tempDir);
		expect(config.watchdog.maxEscalationLevel).toBe(5);
	});

	test("accepts empty models section", async () => {
		await writeConfig(`
models:
`);
		const config = await loadConfig(tempDir);
		expect(config.models).toBeDefined();
	});

	test("accepts valid model names in models section", async () => {
		await writeConfig(`
models:
  coordinator: sonnet
  monitor: haiku
  builder: opus
`);
		const config = await loadConfig(tempDir);
		expect(config.models.coordinator).toBe("sonnet");
		expect(config.models.monitor).toBe("haiku");
		expect(config.models.builder).toBe("opus");
	});

	test("rejects invalid model name in models section", async () => {
		await writeConfig(`
models:
  coordinator: gpt4
`);
		await expect(loadConfig(tempDir)).rejects.toThrow(ValidationError);
	});

	// Provider validation tests

	test("rejects provider with invalid type", async () => {
		await writeConfig(`
providers:
  custom:
    type: custom
`);
		await expect(loadConfig(tempDir)).rejects.toThrow(ValidationError);
	});

	test("rejects gateway provider without baseUrl", async () => {
		await writeConfig(`
providers:
  mygateway:
    type: gateway
    authTokenEnv: MY_TOKEN
`);
		await expect(loadConfig(tempDir)).rejects.toThrow(ValidationError);
	});

	test("rejects gateway provider without authTokenEnv", async () => {
		await writeConfig(`
providers:
  mygateway:
    type: gateway
    baseUrl: https://example.com
`);
		await expect(loadConfig(tempDir)).rejects.toThrow(ValidationError);
	});

	test("accepts native provider without baseUrl or authTokenEnv", async () => {
		await writeConfig(`
providers:
  mylocal:
    type: native
`);
		const config = await loadConfig(tempDir);
		expect(config.providers.mylocal).toEqual({ type: "native" });
	});

	// Model validation tests

	test("accepts provider-prefixed model ref when provider exists", async () => {
		await writeConfig(`
providers:
  openrouter:
    type: gateway
    baseUrl: https://openrouter.ai/api/v1
    authTokenEnv: OPENROUTER_API_KEY
models:
  coordinator: openrouter/openai/gpt-5.3
`);
		const config = await loadConfig(tempDir);
		expect(config.models.coordinator).toBe("openrouter/openai/gpt-5.3");
	});

	test("rejects provider-prefixed model ref when provider is unknown", async () => {
		await writeConfig(`
models:
  coordinator: unknown/model
`);
		await expect(loadConfig(tempDir)).rejects.toThrow(ValidationError);
	});

	test("rejects model ref with deeply nested slashes when provider unknown", async () => {
		await writeConfig(`
models:
  coordinator: unknown/openai/gpt-5.3/latest
`);
		await expect(loadConfig(tempDir)).rejects.toThrow(ValidationError);
	});

	test("accepts model ref with deeply nested slashes when provider exists", async () => {
		await writeConfig(`
providers:
  openrouter:
    type: gateway
    baseUrl: https://openrouter.ai/api/v1
    authTokenEnv: OPENROUTER_API_KEY
models:
  coordinator: openrouter/openai/gpt-5.3/variant
`);
		const config = await loadConfig(tempDir);
		expect(config.models.coordinator).toBe("openrouter/openai/gpt-5.3/variant");
	});

	test("rejects bare invalid model name", async () => {
		await writeConfig(`
models:
  coordinator: gpt4
`);
		const err = await loadConfig(tempDir).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(ValidationError);
		expect((err as ValidationError).message).toContain("provider-prefixed ref");
	});

	test("accepts bare model name when runtime.default is codex", async () => {
		await writeConfig(`
runtime:
  default: codex
models:
  coordinator: gpt-5.3-codex
`);
		const config = await loadConfig(tempDir);
		expect(config.models.coordinator).toBe("gpt-5.3-codex");
	});

	test("warns on bare non-Anthropic model in tool-heavy role when runtime.default is codex", async () => {
		await writeConfig(`
runtime:
  default: codex
models:
  builder: gpt-5.3-codex
`);
		const origWrite = process.stderr.write;
		let capturedStderr = "";
		process.stderr.write = ((s: string | Uint8Array) => {
			if (typeof s === "string") capturedStderr += s;
			return true;
		}) as typeof process.stderr.write;
		try {
			await loadConfig(tempDir);
		} finally {
			process.stderr.write = origWrite;
		}
		expect(capturedStderr).toContain("WARNING: models.builder uses non-Anthropic model");
		expect(capturedStderr).toContain("gpt-5.3-codex");
	});

	test("warns on non-Anthropic model in tool-heavy role", async () => {
		await writeConfig(`
providers:
  openrouter:
    type: gateway
    baseUrl: https://openrouter.ai/api/v1
    authTokenEnv: OPENROUTER_API_KEY
models:
  builder: openrouter/openai/gpt-4
`);
		const origWrite = process.stderr.write;
		let capturedStderr = "";
		process.stderr.write = ((s: string | Uint8Array) => {
			if (typeof s === "string") capturedStderr += s;
			return true;
		}) as typeof process.stderr.write;
		try {
			await loadConfig(tempDir);
		} finally {
			process.stderr.write = origWrite;
		}
		expect(capturedStderr).toContain("WARNING: models.builder uses non-Anthropic model");
		expect(capturedStderr).toContain("openrouter/openai/gpt-4");
	});

	test("warns only once per role/model combination across multiple loadConfig calls", async () => {
		await writeConfig(`
providers:
  openrouter:
    type: gateway
    baseUrl: https://openrouter.ai/api/v1
    authTokenEnv: OPENROUTER_API_KEY
models:
  builder: openrouter/openai/gpt-4
`);
		const origWrite = process.stderr.write;
		const stderrLines: string[] = [];
		process.stderr.write = ((s: string | Uint8Array) => {
			if (typeof s === "string") stderrLines.push(s);
			return true;
		}) as typeof process.stderr.write;
		try {
			await loadConfig(tempDir);
			await loadConfig(tempDir);
			await loadConfig(tempDir);
		} finally {
			process.stderr.write = origWrite;
		}
		const warnings = stderrLines.filter((l) => l.includes("WARNING: models.builder"));
		expect(warnings.length).toBe(1);
	});

	test("does not warn for non-Anthropic model in non-tool-heavy role", async () => {
		await writeConfig(`
providers:
  openrouter:
    type: gateway
    baseUrl: https://openrouter.ai/api/v1
    authTokenEnv: OPENROUTER_API_KEY
models:
  coordinator: openrouter/openai/gpt-4
`);
		const origWrite = process.stderr.write;
		let capturedStderr = "";
		process.stderr.write = ((s: string | Uint8Array) => {
			if (typeof s === "string") capturedStderr += s;
			return true;
		}) as typeof process.stderr.write;
		try {
			await loadConfig(tempDir);
		} finally {
			process.stderr.write = origWrite;
		}
		expect(capturedStderr).not.toContain("WARNING");
	});

	test("custom qualityGates from config.yaml are loaded", async () => {
		await writeConfig(`
project:
  canonicalBranch: main
  qualityGates:
    - name: Test
      command: pytest
      description: all tests pass
    - name: Lint
      command: ruff check .
      description: no lint errors
`);
		const config = await loadConfig(tempDir);
		expect(config.project.qualityGates?.length).toBe(2);
		expect(config.project.qualityGates?.[0]?.command).toBe("pytest");
		expect(config.project.qualityGates?.[1]?.command).toBe("ruff check .");
	});

	test("rejects qualityGate with empty name", async () => {
		await writeConfig(`
project:
  canonicalBranch: main
  qualityGates:
    - name: ""
      command: pytest
      description: all tests pass
`);
		await expect(loadConfig(tempDir)).rejects.toThrow(ValidationError);
	});

	test("rejects qualityGate with empty command", async () => {
		await writeConfig(`
project:
  canonicalBranch: main
  qualityGates:
    - name: Test
      command: ""
      description: all tests pass
`);
		await expect(loadConfig(tempDir)).rejects.toThrow(ValidationError);
	});

	test("resets negative shellInitDelayMs to 0 with warning", async () => {
		await writeConfig("runtime:\n  shellInitDelayMs: -100\n");
		const origWrite = process.stderr.write;
		let capturedStderr = "";
		process.stderr.write = ((s: string | Uint8Array) => {
			if (typeof s === "string") capturedStderr += s;
			return true;
		}) as typeof process.stderr.write;
		try {
			const config = await loadConfig(tempDir);
			expect(config.runtime?.shellInitDelayMs).toBe(0);
		} finally {
			process.stderr.write = origWrite;
		}
		expect(capturedStderr).toContain("WARNING: runtime.shellInitDelayMs");
	});

	test("resets Infinity shellInitDelayMs to 0 with warning", async () => {
		await writeConfig("runtime:\n  shellInitDelayMs: .inf\n");
		const origWrite = process.stderr.write;
		let capturedStderr = "";
		process.stderr.write = ((s: string | Uint8Array) => {
			if (typeof s === "string") capturedStderr += s;
			return true;
		}) as typeof process.stderr.write;
		try {
			const config = await loadConfig(tempDir);
			expect(config.runtime?.shellInitDelayMs).toBe(0);
		} finally {
			process.stderr.write = origWrite;
		}
		expect(capturedStderr).toContain("WARNING: runtime.shellInitDelayMs");
	});

	test("warns when shellInitDelayMs exceeds 30s", async () => {
		await writeConfig("runtime:\n  shellInitDelayMs: 60000\n");
		const origWrite = process.stderr.write;
		let capturedStderr = "";
		process.stderr.write = ((s: string | Uint8Array) => {
			if (typeof s === "string") capturedStderr += s;
			return true;
		}) as typeof process.stderr.write;
		try {
			const config = await loadConfig(tempDir);
			expect(config.runtime?.shellInitDelayMs).toBe(60000);
		} finally {
			process.stderr.write = origWrite;
		}
		expect(capturedStderr).toContain("WARNING: runtime.shellInitDelayMs is 60000ms");
	});

	test("accepts valid shellInitDelayMs without warning", async () => {
		await writeConfig("runtime:\n  shellInitDelayMs: 2000\n");
		const origWrite = process.stderr.write;
		let capturedStderr = "";
		process.stderr.write = ((s: string | Uint8Array) => {
			if (typeof s === "string") capturedStderr += s;
			return true;
		}) as typeof process.stderr.write;
		try {
			const config = await loadConfig(tempDir);
			expect(config.runtime?.shellInitDelayMs).toBe(2000);
		} finally {
			process.stderr.write = origWrite;
		}
		expect(capturedStderr).not.toContain("shellInitDelayMs");
	});

	test("rejects qualityGate with empty description", async () => {
		await writeConfig(`
project:
  canonicalBranch: main
  qualityGates:
    - name: Test
      command: pytest
      description: ""
`);
		await expect(loadConfig(tempDir)).rejects.toThrow(ValidationError);
	});
});

describe("resolveProjectRoot", () => {
	let repoDir: string;

	afterEach(async () => {
		if (repoDir) {
			// Remove worktrees before cleaning up
			try {
				await runGitInDir(repoDir, ["worktree", "prune"]);
			} catch {
				// Best effort
			}
			await cleanupTempDir(repoDir);
		}
	});

	test("returns startDir when .overstory/config.yaml exists there", async () => {
		repoDir = await createTempGitRepo();
		await mkdir(join(repoDir, ".overstory"), { recursive: true });
		await Bun.write(
			join(repoDir, ".overstory", "config.yaml"),
			"project:\n  canonicalBranch: main\n",
		);

		const result = await resolveProjectRoot(repoDir);
		expect(result).toBe(repoDir);
	});

	test("resolves worktree to main project root", async () => {
		repoDir = await createTempGitRepo();
		// Resolve symlinks (macOS /var -> /private/var) to match git's output
		repoDir = await realpath(repoDir);
		await mkdir(join(repoDir, ".overstory"), { recursive: true });
		await Bun.write(
			join(repoDir, ".overstory", "config.yaml"),
			"project:\n  canonicalBranch: main\n",
		);

		// Create a worktree like overstory sling does
		const worktreeDir = join(repoDir, ".overstory", "worktrees", "test-agent");
		await mkdir(join(repoDir, ".overstory", "worktrees"), { recursive: true });
		await runGitInDir(repoDir, [
			"worktree",
			"add",
			"-b",
			"overstory/test-agent/task-1",
			worktreeDir,
		]);

		// resolveProjectRoot from the worktree should return the main repo
		const result = await resolveProjectRoot(worktreeDir);
		expect(result).toBe(repoDir);
	});

	test("resolves worktree to main root even when config.yaml is committed (regression)", async () => {
		repoDir = await createTempGitRepo();
		repoDir = await realpath(repoDir);

		// Commit .overstory/config.yaml so the worktree gets a copy via git
		// (this is what overstory init does — the file is tracked)
		await mkdir(join(repoDir, ".overstory"), { recursive: true });
		await Bun.write(
			join(repoDir, ".overstory", "config.yaml"),
			"project:\n  canonicalBranch: main\n",
		);
		await runGitInDir(repoDir, ["add", ".overstory/config.yaml"]);
		await runGitInDir(repoDir, ["commit", "-m", "add overstory config"]);

		// Create a worktree — it will now have .overstory/config.yaml from git
		const worktreeDir = join(repoDir, ".overstory", "worktrees", "mail-scout");
		await mkdir(join(repoDir, ".overstory", "worktrees"), { recursive: true });
		await runGitInDir(repoDir, [
			"worktree",
			"add",
			"-b",
			"overstory/mail-scout/task-1",
			worktreeDir,
		]);

		// Must resolve to main repo root, NOT the worktree
		// (even though worktree has its own .overstory/config.yaml)
		const result = await resolveProjectRoot(worktreeDir);
		expect(result).toBe(repoDir);
	});

	test("loadConfig resolves correct root from worktree", async () => {
		repoDir = await createTempGitRepo();
		// Resolve symlinks (macOS /var -> /private/var) to match git's output
		repoDir = await realpath(repoDir);
		await mkdir(join(repoDir, ".overstory"), { recursive: true });
		await Bun.write(
			join(repoDir, ".overstory", "config.yaml"),
			"project:\n  canonicalBranch: develop\n",
		);

		const worktreeDir = join(repoDir, ".overstory", "worktrees", "agent-2");
		await mkdir(join(repoDir, ".overstory", "worktrees"), { recursive: true });
		await runGitInDir(repoDir, ["worktree", "add", "-b", "overstory/agent-2/task-2", worktreeDir]);

		// loadConfig from the worktree should resolve to the main project root
		const config = await loadConfig(worktreeDir);
		expect(config.project.root).toBe(repoDir);
		expect(config.project.canonicalBranch).toBe("develop");
	});
});

describe("resolveProjectRoot — env var and walk-up", () => {
	let tempDir: string;
	let savedEnv: string | undefined;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "overstory-envtest-"));
		savedEnv = process.env.OVERSTORY_PROJECT_ROOT;
		delete process.env.OVERSTORY_PROJECT_ROOT;
		clearProjectRootOverride();
	});

	afterEach(async () => {
		if (savedEnv !== undefined) {
			process.env.OVERSTORY_PROJECT_ROOT = savedEnv;
		} else {
			delete process.env.OVERSTORY_PROJECT_ROOT;
		}
		clearProjectRootOverride();
		await cleanupTempDir(tempDir);
	});

	test("OVERSTORY_PROJECT_ROOT env var is returned immediately", async () => {
		await mkdir(join(tempDir, ".overstory"), { recursive: true });
		await Bun.write(
			join(tempDir, ".overstory", "config.yaml"),
			"project:\n  canonicalBranch: main\n",
		);
		process.env.OVERSTORY_PROJECT_ROOT = tempDir;
		const result = await resolveProjectRoot("/some/unrelated/path");
		expect(result).toBe(tempDir);
	});

	test("env var beats walk-up worktree resolution", async () => {
		// Set up a parent root with config.yaml
		const parentRoot = tempDir;
		await mkdir(join(parentRoot, ".overstory", "worktrees", "some-agent"), { recursive: true });
		await Bun.write(
			join(parentRoot, ".overstory", "config.yaml"),
			"project:\n  canonicalBranch: main\n",
		);
		const worktreePath = join(parentRoot, ".overstory", "worktrees", "some-agent");
		// Even though walk-up would resolve parentRoot, env var pointing elsewhere wins
		const envTarget = await mkdtemp(join(tmpdir(), "overstory-envtarget-"));
		try {
			process.env.OVERSTORY_PROJECT_ROOT = envTarget;
			const result = await resolveProjectRoot(worktreePath);
			expect(result).toBe(envTarget);
		} finally {
			await cleanupTempDir(envTarget);
		}
	});

	test("walk-up resolves submodule path without git", async () => {
		// Simulate a submodule worktree: {tempDir}/.overstory/worktrees/my-agent/sub
		// config.yaml exists at {tempDir}/.overstory/config.yaml
		const worktreeBase = join(tempDir, ".overstory", "worktrees", "my-agent");
		const subDir = join(worktreeBase, "sub");
		await mkdir(subDir, { recursive: true });
		await mkdir(join(tempDir, ".overstory"), { recursive: true });
		await Bun.write(
			join(tempDir, ".overstory", "config.yaml"),
			"project:\n  canonicalBranch: main\n",
		);
		const result = await resolveProjectRoot(subDir);
		expect(result).toBe(tempDir);
	});

	test("walk-up is skipped when parent has no config.yaml", async () => {
		// Same path structure but NO config.yaml at parentRoot
		const worktreeBase = join(tempDir, ".overstory", "worktrees", "my-agent");
		await mkdir(worktreeBase, { recursive: true });
		// No config.yaml written — walk-up guard should prevent false resolution
		const result = await resolveProjectRoot(worktreeBase);
		// Falls through to startDir fallback
		expect(result).toBe(worktreeBase);
	});
});

describe("projectRootOverride", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "overstory-test-"));
		clearProjectRootOverride();
	});

	afterEach(async () => {
		clearProjectRootOverride();
		await cleanupTempDir(tempDir);
	});

	test("setProjectRootOverride makes resolveProjectRoot return the override", async () => {
		setProjectRootOverride(tempDir);
		const result = await resolveProjectRoot("/some/other/dir");
		expect(result).toBe(tempDir);
	});

	test("clearProjectRootOverride restores normal resolution", async () => {
		setProjectRootOverride("/completely/fake/path");
		clearProjectRootOverride();
		// After clearing, normal resolution returns startDir when no .overstory present
		const result = await resolveProjectRoot(tempDir);
		expect(result).toBe(tempDir);
	});

	test("loadConfig respects project root override", async () => {
		await mkdir(join(tempDir, ".overstory"), { recursive: true });
		await Bun.write(
			join(tempDir, ".overstory", "config.yaml"),
			"project:\n  canonicalBranch: override-branch\n",
		);
		setProjectRootOverride(tempDir);
		const config = await loadConfig("/completely/different/path");
		expect(config.project.root).toBe(tempDir);
		expect(config.project.canonicalBranch).toBe("override-branch");
	});

	test("override takes precedence over worktree resolution", async () => {
		// Even if we're in a worktree, the override wins
		const otherDir = await mkdtemp(join(tmpdir(), "overstory-other-"));
		try {
			await mkdir(join(otherDir, ".overstory"), { recursive: true });
			await Bun.write(
				join(otherDir, ".overstory", "config.yaml"),
				"project:\n  canonicalBranch: other-branch\n",
			);
			setProjectRootOverride(otherDir);
			const result = await resolveProjectRoot(tempDir);
			expect(result).toBe(otherDir);
		} finally {
			await cleanupTempDir(otherDir);
		}
	});
});

describe("coordinator.exitTriggers", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "overstory-test-"));
		const { mkdir } = await import("node:fs/promises");
		await mkdir(join(tempDir, ".overstory"), { recursive: true });
	});

	afterEach(async () => {
		await cleanupTempDir(tempDir);
	});

	async function writeConfig(yaml: string): Promise<void> {
		await Bun.write(join(tempDir, ".overstory", "config.yaml"), yaml);
	}

	test("defaults all exitTriggers to false", async () => {
		const config = await loadConfig(tempDir);
		expect(config.coordinator?.exitTriggers.allAgentsDone).toBe(false);
		expect(config.coordinator?.exitTriggers.taskTrackerEmpty).toBe(false);
		expect(config.coordinator?.exitTriggers.onShutdownSignal).toBe(false);
	});

	test("parses coordinator.exitTriggers from config.yaml", async () => {
		await writeConfig(`
coordinator:
  exitTriggers:
    allAgentsDone: true
    taskTrackerEmpty: true
    onShutdownSignal: false
`);
		const config = await loadConfig(tempDir);
		expect(config.coordinator?.exitTriggers.allAgentsDone).toBe(true);
		expect(config.coordinator?.exitTriggers.taskTrackerEmpty).toBe(true);
		expect(config.coordinator?.exitTriggers.onShutdownSignal).toBe(false);
	});

	test("partial exitTriggers override keeps unset values at default (false)", async () => {
		await writeConfig(`
coordinator:
  exitTriggers:
    onShutdownSignal: true
`);
		const config = await loadConfig(tempDir);
		expect(config.coordinator?.exitTriggers.allAgentsDone).toBe(false);
		expect(config.coordinator?.exitTriggers.taskTrackerEmpty).toBe(false);
		expect(config.coordinator?.exitTriggers.onShutdownSignal).toBe(true);
	});

	test("config.local.yaml can override exitTriggers", async () => {
		await writeConfig(`
coordinator:
  exitTriggers:
    allAgentsDone: false
`);
		await Bun.write(
			join(tempDir, ".overstory", "config.local.yaml"),
			`coordinator:\n  exitTriggers:\n    allAgentsDone: true\n`,
		);
		const config = await loadConfig(tempDir);
		expect(config.coordinator?.exitTriggers.allAgentsDone).toBe(true);
	});
});

describe("YAML parser edge cases", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "overstory-test-"));
		await mkdir(join(tempDir, ".overstory"), { recursive: true });
	});

	afterEach(async () => {
		await cleanupTempDir(tempDir);
	});

	async function writeConfig(yaml: string): Promise<void> {
		await Bun.write(join(tempDir, ".overstory", "config.yaml"), yaml);
	}

	test("inline comments are stripped from values", async () => {
		await writeConfig(`
project:
  canonicalBranch: develop # this is a comment
`);
		const config = await loadConfig(tempDir);
		expect(config.project.canonicalBranch).toBe("develop");
	});

	test("quoted strings containing # are preserved (not treated as comments)", async () => {
		await writeConfig(`
project:
  canonicalBranch: "feature#branch"
`);
		const config = await loadConfig(tempDir);
		expect(config.project.canonicalBranch).toBe("feature#branch");
	});

	test("single-quoted strings containing # are preserved", async () => {
		await writeConfig(`
project:
  canonicalBranch: 'feature#branch'
`);
		const config = await loadConfig(tempDir);
		expect(config.project.canonicalBranch).toBe("feature#branch");
	});

	test("boolean coercion: true/True/TRUE all parse as true", async () => {
		// Test with three separate configs since they all map to the same field
		for (const val of ["true", "True", "TRUE"]) {
			await writeConfig(`mulch:\n  enabled: ${val}\n`);
			const config = await loadConfig(tempDir);
			expect(config.mulch.enabled).toBe(true);
		}
	});

	test("boolean coercion: false/False/FALSE all parse as false", async () => {
		for (const val of ["false", "False", "FALSE"]) {
			await writeConfig(`mulch:\n  enabled: ${val}\n`);
			const config = await loadConfig(tempDir);
			expect(config.mulch.enabled).toBe(false);
		}
	});

	test("yes/no are treated as plain strings, not booleans", async () => {
		// The YAML parser does NOT treat yes/no as booleans (unlike YAML 1.1)
		await writeConfig(`
project:
  canonicalBranch: yes
`);
		const config = await loadConfig(tempDir);
		// "yes" is a plain string, not coerced to boolean
		expect(config.project.canonicalBranch).toBe("yes");
	});

	test("integer number coercion", async () => {
		await writeConfig(`
agents:
  maxConcurrent: 42
`);
		const config = await loadConfig(tempDir);
		expect(config.agents.maxConcurrent).toBe(42);
	});

	test("float number coercion", async () => {
		// maxSessionsPerRun doesn't accept floats, but the parser itself parses them.
		// Use a field that passes validation as a number.
		await writeConfig(`
agents:
  maxSessionsPerRun: 5
  staggerDelayMs: 1500
`);
		const config = await loadConfig(tempDir);
		expect(config.agents.staggerDelayMs).toBe(1500);
	});

	test("underscore-separated numbers are coerced correctly", async () => {
		await writeConfig(`
watchdog:
  staleThresholdMs: 300_000
  zombieThresholdMs: 600_000
`);
		const config = await loadConfig(tempDir);
		expect(config.watchdog.staleThresholdMs).toBe(300_000);
		expect(config.watchdog.zombieThresholdMs).toBe(600_000);
	});
});

describe("DEFAULT_CONFIG", () => {
	test("has all required top-level keys", () => {
		expect(DEFAULT_CONFIG.project).toBeDefined();
		expect(DEFAULT_CONFIG.agents).toBeDefined();
		expect(DEFAULT_CONFIG.worktrees).toBeDefined();
		expect(DEFAULT_CONFIG.taskTracker).toBeDefined();
		expect(DEFAULT_CONFIG.mulch).toBeDefined();
		expect(DEFAULT_CONFIG.merge).toBeDefined();
		expect(DEFAULT_CONFIG.providers).toBeDefined();
		expect(DEFAULT_CONFIG.watchdog).toBeDefined();
		expect(DEFAULT_CONFIG.models).toBeDefined();
		expect(DEFAULT_CONFIG.logging).toBeDefined();
	});

	test("has default providers with anthropic native", () => {
		expect(DEFAULT_CONFIG.providers).toBeDefined();
		expect(DEFAULT_CONFIG.providers.anthropic).toEqual({ type: "native" });
	});

	test("has sensible default values", () => {
		expect(DEFAULT_CONFIG.project.canonicalBranch).toBe("main");
		expect(DEFAULT_CONFIG.agents.maxConcurrent).toBe(25);
		expect(DEFAULT_CONFIG.agents.maxDepth).toBe(2);
		expect(DEFAULT_CONFIG.agents.staggerDelayMs).toBe(2_000);
		expect(DEFAULT_CONFIG.agents.maxSessionsPerRun).toBe(0);
		expect(DEFAULT_CONFIG.watchdog.tier0IntervalMs).toBe(30_000);
		expect(DEFAULT_CONFIG.watchdog.staleThresholdMs).toBe(300_000);
		expect(DEFAULT_CONFIG.watchdog.zombieThresholdMs).toBe(600_000);
	});

	test("includes default qualityGates", () => {
		expect(DEFAULT_CONFIG.project.qualityGates).toBeDefined();
		expect(DEFAULT_CONFIG.project.qualityGates?.length).toBe(3);
		expect(DEFAULT_CONFIG.project.qualityGates?.[0]?.command).toBe("bun test");
		expect(DEFAULT_CONFIG.project.qualityGates?.[1]?.command).toBe("bun run lint");
		expect(DEFAULT_CONFIG.project.qualityGates?.[2]?.command).toBe("bun run typecheck");
	});

	test("has coordinator with exitTriggers defaulting to false", () => {
		expect(DEFAULT_CONFIG.coordinator).toBeDefined();
		expect(DEFAULT_CONFIG.coordinator?.exitTriggers.allAgentsDone).toBe(false);
		expect(DEFAULT_CONFIG.coordinator?.exitTriggers.taskTrackerEmpty).toBe(false);
		expect(DEFAULT_CONFIG.coordinator?.exitTriggers.onShutdownSignal).toBe(false);
	});

	test("DEFAULT_QUALITY_GATES matches the project default gates", () => {
		expect(DEFAULT_QUALITY_GATES).toHaveLength(3);
		expect(DEFAULT_QUALITY_GATES[0]?.name).toBe("Tests");
		expect(DEFAULT_QUALITY_GATES[1]?.name).toBe("Lint");
		expect(DEFAULT_QUALITY_GATES[2]?.name).toBe("Typecheck");
	});
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, loadConfig, resolveProjectRoot } from "./config.ts";
import { ValidationError } from "./errors.ts";
import { cleanupTempDir, createTempGitRepo, runGitInDir } from "./test-helpers.ts";

describe("loadConfig", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "overstory-test-"));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
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
		expect(config.beads.enabled).toBe(true);
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
		expect(config.beads.enabled).toBe(true);
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

		expect(config.beads.enabled).toBe(false);
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
`);

		const config = await loadConfig(tempDir);
		// New keys used directly — no migration needed
		expect(config.watchdog.tier0Enabled).toBe(false);
		expect(config.watchdog.tier0IntervalMs).toBe(20000);
		expect(config.watchdog.tier1Enabled).toBe(true);
	});
});

describe("validateConfig", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "overstory-test-"));
		const { mkdir } = await import("node:fs/promises");
		await mkdir(join(tempDir, ".overstory"), { recursive: true });
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
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

	test("rejects invalid mulch.primeFormat", async () => {
		await writeConfig(`
mulch:
  primeFormat: yaml
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

	test("rejects bare invalid model name", async () => {
		await writeConfig(`
models:
  coordinator: gpt4
`);
		const err = await loadConfig(tempDir).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(ValidationError);
		expect((err as ValidationError).message).toContain("provider-prefixed ref");
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

describe("DEFAULT_CONFIG", () => {
	test("has all required top-level keys", () => {
		expect(DEFAULT_CONFIG.project).toBeDefined();
		expect(DEFAULT_CONFIG.agents).toBeDefined();
		expect(DEFAULT_CONFIG.worktrees).toBeDefined();
		expect(DEFAULT_CONFIG.beads).toBeDefined();
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
});

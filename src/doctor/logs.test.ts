/**
 * Tests for logs doctor checks.
 *
 * Uses temp directories with real filesystem operations.
 * No mocks needed -- all operations are cheap and local.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OverstoryConfig } from "../types.ts";
import { checkLogs } from "./logs.ts";

describe("checkLogs", () => {
	let tempDir: string;
	let overstoryDir: string;
	let logsDir: string;
	let mockConfig: OverstoryConfig;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "logs-test-"));
		overstoryDir = join(tempDir, ".overstory");
		logsDir = join(overstoryDir, "logs");

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

		await mkdir(overstoryDir, { recursive: true });
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	test("warns when logs/ directory does not exist", async () => {
		const checks = await checkLogs(mockConfig, overstoryDir);

		const dirCheck = checks.find((c) => c.name === "logs/ directory");
		expect(dirCheck).toBeDefined();
		expect(dirCheck?.status).toBe("warn");
		expect(dirCheck?.message).toContain("missing");
	});

	test("passes when logs/ directory exists but is empty", async () => {
		await mkdir(logsDir, { recursive: true });

		const checks = await checkLogs(mockConfig, overstoryDir);

		const dirCheck = checks.find((c) => c.name === "logs/ directory");
		expect(dirCheck?.status).toBe("pass");

		const usageCheck = checks.find((c) => c.name === "Total disk usage");
		expect(usageCheck?.status).toBe("pass");
		expect(usageCheck?.message).toContain("0B");
	});

	test("calculates total disk usage correctly", async () => {
		await mkdir(logsDir, { recursive: true });
		const agentDir = join(logsDir, "test-agent", "session-1");
		await mkdir(agentDir, { recursive: true });

		// Create log files with known sizes
		await writeFile(join(agentDir, "session.log"), "a".repeat(1024)); // 1KB
		await writeFile(join(agentDir, "events.ndjson"), "b".repeat(2048)); // 2KB
		await writeFile(join(agentDir, "tools.ndjson"), "c".repeat(512)); // 512B

		const checks = await checkLogs(mockConfig, overstoryDir);

		const usageCheck = checks.find((c) => c.name === "Total disk usage");
		expect(usageCheck).toBeDefined();
		expect(usageCheck?.status).toBe("pass");
		expect(usageCheck?.message).toContain("3.5KB"); // 1024 + 2048 + 512 = 3584 bytes
	});

	test("warns when disk usage exceeds threshold", async () => {
		await mkdir(logsDir, { recursive: true });
		const agentDir = join(logsDir, "test-agent", "session-1");
		await mkdir(agentDir, { recursive: true });

		// Create a large log file (> 500MB threshold)
		const largeContent = "x".repeat(600 * 1024 * 1024); // 600MB
		await writeFile(join(agentDir, "session.log"), largeContent);

		const checks = await checkLogs(mockConfig, overstoryDir);

		const usageCheck = checks.find((c) => c.name === "Total disk usage");
		expect(usageCheck).toBeDefined();
		expect(usageCheck?.status).toBe("warn");
		expect(usageCheck?.details).toBeDefined();
		expect(usageCheck?.details?.some((d) => d.includes("threshold"))).toBe(true);
	});

	test("reports per-agent log sizes", async () => {
		await mkdir(logsDir, { recursive: true });

		// Create logs for multiple agents
		const agent1Dir = join(logsDir, "agent-1", "session-1");
		await mkdir(agent1Dir, { recursive: true });
		await writeFile(join(agent1Dir, "session.log"), "a".repeat(10000));

		const agent2Dir = join(logsDir, "agent-2", "session-1");
		await mkdir(agent2Dir, { recursive: true });
		await writeFile(join(agent2Dir, "session.log"), "b".repeat(5000));

		const checks = await checkLogs(mockConfig, overstoryDir);

		const sizesCheck = checks.find((c) => c.name === "Per-agent log sizes");
		expect(sizesCheck).toBeDefined();
		expect(sizesCheck?.status).toBe("pass");
		expect(sizesCheck?.message).toContain("2 agent(s)");
		expect(sizesCheck?.details).toBeDefined();
		expect(sizesCheck?.details?.some((d) => d.includes("agent-1"))).toBe(true);
		expect(sizesCheck?.details?.some((d) => d.includes("agent-2"))).toBe(true);
	});

	test("detects malformed NDJSON in events.ndjson", async () => {
		await mkdir(logsDir, { recursive: true });
		const agentDir = join(logsDir, "test-agent", "session-1");
		await mkdir(agentDir, { recursive: true });

		// Valid and invalid JSON lines
		const content = `{"event":"start","timestamp":"2024-01-01T00:00:00Z"}
invalid json line here
{"event":"end","timestamp":"2024-01-01T00:01:00Z"}`;

		await writeFile(join(agentDir, "events.ndjson"), content);

		const checks = await checkLogs(mockConfig, overstoryDir);

		const integrityCheck = checks.find((c) => c.name === "NDJSON integrity");
		expect(integrityCheck).toBeDefined();
		expect(integrityCheck?.status).toBe("warn");
		expect(integrityCheck?.message).toContain("malformed JSON");
		expect(integrityCheck?.details?.some((d) => d.includes("events.ndjson"))).toBe(true);
	});

	test("passes when all NDJSON files are valid", async () => {
		await mkdir(logsDir, { recursive: true });
		const agentDir = join(logsDir, "test-agent", "session-1");
		await mkdir(agentDir, { recursive: true });

		const validContent = `{"event":"start","timestamp":"2024-01-01T00:00:00Z"}
{"event":"end","timestamp":"2024-01-01T00:01:00Z"}`;

		await writeFile(join(agentDir, "events.ndjson"), validContent);
		await writeFile(join(agentDir, "tools.ndjson"), validContent);

		const checks = await checkLogs(mockConfig, overstoryDir);

		const integrityCheck = checks.find((c) => c.name === "NDJSON integrity");
		expect(integrityCheck).toBeDefined();
		expect(integrityCheck?.status).toBe("pass");
	});

	test("detects orphaned toolStart events", async () => {
		await mkdir(logsDir, { recursive: true });
		const agentDir = join(logsDir, "test-agent", "session-1");
		await mkdir(agentDir, { recursive: true });

		// toolStart without matching toolEnd
		const content = `{"event":"toolStart","tool":"Read","timestamp":"2024-01-01T00:00:00Z"}
{"event":"toolStart","tool":"Write","timestamp":"2024-01-01T00:01:00Z"}
{"event":"toolEnd","tool":"Write","timestamp":"2024-01-01T00:02:00Z"}`;

		await writeFile(join(agentDir, "tools.ndjson"), content);

		const checks = await checkLogs(mockConfig, overstoryDir);

		const orphanCheck = checks.find((c) => c.name === "Orphaned tool events");
		expect(orphanCheck).toBeDefined();
		expect(orphanCheck?.status).toBe("warn");
		expect(orphanCheck?.message).toContain("incomplete");
		expect(orphanCheck?.details?.some((d) => d.includes("Read"))).toBe(true);
	});

	test("handles missing tools.ndjson gracefully", async () => {
		await mkdir(logsDir, { recursive: true });
		const agentDir = join(logsDir, "test-agent", "session-1");
		await mkdir(agentDir, { recursive: true });

		// Only create events.ndjson, no tools.ndjson
		await writeFile(join(agentDir, "events.ndjson"), '{"event":"start"}');

		const checks = await checkLogs(mockConfig, overstoryDir);

		// Should not crash, should pass NDJSON integrity
		const integrityCheck = checks.find((c) => c.name === "NDJSON integrity");
		expect(integrityCheck).toBeDefined();
		expect(integrityCheck?.status).toBe("pass");
	});

	test("handles empty logs directory gracefully", async () => {
		await mkdir(logsDir, { recursive: true });

		const checks = await checkLogs(mockConfig, overstoryDir);

		expect(checks.length).toBeGreaterThan(0);
		const dirCheck = checks.find((c) => c.name === "logs/ directory");
		expect(dirCheck?.status).toBe("pass");
	});
});

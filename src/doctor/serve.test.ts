import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OverstoryConfig } from "../types.ts";
import { checkServe } from "./serve.ts";

describe("checkServe", () => {
	let tempDir: string;
	let mockConfig: OverstoryConfig;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "overstory-serve-doctor-test-"));
		mockConfig = {
			project: { name: "test", root: tempDir, canonicalBranch: "main" },
			agents: {
				manifestPath: "",
				baseDir: "",
				maxConcurrent: 5,
				staggerDelayMs: 100,
				maxDepth: 2,
				maxSessionsPerRun: 0,
				maxAgentsPerLead: 5,
			},
			worktrees: { baseDir: "" },
			taskTracker: { backend: "auto", enabled: true },
			mulch: { enabled: true, domains: [], primeFormat: "markdown" },
			merge: { aiResolveEnabled: false, reimagineEnabled: false },
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
			logging: { verbose: false, redactSecrets: true },
		};
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	test("ui/dist missing — returns warn about missing build", async () => {
		const checks = await checkServe(mockConfig, tempDir);
		const distCheck = checks.find((c) => c.name === "serve ui/dist");

		expect(distCheck).toBeDefined();
		expect(distCheck?.status).toBe("warn");
		expect(distCheck?.message).toContain("ui/dist not found");
		expect(distCheck?.details?.some((d) => d.includes("ui/dist"))).toBe(true);
	});

	test("ui/dist exists but index.html missing — returns warn about incomplete build", async () => {
		mkdirSync(join(tempDir, "ui", "dist"), { recursive: true });
		const checks = await checkServe(mockConfig, tempDir);
		const distCheck = checks.find((c) => c.name === "serve ui/dist");

		expect(distCheck).toBeDefined();
		expect(distCheck?.status).toBe("warn");
		expect(distCheck?.message).toContain("index.html is missing");
	});

	test("ui/dist with index.html — returns pass", async () => {
		mkdirSync(join(tempDir, "ui", "dist"), { recursive: true });
		writeFileSync(join(tempDir, "ui", "dist", "index.html"), "<html></html>");
		const checks = await checkServe(mockConfig, tempDir);
		const distCheck = checks.find((c) => c.name === "serve ui/dist");

		expect(distCheck).toBeDefined();
		expect(distCheck?.status).toBe("pass");
		expect(distCheck?.message).toContain("index.html");
	});

	test("port check included in results", async () => {
		const checks = await checkServe(mockConfig, tempDir);
		const portCheck = checks.find((c) => c.name === "serve port");

		expect(portCheck).toBeDefined();
		// Server not running — should warn (or pass if something happens to be on 8080)
		expect(portCheck?.status === "warn" || portCheck?.status === "pass").toBe(true);
	});

	test("returns exactly 2 checks (ui/dist + port)", async () => {
		const checks = await checkServe(mockConfig, tempDir);
		expect(checks).toHaveLength(2);
		expect(checks.map((c) => c.category).every((cat) => cat === "serve")).toBe(true);
	});
});

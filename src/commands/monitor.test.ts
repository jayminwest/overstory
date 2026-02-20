/**
 * Tests for src/commands/monitor.ts
 *
 * Note: We do NOT test start/stop/status subcommands here because they require
 * tmux session management, which is fragile in test environments and interferes
 * with developer tmux sessions. Those operations are covered by E2E testing.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { AgentError, ValidationError } from "../errors.ts";
import { cleanupTempDir, createTempGitRepo } from "../test-helpers.ts";
import { buildMonitorBeacon, monitorCommand } from "./monitor.ts";
import { isRunningAsRoot } from "./sling.ts";

describe("buildMonitorBeacon", () => {
	test("contains monitor agent name", () => {
		const beacon = buildMonitorBeacon();
		expect(beacon).toContain("monitor");
	});

	test("contains tier-2 designation", () => {
		const beacon = buildMonitorBeacon();
		expect(beacon).toContain("tier-2");
	});

	test("contains ISO timestamp with today's date", () => {
		const beacon = buildMonitorBeacon();
		const today = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
		if (!today) {
			throw new Error("Failed to extract date from ISO string");
		}
		expect(beacon).toContain(today);
	});

	test("contains startup instruction: overstory init", () => {
		const beacon = buildMonitorBeacon();
		expect(beacon).toContain("overstory init");
	});

	test("contains startup instruction: overstory status --json", () => {
		const beacon = buildMonitorBeacon();
		expect(beacon).toContain("overstory status --json");
	});

	test("contains startup instruction: overstory mail check --agent monitor", () => {
		const beacon = buildMonitorBeacon();
		expect(beacon).toContain("overstory mail check --agent monitor");
	});

	test("contains startup instruction: patrol loop", () => {
		const beacon = buildMonitorBeacon();
		expect(beacon).toContain("patrol loop");
	});

	test("contains [OVERSTORY] prefix", () => {
		const beacon = buildMonitorBeacon();
		expect(beacon).toContain("[OVERSTORY]");
	});

	test("contains Depth: 0", () => {
		const beacon = buildMonitorBeacon();
		expect(beacon).toContain("Depth: 0");
	});

	test("contains Parent: none", () => {
		const beacon = buildMonitorBeacon();
		expect(beacon).toContain("Parent: none");
	});
});

describe("monitorCommand", () => {
	let stdoutSpy: ReturnType<typeof spyOn>;
	let stdoutWrites: string[] = [];

	beforeEach(() => {
		stdoutWrites = [];
		stdoutSpy = spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
			stdoutWrites.push(String(chunk));
			return true;
		});
	});

	afterEach(() => {
		stdoutSpy.mockRestore();
	});

	test("--help prints help text containing 'overstory monitor'", async () => {
		await monitorCommand(["--help"]);
		const output = stdoutWrites.join("");
		expect(output).toContain("overstory monitor");
	});

	test("--help prints help text containing 'start'", async () => {
		await monitorCommand(["--help"]);
		const output = stdoutWrites.join("");
		expect(output).toContain("start");
	});

	test("--help prints help text containing 'stop'", async () => {
		await monitorCommand(["--help"]);
		const output = stdoutWrites.join("");
		expect(output).toContain("stop");
	});

	test("--help prints help text containing 'status'", async () => {
		await monitorCommand(["--help"]);
		const output = stdoutWrites.join("");
		expect(output).toContain("status");
	});

	test("-h prints help text", async () => {
		await monitorCommand(["-h"]);
		const output = stdoutWrites.join("");
		expect(output).toContain("overstory monitor");
	});

	test("empty args [] shows help (same as --help)", async () => {
		await monitorCommand([]);
		const output = stdoutWrites.join("");
		expect(output).toContain("overstory monitor");
	});

	test("unknown subcommand 'restart' throws ValidationError", async () => {
		await expect(monitorCommand(["restart"])).rejects.toThrow(ValidationError);
	});

	test("unknown subcommand error message contains the bad value 'restart'", async () => {
		try {
			await monitorCommand(["restart"]);
			// Should not reach here
			expect(true).toBe(false);
		} catch (err) {
			if (err instanceof ValidationError) {
				expect(err.message).toContain("restart");
			} else {
				throw err;
			}
		}
	});

	describe("tier2Enabled gate", () => {
		let tempDir: string;
		const originalCwd = process.cwd();
		let originalGetuid: (() => number) | undefined;

		beforeEach(async () => {
			originalGetuid = process.getuid;
			process.getuid = () => 1000;
			process.chdir(originalCwd);
			tempDir = await createTempGitRepo();
			const overstoryDir = join(tempDir, ".overstory");
			await mkdir(overstoryDir, { recursive: true });
			// Write minimal config — tier2Enabled defaults to false
			await Bun.write(
				join(overstoryDir, "config.yaml"),
				["project:", "  name: test-project", `  root: ${tempDir}`, "  canonicalBranch: main"].join(
					"\n",
				),
			);
			process.chdir(tempDir);
		});

		afterEach(async () => {
			process.getuid = originalGetuid;
			process.chdir(originalCwd);
			await cleanupTempDir(tempDir);
		});

		test("monitor start throws AgentError when tier2Enabled is false (default)", async () => {
			await expect(monitorCommand(["start"])).rejects.toThrow(AgentError);
		});

		test("monitor start error message contains 'disabled' when tier2Enabled is false", async () => {
			try {
				await monitorCommand(["start"]);
				expect(true).toBe(false); // Should not reach here
			} catch (err) {
				if (err instanceof AgentError) {
					expect(err.message).toContain("disabled");
				} else {
					throw err;
				}
			}
		});

		test("monitor start enforces root check when cli base is claude", async () => {
			process.getuid = () => 0;
			try {
				await monitorCommand(["start"]);
				expect(true).toBe(false);
			} catch (err) {
				if (err instanceof AgentError) {
					expect(err.message).toContain("Cannot spawn agents as root");
				} else {
					throw err;
				}
			}
		});

		test("monitor start skips root check when cli base is codex", async () => {
			process.getuid = () => 0;
			await Bun.write(
				join(tempDir, ".overstory", "config.yaml"),
				[
					"project:",
					"  name: test-project",
					`  root: ${tempDir}`,
					"  canonicalBranch: main",
					"cli:",
					"  base: codex",
				].join("\n"),
			);

			try {
				await monitorCommand(["start"]);
				expect(true).toBe(false);
			} catch (err) {
				if (err instanceof AgentError) {
					expect(err.message).toContain("disabled");
					expect(err.message).not.toContain("Cannot spawn agents as root");
				} else {
					throw err;
				}
			}
		});
	});
});

describe("isRunningAsRoot (imported from sling)", () => {
	test("is accessible from monitor test file", () => {
		expect(isRunningAsRoot(() => 0)).toBe(true);
		expect(isRunningAsRoot(() => 1000)).toBe(false);
	});
});

/**
 * Tests for overstory dashboard command.
 *
 * We only test help output and validation since the dashboard runs an infinite
 * polling loop. The actual rendering cannot be tested without complex mocking
 * of terminal state and multiple data sources.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ValidationError } from "../errors.ts";
import { dashboardCommand } from "./dashboard.ts";

describe("dashboardCommand", () => {
	let chunks: string[];
	let originalWrite: typeof process.stdout.write;
	let tempDir: string;

	beforeEach(async () => {
		chunks = [];
		originalWrite = process.stdout.write;
		process.stdout.write = ((chunk: string) => {
			chunks.push(chunk);
			return true;
		}) as typeof process.stdout.write;

		tempDir = await mkdtemp(join(tmpdir(), "dashboard-test-"));
	});

	afterEach(async () => {
		process.stdout.write = originalWrite;
		await rm(tempDir, { recursive: true, force: true });
	});

	function output(): string {
		return chunks.join("");
	}

	test("--help flag prints help text", async () => {
		await dashboardCommand(["--help"]);
		const out = output();

		expect(out).toContain("overstory dashboard");
		expect(out).toContain("--interval");
		expect(out).toContain("Ctrl+C");
	});

	test("-h flag prints help text", async () => {
		await dashboardCommand(["-h"]);
		const out = output();

		expect(out).toContain("overstory dashboard");
		expect(out).toContain("--interval");
		expect(out).toContain("Ctrl+C");
	});

	test("--interval with non-numeric value throws ValidationError", async () => {
		await expect(dashboardCommand(["--interval", "abc"])).rejects.toThrow(ValidationError);
	});

	test("--interval below 500 throws ValidationError", async () => {
		await expect(dashboardCommand(["--interval", "499"])).rejects.toThrow(ValidationError);
	});

	test("--interval with NaN throws ValidationError", async () => {
		await expect(dashboardCommand(["--interval", "not-a-number"])).rejects.toThrow(ValidationError);
	});

	test("--interval at exactly 500 passes validation", async () => {
		// This test verifies that interval validation passes for the value 500.
		// We chdir to a temp dir WITHOUT .overstory/config.yaml so that loadConfig()
		// throws BEFORE the infinite while loop starts. This proves validation passed
		// (no ValidationError about interval) while preventing the loop from leaking.

		const originalCwd = process.cwd();

		try {
			process.chdir(tempDir);
			await dashboardCommand(["--interval", "500"]);
		} catch (err) {
			// If it's a ValidationError about interval, the test should fail
			if (err instanceof ValidationError && err.field === "interval") {
				throw new Error("Interval validation should have passed for value 500");
			}
			// Other errors (like from loadConfig) are expected - they occur after validation passed
		} finally {
			process.chdir(originalCwd);
		}

		// If we reach here without throwing a ValidationError about interval, validation passed
	});

	test("help text includes --all flag", async () => {
		await dashboardCommand(["--help"]);
		const out = output();

		expect(out).toContain("--all");
	});

	test("help text describes current run scoping", async () => {
		await dashboardCommand(["--help"]);
		const out = output();

		expect(out).toContain("current run");
	});
});

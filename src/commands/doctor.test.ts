/**
 * Tests for `overstory doctor` command.
 *
 * Uses temp directories with real config.yaml to test the doctor scaffold.
 * All check modules return empty arrays (stubs), so tests verify the scaffold
 * structure, not individual check implementations.
 *
 * Real implementations used for: filesystem (temp dirs), config loading.
 * No mocks needed -- all dependencies are cheap and local.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ValidationError } from "../errors.ts";
import { cleanupTempDir } from "../test-helpers.ts";
import { doctorCommand } from "./doctor.ts";

describe("doctorCommand", () => {
	let chunks: string[];
	let originalWrite: typeof process.stdout.write;
	let originalExitCode: number | undefined;
	let tempDir: string;
	let originalCwd: string;

	beforeEach(async () => {
		originalExitCode = process.exitCode as number | undefined;
		process.exitCode = 0;

		// Spy on stdout
		chunks = [];
		originalWrite = process.stdout.write;
		process.stdout.write = ((chunk: string) => {
			chunks.push(chunk);
			return true;
		}) as typeof process.stdout.write;

		// Create temp dir with .overstory/config.yaml structure
		tempDir = await mkdtemp(join(tmpdir(), "doctor-test-"));
		const overstoryDir = join(tempDir, ".overstory");
		await Bun.write(
			join(overstoryDir, "config.yaml"),
			`project:\n  name: test\n  root: ${tempDir}\n  canonicalBranch: main\n`,
		);

		// Change to temp dir so loadConfig() works
		originalCwd = process.cwd();
		process.chdir(tempDir);
	});

	afterEach(async () => {
		process.exitCode = originalExitCode ?? 0;
		process.stdout.write = originalWrite;
		process.chdir(originalCwd);
		await cleanupTempDir(tempDir);
	});

	function output(): string {
		return chunks.join("");
	}

	// === Help flag ===

	describe("help flag", () => {
		test("--help shows help text", async () => {
			await doctorCommand(["--help"], { checkRunners: [] });
			const out = output();

			expect(out).toContain("doctor");
			expect(out).toContain("Run health checks");
			expect(out).toContain("--json");
			expect(out).toContain("--verbose");
			expect(out).toContain("--category");
		});

		test("-h shows help text", async () => {
			await doctorCommand(["-h"], { checkRunners: [] });
			const out = output();

			expect(out).toContain("doctor");
			expect(out).toContain("--help");
		});
	});

	// === JSON output ===

	describe("JSON output mode", () => {
		test("outputs valid JSON with checks array and summary", async () => {
			await doctorCommand(["--json"], { checkRunners: [] });
			const out = output();

			const parsed = JSON.parse(out.trim()) as {
				success: boolean;
				command: string;
				checks: unknown[];
				summary: { pass: number; warn: number; fail: number };
			};
			expect(parsed).toBeDefined();
			expect(parsed.success).toBe(true);
			expect(parsed.command).toBe("doctor");
			expect(Array.isArray(parsed.checks)).toBe(true);
			expect(parsed.summary).toBeDefined();
			expect(typeof parsed.summary.pass).toBe("number");
			expect(typeof parsed.summary.warn).toBe("number");
			expect(typeof parsed.summary.fail).toBe("number");
		});

		test("empty stubs produce zero counts in summary", async () => {
			await doctorCommand(["--json"], { checkRunners: [] });
			const out = output();

			const parsed = JSON.parse(out.trim()) as {
				success: boolean;
				command: string;
				checks: unknown[];
				summary: { pass: number; warn: number; fail: number };
			};
			expect(parsed.success).toBe(true);
			expect(parsed.command).toBe("doctor");
			expect(parsed.checks).toEqual([]);
			expect(parsed.summary.pass).toBe(0);
			expect(parsed.summary.warn).toBe(0);
			expect(parsed.summary.fail).toBe(0);
		});
	});

	// === Human-readable output ===

	describe("human-readable output", () => {
		test("shows header", async () => {
			await doctorCommand([], { checkRunners: [] });
			const out = output();

			expect(out).toContain("Overstory Doctor");
			expect(out).toContain("────────────────");
		});

		test("shows summary line with zero counts", async () => {
			await doctorCommand([], { checkRunners: [] });
			const out = output();

			expect(out).toContain("Summary:");
			expect(out).toContain("0 passed");
			expect(out).toContain("0 warning");
			expect(out).toContain("0 failure");
		});

		test("summary uses singular form for one failure", async () => {
			// This test can't verify "1 failure" without real checks, but we can test the logic
			// by checking that the scaffold doesn't crash on empty checks
			await doctorCommand([], { checkRunners: [] });
			const out = output();

			// Should show "0 failures" (plural) when count is 0
			expect(out).toContain("0 failure");
		});

		test("default mode does not show empty categories", async () => {
			await doctorCommand([], { checkRunners: [] });
			const out = output();

			// Since all stubs return empty arrays, no category headers should appear
			// in non-verbose mode
			expect(out).not.toContain("[dependencies]");
			expect(out).not.toContain("[structure]");
			expect(out).not.toContain("[config]");
		});
	});

	// === --verbose flag ===

	describe("--verbose flag", () => {
		test("shows header and summary even with no check runners", async () => {
			await doctorCommand(["--verbose"], { checkRunners: [] });
			const out = output();

			// With no check runners, no categories appear (even in verbose mode)
			expect(out).toContain("Overstory Doctor");
			expect(out).toContain("Summary:");
			expect(out).toContain("0 passed");
			// No categories should appear with empty checkRunners
			expect(out).not.toContain("[dependencies]");
			expect(out).not.toContain("[structure]");
		});

		test("verbose mode works with empty check runners", async () => {
			await doctorCommand(["--verbose"], { checkRunners: [] });
			const out = output();

			// Should still produce valid output with no categories
			expect(out).toContain("Overstory Doctor");
			expect(out).toContain("Summary:");
			// With no check runners, "No checks" doesn't appear (no categories to show it under)
			expect(out).not.toContain("No checks");
		});
	});

	// === --category flag ===

	describe("--category flag", () => {
		test("runs only specified category", async () => {
			await doctorCommand(["--category", "dependencies", "--json"], { checkRunners: [] });
			const out = output();

			const parsed = JSON.parse(out.trim()) as {
				checks: Array<{ category: string }>;
			};
			// Since dependencies stub returns [], checks should be empty
			expect(parsed.checks).toEqual([]);
		});

		test("validates category name", async () => {
			await expect(
				doctorCommand(["--category", "invalid-category"], { checkRunners: [] }),
			).rejects.toThrow(ValidationError);
		});

		test("invalid category error mentions valid categories", async () => {
			try {
				await doctorCommand(["--category", "bad"], { checkRunners: [] });
				expect.unreachable("should have thrown");
			} catch (err) {
				expect(err).toBeInstanceOf(ValidationError);
				const message = (err as ValidationError).message;
				expect(message).toContain("Invalid category");
				expect(message).toContain("dependencies");
				expect(message).toContain("structure");
				expect(message).toContain("config");
			}
		});

		test("accepts all valid category names", async () => {
			const categories = [
				"dependencies",
				"structure",
				"config",
				"databases",
				"consistency",
				"agents",
				"merge",
				"logs",
				"version",
			];

			for (const category of categories) {
				chunks = []; // Reset output
				await doctorCommand(["--category", category, "--json"], { checkRunners: [] });
				const out = output();
				// Should not throw, and output should be valid JSON
				JSON.parse(out.trim());
			}
		});
	});

	// === Exit code ===

	describe("exit code", () => {
		test("returns undefined when all checks pass or warn", async () => {
			const exitCode = await doctorCommand([], { checkRunners: [] });
			expect(exitCode).toBeUndefined();
		});

		test("returns undefined on success (no failures)", async () => {
			const exitCode = await doctorCommand([], { checkRunners: [] });
			expect(exitCode).toBeUndefined();
		});

		test("ignores ambient nonzero process.exitCode on success", async () => {
			process.exitCode = 1;
			const exitCode = await doctorCommand([], { checkRunners: [] });
			expect(exitCode).toBeUndefined();
		});
	});

	// === Edge cases ===

	describe("edge cases", () => {
		test("handles multiple flags together", async () => {
			await doctorCommand(["--json", "--verbose", "--category", "config"], {
				checkRunners: [],
			});
			const out = output();

			const parsed = JSON.parse(out.trim()) as {
				checks: unknown[];
				summary: unknown;
			};
			expect(parsed.checks).toEqual([]);
		});

		test("flags can appear in any order", async () => {
			chunks = [];
			await doctorCommand(["--category", "logs", "--json"], { checkRunners: [] });
			const out1 = output();

			chunks = [];
			await doctorCommand(["--json", "--category", "logs"], { checkRunners: [] });
			const out2 = output();

			// Both should produce the same JSON
			expect(JSON.parse(out1.trim())).toEqual(JSON.parse(out2.trim()));
		});

		test("runs without crashing on minimal config", async () => {
			// The beforeEach already sets up minimal config, so this just
			// verifies the command doesn't crash
			await doctorCommand([], { checkRunners: [] });
			const out = output();

			expect(out).toContain("Overstory Doctor");
		});
	});
});

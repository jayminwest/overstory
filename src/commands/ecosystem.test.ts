/**
 * Tests for the ov ecosystem command.
 *
 * Structural tests for CLI registration, plus a smoke test that runs the
 * actual command and verifies the JSON output shape. The smoke test hits
 * real CLIs and the npm registry, so it requires network access.
 */

import { describe, expect, test } from "bun:test";
import {
	createEcosystemCommand,
	executeEcosystem,
	formatDoctorLine,
	printHumanOutput,
	type ToolResult,
} from "./ecosystem.ts";

describe("createEcosystemCommand — CLI structure", () => {
	test("command has correct name", () => {
		const cmd = createEcosystemCommand();
		expect(cmd.name()).toBe("ecosystem");
	});

	test("description mentions os-eco", () => {
		const cmd = createEcosystemCommand();
		expect(cmd.description().toLowerCase()).toContain("os-eco");
	});

	test("has --json option", () => {
		const cmd = createEcosystemCommand();
		const optionNames = cmd.options.map((o) => o.long);
		expect(optionNames).toContain("--json");
	});

	test("returns a Command instance", () => {
		const cmd = createEcosystemCommand();
		expect(typeof cmd.parse).toBe("function");
	});
});

describe("executeEcosystem — JSON output shape", () => {
	test("--json produces valid JSON with expected structure", async () => {
		// Capture stdout
		const chunks: string[] = [];
		const originalWrite = process.stdout.write;
		process.stdout.write = (chunk: string | Uint8Array) => {
			chunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
			return true;
		};

		try {
			await executeEcosystem({ json: true });
		} finally {
			process.stdout.write = originalWrite;
		}

		const output = chunks.join("");
		const parsed = JSON.parse(output.trim());

		// Envelope
		expect(parsed.success).toBe(true);
		expect(parsed.command).toBe("ecosystem");

		// Tools array
		expect(Array.isArray(parsed.tools)).toBe(true);
		expect(parsed.tools.length).toBeGreaterThan(0);

		// Each tool has required fields
		for (const tool of parsed.tools) {
			expect(typeof tool.name).toBe("string");
			expect(typeof tool.cli).toBe("string");
			expect(typeof tool.npm).toBe("string");
			expect(typeof tool.installed).toBe("boolean");
		}

		// Summary
		expect(typeof parsed.summary).toBe("object");
		expect(typeof parsed.summary.total).toBe("number");
		expect(typeof parsed.summary.installed).toBe("number");
		expect(typeof parsed.summary.missing).toBe("number");
		expect(typeof parsed.summary.outdated).toBe("number");
		expect(parsed.summary.total).toBe(parsed.tools.length);
	}, 30_000); // Network calls may be slow

	test("includes overstory in tool list", async () => {
		const chunks: string[] = [];
		const originalWrite = process.stdout.write;
		process.stdout.write = (chunk: string | Uint8Array) => {
			chunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
			return true;
		};

		try {
			await executeEcosystem({ json: true });
		} finally {
			process.stdout.write = originalWrite;
		}

		const parsed = JSON.parse(chunks.join("").trim());
		const overstory = parsed.tools.find((t: { name: string }) => t.name === "overstory");
		expect(overstory).toBeDefined();
		// In CI, `ov` may not be globally installed — only assert version when installed
		if (overstory.installed) {
			expect(overstory.version).toBeDefined();
		}
	}, 30_000);
});

describe("formatDoctorLine", () => {
	test("pass-only shows green passed count", () => {
		const result = formatDoctorLine({ pass: 5, warn: 0, fail: 0 });
		expect(result).toContain("5 passed");
		expect(result).not.toContain("warn");
		expect(result).not.toContain("fail");
	});

	test("warn and fail without pass", () => {
		const result = formatDoctorLine({ pass: 0, warn: 2, fail: 3 });
		expect(result).toContain("2 warn");
		expect(result).toContain("3 fail");
		expect(result).not.toContain("passed");
	});

	test("all three counts present", () => {
		const result = formatDoctorLine({ pass: 10, warn: 1, fail: 2 });
		expect(result).toContain("10 passed");
		expect(result).toContain("1 warn");
		expect(result).toContain("2 fail");
	});

	test("all-zero returns 'no checks'", () => {
		const result = formatDoctorLine({ pass: 0, warn: 0, fail: 0 });
		expect(result).toBe("no checks");
	});
});

// getInstalledVersion tests moved to src/utils/version.test.ts

describe("printHumanOutput", () => {
	function capturePrintOutput(results: ToolResult[]): string {
		const chunks: string[] = [];
		const original = process.stdout.write;
		process.stdout.write = (chunk: string | Uint8Array) => {
			chunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
			return true;
		};
		try {
			printHumanOutput(results);
		} finally {
			process.stdout.write = original;
		}
		return chunks.join("");
	}

	test("shows installed tool with version", () => {
		const results: ToolResult[] = [
			{
				name: "test-tool",
				cli: "tt",
				npm: "@test/tool",
				installed: true,
				version: "1.2.3",
				latest: "1.2.3",
				upToDate: true,
			},
		];
		const output = capturePrintOutput(results);
		expect(output).toContain("test-tool");
		expect(output).toContain("1.2.3");
		expect(output).toContain("up to date");
		expect(output).toContain("1/1 installed");
	});

	test("shows not-installed tool with install hint", () => {
		const results: ToolResult[] = [
			{
				name: "missing-tool",
				cli: "mt",
				npm: "@test/missing",
				installed: false,
			},
		];
		const output = capturePrintOutput(results);
		expect(output).toContain("missing-tool");
		expect(output).toContain("not installed");
		expect(output).toContain("npm i -g @test/missing");
		expect(output).toContain("1 missing");
	});

	test("shows outdated tool with latest version", () => {
		const results: ToolResult[] = [
			{
				name: "old-tool",
				cli: "ot",
				npm: "@test/old",
				installed: true,
				version: "1.0.0",
				latest: "2.0.0",
				upToDate: false,
			},
		];
		const output = capturePrintOutput(results);
		expect(output).toContain("old-tool");
		expect(output).toContain("1.0.0");
		expect(output).toContain("outdated");
		expect(output).toContain("2.0.0");
		expect(output).toContain("1 outdated");
	});

	test("shows latestError gracefully", () => {
		const results: ToolResult[] = [
			{
				name: "err-tool",
				cli: "et",
				npm: "@test/err",
				installed: true,
				version: "1.0.0",
				latestError: "network timeout",
			},
		];
		const output = capturePrintOutput(results);
		expect(output).toContain("err-tool");
		expect(output).toContain("1.0.0");
		expect(output).toContain("version check failed");
	});
});

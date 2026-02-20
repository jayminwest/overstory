import { describe, expect, test } from "bun:test";
import { isRunningAsRoot } from "./sling.ts";
import { buildSupervisorBeacon, supervisorCommand } from "./supervisor.ts";

/**
 * Tests for supervisor command functions.
 *
 * Session persistence is now handled by SessionStore (SQLite).
 * Those tests live in src/sessions/store.test.ts and src/sessions/compat.test.ts.
 * Here we test beacon generation.
 */

describe("buildSupervisorBeacon", () => {
	test("contains agent name and beadId from opts", () => {
		const beacon = buildSupervisorBeacon({
			name: "supervisor-1",
			beadId: "task-abc123",
			depth: 1,
			parent: "coordinator",
		});

		expect(beacon).toContain("supervisor-1");
		expect(beacon).toContain("task-abc123");
	});

	test("contains [OVERSTORY] prefix", () => {
		const beacon = buildSupervisorBeacon({
			name: "supervisor-1",
			beadId: "task-1",
			depth: 1,
			parent: "coordinator",
		});

		expect(beacon).toContain("[OVERSTORY]");
	});

	test("contains (supervisor) designation", () => {
		const beacon = buildSupervisorBeacon({
			name: "supervisor-1",
			beadId: "task-1",
			depth: 1,
			parent: "coordinator",
		});

		expect(beacon).toContain("(supervisor)");
	});

	test("contains depth and parent info from opts", () => {
		const beacon = buildSupervisorBeacon({
			name: "supervisor-1",
			beadId: "task-1",
			depth: 2,
			parent: "lead-cli",
		});

		expect(beacon).toContain("Depth: 2");
		expect(beacon).toContain("Parent: lead-cli");
	});

	test("contains startup instructions", () => {
		const beacon = buildSupervisorBeacon({
			name: "supervisor-1",
			beadId: "task-1",
			depth: 1,
			parent: "coordinator",
		});

		// Should include overstory init
		expect(beacon).toContain("overstory init");

		// Should include mail check with agent name
		expect(beacon).toContain("overstory mail check --agent supervisor-1");

		// Should include optional bd show with beadId
		expect(beacon).toContain("bd show task-1 if available");
	});

	test("contains ISO timestamp", () => {
		const before = new Date();
		const beacon = buildSupervisorBeacon({
			name: "supervisor-1",
			beadId: "task-1",
			depth: 1,
			parent: "coordinator",
		});
		const after = new Date();

		// Extract timestamp from beacon (format: [OVERSTORY] {name} (supervisor) {timestamp} task:{beadId})
		const timestampMatch = beacon.match(/\(supervisor\)\s+(\S+)\s+task:/);
		expect(timestampMatch).toBeTruthy();

		if (timestampMatch?.[1]) {
			const timestamp = new Date(timestampMatch[1]);
			expect(timestamp.getTime()).toBeGreaterThanOrEqual(before.getTime());
			expect(timestamp.getTime()).toBeLessThanOrEqual(after.getTime());

			// Verify ISO format (should parse correctly)
			expect(timestamp.toISOString()).toBeTruthy();
		}
	});
});

describe("supervisorCommand", () => {
	test("--help prints help containing required keywords", async () => {
		const originalWrite = process.stdout.write;
		let output = "";
		process.stdout.write = ((chunk: string) => {
			output += chunk;
			return true;
		}) as typeof process.stdout.write;

		try {
			await supervisorCommand(["--help"]);
			expect(output).toContain("overstory supervisor");
			expect(output).toContain("start");
			expect(output).toContain("stop");
			expect(output).toContain("status");
			expect(output).toContain("--task");
			expect(output).toContain("--name");
		} finally {
			process.stdout.write = originalWrite;
		}
	});

	test("-h prints help", async () => {
		const originalWrite = process.stdout.write;
		let output = "";
		process.stdout.write = ((chunk: string) => {
			output += chunk;
			return true;
		}) as typeof process.stdout.write;

		try {
			await supervisorCommand(["-h"]);
			expect(output).toContain("overstory supervisor");
		} finally {
			process.stdout.write = originalWrite;
		}
	});

	test("empty args [] shows help", async () => {
		const originalWrite = process.stdout.write;
		let output = "";
		process.stdout.write = ((chunk: string) => {
			output += chunk;
			return true;
		}) as typeof process.stdout.write;

		try {
			await supervisorCommand([]);
			expect(output).toContain("overstory supervisor");
		} finally {
			process.stdout.write = originalWrite;
		}
	});

	test("unknown subcommand throws ValidationError with bad value in message", async () => {
		expect(async () => {
			await supervisorCommand(["invalid-subcommand"]);
		}).toThrow(/invalid-subcommand/);
	});

	test("start without --task throws ValidationError", async () => {
		expect(async () => {
			await supervisorCommand(["start", "--name", "supervisor-1"]);
		}).toThrow(/--task/);
	});

	test("start without --name throws ValidationError", async () => {
		expect(async () => {
			await supervisorCommand(["start", "--task", "task-1"]);
		}).toThrow(/--name/);
	});

	test("stop without --name throws ValidationError", async () => {
		expect(async () => {
			await supervisorCommand(["stop"]);
		}).toThrow(/--name/);
	});
});

describe("isRunningAsRoot (imported from sling)", () => {
	test("is accessible from supervisor test file", () => {
		expect(isRunningAsRoot(() => 0)).toBe(true);
		expect(isRunningAsRoot(() => 1000)).toBe(false);
	});
});

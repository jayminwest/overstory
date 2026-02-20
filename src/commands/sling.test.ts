import { describe, expect, test } from "bun:test";
import { HierarchyError } from "../errors.ts";
import {
	type BeaconOptions,
	buildBeacon,
	calculateStaggerDelay,
	isRunningAsRoot,
	parentHasScouts,
	validateHierarchy,
} from "./sling.ts";

/**
 * Tests for the stagger delay enforcement in the sling command (step 4b).
 *
 * The stagger delay logic prevents rapid-fire agent spawning by requiring
 * a minimum delay between consecutive spawns. If the most recently started
 * active session was spawned less than staggerDelayMs ago, the sling command
 * sleeps for the remaining time.
 *
 * calculateStaggerDelay is a pure function that returns the number of
 * milliseconds to sleep (0 if no delay is needed). The sling command calls
 * Bun.sleep with the returned value if it's greater than 0.
 */

// --- Helpers ---

function makeSession(startedAt: string): { startedAt: string } {
	return { startedAt };
}

describe("calculateStaggerDelay", () => {
	test("returns remaining delay when a recent session exists", () => {
		const now = Date.now();
		// Session started 500ms ago, stagger delay is 2000ms -> should return ~1500ms
		const sessions = [makeSession(new Date(now - 500).toISOString())];

		const delay = calculateStaggerDelay(2_000, sessions, now);

		expect(delay).toBe(1_500);
	});

	test("returns 0 when staggerDelayMs is 0", () => {
		const now = Date.now();
		// Even with a very recent session, delay of 0 means no stagger
		const sessions = [makeSession(new Date(now - 100).toISOString())];

		const delay = calculateStaggerDelay(0, sessions, now);

		expect(delay).toBe(0);
	});

	test("returns 0 when no active sessions exist", () => {
		const now = Date.now();

		const delay = calculateStaggerDelay(5_000, [], now);

		expect(delay).toBe(0);
	});

	test("returns 0 when enough time has already elapsed", () => {
		const now = Date.now();
		// Session started 10 seconds ago, stagger delay is 2 seconds -> no delay
		const sessions = [makeSession(new Date(now - 10_000).toISOString())];

		const delay = calculateStaggerDelay(2_000, sessions, now);

		expect(delay).toBe(0);
	});

	test("returns 0 when elapsed time exactly equals stagger delay", () => {
		const now = Date.now();
		// Session started exactly 2000ms ago, stagger delay is 2000ms -> remaining = 0
		const sessions = [makeSession(new Date(now - 2_000).toISOString())];

		const delay = calculateStaggerDelay(2_000, sessions, now);

		expect(delay).toBe(0);
	});

	test("uses the most recent session for calculation with multiple sessions", () => {
		const now = Date.now();
		// Two sessions: one old (5s ago), one recent (200ms ago)
		// With staggerDelayMs=2000, delay should be based on the 200ms-old session
		const sessions = [
			makeSession(new Date(now - 5_000).toISOString()),
			makeSession(new Date(now - 200).toISOString()),
		];

		const delay = calculateStaggerDelay(2_000, sessions, now);

		expect(delay).toBe(1_800);
	});

	test("handles sessions in any order (most recent is not last)", () => {
		const now = Date.now();
		// Most recent session is first in the array
		const sessions = [
			makeSession(new Date(now - 300).toISOString()),
			makeSession(new Date(now - 5_000).toISOString()),
			makeSession(new Date(now - 10_000).toISOString()),
		];

		const delay = calculateStaggerDelay(2_000, sessions, now);

		expect(delay).toBe(1_700);
	});

	test("returns 0 when staggerDelayMs is negative", () => {
		const now = Date.now();
		const sessions = [makeSession(new Date(now - 100).toISOString())];

		const delay = calculateStaggerDelay(-1_000, sessions, now);

		expect(delay).toBe(0);
	});

	test("returns full delay when session was just started (elapsed ~0)", () => {
		const now = Date.now();
		// Session started at exactly now
		const sessions = [makeSession(new Date(now).toISOString())];

		const delay = calculateStaggerDelay(3_000, sessions, now);

		expect(delay).toBe(3_000);
	});

	test("handles a single session correctly", () => {
		const now = Date.now();
		const sessions = [makeSession(new Date(now - 1_000).toISOString())];

		const delay = calculateStaggerDelay(5_000, sessions, now);

		expect(delay).toBe(4_000);
	});

	test("handles large stagger delay values", () => {
		const now = Date.now();
		const sessions = [makeSession(new Date(now - 1_000).toISOString())];

		const delay = calculateStaggerDelay(60_000, sessions, now);

		expect(delay).toBe(59_000);
	});

	test("all sessions old enough means no delay, regardless of count", () => {
		const now = Date.now();
		// Many sessions, but all started well before the stagger window
		const sessions = [
			makeSession(new Date(now - 30_000).toISOString()),
			makeSession(new Date(now - 25_000).toISOString()),
			makeSession(new Date(now - 20_000).toISOString()),
			makeSession(new Date(now - 15_000).toISOString()),
		];

		const delay = calculateStaggerDelay(5_000, sessions, now);

		expect(delay).toBe(0);
	});
});

/**
 * Tests for parentHasScouts check.
 *
 * parentHasScouts is used during sling to detect when a lead agent spawns a
 * builder without having previously spawned any scouts. This provides structural
 * enforcement of the scout-first workflow (Phase 1: explore, Phase 2: build).
 *
 * The function is non-blocking — it only emits a warning to stderr, but does
 * not prevent the spawn. This allows valid edge cases where scout-skip is
 * justified, while surfacing the pattern so agents and operators can see it.
 */

function makeAgentSession(
	parentAgent: string | null,
	capability: string,
): { parentAgent: string | null; capability: string } {
	return { parentAgent, capability };
}

describe("parentHasScouts", () => {
	test("returns false when sessions is empty", () => {
		expect(parentHasScouts([], "lead-alpha")).toBe(false);
	});

	test("returns false when parent has only builder children", () => {
		const sessions = [
			makeAgentSession("lead-alpha", "builder"),
			makeAgentSession("lead-alpha", "builder"),
		];

		expect(parentHasScouts(sessions, "lead-alpha")).toBe(false);
	});

	test("returns true when parent has a scout child", () => {
		const sessions = [makeAgentSession("lead-alpha", "scout")];

		expect(parentHasScouts(sessions, "lead-alpha")).toBe(true);
	});

	test("returns true when parent has scout + builder children", () => {
		const sessions = [
			makeAgentSession("lead-alpha", "scout"),
			makeAgentSession("lead-alpha", "builder"),
		];

		expect(parentHasScouts(sessions, "lead-alpha")).toBe(true);
	});

	test("ignores scouts from other parents", () => {
		const sessions = [
			makeAgentSession("lead-beta", "scout"),
			makeAgentSession("lead-gamma", "scout"),
			makeAgentSession("lead-alpha", "builder"),
		];

		expect(parentHasScouts(sessions, "lead-alpha")).toBe(false);
	});

	test("returns false when parent has only reviewer children", () => {
		const sessions = [
			makeAgentSession("lead-alpha", "reviewer"),
			makeAgentSession("lead-alpha", "reviewer"),
		];

		expect(parentHasScouts(sessions, "lead-alpha")).toBe(false);
	});

	test("returns true when parent has multiple scouts", () => {
		const sessions = [
			makeAgentSession("lead-alpha", "scout"),
			makeAgentSession("lead-alpha", "scout"),
			makeAgentSession("lead-alpha", "scout"),
		];

		expect(parentHasScouts(sessions, "lead-alpha")).toBe(true);
	});

	test("returns false when sessions contain null parents only", () => {
		const sessions = [makeAgentSession(null, "scout"), makeAgentSession(null, "builder")];

		expect(parentHasScouts(sessions, "lead-alpha")).toBe(false);
	});

	test("differentiates between parent names (case-sensitive)", () => {
		const sessions = [
			makeAgentSession("lead-alpha", "scout"),
			makeAgentSession("Lead-Alpha", "scout"),
		];

		// Should only find the exact match
		expect(parentHasScouts(sessions, "lead-alpha")).toBe(true);
		expect(parentHasScouts(sessions, "Lead-Alpha")).toBe(true);
		expect(parentHasScouts(sessions, "lead-beta")).toBe(false);
	});

	test("works with mixed capability types", () => {
		const sessions = [
			makeAgentSession("lead-alpha", "builder"),
			makeAgentSession("lead-alpha", "reviewer"),
			makeAgentSession("lead-alpha", "merger"),
		];

		expect(parentHasScouts(sessions, "lead-alpha")).toBe(false);
	});
});

/**
 * Tests for hierarchy validation in sling.
 *
 * validateHierarchy enforces that the coordinator (no --parent flag) can only
 * spawn lead agents. All other capabilities must be spawned by a lead or
 * supervisor that passes --parent. This prevents the flat delegation anti-pattern
 * where the coordinator short-circuits the hierarchy.
 */

describe("validateHierarchy", () => {
	test("rejects builder when parentAgent is null", () => {
		expect(() => validateHierarchy(null, "builder", "test-builder", 0, false)).toThrow(
			HierarchyError,
		);
	});

	test("rejects scout when parentAgent is null", () => {
		expect(() => validateHierarchy(null, "scout", "test-scout", 0, false)).toThrow(HierarchyError);
	});

	test("rejects reviewer when parentAgent is null", () => {
		expect(() => validateHierarchy(null, "reviewer", "test-reviewer", 0, false)).toThrow(
			HierarchyError,
		);
	});

	test("rejects merger when parentAgent is null", () => {
		expect(() => validateHierarchy(null, "merger", "test-merger", 0, false)).toThrow(
			HierarchyError,
		);
	});

	test("allows lead when parentAgent is null", () => {
		expect(() => validateHierarchy(null, "lead", "test-lead", 0, false)).not.toThrow();
	});

	test("allows builder when parentAgent is provided", () => {
		expect(() =>
			validateHierarchy("lead-alpha", "builder", "test-builder", 1, false),
		).not.toThrow();
	});

	test("allows scout when parentAgent is provided", () => {
		expect(() => validateHierarchy("lead-alpha", "scout", "test-scout", 1, false)).not.toThrow();
	});

	test("allows reviewer when parentAgent is provided", () => {
		expect(() =>
			validateHierarchy("lead-alpha", "reviewer", "test-reviewer", 1, false),
		).not.toThrow();
	});

	test("--force-hierarchy bypasses the check for builder", () => {
		expect(() => validateHierarchy(null, "builder", "test-builder", 0, true)).not.toThrow();
	});

	test("--force-hierarchy bypasses the check for scout", () => {
		expect(() => validateHierarchy(null, "scout", "test-scout", 0, true)).not.toThrow();
	});

	test("error has correct fields and code", () => {
		try {
			validateHierarchy(null, "builder", "my-builder", 0, false);
			expect.unreachable("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(HierarchyError);
			const he = err as HierarchyError;
			expect(he.code).toBe("HIERARCHY_VIOLATION");
			expect(he.agentName).toBe("my-builder");
			expect(he.requestedCapability).toBe("builder");
			expect(he.message).toContain("builder");
			expect(he.message).toContain("lead");
		}
	});
});

/**
 * Tests for the structured startup beacon sent to agents via tmux send-keys.
 *
 * buildBeacon is a pure function that constructs the first user message an
 * agent sees. It includes identity context (name, capability, task ID),
 * hierarchy info (depth, parent), and startup instructions.
 *
 * The beacon is a single-line string (parts joined by " — ") to prevent
 * multiline tmux send-keys issues (overstory-y2ob, overstory-cczf).
 */

function makeBeaconOpts(overrides?: Partial<BeaconOptions>): BeaconOptions {
	return {
		agentName: "test-builder",
		capability: "builder",
		taskId: "overstory-abc",
		parentAgent: null,
		depth: 0,
		...overrides,
	};
}

describe("buildBeacon", () => {
	test("is a single line (no newlines)", () => {
		const beacon = buildBeacon(makeBeaconOpts());

		expect(beacon).not.toContain("\n");
	});

	test("includes agent identity and task ID in header", () => {
		const beacon = buildBeacon(makeBeaconOpts());

		expect(beacon).toContain("[OVERSTORY] test-builder (builder) ");
		expect(beacon).toContain("task:overstory-abc");
	});

	test("includes ISO timestamp", () => {
		const beacon = buildBeacon(makeBeaconOpts());

		expect(beacon).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
	});

	test("includes depth and parent info", () => {
		const beacon = buildBeacon(makeBeaconOpts({ depth: 1, parentAgent: "lead-alpha" }));

		expect(beacon).toContain("Depth: 1 | Parent: lead-alpha");
	});

	test("shows 'none' for parent when no parent agent", () => {
		const beacon = buildBeacon(makeBeaconOpts({ parentAgent: null }));

		expect(beacon).toContain("Depth: 0 | Parent: none");
	});

	test("includes startup instructions with agent name and task ID", () => {
		const opts = makeBeaconOpts({ agentName: "scout-1", taskId: "overstory-xyz" });
		const beacon = buildBeacon(opts);

		expect(beacon).toContain("read .claude/CLAUDE.md");
		expect(beacon).toContain("overstory init");
		expect(beacon).toContain("overstory mail check --agent scout-1");
		expect(beacon).toContain("begin task overstory-xyz");
	});

	test("uses agent name in mail check command", () => {
		const beacon = buildBeacon(makeBeaconOpts({ agentName: "reviewer-beta" }));

		expect(beacon).toContain("overstory mail check --agent reviewer-beta");
	});

	test("reflects capability in header", () => {
		const beacon = buildBeacon(makeBeaconOpts({ capability: "scout" }));

		expect(beacon).toContain("(scout)");
	});

	test("works with hierarchy depth > 0 and parent", () => {
		const beacon = buildBeacon(
			makeBeaconOpts({
				agentName: "worker-3",
				capability: "builder",
				taskId: "overstory-deep",
				parentAgent: "lead-main",
				depth: 2,
			}),
		);

		expect(beacon).toContain("[OVERSTORY] worker-3 (builder)");
		expect(beacon).toContain("task:overstory-deep");
		expect(beacon).toContain("Depth: 2 | Parent: lead-main");
	});
});

describe("isRunningAsRoot", () => {
	test("returns true when getuid returns 0", () => {
		expect(isRunningAsRoot(() => 0)).toBe(true);
	});

	test("returns false when getuid returns non-zero UID", () => {
		expect(isRunningAsRoot(() => 1000)).toBe(false);
	});

	test("returns false when getuid is undefined (platform without getuid)", () => {
		expect(isRunningAsRoot(undefined)).toBe(false);
	});
});

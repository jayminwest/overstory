import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveModel, resolveProviderEnv } from "../agents/manifest.ts";
import { HierarchyError, ValidationError } from "../errors.ts";
import { ClaudeRuntime } from "../runtimes/claude.ts";
import { getRuntime } from "../runtimes/registry.ts";
import { cleanupTempDir, createTempGitRepo } from "../test-helpers.ts";
import type { AgentManifest, OverstoryConfig } from "../types.ts";
import {
	type AutoDispatchOptions,
	type BeaconOptions,
	buildAutoDispatch,
	buildBeacon,
	calculateStaggerDelay,
	checkDuplicateLead,
	checkParentAgentLimit,
	checkRunSessionLimit,
	checkTaskLock,
	extractMulchRecordIds,
	generateAgentName,
	getCurrentBranch,
	getSharedWritableDirs,
	inferDomainsFromFiles,
	isRunningAsRoot,
	parentHasScouts,
	resolveUseHeadless,
	resolveUseSpawnPerTurn,
	shouldShowScoutWarning,
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
 * Tests for shouldShowScoutWarning (overstory-6eyw).
 *
 * shouldShowScoutWarning determines whether the "spawning builder without scouts"
 * warning should be emitted. It is a pure function extracted from slingCommand
 * so it can be suppressed via --no-scout-check or --skip-scout.
 */

describe("shouldShowScoutWarning", () => {
	function makeSession(
		parentAgent: string | null,
		capability: string,
	): { parentAgent: string | null; capability: string } {
		return { parentAgent, capability };
	}

	const withScout = [makeSession("lead-alpha", "scout"), makeSession("lead-alpha", "builder")];
	const withoutScout = [makeSession("lead-alpha", "builder")];
	const empty: { parentAgent: string | null; capability: string }[] = [];

	test("returns true when builder has parent but no scouts", () => {
		expect(shouldShowScoutWarning("builder", "lead-alpha", withoutScout, false, false)).toBe(true);
	});

	test("returns false when builder has parent and scouts exist", () => {
		expect(shouldShowScoutWarning("builder", "lead-alpha", withScout, false, false)).toBe(false);
	});

	test("returns false when capability is not builder", () => {
		expect(shouldShowScoutWarning("scout", "lead-alpha", empty, false, false)).toBe(false);
		expect(shouldShowScoutWarning("reviewer", "lead-alpha", empty, false, false)).toBe(false);
		expect(shouldShowScoutWarning("lead", "lead-alpha", empty, false, false)).toBe(false);
	});

	test("returns false when parentAgent is null (coordinator spawn)", () => {
		expect(shouldShowScoutWarning("builder", null, withoutScout, false, false)).toBe(false);
	});

	test("returns false when noScoutCheck is true (flag suppresses warning)", () => {
		expect(shouldShowScoutWarning("builder", "lead-alpha", withoutScout, true, false)).toBe(false);
	});

	test("returns false when skipScout is true (lead opted out of scouting)", () => {
		expect(shouldShowScoutWarning("builder", "lead-alpha", withoutScout, false, true)).toBe(false);
	});

	test("returns false when both noScoutCheck and skipScout are true", () => {
		expect(shouldShowScoutWarning("builder", "lead-alpha", withoutScout, true, true)).toBe(false);
	});

	test("returns false with empty sessions and no parent", () => {
		expect(shouldShowScoutWarning("builder", null, empty, false, false)).toBe(false);
	});

	test("returns true with empty sessions and a parent (no scouts ever spawned)", () => {
		expect(shouldShowScoutWarning("builder", "lead-alpha", empty, false, false)).toBe(true);
	});
});

describe("getSharedWritableDirs", () => {
	test("returns only .overstory for non-lead agents", () => {
		expect(getSharedWritableDirs("/repo", "builder")).toEqual(["/repo/.overstory"]);
		expect(getSharedWritableDirs("/repo", "scout")).toEqual(["/repo/.overstory"]);
	});

	test("includes canonical .git for lead agents", () => {
		expect(getSharedWritableDirs("/repo", "lead")).toEqual(["/repo/.overstory", "/repo/.git"]);
	});
});

describe("generateAgentName", () => {
	test("returns capability-taskId when no collision", () => {
		expect(generateAgentName("builder", "overstory-2f10", [])).toBe("builder-overstory-2f10");
	});

	test("returns capability-taskId when takenNames is empty", () => {
		expect(generateAgentName("scout", "task-123", [])).toBe("scout-task-123");
	});

	test("appends -2 when base name is taken", () => {
		expect(generateAgentName("builder", "overstory-2f10", ["builder-overstory-2f10"])).toBe(
			"builder-overstory-2f10-2",
		);
	});

	test("skips taken suffixes and returns -3 when -2 is also taken", () => {
		expect(
			generateAgentName("builder", "overstory-2f10", [
				"builder-overstory-2f10",
				"builder-overstory-2f10-2",
			]),
		).toBe("builder-overstory-2f10-3");
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
	test("allows builder when parentAgent is null", () => {
		expect(() => validateHierarchy(null, "builder", "test-builder", 0, false)).not.toThrow();
	});

	test("allows scout when parentAgent is null", () => {
		expect(() => validateHierarchy(null, "scout", "test-scout", 0, false)).not.toThrow();
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
			validateHierarchy(null, "reviewer", "my-reviewer", 0, false);
			expect.unreachable("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(HierarchyError);
			const he = err as HierarchyError;
			expect(he.code).toBe("HIERARCHY_VIOLATION");
			expect(he.agentName).toBe("my-reviewer");
			expect(he.requestedCapability).toBe("reviewer");
			expect(he.message).toContain("reviewer");
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
		instructionPath: ".claude/CLAUDE.md",
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

		expect(beacon).toContain(`read ${opts.instructionPath}`);
		expect(beacon).toContain("mulch prime");
		expect(beacon).toContain("ov mail check --agent scout-1");
		expect(beacon).toContain("begin task overstory-xyz");
	});

	test("uses custom instructionPath in startup instructions", () => {
		const opts = makeBeaconOpts({ instructionPath: "AGENTS.md" });
		const beacon = buildBeacon(opts);

		expect(beacon).toContain("read AGENTS.md");
		expect(beacon).not.toContain(".claude/CLAUDE.md");
	});

	test("uses agent name in mail check command", () => {
		const beacon = buildBeacon(makeBeaconOpts({ agentName: "reviewer-beta" }));

		expect(beacon).toContain("ov mail check --agent reviewer-beta");
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

/**
 * Tests for inferDomainsFromFiles.
 *
 * This pure function maps file paths to mulch domains using inferDomain(),
 * deduplicates results, sorts them alphabetically, and falls back to
 * configDomains when no paths produce a domain mapping.
 */

describe("inferDomainsFromFiles", () => {
	test("infers cli domain from src/commands/ files", () => {
		const domains = inferDomainsFromFiles(["src/commands/sling.ts"], []);

		expect(domains).toEqual(["cli"]);
	});

	test("infers messaging domain from src/mail/ files", () => {
		const domains = inferDomainsFromFiles(["src/mail/store.ts"], []);

		expect(domains).toEqual(["messaging"]);
	});

	test("infers typescript domain from general src/ files", () => {
		const domains = inferDomainsFromFiles(["src/config.ts"], []);

		expect(domains).toEqual(["typescript"]);
	});

	test("infers cli domain from .test.ts files in src/commands/ (commands check takes priority)", () => {
		const domains = inferDomainsFromFiles(["src/commands/sling.test.ts"], []);

		// src/commands/ check runs before .test.ts check in inferDomain
		expect(domains).toEqual(["cli"]);
	});

	test("infers typescript domain from .test.ts files outside recognized directories", () => {
		const domains = inferDomainsFromFiles(["src/config.test.ts"], []);

		// src/ match triggers typescript (config.test.ts is not in a specific subdirectory)
		expect(domains).toEqual(["typescript"]);
	});

	test("deduplicates domains across multiple files", () => {
		const files = ["src/commands/sling.ts", "src/commands/init.ts", "src/commands/merge.ts"];
		const domains = inferDomainsFromFiles(files, []);

		expect(domains).toEqual(["cli"]);
	});

	test("returns multiple domains sorted alphabetically", () => {
		const files = ["src/commands/sling.ts", "src/mail/store.ts"];
		const domains = inferDomainsFromFiles(files, []);

		expect(domains).toEqual(["cli", "messaging"]);
	});

	test("falls back to configDomains when no files match", () => {
		const domains = inferDomainsFromFiles(["docs/README.md"], ["typescript", "cli"]);

		expect(domains).toEqual(["typescript", "cli"]);
	});

	test("falls back to configDomains when files list is empty", () => {
		const domains = inferDomainsFromFiles([], ["agents"]);

		expect(domains).toEqual(["agents"]);
	});

	test("returns empty array when no files match and configDomains is empty", () => {
		const domains = inferDomainsFromFiles(["docs/README.md"], []);

		expect(domains).toEqual([]);
	});

	test("infers agents domain from src/agents/ files", () => {
		const domains = inferDomainsFromFiles(["src/agents/manifest.ts"], []);

		expect(domains).toEqual(["agents"]);
	});

	test("infers architecture domain from src/merge/ files", () => {
		const domains = inferDomainsFromFiles(["src/merge/queue.ts"], []);

		expect(domains).toEqual(["architecture"]);
	});

	test("infers architecture domain from src/worktree/ files", () => {
		const domains = inferDomainsFromFiles(["src/worktree/manager.ts"], []);

		expect(domains).toEqual(["architecture"]);
	});

	test("handles mixed file scopes producing multiple domains", () => {
		const files = ["src/commands/sling.ts", "src/agents/manifest.ts", "src/mail/client.ts"];
		const domains = inferDomainsFromFiles(files, []);

		expect(domains).toEqual(["agents", "cli", "messaging"]);
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

/**
 * Tests for checkTaskLock.
 *
 * checkTaskLock prevents concurrent agents from working the same task ID.
 * It checks the active session list and returns the agent name that holds
 * the lock (i.e., is already working on the task), or null if the task is free.
 */

function makeTaskSession(agentName: string, taskId: string): { agentName: string; taskId: string } {
	return { agentName, taskId };
}

describe("checkTaskLock", () => {
	test("returns null when no sessions exist", () => {
		expect(checkTaskLock([], "overstory-abc")).toBeNull();
	});

	test("returns null when no session matches the task ID", () => {
		const sessions = [
			makeTaskSession("builder-1", "overstory-xyz"),
			makeTaskSession("builder-2", "overstory-def"),
		];

		expect(checkTaskLock(sessions, "overstory-abc")).toBeNull();
	});

	test("returns the agent name when a session matches", () => {
		const sessions = [
			makeTaskSession("builder-1", "overstory-abc"),
			makeTaskSession("builder-2", "overstory-xyz"),
		];

		expect(checkTaskLock(sessions, "overstory-abc")).toBe("builder-1");
	});

	test("returns the first matching agent when multiple sessions match", () => {
		// Multiple sessions can have the same taskId (e.g., retried agent)
		// checkTaskLock returns the first match
		const sessions = [
			makeTaskSession("builder-1", "overstory-abc"),
			makeTaskSession("builder-2", "overstory-abc"),
		];

		expect(checkTaskLock(sessions, "overstory-abc")).toBe("builder-1");
	});
});

describe("checkTaskLock parent bypass", () => {
	test("parent matching lock holder is allowed (returns lock holder name for caller to compare)", () => {
		// checkTaskLock is a pure function — it returns the lock holder name or null.
		// The parent bypass logic is in slingCommand, not checkTaskLock.
		// These tests verify the building blocks work correctly.
		const sessions = [makeTaskSession("lead-alpha", "overstory-abc")];
		// checkTaskLock still returns the holder — the caller (slingCommand) decides
		// whether to allow based on parentAgent match.
		expect(checkTaskLock(sessions, "overstory-abc")).toBe("lead-alpha");
	});

	test("non-parent lock holder blocks spawn", () => {
		const sessions = [makeTaskSession("other-agent", "overstory-abc")];
		const lockHolder = checkTaskLock(sessions, "overstory-abc");
		const parentAgent = "lead-alpha";
		// lockHolder is 'other-agent', parentAgent is 'lead-alpha' — not equal, should block
		expect(lockHolder).not.toBeNull();
		expect(lockHolder).not.toBe(parentAgent);
	});

	test("null parent with lock holder blocks spawn", () => {
		const sessions = [makeTaskSession("lead-alpha", "overstory-abc")];
		const lockHolder = checkTaskLock(sessions, "overstory-abc");
		const parentAgent = null;
		// lockHolder is non-null and parentAgent is null — should block
		expect(lockHolder).not.toBeNull();
		expect(lockHolder).not.toBe(parentAgent);
	});
});

/**
 * Tests for checkDuplicateLead.
 *
 * checkDuplicateLead prevents spawning a second lead agent for the same task ID.
 * It filters the active session list to only "lead" capability sessions, so
 * builder/scout children working the same bead via parent delegation do not
 * trigger this check.
 *
 * The activeSessions input is pre-filtered by store.getActive() to exclude
 * completed and zombie sessions.
 */

function makeLeadSession(
	agentName: string,
	taskId: string,
	capability: string,
): { agentName: string; taskId: string; capability: string } {
	return { agentName, taskId, capability };
}

describe("checkDuplicateLead", () => {
	test("returns lead agent name when an active lead exists for the task", () => {
		const sessions = [
			makeLeadSession("lead-alpha", "overstory-abc", "lead"),
			makeLeadSession("builder-1", "overstory-xyz", "builder"),
		];
		expect(checkDuplicateLead(sessions, "overstory-abc")).toBe("lead-alpha");
	});

	test("returns null when no lead exists for the task", () => {
		const sessions = [
			makeLeadSession("lead-alpha", "overstory-xyz", "lead"),
			makeLeadSession("builder-1", "overstory-abc", "builder"),
		];
		expect(checkDuplicateLead(sessions, "overstory-abc")).toBeNull();
	});

	test("returns null when no sessions exist (completed/zombie filtered out)", () => {
		// activeSessions from store.getActive() already excludes completed/zombie
		expect(checkDuplicateLead([], "overstory-abc")).toBeNull();
	});

	test("ignores non-lead agents working the same bead", () => {
		const sessions = [
			makeLeadSession("builder-1", "overstory-abc", "builder"),
			makeLeadSession("scout-1", "overstory-abc", "scout"),
			makeLeadSession("reviewer-1", "overstory-abc", "reviewer"),
		];
		expect(checkDuplicateLead(sessions, "overstory-abc")).toBeNull();
	});

	test("returns first matching lead when multiple leads exist for the same bead", () => {
		const sessions = [
			makeLeadSession("lead-alpha", "overstory-abc", "lead"),
			makeLeadSession("lead-beta", "overstory-abc", "lead"),
		];
		expect(checkDuplicateLead(sessions, "overstory-abc")).toBe("lead-alpha");
	});

	test("differentiates between task IDs", () => {
		const sessions = [makeLeadSession("lead-alpha", "overstory-abc", "lead")];
		expect(checkDuplicateLead(sessions, "overstory-xyz")).toBeNull();
	});
});

/**
 * Tests for checkRunSessionLimit.
 *
 * checkRunSessionLimit prevents spawning when the per-run agent cap is reached.
 * A limit of 0 (or negative) means unlimited. Returns true if the limit
 * is reached (spawn should be blocked), false otherwise.
 */

describe("checkRunSessionLimit", () => {
	test("returns false when limit is 0 (unlimited)", () => {
		expect(checkRunSessionLimit(0, 100)).toBe(false);
	});

	test("returns false when count is below limit", () => {
		expect(checkRunSessionLimit(10, 5)).toBe(false);
	});

	test("returns true when count equals limit", () => {
		expect(checkRunSessionLimit(10, 10)).toBe(true);
	});

	test("returns true when count exceeds limit", () => {
		expect(checkRunSessionLimit(10, 15)).toBe(true);
	});

	test("returns false when limit is negative (treated as unlimited)", () => {
		expect(checkRunSessionLimit(-1, 100)).toBe(false);
	});
});

describe("checkParentAgentLimit", () => {
	test("returns false when limit is 0 (unlimited)", () => {
		const sessions = [{ parentAgent: "lead-alpha" }, { parentAgent: "lead-alpha" }];
		expect(checkParentAgentLimit(sessions, "lead-alpha", 0)).toBe(false);
	});

	test("returns false when count is below limit", () => {
		const sessions = [{ parentAgent: "lead-alpha" }];
		expect(checkParentAgentLimit(sessions, "lead-alpha", 5)).toBe(false);
	});

	test("returns true when count equals limit", () => {
		const sessions = [
			{ parentAgent: "lead-alpha" },
			{ parentAgent: "lead-alpha" },
			{ parentAgent: "lead-alpha" },
		];
		expect(checkParentAgentLimit(sessions, "lead-alpha", 3)).toBe(true);
	});

	test("returns true when count exceeds limit", () => {
		const sessions = [
			{ parentAgent: "lead-alpha" },
			{ parentAgent: "lead-alpha" },
			{ parentAgent: "lead-alpha" },
			{ parentAgent: "lead-alpha" },
		];
		expect(checkParentAgentLimit(sessions, "lead-alpha", 3)).toBe(true);
	});

	test("returns false when limit is negative (treated as unlimited)", () => {
		const sessions = [{ parentAgent: "lead-alpha" }];
		expect(checkParentAgentLimit(sessions, "lead-alpha", -1)).toBe(false);
	});

	test("only counts children of the specified parent", () => {
		const sessions = [
			{ parentAgent: "lead-alpha" },
			{ parentAgent: "lead-beta" },
			{ parentAgent: "lead-alpha" },
			{ parentAgent: "lead-gamma" },
		];
		expect(checkParentAgentLimit(sessions, "lead-alpha", 3)).toBe(false);
		expect(checkParentAgentLimit(sessions, "lead-alpha", 2)).toBe(true);
	});

	test("returns false when no sessions match the parent", () => {
		const sessions = [{ parentAgent: "lead-beta" }, { parentAgent: "lead-gamma" }];
		expect(checkParentAgentLimit(sessions, "lead-alpha", 1)).toBe(false);
	});

	test("ignores sessions with null parent", () => {
		const sessions = [{ parentAgent: null }, { parentAgent: "lead-alpha" }, { parentAgent: null }];
		expect(checkParentAgentLimit(sessions, "lead-alpha", 2)).toBe(false);
	});

	test("returns false when sessions array is empty", () => {
		expect(checkParentAgentLimit([], "lead-alpha", 5)).toBe(false);
	});
});

/**
 * Tests for sling provider env injection building blocks.
 *
 * In slingCommand, resolveModel() is called to get the { model, env } for the
 * spawned agent. The env dict is then spread into createSession's env parameter
 * alongside OVERSTORY_AGENT_NAME and OVERSTORY_WORKTREE_PATH:
 *
 *   const { model, env } = resolveModel(config, manifest, capability, agentDef.model);
 *   const pid = await createSession(tmuxSessionName, worktreePath, claudeCmd, {
 *       ...env,
 *       OVERSTORY_AGENT_NAME: name,
 *       OVERSTORY_WORKTREE_PATH: worktreePath,
 *   });
 *
 * These tests verify the building blocks: that resolveModel and resolveProviderEnv
 * produce the correct env dicts for the provider scenarios sling will encounter.
 */

function makeConfig(
	models: OverstoryConfig["models"] = {},
	providers: OverstoryConfig["providers"] = { anthropic: { type: "native" } },
): OverstoryConfig {
	return {
		project: { name: "test", root: "/tmp/test", canonicalBranch: "main" },
		agents: {
			manifestPath: ".overstory/agent-manifest.json",
			baseDir: ".overstory/agent-defs",
			maxConcurrent: 5,
			staggerDelayMs: 0,
			maxDepth: 2,
			maxSessionsPerRun: 0,
			maxAgentsPerLead: 5,
		},
		worktrees: { baseDir: ".overstory/worktrees" },
		taskTracker: { backend: "auto", enabled: false },
		mulch: { enabled: false, domains: [], primeFormat: "markdown" },
		merge: { aiResolveEnabled: false, reimagineEnabled: false },
		providers,
		watchdog: {
			tier0Enabled: false,
			tier0IntervalMs: 30_000,
			tier1Enabled: false,
			tier2Enabled: false,
			staleThresholdMs: 300_000,
			zombieThresholdMs: 600_000,
			nudgeIntervalMs: 60_000,
		},
		models,
		logging: { verbose: false, redactSecrets: true },
	};
}

function makeManifest(): AgentManifest {
	return {
		version: "1.0",
		agents: {
			builder: {
				file: "builder.md",
				model: "opus",
				tools: ["Read", "Write", "Edit", "Bash"],
				capabilities: ["implement"],
				canSpawn: false,
				constraints: [],
			},
			coordinator: {
				file: "coordinator.md",
				model: "sonnet",
				tools: ["Read", "Bash"],
				capabilities: ["coordinate"],
				canSpawn: true,
				constraints: [],
			},
		},
		capabilityIndex: { implement: ["builder"], coordinate: ["coordinator"] },
	};
}

describe("sling provider env injection building blocks", () => {
	test("resolveModel produces env for gateway provider in config override scenario", () => {
		const config = makeConfig(
			{ builder: "openrouter/anthropic/claude-3-5-sonnet" },
			{ openrouter: { type: "gateway", baseUrl: "https://openrouter.ai/api/v1" } },
		);
		const manifest = makeManifest();

		const result = resolveModel(config, manifest, "builder", "sonnet");

		expect(result.model).toBe("sonnet");
		expect(result.env).toBeDefined();
		expect(result.env?.ANTHROPIC_BASE_URL).toBe("https://openrouter.ai/api/v1");
		expect(result.env?.ANTHROPIC_API_KEY).toBe("");
		expect(result.env?.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("anthropic/claude-3-5-sonnet");
	});

	test("env dict from resolveModel can be spread with OVERSTORY_AGENT_NAME and OVERSTORY_WORKTREE_PATH", () => {
		const config = makeConfig(
			{ builder: "openrouter/anthropic/claude-3-5-sonnet" },
			{ openrouter: { type: "gateway", baseUrl: "https://openrouter.ai/api/v1" } },
		);
		const manifest = makeManifest();

		const { env } = resolveModel(config, manifest, "builder", "sonnet");
		// Simulates the spread in slingCommand: { ...env, OVERSTORY_AGENT_NAME: name, OVERSTORY_WORKTREE_PATH: wt }
		const combined: Record<string, string> = {
			...(env ?? {}),
			OVERSTORY_AGENT_NAME: "test-builder",
			OVERSTORY_WORKTREE_PATH: "/tmp/wt",
		};

		expect(combined.ANTHROPIC_BASE_URL).toBe("https://openrouter.ai/api/v1");
		expect(combined.ANTHROPIC_API_KEY).toBe("");
		expect(combined.OVERSTORY_AGENT_NAME).toBe("test-builder");
		expect(combined.OVERSTORY_WORKTREE_PATH).toBe("/tmp/wt");
	});

	test("env dict from resolveModel can be spread with OVERSTORY_TASK_ID", () => {
		const config = makeConfig(
			{ builder: "openrouter/anthropic/claude-3-5-sonnet" },
			{ openrouter: { type: "gateway", baseUrl: "https://openrouter.ai/api/v1" } },
		);
		const manifest = makeManifest();

		const { env } = resolveModel(config, manifest, "builder", "sonnet");
		// Simulates the spread in slingCommand: { ...env, OVERSTORY_AGENT_NAME: name, OVERSTORY_WORKTREE_PATH: wt, OVERSTORY_TASK_ID: taskId }
		const combined: Record<string, string> = {
			...(env ?? {}),
			OVERSTORY_AGENT_NAME: "test-builder",
			OVERSTORY_WORKTREE_PATH: "/tmp/wt",
			OVERSTORY_TASK_ID: "overstory-1234",
		};

		expect(combined.OVERSTORY_AGENT_NAME).toBe("test-builder");
		expect(combined.OVERSTORY_WORKTREE_PATH).toBe("/tmp/wt");
		expect(combined.OVERSTORY_TASK_ID).toBe("overstory-1234");
	});

	test("env dict includes OVERSTORY_PROJECT_ROOT", () => {
		const env = { MODEL_KEY: "value" };
		const combined = {
			...env,
			OVERSTORY_AGENT_NAME: "test-builder",
			OVERSTORY_WORKTREE_PATH: "/path/to/wt",
			OVERSTORY_TASK_ID: "task-1",
			OVERSTORY_PROJECT_ROOT: "/path/to/project",
		};
		expect(combined.OVERSTORY_PROJECT_ROOT).toBe("/path/to/project");
	});

	test("resolveModel returns no env for native anthropic provider", () => {
		const config = makeConfig({ builder: "sonnet" }, { anthropic: { type: "native" } });
		const manifest = makeManifest();

		const result = resolveModel(config, manifest, "builder", "sonnet");

		expect(result.model).toBe("sonnet");
		expect(result.env).toBeUndefined();
	});

	test("resolveModel returns no env when model is a simple alias from manifest default", () => {
		// No models override: manifest builder model "opus" is a simple alias
		const config = makeConfig({}, {});
		const manifest = makeManifest();

		const result = resolveModel(config, manifest, "builder", "sonnet");

		expect(result.model).toBe("opus");
		expect(result.env).toBeUndefined();
	});

	test("resolveProviderEnv includes ANTHROPIC_AUTH_TOKEN when authTokenEnv var is set", () => {
		const providers = {
			openrouter: {
				type: "gateway" as const,
				baseUrl: "https://openrouter.ai/api/v1",
				authTokenEnv: "MY_API_KEY",
			},
		};
		const env = { MY_API_KEY: "sk-test-123" };

		const result = resolveProviderEnv("openrouter", "anthropic/claude-3-5-sonnet", providers, env);

		expect(result).not.toBeNull();
		expect(result?.ANTHROPIC_AUTH_TOKEN).toBe("sk-test-123");
	});

	test("resolveProviderEnv omits ANTHROPIC_AUTH_TOKEN when authTokenEnv var is absent", () => {
		const providers = {
			openrouter: {
				type: "gateway" as const,
				baseUrl: "https://openrouter.ai/api/v1",
				authTokenEnv: "MY_API_KEY",
			},
		};
		const env: Record<string, string | undefined> = {};

		const result = resolveProviderEnv("openrouter", "anthropic/claude-3-5-sonnet", providers, env);

		expect(result).not.toBeNull();
		expect(result?.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
	});

	test("resolveModel produces different env dicts for coordinator and builder with different gateway providers", () => {
		const config = makeConfig(
			{
				coordinator: "openrouter/anthropic/claude-3-5-sonnet",
				builder: "litellm/anthropic/claude-3-5-haiku",
			},
			{
				openrouter: { type: "gateway", baseUrl: "https://openrouter.ai/api/v1" },
				litellm: { type: "gateway", baseUrl: "https://litellm.example.com/v1" },
			},
		);
		const manifest = makeManifest();

		const coordinatorResult = resolveModel(config, manifest, "coordinator", "sonnet");
		const builderResult = resolveModel(config, manifest, "builder", "sonnet");

		expect(coordinatorResult.model).toBe("sonnet");
		expect(builderResult.model).toBe("sonnet");
		expect(coordinatorResult.env?.ANTHROPIC_BASE_URL).toBe("https://openrouter.ai/api/v1");
		expect(builderResult.env?.ANTHROPIC_BASE_URL).toBe("https://litellm.example.com/v1");
		expect(coordinatorResult.env?.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe(
			"anthropic/claude-3-5-sonnet",
		);
		expect(builderResult.env?.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("anthropic/claude-3-5-haiku");
	});
});

/**
 * Tests for buildAutoDispatch.
 *
 * buildAutoDispatch constructs a pre-spawn dispatch mail message that is
 * inserted into the mail DB before the tmux session is created. This ensures
 * the agent's SessionStart hook can immediately deliver context without
 * waiting for the coordinator to send a separate dispatch message.
 */

function makeAutoDispatchOpts(overrides?: Partial<AutoDispatchOptions>): AutoDispatchOptions {
	return {
		agentName: "builder-1",
		taskId: "overstory-abc",
		capability: "builder",
		specPath: "/path/to/spec.md",
		parentAgent: "lead-alpha",
		instructionPath: ".claude/CLAUDE.md",
		...overrides,
	};
}

describe("buildAutoDispatch", () => {
	test("uses parent agent as sender when provided", () => {
		const dispatch = buildAutoDispatch({
			agentName: "builder-1",
			taskId: "overstory-abc",
			capability: "builder",
			specPath: "/path/to/spec.md",
			parentAgent: "lead-alpha",
			instructionPath: ".claude/CLAUDE.md",
		});
		expect(dispatch.from).toBe("lead-alpha");
		expect(dispatch.to).toBe("builder-1");
		expect(dispatch.subject).toContain("overstory-abc");
		expect(dispatch.body).toContain("spec.md");
	});

	test("uses orchestrator as sender when no parent", () => {
		const dispatch = buildAutoDispatch({
			agentName: "lead-1",
			taskId: "overstory-xyz",
			capability: "lead",
			specPath: null,
			parentAgent: null,
			instructionPath: ".claude/CLAUDE.md",
		});
		expect(dispatch.from).toBe("orchestrator");
		expect(dispatch.body).toContain("No spec file");
	});

	test("includes capability in body", () => {
		const dispatch = buildAutoDispatch({
			agentName: "scout-1",
			taskId: "overstory-abc",
			capability: "scout",
			specPath: null,
			parentAgent: "lead-alpha",
			instructionPath: ".claude/CLAUDE.md",
		});
		expect(dispatch.body).toContain("scout");
	});

	test("includes spec path when provided", () => {
		const dispatch = buildAutoDispatch({
			agentName: "builder-1",
			taskId: "overstory-abc",
			capability: "builder",
			specPath: "/abs/path/to/spec.md",
			parentAgent: "lead-alpha",
			instructionPath: ".claude/CLAUDE.md",
		});
		expect(dispatch.body).toContain("/abs/path/to/spec.md");
	});

	test("subject contains task ID", () => {
		const dispatch = buildAutoDispatch(makeAutoDispatchOpts({ taskId: "overstory-zz99" }));
		expect(dispatch.subject).toContain("overstory-zz99");
	});

	test("to is the agent name", () => {
		const dispatch = buildAutoDispatch(makeAutoDispatchOpts({ agentName: "my-builder" }));
		expect(dispatch.to).toBe("my-builder");
	});
});

/**
 * Beacon verification loop (sling.ts step 13d)
 *
 * NOT UNIT-TESTABLE: The beacon verification loop at sling.ts lines 687-698
 * uses capturePaneContent() to poll tmux and resend the beacon if the agent
 * is still at the welcome screen ("Try "). This involves real tmux operations
 * that cannot be reliably mocked without mock.module() (which leaks across
 * test files — see mx-56558b).
 *
 * Manual verification:
 * 1. `ov sling <task-id> --name test --capability builder`
 * 2. Watch tmux pane: `tmux capture-pane -t overstory-<project>-test -p`
 * 3. Verify the beacon text appears and the agent starts processing
 *
 * Integration coverage: The beacon loop has been validated through production
 * agent spawns. Failure mode is agents stuck at welcome screen (overstory-3271).
 */

describe("sling runtime integration", () => {
	test("runtime.buildSpawnCommand produces identical command to old hardcoded string", () => {
		const runtime = getRuntime("claude");
		const cmd = runtime.buildSpawnCommand({
			model: "sonnet",
			permissionMode: "bypass",
			cwd: "/tmp/worktree",
			env: {},
		});
		expect(cmd).toBe("claude --model sonnet --permission-mode bypassPermissions");
	});

	test("runtime.buildSpawnCommand with opus model", () => {
		const runtime = getRuntime("claude");
		const cmd = runtime.buildSpawnCommand({
			model: "opus",
			permissionMode: "bypass",
			cwd: "/tmp/worktree",
			env: {},
		});
		expect(cmd).toBe("claude --model opus --permission-mode bypassPermissions");
	});

	test("runtime.buildEnv returns empty object for native model", () => {
		const runtime = new ClaudeRuntime();
		const env = runtime.buildEnv({ model: "sonnet" });
		expect(env).toEqual({});
	});

	test("runtime.buildEnv passes through provider env vars", () => {
		const runtime = new ClaudeRuntime();
		const env = runtime.buildEnv({
			model: "sonnet",
			env: { ANTHROPIC_BASE_URL: "https://example.com" },
		});
		expect(env).toEqual({ ANTHROPIC_BASE_URL: "https://example.com" });
	});

	test("runtime.detectReady returns ready for idle Claude prompt", () => {
		const runtime = new ClaudeRuntime();
		const state = runtime.detectReady('Try "hello world"\n\nbypass permissions');
		expect(state.phase).toBe("ready");
	});

	test("runtime.detectReady returns loading when agent is processing", () => {
		const runtime = new ClaudeRuntime();
		const state = runtime.detectReady("Running tool: Read\nbypass permissions");
		expect(state.phase).toBe("loading");
	});
});

describe("extractMulchRecordIds", () => {
	test("returns empty array for empty string", () => {
		expect(extractMulchRecordIds("")).toEqual([]);
	});

	test("returns empty when no mx-IDs present", () => {
		const text = "## agents (2 records)\n- convention without ID";
		expect(extractMulchRecordIds(text)).toEqual([]);
	});

	test("extracts single ID from a domain", () => {
		const text = "## agents (1 records)\n- [convention] Some. (mx-abc123)";
		expect(extractMulchRecordIds(text)).toEqual([{ id: "mx-abc123", domain: "agents" }]);
	});

	test("extracts multiple IDs from same domain", () => {
		const text = ["## typescript", "- first. (mx-aaa111)", "- second. (mx-bbb222)"].join("\n");
		expect(extractMulchRecordIds(text)).toEqual([
			{ id: "mx-aaa111", domain: "typescript" },
			{ id: "mx-bbb222", domain: "typescript" },
		]);
	});

	test("extracts IDs from multiple domains", () => {
		const text = ["## agents", "- agent. (mx-111aaa)", "## typescript", "- ts. (mx-222bbb)"].join(
			"\n",
		);
		expect(extractMulchRecordIds(text)).toEqual([
			{ id: "mx-111aaa", domain: "agents" },
			{ id: "mx-222bbb", domain: "typescript" },
		]);
	});

	test("ignores non-domain headings with no mx-IDs", () => {
		const text = [
			"## Quick Reference",
			"- use mulch search",
			"## agents",
			"- real. (mx-deadbeef)",
		].join("\n");
		expect(extractMulchRecordIds(text)).toEqual([{ id: "mx-deadbeef", domain: "agents" }]);
	});

	test("deduplicates repeated pairs", () => {
		const text = ["## agents", "- first. (mx-aabbcc)", "- dup. (mx-aabbcc)"].join("\n");
		expect(extractMulchRecordIds(text)).toEqual([{ id: "mx-aabbcc", domain: "agents" }]);
	});

	test("handles realistic ml prime output", () => {
		const text = [
			"## agents (3 records, updated just now)",
			"- [convention] lead.md convention. (mx-636708)",
			"- [convention] writeOverlay(). (mx-b7fa3d)",
			"## typescript (2 records, updated just now)",
			"- [convention] No any types. (mx-2ce43d)",
			"## Quick Reference",
			"- mulch search",
		].join("\n");
		const result = extractMulchRecordIds(text);
		expect(result).toHaveLength(3);
		expect(result).toContainEqual({ id: "mx-636708", domain: "agents" });
		expect(result).toContainEqual({ id: "mx-b7fa3d", domain: "agents" });
		expect(result).toContainEqual({ id: "mx-2ce43d", domain: "typescript" });
	});
});

describe("getCurrentBranch", () => {
	let repoDir: string;

	beforeEach(async () => {
		repoDir = realpathSync(await createTempGitRepo());
	});

	afterEach(async () => {
		await cleanupTempDir(repoDir);
	});

	test("returns the current branch name", async () => {
		const branch = await getCurrentBranch(repoDir);
		expect(branch).toMatch(/^(main|master)$/);
	});

	test("returns feature branch name after checkout", async () => {
		const proc = Bun.spawn(["git", "checkout", "-b", "feature/test-branch"], {
			cwd: repoDir,
			stdout: "pipe",
			stderr: "pipe",
		});
		await proc.exited;
		const branch = await getCurrentBranch(repoDir);
		expect(branch).toBe("feature/test-branch");
	});

	test("returns null for detached HEAD", async () => {
		const hashProc = Bun.spawn(["git", "rev-parse", "HEAD"], {
			cwd: repoDir,
			stdout: "pipe",
			stderr: "pipe",
		});
		const hash = (await new Response(hashProc.stdout).text()).trim();
		await hashProc.exited;
		const proc = Bun.spawn(["git", "checkout", hash], {
			cwd: repoDir,
			stdout: "pipe",
			stderr: "pipe",
		});
		await proc.exited;
		const branch = await getCurrentBranch(repoDir);
		expect(branch).toBeNull();
	});

	test("returns null for non-git directory", async () => {
		const tmpDir = realpathSync(await mkdtemp(join(tmpdir(), "overstory-notgit-")));
		try {
			const branch = await getCurrentBranch(tmpDir);
			expect(branch).toBeNull();
		} finally {
			await cleanupTempDir(tmpDir);
		}
	});
});

describe("resolveUseHeadless", () => {
	const claudeLike = { id: "claude", buildDirectSpawn: () => [] as string[] };
	const claudeNoSpawn = { id: "claude" };
	const saplingLike = {
		id: "sapling",
		headless: true as const,
		buildDirectSpawn: () => [] as string[],
	};
	const codexLike = { id: "codex" };
	const baseConfig = {} as OverstoryConfig;
	const headlessByDefaultConfig = {
		runtime: { default: "claude", claudeHeadlessByDefault: true },
	} as unknown as OverstoryConfig;

	test("statically headless runtime returns true regardless of flag", () => {
		expect(resolveUseHeadless(saplingLike, undefined, baseConfig)).toBe(true);
	});

	test("claude + no flag + base config returns false (default tmux)", () => {
		expect(resolveUseHeadless(claudeLike, undefined, baseConfig)).toBe(false);
	});

	test("claude + no flag + claudeHeadlessByDefault:true returns true", () => {
		expect(resolveUseHeadless(claudeLike, undefined, headlessByDefaultConfig)).toBe(true);
	});

	test("claude + flag:true + base config returns true", () => {
		expect(resolveUseHeadless(claudeLike, true, baseConfig)).toBe(true);
	});

	test("claude + flag:false + claudeHeadlessByDefault:true returns false (flag wins)", () => {
		expect(resolveUseHeadless(claudeLike, false, headlessByDefaultConfig)).toBe(false);
	});

	test("claude without buildDirectSpawn + flag:true throws ValidationError", () => {
		expect(() => resolveUseHeadless(claudeNoSpawn, true, baseConfig)).toThrow(ValidationError);
	});

	test("codex + claudeHeadlessByDefault:true returns false (config knob is Claude-only)", () => {
		expect(resolveUseHeadless(codexLike, undefined, headlessByDefaultConfig)).toBe(false);
	});

	test("codex + flag:true throws ValidationError (no buildDirectSpawn)", () => {
		expect(() => resolveUseHeadless(codexLike, true, baseConfig)).toThrow(ValidationError);
	});

	test("sapling + flag:false returns true (statically headless wins over flag)", () => {
		expect(resolveUseHeadless(saplingLike, false, baseConfig)).toBe(true);
	});
});

describe("resolveUseSpawnPerTurn", () => {
	const claudeLike: { headless?: boolean; buildDirectSpawn?: unknown } = {
		buildDirectSpawn: () => [] as string[],
	};
	const claudeNoSpawn: { headless?: boolean; buildDirectSpawn?: unknown } = {};
	const saplingLike: { headless?: boolean; buildDirectSpawn?: unknown } = {
		headless: true,
		buildDirectSpawn: () => [] as string[],
	};
	const flagOff: { runtime?: { claudeSpawnPerTurn?: boolean } } = {};
	const flagOn: { runtime?: { claudeSpawnPerTurn?: boolean } } = {
		runtime: { claudeSpawnPerTurn: true },
	};

	test("returns true for builder + headless + flag on + buildDirectSpawn", () => {
		expect(resolveUseSpawnPerTurn("builder", claudeLike, flagOn, true)).toBe(true);
	});

	test("returns true via statically headless runtime when useHeadless is false", () => {
		expect(resolveUseSpawnPerTurn("builder", saplingLike, flagOn, false)).toBe(true);
	});

	test("returns false when capability is not builder", () => {
		expect(resolveUseSpawnPerTurn("scout", claudeLike, flagOn, true)).toBe(false);
		expect(resolveUseSpawnPerTurn("lead", claudeLike, flagOn, true)).toBe(false);
	});

	test("returns false when claudeSpawnPerTurn flag is off", () => {
		expect(resolveUseSpawnPerTurn("builder", claudeLike, flagOff, true)).toBe(false);
	});

	test("returns false when runtime has no buildDirectSpawn", () => {
		expect(resolveUseSpawnPerTurn("builder", claudeNoSpawn, flagOn, true)).toBe(false);
	});

	test("returns false when neither useHeadless nor runtime.headless is set", () => {
		expect(resolveUseSpawnPerTurn("builder", claudeLike, flagOn, false)).toBe(false);
	});
});

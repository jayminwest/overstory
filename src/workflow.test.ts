import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
	normalizeWorkflowName,
	repoRootFromCommandDir,
	resolveProfileName,
	resolveSpecPathForWorkflow,
	resolveWorkflowProfile,
	validateWorkflowName,
} from "./workflow.ts";

describe("normalizeWorkflowName", () => {
	test("maps delivery aliases", () => {
		expect(normalizeWorkflowName("delivery")).toBe("delivery");
		expect(normalizeWorkflowName("ov-delivery")).toBe("delivery");
	});

	test("maps co-creation aliases", () => {
		expect(normalizeWorkflowName("co-creation")).toBe("co-creation");
		expect(normalizeWorkflowName("co_creation")).toBe("co-creation");
		expect(normalizeWorkflowName("cocreation")).toBe("co-creation");
		expect(normalizeWorkflowName("ov-co-creation")).toBe("co-creation");
	});

	test("returns undefined for unknown workflows", () => {
		expect(normalizeWorkflowName("discovery")).toBeUndefined();
		expect(normalizeWorkflowName(undefined)).toBeUndefined();
	});
});

describe("validateWorkflowName", () => {
	test("returns normalized workflows", () => {
		expect(validateWorkflowName("ov-delivery")).toBe("delivery");
		expect(validateWorkflowName("co_creation")).toBe("co-creation");
	});

	test("throws for unknown workflows", () => {
		expect(() => validateWorkflowName("discovery")).toThrow("Unknown workflow");
	});
});

describe("resolveWorkflowProfile", () => {
	test("resolves delivery metadata", () => {
		expect(resolveWorkflowProfile("delivery")).toEqual({
			workflow: "delivery",
			profile: "ov-delivery",
			specLayout: "overstory",
		});
	});

	test("resolves co-creation metadata", () => {
		expect(resolveWorkflowProfile("co-creation")).toEqual({
			workflow: "co-creation",
			profile: "ov-co-creation",
			specLayout: "trellis",
		});
	});
});

describe("resolveProfileName", () => {
	test("returns canonical profile names for workflow aliases", () => {
		expect(resolveProfileName("delivery")).toBe("ov-delivery");
		expect(resolveProfileName("co-creation")).toBe("ov-co-creation");
	});

	test("passes through unknown profile names", () => {
		expect(resolveProfileName("ov-discovery")).toBe("ov-discovery");
	});
});

describe("resolveSpecPathForWorkflow", () => {
	test("uses .overstory specs for delivery", () => {
		expect(resolveSpecPathForWorkflow("/repo", "task-1", "delivery")).toBe(
			join("/repo", ".overstory", "specs", "task-1.md"),
		);
	});

	test("uses Trellis specs for co-creation", () => {
		expect(resolveSpecPathForWorkflow("/repo", "task-1", "co-creation")).toBe(
			join("/repo", ".trellis", "specs", "task-1.yaml"),
		);
	});

	test("allows forcing Trellis regardless of workflow", () => {
		expect(resolveSpecPathForWorkflow("/repo", "task-1", undefined, true)).toBe(
			join("/repo", ".trellis", "specs", "task-1.yaml"),
		);
	});
});

describe("repoRootFromCommandDir", () => {
	test("resolves two levels up from src/commands", () => {
		expect(repoRootFromCommandDir("/repo/src/commands")).toBe("/repo");
	});
});

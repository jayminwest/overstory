import { describe, expect, test } from "bun:test";
import { ValidationError } from "../errors.ts";
import type { WorkflowDeps } from "./workflow.ts";
import { createWorkflowCommand, workflowStartCommand } from "./workflow.ts";

describe("workflowStartCommand", () => {
	test("passes delivery workflow through to coordinator startup", async () => {
		let captured: Parameters<NonNullable<WorkflowDeps["_startCoordinator"]>>[0] | undefined;
		const deps: WorkflowDeps = {
			_startCoordinator: async (opts) => {
				captured = opts;
			},
		};

		await workflowStartCommand("delivery", { attach: false }, deps);

		expect(captured?.workflow).toBe("delivery");
		expect(captured?.attach).toBe(false);
	});

	test("passes co-creation workflow through to coordinator startup", async () => {
		let captured: Parameters<NonNullable<WorkflowDeps["_startCoordinator"]>>[0] | undefined;
		const deps: WorkflowDeps = {
			_startCoordinator: async (opts) => {
				captured = opts;
			},
		};

		await workflowStartCommand("co-creation", { attach: false, watchdog: true }, deps);

		expect(captured?.workflow).toBe("co-creation");
		expect(captured?.watchdog).toBe(true);
	});

	test("rejects unknown workflow names", async () => {
		await expect(workflowStartCommand("discovery", { attach: false }, {})).rejects.toThrow(
			ValidationError,
		);
	});
});

describe("createWorkflowCommand", () => {
	test("creates the workflow command", () => {
		expect(createWorkflowCommand().name()).toBe("workflow");
	});
});

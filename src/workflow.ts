import { join, resolve } from "node:path";
import { ValidationError } from "./errors.ts";

export type WorkflowName = "delivery" | "co-creation";
export type WorkflowSpecLayout = "overstory" | "trellis";

export interface WorkflowProfile {
	workflow: WorkflowName;
	profile: string;
	specLayout: WorkflowSpecLayout;
}

const WORKFLOW_PROFILES: Record<WorkflowName, WorkflowProfile> = {
	delivery: {
		workflow: "delivery",
		profile: "ov-delivery",
		specLayout: "overstory",
	},
	"co-creation": {
		workflow: "co-creation",
		profile: "ov-co-creation",
		specLayout: "trellis",
	},
};

const WORKFLOW_ALIASES = new Map<string, WorkflowName>([
	["delivery", "delivery"],
	["ov-delivery", "delivery"],
	["co-creation", "co-creation"],
	["co_creation", "co-creation"],
	["cocreation", "co-creation"],
	["ov-co-creation", "co-creation"],
]);

export function normalizeWorkflowName(input: string | undefined): WorkflowName | undefined {
	if (!input) return undefined;
	return WORKFLOW_ALIASES.get(input.trim().toLowerCase());
}

export function validateWorkflowName(input: string | undefined): WorkflowName | undefined {
	if (input === undefined) return undefined;
	const normalized = normalizeWorkflowName(input);
	if (!normalized) {
		throw new ValidationError(
			`Unknown workflow '${input}'. Valid workflows: delivery, co-creation`,
			{
				field: "workflow",
				value: input,
			},
		);
	}
	return normalized;
}

export function resolveWorkflowProfile(input: string | undefined): WorkflowProfile | undefined {
	const workflow = normalizeWorkflowName(input);
	return workflow ? WORKFLOW_PROFILES[workflow] : undefined;
}

export function resolveProfileName(input: string | undefined): string | undefined {
	return resolveWorkflowProfile(input)?.profile ?? input;
}

export function resolveSpecPathForWorkflow(
	projectRoot: string,
	taskId: string,
	input: string | undefined,
	forceTrellis = false,
): string {
	const workflow = resolveWorkflowProfile(input);
	if (forceTrellis || workflow?.specLayout === "trellis") {
		return join(projectRoot, ".trellis", "specs", `${taskId}.yaml`);
	}
	return join(projectRoot, ".overstory", "specs", `${taskId}.md`);
}

export function workflowPromptPath(repoRoot: string, workflow: WorkflowName): string {
	const filename = workflow === "delivery" ? "ov-delivery.md" : "ov-co-creation.md";
	return join(repoRoot, "agents", filename);
}

export function repoRootFromCommandDir(commandDir: string): string {
	// Command modules currently live at <package-root>/src/commands/.
	// Resolve two levels up from the command directory instead of relying on dirname().
	return resolve(commandDir, "..", "..");
}

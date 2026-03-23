import { Command } from "commander";
import { validateWorkflowName } from "../workflow.ts";
import { startCoordinator } from "./coordinator.ts";

export interface WorkflowStartOptions {
	attach?: boolean;
	watchdog?: boolean;
	monitor?: boolean;
	json?: boolean;
}

export interface WorkflowDeps {
	_startCoordinator?: typeof startCoordinator;
}

export async function workflowStartCommand(
	workflow: string,
	opts: WorkflowStartOptions,
	deps: WorkflowDeps = {},
): Promise<void> {
	const normalized = validateWorkflowName(workflow);

	const attach = opts.attach !== undefined ? opts.attach : !!process.stdout.isTTY;
	const start = deps._startCoordinator ?? startCoordinator;
	await start({
		json: opts.json ?? false,
		attach,
		watchdog: opts.watchdog ?? false,
		monitor: opts.monitor ?? false,
		workflow: normalized,
	});
}

export function createWorkflowCommand(deps: WorkflowDeps = {}): Command {
	const cmd = new Command("workflow").description("Start the coordinator in a workflow mode");

	cmd
		.command("start")
		.description("Start workflow-mode coordination")
		.argument("<workflow>", "Workflow name: delivery or co-creation")
		.option("--attach", "Always attach to tmux session after start")
		.option("--no-attach", "Never attach to tmux session after start")
		.option("--watchdog", "Auto-start watchdog daemon with coordinator")
		.option("--monitor", "Auto-start the Tier 2 monitor agent alongside the coordinator")
		.option("--json", "Output as JSON")
		.action(
			async (
				workflow: string,
				opts: {
					attach?: boolean;
					watchdog?: boolean;
					monitor?: boolean;
					json?: boolean;
				},
			) => {
				await workflowStartCommand(workflow, opts, deps);
			},
		);

	return cmd;
}

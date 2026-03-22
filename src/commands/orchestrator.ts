import type { Command } from "commander";
import {
	type CoordinatorDeps,
	createPersistentAgentCommand,
	type PersistentAgentSpec,
	persistentAgentCommand,
} from "./coordinator.ts";

const ORCHESTRATOR_SPEC: PersistentAgentSpec = {
	commandName: "orchestrator",
	displayName: "Orchestrator",
	agentName: "orchestrator",
	capability: "orchestrator",
	agentDefFile: "orchestrator.md",
	beaconBuilder: buildOrchestratorBeacon,
};

/**
 * Build the startup beacon for the ecosystem-level orchestrator session.
 */
export function buildOrchestratorBeacon(cliName = "bd"): string {
	const timestamp = new Date().toISOString();
	const parts = [
		`[OVERSTORY] orchestrator (orchestrator) ${timestamp}`,
		"Depth: 0 | Parent: none | Role: persistent ecosystem orchestrator",
		"HIERARCHY: You start per-repo coordinators with ov coordinator start --project <path>. Do NOT use ov sling directly.",
		"DELEGATION: Work flows through sub-repo coordinators. Dispatch objectives by mail, then monitor coordinator progress and escalate only when needed.",
		`Startup: run mulch prime, check mail (ov mail check --agent orchestrator), check ${cliName} ready, inspect ecosystem status, then begin coordination`,
	];
	return parts.join(" — ");
}

export function createOrchestratorCommand(deps: CoordinatorDeps = {}): Command {
	return createPersistentAgentCommand(ORCHESTRATOR_SPEC, deps);
}

export async function orchestratorCommand(
	args: string[],
	deps: CoordinatorDeps = {},
): Promise<void> {
	await persistentAgentCommand(args, ORCHESTRATOR_SPEC, deps);
}

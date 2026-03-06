import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AgentError } from "../errors.ts";
import { PATH_PREFIX } from "./hooks-deployer.ts";

/** Copilot hook entry shape — simpler than Claude Code (no matcher, no type field). */
interface CopilotHookEntry {
	command: string;
}

/**
 * Resolve the path to the Copilot hooks template file.
 * The template lives at `templates/copilot-hooks.json.tmpl` relative to the repo root.
 */
function getTemplatePath(): string {
	// src/agents/copilot-hooks-deployer.ts -> repo root is ../../
	return join(dirname(import.meta.dir), "..", "templates", "copilot-hooks.json.tmpl");
}

/**
 * Deploy Copilot lifecycle hooks to an agent's worktree.
 *
 * Reads `templates/copilot-hooks.json.tmpl`, replaces all `{{AGENT_NAME}}` tokens,
 * prepends PATH_PREFIX to every hook command so CLIs (ov, ml, sd) resolve correctly
 * under Copilot's minimal PATH, then writes the result to
 * `<worktreePath>/.github/hooks/hooks.json`.
 *
 * Phase 1: lifecycle hooks only (onSessionStart). No security guards.
 *
 * @param worktreePath - Absolute path to the agent's git worktree
 * @param agentName - The unique name of the agent (replaces {{AGENT_NAME}} in template)
 * @throws {AgentError} If the template is missing or the write fails
 */
export async function deployCopilotHooks(worktreePath: string, agentName: string): Promise<void> {
	const templatePath = getTemplatePath();
	const file = Bun.file(templatePath);
	const exists = await file.exists();

	if (!exists) {
		throw new AgentError(`Copilot hooks template not found: ${templatePath}`, {
			agentName,
		});
	}

	let template: string;
	try {
		template = await file.text();
	} catch (err) {
		throw new AgentError(`Failed to read Copilot hooks template: ${templatePath}`, {
			agentName,
			cause: err instanceof Error ? err : undefined,
		});
	}

	// Replace all occurrences of {{AGENT_NAME}}
	let content = template;
	while (content.includes("{{AGENT_NAME}}")) {
		content = content.replace("{{AGENT_NAME}}", agentName);
	}

	// Parse the base config from the template
	const config = JSON.parse(content) as { hooks: Record<string, CopilotHookEntry[]> };

	// Extend PATH in all hook commands.
	// Copilot CLI executes hooks with a minimal PATH — ~/.bun/bin (where ov, ml, sd live)
	// is not included. Prepend PATH_PREFIX so CLIs resolve correctly.
	for (const entries of Object.values(config.hooks)) {
		for (const entry of entries) {
			entry.command = `${PATH_PREFIX} ${entry.command}`;
		}
	}

	const hooksDir = join(worktreePath, ".github", "hooks");
	const outputPath = join(hooksDir, "hooks.json");

	try {
		await mkdir(hooksDir, { recursive: true });
	} catch (err) {
		throw new AgentError(`Failed to create .github/hooks/ directory at: ${hooksDir}`, {
			agentName,
			cause: err instanceof Error ? err : undefined,
		});
	}

	try {
		await Bun.write(outputPath, `${JSON.stringify(config, null, "\t")}\n`);
	} catch (err) {
		throw new AgentError(`Failed to write Copilot hooks config to: ${outputPath}`, {
			agentName,
			cause: err instanceof Error ? err : undefined,
		});
	}
}

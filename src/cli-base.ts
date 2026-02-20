import type { CliBase, OverstoryConfig } from "./types.ts";

/** Resolved instruction overlay location for a given CLI base. */
export interface InstructionLayout {
	dir: string;
	file: string;
	startupPath: string;
}

/** Built interactive command plus whether system prompt was embedded inline. */
export interface InteractiveAgentCommand {
	command: string;
	systemPromptEmbedded: boolean;
}

function escapeSingleQuotes(value: string): string {
	return value.replace(/'/g, "'\\''");
}

/**
 * Resolve the active CLI base from config.
 * Falls back to "claude" when cli.base is unset.
 */
export function resolveCliBase(config: OverstoryConfig): CliBase {
	return config.cli?.base === "codex" ? "codex" : "claude";
}

/**
 * Get the instruction overlay target for the selected CLI.
 *
 * Claude sessions read `.claude/CLAUDE.md`.
 * Codex sessions read `AGENTS.md` at the worktree root.
 */
export function getInstructionLayout(cliBase: CliBase): InstructionLayout {
	if (cliBase === "codex") {
		return {
			dir: ".",
			file: "AGENTS.md",
			startupPath: "AGENTS.md",
		};
	}

	return {
		dir: ".claude",
		file: "CLAUDE.md",
		startupPath: ".claude/CLAUDE.md",
	};
}

/**
 * Build the command used to launch an interactive agent CLI session.
 *
 * Notes:
 * - Claude supports inline system prompt injection.
 * - Codex support is currently launch-only (model + interactive shell);
 *   base prompts are delivered via overlay/beacon flows.
 */
export function buildInteractiveAgentCommand(options: {
	cliBase: CliBase;
	model: string;
	systemPrompt?: string;
}): InteractiveAgentCommand {
	if (options.cliBase === "codex") {
		return {
			command: `codex --model ${options.model}`,
			systemPromptEmbedded: false,
		};
	}

	let command = `claude --model ${options.model} --dangerously-skip-permissions`;
	if (options.systemPrompt && options.systemPrompt.trim().length > 0) {
		command += ` --append-system-prompt '${escapeSingleQuotes(options.systemPrompt)}'`;
	}

	return { command, systemPromptEmbedded: true };
}

/**
 * True when selected CLI cannot run as root due known permission constraints.
 */
export function requiresNonRoot(cliBase: CliBase): boolean {
	return cliBase === "claude";
}

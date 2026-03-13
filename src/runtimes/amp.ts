// Amp runtime adapter for overstory's AgentRuntime interface.
// Implements the AgentRuntime contract for Sourcegraph's `amp` CLI (AI coding agent).
//
// Key differences from Claude/Pi adapters:
// - Interactive: `amp` runs as an interactive chat session in tmux
// - Instruction file: .amp/AGENT.md (Amp's native instruction file)
// - No hooks: Amp manages permissions via its own approval system
// - One-shot calls use `amp --prompt <prompt> --no-input`
// - Model is passed via `--model <model>`

import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ResolvedModel } from "../types.ts";
import type {
	AgentRuntime,
	HooksDef,
	OverlayContent,
	ReadyState,
	SpawnOpts,
	TranscriptSummary,
} from "./types.ts";

/**
 * Amp runtime adapter.
 *
 * Implements AgentRuntime for Sourcegraph's `amp` CLI. Amp agents run
 * as interactive chat sessions with configurable models and tools.
 *
 * Security is managed by Amp's built-in approval system for file
 * modifications and command execution.
 */
export class AmpRuntime implements AgentRuntime {
	readonly id = "amp";

	/** Experimental — community-contributed adapter, not yet battle-tested in production. */
	readonly stability = "experimental" as const;

	/**
	 * Amp reads .amp/AGENT.md from the repo for project-level instructions.
	 */
	readonly instructionPath = ".amp/AGENT.md";

	/**
	 * Build the shell command string to spawn an Amp agent in a tmux pane.
	 *
	 * Uses `amp` in interactive mode with `--model` for model selection
	 * and `--yes` for automatic approval.
	 *
	 * @param opts - Spawn options
	 * @returns Shell command string suitable for tmux new-session
	 */
	buildSpawnCommand(opts: SpawnOpts): string {
		let cmd = `amp --model ${opts.model} --yes`;

		if (opts.appendSystemPromptFile) {
			const escaped = opts.appendSystemPromptFile.replace(/'/g, "'\\''");
			cmd += ` --prompt "$(cat '${escaped}') Read .amp/AGENT.md for your task assignment."`;
		} else if (opts.appendSystemPrompt) {
			const escaped =
				`${opts.appendSystemPrompt}\n\nRead .amp/AGENT.md for your task assignment and begin.`.replace(
					/'/g,
					"'\\''",
				);
			cmd += ` --prompt '${escaped}'`;
		} else {
			cmd += ` --prompt 'Read .amp/AGENT.md for your task assignment and begin immediately.'`;
		}

		return cmd;
	}

	/**
	 * Build argv for a headless one-shot Amp invocation.
	 *
	 * Uses `amp --prompt <prompt> --no-input --yes` for non-interactive execution.
	 *
	 * @param prompt - The prompt to pass
	 * @param model - Optional model override
	 * @returns Argv array for Bun.spawn
	 */
	buildPrintCommand(prompt: string, model?: string): string[] {
		const cmd = ["amp", "--prompt", prompt, "--no-input", "--yes"];
		if (model !== undefined) {
			cmd.push("--model", model);
		}
		return cmd;
	}

	/**
	 * Deploy per-agent instructions to a worktree.
	 *
	 * Writes the overlay to .amp/AGENT.md (Amp's native instruction file).
	 * No hooks — Amp manages approvals internally.
	 *
	 * @param worktreePath - Absolute path to the agent's git worktree
	 * @param overlay - Overlay content, or undefined for no-op
	 * @param _hooks - Unused — Amp has no hook system
	 */
	async deployConfig(
		worktreePath: string,
		overlay: OverlayContent | undefined,
		_hooks: HooksDef,
	): Promise<void> {
		if (!overlay) return;
		const agentPath = join(worktreePath, this.instructionPath);
		await mkdir(dirname(agentPath), { recursive: true });
		await Bun.write(agentPath, overlay.content);
	}

	/**
	 * Detect Amp TUI readiness from tmux pane content.
	 *
	 * Amp shows a prompt indicator when ready for input.
	 *
	 * @param paneContent - Captured tmux pane content
	 * @returns Readiness phase
	 */
	detectReady(paneContent: string): ReadyState {
		const lower = paneContent.toLowerCase();

		// Prompt indicator: ">" or "amp>" at end of a line
		const hasPrompt = /(?:amp)?>\s*$/.test(paneContent);

		// Branding indicator: "amp" as a standalone word (word boundary prevents
		// matching inside "example", "stamp", "&amp;", etc.)
		const hasBranding = /\bamp\b/.test(lower);

		// Both required (AND logic) to prevent premature ready detection
		// during startup messages like "amp v1.2.3 starting..."
		if (hasPrompt && hasBranding) {
			return { phase: "ready" };
		}
		return { phase: "loading" };
	}

	/** Amp does not require beacon verification. */
	requiresBeaconVerification(): boolean {
		return false;
	}

	/** Amp does not produce machine-readable transcripts. */
	async parseTranscript(_path: string): Promise<TranscriptSummary | null> {
		return null;
	}

	buildEnv(model: ResolvedModel): Record<string, string> {
		return model.env ?? {};
	}

	/** Amp does not expose a transcript directory. */
	getTranscriptDir(_projectRoot: string): string | null {
		return null;
	}
}

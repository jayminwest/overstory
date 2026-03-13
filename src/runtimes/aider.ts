// Aider runtime adapter for overstory's AgentRuntime interface.
// Implements the AgentRuntime contract for the `aider` CLI (Paul Gauthier's AI pair programming tool).
//
// Key differences from Claude/Pi adapters:
// - Interactive: `aider` stays alive in tmux as a REPL-like session
// - Instruction file: .aider.conf.yml or CONVENTIONS.md (we use CONVENTIONS.md for overlay)
// - No hooks: Aider has no PreToolUse/PostToolUse hook system
// - One-shot calls use `aider --message <prompt> --yes-always`
// - Model is passed via `--model <model>` (supports litellm model strings)

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
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
 * Aider runtime adapter.
 *
 * Implements AgentRuntime for Paul Gauthier's `aider` CLI. Tmux-spawned
 * Aider agents run in interactive mode with `--yes-always` for automatic
 * confirmation of file edits.
 *
 * Security relies on Aider's built-in file-scope limiting — it only edits
 * files explicitly added to its context. No OS-level sandbox or hook guards.
 */
export class AiderRuntime implements AgentRuntime {
	readonly id = "aider";

	/** Experimental — community-contributed adapter, not yet battle-tested in production. */
	readonly stability = "experimental" as const;

	/**
	 * Aider reads CONVENTIONS.md from the repo root for project-level instructions.
	 * We write the overlay here so Aider picks it up natively.
	 */
	readonly instructionPath = "CONVENTIONS.md";

	/**
	 * Build the shell command string to spawn an Aider agent in a tmux pane.
	 *
	 * Uses `--yes-always` for automatic approval of file edits and
	 * `--no-auto-commits` so overstory controls git operations.
	 *
	 * @param opts - Spawn options
	 * @returns Shell command string suitable for tmux new-session
	 */
	buildSpawnCommand(opts: SpawnOpts): string {
		let cmd = "aider --yes-always --no-auto-commits";

		// Aider accepts litellm model strings: provider/model-name
		cmd += ` --model ${opts.model}`;

		if (opts.appendSystemPromptFile) {
			const escaped = opts.appendSystemPromptFile.replace(/'/g, "'\\''");
			cmd += ` --read '${escaped}'`;
		} else if (opts.appendSystemPrompt) {
			const escaped = opts.appendSystemPrompt.replace(/'/g, "'\\''");
			cmd += ` --message '${escaped} Read CONVENTIONS.md for your task assignment and begin.'`;
		} else {
			cmd += ` --message 'Read CONVENTIONS.md for your task assignment and begin immediately.'`;
		}

		return cmd;
	}

	/**
	 * Build argv for a headless one-shot Aider invocation.
	 *
	 * Uses `--message` for the prompt with `--yes-always` for non-interactive mode.
	 *
	 * @param prompt - The prompt to pass
	 * @param model - Optional model override
	 * @returns Argv array for Bun.spawn
	 */
	buildPrintCommand(prompt: string, model?: string): string[] {
		const cmd = ["aider", "--message", prompt, "--yes-always", "--no-auto-commits"];
		if (model !== undefined) {
			cmd.push("--model", model);
		}
		return cmd;
	}

	/**
	 * Deploy per-agent instructions to a worktree.
	 *
	 * Writes the overlay to CONVENTIONS.md (Aider's native conventions file).
	 * No hooks or guard extensions — Aider has no hook system.
	 *
	 * @param worktreePath - Absolute path to the agent's git worktree
	 * @param overlay - Overlay content, or undefined for no-op
	 * @param _hooks - Unused — Aider has no hook system
	 */
	async deployConfig(
		worktreePath: string,
		overlay: OverlayContent | undefined,
		_hooks: HooksDef,
	): Promise<void> {
		if (!overlay) return;
		await mkdir(worktreePath, { recursive: true });
		await Bun.write(join(worktreePath, this.instructionPath), overlay.content);
	}

	/**
	 * Detect Aider TUI readiness from tmux pane content.
	 *
	 * Aider shows a prompt like "aider>" or "> " when ready for input.
	 *
	 * @param paneContent - Captured tmux pane content
	 * @returns Readiness phase
	 */
	detectReady(paneContent: string): ReadyState {
		// Aider shows its prompt when ready: "aider> " or "> "
		if (/(?:aider)?>\s*$/.test(paneContent)) {
			return { phase: "ready" };
		}
		return { phase: "loading" };
	}

	/** Aider does not require beacon verification — accepts input reliably. */
	requiresBeaconVerification(): boolean {
		return false;
	}

	/**
	 * Aider does not produce machine-readable transcripts.
	 * Returns null — cost tracking relies on provider billing.
	 */
	async parseTranscript(_path: string): Promise<TranscriptSummary | null> {
		return null;
	}

	buildEnv(model: ResolvedModel): Record<string, string> {
		return model.env ?? {};
	}

	/** Aider logs to .aider.chat.history.md but not in a parseable transcript format. */
	getTranscriptDir(_projectRoot: string): string | null {
		return null;
	}
}

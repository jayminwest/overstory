// Goose runtime adapter for overstory's AgentRuntime interface.
// Implements the AgentRuntime contract for Block's `goose` CLI (AI developer agent).
//
// Key differences from Claude/Pi adapters:
// - Interactive: `goose` runs as a REPL session in tmux
// - Instruction file: .goosehints (Goose's native instruction file)
// - No hooks: Goose uses profile-based permissions, not PreToolUse hooks
// - One-shot calls use `goose run --text <prompt>`
// - Model is passed via `--model <model>` (or GOOSE_MODEL env var)

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
 * Goose runtime adapter.
 *
 * Implements AgentRuntime for Block's `goose` CLI. Goose agents run
 * as interactive REPL sessions with configurable toolkits (developer,
 * screen, github, etc.).
 *
 * Security is managed via Goose profiles which control which toolkits
 * and permissions are available. No OS-level sandbox.
 */
export class GooseRuntime implements AgentRuntime {
	readonly id = "goose";

	/**
	 * Goose reads .goosehints from the repo root for project-level instructions.
	 */
	readonly instructionPath = ".goosehints";

	/**
	 * Build the shell command string to spawn a Goose agent in a tmux pane.
	 *
	 * Goose starts an interactive session with `goose`. The `--model` flag
	 * sets the model. Instructions are provided via .goosehints.
	 *
	 * @param opts - Spawn options
	 * @returns Shell command string suitable for tmux new-session
	 */
	buildSpawnCommand(opts: SpawnOpts): string {
		let cmd = `goose --model ${opts.model}`;

		if (opts.appendSystemPromptFile) {
			const escaped = opts.appendSystemPromptFile.replace(/'/g, "'\\''");
			cmd += ` --instructions '${escaped}'`;
		} else if (opts.appendSystemPrompt) {
			// Goose doesn't have an inline system prompt flag — write to temp
			// and use --instructions. For tmux, we pipe it in via the initial prompt.
			const escaped =
				`${opts.appendSystemPrompt}\n\nRead .goosehints for your task assignment.`.replace(
					/'/g,
					"'\\''",
				);
			cmd += ` --with-prompt '${escaped}'`;
		}

		return cmd;
	}

	/**
	 * Build argv for a headless one-shot Goose invocation.
	 *
	 * Uses `goose run --text <prompt>` for non-interactive execution.
	 *
	 * @param prompt - The prompt to pass
	 * @param model - Optional model override
	 * @returns Argv array for Bun.spawn
	 */
	buildPrintCommand(prompt: string, model?: string): string[] {
		const cmd = ["goose", "run", "--text", prompt];
		if (model !== undefined) {
			cmd.push("--model", model);
		}
		return cmd;
	}

	/**
	 * Deploy per-agent instructions to a worktree.
	 *
	 * Writes the overlay to .goosehints (Goose's native instruction file).
	 * No hooks — Goose uses profile-based permissions.
	 *
	 * @param worktreePath - Absolute path to the agent's git worktree
	 * @param overlay - Overlay content, or undefined for no-op
	 * @param _hooks - Unused — Goose has no hook system
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
	 * Detect Goose TUI readiness from tmux pane content.
	 *
	 * Goose shows a "( O)> " prompt (the goose emoji) when ready for input.
	 *
	 * @param paneContent - Captured tmux pane content
	 * @returns Readiness phase
	 */
	detectReady(paneContent: string): ReadyState {
		const lower = paneContent.toLowerCase();

		// Prompt indicator: ">" or "❯" at end of a line
		const hasPrompt = /[>❯]\s*$/.test(paneContent);

		// Branding indicator: "goose" or the goose emoji "( O)" in pane content
		const hasBranding = lower.includes("goose") || paneContent.includes("( O)");

		// Both required (AND logic) to prevent premature ready detection
		// during startup messages like "Loading Goose..."
		if (hasPrompt && hasBranding) {
			return { phase: "ready" };
		}
		return { phase: "loading" };
	}

	/** Goose does not require beacon verification. */
	requiresBeaconVerification(): boolean {
		return false;
	}

	/**
	 * Goose does not produce machine-readable transcripts.
	 * Session logs are stored in ~/.config/goose/sessions/ but not in
	 * a format compatible with overstory's TranscriptSummary.
	 */
	async parseTranscript(_path: string): Promise<TranscriptSummary | null> {
		return null;
	}

	buildEnv(model: ResolvedModel): Record<string, string> {
		return model.env ?? {};
	}

	/** Goose stores sessions in ~/.config/goose/sessions/ but not transcript-parseable. */
	getTranscriptDir(_projectRoot: string): string | null {
		return null;
	}
}

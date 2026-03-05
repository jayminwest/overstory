// GitHub Copilot runtime adapter for overstory's AgentRuntime interface.
// Implements the AgentRuntime contract for the `copilot` CLI (GitHub Copilot).

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
 * Map of overstory model aliases to fully-qualified Copilot model names.
 *
 * The copilot CLI rejects short aliases like "sonnet" and requires fully-qualified
 * names like "claude-sonnet-4-6". Unknown names (e.g. "gpt-4o", "openrouter/gpt-5")
 * are passed through unchanged.
 */
const MODEL_MAP: Record<string, string> = {
	sonnet: "claude-sonnet-4-6",
	opus: "claude-opus-4-6",
	haiku: "claude-haiku-4-5",
};

/**
 * GitHub Copilot runtime adapter.
 *
 * Implements AgentRuntime for the `copilot` CLI (GitHub Copilot coding agent).
 * Key differences from Claude Code:
 * - Uses `--allow-all-tools` instead of `--permission-mode bypassPermissions`
 * - No `--append-system-prompt` flag (ignored when provided)
 * - Instruction file lives at `.github/copilot-instructions.md`
 * - No hooks deployment (hooks param unused in deployConfig)
 * - Transcript parser handles both Claude-style and Pi-style formats
 */
export class CopilotRuntime implements AgentRuntime {
	/** Unique identifier for this runtime. */
	readonly id = "copilot";

	/** Relative path to the instruction file within a worktree. */
	readonly instructionPath = ".github/copilot-instructions.md";

	/**
	 * Expand a model alias to a fully-qualified Copilot model name.
	 *
	 * Looks up the alias in MODEL_MAP. If not found, returns the model unchanged.
	 * This allows known aliases (sonnet, opus, haiku) to be resolved while
	 * passing through fully-qualified names (e.g. gpt-4o, openrouter/gpt-5).
	 *
	 * @param model - Short alias or fully-qualified model name
	 * @returns Fully-qualified model name accepted by the copilot CLI
	 */
	expandModel(model: string): string {
		return MODEL_MAP[model] ?? model;
	}

	/**
	 * Build the shell command string to spawn an interactive Copilot agent.
	 *
	 * Maps SpawnOpts to `copilot` CLI flags:
	 * - `model` → `--model <model>` (aliases expanded via MODEL_MAP)
	 * - `permissionMode === "bypass"` → `--allow-all-tools`
	 * - `permissionMode === "ask"` → no permission flag added
	 * - `appendSystemPrompt` and `appendSystemPromptFile` are IGNORED —
	 *   the `copilot` CLI has no equivalent flag.
	 *
	 * The `cwd` and `env` fields of SpawnOpts are handled by the tmux session
	 * creator, not embedded in the command string.
	 *
	 * @param opts - Spawn options (model, permissionMode; appendSystemPrompt ignored)
	 * @returns Shell command string suitable for tmux new-session -c
	 */
	buildSpawnCommand(opts: SpawnOpts): string {
		let cmd = `copilot --model ${this.expandModel(opts.model)}`;

		if (opts.permissionMode === "bypass") {
			cmd += " --allow-all-tools";
		}

		// appendSystemPrompt and appendSystemPromptFile are intentionally ignored.
		// The copilot CLI has no --append-system-prompt equivalent.

		return cmd;
	}

	/**
	 * Build the argv array for a headless one-shot Copilot invocation.
	 *
	 * Returns an argv array suitable for `Bun.spawn()`. The `-p` flag passes
	 * the prompt and `--allow-all-tools` grants full tool access. An optional
	 * `--model` flag can override the default model.
	 *
	 * Used by merge/resolver.ts and watchdog/triage.ts for AI-assisted operations.
	 *
	 * @param prompt - The prompt to pass via `-p`
	 * @param model - Optional model override
	 * @returns Argv array for Bun.spawn
	 */
	buildPrintCommand(prompt: string, model?: string): string[] {
		const cmd = ["copilot", "-p", prompt, "--allow-all-tools"];
		if (model !== undefined) {
			cmd.push("--model", this.expandModel(model));
		}
		return cmd;
	}

	/**
	 * Deploy per-agent instructions to a worktree.
	 *
	 * For Copilot this writes only the instruction file:
	 * - `.github/copilot-instructions.md` — the agent's task-specific overlay.
	 *   Skipped when overlay is undefined.
	 *
	 * The `hooks` parameter is unused — Copilot does not support Claude Code's
	 * hook mechanism, so no settings file is deployed.
	 *
	 * @param worktreePath - Absolute path to the agent's git worktree
	 * @param overlay - Overlay content to write as copilot-instructions.md, or undefined to skip
	 * @param _hooks - Unused for Copilot runtime
	 */
	async deployConfig(
		worktreePath: string,
		overlay: OverlayContent | undefined,
		_hooks: HooksDef,
	): Promise<void> {
		if (overlay) {
			const githubDir = join(worktreePath, ".github");
			await mkdir(githubDir, { recursive: true });
			await Bun.write(join(githubDir, "copilot-instructions.md"), overlay.content);
		}

		// No hook deployment for Copilot — the runtime has no hook mechanism.
	}

	/**
	 * Detect Copilot TUI readiness from a tmux pane content snapshot.
	 *
	 * Detection requires both a prompt indicator AND a status bar indicator
	 * (matched case-insensitively). No trust dialog phase exists for Copilot.
	 *
	 * - Prompt: U+276F (❯) or "copilot" in pane content (case-insensitive)
	 * - Status bar: "shift+tab" or "esc" in pane content (case-insensitive)
	 *
	 * @param paneContent - Captured tmux pane content to analyze
	 * @returns Current readiness phase (never "dialog" for Copilot)
	 */
	detectReady(paneContent: string): ReadyState {
		const lower = paneContent.toLowerCase();

		// Prompt indicator: ❯ character or "copilot" keyword in pane.
		const hasPrompt = paneContent.includes("\u276f") || lower.includes("copilot");

		// Status bar indicator: keyboard shortcut hints visible when TUI is ready.
		const hasStatusBar = lower.includes("shift+tab") || lower.includes("esc");

		if (hasPrompt && hasStatusBar) {
			return { phase: "ready" };
		}

		return { phase: "loading" };
	}

	/**
	 * Parse a Copilot transcript JSONL file into normalized token usage.
	 *
	 * Handles two transcript formats:
	 * - Claude-style: `type === "assistant"` entries with `message.usage.input_tokens`
	 *   and `message.usage.output_tokens`; model from `message.model`
	 * - Pi-style: `type === "message_end"` entries with top-level `inputTokens`
	 *   and `outputTokens`
	 *
	 * Also checks the top-level `model` field on any entry for model identification.
	 * Returns null if the file does not exist or cannot be parsed.
	 *
	 * @param path - Absolute path to the transcript JSONL file
	 * @returns Aggregated token usage, or null if unavailable
	 */
	async parseTranscript(path: string): Promise<TranscriptSummary | null> {
		const file = Bun.file(path);
		if (!(await file.exists())) {
			return null;
		}

		try {
			const text = await file.text();
			const lines = text.split("\n").filter((l) => l.trim().length > 0);

			let inputTokens = 0;
			let outputTokens = 0;
			let model = "";

			for (const line of lines) {
				let entry: Record<string, unknown>;
				try {
					entry = JSON.parse(line) as Record<string, unknown>;
				} catch {
					// Skip malformed lines — transcripts may have partial writes.
					continue;
				}

				// Check top-level model field (Pi model_change and other events).
				if (typeof entry.model === "string" && entry.model) {
					model = entry.model;
				}

				if (entry.type === "assistant") {
					// Claude-style: message.usage.input_tokens / output_tokens.
					const message = entry.message as Record<string, unknown> | undefined;
					const usage = message?.usage as Record<string, unknown> | undefined;
					if (typeof usage?.input_tokens === "number") {
						inputTokens += usage.input_tokens;
					}
					if (typeof usage?.output_tokens === "number") {
						outputTokens += usage.output_tokens;
					}
					// Model may also live inside message object.
					if (typeof message?.model === "string" && message.model) {
						model = message.model;
					}
				} else if (entry.type === "message_end") {
					// Pi-style: top-level inputTokens / outputTokens.
					if (typeof entry.inputTokens === "number") {
						inputTokens += entry.inputTokens;
					}
					if (typeof entry.outputTokens === "number") {
						outputTokens += entry.outputTokens;
					}
				}
			}

			return { inputTokens, outputTokens, model };
		} catch {
			return null;
		}
	}

	/**
	 * Build runtime-specific environment variables for model/provider routing.
	 *
	 * Returns the provider environment variables from the resolved model, or an
	 * empty object if none are set.
	 *
	 * @param model - Resolved model with optional provider env vars
	 * @returns Environment variable map (may be empty)
	 */
	buildEnv(model: ResolvedModel): Record<string, string> {
		return model.env ?? {};
	}

	/** Copilot does not produce transcript files. */
	getTranscriptDir(_projectRoot: string): string | null {
		return null;
	}
}

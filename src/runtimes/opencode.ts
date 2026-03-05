// OpenCode runtime adapter for overstory's AgentRuntime interface.
// Implements the AgentRuntime contract for the `opencode` CLI (OpenCode AI coding agent).

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
 * OpenCode runtime adapter.
 *
 * Implements AgentRuntime for the `opencode` CLI. Key differences from Claude Code:
 * - No permission-mode flags (defaults to bypass mode)
 * - Uses `--dir <path>` for working directory (perfect for worktree isolation)
 * - Uses `--format json` for headless mode / transcript parsing
 * - Instruction file at `.claude/CLAUDE.md` (same as Claude/Pi)
 * - No hooks deployment (OpenCode has no hook system - follows Copilot pattern)
 */
export class OpenCodeRuntime implements AgentRuntime {
	readonly id = "opencode";
	readonly instructionPath = ".claude/CLAUDE.md";

	buildSpawnCommand(opts: SpawnOpts): string {
		let cmd = `opencode run`;

		if (opts.model) {
			cmd += ` --model ${opts.model}`;
		}

		if (opts.cwd) {
			const escaped = opts.cwd.replace(/'/g, "'\\''");
			cmd += ` --dir '${escaped}'`;
		}

		if (opts.appendSystemPromptFile) {
			// Read role definition from file at shell expansion time - avoids tmux
			// command length limits. Prepend to user prompt.
			const escaped = opts.appendSystemPromptFile.replace(/'/g, "'\\''");
			cmd += ` --prompt "$(cat '${escaped}')"`;
		} else if (opts.appendSystemPrompt) {
			// Inline system prompt - prepend to any user prompt
			const escaped = opts.appendSystemPrompt.replace(/'/g, "'\\''");
			cmd += ` --prompt '${escaped}'`;
		}

		return cmd;
	}

	buildPrintCommand(prompt: string, model?: string): string[] {
		// Use --format json for structured output in headless mode
		const cmd = ["opencode", "run", "--format", "json"];

		if (model !== undefined) {
			cmd.push("--model", model);
		}

		cmd.push(prompt);

		return cmd;
	}

	async deployConfig(
		worktreePath: string,
		overlay: OverlayContent | undefined,
		_hooks: HooksDef,
	): Promise<void> {
		if (!overlay) return;

		// Write CLAUDE.md from overlay content
		const claudeDir = join(worktreePath, ".claude");
		await mkdir(claudeDir, { recursive: true });

		const claudeMdPath = join(claudeDir, "CLAUDE.md");
		await Bun.write(claudeMdPath, overlay.content);

		// No hook deployment for OpenCode - runtime has no hook system
		// (Follows Copilot pattern)
	}

	detectReady(paneContent: string): ReadyState {
		const lower = paneContent.toLowerCase();

		// Prompt indicator: "❯" character or "opencode" branding in pane.
		const hasPrompt = paneContent.includes("\u276f") || lower.includes("opencode");

		// Status bar: look for OpenCode-specific indicators — token counts or
		// model name display that appear once the TUI is fully initialized.
		const hasStatusBar =
			/tokens?\s*[:=]\s*[0-9]/i.test(paneContent) ||
			/model\s*[:=]\s*\S/i.test(paneContent) ||
			lower.includes("ready");

		if (hasPrompt && hasStatusBar) {
			return { phase: "ready" };
		}

		return { phase: "loading" };
	}

	async parseTranscript(path: string): Promise<TranscriptSummary | null> {
		const file = Bun.file(path);
		if (!(await file.exists())) {
			return null;
		}

		try {
			const text = await file.text();

			// Try parsing as JSON first (session export format)
			let data: unknown;
			try {
				data = JSON.parse(text);
			} catch {
				// Not JSON - check if it's JSONL (multiple JSON objects per line)
				const lines = text.split("\n").filter((l) => l.trim().length > 0);

				let inputTokens = 0;
				let outputTokens = 0;
				let model = "";
				let foundTokens = false;

				for (const line of lines) {
					try {
						const event = JSON.parse(line) as Record<string, unknown>;

						// Look for token counts in various possible field names
						if (typeof event.inputTokens === "number") {
							inputTokens += event.inputTokens;
							foundTokens = true;
						}
						if (typeof event.outputTokens === "number") {
							outputTokens += event.outputTokens;
							foundTokens = true;
						}
						if (
							typeof event.usage === "object" &&
							event.usage !== null &&
							typeof (event.usage as Record<string, unknown>).inputTokens === "number"
						) {
							inputTokens += (event.usage as Record<string, unknown>).inputTokens as number;
							foundTokens = true;
						}
						if (
							typeof event.usage === "object" &&
							event.usage !== null &&
							typeof (event.usage as Record<string, unknown>).outputTokens === "number"
						) {
							outputTokens += (event.usage as Record<string, unknown>).outputTokens as number;
							foundTokens = true;
						}
						if (typeof event.message === "object" && event.message !== null) {
							const messageUsage = (event.message as Record<string, unknown>).usage;
							if (messageUsage != null && typeof messageUsage === "object") {
								const inputCount = (messageUsage as Record<string, unknown>).input_tokens;
								const outputCount = (messageUsage as Record<string, unknown>).output_tokens;
								if (typeof inputCount === "number") {
									inputTokens += inputCount;
									foundTokens = true;
								}
								if (typeof outputCount === "number") {
									outputTokens += outputCount;
									foundTokens = true;
								}
							}

							// Capture model from message object
							const messageModel = (event.message as Record<string, unknown>).model;
							if (typeof messageModel === "string") {
								model = messageModel;
							}
						}

						// Capture model from top-level event
						if (typeof event.model === "string") {
							model = event.model;
						}
					} catch {}
				}

				if (foundTokens) {
					return { inputTokens, outputTokens, model };
				}

				return null;
			}

			// Single JSON object format - OpenCode session export
			if (typeof data === "object" && data !== null) {
				const session = data as Record<string, unknown>;

				let inputTokens = 0;
				let outputTokens = 0;
				let model = "";

				// Try various field paths for token counts
				const tokensPath = session.tokens || session.usage || session.metrics || session.stats;
				if (typeof tokensPath === "object" && tokensPath !== null) {
					if (typeof (tokensPath as Record<string, unknown>).input === "number") {
						inputTokens = (tokensPath as Record<string, unknown>).input as number;
					}
					if (typeof (tokensPath as Record<string, unknown>).output === "number") {
						outputTokens = (tokensPath as Record<string, unknown>).output as number;
					}
					if (typeof (tokensPath as Record<string, unknown>).inputTokens === "number") {
						inputTokens = (tokensPath as Record<string, unknown>).inputTokens as number;
					}
					if (typeof (tokensPath as Record<string, unknown>).outputTokens === "number") {
						outputTokens = (tokensPath as Record<string, unknown>).outputTokens as number;
					}
					if (typeof (tokensPath as Record<string, unknown>).prompt_tokens === "number") {
						inputTokens = (tokensPath as Record<string, unknown>).prompt_tokens as number;
					}
					if (typeof (tokensPath as Record<string, unknown>).completion_tokens === "number") {
						outputTokens = (tokensPath as Record<string, unknown>).completion_tokens as number;
					}
				}

				// Also check message.usage (Anthropic API response format)
				if (typeof session.message === "object" && session.message !== null) {
					const msg = session.message as Record<string, unknown>;
					const msgUsage = msg.usage;
					if (typeof msgUsage === "object" && msgUsage !== null) {
						const mu = msgUsage as Record<string, unknown>;
						if (typeof mu.input_tokens === "number") {
							inputTokens = mu.input_tokens as number;
						}
						if (typeof mu.output_tokens === "number") {
							outputTokens = mu.output_tokens as number;
						}
					}
					if (typeof msg.model === "string") {
						model = msg.model;
					}
				}

				// Capture model
				if (typeof session.model === "string") {
					model = session.model;
				} else if (typeof session.options === "object" && session.options !== null) {
					const opts = session.options as Record<string, unknown>;
					if (typeof opts.model === "string") {
						model = opts.model;
					}
				}

				if (inputTokens > 0 || outputTokens > 0) {
					return { inputTokens, outputTokens, model };
				}
			}

			return null;
		} catch {
			return null;
		}
	}

	getTranscriptDir(_projectRoot: string): string | null {
		return null;
	}

	requiresBeaconVerification(): boolean {
		return false;
	}

	buildEnv(model: ResolvedModel): Record<string, string> {
		return model.env ?? {};
	}
}

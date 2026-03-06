// Cursor CLI runtime adapter for overstory's AgentRuntime interface.
// Implements the AgentRuntime contract for the `agent` binary (Cursor's CLI agent).
//
// Key characteristics:
// - TUI: `agent` maintains an interactive TUI in tmux
// - Instruction file: .cursor/rules/overstory.md (Cursor's native rules system)
// - No hooks: Cursor CLI has no hook/guard mechanism (like Copilot/Gemini)
// - Permission: `--yolo` flag for bypass mode
// - Headless: `agent -p "prompt"` for one-shot calls
// - Transcripts: stream-json NDJSON with system/init events for model

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
 * Cursor CLI runtime adapter.
 *
 * Implements AgentRuntime for the `agent` binary (Cursor's coding agent CLI).
 * The CLI binary is `agent`, not `cursor`.
 *
 * Instructions are delivered via `.cursor/rules/overstory.md` (Cursor's
 * native rules system), which the CLI reads automatically from the workspace.
 *
 * No hook/guard deployment — the `_hooks` parameter in `deployConfig`
 * is unused, same as Copilot and Gemini.
 */
export class CursorRuntime implements AgentRuntime {
	/** Unique identifier for this runtime. */
	readonly id = "cursor";

	/** Relative path to the instruction file within a worktree. */
	readonly instructionPath = ".cursor/rules/overstory.md";

	/**
	 * Build the shell command string to spawn an interactive Cursor agent.
	 *
	 * Maps SpawnOpts to `agent` CLI flags:
	 * - `model` → `--model <model>`
	 * - `permissionMode === "bypass"` → `--yolo`
	 * - `permissionMode === "ask"` → no permission flag
	 * - `appendSystemPrompt` and `appendSystemPromptFile` are IGNORED —
	 *   the `agent` CLI has no equivalent flag.
	 *
	 * The `cwd` and `env` fields of SpawnOpts are handled by the tmux session
	 * creator, not embedded in the command string.
	 *
	 * @param opts - Spawn options (model, permissionMode; appendSystemPrompt ignored)
	 * @returns Shell command string suitable for tmux new-session -c
	 */
	buildSpawnCommand(opts: SpawnOpts): string {
		let cmd = `agent --model ${opts.model}`;

		if (opts.permissionMode === "bypass") {
			cmd += " --yolo";
		}

		return cmd;
	}

	/**
	 * Build the argv array for a headless one-shot Cursor invocation.
	 *
	 * Returns an argv array suitable for `Bun.spawn()`. The `-p` flag
	 * triggers headless/print mode. `--yolo` is always included to
	 * auto-approve tool calls for headless operations.
	 *
	 * @param prompt - The prompt to pass via `-p`
	 * @param model - Optional model override
	 * @returns Argv array for Bun.spawn
	 */
	buildPrintCommand(prompt: string, model?: string): string[] {
		const cmd = ["agent", "-p", prompt, "--yolo"];
		if (model !== undefined) {
			cmd.push("--model", model);
		}
		return cmd;
	}

	/**
	 * Deploy per-agent instructions to a worktree.
	 *
	 * Writes the overlay to `.cursor/rules/overstory.md` in the worktree
	 * (Cursor's native rules system). Creates the `.cursor/rules/` directory
	 * if it doesn't exist.
	 *
	 * The `hooks` parameter is unused — Cursor CLI has no hook mechanism
	 * for per-tool interception.
	 *
	 * @param worktreePath - Absolute path to the agent's git worktree
	 * @param overlay - Overlay content to write, or undefined to skip
	 * @param _hooks - Unused for Cursor runtime
	 */
	async deployConfig(
		worktreePath: string,
		overlay: OverlayContent | undefined,
		_hooks: HooksDef,
	): Promise<void> {
		if (!overlay) return;

		const filePath = join(worktreePath, this.instructionPath);
		await mkdir(dirname(filePath), { recursive: true });
		await Bun.write(filePath, overlay.content);
	}

	/**
	 * Detect Cursor TUI readiness from a tmux pane content snapshot.
	 *
	 * Detection requires both a prompt indicator AND a status indicator
	 * (AND logic):
	 *
	 * - Prompt: U+276F (❯) or `> ` at line start (`/^> /m`)
	 * - Status: "shift+tab", "esc", or "agent" in pane content (case-insensitive)
	 *
	 * No trust dialog phase exists for Cursor (unlike Claude Code).
	 *
	 * @param paneContent - Captured tmux pane content to analyze
	 * @returns Current readiness phase (never "dialog" for Cursor)
	 */
	detectReady(paneContent: string): ReadyState {
		const lower = paneContent.toLowerCase();

		const hasPrompt = paneContent.includes("\u276f") || /^> /m.test(paneContent);

		const hasStatusBar =
			lower.includes("shift+tab") || lower.includes("esc") || lower.includes("agent");

		if (hasPrompt && hasStatusBar) {
			return { phase: "ready" };
		}

		return { phase: "loading" };
	}

	/**
	 * Parse a Cursor stream-json NDJSON transcript into normalized token usage.
	 *
	 * Cursor's transcript format uses `{ type: "system", subtype: "init", model: "..." }`
	 * events for model identification. Token usage is NOT available in Cursor's
	 * format, so inputTokens and outputTokens are always 0.
	 *
	 * @param path - Absolute path to the transcript NDJSON file
	 * @returns Normalized summary with model and zero tokens, or null if unavailable
	 */
	async parseTranscript(path: string): Promise<TranscriptSummary | null> {
		const file = Bun.file(path);
		if (!(await file.exists())) {
			return null;
		}

		try {
			const text = await file.text();
			const lines = text.split("\n").filter((l) => l.trim().length > 0);

			let model = "";

			for (const line of lines) {
				let event: Record<string, unknown>;
				try {
					event = JSON.parse(line) as Record<string, unknown>;
				} catch {
					continue;
				}

				if (
					event.type === "system" &&
					event.subtype === "init" &&
					typeof event.model === "string"
				) {
					model = event.model;
				}
			}

			return { inputTokens: 0, outputTokens: 0, model };
		} catch {
			return null;
		}
	}

	/**
	 * Build runtime-specific environment variables for model/provider routing.
	 *
	 * @param model - Resolved model with optional provider env vars
	 * @returns Environment variable map (may be empty)
	 */
	buildEnv(model: ResolvedModel): Record<string, string> {
		return model.env ?? {};
	}

	/** Cursor transcript location not yet verified. */
	getTranscriptDir(_projectRoot: string): string | null {
		return null;
	}
}

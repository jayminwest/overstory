// Codex runtime adapter for overstory's AgentRuntime interface.
// Implements the AgentRuntime contract for the OpenAI `codex` CLI.
//
// Key differences from Claude/Pi adapters:
// - Interactive: `codex` (without `exec`) stays alive in tmux for orchestration
// - Instruction file: AGENTS.md (not .claude/CLAUDE.md)
// - No hooks: Codex uses OS-level sandbox (Seatbelt/Landlock)
// - One-shot calls still use `codex exec` (buildPrintCommand)

import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ResolvedModel } from "../types.ts";
import type {
	AgentRuntime,
	HooksDef,
	OverlayContent,
	RateLimitState,
	ReadyState,
	SpawnOpts,
	TranscriptSummary,
} from "./types.ts";

/**
 * Codex runtime adapter.
 *
 * Implements AgentRuntime for the OpenAI `codex` CLI. Tmux-spawned Codex
 * agents run in interactive mode (`codex`) so sessions stay alive and can be
 * nudged via tmux.
 *
 * Security is enforced via Codex's OS-level sandbox (Seatbelt on macOS,
 * Landlock on Linux) rather than hook-based guards. The `--full-auto` flag
 * enables `workspace-write` sandbox + automatic approvals.
 *
 * Instructions are delivered via `AGENTS.md` (Codex's native convention),
 * not `.claude/CLAUDE.md`.
 */
export class CodexRuntime implements AgentRuntime {
	/** Unique identifier for this runtime. */
	readonly id = "codex";

	/** Relative path to the instruction file within a worktree. */
	readonly instructionPath = "AGENTS.md";

	/**
	 * Anthropic aliases used by overstory manifests that Codex CLI does not
	 * accept as --model values.
	 */
	private static readonly MANIFEST_ALIASES = new Set(["sonnet", "opus", "haiku"]);

	/**
	 * Build the shell command string to spawn a Codex agent in a tmux pane.
	 *
	 * Uses interactive `codex` with `--full-auto` for workspace-write sandbox +
	 * automatic approvals.
	 *
	 * The prompt directs the agent to read AGENTS.md for its full instructions.
	 * If `appendSystemPrompt` or `appendSystemPromptFile` is provided, the
	 * content is prepended to the prompt (Codex has no --append-system-prompt
	 * flag — all context goes through the exec prompt or AGENTS.md).
	 *
	 * @param opts - Spawn options (model, appendSystemPrompt; permissionMode is accepted but
	 *   not mapped — Codex enforces security via OS sandbox, not permission flags)
	 * @returns Shell command string suitable for tmux new-session -c
	 */
	buildSpawnCommand(opts: SpawnOpts): string {
		// When model comes from default manifest aliases (sonnet/opus/haiku),
		// omit --model so Codex uses the user's configured default model.
		let cmd = "codex --full-auto";
		if (!CodexRuntime.MANIFEST_ALIASES.has(opts.model)) {
			cmd += ` --model ${opts.model}`;
		}

		if (opts.appendSystemPromptFile) {
			// Read role definition from file at shell expansion time — avoids tmux
			// IPC message size limits. Append the "read AGENTS.md" instruction.
			const escaped = opts.appendSystemPromptFile.replace(/'/g, "'\\''");
			cmd += ` "$(cat '${escaped}')"' Read AGENTS.md for your task assignment and begin immediately.'`;
		} else if (opts.appendSystemPrompt) {
			// Inline role definition + instruction to read AGENTS.md.
			const prompt = `${opts.appendSystemPrompt}\n\nRead AGENTS.md for your task assignment and begin immediately.`;
			const escaped = prompt.replace(/'/g, "'\\''");
			cmd += ` '${escaped}'`;
		} else {
			cmd += ` 'Read AGENTS.md for your task assignment and begin immediately.'`;
		}

		return cmd;
	}

	/**
	 * Build the argv array for a headless one-shot Codex invocation.
	 *
	 * Returns an argv array suitable for `Bun.spawn()`. Uses `codex exec`
	 * with `--full-auto` and `--ephemeral` (no session persistence).
	 * Without `--json`, stdout contains the plain text final message.
	 *
	 * Used by merge/resolver.ts (AI-assisted conflict resolution) and
	 * watchdog/triage.ts (AI-assisted failure classification).
	 *
	 * @param prompt - The prompt to pass as the exec argument
	 * @param model - Optional model override
	 * @returns Argv array for Bun.spawn
	 */
	buildPrintCommand(prompt: string, model?: string): string[] {
		const cmd = ["codex", "exec", "--full-auto", "--ephemeral"];
		if (model !== undefined) {
			cmd.push("--model", model);
		}
		cmd.push(prompt);
		return cmd;
	}

	/**
	 * Deploy per-agent instructions to a worktree.
	 *
	 * Writes the overlay to `AGENTS.md` in the worktree root (Codex's native
	 * instruction file convention). Unlike Claude/Pi adapters, no hooks or
	 * guard extensions are deployed — Codex enforces security boundaries via
	 * its OS-level sandbox (Seatbelt on macOS, Landlock on Linux).
	 *
	 * When overlay is undefined (hooks-only deployment for coordinator/supervisor/monitor),
	 * this is a no-op since Codex has no hook system to deploy.
	 *
	 * @param worktreePath - Absolute path to the agent's git worktree
	 * @param overlay - Overlay content to write as AGENTS.md, or undefined for no-op
	 * @param _hooks - Hook definition (unused — Codex uses OS sandbox, not hooks)
	 */
	async deployConfig(
		worktreePath: string,
		overlay: OverlayContent | undefined,
		_hooks: HooksDef,
	): Promise<void> {
		if (!overlay) return;

		const agentsPath = join(worktreePath, this.instructionPath);
		// Ensure parent directory exists (AGENTS.md is in the worktree root,
		// but the worktree dir itself might not exist yet).
		await mkdir(dirname(agentsPath), { recursive: true });
		await Bun.write(agentsPath, overlay.content);
	}

	/**
	 * Codex interactive startup is treated as ready once a pane exists.
	 *
	 * @param _paneContent - Captured tmux pane content (unused)
	 * @returns Always `{ phase: "ready" }`
	 */
	detectReady(_paneContent: string): ReadyState {
		return { phase: "ready" };
	}

	/**
	 * Codex does not require beacon verification/resend.
	 *
	 * Codex accepts startup input reliably once spawned.
	 */
	requiresBeaconVerification(): boolean {
		return false;
	}

	/**
	 * Parse a Codex NDJSON transcript file into normalized token usage.
	 *
	 * Codex NDJSON format (from `--json` flag) differs from Claude/Pi:
	 * - Token counts are in `turn.completed` events with
	 *   `usage.input_tokens` and `usage.output_tokens`
	 * - Model identity may appear in `thread.started` events or item metadata
	 *
	 * Returns null if the file does not exist or cannot be parsed.
	 *
	 * @param path - Absolute path to the Codex NDJSON transcript file
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
				let event: Record<string, unknown>;
				try {
					event = JSON.parse(line) as Record<string, unknown>;
				} catch {
					// Skip malformed lines — partial writes during capture.
					continue;
				}

				if (event.type === "turn.completed") {
					const usage = event.usage as Record<string, number | undefined> | undefined;
					if (usage) {
						if (typeof usage.input_tokens === "number") {
							inputTokens += usage.input_tokens;
						}
						if (typeof usage.output_tokens === "number") {
							outputTokens += usage.output_tokens;
						}
					}
				}

				// Capture model from any event that carries it.
				if (typeof event.model === "string") {
					model = event.model;
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
	 * Returns the provider environment variables from the resolved model.
	 * For OpenAI native: may include OPENAI_API_KEY, OPENAI_BASE_URL.
	 * For gateway providers: may include gateway-specific auth and routing vars.
	 *
	 * @param model - Resolved model with optional provider env vars
	 * @returns Environment variable map (may be empty)
	 */
	buildEnv(model: ResolvedModel): Record<string, string> {
		return model.env ?? {};
	}

	/** Codex does not produce transcript files. */
	getTranscriptDir(_projectRoot: string): string | null {
		return null;
	}

	/**
	 * Detect rate limiting from tmux pane content.
	 *
	 * Checks for OpenAI rate limit patterns: HTTP 429, quota exceeded, etc.
	 */
	detectRateLimit(paneContent: string): RateLimitState {
		const lower = paneContent.toLowerCase();
		if (lower.includes("429") || lower.includes("rate limit") || lower.includes("rate_limit")) {
			return { limited: true, resumesAt: null, message: "OpenAI rate limited (429)" };
		}
		if (lower.includes("too many requests")) {
			return { limited: true, resumesAt: null, message: "OpenAI too many requests" };
		}
		if (lower.includes("quota exceeded") || lower.includes("insufficient_quota")) {
			return { limited: true, resumesAt: null, message: "OpenAI quota exceeded" };
		}
		return { limited: false };
	}
}

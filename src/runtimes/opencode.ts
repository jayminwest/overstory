// OpenCode runtime adapter for overstory's AgentRuntime interface.
// Implements the AgentRuntime contract for the `opencode` CLI (SST OpenCode).
//
// Key differences from Claude/Pi adapters:
// - Uses `opencode` CLI for interactive sessions and `opencode run` for headless
// - Instruction file: AGENTS.md (OpenCode reads this at startup via /init)
// - Guard mechanism: .opencode/plugins/ guard plugin + opencode.json permission config
// - detectReady matches "Ask anything" prompt + version number in status bar
// - parseTranscript parses nd-JSON from `opencode run --format json` output
// - Data stored in SQLite at ~/.local/share/opencode/opencode.db

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ResolvedModel } from "../types.ts";
import {
	generateOpenCodeGuardPlugin,
	generateOpenCodePermissionConfig,
} from "./opencode-guards.ts";
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
 * Implements AgentRuntime for the `opencode` CLI (SST OpenCode coding agent).
 * Key differences from Claude Code:
 * - Uses `--model` flag for model selection (accepts provider/model format)
 * - Instruction file lives at `AGENTS.md` (OpenCode reads this at startup)
 * - Guard deployment via `.opencode/plugins/overstory-guard.ts` plugin +
 *   `opencode.json` permission config (defense-in-depth)
 * - `detectReady` matches "Ask anything" prompt text + version number in status bar
 * - `parseTranscript` parses nd-JSON from `opencode run --format json` step_finish events
 * - OpenCode stores data in SQLite (~/.local/share/opencode/opencode.db), not JSONL files
 *
 * Verified against OpenCode v1.2.27 on macOS (2026-03-28).
 */
export class OpenCodeRuntime implements AgentRuntime {
	/** Unique identifier for this runtime. */
	readonly id = "opencode";

	/** Stability level. OpenCode adapter is experimental — guard plugin approach is new. */
	readonly stability = "experimental" as const;

	/**
	 * Relative path to the instruction file within a worktree.
	 *
	 * OpenCode reads `AGENTS.md` at startup via its `/init` convention.
	 * Verified against OpenCode v1.2.27 documentation and behavior.
	 */
	readonly instructionPath = "AGENTS.md";

	/**
	 * Build the shell command string to spawn an interactive OpenCode agent in a tmux pane.
	 *
	 * Maps SpawnOpts to `opencode` CLI flags:
	 * - `model` → `--model <model>`
	 * - `permissionMode`, `appendSystemPrompt`, `appendSystemPromptFile` are IGNORED —
	 *   the `opencode` CLI has no equivalent flags. Permissions are handled via the
	 *   `opencode.json` config and guard plugin deployed by `deployConfig()`.
	 *
	 * The `cwd` and `env` fields of SpawnOpts are handled by the tmux session
	 * creator, not embedded in the command string.
	 *
	 * @param opts - Spawn options (model used; others ignored)
	 * @returns Shell command string suitable for tmux new-session -c
	 */
	buildSpawnCommand(opts: SpawnOpts): string {
		// permissionMode, appendSystemPrompt, appendSystemPromptFile are intentionally ignored.
		// OpenCode has no equivalent flags for these options.
		// Permissions are enforced via .opencode/plugins/overstory-guard.ts + opencode.json.
		return `opencode --model ${opts.model}`;
	}

	/**
	 * Build the argv array for a headless one-shot OpenCode invocation.
	 *
	 * Returns an argv array suitable for `Bun.spawn()`. Uses `opencode run` subcommand
	 * with `--format json` for nd-JSON event output. The prompt is a positional argument.
	 *
	 * Verified against OpenCode v1.2.27: `opencode run --format json "prompt"` emits
	 * nd-JSON events including step_start, tool_use, text, and step_finish with token data.
	 *
	 * Used by merge/resolver.ts and watchdog/triage.ts for AI-assisted operations.
	 *
	 * @param prompt - The prompt to pass as a positional argument
	 * @param model - Optional model override (provider/model format)
	 * @returns Argv array for Bun.spawn
	 */
	buildPrintCommand(prompt: string, model?: string): string[] {
		const cmd = ["opencode", "run", "--format", "json", prompt];
		if (model !== undefined) {
			cmd.push("--model", model);
		}
		return cmd;
	}

	/**
	 * Deploy per-agent instructions and guards to a worktree.
	 *
	 * For OpenCode this writes up to three files:
	 * 1. `AGENTS.md` — the agent's task-specific overlay.
	 *    Skipped when overlay is undefined.
	 * 2. `.opencode/plugins/overstory-guard.ts` — guard plugin (always deployed).
	 *    Uses OpenCode's plugin system with `tool.execute.before` to block dangerous
	 *    operations based on agent capability.
	 * 3. `opencode.json` — OpenCode permission config (always deployed).
	 *    Defense-in-depth: denies write tools for read-only agents at the permission level.
	 *
	 * @param worktreePath - Absolute path to the agent's git worktree
	 * @param overlay - Overlay content to write as AGENTS.md, or undefined to skip
	 * @param hooks - Agent identity, capability, worktree path, and optional quality gates
	 */
	async deployConfig(
		worktreePath: string,
		overlay: OverlayContent | undefined,
		hooks: HooksDef,
	): Promise<void> {
		if (overlay) {
			await mkdir(worktreePath, { recursive: true });
			await Bun.write(join(worktreePath, "AGENTS.md"), overlay.content);
		}

		// Always deploy OpenCode guard plugin.
		const pluginDir = join(worktreePath, ".opencode", "plugins");
		await mkdir(pluginDir, { recursive: true });
		await Bun.write(join(pluginDir, "overstory-guard.ts"), generateOpenCodeGuardPlugin(hooks));

		// Always deploy OpenCode permission config (defense-in-depth).
		const permissionConfig = generateOpenCodePermissionConfig(hooks.capability);
		await Bun.write(
			join(worktreePath, "opencode.json"),
			`${JSON.stringify(permissionConfig, null, "\t")}\n`,
		);
	}

	/**
	 * OpenCode does not require beacon verification/resend.
	 *
	 * OpenCode's TUI renders a clean "Ask anything..." prompt area when ready
	 * and does not exhibit Claude Code's Enter-swallowing behavior during late
	 * initialization. Verified against OpenCode v1.2.27 in tmux.
	 */
	requiresBeaconVerification(): boolean {
		return false;
	}

	/**
	 * Detect OpenCode TUI readiness from a tmux pane content snapshot.
	 *
	 * Verified against OpenCode v1.2.27 tmux captures:
	 * - Loading state: completely blank pane (first ~2 seconds)
	 * - Ready state: ASCII art "OPENCODE" banner + "Ask anything..." prompt +
	 *   status bar with version number (e.g. "1.2.27") at the bottom
	 *
	 * Detection requires BOTH:
	 * 1. "Ask anything" text (the prompt placeholder, present when TUI is interactive)
	 * 2. A version number pattern (X.Y.Z) in the status bar
	 *
	 * OpenCode has no trust dialog phase — no dialog detection needed.
	 *
	 * @param paneContent - Captured tmux pane content to analyze
	 * @returns Current readiness phase (never "dialog" for OpenCode)
	 */
	detectReady(paneContent: string): ReadyState {
		// "Ask anything" appears in the prompt area when the TUI is fully rendered.
		const hasAskPrompt = paneContent.includes("Ask anything");

		// Version number (e.g. "1.2.27") appears in the bottom status bar.
		const hasVersion = /\d+\.\d+\.\d+/.test(paneContent);

		if (hasAskPrompt && hasVersion) {
			return { phase: "ready" };
		}
		return { phase: "loading" };
	}

	/**
	 * Parse an OpenCode session transcript into normalized token usage.
	 *
	 * OpenCode's `opencode run --format json` emits nd-JSON events to stdout.
	 * Token data lives in `step_finish` events under `part.tokens`:
	 *
	 * ```json
	 * {"type":"step_finish","part":{"type":"step-finish","tokens":{
	 *   "total":23838,"input":2,"output":6,"reasoning":0,
	 *   "cache":{"read":23494,"write":336}
	 * }}}
	 * ```
	 *
	 * Input tokens = tokens.input + tokens.cache.read (following Pi convention).
	 * Output tokens = tokens.output.
	 *
	 * Note: OpenCode stores session data in SQLite (~/.local/share/opencode/opencode.db),
	 * not JSONL files. This parser handles nd-JSON captured from stdout by Overstory's
	 * event tailer during headless `opencode run` invocations.
	 *
	 * Verified against OpenCode v1.2.27 output format.
	 *
	 * @param path - Path to nd-JSON transcript file (captured stdout from opencode run)
	 * @returns Aggregated token usage, or null if file doesn't exist
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

				// Token usage from step_finish events.
				// OpenCode v1.2.27 format: part.tokens.input / part.tokens.output / part.tokens.cache.read
				if (entry.type === "step_finish") {
					const part = entry.part as Record<string, unknown> | undefined;
					const tokens = part?.tokens as Record<string, unknown> | undefined;
					if (tokens) {
						if (typeof tokens.input === "number") {
							inputTokens += tokens.input;
						}
						if (typeof tokens.output === "number") {
							outputTokens += tokens.output;
						}
						// Count cache reads toward input tokens (following Pi convention).
						const cache = tokens.cache as Record<string, unknown> | undefined;
						if (typeof cache?.read === "number") {
							inputTokens += cache.read;
						}
					}
				}

				// Model may appear in tool_use events or at the session level.
				// OpenCode does not emit explicit model_change events in nd-JSON,
				// but the model may be embedded in session metadata.
				if (typeof entry.model === "string" && entry.model) {
					model = entry.model;
				}
			}

			return { inputTokens, outputTokens, model };
		} catch {
			return null;
		}
	}

	/**
	 * Return the base data directory for OpenCode sessions.
	 *
	 * OpenCode stores all data in SQLite at `~/.local/share/opencode/opencode.db`.
	 * Unlike runtimes that use per-session JSONL files, OpenCode's session data
	 * is in a single database. This returns the parent directory for discovery.
	 *
	 * For transcript data from headless `opencode run --format json` invocations,
	 * Overstory's event tailer captures stdout to `.overstory/logs/`.
	 *
	 * Verified against OpenCode v1.2.27 on macOS.
	 *
	 * @param _projectRoot - Absolute path to the project root (unused — OpenCode uses a global DB)
	 * @returns Absolute path to the OpenCode data directory, or null if HOME is unset
	 */
	getTranscriptDir(_projectRoot: string): string | null {
		const home = process.env.HOME ?? process.env.USERPROFILE;
		if (!home) return null;
		return join(home, ".local", "share", "opencode");
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
}

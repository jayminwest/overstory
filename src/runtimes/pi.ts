// Pi runtime adapter for overstory's AgentRuntime interface.
// Implements the AgentRuntime contract for the `pi` CLI (Mario Zechner's Pi coding agent).

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { PiRuntimeConfig, ResolvedModel } from "../types.ts";
import { tailReadLines } from "../watchdog/swap.ts";
import { generatePiGuardExtension } from "./pi-guards.ts";
import type {
	AgentRuntime,
	HooksDef,
	OverlayContent,
	ReadyState,
	SpawnOpts,
	TranscriptSummary,
} from "./types.ts";

/** Default Pi runtime config used when no config is provided. */
const DEFAULT_PI_CONFIG: PiRuntimeConfig = {
	provider: "anthropic",
	modelMap: {
		opus: "anthropic/claude-opus-4-6",
		sonnet: "anthropic/claude-sonnet-4-6",
		haiku: "anthropic/claude-haiku-4-5",
	},
};

/**
 * Pi runtime adapter.
 *
 * Implements AgentRuntime for the `pi` CLI (Mario Zechner's Pi coding agent).
 * Security is enforced via Pi guard extensions rather than permission-mode flags —
 * Pi has no --permission-mode equivalent.
 */
export class PiRuntime implements AgentRuntime {
	/** Unique identifier for this runtime. */
	readonly id = "pi";

	/** Relative path to the instruction file within a worktree. Pi reads .claude/CLAUDE.md natively. */
	readonly instructionPath = ".claude/CLAUDE.md";

	private readonly config: PiRuntimeConfig;

	constructor(config?: PiRuntimeConfig) {
		this.config = config ?? DEFAULT_PI_CONFIG;
	}

	/**
	 * Expand a model alias to a provider-qualified model ID.
	 *
	 * 1. If model contains "/" → already qualified, pass through
	 * 2. If model is in modelMap → return the mapped value
	 * 3. Otherwise → return `${provider}/${model}`
	 */
	expandModel(model: string): string {
		if (model.includes("/")) return model;
		const mapped = this.config.modelMap[model];
		if (mapped) return mapped;
		return `${this.config.provider}/${model}`;
	}

	/**
	 * Build the shell command string to spawn an interactive Pi agent.
	 *
	 * Maps SpawnOpts to the `pi` CLI flags:
	 * - `model` → `--model <model>`
	 * - `permissionMode` is accepted but NOT mapped — Pi has no permission-mode flag.
	 *   Security is enforced via guard extensions deployed by deployConfig().
	 * - `appendSystemPrompt` → `--append-system-prompt '<escaped>'` (POSIX single-quote escaping)
	 *
	 * The `cwd` and `env` fields are handled by the tmux session creator, not embedded here.
	 *
	 * @param opts - Spawn options (model, appendSystemPrompt; permissionMode is ignored)
	 * @returns Shell command string suitable for tmux new-session -c
	 */
	buildSpawnCommand(opts: SpawnOpts): string {
		let cmd = `pi --model ${this.expandModel(opts.model)}`;

		if (opts.appendSystemPromptFile) {
			// Read from file at shell expansion time — avoids tmux command length limits.
			const escaped = opts.appendSystemPromptFile.replace(/'/g, "'\\''");
			cmd += ` --append-system-prompt "$(cat '${escaped}')"`;
		} else if (opts.appendSystemPrompt) {
			// POSIX single-quote escape: end quote, backslash-quote, start quote.
			const escaped = opts.appendSystemPrompt.replace(/'/g, "'\\''");
			cmd += ` --append-system-prompt '${escaped}'`;
		}

		return cmd;
	}

	/**
	 * Build the argv array for a headless one-shot Pi invocation.
	 *
	 * Returns an argv array suitable for `Bun.spawn()`. The `--print` flag causes Pi
	 * to run the prompt and exit. Unlike Claude Code, the prompt is a positional argument
	 * (last), not passed via `-p`.
	 *
	 * @param prompt - The prompt to pass as a positional argument
	 * @param model - Optional model override
	 * @returns Argv array for Bun.spawn
	 */
	buildPrintCommand(prompt: string, model?: string): string[] {
		const cmd = ["pi", "--print"];
		if (model !== undefined) {
			cmd.push("--model", this.expandModel(model));
		}
		cmd.push(prompt);
		return cmd;
	}

	/**
	 * Deploy per-agent instructions and guards to a worktree.
	 *
	 * Writes up to three files:
	 * 1. `.claude/CLAUDE.md` — agent's task-specific overlay. Skipped when overlay is undefined.
	 * 2. `.pi/extensions/overstory-guard.ts` — Pi guard extension (always deployed).
	 * 3. `.pi/settings.json` — Pi settings enabling the extensions directory (always deployed).
	 *
	 * @param worktreePath - Absolute path to the agent's git worktree
	 * @param overlay - Overlay content to write as CLAUDE.md, or undefined for guard-only deployment
	 * @param hooks - Agent identity, capability, worktree path, and optional quality gates
	 */
	async deployConfig(
		worktreePath: string,
		overlay: OverlayContent | undefined,
		hooks: HooksDef,
	): Promise<void> {
		if (overlay) {
			const claudeDir = join(worktreePath, ".claude");
			await mkdir(claudeDir, { recursive: true });
			await Bun.write(join(claudeDir, "CLAUDE.md"), overlay.content);
		}

		// Always deploy Pi guard extension.
		const piExtDir = join(worktreePath, ".pi", "extensions");
		await mkdir(piExtDir, { recursive: true });
		await Bun.write(join(piExtDir, "overstory-guard.ts"), generatePiGuardExtension(hooks));

		// Always deploy Pi settings pointing at the extensions directory.
		const piDir = join(worktreePath, ".pi");
		const settings = { extensions: ["./extensions"] };
		await Bun.write(join(piDir, "settings.json"), `${JSON.stringify(settings, null, "\t")}\n`);
	}

	/**
	 * Pi does not require beacon verification/resend.
	 *
	 * Claude Code's TUI sometimes swallows Enter during late initialization, so the
	 * orchestrator resends the beacon until the pane leaves the "idle" state. Pi's TUI
	 * does not have this issue AND its idle vs. processing states are indistinguishable
	 * via detectReady (the header "pi v..." and status bar token counter are visible in
	 * both states). Enabling the resend loop would spam Pi with duplicate beacon messages.
	 */
	requiresBeaconVerification(): boolean {
		return false;
	}

	/**
	 * Detect Pi TUI readiness from a tmux pane content snapshot.
	 *
	 * Pi shows a header containing "pi" and "model:" when the TUI has fully rendered.
	 * Pi has no trust dialog phase.
	 *
	 * @param paneContent - Captured tmux pane content to analyze
	 * @returns Current readiness phase
	 */
	detectReady(paneContent: string): ReadyState {
		// Pi's TUI shows "pi v<version>" in the header and a status bar with
		// a token usage indicator like "0.0%/200k" when fully rendered.
		// Earlier detection checked for "model:" which Pi's TUI never contains.
		const hasHeader = paneContent.includes("pi v");
		const hasStatusBar = /\d+\.\d+%\/\d+k/.test(paneContent);
		if (hasHeader && hasStatusBar) {
			return { phase: "ready" };
		}
		return { phase: "loading" };
	}

	/**
	 * Parse a Pi transcript JSONL file into normalized token usage.
	 *
	 * Pi JSONL format (version 3):
	 * - Session metadata: `{ type: "session", version: 3, id, cwd }`
	 * - Model identity: `{ type: "model_change", provider, modelId }`
	 * - Token usage: on `{ type: "message" }` events where `message.role === "assistant"`,
	 *   nested under `message.usage`: `{ input, output, cacheRead, cacheWrite, totalTokens, cost }`
	 * - Cost data: `message.usage.cost.total` (USD)
	 *
	 * Returns null if the file does not exist or cannot be parsed.
	 *
	 * @param path - Absolute path to the Pi transcript JSONL file
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
					// Skip malformed lines — Pi transcripts may have partial writes.
					continue;
				}

				// Model identity from model_change events.
				if (entry.type === "model_change") {
					if (typeof entry.modelId === "string") {
						model = entry.modelId;
					} else if (typeof entry.model === "string") {
						model = entry.model;
					}
				}

				// Token usage from assistant message events.
				// Pi v3 format: message.usage.input / message.usage.output
				if (entry.type === "message") {
					const msg = entry.message as Record<string, unknown> | undefined;
					if (msg?.role === "assistant") {
						const usage = msg.usage as Record<string, unknown> | undefined;
						if (usage) {
							if (typeof usage.input === "number") {
								inputTokens += usage.input;
							}
							if (typeof usage.output === "number") {
								outputTokens += usage.output;
							}
							// Also count cache tokens toward input for compatibility.
							if (typeof usage.cacheRead === "number") {
								inputTokens += usage.cacheRead;
							}
						}

						// Capture model from message if model_change was missed.
						if (typeof msg.model === "string" && model === "") {
							model = msg.model;
						}
					}
				}

				// Fallback: message_end events (older Pi versions).
				if (entry.type === "message_end") {
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
	 * Returns the provider environment variables from the resolved model, or an empty
	 * object if none are set.
	 *
	 * @param model - Resolved model with optional provider env vars
	 * @returns Environment variable map (may be empty)
	 */
	buildEnv(model: ResolvedModel): Record<string, string> {
		return model.env ?? {};
	}

	/**
	 * Return the directory containing Pi session transcript files.
	 *
	 * Pi stores JSONL transcripts in `~/.pi/agent/sessions/{encoded-project-path}/`.
	 * The project path is encoded by replacing path separators with `--` and
	 * prefixing/suffixing with `--`.
	 *
	 * Example: `/home/user/project` → `~/.pi/agent/sessions/--home-user-project--/`
	 *
	 * @param projectRoot - Absolute path to the project root
	 * @returns Absolute path to the transcript directory
	 */
	getTranscriptDir(projectRoot: string): string | null {
		const home = process.env.HOME ?? process.env.USERPROFILE;
		if (!home) return null;

		// Pi encodes the project path: replace separators with dashes, wrap with --
		const encoded = `--${projectRoot.replace(/[\\/]/g, "-").replace(/:/g, "")}--`;
		return join(home, ".pi", "agent", "sessions", encoded);
	}

	/**
	 * Extract recent conversation from Pi JSONL transcript.
	 * Pi format: type=message, message.role=user|assistant, message.content=string|array.
	 * Uses tail-read (last 100KB) for performance.
	 */
	async extractConversation(
		worktreePath: string,
		sessionId: string,
		maxTurns: number,
	): Promise<string> {
		const transcriptDir = this.getTranscriptDir(worktreePath);
		if (!transcriptDir) return "";
		const jsonlPath = join(transcriptDir, `${sessionId}.jsonl`);

		const lines = await tailReadLines(jsonlPath);
		if (lines.length === 0) return "";

		const turns: Array<{ type: string; content: string }> = [];
		for (const line of lines) {
			try {
				const obj = JSON.parse(line) as Record<string, unknown>;
				if (obj.type !== "message") continue;

				const msg = obj.message as Record<string, unknown> | undefined;
				if (!msg) continue;

				const role = msg.role as string | undefined;
				if (role !== "user" && role !== "assistant") continue;

				const c = msg.content;
				let content = "";
				if (typeof c === "string") {
					content = c;
				} else if (Array.isArray(c)) {
					for (const block of c as Array<Record<string, unknown>>) {
						if (block.type === "text" && typeof block.text === "string") {
							content += `${block.text}\n`;
						} else if (block.type === "tool_use") {
							content += `[Tool: ${block.name}]\n`;
						}
					}
				}

				if (content.trim()) {
					turns.push({ type: role, content: content.trim() });
				}
			} catch {
				// Skip malformed lines
			}
		}

		const recent = turns.slice(-maxTurns * 2);
		if (recent.length === 0) return "";

		let md = "";
		for (const turn of recent) {
			const label = turn.type === "user" ? "User" : "Assistant";
			md += `### ${label}\n${turn.content}\n\n`;
		}
		return md.trim();
	}
}

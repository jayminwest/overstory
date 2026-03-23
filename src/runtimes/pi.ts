// Pi runtime adapter for overstory's AgentRuntime interface.
// Implements the AgentRuntime contract for the `pi` CLI (Mario Zechner's Pi coding agent).

import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { PiRuntimeConfig, ResolvedModel } from "../types.ts";
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

const PI_READY_MARKER_PREFIX = "\u2713 os-eco";
const PI_EXTENSION_SOURCE = "https://github.com/RogerNavelsaker/pi-os-eco";
const OVERSTORY_WORKTREE_RE = /^(.*?)(?:[\\/]\.overstory[\\/]worktrees[\\/].*)$/;

interface PiCommandResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

type PiCommandRunner = (args: string[], cwd: string) => Promise<PiCommandResult>;

interface PiRuntimeDeps {
	runPiCommand?: PiCommandRunner;
}

const defaultRunPiCommand: PiCommandRunner = async (args, cwd) => {
	try {
		const proc = Bun.spawn(["pi", ...args], {
			cwd,
			stdout: "pipe",
			stderr: "pipe",
		});
		const exitCode = await proc.exited;
		const stdout = await new Response(proc.stdout).text();
		const stderr = await new Response(proc.stderr).text();
		return { exitCode, stdout, stderr };
	} catch (error) {
		return {
			exitCode: 1,
			stdout: "",
			stderr: error instanceof Error ? error.message : String(error),
		};
	}
};

function inferProjectRoot(worktreePath: string): string {
	return worktreePath.match(OVERSTORY_WORKTREE_RE)?.[1] ?? worktreePath;
}

function isPathLikePiSource(source: string): boolean {
	return (
		source.startsWith(".") ||
		source.startsWith("/") ||
		/^[A-Za-z]:[\\/]/.test(source)
	);
}

function normalizePiSource(source: string, projectRoot: string): string {
	return isPathLikePiSource(source) ? resolve(projectRoot, source) : source;
}

async function hasConfiguredPiExtension(projectRoot: string, source: string): Promise<boolean> {
	const settingsFile = Bun.file(join(projectRoot, ".pi", "settings.json"));
	if (!(await settingsFile.exists())) return false;

	try {
		const parsed = JSON.parse(await settingsFile.text()) as { packages?: unknown };
		const packages = Array.isArray(parsed.packages)
			? parsed.packages.filter((value): value is string => typeof value === "string")
			: [];
		const normalizedSource = normalizePiSource(source, projectRoot);
		return packages.some((pkg) => normalizePiSource(pkg, projectRoot) === normalizedSource);
	} catch {
		return false;
	}
}

/**
 * Pi runtime adapter.
 *
 * Implements AgentRuntime for the `pi` CLI (Mario Zechner's Pi coding agent).
 * Pi has no --permission-mode flag. Session-scoped policy and readiness are
 * enforced by the companion os-eco Pi extension package instead.
 */
export class PiRuntime implements AgentRuntime {
	/** Unique identifier for this runtime. */
	readonly id = "pi";

	/** Stability level. Pi adapter is experimental — not fully validated. */
	readonly stability = "experimental" as const;

	/** Relative path to the instruction file within a worktree. Pi reads .claude/CLAUDE.md natively. */
	readonly instructionPath = ".claude/CLAUDE.md";

	private readonly config: PiRuntimeConfig;
	private readonly runPiCommand: PiCommandRunner;

	constructor(config?: PiRuntimeConfig, deps?: PiRuntimeDeps) {
		this.config = config ?? DEFAULT_PI_CONFIG;
		this.runPiCommand = deps?.runPiCommand ?? defaultRunPiCommand;
	}

	private async syncProjectPiExtension(projectRoot: string): Promise<void> {
		const commandArgs = (await hasConfiguredPiExtension(projectRoot, PI_EXTENSION_SOURCE))
			? ["update", PI_EXTENSION_SOURCE]
			: ["install", PI_EXTENSION_SOURCE, "-l"];
		const result = await this.runPiCommand(commandArgs, projectRoot);
		if (result.exitCode === 0) return;

		const action = commandArgs[0] ?? "sync";
		const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`;
		throw new Error(`Pi extension ${action} failed: ${detail}`);
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
	 * Deploy per-agent instructions to a worktree.
	 *
	 * Pi session policy and readiness signaling now live in the external
	 * os-eco Pi extension package. Overstory only writes the task-specific
	 * overlay file here.
	 *
	 * @param worktreePath - Absolute path to the agent's git worktree
	 * @param overlay - Overlay content to write as CLAUDE.md, or undefined to skip instruction output
	 * @param _hooks - Reserved for interface compatibility; Pi policy now lives in the extension package
	 */
	async deployConfig(
		worktreePath: string,
		overlay: OverlayContent | undefined,
		_hooks: HooksDef,
	): Promise<void> {
		await this.syncProjectPiExtension(inferProjectRoot(worktreePath));

		if (overlay) {
			const claudeDir = join(worktreePath, ".claude");
			await mkdir(claudeDir, { recursive: true });
			await Bun.write(join(claudeDir, "CLAUDE.md"), overlay.content);
		}
	}

	/**
	 * Pi does not require beacon verification/resend.
	 *
	 * Claude Code's TUI sometimes swallows Enter during late initialization, so the
	 * orchestrator resends the beacon until the pane leaves the "idle" state. Pi uses
	 * an explicit ready marker emitted by the companion extension package, so it does
	 * not need the resend loop either.
	 */
	requiresBeaconVerification(): boolean {
		return false;
	}

	/**
	 * Detect Pi readiness from the explicit extension-owned ready marker.
	 *
	 * The marker is rendered into the Pi UI by the os-eco Pi extension only when the
	 * managed session is ready for work:
	 *   ✓ os-eco agent=<name> runtime=pi
	 *
	 * @param paneContent - Captured tmux pane content to analyze
	 * @returns Current readiness phase
	 */
	detectReady(paneContent: string): ReadyState {
		if (paneContent.includes(PI_READY_MARKER_PREFIX) && paneContent.includes("runtime=pi")) {
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
}

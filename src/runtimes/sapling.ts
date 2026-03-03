// Sapling runtime adapter for overstory's AgentRuntime interface.
// Implements the AgentRuntime contract for the `sp` CLI (Sapling headless coding agent).
//
// Key characteristics:
// - Headless: Sapling runs as a Bun subprocess (no tmux TUI)
// - Instruction file: SAPLING.md (auto-read from worktree root)
// - Communication: JSON-RPC over stdin/stdout (--mode rpc)
// - Guards: .sapling/guards.json (stub for Wave 3 guard deployment)
// - Events: NDJSON stream on stdout (parsed for token usage and agent events)

import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ResolvedModel } from "../types.ts";
import type {
	AgentEvent,
	AgentRuntime,
	DirectSpawnOpts,
	HooksDef,
	OverlayContent,
	ReadyState,
	SpawnOpts,
	TranscriptSummary,
} from "./types.ts";

/**
 * Sapling runtime adapter.
 *
 * Implements AgentRuntime for the `sp` CLI (Sapling headless coding agent).
 * Sapling workers run as headless Bun subprocesses — they communicate via
 * JSON-RPC on stdin/stdout rather than a TUI in a tmux pane. This means
 * all tmux lifecycle methods (buildSpawnCommand, detectReady, requiresBeaconVerification)
 * are stubs: the orchestrator checks `runtime.headless === true` and takes the
 * direct-spawn code path instead.
 *
 * Instructions are delivered via `SAPLING.md` in the worktree root.
 * Guard configuration is written to `.sapling/guards.json` (stub for Wave 3).
 *
 * Hardware impact: Sapling workers use 60–120 MB RAM vs 250–400 MB for TUI agents,
 * enabling 4–6× more concurrent workers on a typical developer machine.
 */
export class SaplingRuntime implements AgentRuntime {
	/** Unique identifier for this runtime. */
	readonly id = "sapling";

	/** Relative path to the instruction file within a worktree. */
	readonly instructionPath = "SAPLING.md";

	/**
	 * Whether this runtime is headless (no tmux, direct subprocess).
	 * Headless runtimes bypass all tmux session management and use Bun.spawn directly.
	 */
	readonly headless = true;

	/**
	 * Build the shell command string to spawn a Sapling agent in a tmux pane.
	 *
	 * This method exists for the TUI fallback path (e.g., `ov sling --runtime sapling`
	 * on a host that has tmux). Under normal operation, Sapling is headless and
	 * buildDirectSpawn() is used instead.
	 *
	 * Maps SpawnOpts to `sp run` flags:
	 * - `model` → `--model <model>`
	 * - `appendSystemPromptFile` → prepended via `$(cat ...)` shell expansion
	 * - `appendSystemPrompt` → appended inline
	 * - `permissionMode` is accepted but NOT mapped — Sapling enforces security
	 *   via .sapling/guards.json rather than permission flags.
	 *
	 * @param opts - Spawn options (model, appendSystemPrompt; permissionMode ignored)
	 * @returns Shell command string suitable for tmux new-session -c
	 */
	buildSpawnCommand(opts: SpawnOpts): string {
		let cmd = `sp run --model ${opts.model} --mode rpc`;

		if (opts.appendSystemPromptFile) {
			// Read role definition from file at shell expansion time — avoids tmux
			// IPC message size limits. Append the "read SAPLING.md" instruction.
			const escaped = opts.appendSystemPromptFile.replace(/'/g, "'\\''");
			cmd += ` "$(cat '${escaped}')"' Read SAPLING.md for your task assignment and begin immediately.'`;
		} else if (opts.appendSystemPrompt) {
			// Inline role definition + instruction to read SAPLING.md.
			const prompt = `${opts.appendSystemPrompt}\n\nRead SAPLING.md for your task assignment and begin immediately.`;
			const escaped = prompt.replace(/'/g, "'\\''");
			cmd += ` '${escaped}'`;
		} else {
			cmd += ` 'Read SAPLING.md for your task assignment and begin immediately.'`;
		}

		return cmd;
	}

	/**
	 * Build the argv array for a headless one-shot Sapling invocation.
	 *
	 * Returns an argv array suitable for `Bun.spawn()`. The `sp print` subcommand
	 * processes a prompt and exits, printing the result to stdout.
	 *
	 * Used by merge/resolver.ts (AI-assisted conflict resolution) and
	 * watchdog/triage.ts (AI-assisted failure classification).
	 *
	 * @param prompt - The prompt to pass as the argument
	 * @param model - Optional model override
	 * @returns Argv array for Bun.spawn
	 */
	buildPrintCommand(prompt: string, model?: string): string[] {
		const cmd = ["sp", "print"];
		if (model !== undefined) {
			cmd.push("--model", model);
		}
		cmd.push(prompt);
		return cmd;
	}

	/**
	 * Build the argv array for Bun.spawn() to launch a Sapling agent subprocess.
	 *
	 * Returns an argv array that starts the Sapling agent in RPC mode. The agent
	 * reads its instructions from the file at `opts.instructionPath`, processes
	 * the task, emits NDJSON events on stdout, and exits on completion.
	 *
	 * @param opts - Direct spawn options (cwd, env, model, instructionPath)
	 * @returns Argv array for Bun.spawn — do not shell-interpolate
	 */
	buildDirectSpawn(opts: DirectSpawnOpts): string[] {
		return [
			"sp",
			"run",
			"--model",
			opts.model,
			"--mode",
			"rpc",
			"--cwd",
			opts.cwd,
			"--instructions",
			opts.instructionPath,
		];
	}

	/**
	 * Deploy per-agent instructions and guard stubs to a worktree.
	 *
	 * Writes the overlay content to `SAPLING.md` in the worktree root.
	 * Also writes `.sapling/guards.json` with an empty guards array as a
	 * stub for Wave 3 guard deployment (full guard implementation is out of scope).
	 *
	 * When overlay is undefined (hooks-only deployment for coordinator/supervisor/monitor),
	 * this is a no-op since Sapling has no hook system to deploy.
	 *
	 * @param worktreePath - Absolute path to the agent's git worktree
	 * @param overlay - Overlay content to write as SAPLING.md, or undefined for no-op
	 * @param _hooks - Hook definition (unused — Sapling uses .sapling/guards.json)
	 */
	async deployConfig(
		worktreePath: string,
		overlay: OverlayContent | undefined,
		_hooks: HooksDef,
	): Promise<void> {
		if (!overlay) return;

		// Write SAPLING.md instruction file.
		const saplingPath = join(worktreePath, this.instructionPath);
		await mkdir(dirname(saplingPath), { recursive: true });
		await Bun.write(saplingPath, overlay.content);

		// Write .sapling/guards.json stub (Wave 3 will populate with real guards).
		const guardsPath = join(worktreePath, ".sapling", "guards.json");
		await mkdir(dirname(guardsPath), { recursive: true });
		await Bun.write(guardsPath, `${JSON.stringify({ guards: [] }, null, 2)}\n`);
	}

	/**
	 * Sapling is headless — always ready.
	 *
	 * Sapling runs as a direct subprocess that emits a `{"type":"ready"}` event
	 * on stdout when initialization completes. Tmux-based readiness detection
	 * is never used for Sapling workers.
	 *
	 * @param _paneContent - Captured tmux pane content (unused)
	 * @returns Always `{ phase: "ready" }`
	 */
	detectReady(_paneContent: string): ReadyState {
		return { phase: "ready" };
	}

	/**
	 * Sapling does not require beacon verification/resend.
	 *
	 * The beacon verification loop exists because Claude Code's TUI sometimes
	 * swallows the initial Enter during late initialization. Sapling is headless —
	 * it communicates via stdin/stdout with no TUI startup delay.
	 */
	requiresBeaconVerification(): boolean {
		return false;
	}

	/**
	 * Parse a Sapling NDJSON transcript file into normalized token usage.
	 *
	 * Sapling emits NDJSON events on stdout during execution. The transcript
	 * file records these events. Token usage is extracted from events that
	 * carry a `usage` object with `input_tokens` and/or `output_tokens` fields.
	 * Model identity is extracted from any event that carries a `model` field.
	 *
	 * Returns null if the file does not exist or cannot be parsed.
	 *
	 * @param path - Absolute path to the Sapling NDJSON transcript file
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

				// Extract token usage from any event carrying a usage object.
				if (typeof event.usage === "object" && event.usage !== null) {
					const usage = event.usage as Record<string, unknown>;
					if (typeof usage.input_tokens === "number") {
						inputTokens += usage.input_tokens;
					}
					if (typeof usage.output_tokens === "number") {
						outputTokens += usage.output_tokens;
					}
				}

				// Capture model from any event that carries it.
				if (typeof event.model === "string" && event.model && !model) {
					model = event.model;
				}
			}

			return { inputTokens, outputTokens, model };
		} catch {
			return null;
		}
	}

	/**
	 * Parse NDJSON stdout from a Sapling agent subprocess into typed AgentEvent objects.
	 *
	 * Reads the ReadableStream from Bun.spawn() stdout, buffers partial lines,
	 * and yields a typed AgentEvent for each complete JSON line. Malformed lines
	 * (partial writes, non-JSON output) are silently skipped.
	 *
	 * The NDJSON format mirrors Pi's `--mode json` output so `ov feed`, `ov trace`,
	 * and `ov costs` work without runtime-specific parsing.
	 *
	 * @param stream - ReadableStream<Uint8Array> from Bun.spawn stdout
	 * @yields Parsed AgentEvent objects in emission order
	 */
	async *parseEvents(stream: ReadableStream<Uint8Array>): AsyncIterable<AgentEvent> {
		const reader = stream.getReader();
		const decoder = new TextDecoder();
		let buffer = "";

		try {
			while (true) {
				const result = await reader.read();
				if (result.done) break;

				buffer += decoder.decode(result.value, { stream: true });

				// Split on newlines, keeping the remainder in the buffer.
				const lines = buffer.split("\n");
				// The last element is either empty or an incomplete line.
				buffer = lines.pop() ?? "";

				for (const line of lines) {
					const trimmed = line.trim();
					if (!trimmed) continue;

					try {
						const event = JSON.parse(trimmed) as AgentEvent;
						yield event;
					} catch {
						// Skip malformed lines — partial writes or debug output.
					}
				}
			}

			// Flush any remaining buffer content after stream ends.
			const remaining = buffer.trim();
			if (remaining) {
				try {
					const event = JSON.parse(remaining) as AgentEvent;
					yield event;
				} catch {
					// Skip malformed trailing line.
				}
			}
		} finally {
			reader.releaseLock();
		}
	}

	/**
	 * Build runtime-specific environment variables for model/provider routing.
	 *
	 * Returns the provider environment variables from the resolved model.
	 * For Sapling native: may include SAPLING_API_KEY or provider-specific vars.
	 * For gateway providers: may include gateway-specific auth and routing vars.
	 *
	 * @param model - Resolved model with optional provider env vars
	 * @returns Environment variable map (may be empty)
	 */
	buildEnv(model: ResolvedModel): Record<string, string> {
		return model.env ?? {};
	}
}

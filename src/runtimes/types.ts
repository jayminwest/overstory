// Runtime abstraction types for multi-provider agent support.
// See docs/runtime-abstraction.md for design rationale and coupling inventory.

import type { QualityGate, ResolvedModel } from "../types.ts";

// === Spawn ===

/** Options for spawning an interactive agent process. */
export interface SpawnOpts {
	/** Model ref (alias or provider-qualified, e.g. "sonnet" or "openrouter/gpt-5"). */
	model: string;
	/** Permission mode: bypass for trusted builders, ask for interactive agents. */
	permissionMode: "bypass" | "ask";
	/** Optional system prompt prefix injected before the agent's base instructions. */
	systemPrompt?: string;
	/** Optional system prompt suffix appended after the base instructions. */
	appendSystemPrompt?: string;
	/** Path to a file whose contents are appended as system prompt (avoids tmux command length limits). */
	appendSystemPromptFile?: string;
	/** Working directory for the spawned process. */
	cwd: string;
	/** Additional environment variables to pass to the spawned process. */
	env: Record<string, string>;
	/** Resume an existing session by ID instead of starting fresh (Claude Code --resume). */
	resumeSessionId?: string;
}

// === Readiness ===

/**
 * Discrete phases of agent TUI readiness, detected from tmux pane content.
 * Headless runtimes (codex exec, pi --mode rpc) always return { phase: "ready" }.
 */
export type ReadyState =
	| { phase: "loading" }
	| { phase: "dialog"; action: string }
	| { phase: "ready" };

// === Config Deployment ===

/** Runtime-agnostic overlay content to write into a worktree. */
export interface OverlayContent {
	/** Full markdown text to write as the agent's instruction file. */
	content: string;
}

/**
 * Runtime-agnostic hook/guard configuration for deployment to a worktree.
 * Each runtime adapter translates this into its native guard mechanism
 * (e.g., settings.local.json hooks for Claude Code, guard extensions for Pi).
 */
export interface HooksDef {
	/** Agent name injected into hook commands. */
	agentName: string;
	/** Agent capability (builder, scout, reviewer, lead, etc.). */
	capability: string;
	/** Absolute path to the agent's worktree for path-boundary enforcement. */
	worktreePath: string;
	/** Quality gates agents must pass before reporting completion. */
	qualityGates?: QualityGate[];
}

// === Transcripts ===

/** Normalized token usage extracted from any runtime's session transcript. */
export interface TranscriptSummary {
	inputTokens: number;
	outputTokens: number;
	/** Model identifier as reported by the runtime (e.g. "claude-sonnet-4-6"). */
	model: string;
}

// === RPC Connection ===

/**
 * Reported state of a connected agent process.
 * Used by RuntimeConnection.getState() to poll agent activity without tmux.
 */
export type ConnectionState = {
	status: "idle" | "working" | "error";
	/** Tool currently executing, if status is "working". */
	currentTool?: string;
};

/**
 * Handle to spawned agent process I/O streams for RPC communication.
 * Compatible with Bun.spawn output when configured with stdin/stdout pipe.
 */
export interface RpcProcessHandle {
	readonly stdin: {
		write(data: string | Uint8Array): number | Promise<number>;
	};
	readonly stdout: ReadableStream<Uint8Array>;
}

/**
 * Lifecycle interface for runtimes supporting direct RPC.
 * When AgentRuntime.connect() exists, the orchestrator bypasses tmux for
 * mail delivery (followUp), shutdown (abort), and health checks (getState).
 * Pi implements via JSON-RPC 2.0 over stdin/stdout.
 */
export interface RuntimeConnection {
	/** Send initial prompt after spawn. */
	sendPrompt(text: string): Promise<void>;
	/** Send follow-up message — replaces tmux send-keys. */
	followUp(text: string): Promise<void>;
	/** Clean shutdown — replaces SIGTERM. */
	abort(): Promise<void>;
	/** Query current state — replaces tmux capture-pane. */
	getState(): Promise<ConnectionState>;
	/** Release connection resources. */
	close(): void;
}

// === Headless Spawn ===

/** Options for spawning a headless (non-tmux) agent subprocess directly. */
export interface DirectSpawnOpts {
	/** Working directory for the spawned process. */
	cwd: string;
	/** Environment variables for the subprocess. */
	env: Record<string, string>;
	/** Model ref (alias or provider-qualified). When undefined, the runtime omits --model and lets the agent use its own config. */
	model?: string;
	/** Path to the instruction/overlay file for this agent. */
	instructionPath: string;
}

/** Structured event emitted by a headless agent on stdout (NDJSON). */
export interface AgentEvent {
	/** Event type (e.g. 'tool_start', 'tool_end', 'result', 'error', 'ready'). */
	type: string;
	/** ISO 8601 timestamp. */
	timestamp: string;
	/** Event-specific payload. */
	[key: string]: unknown;
}

/** Result of rate limit detection from agent TUI output. */
export type RateLimitState =
	| { limited: false }
	| { limited: true; resumesAt: Date | null; message: string };

// === Runtime Interface ===

/**
 * Contract that all agent runtime adapters must implement.
 *
 * Each runtime (Claude Code, Codex, Pi, OpenCode, ...) provides a ~200-400 line
 * adapter file implementing this interface. The orchestration engine calls only
 * these methods — never the runtime's CLI directly.
 */
export interface AgentRuntime {
	/** Unique runtime identifier (e.g. "claude", "codex", "pi"). */
	id: string;

	/** Relative path to the instruction file within a worktree (e.g. ".claude/CLAUDE.md"). */
	readonly instructionPath: string;

	/** Build the shell command string to spawn an interactive agent in a tmux pane. */
	buildSpawnCommand(opts: SpawnOpts): string;

	/**
	 * Build the argv array for a headless one-shot AI call.
	 * Used by merge/resolver.ts and watchdog/triage.ts for AI-assisted operations.
	 */
	buildPrintCommand(prompt: string, model?: string): string[];

	/**
	 * Deploy per-agent instructions and guards to a worktree.
	 * Claude Code writes .claude/CLAUDE.md + settings.local.json hooks.
	 * Codex writes AGENTS.md (no hook deployment needed).
	 * Pi writes .claude/CLAUDE.md + a guard extension in .pi/extensions/.
	 * When overlay is undefined, only hooks are deployed (no instruction file written).
	 */
	deployConfig(
		worktreePath: string,
		overlay: OverlayContent | undefined,
		hooks: HooksDef,
	): Promise<void>;

	/**
	 * Detect agent readiness from tmux pane content.
	 * Headless runtimes that exit when done should return { phase: "ready" } unconditionally.
	 */
	detectReady(paneContent: string): ReadyState;

	/**
	 * Parse a session transcript file into normalized token usage.
	 * Returns null if the transcript does not exist or cannot be parsed.
	 */
	parseTranscript(path: string): Promise<TranscriptSummary | null>;

	/**
	 * Return the directory containing session transcript files for this runtime,
	 * or null if transcript discovery is not supported.
	 *
	 * @param projectRoot - Absolute path to the project root
	 * @returns Absolute path to the transcript directory, or null
	 */
	getTranscriptDir(projectRoot: string): string | null;

	/**
	 * Build runtime-specific environment variables for model/provider routing.
	 * Claude Code uses ANTHROPIC_API_KEY; Codex uses OPENAI_API_KEY; Pi passes
	 * the provider's authTokenEnv directly.
	 */
	buildEnv(model: ResolvedModel): Record<string, string>;

	/**
	 * Whether this runtime requires the beacon verification/resend loop after initial send.
	 *
	 * Claude Code's TUI sometimes swallows Enter during late initialization, so the
	 * orchestrator resends the beacon if the pane still appears idle (overstory-3271).
	 * Pi's TUI does not exhibit this behavior AND its idle/processing states are
	 * indistinguishable via detectReady (both show the header and status bar), so
	 * the resend loop would spam Pi with duplicate startup messages.
	 *
	 * Runtimes that omit this method (or return true) get the resend loop.
	 * Pi returns false to skip it.
	 */
	requiresBeaconVerification?(): boolean;

	/**
	 * Establish direct RPC connection to running agent process.
	 * Runtimes without RPC (Claude, Codex) omit this method.
	 * Orchestrator checks `if (runtime.connect)` before calling, falls back to tmux when absent.
	 */
	connect?(process: RpcProcessHandle): RuntimeConnection;

	/**
	 * Whether this runtime is headless (no tmux, direct subprocess).
	 * Headless runtimes bypass all tmux session management and use Bun.spawn directly.
	 * Default: false (absent means interactive/tmux-based).
	 */
	readonly headless?: boolean;

	/**
	 * Build the argv array for Bun.spawn() to launch a headless agent subprocess.
	 * Only headless runtimes implement this method.
	 * The returned array is passed directly to Bun.spawn() — no shell interpolation.
	 */
	buildDirectSpawn?(opts: DirectSpawnOpts): string[];

	/**
	 * Parse NDJSON stdout from a headless agent subprocess into typed AgentEvent objects.
	 * Only headless runtimes implement this method.
	 * The caller provides the raw stdout ReadableStream from Bun.spawn().
	 */
	parseEvents?(stream: ReadableStream<Uint8Array>): AsyncIterable<AgentEvent>;

	/**
	 * Detect rate limit state from tmux pane content.
	 * Returns { limited: false } when no rate limit is detected.
	 * Runtimes that omit this method are assumed to never be rate-limited.
	 */
	detectRateLimit?(paneContent: string): RateLimitState;

	/**
	 * Extract recent conversation context from a transcript file for handoff.
	 * Returns markdown-formatted last N turns, or empty string if unavailable.
	 *
	 * Performance: implementations MUST tail-read (last ~100KB), never the full file.
	 * Called only during swap, not on every tick.
	 *
	 * Runtimes that omit this method fall back to tmux pane capture.
	 */
	extractConversation?(worktreePath: string, sessionId: string, maxTurns: number): Promise<string>;
}

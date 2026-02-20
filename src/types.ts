// === Model & Provider Types ===

/** Backward-compatible model alias for Anthropic models. */
export type ModelAlias = "sonnet" | "opus" | "haiku";

/**
 * A model reference: either a simple alias ('sonnet') or a provider-qualified
 * string ('provider/model', e.g. 'openrouter/openai/gpt-5.3').
 */
export type ModelRef = ModelAlias | (string & {});

/** Configuration for a model provider. */
export type ProviderRuntime = "codex" | "claude";

/** Optional environment adaptation for a provider under a specific runtime. */
export interface ProviderAdapter {
	baseUrlEnv?: string;
	authTokenTargetEnv?: string;
	staticEnv?: Record<string, string>;
	commandArgs?: string[];
}

/** Configuration for a model provider. */
export interface ProviderConfig {
	type: "native" | "gateway";
	runtimes: ProviderRuntime[];
	baseUrl?: string;
	authTokenEnv?: string;
	adapters?: Partial<Record<ProviderRuntime, ProviderAdapter>>;
}

/** Primary interactive CLI used for spawned agents. */
export type CliBase = "claude" | "codex";

/** Provider-qualified model profile alias. */
export interface ModelProfile {
	provider: string;
	model: string;
}

// === Project Configuration ===

export interface OverstoryConfig {
	project: {
		name: string;
		root: string; // Absolute path to target repo
		canonicalBranch: string; // "main" | "develop"
	};
	agents: {
		manifestPath: string; // Path to agent-manifest.json
		baseDir: string; // Path to base agent definitions
		maxConcurrent: number; // Rate limit ceiling
		staggerDelayMs: number; // Delay between spawns
		maxDepth: number; // Hierarchy depth limit (default 2)
	};
	worktrees: {
		baseDir: string; // Where worktrees live
	};
	beads: {
		enabled: boolean;
	};
	mulch: {
		enabled: boolean;
		domains: string[]; // Domains to prime (empty = auto-detect)
		primeFormat: "markdown" | "xml" | "json";
	};
	merge: {
		aiResolveEnabled: boolean;
		reimagineEnabled: boolean;
	};
	/** Optional runtime CLI base selection. Defaults to "claude" when omitted. */
	cli?: {
		base: CliBase;
	};
	providers: Record<string, ProviderConfig>;
	watchdog: {
		tier0Enabled: boolean; // Tier 0: Mechanical daemon (heartbeat, tmux/pid liveness)
		tier0IntervalMs: number; // Default 30_000
		tier1Enabled: boolean; // Tier 1: Triage agent (ephemeral AI analysis)
		tier2Enabled: boolean; // Tier 2: Monitor agent (continuous patrol)
		staleThresholdMs: number; // When to consider agent stale
		zombieThresholdMs: number; // When to kill
		nudgeIntervalMs: number; // Time between progressive nudge stages (default 60_000)
	};
	/**
	 * Per-role model overrides (keyed by role name, e.g. coordinator/monitor).
	 * Optional `default` key applies to all roles when a role-specific override
	 * is not provided.
	 *
	 * Validation:
	 * - cli.base=claude -> values must be sonnet|opus|haiku
	 * - cli.base=codex  -> values may be any non-empty model id string
	 */
	models: Partial<Record<string, ModelRef>>;
	roleProfiles?: Partial<Record<Capability | "default", string[]>>;
	modelProfiles?: Record<string, ModelProfile>;
	logging: {
		verbose: boolean;
		redactSecrets: boolean;
	};
}

// === Agent Manifest ===

export interface AgentManifest {
	version: string;
	agents: Record<string, AgentDefinition>;
	capabilityIndex: Record<string, string[]>;
}

export interface AgentDefinition {
	file: string; // Path to base agent definition (.md)
	model: ModelAlias;
	tools: string[]; // Allowed tools
	capabilities: string[]; // What this agent can do
	canSpawn: boolean; // Can this agent spawn sub-workers?
	constraints: string[]; // Machine-readable restrictions
}

/** All valid agent capability types. Used for compile-time validation. */
export const SUPPORTED_CAPABILITIES = [
	"scout",
	"builder",
	"reviewer",
	"lead",
	"merger",
	"coordinator",
	"supervisor",
	"monitor",
] as const;

/** Union type derived from the capabilities constant. */
export type Capability = (typeof SUPPORTED_CAPABILITIES)[number];

// === Agent Session ===

export type AgentState = "booting" | "working" | "completed" | "stalled" | "zombie";

export interface AgentSession {
	id: string; // Unique session ID
	agentName: string; // Unique per-session name
	capability: string; // Which agent definition
	worktreePath: string;
	branchName: string;
	beadId: string; // Task being worked
	tmuxSession: string; // Tmux session name
	state: AgentState;
	pid: number | null; // Claude Code PID
	parentAgent: string | null; // Who spawned this agent (null = orchestrator)
	depth: number; // 0 = direct from orchestrator
	runId: string | null; // Groups sessions in the same orchestrator run
	startedAt: string;
	lastActivity: string;
	escalationLevel: number; // Progressive nudge stage: 0=warn, 1=nudge, 2=escalate, 3=terminate
	stalledSince: string | null; // ISO timestamp when agent first entered stalled state
}

// === Agent Identity ===

export interface AgentIdentity {
	name: string;
	capability: string;
	created: string;
	sessionsCompleted: number;
	expertiseDomains: string[];
	recentTasks: Array<{
		beadId: string;
		summary: string;
		completedAt: string;
	}>;
}

// === Mail (Custom SQLite) ===

/** Semantic message types (original, human-readable). */
export type MailSemanticType = "status" | "question" | "result" | "error";

/** Protocol message types for structured agent coordination. */
export type MailProtocolType =
	| "worker_done"
	| "merge_ready"
	| "merged"
	| "merge_failed"
	| "escalation"
	| "health_check"
	| "dispatch"
	| "assign";

/** All valid mail message types. */
export type MailMessageType = MailSemanticType | MailProtocolType;

/** All protocol type strings as a runtime array for CHECK constraint generation. */
export const MAIL_MESSAGE_TYPES: readonly MailMessageType[] = [
	"status",
	"question",
	"result",
	"error",
	"worker_done",
	"merge_ready",
	"merged",
	"merge_failed",
	"escalation",
	"health_check",
	"dispatch",
	"assign",
] as const;

export interface MailMessage {
	id: string; // "msg-" + nanoid(12)
	from: string; // Agent name
	to: string; // Agent name or "orchestrator"
	subject: string;
	body: string;
	priority: "low" | "normal" | "high" | "urgent";
	type: MailMessageType;
	threadId: string | null; // Conversation threading
	payload: string | null; // JSON-encoded structured data for protocol messages
	read: boolean;
	createdAt: string; // ISO timestamp
}

// === Mail Protocol Payloads ===

/** Worker signals task completion to supervisor. */
export interface WorkerDonePayload {
	beadId: string;
	branch: string;
	exitCode: number;
	filesModified: string[];
}

/** Supervisor signals branch is verified and ready for merge. */
export interface MergeReadyPayload {
	branch: string;
	beadId: string;
	agentName: string;
	filesModified: string[];
}

/** Merger signals branch was merged successfully. */
export interface MergedPayload {
	branch: string;
	beadId: string;
	tier: ResolutionTier;
}

/** Merger signals merge failed, needs rework. */
export interface MergeFailedPayload {
	branch: string;
	beadId: string;
	conflictFiles: string[];
	errorMessage: string;
}

/** Any agent escalates an issue to a higher-level decision-maker. */
export interface EscalationPayload {
	severity: "warning" | "error" | "critical";
	beadId: string | null;
	context: string;
}

/** Watchdog probes agent liveness. */
export interface HealthCheckPayload {
	agentName: string;
	checkType: "liveness" | "readiness";
}

/** Coordinator dispatches work to a supervisor. */
export interface DispatchPayload {
	beadId: string;
	specPath: string;
	capability: Capability;
	fileScope: string[];
}

/** Supervisor assigns work to a specific worker. */
export interface AssignPayload {
	beadId: string;
	specPath: string;
	workerName: string;
	branch: string;
}

/** Maps protocol message types to their payload interfaces. */
export interface MailPayloadMap {
	worker_done: WorkerDonePayload;
	merge_ready: MergeReadyPayload;
	merged: MergedPayload;
	merge_failed: MergeFailedPayload;
	escalation: EscalationPayload;
	health_check: HealthCheckPayload;
	dispatch: DispatchPayload;
	assign: AssignPayload;
}

// === Overlay ===

export interface OverlayConfig {
	agentName: string;
	beadId: string;
	specPath: string | null;
	branchName: string;
	worktreePath: string;
	fileScope: string[];
	mulchDomains: string[];
	parentAgent: string | null;
	depth: number;
	canSpawn: boolean;
	capability: string;
	/** Full content of the base agent definition file (Layer 1: role-specific HOW). */
	baseDefinition: string;
	/** Pre-fetched mulch expertise output to embed directly in the overlay. */
	mulchExpertise?: string;
	/** Output directory for the instruction overlay (defaults to ".claude"). */
	instructionsDir?: string;
	/** Output filename for the instruction overlay (defaults to "CLAUDE.md"). */
	instructionsFile?: string;
}

// === Merge Queue ===

export type ResolutionTier = "clean-merge" | "auto-resolve" | "ai-resolve" | "reimagine";

export interface MergeEntry {
	branchName: string;
	beadId: string;
	agentName: string;
	filesModified: string[];
	enqueuedAt: string;
	status: "pending" | "merging" | "merged" | "conflict" | "failed";
	resolvedTier: ResolutionTier | null;
}

export interface MergeResult {
	entry: MergeEntry;
	success: boolean;
	tier: ResolutionTier;
	conflictFiles: string[];
	errorMessage: string | null;
}

/** Parsed conflict pattern from a single mulch record. */
export interface ParsedConflictPattern {
	tier: ResolutionTier;
	success: boolean;
	files: string[];
	agent: string;
	branch: string;
}

/** Historical conflict data assembled from mulch search results. */
export interface ConflictHistory {
	/** Tiers to skip based on historical failure rates for these files. */
	skipTiers: ResolutionTier[];
	/** Descriptions of past successful resolutions for AI prompt enrichment. */
	pastResolutions: string[];
	/** Files predicted to conflict based on historical patterns. */
	predictedConflictFiles: string[];
}

// === Watchdog ===

export interface HealthCheck {
	agentName: string;
	timestamp: string;
	processAlive: boolean;
	tmuxAlive: boolean;
	pidAlive: boolean | null; // null when pid is unavailable
	lastActivity: string;
	state: AgentState;
	action: "none" | "escalate" | "terminate" | "investigate";
	/** Describes any conflict between observable state and recorded state. */
	reconciliationNote: string | null;
}

// === Logging ===

export interface LogEvent {
	timestamp: string;
	level: "debug" | "info" | "warn" | "error";
	event: string;
	agentName: string | null;
	data: Record<string, unknown>;
}

// === Metrics ===

export interface SessionMetrics {
	agentName: string;
	beadId: string;
	capability: string;
	startedAt: string;
	completedAt: string | null;
	durationMs: number;
	exitCode: number | null;
	mergeResult: ResolutionTier | null;
	parentAgent: string | null;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheCreationTokens: number;
	estimatedCostUsd: number | null;
	modelUsed: string | null;
	runId: string | null;
}

/** A point-in-time token usage snapshot for a running agent session. */
export interface TokenSnapshot {
	agentName: string;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheCreationTokens: number;
	estimatedCostUsd: number | null;
	modelUsed: string | null;
	createdAt: string;
}

// === Task Groups (Batch Coordination) ===

export interface TaskGroup {
	id: string; // "group-" + nanoid(8)
	name: string;
	memberIssueIds: string[]; // beads issue IDs tracked by this group
	status: "active" | "completed";
	createdAt: string; // ISO timestamp
	completedAt: string | null; // ISO timestamp when all members closed
}

export interface TaskGroupProgress {
	group: TaskGroup;
	total: number;
	completed: number;
	inProgress: number;
	blocked: number;
	open: number;
}

// === Event Store (Observability) ===

/** Event types for agent activity tracking. */
export type EventType =
	| "tool_start"
	| "tool_end"
	| "session_start"
	| "session_end"
	| "mail_sent"
	| "mail_received"
	| "spawn"
	| "error"
	| "custom";

/** Severity levels for events. */
export type EventLevel = "debug" | "info" | "warn" | "error";

/** All valid event level strings as a runtime array for CHECK constraint generation. */
export const EVENT_LEVELS: readonly EventLevel[] = ["debug", "info", "warn", "error"] as const;

/** An event as stored in the SQLite events table. */
export interface StoredEvent {
	id: number;
	runId: string | null;
	agentName: string;
	sessionId: string | null;
	eventType: EventType;
	toolName: string | null;
	toolArgs: string | null;
	toolDurationMs: number | null;
	level: EventLevel;
	data: string | null;
	createdAt: string;
}

/** Input for inserting a new event (id and createdAt are auto-generated). */
export type InsertEvent = Omit<StoredEvent, "id" | "createdAt">;

/** Options for filtering event queries. */
export interface EventQueryOptions {
	limit?: number;
	since?: string; // ISO timestamp
	until?: string; // ISO timestamp
	level?: EventLevel;
}

/** Tool usage statistics returned by getToolStats. */
export interface ToolStats {
	toolName: string;
	count: number;
	avgDurationMs: number;
	maxDurationMs: number;
}

/** Interface for the SQLite-backed event store. */
export interface EventStore {
	/** Insert a new event. Returns the auto-generated row ID. */
	insert(event: InsertEvent): number;
	/** Find the most recent unmatched tool_start for correlation. Returns start ID and duration. */
	correlateToolEnd(
		agentName: string,
		toolName: string,
	): { startId: number; durationMs: number } | null;
	/** Get events for a specific agent. */
	getByAgent(agentName: string, opts?: EventQueryOptions): StoredEvent[];
	/** Get events for a specific run. */
	getByRun(runId: string, opts?: EventQueryOptions): StoredEvent[];
	/** Get error-level events. */
	getErrors(opts?: EventQueryOptions): StoredEvent[];
	/** Get a timeline of events with required options. */
	getTimeline(opts: EventQueryOptions & { since: string }): StoredEvent[];
	/** Get aggregated tool usage statistics. */
	getToolStats(opts?: { agentName?: string; since?: string }): ToolStats[];
	/** Delete events matching criteria. Returns number of rows deleted. */
	purge(opts: { all?: boolean; olderThanMs?: number; agentName?: string }): number;
	/** Close the database connection. */
	close(): void;
}

// === Run (Coordinator Session Grouping) ===

/** Status of a run (coordinator session grouping agents). */
export type RunStatus = "active" | "completed" | "failed";

/** A run groups all agents spawned from one coordinator session. */
export interface Run {
	id: string; // Format: run-{ISO timestamp}
	startedAt: string;
	completedAt: string | null;
	agentCount: number;
	coordinatorSessionId: string | null;
	status: RunStatus;
}

/** Input for creating a new run. */
export type InsertRun = Omit<Run, "completedAt" | "agentCount"> & {
	agentCount?: number;
};

/** Interface for run management operations. */
export interface RunStore {
	/** Create a new run. */
	createRun(run: InsertRun): void;
	/** Get a run by ID, or null if not found. */
	getRun(id: string): Run | null;
	/** Get the most recently started active run. */
	getActiveRun(): Run | null;
	/** List runs, optionally limited. */
	listRuns(opts?: { limit?: number; status?: RunStatus }): Run[];
	/** Increment agent count for a run. */
	incrementAgentCount(runId: string): void;
	/** Complete a run (set status and completedAt). */
	completeRun(runId: string, status: "completed" | "failed"): void;
	/** Close the store (if standalone — in practice may share DB with SessionStore). */
	close(): void;
}

// === Mulch CLI Results ===

/** Mulch status result (domain statistics). */
export interface MulchStatus {
	domains: Array<{ name: string; recordCount: number; lastUpdated: string }>;
}

/** Result from mulch diff command. */
export interface MulchDiffResult {
	success: boolean;
	command: string;
	since: string;
	domains: string[];
	message: string;
}

/** Result from mulch learn command. */
export interface MulchLearnResult {
	success: boolean;
	command: string;
	changedFiles: string[];
	suggestedDomains: string[];
	unmatchedFiles: string[];
}

/** Result from mulch prune command. */
export interface MulchPruneResult {
	success: boolean;
	command: string;
	dryRun: boolean;
	totalPruned: number;
	results: Array<{
		domain: string;
		pruned: number;
		records: string[];
	}>;
}

/** Health check result from mulch doctor. */
export interface MulchDoctorResult {
	success: boolean;
	command: string;
	checks: Array<{
		name: string;
		status: "pass" | "warn" | "fail";
		message: string;
		fixable: boolean;
		details: string[];
	}>;
	summary: {
		pass: number;
		warn: number;
		fail: number;
	};
}

/** Ready records result from mulch ready. */
export interface MulchReadyResult {
	success: boolean;
	command: string;
	count: number;
	entries: Array<{
		domain: string;
		id: string;
		type: string;
		recorded_at: string;
		summary: string;
		record: Record<string, unknown>;
	}>;
}

/** Result from mulch compact command. */
export interface MulchCompactResult {
	success: boolean;
	command: string;
	action: string;
	candidates?: Array<{
		domain: string;
		type: string;
		records: Array<{
			id: string;
			summary: string;
			recorded_at: string;
		}>;
	}>;
	compacted?: Array<{
		domain: string;
		type: string;
		before: number;
		after: number;
		recordIds: string[];
	}>;
	message?: string;
}

// === Session Lifecycle (Checkpoint / Handoff / Continuity) ===

/**
 * Snapshot of agent progress, saved before compaction or handoff.
 * Stored as JSON in .overstory/agents/{name}/checkpoint.json.
 */
export interface SessionCheckpoint {
	agentName: string;
	beadId: string;
	sessionId: string; // The AgentSession.id that created this checkpoint
	timestamp: string; // ISO
	progressSummary: string; // Human-readable summary of work done so far
	filesModified: string[]; // Paths modified since session start
	currentBranch: string;
	pendingWork: string; // What remains to be done
	mulchDomains: string[]; // Domains the agent has been working in
}

/**
 * Record of a session handoff — when one session ends and another picks up.
 */
export interface SessionHandoff {
	fromSessionId: string;
	toSessionId: string | null; // null until the new session starts
	checkpoint: SessionCheckpoint;
	reason: "compaction" | "crash" | "manual" | "timeout";
	handoffAt: string; // ISO timestamp
}

/**
 * Three-layer model for agent persistence.
 * Session = ephemeral Claude runtime
 * Sandbox = git worktree (persists across sessions)
 * Identity = permanent agent record (persists across assignments)
 */
export interface AgentLayers {
	identity: AgentIdentity;
	sandbox: {
		worktreePath: string;
		branchName: string;
		beadId: string;
	};
	session: {
		id: string;
		pid: number | null;
		tmuxSession: string;
		startedAt: string;
		checkpoint: SessionCheckpoint | null;
	} | null; // null when sandbox exists but no active session
}

// === Session Insight Analysis ===

/** A single structured insight extracted from a completed session. */
export interface SessionInsight {
	/** Mulch record type for this insight. */
	type: "pattern" | "convention" | "failure";
	/** Mulch domain this insight belongs to. */
	domain: string;
	/** Human-readable description of the insight. */
	description: string;
	/** Tags for mulch record categorization. */
	tags: string[];
}

/** Aggregated tool usage profile for a session. */
export interface ToolProfile {
	topTools: Array<{ name: string; count: number; avgMs: number }>;
	totalToolCalls: number;
	errorCount: number;
}

/** File edit frequency profile for a session. */
export interface FileProfile {
	/** Files edited more than once, sorted by edit count descending. */
	hotFiles: Array<{ path: string; editCount: number }>;
	totalEdits: number;
}

/** Complete insight analysis result for a completed session. */
export interface InsightAnalysis {
	insights: SessionInsight[];
	toolProfile: ToolProfile;
	fileProfile: FileProfile;
}

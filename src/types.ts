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
	watchdog: {
		tier1Enabled: boolean;
		tier1IntervalMs: number; // Default 30_000
		tier2Enabled: boolean;
		staleThresholdMs: number; // When to consider agent stale
		zombieThresholdMs: number; // When to kill
	};
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
	model: "sonnet" | "opus" | "haiku";
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
	startedAt: string;
	lastActivity: string;
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
	fileScope: string[];
	mulchDomains: string[];
	parentAgent: string | null;
	depth: number;
	canSpawn: boolean;
	capability: string;
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

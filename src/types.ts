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

export interface MailMessage {
	id: string; // "msg-" + nanoid(12)
	from: string; // Agent name
	to: string; // Agent name or "orchestrator"
	subject: string;
	body: string;
	priority: "low" | "normal" | "high" | "urgent";
	type: "status" | "question" | "result" | "error";
	threadId: string | null; // Conversation threading
	read: boolean;
	createdAt: string; // ISO timestamp
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
	lastActivity: string;
	state: AgentState;
	action: "none" | "escalate" | "terminate";
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

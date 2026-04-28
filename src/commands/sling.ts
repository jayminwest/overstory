/**
 * CLI command: ov sling <task-id>
 *
 * CRITICAL PATH. Orchestrates a full agent spawn:
 * 1. Load config + manifest
 * 2. Validate (depth limit, hierarchy)
 * 3. Load manifest + validate capability
 * 4. Resolve or create run_id (current-run.txt)
 * 5. Check name uniqueness + concurrency limit
 * 6. Validate task exists
 * 7. Create worktree
 * 8. Generate + write overlay CLAUDE.md
 * 9. Deploy hooks config
 * 10. Claim task issue
 * 11. Create agent identity
 * 12. Create tmux session running claude
 * 13. Record session in SessionStore + increment run agent count
 * 14. Return AgentSession
 */

import { mkdirSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createIdentity, loadIdentity } from "../agents/identity.ts";
import { createManifestLoader, resolveModel } from "../agents/manifest.ts";
import { writeOverlay } from "../agents/overlay.ts";
import { createCanopyClient } from "../canopy/client.ts";
import { loadConfig } from "../config.ts";
import { AgentError, HierarchyError, ValidationError } from "../errors.ts";
import { inferDomain } from "../insights/analyzer.ts";
import { jsonOutput } from "../json.ts";
import { printSuccess } from "../logging/color.ts";
import { createMailClient } from "../mail/client.ts";
import { createMailStore } from "../mail/store.ts";
import { createMulchClient } from "../mulch/client.ts";
import { getRuntime } from "../runtimes/registry.ts";
import { openSessionStore } from "../sessions/compat.ts";
import { createRunStore } from "../sessions/store.ts";
import type { TrackerIssue } from "../tracker/factory.ts";
import { createTrackerClient, resolveBackend, trackerCliName } from "../tracker/factory.ts";
import type { AgentSession, OverlayConfig, OverstoryConfig } from "../types.ts";
import { createWorktree, rollbackWorktree } from "../worktree/manager.ts";
import { spawnHeadlessAgent } from "../worktree/process.ts";
import {
	capturePaneContent,
	checkSessionState,
	createSession,
	ensureTmuxAvailable,
	isSessionAlive,
	killSession,
	sanitizeTmuxName,
	sendKeys,
	waitForTuiReady,
} from "../worktree/tmux.ts";

/**
 * Calculate how many milliseconds to sleep before spawning a new agent,
 * based on the configured stagger delay and when the most recent active
 * session was started.
 *
 * Returns 0 if no sleep is needed (no active sessions, delay is 0, or
 * enough time has already elapsed).
 *
 * @param staggerDelayMs - The configured minimum delay between spawns
 * @param activeSessions - Currently active (non-zombie) sessions
 * @param now - Current timestamp in ms (defaults to Date.now(), injectable for testing)
 */
export function calculateStaggerDelay(
	staggerDelayMs: number,
	activeSessions: ReadonlyArray<{ startedAt: string }>,
	now: number = Date.now(),
): number {
	if (staggerDelayMs <= 0 || activeSessions.length === 0) {
		return 0;
	}

	const mostRecent = activeSessions.reduce((latest, s) => {
		return new Date(s.startedAt).getTime() > new Date(latest.startedAt).getTime() ? s : latest;
	});
	const elapsed = now - new Date(mostRecent.startedAt).getTime();
	const remaining = staggerDelayMs - elapsed;
	return remaining > 0 ? remaining : 0;
}

/**
 * Generate a unique agent name from capability and taskId.
 * Base: capability-taskId. If that collides with takenNames,
 * appends -2, -3, etc. up to 100. Falls back to -Date.now() for guaranteed uniqueness.
 */
export function generateAgentName(
	capability: string,
	taskId: string,
	takenNames: readonly string[],
): string {
	const base = `${capability}-${taskId}`;
	if (!takenNames.includes(base)) {
		return base;
	}
	for (let i = 2; i <= 100; i++) {
		const candidate = `${base}-${i}`;
		if (!takenNames.includes(candidate)) {
			return candidate;
		}
	}
	return `${base}-${Date.now()}`;
}

/**
 * Check if the current process is running as root (UID 0).
 * Returns true if running as root, false otherwise.
 * Returns false on platforms that don't support getuid (e.g., Windows).
 *
 * The getuid parameter is injectable for testability without mocking process.getuid.
 */
export function isRunningAsRoot(getuid: (() => number) | undefined = process.getuid): boolean {
	return getuid?.() === 0;
}

/**
 * Infer mulch domains from a list of file paths.
 * Returns unique domains sorted alphabetically, falling back to
 * configured defaults if no domains could be inferred.
 */
export function inferDomainsFromFiles(
	files: readonly string[],
	configDomains: readonly string[],
): string[] {
	const inferred = new Set<string>();
	for (const file of files) {
		const domain = inferDomain(file);
		if (domain !== null) {
			inferred.add(domain);
		}
	}
	if (inferred.size === 0) {
		return [...configDomains];
	}
	return [...inferred].sort();
}

export interface SlingOptions {
	capability?: string;
	name?: string;
	spec?: string;
	files?: string;
	parent?: string;
	depth?: string;
	skipScout?: boolean;
	skipTaskCheck?: boolean;
	forceHierarchy?: boolean;
	json?: boolean;
	maxAgents?: string;
	skipReview?: boolean;
	dispatchMaxAgents?: string;
	runtime?: string;
	noScoutCheck?: boolean;
	baseBranch?: string;
	profile?: string;
	headless?: boolean;
}

export interface AutoDispatchOptions {
	agentName: string;
	taskId: string;
	capability: string;
	specPath: string | null;
	parentAgent: string | null;
	instructionPath: string;
}

/**
 * Build a structured auto-dispatch mail message for a newly slung agent.
 *
 * Sending this mail before creating the tmux session ensures it exists
 * in the DB when SessionStart fires, eliminating the race where dispatch
 * mail arrives after the agent boots and sits idle forever.
 */
export function buildAutoDispatch(opts: AutoDispatchOptions): {
	from: string;
	to: string;
	subject: string;
	body: string;
} {
	const from = opts.parentAgent ?? "orchestrator";
	const specLine = opts.specPath
		? `Spec file: ${opts.specPath}`
		: "No spec file provided. Check your overlay for task details.";
	const body = [
		`You have been assigned task ${opts.taskId} as a ${opts.capability} agent.`,
		specLine,
		`Read your overlay at ${opts.instructionPath} and begin immediately.`,
	].join(" ");

	return {
		from,
		to: opts.agentName,
		subject: `Dispatch: ${opts.taskId}`,
		body,
	};
}

/**
 * Options for building the structured startup beacon.
 */
export interface BeaconOptions {
	agentName: string;
	capability: string;
	taskId: string;
	parentAgent: string | null;
	depth: number;
	instructionPath: string;
}

/**
 * Build a structured startup beacon for an agent.
 *
 * The beacon is the first user message sent to a Claude Code agent via
 * tmux send-keys. It provides identity context and a numbered startup
 * protocol so the agent knows exactly what to do on boot.
 *
 * Format:
 *   [OVERSTORY] <agent-name> (<capability>) <ISO timestamp> task:<task-id>
 *   Depth: <n> | Parent: <parent-name|none>
 *   Startup protocol:
 *   1. Read your assignment in .claude/CLAUDE.md
 *   2. Load expertise: mulch prime
 *   3. Check mail: ov mail check --agent <name>
 *   4. Begin working on task <task-id>
 */
export function buildBeacon(opts: BeaconOptions): string {
	const timestamp = new Date().toISOString();
	const parent = opts.parentAgent ?? "none";
	const parts = [
		`[OVERSTORY] ${opts.agentName} (${opts.capability}) ${timestamp} task:${opts.taskId}`,
		`Depth: ${opts.depth} | Parent: ${parent}`,
		`Startup: read ${opts.instructionPath}, run mulch prime, check mail (ov mail check --agent ${opts.agentName}), then begin task ${opts.taskId}`,
	];
	return parts.join(" — ");
}

/**
 * Check if a parent agent has spawned any scouts.
 * Returns true if the parent has at least one scout child in the session history.
 */
export function parentHasScouts(
	sessions: ReadonlyArray<{ parentAgent: string | null; capability: string }>,
	parentAgent: string,
): boolean {
	return sessions.some((s) => s.parentAgent === parentAgent && s.capability === "scout");
}

/**
 * Determine whether to emit the scout-before-build warning.
 *
 * Returns true when all of the following hold:
 *  - The incoming capability is "builder" (only builders trigger the check)
 *  - A parent agent is set (orphaned builders don't trigger it)
 *  - The parent has not yet spawned any scouts
 *  - noScoutCheck is false (caller has not suppressed the warning)
 *  - skipScout is false (the lead is not intentionally running without scouts)
 *
 * Extracted from slingCommand for testability (overstory-6eyw).
 *
 * @param capability - The requested agent capability
 * @param parentAgent - The --parent flag value (null = coordinator/human)
 * @param sessions - All sessions (not just active) for parentHasScouts query
 * @param noScoutCheck - True when --no-scout-check flag is set
 * @param skipScout - True when --skip-scout flag is set (lead opted out of scouting)
 */
export function shouldShowScoutWarning(
	capability: string,
	parentAgent: string | null,
	sessions: ReadonlyArray<{ parentAgent: string | null; capability: string }>,
	noScoutCheck: boolean,
	skipScout: boolean,
): boolean {
	if (capability !== "builder") return false;
	if (parentAgent === null) return false;
	if (noScoutCheck) return false;
	if (skipScout) return false;
	return !parentHasScouts(sessions, parentAgent);
}

/**
 * Resolve which canonical repo directories should be writable to an
 * interactive agent runtime in addition to its worktree sandbox.
 *
 * All interactive agents need `.overstory` so they can access shared mail,
 * metrics, and session state. Only `lead` agents need canonical `.git`
 * because they can spawn child worktrees from inside the runtime.
 *
 * @param projectRoot - Absolute path to the canonical repository root
 * @param capability - Capability being launched
 */
export function getSharedWritableDirs(projectRoot: string, capability: string): string[] {
	const sharedWritableDirs = [join(projectRoot, ".overstory")];

	if (capability === "lead") {
		sharedWritableDirs.push(join(projectRoot, ".git"));
	}

	return sharedWritableDirs;
}

/**
 * Check if any active agent is already working on the given task ID.
 * Returns the agent name if locked, or null if the task is free.
 *
 * @param activeSessions - Currently active (non-zombie) sessions
 * @param taskId - The task ID to check for concurrent work
 */
export function checkTaskLock(
	activeSessions: ReadonlyArray<{ agentName: string; taskId: string }>,
	taskId: string,
): string | null {
	const existing = activeSessions.find((s) => s.taskId === taskId);
	return existing?.agentName ?? null;
}

/**
 * Check if an active lead agent is already assigned to the given task ID.
 * Returns the lead agent name if found, or null if no active lead exists.
 *
 * This prevents the duplicate-lead anti-pattern where two leads run
 * simultaneously on the same bead, causing duplicate work streams and
 * wasted tokens (overstory-gktc postmortem).
 *
 * Only checks sessions with capability "lead". Builder/scout children
 * working the same bead (via parent delegation) do not trigger this check.
 *
 * @param activeSessions - Currently active (non-zombie, non-completed) sessions
 * @param taskId - The task ID to check for an existing lead
 */
export function checkDuplicateLead(
	activeSessions: ReadonlyArray<{ agentName: string; taskId: string; capability: string }>,
	taskId: string,
): string | null {
	const existing = activeSessions.find((s) => s.taskId === taskId && s.capability === "lead");
	return existing?.agentName ?? null;
}

/**
 * Check if spawning another agent would exceed the per-run session limit.
 * Returns true if the limit is reached. A limit of 0 means unlimited.
 *
 * @param maxSessionsPerRun - Config limit (0 = unlimited)
 * @param currentRunAgentCount - Number of agents already spawned in this run
 */
export function checkRunSessionLimit(
	maxSessionsPerRun: number,
	currentRunAgentCount: number,
): boolean {
	if (maxSessionsPerRun <= 0) return false;
	return currentRunAgentCount >= maxSessionsPerRun;
}

/**
 * Check if a parent agent has reached its per-lead child ceiling.
 * Returns true if the limit is reached. A limit of 0 means unlimited.
 *
 * @param activeSessions - Currently active (non-zombie) sessions
 * @param parentAgent - The parent agent name to count children for
 * @param maxAgentsPerLead - Config or CLI limit (0 = unlimited)
 */
export function checkParentAgentLimit(
	activeSessions: ReadonlyArray<{ parentAgent: string | null }>,
	parentAgent: string,
	maxAgentsPerLead: number,
): boolean {
	if (maxAgentsPerLead <= 0) return false;
	const count = activeSessions.filter((s) => s.parentAgent === parentAgent).length;
	return count >= maxAgentsPerLead;
}

/**
 * Validate hierarchy constraints for direct coordinator/human spawns.
 *
 * When parentAgent is null, the caller is the coordinator or a human.
 * Direct spawns are allowed for "lead", "scout", and "builder".
 * Other capabilities (reviewer, merger, etc.) must be spawned by a lead
 * that passes --parent.
 *
 * @param parentAgent - The --parent flag value (null = coordinator/human)
 * @param capability - The requested agent capability
 * @param name - The agent name (for error context)
 * @param depth - The requested hierarchy depth
 * @param forceHierarchy - If true, bypass the check (for debugging)
 * @throws HierarchyError if the constraint is violated
 */
export function validateHierarchy(
	parentAgent: string | null,
	capability: string,
	name: string,
	_depth: number,
	forceHierarchy: boolean,
): void {
	if (forceHierarchy) {
		return;
	}

	const directSpawnCapabilities = ["lead", "scout", "builder"];
	if (parentAgent === null && !directSpawnCapabilities.includes(capability)) {
		throw new HierarchyError(
			`Coordinator cannot spawn "${capability}" directly. Only lead, scout, and builder are allowed without --parent. Use a lead as intermediary, or pass --force-hierarchy to bypass.`,
			{ agentName: name, requestedCapability: capability },
		);
	}
}

/**
 * Extract mulch record IDs and their domains from mulch prime output text.
 * Parses the markdown structure produced by ml prime: domain headings
 * (## <name>) followed by record lines containing (mx-XXXXXX) identifiers.
 * @param primeText - The output text from ml prime
 * @returns Array of {id, domain} pairs. Deduplicated.
 */
export function extractMulchRecordIds(primeText: string): Array<{ id: string; domain: string }> {
	const results: Array<{ id: string; domain: string }> = [];
	const seen = new Set<string>();
	let currentDomain = "";

	for (const line of primeText.split("\n")) {
		const domainMatch = line.match(/^## ([\w-]+)/);
		if (domainMatch) {
			currentDomain = domainMatch[1] ?? "";
			continue;
		}
		if (currentDomain) {
			const idRegex = /\(mx-([a-f0-9]+)\)/g;
			let match = idRegex.exec(line);
			while (match !== null) {
				const shortId = match[1] ?? "";
				if (shortId) {
					const key = `${currentDomain}:mx-${shortId}`;
					if (!seen.has(key)) {
						seen.add(key);
						results.push({ id: `mx-${shortId}`, domain: currentDomain });
					}
				}
				match = idRegex.exec(line);
			}
		}
	}
	return results;
}

/**
 * Get the current git branch name for the repo at the given path.
 *
 * Returns null if in detached HEAD state, the directory is not a git repo,
 * or git exits non-zero.
 *
 * @param repoRoot - Absolute path to the git repository root
 */
export async function getCurrentBranch(repoRoot: string): Promise<string | null> {
	const proc = Bun.spawn(["git", "rev-parse", "--abbrev-ref", "HEAD"], {
		cwd: repoRoot,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
	if (exitCode !== 0) return null;
	const branch = stdout.trim();
	// "HEAD" is returned when in detached HEAD state
	if (branch === "HEAD" || branch === "") return null;
	return branch;
}

/**
 * Resolve whether to use the headless spawn path for a given runtime + flags + config.
 *
 * Precedence (highest first):
 *   1. runtime.headless === true (statically headless runtimes always use headless)
 *   2. Explicit --headless / --no-headless flag (boolean | undefined from commander)
 *   3. config.runtime.claudeHeadlessByDefault (only applies when runtime.id === "claude")
 *   4. Default: false (tmux)
 *
 * Throws ValidationError when --headless is explicitly true but the runtime has no
 * buildDirectSpawn implementation.
 */
export function resolveUseHeadless(
	runtime: { id: string; headless?: boolean; buildDirectSpawn?: unknown },
	flag: boolean | undefined,
	config: OverstoryConfig,
): boolean {
	if (runtime.headless === true) return true;

	if (flag === true) {
		if (typeof runtime.buildDirectSpawn !== "function") {
			throw new ValidationError(
				`--headless requires a runtime with headless support. Runtime "${runtime.id}" does not implement buildDirectSpawn.`,
				{ field: "headless", value: true },
			);
		}
		return true;
	}
	if (flag === false) return false;

	if (runtime.id === "claude" && config.runtime?.claudeHeadlessByDefault === true) {
		if (typeof runtime.buildDirectSpawn !== "function") return false;
		return true;
	}

	return false;
}

/**
 * Entry point for `ov sling <task-id> [flags]`.
 *
 * @param taskId - The task ID to assign to the agent
 * @param opts - Command options
 */
export async function slingCommand(taskId: string, opts: SlingOptions): Promise<void> {
	if (!taskId) {
		throw new ValidationError("Task ID is required: ov sling <task-id>", {
			field: "taskId",
		});
	}

	const capability = opts.capability ?? "builder";
	const rawName = opts.name?.trim() ?? "";
	const nameWasAutoGenerated = rawName.length === 0;
	let name = nameWasAutoGenerated ? `${capability}-${taskId}` : rawName;
	const specPath = opts.spec ?? null;
	const filesRaw = opts.files;
	const parentAgent = opts.parent ?? null;
	const depthStr = opts.depth;
	const depth = depthStr !== undefined ? Number.parseInt(depthStr, 10) : 0;
	const forceHierarchy = opts.forceHierarchy ?? false;
	const skipScout = opts.skipScout ?? false;
	const skipTaskCheck = opts.skipTaskCheck ?? false;

	if (Number.isNaN(depth) || depth < 0) {
		throw new ValidationError("--depth must be a non-negative integer", {
			field: "depth",
			value: depthStr,
		});
	}

	if (isRunningAsRoot()) {
		throw new AgentError(
			"Cannot spawn agents as root (UID 0). The claude CLI rejects --permission-mode bypassPermissions when run as root, causing the tmux session to die immediately. Run overstory as a non-root user.",
			{ agentName: name },
		);
	}

	if (opts.maxAgents !== undefined) {
		const parsed = Number.parseInt(opts.maxAgents, 10);
		if (Number.isNaN(parsed) || parsed < 0) {
			throw new ValidationError("--max-agents must be a non-negative integer", {
				field: "maxAgents",
				value: opts.maxAgents,
			});
		}
	}

	if (opts.dispatchMaxAgents !== undefined) {
		const parsed = Number.parseInt(opts.dispatchMaxAgents, 10);
		if (Number.isNaN(parsed) || parsed < 0) {
			throw new ValidationError("--dispatch-max-agents must be a non-negative integer", {
				field: "dispatchMaxAgents",
				value: opts.dispatchMaxAgents,
			});
		}
	}

	// Warn if --skip-scout is used for a non-lead capability (harmless but confusing)
	if (skipScout && capability !== "lead") {
		process.stderr.write(
			`Warning: --skip-scout is only meaningful for leads. Ignoring for "${capability}" agent "${name}".\n`,
		);
	}

	if (skipTaskCheck && !parentAgent) {
		process.stderr.write(
			`Warning: --skip-task-check without --parent is unusual. This flag is designed for leads spawning builders with worktree-created issues.\n`,
		);
	}

	// Validate that spec file exists if provided, and resolve to absolute path
	// so agents in worktrees can access it (worktrees don't have .overstory/)
	let absoluteSpecPath: string | null = null;
	if (specPath !== null) {
		absoluteSpecPath = resolve(specPath);
		const specFile = Bun.file(absoluteSpecPath);
		const specExists = await specFile.exists();
		if (!specExists) {
			throw new ValidationError(`Spec file not found: ${specPath}`, {
				field: "spec",
				value: specPath,
			});
		}
	}

	const fileScope = filesRaw
		? filesRaw
				.split(",")
				.map((f) => f.trim())
				.filter((f) => f.length > 0)
		: [];

	// 1. Load config
	const cwd = process.cwd();
	const config = await loadConfig(cwd);
	const resolvedBackend = await resolveBackend(config.taskTracker.backend, config.project.root);

	// 2. Validate depth limit
	// Hierarchy: orchestrator(0) -> lead(1) -> specialist(2)
	// With maxDepth=2, depth=2 is the deepest allowed leaf, so reject only depth > maxDepth
	if (depth > config.agents.maxDepth) {
		throw new AgentError(
			`Depth limit exceeded: depth ${depth} > maxDepth ${config.agents.maxDepth}`,
			{ agentName: name },
		);
	}

	// 2b. Validate hierarchy: coordinator (no --parent) can only spawn leads
	validateHierarchy(parentAgent, capability, name, depth, forceHierarchy);

	// 3. Load manifest and validate capability
	const manifestLoader = createManifestLoader(
		join(config.project.root, config.agents.manifestPath),
		join(config.project.root, config.agents.baseDir),
	);
	const manifest = await manifestLoader.load();

	const agentDef = manifest.agents[capability];
	if (!agentDef) {
		throw new AgentError(
			`Unknown capability "${capability}". Available: ${Object.keys(manifest.agents).join(", ")}`,
			{ agentName: name, capability },
		);
	}

	// 4. Resolve or create run_id for this spawn
	const overstoryDir = join(config.project.root, ".overstory");
	const currentRunPath = join(overstoryDir, "current-run.txt");

	// 5. Check name uniqueness and concurrency limit against active sessions
	// (Session store opened here so we can also use it for parent run ID inheritance in step 4.)
	const { store } = openSessionStore(overstoryDir);
	try {
		// 4a. Resolve run ID: inherit from parent → current-run.txt fallback → create new.
		// Parent inheritance ensures child agents belong to the same run as their coordinator.
		const runId = await (async (): Promise<string> => {
			if (parentAgent) {
				const parentSession = store.getByName(parentAgent);
				if (parentSession?.runId) {
					return parentSession.runId;
				}
			}

			// Fallback: read current-run.txt (backward compat with single-coordinator setups).
			const currentRunFile = Bun.file(currentRunPath);
			if (await currentRunFile.exists()) {
				const text = (await currentRunFile.text()).trim();
				if (text) return text;
			}

			// Create a new run if none exists.
			const newRunId = `run-${new Date().toISOString().replace(/[:.]/g, "-")}`;
			const runStore = createRunStore(join(overstoryDir, "sessions.db"));
			try {
				runStore.createRun({
					id: newRunId,
					startedAt: new Date().toISOString(),
					coordinatorSessionId: null,
					coordinatorName: null,
					status: "active",
				});
			} finally {
				runStore.close();
			}
			await Bun.write(currentRunPath, newRunId);
			return newRunId;
		})();

		// 4b. Check per-run session limit
		if (config.agents.maxSessionsPerRun > 0) {
			const runCheckStore = createRunStore(join(overstoryDir, "sessions.db"));
			try {
				const run = runCheckStore.getRun(runId);
				if (run && checkRunSessionLimit(config.agents.maxSessionsPerRun, run.agentCount)) {
					throw new AgentError(
						`Run session limit reached: ${run.agentCount}/${config.agents.maxSessionsPerRun} agents spawned in run "${runId}". ` +
							`Increase agents.maxSessionsPerRun in config.yaml or start a new run.`,
						{ agentName: name },
					);
				}
			} finally {
				runCheckStore.close();
			}
		}

		const activeSessions = store.getActive();
		if (activeSessions.length >= config.agents.maxConcurrent) {
			throw new AgentError(
				`Max concurrent agent limit reached: ${activeSessions.length}/${config.agents.maxConcurrent} active agents`,
				{ agentName: name },
			);
		}

		if (nameWasAutoGenerated) {
			const takenNames = activeSessions.map((s) => s.agentName);
			name = generateAgentName(capability, taskId, takenNames);
		} else {
			const existing = store.getByName(name);
			if (existing && existing.state !== "zombie" && existing.state !== "completed") {
				throw new AgentError(`Agent name "${name}" is already in use (state: ${existing.state})`, {
					agentName: name,
				});
			}
		}

		// 5d. Task-level locking: prevent concurrent agents on the same task ID.
		// Exception: the parent agent may delegate its own task to a child.
		const lockHolder = checkTaskLock(activeSessions, taskId);
		if (lockHolder !== null && lockHolder !== parentAgent) {
			throw new AgentError(
				`Task "${taskId}" is already being worked by agent "${lockHolder}". ` +
					`Concurrent work on the same task causes duplicate issues and wasted tokens.`,
				{ agentName: name },
			);
		}

		// 5b. Enforce stagger delay between agent spawns
		const staggerMs = calculateStaggerDelay(config.agents.staggerDelayMs, activeSessions);
		if (staggerMs > 0) {
			await Bun.sleep(staggerMs);
		}

		// 5e. Enforce per-lead agent ceiling when spawning under a parent
		if (parentAgent !== null) {
			const maxPerLead =
				opts.maxAgents !== undefined
					? Number.parseInt(opts.maxAgents, 10)
					: config.agents.maxAgentsPerLead;
			if (checkParentAgentLimit(activeSessions, parentAgent, maxPerLead)) {
				const currentCount = activeSessions.filter((s) => s.parentAgent === parentAgent).length;
				throw new AgentError(
					`Per-lead agent limit reached: "${parentAgent}" has ${currentCount}/${maxPerLead} active children. ` +
						`Increase agents.maxAgentsPerLead in config.yaml or pass --max-agents <n>.`,
					{ agentName: name },
				);
			}
		}

		// 5c. Structural enforcement: warn when a lead spawns a builder without prior scouts.
		// This is a non-blocking warning — it does not prevent the spawn, but surfaces
		// the scout-skip pattern so agents and operators can see it happening.
		// Use --no-scout-check to suppress this warning when intentionally skipping scouts.
		if (
			shouldShowScoutWarning(
				capability,
				parentAgent,
				store.getAll(),
				opts.noScoutCheck ?? false,
				skipScout,
			)
		) {
			process.stderr.write(
				`Warning: "${parentAgent}" is spawning builder "${name}" without having spawned any scouts.\n`,
			);
			process.stderr.write(
				"   Leads should spawn scouts in Phase 1 before building. See agents/lead.md.\n",
			);
		}

		// 6. Validate task exists and is in a workable state (if tracker enabled)
		const tracker = createTrackerClient(resolvedBackend, config.project.root);
		if (config.taskTracker.enabled && !skipTaskCheck) {
			let issue: TrackerIssue;
			try {
				issue = await tracker.show(taskId);
			} catch (err) {
				throw new AgentError(`Task "${taskId}" not found or inaccessible`, {
					agentName: name,
					cause: err instanceof Error ? err : undefined,
				});
			}

			const workableStatuses = ["open", "in_progress"];
			if (!workableStatuses.includes(issue.status)) {
				throw new ValidationError(
					`Task "${taskId}" is not workable (status: ${issue.status}). Only open or in_progress issues can be assigned.`,
					{ field: "taskId", value: taskId },
				);
			}
		}

		// 7. Create worktree
		const worktreeBaseDir = join(config.project.root, config.worktrees.baseDir);
		await mkdir(worktreeBaseDir, { recursive: true });

		// Resolve base branch: --base-branch flag > current HEAD > config.project.canonicalBranch
		const baseBranch =
			opts.baseBranch ??
			(await getCurrentBranch(config.project.root)) ??
			config.project.canonicalBranch;

		const { path: worktreePath, branch: branchName } = await createWorktree({
			repoRoot: config.project.root,
			baseDir: worktreeBaseDir,
			agentName: name,
			baseBranch,
			taskId: taskId,
		});

		try {
			// 8. Generate + write overlay CLAUDE.md
			const agentDefPath = join(config.project.root, config.agents.baseDir, agentDef.file);
			const baseDefinition = await Bun.file(agentDefPath).text();

			// 8a. Fetch file-scoped mulch expertise if mulch is enabled and files are provided
			let mulchExpertise: string | undefined;
			if (config.mulch.enabled && fileScope.length > 0) {
				try {
					const mulch = createMulchClient(config.project.root);
					mulchExpertise = await mulch.prime(undefined, undefined, {
						files: fileScope,
						sortByScore: true,
					});
				} catch {
					// Non-fatal: mulch expertise is supplementary context
					mulchExpertise = undefined;
				}
			}

			// 8b. Resolve canopy profile if specified
			const profileName =
				opts.profile ?? process.env.OVERSTORY_PROFILE ?? config.project.defaultProfile;
			let profileContent: string | undefined;
			if (profileName) {
				try {
					const canopy = createCanopyClient(config.project.root);
					const rendered = await canopy.render(profileName);
					if (rendered.success && rendered.sections.length > 0) {
						profileContent = rendered.sections.map((s) => s.body).join("\n\n");
					}
				} catch {
					// Non-fatal: canopy may not be installed or profile may not exist
					profileContent = undefined;
				}
			}

			// Resolve runtime before overlayConfig so we can pass runtime.instructionPath
			const runtime = getRuntime(opts.runtime, config, capability);

			// Runtime-specific worktree preparation (e.g., Copilot folder trust)
			if (runtime.prepareWorktree) {
				await runtime.prepareWorktree(worktreePath);
			}

			const overlayConfig: OverlayConfig = {
				agentName: name,
				taskId: taskId,
				specPath: absoluteSpecPath,
				branchName,
				worktreePath,
				fileScope,
				mulchDomains: config.mulch.enabled
					? inferDomainsFromFiles(fileScope, config.mulch.domains)
					: [],
				parentAgent: parentAgent,
				depth,
				canSpawn: agentDef.canSpawn,
				capability,
				baseDefinition,
				profileContent,
				mulchExpertise,
				skipScout: skipScout && capability === "lead",
				skipReview: opts.skipReview === true && capability === "lead",
				maxAgentsOverride:
					opts.dispatchMaxAgents !== undefined
						? Number.parseInt(opts.dispatchMaxAgents, 10)
						: undefined,
				qualityGates: config.project.qualityGates,
				trackerCli: trackerCliName(resolvedBackend),
				trackerName: resolvedBackend,
				instructionPath: runtime.instructionPath,
			};

			await writeOverlay(worktreePath, overlayConfig, config.project.root, runtime.instructionPath);

			// 9. Resolve runtime + model (needed for deployConfig, spawn, and beacon)
			const resolvedModel = resolveModel(config, manifest, capability, agentDef.model);

			// 9a. Deploy hooks config (capability-specific guards)
			await runtime.deployConfig(worktreePath, undefined, {
				agentName: name,
				capability,
				worktreePath,
				qualityGates: config.project.qualityGates,
			});

			// 9b. Send auto-dispatch mail so it exists when SessionStart hook fires.
			// This eliminates the race where coordinator sends dispatch AFTER agent boots.
			const dispatch = buildAutoDispatch({
				agentName: name,
				taskId,
				capability,
				specPath: absoluteSpecPath,
				parentAgent,
				instructionPath: runtime.instructionPath,
			});
			const mailStore = createMailStore(join(overstoryDir, "mail.db"));
			try {
				const mailClient = createMailClient(mailStore);
				mailClient.send({
					from: dispatch.from,
					to: dispatch.to,
					subject: dispatch.subject,
					body: dispatch.body,
					type: "dispatch",
					priority: "normal",
				});
			} finally {
				mailStore.close();
			}

			// 10. Claim tracker issue
			if (config.taskTracker.enabled && !skipTaskCheck) {
				try {
					await tracker.claim(taskId);
				} catch {
					// Non-fatal: issue may already be claimed
				}
			}

			// 11. Create agent identity (if new)
			const identityBaseDir = join(config.project.root, ".overstory", "agents");
			const existingIdentity = await loadIdentity(identityBaseDir, name);
			if (!existingIdentity) {
				await createIdentity(identityBaseDir, {
					name,
					capability,
					created: new Date().toISOString(),
					sessionsCompleted: 0,
					expertiseDomains: config.mulch.enabled ? config.mulch.domains : [],
					recentTasks: [],
				});
			}

			// 11b. Save applied mulch record IDs for session-end outcome tracking.
			// Written to .overstory/agents/{name}/applied-records.json so log.ts
			// can append outcomes when the session completes.
			if (mulchExpertise) {
				const appliedRecords = extractMulchRecordIds(mulchExpertise);
				if (appliedRecords.length > 0) {
					const appliedRecordsPath = join(identityBaseDir, name, "applied-records.json");
					const appliedData = { taskId, agentName: name, capability, records: appliedRecords };
					try {
						await Bun.write(appliedRecordsPath, `${JSON.stringify(appliedData, null, "\t")}\n`);
					} catch {
						// Non-fatal: outcome tracking is supplementary context
					}
				}
			}

			// 11c. Spawn: headless runtimes bypass tmux entirely; tmux path is unchanged.
			const useHeadless = resolveUseHeadless(runtime, opts.headless, config);
			if (useHeadless && runtime.buildDirectSpawn) {
				const directEnv = {
					...runtime.buildEnv(resolvedModel),
					OVERSTORY_AGENT_NAME: name,
					OVERSTORY_WORKTREE_PATH: worktreePath,
					OVERSTORY_TASK_ID: taskId,
					OVERSTORY_PROJECT_ROOT: config.project.root,
				};
				const argv = runtime.buildDirectSpawn({
					cwd: worktreePath,
					env: directEnv,
					...(resolvedModel.isExplicitOverride ? { model: resolvedModel.model } : {}),
					instructionPath: runtime.instructionPath,
				});

				// Create a timestamped log dir for this headless agent session.
				// Always redirect stdout to a file. This prevents SIGPIPE death:
				// ov sling exits after spawning, closing the pipe's read end.
				// If stdout is a pipe, the agent dies on the next write (SIGPIPE).
				// File writes have no such limit, and the agent survives the CLI exit.
				//
				// Note: RPC connection wiring is intentionally omitted here. The RPC pipe
				// is only useful when the spawner stays alive to consume it. ov sling is
				// a short-lived CLI — any connection created here dies with the process.
				const logTimestamp = new Date().toISOString().replace(/[:.]/g, "-");
				const agentLogDir = join(overstoryDir, "logs", name, logTimestamp);
				mkdirSync(agentLogDir, { recursive: true });

				const headlessProc = await spawnHeadlessAgent(argv, {
					cwd: worktreePath,
					env: { ...(process.env as Record<string, string>), ...directEnv },
					stdoutFile: join(agentLogDir, "stdout.log"),
					stderrFile: join(agentLogDir, "stderr.log"),
				});

				// 13. Record session with empty tmuxSession (no tmux pane for headless agents).
				const session: AgentSession = {
					id: `session-${Date.now()}-${name}`,
					agentName: name,
					capability,
					worktreePath,
					branchName,
					taskId: taskId,
					tmuxSession: "",
					state: "booting",
					pid: headlessProc.pid,
					parentAgent: parentAgent,
					depth,
					runId,
					startedAt: new Date().toISOString(),
					lastActivity: new Date().toISOString(),
					escalationLevel: 0,
					stalledSince: null,
					transcriptPath: null,
				};
				store.upsert(session);

				const runStore = createRunStore(join(overstoryDir, "sessions.db"));
				try {
					runStore.incrementAgentCount(runId);
				} finally {
					runStore.close();
				}

				// 14. Output result (headless)
				if (opts.json ?? false) {
					jsonOutput("sling", {
						agentName: name,
						capability,
						taskId,
						branch: branchName,
						worktree: worktreePath,
						tmuxSession: "",
						pid: headlessProc.pid,
					});
				} else {
					printSuccess("Agent launched (headless)", name);
					process.stdout.write(`   Task:     ${taskId}\n`);
					process.stdout.write(`   Branch:   ${branchName}\n`);
					process.stdout.write(`   Worktree: ${worktreePath}\n`);
					process.stdout.write(`   PID:      ${headlessProc.pid}\n`);
				}
			} else {
				// 11c. Preflight: verify tmux is available before attempting session creation
				await ensureTmuxAvailable();

				// 12. Create tmux session running claude in interactive mode
				const tmuxSessionName = `overstory-${sanitizeTmuxName(config.project.name)}-${name}`;
				const spawnCmd = runtime.buildSpawnCommand({
					model: resolvedModel.model,
					permissionMode: "bypass",
					cwd: worktreePath,
					sharedWritableDirs: getSharedWritableDirs(config.project.root, capability),
					env: {
						...runtime.buildEnv(resolvedModel),
						OVERSTORY_AGENT_NAME: name,
						OVERSTORY_WORKTREE_PATH: worktreePath,
						OVERSTORY_TASK_ID: taskId,
						OVERSTORY_PROJECT_ROOT: config.project.root,
					},
				});
				const pid = await createSession(tmuxSessionName, worktreePath, spawnCmd, {
					...runtime.buildEnv(resolvedModel),
					OVERSTORY_AGENT_NAME: name,
					OVERSTORY_WORKTREE_PATH: worktreePath,
					OVERSTORY_TASK_ID: taskId,
					OVERSTORY_PROJECT_ROOT: config.project.root,
				});

				// 13. Record session BEFORE sending the beacon so that hook-triggered
				// updateLastActivity() can find the entry and transition booting->working.
				// Without this, a race exists: hooks fire before the session is persisted,
				// leaving the agent stuck in "booting" (overstory-036f).
				const session: AgentSession = {
					id: `session-${Date.now()}-${name}`,
					agentName: name,
					capability,
					worktreePath,
					branchName,
					taskId: taskId,
					tmuxSession: tmuxSessionName,
					state: "booting",
					pid,
					parentAgent: parentAgent,
					depth,
					runId,
					startedAt: new Date().toISOString(),
					lastActivity: new Date().toISOString(),
					escalationLevel: 0,
					stalledSince: null,
					transcriptPath: null,
				};

				store.upsert(session);

				// Increment agent count for the run
				const runStore = createRunStore(join(overstoryDir, "sessions.db"));
				try {
					runStore.incrementAgentCount(runId);
				} finally {
					runStore.close();
				}

				// 13b. Give slow shells time to finish initializing before polling for TUI readiness.
				const shellDelay = config.runtime?.shellInitDelayMs ?? 0;
				if (shellDelay > 0) {
					await Bun.sleep(shellDelay);
				}

				// Wait for Claude Code TUI to render before sending input.
				// Polling capture-pane is more reliable than a fixed sleep because
				// TUI init time varies by machine load and model state.
				const tuiReady = await waitForTuiReady(tmuxSessionName, (content) =>
					runtime.detectReady(content),
				);
				if (!tuiReady) {
					const alive = await isSessionAlive(tmuxSessionName);
					// Mark as zombie (not completed) so the watchdog detects this failed
					// startup. 'completed' is a terminal success state that the watchdog
					// skips entirely (overstory-c40e).
					store.updateState(name, "zombie");

					if (alive) {
						await killSession(tmuxSessionName);
						throw new AgentError(
							`Agent tmux session "${tmuxSessionName}" did not become ready during startup. The runtime may still be waiting on an interactive dialog or initializing too slowly.`,
							{ agentName: name },
						);
					}

					const sessionState = await checkSessionState(tmuxSessionName);
					const detail =
						sessionState === "no_server"
							? "The tmux server is no longer running. It may have crashed or been killed externally."
							: "The agent process may have crashed or exited immediately before the TUI became ready.";
					throw new AgentError(
						`Agent tmux session "${tmuxSessionName}" died during startup. ${detail}`,
						{ agentName: name },
					);
				}
				// Buffer for the input handler to attach after initial render
				await Bun.sleep(1_000);

				const beacon = buildBeacon({
					agentName: name,
					capability,
					taskId,
					parentAgent,
					depth,
					instructionPath: runtime.instructionPath,
				});
				await sendKeys(tmuxSessionName, beacon);

				// 13c. Follow-up Enters with increasing delays to ensure submission.
				// Claude Code's TUI may consume early Enters during late initialization
				// (overstory-yhv6). An Enter on an empty input line is harmless.
				for (const delay of [1_000, 2_000, 3_000, 5_000]) {
					await Bun.sleep(delay);
					await sendKeys(tmuxSessionName, "");
				}

				// 13d. Verify beacon was received — if pane still shows the welcome
				// screen (detectReady returns "ready"), resend the beacon. Claude Code's TUI
				// sometimes consumes the Enter keystroke during late initialization, swallowing
				// the beacon text entirely (overstory-3271).
				//
				// Skipped for runtimes that return false from requiresBeaconVerification().
				// Pi's TUI idle and processing states are indistinguishable via detectReady
				// (both show "pi v..." header and the token-usage status bar), so the loop
				// would incorrectly conclude the beacon was not received and spam duplicate
				// startup messages.
				const needsVerification =
					!runtime.requiresBeaconVerification || runtime.requiresBeaconVerification();
				if (needsVerification) {
					const verifyAttempts = 5;
					for (let v = 0; v < verifyAttempts; v++) {
						await Bun.sleep(2_000);
						const paneContent = await capturePaneContent(tmuxSessionName);
						if (paneContent) {
							const readyState = runtime.detectReady(paneContent);
							if (readyState.phase !== "ready") {
								break; // Agent is processing — beacon was received
							}
						}
						// Still at welcome/idle screen — resend beacon
						await sendKeys(tmuxSessionName, beacon);
						await Bun.sleep(1_000);
						await sendKeys(tmuxSessionName, ""); // Follow-up Enter
					}
				}

				// 14. Output result
				const output = {
					agentName: name,
					capability,
					taskId,
					branch: branchName,
					worktree: worktreePath,
					tmuxSession: tmuxSessionName,
					pid,
				};

				if (opts.json ?? false) {
					jsonOutput("sling", output);
				} else {
					printSuccess("Agent launched", name);
					process.stdout.write(`   Task:     ${taskId}\n`);
					process.stdout.write(`   Branch:   ${branchName}\n`);
					process.stdout.write(`   Worktree: ${worktreePath}\n`);
					process.stdout.write(`   Tmux:     ${tmuxSessionName}\n`);
					process.stdout.write(`   PID:      ${pid}\n`);
				}
			}
		} catch (err) {
			await rollbackWorktree(config.project.root, worktreePath, branchName);
			throw err;
		}
	} finally {
		store.close();
	}
}

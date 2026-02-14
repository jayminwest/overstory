/**
 * CLI command: overstory sling <task-id>
 *
 * CRITICAL PATH. Orchestrates a full agent spawn:
 * 1. Load config + manifest
 * 2. Validate (name unique, depth limit, bead exists)
 * 3. Create worktree
 * 4. Generate + write overlay CLAUDE.md
 * 5. Generate + write hooks config
 * 6. Claim beads issue
 * 7. Create tmux session running claude
 * 8. Record session in SessionStore (sessions.db)
 * 9. Return AgentSession
 */

import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { deployHooks } from "../agents/hooks-deployer.ts";
import { createIdentity, loadIdentity } from "../agents/identity.ts";
import { createManifestLoader } from "../agents/manifest.ts";
import { writeOverlay } from "../agents/overlay.ts";
import type { BeadIssue } from "../beads/client.ts";
import { createBeadsClient } from "../beads/client.ts";
import { loadConfig } from "../config.ts";
import { AgentError, HierarchyError, ValidationError } from "../errors.ts";
import { openSessionStore } from "../sessions/compat.ts";
import type { AgentSession, OverlayConfig } from "../types.ts";
import { createWorktree } from "../worktree/manager.ts";
import { createSession, sendKeys } from "../worktree/tmux.ts";

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
 * Parse a named flag value from an args array.
 */
function getFlag(args: string[], flag: string): string | undefined {
	const idx = args.indexOf(flag);
	if (idx === -1 || idx + 1 >= args.length) {
		return undefined;
	}
	return args[idx + 1];
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
}

/**
 * Build a structured startup beacon for an agent.
 *
 * The beacon is the first user message sent to a Claude Code agent via
 * tmux send-keys. It provides identity context and a numbered startup
 * protocol so the agent knows exactly what to do on boot.
 *
 * Format:
 *   [OVERSTORY] <agent-name> (<capability>) <ISO timestamp> task:<bead-id>
 *   Depth: <n> | Parent: <parent-name|none>
 *   Startup protocol:
 *   1. Read your assignment in .claude/CLAUDE.md
 *   2. Load expertise: mulch prime
 *   3. Check mail: overstory mail check --agent <name>
 *   4. Begin working on task <bead-id>
 */
export function buildBeacon(opts: BeaconOptions): string {
	const timestamp = new Date().toISOString();
	const parent = opts.parentAgent ?? "none";
	const parts = [
		`[OVERSTORY] ${opts.agentName} (${opts.capability}) ${timestamp} task:${opts.taskId}`,
		`Depth: ${opts.depth} | Parent: ${parent}`,
		`Startup: read .claude/CLAUDE.md, run mulch prime, check mail (overstory mail check --agent ${opts.agentName}), then begin task ${opts.taskId}`,
	];
	return parts.join(" — ");
}

/**
 * Validate hierarchy constraints: the coordinator (no parent) may only spawn leads.
 *
 * When parentAgent is null, the caller is the coordinator or a human.
 * Only "lead" capability is allowed in that case. All other capabilities
 * (builder, scout, reviewer, merger) must be spawned by a lead or supervisor
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

	if (parentAgent === null && capability !== "lead") {
		throw new HierarchyError(
			`Coordinator cannot spawn "${capability}" directly. Only "lead" is allowed without --parent. Use a lead as intermediary, or pass --force-hierarchy to bypass.`,
			{ agentName: name, requestedCapability: capability },
		);
	}
}

/**
 * Entry point for `overstory sling <task-id> [flags]`.
 *
 * Flags:
 *   --capability <type>    builder | scout | reviewer | lead | merger
 *   --name <name>          Unique agent name
 *   --spec <path>          Path to task spec file
 *   --files <f1,f2,...>    Exclusive file scope
 *   --parent <agent-name>  Parent agent (for hierarchy tracking)
 *   --depth <n>            Current hierarchy depth (default 0)
 *   --force-hierarchy      Bypass hierarchy validation (debugging only)
 */
const SLING_HELP = `overstory sling — Spawn a worker agent

Usage: overstory sling <task-id> [flags]

Arguments:
  <task-id>                  Beads task ID to assign

Options:
  --capability <type>        Agent type: builder | scout | reviewer | lead | merger (default: builder)
  --name <name>              Unique agent name (required)
  --spec <path>              Path to task spec file
  --files <f1,f2,...>        Exclusive file scope (comma-separated)
  --parent <agent-name>      Parent agent for hierarchy tracking
  --depth <n>                Current hierarchy depth (default: 0)
  --force-hierarchy            Bypass hierarchy validation (debugging only)
  --json                     Output result as JSON
  --help, -h                 Show this help`;

export async function slingCommand(args: string[]): Promise<void> {
	if (args.includes("--help") || args.includes("-h")) {
		process.stdout.write(`${SLING_HELP}\n`);
		return;
	}

	const taskId = args.find((a) => !a.startsWith("--"));
	if (!taskId) {
		throw new ValidationError("Task ID is required: overstory sling <task-id>", {
			field: "taskId",
		});
	}

	const capability = getFlag(args, "--capability") ?? "builder";
	const name = getFlag(args, "--name");
	const specPath = getFlag(args, "--spec") ?? null;
	const filesRaw = getFlag(args, "--files");
	const parentAgent = getFlag(args, "--parent") ?? null;
	const depthStr = getFlag(args, "--depth");
	const depth = depthStr !== undefined ? Number.parseInt(depthStr, 10) : 0;
	const forceHierarchy = args.includes("--force-hierarchy");

	if (!name || name.trim().length === 0) {
		throw new ValidationError("--name is required for sling", { field: "name" });
	}

	if (Number.isNaN(depth) || depth < 0) {
		throw new ValidationError("--depth must be a non-negative integer", {
			field: "depth",
			value: depthStr,
		});
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

	// 4. Check name uniqueness and concurrency limit against active sessions
	const overstoryDir = join(config.project.root, ".overstory");
	const { store } = openSessionStore(overstoryDir);
	try {
		const activeSessions = store.getActive();
		if (activeSessions.length >= config.agents.maxConcurrent) {
			throw new AgentError(
				`Max concurrent agent limit reached: ${activeSessions.length}/${config.agents.maxConcurrent} active agents`,
				{ agentName: name },
			);
		}

		const existing = store.getByName(name);
		if (existing && existing.state !== "zombie" && existing.state !== "completed") {
			throw new AgentError(`Agent name "${name}" is already in use (state: ${existing.state})`, {
				agentName: name,
			});
		}

		// 4b. Enforce stagger delay between agent spawns
		const staggerMs = calculateStaggerDelay(config.agents.staggerDelayMs, activeSessions);
		if (staggerMs > 0) {
			await Bun.sleep(staggerMs);
		}

		// 5. Validate bead exists and is in a workable state (if beads enabled)
		const beads = createBeadsClient(config.project.root);
		if (config.beads.enabled) {
			let issue: BeadIssue;
			try {
				issue = await beads.show(taskId);
			} catch (err) {
				throw new AgentError(`Bead task "${taskId}" not found or inaccessible`, {
					agentName: name,
					cause: err instanceof Error ? err : undefined,
				});
			}

			const workableStatuses = ["open", "in_progress"];
			if (!workableStatuses.includes(issue.status)) {
				throw new ValidationError(
					`Bead task "${taskId}" is not workable (status: ${issue.status}). Only open or in_progress issues can be assigned.`,
					{ field: "taskId", value: taskId },
				);
			}
		}

		// 6. Create worktree
		const worktreeBaseDir = join(config.project.root, config.worktrees.baseDir);
		await mkdir(worktreeBaseDir, { recursive: true });

		const { path: worktreePath, branch: branchName } = await createWorktree({
			repoRoot: config.project.root,
			baseDir: worktreeBaseDir,
			agentName: name,
			baseBranch: config.project.canonicalBranch,
			beadId: taskId,
		});

		// 7. Generate + write overlay CLAUDE.md
		const agentDefPath = join(config.project.root, config.agents.baseDir, agentDef.file);
		const baseDefinition = await Bun.file(agentDefPath).text();

		const overlayConfig: OverlayConfig = {
			agentName: name,
			beadId: taskId,
			specPath: absoluteSpecPath,
			branchName,
			worktreePath,
			fileScope,
			mulchDomains: config.mulch.enabled ? config.mulch.domains : [],
			parentAgent: parentAgent,
			depth,
			canSpawn: agentDef.canSpawn,
			capability,
			baseDefinition,
		};

		try {
			await writeOverlay(worktreePath, overlayConfig, config.project.root);
		} catch (err) {
			// Clean up the orphaned worktree created in step 6 (overstory-p4st)
			try {
				const cleanupProc = Bun.spawn(["git", "worktree", "remove", "--force", worktreePath], {
					cwd: config.project.root,
					stdout: "pipe",
					stderr: "pipe",
				});
				await cleanupProc.exited;
			} catch {
				// Best-effort cleanup; the original error is more important
			}
			throw err;
		}

		// 8. Deploy hooks config (capability-specific guards)
		await deployHooks(worktreePath, name, capability);

		// 9. Claim beads issue
		if (config.beads.enabled) {
			try {
				await beads.claim(taskId);
			} catch {
				// Non-fatal: issue may already be claimed
			}
		}

		// 10. Create agent identity (if new)
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

		// 11. Create tmux session running claude in interactive mode
		const tmuxSessionName = `overstory-${config.project.name}-${name}`;
		const claudeCmd = `claude --model ${agentDef.model} --dangerously-skip-permissions`;
		const pid = await createSession(tmuxSessionName, worktreePath, claudeCmd, {
			OVERSTORY_AGENT_NAME: name,
			OVERSTORY_WORKTREE_PATH: worktreePath,
		});

		// 12. Record session BEFORE sending the beacon so that hook-triggered
		// updateLastActivity() can find the entry and transition booting->working.
		// Without this, a race exists: hooks fire before the session is persisted,
		// leaving the agent stuck in "booting" (overstory-036f).
		const session: AgentSession = {
			id: `session-${Date.now()}-${name}`,
			agentName: name,
			capability,
			worktreePath,
			branchName,
			beadId: taskId,
			tmuxSession: tmuxSessionName,
			state: "booting",
			pid,
			parentAgent: parentAgent,
			depth,
			runId: null,
			startedAt: new Date().toISOString(),
			lastActivity: new Date().toISOString(),
			escalationLevel: 0,
			stalledSince: null,
		};

		store.upsert(session);

		// 12b. Send beacon prompt via tmux send-keys
		// Allow Claude Code time to initialize its TUI before sending input.
		// 3s gives the TUI enough time to render and attach its input handler.
		await Bun.sleep(3_000);
		const beacon = buildBeacon({
			agentName: name,
			capability,
			taskId,
			parentAgent,
			depth,
		});
		await sendKeys(tmuxSessionName, beacon);

		// 12c. Send a follow-up Enter after a short delay to ensure submission.
		// Claude Code's TUI may consume the first Enter during initialization,
		// leaving the beacon text visible but unsubmitted (overstory-yhv6).
		// A redundant Enter on an empty input line is harmless.
		await Bun.sleep(500);
		await sendKeys(tmuxSessionName, "");

		// 13. Output result
		const output = {
			agentName: name,
			capability,
			taskId,
			branch: branchName,
			worktree: worktreePath,
			tmuxSession: tmuxSessionName,
			pid,
		};

		if (args.includes("--json")) {
			process.stdout.write(`${JSON.stringify(output)}\n`);
		} else {
			process.stdout.write(`🚀 Agent "${name}" launched!\n`);
			process.stdout.write(`   Task:     ${taskId}\n`);
			process.stdout.write(`   Branch:   ${branchName}\n`);
			process.stdout.write(`   Worktree: ${worktreePath}\n`);
			process.stdout.write(`   Tmux:     ${tmuxSessionName}\n`);
			process.stdout.write(`   PID:      ${pid}\n`);
		}
	} finally {
		store.close();
	}
}

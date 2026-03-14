/**
 * `ov prime` command.
 *
 * Loads context for the orchestrator or a specific agent and outputs it
 * to stdout for injection into Claude Code's context via hooks.
 *
 * Called by the SessionStart hook.
 */

import { join } from "node:path";
import { loadCheckpoint } from "../agents/checkpoint.ts";
import { loadIdentity } from "../agents/identity.ts";
import { createManifestLoader } from "../agents/manifest.ts";
import { loadConfig } from "../config.ts";
import { jsonOutput } from "../json.ts";
import { printWarning } from "../logging/color.ts";
import { createMetricsStore } from "../metrics/store.ts";
import { createMulchClient } from "../mulch/client.ts";
import { openSessionStore } from "../sessions/compat.ts";
import type { AgentIdentity, AgentManifest, SessionCheckpoint, SessionMetrics } from "../types.ts";
import { getCurrentSessionName } from "../worktree/tmux.ts";
import { OVERSTORY_GITIGNORE } from "./init.ts";

export interface PrimeOptions {
	agent?: string;
	compact?: boolean;
	json?: boolean;
	/** Override the instruction path referenced in agent activation context. Defaults to ".claude/CLAUDE.md". */
	instructionPath?: string;
}

/**
 * Format the agent manifest section for output.
 * @internal Exported for testing.
 */
export function formatManifest(manifest: AgentManifest): string {
	const lines: string[] = [];
	for (const [name, def] of Object.entries(manifest.agents)) {
		const caps = def.capabilities.join(", ");
		const spawn = def.canSpawn ? " (can spawn)" : "";
		lines.push(`- **${name}** [${def.model}]: ${caps}${spawn}`);
	}
	return lines.length > 0 ? lines.join("\n") : "No agents registered.";
}

/**
 * Format recent session metrics for output.
 * @internal Exported for testing.
 */
export function formatMetrics(sessions: SessionMetrics[]): string {
	if (sessions.length === 0) {
		return "No recent sessions.";
	}

	const lines: string[] = [];
	for (const s of sessions) {
		const status = s.completedAt !== null ? "completed" : "in-progress";
		const duration = s.durationMs > 0 ? ` (${Math.round(s.durationMs / 1000)}s)` : "";
		const merge = s.mergeResult !== null ? ` [${s.mergeResult}]` : "";
		lines.push(`- ${s.agentName} (${s.capability}): ${s.taskId} — ${status}${duration}${merge}`);
	}
	return lines.join("\n");
}

/**
 * Format agent identity for output.
 */
function formatIdentity(identity: AgentIdentity): string {
	const lines: string[] = [];
	lines.push(`Name: ${identity.name}`);
	lines.push(`Capability: ${identity.capability}`);
	lines.push(`Sessions completed: ${identity.sessionsCompleted}`);

	if (identity.expertiseDomains.length > 0) {
		lines.push(`Expertise: ${identity.expertiseDomains.join(", ")}`);
	}

	if (identity.recentTasks.length > 0) {
		lines.push("Recent tasks:");
		for (const task of identity.recentTasks) {
			lines.push(`  - ${task.taskId}: ${task.summary} (${task.completedAt})`);
		}
	}

	return lines.join("\n");
}

/**
 * Format checkpoint recovery section for compact priming.
 */
function formatCheckpointRecovery(checkpoint: SessionCheckpoint): string {
	const lines: string[] = [];
	lines.push("\n## Session Recovery");
	lines.push("");
	lines.push("You are resuming from a previous session that was compacted.");
	lines.push("");
	lines.push(`**Progress so far:** ${checkpoint.progressSummary}`);
	lines.push(`**Files modified:** ${checkpoint.filesModified.join(", ") || "none"}`);
	lines.push(`**Pending work:** ${checkpoint.pendingWork}`);
	lines.push(`**Branch:** ${checkpoint.currentBranch}`);
	return lines.join("\n");
}

/**
 * Auto-heal .overstory/.gitignore if its content differs from the template.
 * Ensures existing projects get updated gitignore on session start.
 */
async function healGitignore(overstoryDir: string): Promise<void> {
	const gitignorePath = join(overstoryDir, ".gitignore");
	try {
		const current = await Bun.file(gitignorePath).text();
		if (current === OVERSTORY_GITIGNORE) {
			return; // Already up to date
		}
	} catch {
		// File does not exist — write it fresh
	}
	await Bun.write(gitignorePath, OVERSTORY_GITIGNORE);
}

/**
 * Prime command entry point.
 *
 * Gathers project state and outputs context to stdout for injection
 * into Claude Code's context.
 *
 * @param opts - Command options
 */
export async function primeCommand(opts: PrimeOptions): Promise<void> {
	const agentName = opts.agent ?? null;
	const compact = opts.compact ?? false;
	const useJson = opts.json ?? false;
	const instructionPath = opts.instructionPath ?? ".claude/CLAUDE.md";

	// 1. Load config
	const config = await loadConfig(process.cwd());

	// 2. Auto-heal .overstory/.gitignore
	const overstoryDir = join(config.project.root, ".overstory");
	await healGitignore(overstoryDir);

	// 3. Load mulch expertise (optional — skip on failure)
	let expertiseOutput: string | null = null;
	if (!compact && config.mulch.enabled) {
		try {
			const mulch = createMulchClient(config.project.root);
			const domains = config.mulch.domains.length > 0 ? config.mulch.domains : undefined;
			expertiseOutput = await mulch.prime(domains, config.mulch.primeFormat);
		} catch {
			// Mulch is optional — silently skip if it fails
		}
	}

	// 4. Output context (orchestrator or agent)
	if (useJson) {
		// Capture context as text, wrap in JSON envelope
		const capture: string[] = [];
		const origWrite = process.stdout.write.bind(process.stdout);
		process.stdout.write = (chunk: string | Uint8Array) => {
			capture.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
			return true;
		};
		try {
			if (agentName !== null) {
				await outputAgentContext(config, agentName, compact, expertiseOutput, instructionPath);
			} else {
				await outputOrchestratorContext(config, compact, expertiseOutput);
			}
		} finally {
			process.stdout.write = origWrite;
		}
		jsonOutput("prime", {
			agent: agentName,
			compact,
			context: capture.join(""),
		});
	} else {
		if (agentName !== null) {
			await outputAgentContext(config, agentName, compact, expertiseOutput, instructionPath);
		} else {
			await outputOrchestratorContext(config, compact, expertiseOutput);
		}
	}
}

/**
 * Output context for a specific agent.
 */
async function outputAgentContext(
	config: Awaited<ReturnType<typeof loadConfig>>,
	agentName: string,
	compact: boolean,
	expertiseOutput: string | null,
	instructionPath: string,
): Promise<void> {
	const sections: string[] = [];

	sections.push(`# Agent Context: ${agentName}`);

	// Check if the agent exists in the SessionStore or has an identity file
	const overstoryDir = join(config.project.root, ".overstory");
	const { store } = openSessionStore(overstoryDir);
	let sessionExists = false;
	let boundSession: { taskId: string } | null = null;
	try {
		const agentSession = store.getByName(agentName);
		sessionExists = agentSession !== null;
		if (
			agentSession &&
			agentSession.state !== "completed" &&
			agentSession.state !== "zombie" &&
			agentSession.taskId
		) {
			boundSession = { taskId: agentSession.taskId };
		}
	} finally {
		store.close();
	}

	// Identity section
	let identity: AgentIdentity | null = null;
	try {
		const baseDir = join(config.project.root, ".overstory", "agents");
		identity = await loadIdentity(baseDir, agentName);
	} catch {
		// Identity may not exist yet
	}

	// Warn if agent is completely unknown (no session and no identity)
	if (!sessionExists && identity === null) {
		printWarning(`agent "${agentName}" not found in sessions or identity store.`);
	}

	sections.push("\n## Identity");
	if (identity !== null) {
		sections.push(formatIdentity(identity));
	} else {
		sections.push("New agent - no prior sessions");
	}

	// Activation context: if agent has a bound task, inject it
	if (boundSession) {
		sections.push("\n## Activation");
		sections.push(`You have a bound task: **${boundSession.taskId}**`);
		sections.push(`Read your overlay at \`${instructionPath}\` and begin working immediately.`);
		sections.push("Do not wait for dispatch mail. Your assignment was bound at spawn time.");
	}

	// In compact mode, check for checkpoint recovery
	if (compact) {
		const baseDir = join(config.project.root, ".overstory", "agents");
		const checkpoint = await loadCheckpoint(baseDir, agentName);
		if (checkpoint !== null) {
			sections.push(formatCheckpointRecovery(checkpoint));
		}
	}

	// In compact mode, skip expertise
	if (!compact && expertiseOutput !== null) {
		sections.push("\n## Expertise");
		sections.push(expertiseOutput.trim());
	}

	process.stdout.write(`${sections.join("\n")}\n`);
}

/**
 * Output context for the orchestrator.
 */
async function outputOrchestratorContext(
	config: Awaited<ReturnType<typeof loadConfig>>,
	compact: boolean,
	expertiseOutput: string | null,
): Promise<void> {
	// Register orchestrator tmux session for reverse-nudge (agents → orchestrator)
	try {
		const tmuxSession = await getCurrentSessionName();
		if (tmuxSession) {
			const regPath = join(config.project.root, ".overstory", "orchestrator-tmux.json");
			await Bun.write(
				regPath,
				`${JSON.stringify({ tmuxSession, registeredAt: new Date().toISOString() }, null, "\t")}\n`,
			);
		}
	} catch {
		// Tmux detection is optional — silently skip
	}

	// Record the orchestrator's current branch for merge targeting
	let sessionBranch: string | null = null;
	try {
		const branchProc = Bun.spawn(["git", "symbolic-ref", "--short", "HEAD"], {
			cwd: config.project.root,
			stdout: "pipe",
			stderr: "pipe",
		});
		const branchExit = await branchProc.exited;
		if (branchExit === 0) {
			const branch = (await new Response(branchProc.stdout).text()).trim();
			if (branch) {
				sessionBranch = branch;
				const sessionBranchPath = join(config.project.root, ".overstory", "session-branch.txt");
				await Bun.write(sessionBranchPath, `${branch}\n`);
			}
		}
	} catch {
		// Branch detection is optional — silently skip
	}

	const sections: string[] = [];

	// Project section
	sections.push("# Overstory Context");
	sections.push(`\n## Project: ${config.project.name}`);
	sections.push(`Canonical branch: ${config.project.canonicalBranch}`);
	if (sessionBranch && sessionBranch !== config.project.canonicalBranch) {
		sections.push(`Session branch: ${sessionBranch} (merge target)`);
	}
	sections.push(`Max concurrent agents: ${config.agents.maxConcurrent}`);
	sections.push(`Max depth: ${config.agents.maxDepth}`);

	// Agent manifest section
	sections.push("\n## Agent Manifest");
	try {
		const manifestPath = join(config.project.root, config.agents.manifestPath);
		const baseDir = join(config.project.root, config.agents.baseDir);
		const loader = createManifestLoader(manifestPath, baseDir);
		const manifest = await loader.load();
		sections.push(formatManifest(manifest));
	} catch {
		sections.push("No agent manifest found.");
	}

	// In compact mode, skip metrics and expertise
	if (!compact) {
		// Recent activity section
		sections.push("\n## Recent Activity");
		try {
			const metricsPath = join(config.project.root, ".overstory", "metrics.db");
			const store = createMetricsStore(metricsPath);
			try {
				const sessions = store.getRecentSessions(5);
				sections.push(formatMetrics(sessions));
			} finally {
				store.close();
			}
		} catch {
			sections.push("No metrics available.");
		}

		// Expertise section
		if (expertiseOutput !== null) {
			sections.push("\n## Expertise");
			sections.push(expertiseOutput.trim());
		}
	}

	process.stdout.write(`${sections.join("\n")}\n`);
}

/**
 * Runtime swap module for rate-limited agents.
 *
 * When an agent hits a rate limit and config.rateLimit.behavior === "swap",
 * this module orchestrates the transition to a different runtime (e.g. Claude → Codex):
 *
 * 1. Builds handoff context (git state + last N conversation turns from JSONL)
 * 2. Writes HANDOFF.md to the worktree
 * 3. Kills the old tmux session
 * 4. Deploys overlay for the new runtime's instruction path
 * 5. Spawns a new tmux session with the target runtime
 * 6. Updates the session store
 */

import { join } from "node:path";
import { initiateHandoff } from "../agents/lifecycle.ts";
import { nudgeAgent } from "../commands/nudge.ts";
import { getRuntime } from "../runtimes/registry.ts";
import { openSessionStore } from "../sessions/compat.ts";
import type { AgentSession, OverstoryConfig } from "../types.ts";
import { createSession, killSession } from "../worktree/tmux.ts";

export interface SwapOptions {
	/** Project root (contains .overstory/). */
	root: string;
	/** The session being swapped. */
	session: AgentSession;
	/** Runtime name to swap TO (e.g. "codex"). */
	targetRuntimeName: string;
	/** Full config. */
	config: OverstoryConfig;
	/** Last N lines captured from tmux pane. */
	paneContext: string | null;
	/** DI overrides for testing. */
	_tmux?: {
		killSession: (name: string) => Promise<void>;
		createSession: (
			name: string,
			cwd: string,
			cmd: string,
			env?: Record<string, string>,
		) => Promise<number>;
	};
}

export interface SwapResult {
	success: boolean;
	newTmuxSession: string | null;
	newPid: number | null;
	newRuntime: string;
	error?: string;
}

const MAX_HANDOFF_CHARS = 40_000;
const MAX_RECENT_TURNS = 10;

/**
 * Swap a rate-limited agent to a different runtime.
 */
export async function swapRuntime(options: SwapOptions): Promise<SwapResult> {
	const { root, session, targetRuntimeName, config, paneContext } = options;
	const tmux = options._tmux ?? { killSession, createSession };

	// Guard: no-op if swapping to the same runtime
	if (targetRuntimeName === session.runtime) {
		return {
			success: false,
			newTmuxSession: null,
			newPid: null,
			newRuntime: targetRuntimeName,
			error: "Target runtime is the same as current runtime",
		};
	}

	const targetRuntime = getRuntime(targetRuntimeName, config, session.capability);
	const oldRuntime = getRuntime(session.runtime, config, session.capability);
	const overstoryDir = join(root, ".overstory");

	try {
		// 1. Build handoff context
		const gitContext = await getGitContext(session.worktreePath);

		// Try runtime-native conversation extraction, fall back to tmux pane
		let conversationContext = "";
		if (oldRuntime.extractConversation) {
			conversationContext = await oldRuntime.extractConversation(
				session.worktreePath,
				session.id,
				MAX_RECENT_TURNS,
			);
		}
		if (!conversationContext && paneContext) {
			conversationContext = `## Terminal Output (tmux fallback)\n\`\`\`\n${paneContext.slice(-10_000)}\n\`\`\``;
		}

		// If conversation context was built from pane, don't duplicate it
		const usedPaneFallback =
			!oldRuntime.extractConversation || !conversationContext.includes("###");
		const handoffMd = buildHandoffDocument({
			fromRuntime: session.runtime,
			toRuntime: targetRuntimeName,
			taskId: session.taskId,
			branchName: session.branchName,
			gitContext,
			conversationContext,
			paneContext: usedPaneFallback ? null : paneContext,
		});

		// 2. Write HANDOFF.md to worktree
		await Bun.write(join(session.worktreePath, "HANDOFF.md"), handoffMd);

		// 3. Create handoff record
		await initiateHandoff({
			agentsDir: join(overstoryDir, "agents"),
			agentName: session.agentName,
			sessionId: session.id,
			taskId: session.taskId,
			reason: "rate_limit_swap",
			progressSummary: `Rate limit swap: ${session.runtime} → ${targetRuntimeName}`,
			pendingWork: "Continue work from HANDOFF.md context",
			currentBranch: session.branchName,
			filesModified: gitContext.modifiedFiles,
			mulchDomains: [],
		});

		// 4. Kill old tmux session
		try {
			await tmux.killSession(session.tmuxSession);
		} catch {
			// Session may already be dead — continue
		}

		// 5. Deploy overlay for new runtime
		const oldOverlayPath = join(session.worktreePath, oldRuntime.instructionPath);
		const newOverlayPath = join(session.worktreePath, targetRuntime.instructionPath);
		let overlayContent = "";
		try {
			const file = Bun.file(oldOverlayPath);
			if (await file.exists()) {
				overlayContent = await file.text();
			}
		} catch {
			// Old overlay not found — proceed with empty
		}

		// Prepend handoff reference to overlay
		const handoffRef =
			"# IMPORTANT: Read HANDOFF.md first\n\n" +
			"You are continuing work from a previous agent session that was rate-limited.\n" +
			"Read `HANDOFF.md` in this directory for full context before starting.\n\n---\n\n";
		await Bun.write(newOverlayPath, handoffRef + overlayContent);

		// 6. Spawn new tmux session
		const newTmuxSession = `${session.tmuxSession}-${targetRuntimeName}`;
		const env: Record<string, string> = {
			...targetRuntime.buildEnv({
				model: config.runtime?.default === targetRuntimeName ? "default" : "default",
				env: {},
			}),
			OVERSTORY_AGENT_NAME: session.agentName,
		};

		const spawnCmd = targetRuntime.buildSpawnCommand({
			model: "default",
			permissionMode: "bypass",
			cwd: session.worktreePath,
			env,
		});

		const newPid = await tmux.createSession(newTmuxSession, session.worktreePath, spawnCmd, env);

		// 7. Update session store
		const { store } = openSessionStore(overstoryDir);
		store.upsert({
			...session,
			runtime: targetRuntime.id,
			tmuxSession: newTmuxSession,
			pid: newPid,
			rateLimitedSince: null,
			state: "booting",
			lastActivity: new Date().toISOString(),
			escalationLevel: 0,
			stalledSince: null,
		});
		store.close();

		// 8. Nudge new session to check mail
		try {
			await nudgeAgent(root, session.agentName, `ov mail check --agent ${session.agentName}`, true);
		} catch {
			// Nudge failure is non-fatal
		}

		return {
			success: true,
			newTmuxSession,
			newPid,
			newRuntime: targetRuntime.id,
		};
	} catch (err) {
		return {
			success: false,
			newTmuxSession: null,
			newPid: null,
			newRuntime: targetRuntimeName,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

// ─── Shared Helpers ──────────────────────────────────────────────────────────

/**
 * Read only the last `maxBytes` of a file and split into lines.
 * Drops the first line (likely truncated by byte boundary).
 * Safe to call on nonexistent files — returns [].
 */
export async function tailReadLines(filePath: string, maxBytes = 100_000): Promise<string[]> {
	const file = Bun.file(filePath);
	if (!(await file.exists())) return [];
	const size = file.size;
	const blob = size > maxBytes ? file.slice(size - maxBytes) : file;
	const text = await blob.text();
	const lines = text.split("\n").filter((l) => l.trim().length > 0);
	if (size > maxBytes) lines.shift();
	return lines;
}

// ─── Private Helpers ─────────────────────────────────────────────────────────

interface GitContext {
	diffStat: string;
	logOneline: string;
	modifiedFiles: string[];
}

async function getGitContext(worktreePath: string): Promise<GitContext> {
	const run = async (args: string[]): Promise<string> => {
		const proc = Bun.spawn(["git", ...args], {
			cwd: worktreePath,
			stdout: "pipe",
			stderr: "pipe",
		});
		const exitCode = await proc.exited;
		if (exitCode !== 0) return "";
		return new Response(proc.stdout).text();
	};

	const [diffStat, logOneline, nameOnly] = await Promise.all([
		run(["diff", "--stat"]),
		run(["log", "--oneline", "-10"]),
		run(["diff", "--name-only"]),
	]);

	return {
		diffStat: diffStat.trim(),
		logOneline: logOneline.trim(),
		modifiedFiles: nameOnly
			.trim()
			.split("\n")
			.filter((f) => f.length > 0),
	};
}

/**
 * Extract conversation from Claude JSONL transcripts.
 * @deprecated Use ClaudeRuntime.extractConversation() directly. Kept for test compatibility.
 */
export async function extractRecentTurns(
	worktreePath: string,
	sessionId: string,
	maxTurns: number,
): Promise<string> {
	const { ClaudeRuntime } = await import("../runtimes/claude.ts");
	const runtime = new ClaudeRuntime();
	return runtime.extractConversation(worktreePath, sessionId, maxTurns);
}

export function buildHandoffDocument(opts: {
	fromRuntime: string;
	toRuntime: string;
	taskId: string;
	branchName: string;
	gitContext: GitContext;
	conversationContext: string;
	paneContext: string | null;
}): string {
	let doc = `# Handoff: ${opts.fromRuntime} → ${opts.toRuntime} (rate limit swap)

You are continuing work from a previous ${opts.fromRuntime} session that hit rate limits.
**Do NOT restart from scratch.** Review the context below and continue where the previous agent left off.

Use \`ov mail check --agent $OVERSTORY_AGENT_NAME\` to check for messages.
Use \`ov mail send\` to communicate with coordinator and other agents.

## Task
- **ID:** ${opts.taskId}
- **Branch:** ${opts.branchName}

## Recent Git History
\`\`\`
${opts.gitContext.logOneline || "(no commits yet)"}
\`\`\`

## Uncommitted Changes
\`\`\`
${opts.gitContext.diffStat || "(clean working tree)"}
\`\`\`
`;

	if (opts.conversationContext) {
		doc += `\n## Previous Conversation (last ${MAX_RECENT_TURNS} turns)\n\n${opts.conversationContext}\n`;
	}

	if (opts.paneContext) {
		const trimmedPane = opts.paneContext.slice(-3000);
		doc += `\n## Last Terminal Output\n\`\`\`\n${trimmedPane}\n\`\`\`\n`;
	}

	doc += `\n## Instructions\n\nContinue the task. Check git diff for current state. Read your overlay/AGENTS.md for the original task assignment.\n`;

	// Truncate if too long
	if (doc.length > MAX_HANDOFF_CHARS) {
		doc = `${doc.slice(0, MAX_HANDOFF_CHARS)}\n\n[...truncated due to size limit]\n`;
	}

	return doc;
}

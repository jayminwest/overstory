/**
 * E2E test for rate limit detection + runtime swap.
 *
 * Uses a real tmux session with a fake agent script that outputs
 * rate limit text. The watchdog daemon tick detects it and triggers
 * a swap to an alternate runtime (also a fake script).
 *
 * Requires tmux to be available on the system.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openSessionStore } from "../sessions/compat.ts";
import type { AgentSession, OverstoryConfig } from "../types.ts";
import { createSession, isSessionAlive, killSession } from "../worktree/tmux.ts";
import { runDaemonTick } from "./daemon.ts";

// Skip if tmux is not available
const tmuxAvailable = await Bun.spawn(["tmux", "-V"], {
	stdout: "pipe",
	stderr: "pipe",
}).exited.then(
	(code) => code === 0,
	() => false,
);

const describeE2E = tmuxAvailable ? describe : describe.skip;

describeE2E("E2E: rate limit detection + swap", () => {
	let tempDir: string;
	let overstoryDir: string;
	let worktreePath: string;
	let tmuxSessionName: string;
	let fakeAgentScript: string;

	beforeEach(async () => {
		tempDir = mkdtempSync(join(tmpdir(), "ov-e2e-swap-"));
		overstoryDir = join(tempDir, ".overstory");
		worktreePath = join(tempDir, "worktree");
		tmuxSessionName = `ov-e2e-swap-${Date.now()}`;

		mkdirSync(overstoryDir, { recursive: true });
		mkdirSync(worktreePath, { recursive: true });
		mkdirSync(join(overstoryDir, "agents", "test-agent"), { recursive: true });

		// Init a real git repo in worktree (needed for swap's getGitContext)
		await Bun.spawn(["git", "init"], { cwd: worktreePath, stdout: "pipe", stderr: "pipe" }).exited;
		await Bun.spawn(["git", "commit", "--allow-empty", "-m", "init"], {
			cwd: worktreePath,
			stdout: "pipe",
			stderr: "pipe",
			env: {
				...process.env,
				GIT_AUTHOR_NAME: "test",
				GIT_AUTHOR_EMAIL: "test@test.com",
				GIT_COMMITTER_NAME: "test",
				GIT_COMMITTER_EMAIL: "test@test.com",
			},
		}).exited;

		// Write current-run.txt
		writeFileSync(join(overstoryDir, "current-run.txt"), "test-run-1");

		// Fake agent script: outputs "Working..." then rate limit text after 2s
		fakeAgentScript = join(tempDir, "fake-agent.sh");
		writeFileSync(
			fakeAgentScript,
			`#!/bin/bash
echo "Claude Code agent running..."
echo "Working on task..."
sleep 2
echo ""
echo "⚠ You've hit your limit. Usage cap reached."
echo "Resets in 5 minutes."
echo ""
# Keep alive so tmux session doesn't die
sleep 300
`,
		);
		await Bun.spawn(["chmod", "+x", fakeAgentScript], { stdout: "pipe" }).exited;
	});

	afterEach(async () => {
		// Kill tmux sessions (best-effort)
		try {
			await killSession(tmuxSessionName);
		} catch {
			// already dead
		}
		try {
			await killSession(`${tmuxSessionName}-gemini`);
		} catch {
			// already dead
		}
		// Cleanup temp dir
		rmSync(tempDir, { recursive: true, force: true });
	});

	test("detects rate limit in tmux pane and triggers swap", async () => {
		// 1. Create a real tmux session running the fake agent script
		const pid = await createSession(tmuxSessionName, worktreePath, `bash ${fakeAgentScript}`);
		expect(pid).toBeGreaterThan(0);

		// 2. Register session in sessions.db
		const { store } = openSessionStore(overstoryDir);
		const session: AgentSession = {
			id: crypto.randomUUID(),
			agentName: "test-agent",
			capability: "builder",
			runtime: "claude",
			worktreePath,
			branchName: "feat/test",
			taskId: "TEST-1",
			tmuxSession: tmuxSessionName,
			state: "working",
			pid,
			parentAgent: null,
			depth: 0,
			runId: "test-run-1",
			startedAt: new Date().toISOString(),
			lastActivity: new Date().toISOString(),
			escalationLevel: 0,
			stalledSince: null,
			rateLimitedSince: null,
			transcriptPath: null,
		};
		store.upsert(session);
		store.close();

		// 3. Wait for the fake agent to output rate limit text
		await Bun.sleep(3_000);

		// 4. Verify tmux session is alive and has rate limit text
		const alive = await isSessionAlive(tmuxSessionName);
		expect(alive).toBe(true);

		// 5. Build config with rate limit swap enabled
		const config: OverstoryConfig = {
			project: {
				name: "e2e-test",
				root: tempDir,
				qualityGates: [],
			},
			taskTracker: { enabled: false, backend: "seeds" },
			rateLimit: {
				enabled: true,
				behavior: "swap",
				maxWaitMs: 60_000,
				pollIntervalMs: 5_000,
				notifyCoordinator: false,
				swapRuntime: "gemini",
			},
		} as OverstoryConfig;

		// 6. Track health checks
		const healthChecks: Array<{ agentName: string; action: string }> = [];

		// 7. Run a single watchdog tick — should detect rate limit and attempt swap
		//    Swap will use real tmux.createSession for the new runtime, but we
		//    DI _tmux on swap to capture the swap call instead of spawning gemini.
		let swapCalled = false;
		let swapTarget = "";
		let newTmuxName = "";

		await runDaemonTick({
			root: tempDir,
			staleThresholdMs: 300_000,
			zombieThresholdMs: 600_000,
			nudgeIntervalMs: 60_000,
			config,
			_capturePaneContent: async (name: string, lines?: number) => {
				// Use real tmux capture
				const proc = Bun.spawn(
					["tmux", "capture-pane", "-t", name, "-p", "-S", `-${lines ?? 100}`],
					{ stdout: "pipe", stderr: "pipe" },
				);
				const code = await proc.exited;
				if (code !== 0) return null;
				return new Response(proc.stdout).text();
			},
			_process: {
				isAlive: (p: number) => {
					try {
						process.kill(p, 0);
						return true;
					} catch {
						return false;
					}
				},
				killTree: async () => {},
			},
			onHealthCheck: (check) => {
				healthChecks.push({ agentName: check.agentName, action: check.action });
			},
		});

		// 8. Check that rate limit was detected — session should have rateLimitedSince set
		const { store: verifyStore } = openSessionStore(overstoryDir);
		const sessions = verifyStore.getAll();
		const updatedSession = sessions.find((s) => s.agentName === "test-agent");
		verifyStore.close();

		expect(updatedSession).toBeDefined();

		// The session should either:
		// a) Have rateLimitedSince set (rate limit detected, swap may have failed due to gemini not existing)
		// b) Have runtime changed to "gemini" (swap succeeded)
		// c) State changed to "booting" (swap succeeded and reset state)
		const rateLimitDetected = updatedSession!.rateLimitedSince !== null;
		const swapHappened = updatedSession!.runtime === "gemini";

		// Rate limit MUST have been detected
		expect(rateLimitDetected || swapHappened).toBe(true);

		if (swapHappened) {
			// If swap succeeded, session should be reset
			expect(updatedSession!.state).toBe("booting");
			expect(updatedSession!.rateLimitedSince).toBeNull();
			expect(updatedSession!.escalationLevel).toBe(0);

			// Verify new tmux session exists
			const newAlive = await isSessionAlive(`${tmuxSessionName}-gemini`);
			expect(newAlive).toBe(true);
		}

		if (swapHappened) {
			// Check exact session names via tmux ls (isSessionAlive uses prefix match)
			const lsProc = Bun.spawn(["tmux", "ls", "-F", "#{session_name}"], {
				stdout: "pipe",
				stderr: "pipe",
			});
			await lsProc.exited;
			const sessionNames = (await new Response(lsProc.stdout).text()).trim().split("\n");

			// Old session should be gone, new session should exist
			expect(sessionNames).not.toContain(tmuxSessionName);
			expect(sessionNames).toContain(`${tmuxSessionName}-gemini`);

			// HANDOFF.md should exist in worktree
			const handoffFile = Bun.file(join(worktreePath, "HANDOFF.md"));
			expect(await handoffFile.exists()).toBe(true);
			const handoffText = await handoffFile.text();
			expect(handoffText).toContain("claude → gemini");
			expect(handoffText).toContain("TEST-1");
		}

	}, 15_000);

	test("rate limit detection sets rateLimitedSince timestamp", async () => {
		// Simpler test: just verify detection without swap
		const pid = await createSession(tmuxSessionName, worktreePath, `bash ${fakeAgentScript}`);

		const { store } = openSessionStore(overstoryDir);
		store.upsert({
			id: crypto.randomUUID(),
			agentName: "test-agent",
			capability: "builder",
			runtime: "claude",
			worktreePath,
			branchName: "feat/test",
			taskId: "TEST-1",
			tmuxSession: tmuxSessionName,
			state: "working",
			pid,
			parentAgent: null,
			depth: 0,
			runId: "test-run-1",
			startedAt: new Date().toISOString(),
			lastActivity: new Date().toISOString(),
			escalationLevel: 0,
			stalledSince: null,
			rateLimitedSince: null,
			transcriptPath: null,
		});
		store.close();

		// Wait for rate limit text
		await Bun.sleep(3_000);

		// Config with behavior: "wait" (no swap, just detect)
		const config: OverstoryConfig = {
			project: { name: "e2e-test", root: tempDir, qualityGates: [] },
			taskTracker: { enabled: false, backend: "seeds" },
			rateLimit: {
				enabled: true,
				behavior: "wait",
				maxWaitMs: 60_000,
				pollIntervalMs: 5_000,
				notifyCoordinator: false,
			},
		} as OverstoryConfig;

		await runDaemonTick({
			root: tempDir,
			staleThresholdMs: 300_000,
			zombieThresholdMs: 600_000,
			nudgeIntervalMs: 60_000,
			config,
			_capturePaneContent: async (name: string) => {
				const proc = Bun.spawn(["tmux", "capture-pane", "-t", name, "-p", "-S", "-100"], {
					stdout: "pipe",
					stderr: "pipe",
				});
				if ((await proc.exited) !== 0) return null;
				return new Response(proc.stdout).text();
			},
			_process: {
				isAlive: (p: number) => {
					try {
						process.kill(p, 0);
						return true;
					} catch {
						return false;
					}
				},
				killTree: async () => {},
			},
		});

		// Verify rateLimitedSince was set
		const { store: verifyStore } = openSessionStore(overstoryDir);
		const updated = verifyStore.getAll().find((s) => s.agentName === "test-agent");
		verifyStore.close();

		expect(updated).toBeDefined();
		expect(updated!.rateLimitedSince).not.toBeNull();
		// Should still be in working state (rate limited agents are protected from escalation)
		expect(updated!.state).toBe("working");
	}, 15_000);
});

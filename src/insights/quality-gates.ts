/**
 * Quality-gate runner used at session-end to determine the outcome status
 * threaded into mulch record writes (success / partial / failure).
 *
 * Used by `src/commands/log.ts` session-end handler. Cheap precheck via
 * `hasWorkToVerify()` lets read-only agents (scout/reviewer) skip gate
 * execution entirely when no commits or uncommitted changes exist.
 */

import type { QualityGate } from "../types.ts";

export interface QualityGateResult {
	name: string;
	command: string;
	passed: boolean;
	durationMs: number;
	exitCode: number;
}

export interface QualityGateOutcome {
	status: "success" | "partial" | "failure";
	results: QualityGateResult[];
	totalDurationMs: number;
}

const DEFAULT_TIMEOUT_MS = 300_000;

/**
 * Run each configured quality gate against `cwd` and aggregate the result.
 *
 * Returns null when `gates` is empty.
 *
 * - all passed -> "success"
 * - none passed -> "failure"
 * - mixed -> "partial"
 */
export async function runQualityGates(
	gates: QualityGate[],
	cwd: string,
	options?: { timeoutMs?: number },
): Promise<QualityGateOutcome | null> {
	if (gates.length === 0) return null;

	const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const results: QualityGateResult[] = [];
	const totalStart = Date.now();

	for (const gate of gates) {
		const argv = gate.command.split(/\s+/).filter((s) => s.length > 0);
		if (argv.length === 0) {
			results.push({
				name: gate.name,
				command: gate.command,
				passed: false,
				durationMs: 0,
				exitCode: -1,
			});
			continue;
		}

		const start = Date.now();
		let proc: ReturnType<typeof Bun.spawn> | undefined;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let timedOut = false;
		try {
			proc = Bun.spawn(argv, {
				cwd,
				stdout: "ignore",
				stderr: "ignore",
			});
			timer = setTimeout(() => {
				timedOut = true;
				try {
					proc?.kill();
				} catch {
					// best-effort kill
				}
			}, timeoutMs);
			const exitCode = await proc.exited;
			const durationMs = Date.now() - start;
			results.push({
				name: gate.name,
				command: gate.command,
				passed: !timedOut && exitCode === 0,
				durationMs,
				exitCode: timedOut ? -1 : exitCode,
			});
		} catch {
			results.push({
				name: gate.name,
				command: gate.command,
				passed: false,
				durationMs: Date.now() - start,
				exitCode: -1,
			});
		} finally {
			if (timer) clearTimeout(timer);
		}
	}

	const passedCount = results.filter((r) => r.passed).length;
	let status: "success" | "partial" | "failure";
	if (passedCount === results.length) {
		status = "success";
	} else if (passedCount === 0) {
		status = "failure";
	} else {
		status = "partial";
	}

	return {
		status,
		results,
		totalDurationMs: Date.now() - totalStart,
	};
}

/**
 * Cheap precheck: returns true when the worktree has commits beyond `baseRef`
 * or any uncommitted modifications. Used to skip gate execution for read-only
 * agents that produced no work.
 *
 * Fails open: if HEAD or `baseRef` cannot be resolved, returns true so that
 * gates still run rather than silently skipping.
 */
export async function hasWorkToVerify(cwd: string, baseRef = "main"): Promise<boolean> {
	const head = await runGit(cwd, ["rev-parse", "--verify", "HEAD"]);
	const base = await runGit(cwd, ["rev-parse", "--verify", baseRef]);
	if (head.exitCode !== 0 || base.exitCode !== 0) return true;

	const ahead = await runGit(cwd, ["rev-list", "--count", `${baseRef}..HEAD`]);
	if (ahead.exitCode === 0) {
		const count = Number.parseInt(ahead.stdout.trim(), 10);
		if (Number.isFinite(count) && count > 0) return true;
	}

	const status = await runGit(cwd, ["status", "--porcelain"]);
	if (status.exitCode === 0 && status.stdout.trim().length > 0) return true;

	return false;
}

async function runGit(cwd: string, args: string[]): Promise<{ stdout: string; exitCode: number }> {
	try {
		const proc = Bun.spawn(["git", ...args], {
			cwd,
			stdout: "pipe",
			stderr: "ignore",
		});
		const stdout = await new Response(proc.stdout).text();
		const exitCode = await proc.exited;
		return { stdout, exitCode };
	} catch {
		return { stdout: "", exitCode: -1 };
	}
}

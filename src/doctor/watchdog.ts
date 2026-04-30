import { existsSync } from "node:fs";
import { stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { getRuntime } from "../runtimes/registry.ts";
import { openSessionStore } from "../sessions/compat.ts";
import { findRunningWatchdogProcesses } from "../utils/process-scan.ts";
import { isProcessRunning } from "../watchdog/health.ts";
import type { DoctorCheck, DoctorCheckFn } from "./types.ts";

/**
 * Watchdog subsystem health checks.
 * Validates PID file integrity, process liveness, and tier availability.
 */
export const checkWatchdog: DoctorCheckFn = async (
	config,
	overstoryDir,
): Promise<DoctorCheck[]> => {
	const checks: DoctorCheck[] = [];

	// If tier0 is disabled, skip all checks with a single pass result
	if (!config.watchdog.tier0Enabled) {
		checks.push({
			name: "watchdog disabled",
			category: "watchdog",
			status: "pass",
			message: "Watchdog daemon is disabled (tier0Enabled: false)",
		});
		return checks;
	}

	const pidFilePath = join(overstoryDir, "watchdog.pid");

	// Check 1: PID file exists and is readable
	if (!existsSync(pidFilePath)) {
		checks.push({
			name: "watchdog pid file",
			category: "watchdog",
			status: "warn",
			message: "Watchdog PID file not found — daemon may not be running",
		});
	} else {
		// Check 2: PID file not corrupted
		const pidText = await Bun.file(pidFilePath).text();
		const pid = Number.parseInt(pidText.trim(), 10);

		if (Number.isNaN(pid) || pid <= 0) {
			checks.push({
				name: "watchdog pid integrity",
				category: "watchdog",
				status: "fail",
				message: "Watchdog PID file is corrupted",
				details: [`Raw content: ${pidText.trim()}`],
				fixable: true,
				fix: async () => {
					await unlink(pidFilePath);
					return ["Removed corrupted watchdog PID file"];
				},
			});
		} else {
			// Check 3: PID alive via isProcessRunning()
			const alive = isProcessRunning(pid);
			if (!alive) {
				checks.push({
					name: "watchdog process",
					category: "watchdog",
					status: "warn",
					message: "Watchdog process is not running (stale PID file)",
					details: [`PID: ${pid}`],
					fixable: true,
					fix: async () => {
						await unlink(pidFilePath);
						return ["Removed stale watchdog PID file"];
					},
				});
			} else {
				checks.push({
					name: "watchdog process",
					category: "watchdog",
					status: "pass",
					message: "Watchdog daemon is running",
				});
			}

			// Check 4: PID file staleness > 24h
			const fileStat = await stat(pidFilePath);
			const ageMs = Date.now() - fileStat.mtimeMs;
			const twentyFourHoursMs = 24 * 60 * 60 * 1000;
			if (ageMs > twentyFourHoursMs) {
				const ageHours = Math.round(ageMs / (1000 * 60 * 60));
				checks.push({
					name: "watchdog pid staleness",
					category: "watchdog",
					status: "warn",
					message: "Watchdog PID file is older than 24 hours",
					details: [`File age: ${ageHours} hours`],
				});
			}
		}
	}

	// Check 5: Tier 2 monitor running if tier2Enabled
	if (config.watchdog.tier2Enabled) {
		try {
			const { store } = openSessionStore(overstoryDir);
			try {
				const sessions = store.getAll();
				const monitorActive = sessions.some(
					(s) => s.capability === "monitor" && s.state !== "completed" && s.state !== "zombie",
				);
				if (!monitorActive) {
					checks.push({
						name: "tier2 monitor",
						category: "watchdog",
						status: "warn",
						message: "Tier 2 monitor is enabled but not running",
					});
				} else {
					checks.push({
						name: "tier2 monitor",
						category: "watchdog",
						status: "pass",
						message: "Tier 2 monitor agent is active",
					});
				}
			} finally {
				store.close();
			}
		} catch {
			checks.push({
				name: "tier2 monitor",
				category: "watchdog",
				status: "warn",
				message: "Tier 2 monitor check skipped — session store unavailable",
			});
		}
	}

	// Check 6: multi-daemon detection (overstory-8ef6).
	// Earlier releases had no exclusion lock, so multiple `ov watch` daemons
	// could run simultaneously. We scan the process table for `ov watch`
	// processes and flag any case with more than one. This is observational —
	// even with the lock now in place, a corrupted/missing PID file could
	// still let a foreign daemon slip past, and we want doctor to catch it.
	try {
		const watchProcs = await findRunningWatchdogProcesses();
		if (watchProcs.length > 1) {
			const lockOwner = existsSync(pidFilePath)
				? Number.parseInt((await Bun.file(pidFilePath).text()).trim(), 10)
				: Number.NaN;
			const lockOwnerLabel = Number.isFinite(lockOwner) ? `${lockOwner}` : "(none)";
			const pidList = watchProcs.map((p) => p.pid).join(", ");
			checks.push({
				name: "watchdog multi-daemon",
				category: "watchdog",
				status: "fail",
				message: `${watchProcs.length} 'ov watch' daemons running concurrently — only one should be live`,
				details: [
					`Live PIDs: ${pidList}`,
					`PID-file owner: ${lockOwnerLabel}`,
					"Run 'ov watch --kill-others' to terminate the foreign daemons.",
				],
				fixable: true,
				fix: async () => {
					const ownerPid = Number.isFinite(lockOwner) ? lockOwner : null;
					const messages: string[] = [];
					for (const proc of watchProcs) {
						if (proc.pid === ownerPid) continue;
						try {
							process.kill(proc.pid, "SIGTERM");
							messages.push(`Killed foreign watchdog PID ${proc.pid}`);
						} catch {
							messages.push(`PID ${proc.pid} already gone`);
						}
					}
					if (messages.length === 0) {
						messages.push("No foreign watchdogs to kill — fix is a no-op");
					}
					return messages;
				},
			});
		}
	} catch {
		// Process scan failure is non-fatal — leave a soft warning instead of
		// failing the whole doctor run.
		checks.push({
			name: "watchdog multi-daemon",
			category: "watchdog",
			status: "warn",
			message: "Could not scan process table for foreign 'ov watch' daemons",
		});
	}

	// Check 7: Tier 1 triage available if tier1Enabled
	if (config.watchdog.tier1Enabled) {
		try {
			getRuntime(config?.runtime?.printCommand ?? config?.runtime?.default, config);
			checks.push({
				name: "tier1 triage",
				category: "watchdog",
				status: "pass",
				message: "Tier 1 triage runtime is available",
			});
		} catch {
			checks.push({
				name: "tier1 triage",
				category: "watchdog",
				status: "warn",
				message: "Tier 1 triage is enabled but runtime is not available",
			});
		}
	}

	return checks;
};

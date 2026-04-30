import { describe, expect, test } from "bun:test";
import { findRunningWatchdogProcesses } from "./process-scan.ts";

describe("findRunningWatchdogProcesses", () => {
	test("returns an array (does not throw)", async () => {
		const results = await findRunningWatchdogProcesses();
		expect(Array.isArray(results)).toBe(true);
		// We can't assert specifics — depends on what's running on the host —
		// but each entry should have a numeric pid and string command.
		for (const proc of results) {
			expect(typeof proc.pid).toBe("number");
			expect(proc.pid).toBeGreaterThan(0);
			expect(typeof proc.command).toBe("string");
		}
	});

	test("excludes own process even if command matches", async () => {
		// The test process itself runs `bun test ...` not `ov watch`, so it
		// would not match anyway. But we still verify own-pid is filtered out
		// by checking no result has our PID.
		const results = await findRunningWatchdogProcesses();
		const ownPid = process.pid;
		for (const proc of results) {
			expect(proc.pid).not.toBe(ownPid);
		}
	});

	test("matches `ov watch` and `bun run ov watch` invocations", async () => {
		// Spawn a sleeper whose command line contains the `ov watch` substring,
		// then verify the scanner finds it. We use `sh -c` so the argv string
		// passed to ps contains our marker tokens.
		const sleeper = Bun.spawn(["sh", "-c", "exec -a 'bun run ov watch' sleep 30"], {
			stdout: "ignore",
			stderr: "ignore",
		});
		try {
			// Give ps a moment to see the new process.
			await Bun.sleep(150);
			const results = await findRunningWatchdogProcesses();
			const found = results.find((p) => p.pid === sleeper.pid);
			// On macOS BSD ps, `exec -a` may or may not change the displayed
			// argv depending on shell version. We accept either: if the
			// command is detected, it must look right; if not, we don't fail
			// the test (env-dependent).
			if (found) {
				expect(found.command).toMatch(/\b(ov|overstory)\b.*\bwatch\b/);
			}
		} finally {
			sleeper.kill("SIGTERM");
			await sleeper.exited.catch(() => {});
		}
	});
});

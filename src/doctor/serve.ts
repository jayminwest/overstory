import { existsSync } from "node:fs";
import { join } from "node:path";
import type { DoctorCheck, DoctorCheckFn } from "./types.ts";

/**
 * ov serve subsystem health checks.
 * Validates ui/dist build output and port reachability.
 */
export const checkServe: DoctorCheckFn = async (config, _overstoryDir): Promise<DoctorCheck[]> => {
	const checks: DoctorCheck[] = [];

	// Check 1: ui/dist directory exists (only relevant if a UI has been built)
	const uiDistPath = join(config.project.root, "ui", "dist");
	const uiDistExists = existsSync(uiDistPath);
	const indexHtmlExists = uiDistExists && existsSync(join(uiDistPath, "index.html"));

	if (!uiDistExists) {
		checks.push({
			name: "serve ui/dist",
			category: "serve",
			status: "warn",
			message: "ui/dist not found — run the UI build before starting ov serve",
			details: [`Expected: ${uiDistPath}`],
		});
	} else if (!indexHtmlExists) {
		checks.push({
			name: "serve ui/dist",
			category: "serve",
			status: "warn",
			message: "ui/dist exists but index.html is missing — UI build may be incomplete",
			details: [`Expected: ${join(uiDistPath, "index.html")}`],
		});
	} else {
		checks.push({
			name: "serve ui/dist",
			category: "serve",
			status: "pass",
			message: "ui/dist is present with index.html",
		});
	}

	// Check 2: default port reachability (non-blocking probe)
	const port = 8080;
	const host = "127.0.0.1";
	const reachable = await probePort(host, port);
	if (reachable) {
		checks.push({
			name: "serve port",
			category: "serve",
			status: "pass",
			message: `ov serve is reachable on ${host}:${port}`,
		});
	} else {
		checks.push({
			name: "serve port",
			category: "serve",
			status: "warn",
			message: `ov serve is not running on ${host}:${port}`,
			details: [`Start with: ov serve --port ${port}`],
		});
	}

	return checks;
};

/**
 * Probe whether a TCP port is open by attempting an HTTP connection.
 * Returns true if the server responds, false on any error.
 */
async function probePort(host: string, port: number): Promise<boolean> {
	try {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 1000);
		try {
			const res = await fetch(`http://${host}:${port}/healthz`, {
				signal: controller.signal,
			});
			return res.ok || res.status < 500;
		} finally {
			clearTimeout(timeout);
		}
	} catch {
		return false;
	}
}

import { resolveBackend, trackerCliName } from "../tracker/factory.ts";
import type { DoctorCheck, DoctorCheckFn } from "./types.ts";

interface ToolSpec {
	name: string;
	versionFlag: string;
	required: boolean;
	/** Short alias to check if the primary tool is available. */
	alias?: string;
	/** npm package name for install hint (e.g. "@os-eco/mulch-cli"). */
	installHint?: string;
}

/**
 * External dependency checks.
 * Validates that required CLI tools (git, bun, tmux, tracker, mulch, overstory)
 * and optional tools (cn) are available, including short alias availability.
 */
export const checkDependencies: DoctorCheckFn = async (
	config,
	_overstoryDir,
): Promise<DoctorCheck[]> => {
	// Determine which tracker CLI to check based on config backend (resolve "auto")
	const resolvedBackend = await resolveBackend(config.taskTracker.backend, config.project.root);
	const trackerName = trackerCliName(resolvedBackend);

	const tools: ToolSpec[] = [
		{ name: "git", versionFlag: "--version", required: true },
		{ name: "bun", versionFlag: "--version", required: true },
		{ name: "tmux", versionFlag: "-V", required: true },
		{
			name: trackerName,
			versionFlag: "--version",
			required: true,
			installHint: trackerName === "sd" ? "@os-eco/seeds-cli" : undefined,
		},
		{
			name: "mulch",
			versionFlag: "--version",
			required: true,
			alias: "ml",
			installHint: "@os-eco/mulch-cli",
		},
		{
			name: "ov",
			versionFlag: "--version",
			required: true,
			alias: "overstory",
			installHint: "@os-eco/overstory-cli",
		},
		{
			name: "cn",
			versionFlag: "--version",
			required: false,
			installHint: "@os-eco/canopy-cli",
		},
	];

	const checks: DoctorCheck[] = [];

	for (const tool of tools) {
		const check = await checkTool(tool.name, tool.versionFlag, tool.required, tool.installHint);
		checks.push(check);

		// Check short alias availability if the main tool is available
		if (tool.alias && check.status === "pass") {
			const aliasCheck = await checkAlias(tool.name, tool.alias, tool.installHint);
			checks.push(aliasCheck);
		}
	}

	// If bd is available, probe for CGO/Dolt backend functionality.
	// Only run for beads backend (CGO check is beads-specific).
	if (trackerName === "bd") {
		const bdCheck = checks.find((c) => c.name === "bd availability");
		if (bdCheck?.status === "pass") {
			const cgoCheck = await checkBdCgoSupport();
			checks.push(cgoCheck);
		}
	}

	// agent-browser: optional dependency for verifier agents
	const agentBrowserChecks = await checkAgentBrowser();
	checks.push(...agentBrowserChecks);

	return checks;
};

/** Minimum agent-browser version required for verifier agents. */
const AGENT_BROWSER_MIN_VERSION = "0.9.0";

/**
 * Compare two semver version strings.
 * Returns true if version >= minVersion.
 */
function isVersionSufficient(version: string, minVersion: string): boolean {
	const parse = (v: string) => v.split(".").map((n) => Number.parseInt(n, 10));
	const current = parse(version);
	const min = parse(minVersion);
	for (let i = 0; i < Math.max(current.length, min.length); i++) {
		const c = current[i] ?? 0;
		const m = min[i] ?? 0;
		if (c > m) return true;
		if (c < m) return false;
	}
	return true;
}

/**
 * Check agent-browser availability and version.
 * agent-browser is optional — only needed for projects using browser verification.
 * Returns warn (not fail) if missing or outdated.
 */
async function checkAgentBrowser(): Promise<DoctorCheck[]> {
	const checks: DoctorCheck[] = [];

	try {
		const proc = Bun.spawn(["agent-browser", "--version"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const exitCode = await proc.exited;

		if (exitCode !== 0) {
			checks.push({
				name: "agent-browser availability",
				category: "dependencies",
				status: "warn",
				message:
					"agent-browser not found. Install with: npm install -g agent-browser && agent-browser install",
				details: [
					"agent-browser is optional — only needed for projects using browser verification (verifier agents).",
					"Install: npm install -g agent-browser && agent-browser install",
				],
				fixable: true,
			});
			return checks;
		}

		const stdout = await new Response(proc.stdout).text();
		const versionLine = stdout.trim().split("\n")[0] ?? "";
		// Extract version number from output (e.g., "agent-browser 0.9.3" or "0.9.3")
		const versionMatch = versionLine.match(/(\d+\.\d+\.\d+)/);
		const version = versionMatch?.[1] ?? "";

		if (version && !isVersionSufficient(version, AGENT_BROWSER_MIN_VERSION)) {
			checks.push({
				name: "agent-browser availability",
				category: "dependencies",
				status: "warn",
				message: `agent-browser version ${version} found, >=${AGENT_BROWSER_MIN_VERSION} required`,
				details: [
					`Current version: ${version}`,
					`Minimum required: ${AGENT_BROWSER_MIN_VERSION}`,
					"Upgrade: npm install -g agent-browser@latest",
				],
				fixable: true,
			});
			return checks;
		}

		checks.push({
			name: "agent-browser availability",
			category: "dependencies",
			status: "pass",
			message: "agent-browser is available",
			details: [versionLine],
		});
	} catch {
		checks.push({
			name: "agent-browser availability",
			category: "dependencies",
			status: "warn",
			message:
				"agent-browser not found. Install with: npm install -g agent-browser && agent-browser install",
			details: [
				"agent-browser is optional — only needed for projects using browser verification (verifier agents).",
				"Install: npm install -g agent-browser && agent-browser install",
			],
			fixable: true,
		});
	}

	return checks;
}

/**
 * Probe whether bd's Dolt database backend is functional.
 * The npm-distributed bd binary may be built without CGO, which causes
 * `bd init` and all database operations to fail even though `bd --version` succeeds.
 * We detect this by running `bd status` in a temp directory and checking for
 * the characteristic "without CGO support" error message.
 */
async function checkBdCgoSupport(): Promise<DoctorCheck> {
	const { mkdtemp, rm } = await import("node:fs/promises");
	const { join } = await import("node:path");
	const { tmpdir } = await import("node:os");

	let tempDir: string | undefined;
	try {
		tempDir = await mkdtemp(join(tmpdir(), "overstory-bd-cgo-"));
		const proc = Bun.spawn(["bd", "status"], {
			cwd: tempDir,
			stdout: "pipe",
			stderr: "pipe",
		});

		const exitCode = await proc.exited;
		const stderr = await new Response(proc.stderr).text();

		if (stderr.includes("without CGO support")) {
			return {
				name: "bd CGO support",
				category: "dependencies",
				status: "fail",
				message: "bd binary was built without CGO — Dolt database operations will fail",
				details: [
					"The installed bd binary lacks CGO support required by its Dolt backend.",
					"Workaround: rebuild bd from source with CGO_ENABLED=1 and ICU headers.",
					"See: https://github.com/jayminwest/overstory/issues/10",
				],
				fixable: true,
			};
		}

		// Any other exit code is fine — bd status may fail for other reasons
		// (no .beads/ dir, etc.) but those aren't CGO issues
		if (exitCode === 0 || !stderr.includes("CGO")) {
			return {
				name: "bd CGO support",
				category: "dependencies",
				status: "pass",
				message: "bd has functional database backend",
				details: ["Dolt backend operational"],
			};
		}

		return {
			name: "bd CGO support",
			category: "dependencies",
			status: "warn",
			message: `bd status returned unexpected error (exit code ${exitCode})`,
			details: [stderr.trim().split("\n")[0] || "unknown error"],
		};
	} catch (error) {
		return {
			name: "bd CGO support",
			category: "dependencies",
			status: "warn",
			message: "Could not verify bd CGO support",
			details: [error instanceof Error ? error.message : String(error)],
		};
	} finally {
		if (tempDir) {
			await rm(tempDir, { recursive: true }).catch(() => {});
		}
	}
}

/**
 * Check if a short alias for a CLI tool is available.
 */
async function checkAlias(
	toolName: string,
	alias: string,
	installHint?: string,
): Promise<DoctorCheck> {
	try {
		const proc = Bun.spawn([alias, "--version"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const exitCode = await proc.exited;

		if (exitCode === 0) {
			return {
				name: `${alias} alias`,
				category: "dependencies",
				status: "pass",
				message: `${alias} alias for ${toolName} is available`,
				details: [`Short alias '${alias}' is configured`],
			};
		}

		const hint = installHint
			? `Reinstall ${installHint} to get the '${alias}' alias.`
			: `Ensure '${alias}' alias is in your PATH.`;
		return {
			name: `${alias} alias`,
			category: "dependencies",
			status: "warn",
			message: `${alias} alias for ${toolName} not working`,
			details: [hint],
			fixable: true,
		};
	} catch {
		const hint = installHint
			? `Reinstall ${installHint} to get the '${alias}' alias.`
			: `Ensure '${alias}' alias is in your PATH.`;
		return {
			name: `${alias} alias`,
			category: "dependencies",
			status: "warn",
			message: `${alias} alias for ${toolName} is not available`,
			details: [`'${toolName}' works but short alias '${alias}' was not found.`, hint],
			fixable: true,
		};
	}
}

/**
 * Check if a CLI tool is available by attempting to run it with a version flag.
 */
async function checkTool(
	name: string,
	versionFlag: string,
	required: boolean,
	installHint?: string,
): Promise<DoctorCheck> {
	try {
		const proc = Bun.spawn([name, versionFlag], {
			stdout: "pipe",
			stderr: "pipe",
		});

		const exitCode = await proc.exited;

		if (exitCode === 0) {
			const stdout = await new Response(proc.stdout).text();
			const version = stdout.split("\n")[0]?.trim() || "version unknown";

			return {
				name: `${name} availability`,
				category: "dependencies",
				status: "pass",
				message: `${name} is available`,
				details: [version],
			};
		}

		// Non-zero exit code
		const stderr = await new Response(proc.stderr).text();
		const details: string[] = [];
		if (stderr) details.push(stderr.trim());
		if (installHint) details.push(`Install: npm install -g ${installHint}`);
		return {
			name: `${name} availability`,
			category: "dependencies",
			status: required ? "fail" : "warn",
			message: `${name} command failed (exit code ${exitCode})`,
			details: details.length > 0 ? details : undefined,
			fixable: true,
		};
	} catch (error) {
		// Command not found or spawn failed
		const details: string[] = [];
		if (installHint) {
			details.push(`Install: npm install -g ${installHint}`);
		} else {
			details.push(`Install ${name} or ensure it is in your PATH`);
		}
		details.push(error instanceof Error ? error.message : String(error));
		return {
			name: `${name} availability`,
			category: "dependencies",
			status: required ? "fail" : "warn",
			message: `${name} is not installed or not in PATH`,
			details,
			fixable: true,
		};
	}
}

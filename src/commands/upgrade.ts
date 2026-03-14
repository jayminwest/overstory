/**
 * CLI command: ov upgrade [--check] [--all] [--json]
 *
 * Upgrades overstory (and optionally all os-eco tools) to their latest npm versions.
 * --check: Compare current vs latest without installing.
 * --all:   Upgrade all 4 ecosystem tools (overstory, mulch, seeds, canopy).
 * --json:  Output result as JSON envelope.
 */

import { Command } from "commander";
import { jsonError, jsonOutput } from "../json.ts";
import { muted, printError, printHint, printSuccess, printWarning } from "../logging/color.ts";
import { fetchLatestVersion, getCurrentVersion } from "../utils/version.ts";

const OVERSTORY_PACKAGE = "@os-eco/overstory-cli";

const ALL_PACKAGES = [
	"@os-eco/overstory-cli",
	"@os-eco/mulch-cli",
	"@os-eco/seeds-cli",
	"@os-eco/canopy-cli",
] as const;

export interface UpgradeOptions {
	check?: boolean;
	all?: boolean;
	json?: boolean;
}

async function runInstall(packageName: string): Promise<number> {
	const proc = Bun.spawn(["bun", "install", "-g", `${packageName}@latest`], {
		stdout: "inherit",
		stderr: "inherit",
	});
	return proc.exited;
}

interface PackageResult {
	package: string;
	current: string;
	latest: string;
	upToDate: boolean;
	updated: boolean;
	error?: string;
}

async function upgradePackage(packageName: string): Promise<PackageResult> {
	let latest: string;
	try {
		latest = await fetchLatestVersion(packageName);
	} catch (err) {
		const error = err instanceof Error ? err.message : String(err);
		return {
			package: packageName,
			current: "unknown",
			latest: "unknown",
			upToDate: false,
			updated: false,
			error,
		};
	}

	const exitCode = await runInstall(packageName);
	if (exitCode !== 0) {
		return {
			package: packageName,
			current: "unknown",
			latest,
			upToDate: false,
			updated: false,
			error: `bun install failed with exit code ${exitCode}`,
		};
	}
	return { package: packageName, current: "unknown", latest, upToDate: false, updated: true };
}

async function executeUpgradeSingle(opts: UpgradeOptions): Promise<void> {
	const json = opts.json ?? false;
	const checkOnly = opts.check ?? false;

	let current: string;
	let latest: string;
	try {
		[current, latest] = await Promise.all([
			getCurrentVersion(),
			fetchLatestVersion(OVERSTORY_PACKAGE),
		]);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (json) {
			jsonError("upgrade", msg);
		} else {
			printError("Failed to check for updates", msg);
		}
		process.exitCode = 1;
		return;
	}

	const upToDate = current === latest;

	if (checkOnly) {
		if (json) {
			jsonOutput("upgrade", { current, latest, upToDate });
		} else if (upToDate) {
			printSuccess("Already up to date", current);
		} else {
			printWarning(`Update available: ${current} → ${latest}`);
			printHint("Run 'ov upgrade' to install the latest version");
			process.exitCode = 1;
		}
		return;
	}

	if (upToDate) {
		if (json) {
			jsonOutput("upgrade", { current, latest, upToDate: true, updated: false });
		} else {
			printSuccess("Already up to date", current);
		}
		return;
	}

	if (!json) {
		process.stdout.write(
			`${muted(`Upgrading ${OVERSTORY_PACKAGE} from ${current} to ${latest}...`)}\n`,
		);
	}

	const exitCode = await runInstall(OVERSTORY_PACKAGE);

	if (exitCode !== 0) {
		if (json) {
			jsonError("upgrade", `bun install failed with exit code ${exitCode}`);
		} else {
			printError("Upgrade failed", `bun install exited with code ${exitCode}`);
		}
		process.exitCode = 1;
		return;
	}

	if (json) {
		jsonOutput("upgrade", { current, latest, upToDate: false, updated: true });
	} else {
		printSuccess("Upgraded to", latest);
	}
}

async function executeUpgradeAll(opts: UpgradeOptions): Promise<void> {
	const json = opts.json ?? false;
	const checkOnly = opts.check ?? false;

	// Fetch all latest versions in parallel
	const latestResults = await Promise.allSettled(
		ALL_PACKAGES.map((pkg) => fetchLatestVersion(pkg)),
	);

	if (checkOnly) {
		// For --check --all, we just report status without installing
		const results: Array<{ package: string; latest: string; error?: string }> = [];
		let anyOutdated = false;

		for (let i = 0; i < ALL_PACKAGES.length; i++) {
			const pkg = ALL_PACKAGES[i] as string;
			const result = latestResults[i];
			if (result === undefined || result.status === "rejected") {
				const error =
					result?.status === "rejected"
						? result.reason instanceof Error
							? result.reason.message
							: String(result.reason)
						: "unknown error";
				results.push({ package: pkg, latest: "unknown", error });
				anyOutdated = true;
			} else {
				results.push({ package: pkg, latest: result.value });
				// We can't easily get current versions for all tools without spawning them
				// so for --all --check we just report latest versions available
			}
		}

		if (json) {
			jsonOutput("upgrade", { packages: results });
		} else {
			for (const r of results) {
				if (r.error) {
					printError(`${r.package}`, r.error);
				} else {
					process.stdout.write(`  ${r.package} → ${r.latest}\n`);
				}
			}
			if (anyOutdated) process.exitCode = 1;
		}
		return;
	}

	// Install all packages
	if (!json) {
		process.stdout.write(`${muted("Upgrading all os-eco tools to latest...")}\n`);
	}

	const results: PackageResult[] = await Promise.all(
		ALL_PACKAGES.map((pkg) => upgradePackage(pkg)),
	);

	const anyError = results.some((r) => r.error !== undefined);

	if (json) {
		if (anyError) {
			jsonError("upgrade", `One or more packages failed to upgrade`);
		} else {
			jsonOutput("upgrade", { packages: results, updated: true });
		}
	} else {
		for (const r of results) {
			if (r.error) {
				printError(`Failed to upgrade ${r.package}`, r.error);
			} else {
				printSuccess(`Upgraded ${r.package} to`, r.latest);
			}
		}
	}

	if (anyError) process.exitCode = 1;
}

export async function executeUpgrade(opts: UpgradeOptions): Promise<void> {
	if (opts.all) {
		await executeUpgradeAll(opts);
	} else {
		await executeUpgradeSingle(opts);
	}
}

export function createUpgradeCommand(): Command {
	return new Command("upgrade")
		.description("Upgrade overstory to the latest version from npm")
		.option("--check", "Check for updates without installing")
		.option("--all", "Upgrade all os-eco ecosystem tools")
		.option("--json", "Output as JSON")
		.action(async (opts: UpgradeOptions) => {
			await executeUpgrade(opts);
		});
}

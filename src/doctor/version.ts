import { join } from "node:path";
import type { DoctorCheck, DoctorCheckFn } from "./types.ts";

/**
 * Version compatibility checks.
 * Validates overstory CLI version, config schema version, database schema versions.
 */
export const checkVersion: DoctorCheckFn = async (
	_config,
	_overstoryDir,
): Promise<DoctorCheck[]> => {
	const checks: DoctorCheck[] = [];

	// Determine overstory tool root (not the target project)
	// import.meta.dir is src/doctor/, so go up two levels to repo root
	const toolRoot = join(import.meta.dir, "..", "..");

	// Check 1: version-current (read package.json)
	const versionCheck = await checkCurrentVersion(toolRoot);
	checks.push(versionCheck);

	// Check 2: package-json-sync (compare package.json and src/index.ts)
	const syncCheck = await checkVersionSync(toolRoot);
	checks.push(syncCheck);

	return checks;
};

/**
 * Check that the current version can be determined from package.json.
 * @internal Exported for testing.
 */
export async function checkCurrentVersion(toolRoot: string): Promise<DoctorCheck> {
	try {
		const packageJsonPath = join(toolRoot, "package.json");
		const packageJson = (await Bun.file(packageJsonPath).json()) as { version?: string };

		if (!packageJson.version) {
			return {
				name: "version-current",
				category: "version",
				status: "fail",
				message: "Cannot determine version (package.json has no version field)",
			};
		}

		return {
			name: "version-current",
			category: "version",
			status: "pass",
			message: `ov v${packageJson.version}`,
		};
	} catch (error) {
		return {
			name: "version-current",
			category: "version",
			status: "fail",
			message: "Cannot determine version",
			details: [error instanceof Error ? error.message : String(error)],
		};
	}
}

/**
 * Check that package.json version matches src/index.ts VERSION constant.
 * @internal Exported for testing.
 */
export async function checkVersionSync(toolRoot: string): Promise<DoctorCheck> {
	try {
		// Read package.json version
		const packageJsonPath = join(toolRoot, "package.json");
		const packageJson = (await Bun.file(packageJsonPath).json()) as { version?: string };
		const pkgVersion = packageJson.version;

		if (!pkgVersion) {
			return {
				name: "package-json-sync",
				category: "version",
				status: "warn",
				message: "Cannot verify version sync (package.json has no version)",
			};
		}

		// Read src/index.ts and extract VERSION constant
		const indexPath = join(toolRoot, "src", "index.ts");
		const indexContent = await Bun.file(indexPath).text();

		// Regex to find: const VERSION = "x.y.z" or export const VERSION = "x.y.z"
		const versionRegex = /(?:export\s+)?const\s+VERSION\s*=\s*["']([^"']+)["']/;
		const match = versionRegex.exec(indexContent);

		if (!match?.[1]) {
			return {
				name: "package-json-sync",
				category: "version",
				status: "warn",
				message: "Cannot find VERSION constant in src/index.ts",
				details: [`package.json version: ${pkgVersion}`],
			};
		}

		const indexVersion = match[1];

		if (pkgVersion === indexVersion) {
			return {
				name: "package-json-sync",
				category: "version",
				status: "pass",
				message: "Versions are synchronized",
				details: [`package.json: ${pkgVersion}`, `src/index.ts: ${indexVersion}`],
			};
		}

		return {
			name: "package-json-sync",
			category: "version",
			status: "warn",
			message: "Version mismatch between package.json and src/index.ts",
			details: [`package.json: ${pkgVersion}`, `src/index.ts: ${indexVersion}`],
			fixable: true,
		};
	} catch (error) {
		return {
			name: "package-json-sync",
			category: "version",
			status: "warn",
			message: "Cannot verify version sync",
			details: [error instanceof Error ? error.message : String(error)],
		};
	}
}

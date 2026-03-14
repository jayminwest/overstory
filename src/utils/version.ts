/**
 * Version detection and npm registry utilities.
 */

/**
 * Get the current installed version of overstory from package.json.
 */
export async function getCurrentVersion(): Promise<string> {
	const pkgPath = new URL("../../package.json", import.meta.url);
	const pkg = JSON.parse(await Bun.file(pkgPath).text()) as { version: string };
	return pkg.version;
}

/**
 * Fetch the latest published version of an npm package from the registry.
 */
export async function fetchLatestVersion(packageName: string): Promise<string> {
	const res = await fetch(`https://registry.npmjs.org/${packageName}/latest`);
	if (!res.ok) {
		throw new Error(
			`Failed to fetch npm registry for ${packageName}: ${res.status} ${res.statusText}`,
		);
	}
	const data = (await res.json()) as { version: string };
	return data.version;
}

/**
 * Get the installed version of a CLI tool by running `--version`.
 * Tries `--version --json` first, then falls back to plain text.
 */
export async function getInstalledVersion(cli: string): Promise<string | null> {
	// Try --version --json first
	try {
		const proc = Bun.spawn([cli, "--version", "--json"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const exitCode = await proc.exited;
		if (exitCode === 0) {
			const stdout = await new Response(proc.stdout).text();
			try {
				const data = JSON.parse(stdout.trim()) as { version?: string };
				if (data.version) return data.version;
			} catch {
				// Not valid JSON, fall through to plain text
			}
		}
	} catch {
		// CLI not found — fall through to plain text fallback
	}

	// Fallback: --version plain text
	try {
		const proc = Bun.spawn([cli, "--version"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const exitCode = await proc.exited;
		if (exitCode === 0) {
			const stdout = await new Response(proc.stdout).text();
			const match = stdout.match(/(\d+\.\d+\.\d+)/);
			if (match?.[1]) return match[1];
		}
	} catch {
		// CLI not found
	}

	return null;
}

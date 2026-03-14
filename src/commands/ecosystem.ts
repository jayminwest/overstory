/**
 * CLI command: ov ecosystem
 *
 * Shows a summary dashboard of all installed os-eco tools: version, update
 * status (latest vs outdated), and doctor health (overstory only).
 */

import { Command } from "commander";
import { jsonError, jsonOutput } from "../json.ts";
import { accent, brand, color, muted } from "../logging/color.ts";
import { thickSeparator } from "../logging/theme.ts";
import { fetchLatestVersion, getInstalledVersion } from "../utils/version.ts";

const TOOLS = [
	{ name: "overstory", cli: "ov", npm: "@os-eco/overstory-cli" },
	{ name: "mulch", cli: "ml", npm: "@os-eco/mulch-cli" },
	{ name: "seeds", cli: "sd", npm: "@os-eco/seeds-cli" },
	{ name: "canopy", cli: "cn", npm: "@os-eco/canopy-cli" },
] as const;

export interface EcosystemOptions {
	json?: boolean;
}

export interface DoctorSummary {
	pass: number;
	warn: number;
	fail: number;
}

export interface ToolResult {
	name: string;
	cli: string;
	npm: string;
	installed: boolean;
	version?: string;
	latest?: string;
	upToDate?: boolean;
	doctorSummary?: DoctorSummary;
	latestError?: string;
}

async function getDoctorSummary(): Promise<DoctorSummary | undefined> {
	try {
		const proc = Bun.spawn(["ov", "doctor", "--json"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		await proc.exited;
		const stdout = await new Response(proc.stdout).text();
		const trimmed = stdout.trim();
		if (trimmed) {
			const data = JSON.parse(trimmed) as {
				summary?: { pass?: number; warn?: number; fail?: number };
			};
			if (data.summary) {
				return {
					pass: data.summary.pass ?? 0,
					warn: data.summary.warn ?? 0,
					fail: data.summary.fail ?? 0,
				};
			}
		}
	} catch {
		// Doctor failed — report nothing
	}
	return undefined;
}

async function checkTool(tool: { name: string; cli: string; npm: string }): Promise<ToolResult> {
	const version = await getInstalledVersion(tool.cli);

	if (version === null) {
		return { name: tool.name, cli: tool.cli, npm: tool.npm, installed: false };
	}

	let latest: string | undefined;
	let latestError: string | undefined;
	let doctorSummary: DoctorSummary | undefined;

	const latestPromise = fetchLatestVersion(tool.npm)
		.then((v) => {
			latest = v;
		})
		.catch((err) => {
			latestError = err instanceof Error ? err.message : String(err);
		});

	const doctorPromise =
		tool.name === "overstory"
			? getDoctorSummary().then((d) => {
					doctorSummary = d;
				})
			: Promise.resolve();

	await Promise.all([latestPromise, doctorPromise]);

	const upToDate = latest !== undefined ? version === latest : undefined;

	return {
		name: tool.name,
		cli: tool.cli,
		npm: tool.npm,
		installed: true,
		version,
		latest,
		upToDate,
		doctorSummary,
		latestError,
	};
}

/** @internal Exported for testing. */
export function formatDoctorLine(summary: DoctorSummary): string {
	const parts: string[] = [];
	if (summary.pass > 0) parts.push(color.green(`${summary.pass} passed`));
	if (summary.warn > 0) parts.push(color.yellow(`${summary.warn} warn`));
	if (summary.fail > 0) parts.push(color.red(`${summary.fail} fail`));
	return parts.length > 0 ? parts.join(", ") : "no checks";
}

/** @internal Exported for testing. */
export function printHumanOutput(results: ToolResult[]): void {
	process.stdout.write(`${brand.bold("os-eco Ecosystem")}\n`);
	process.stdout.write(`${thickSeparator()}\n`);
	process.stdout.write("\n");

	for (const tool of results) {
		if (!tool.installed) {
			process.stdout.write(
				`  ${color.red("x")} ${accent(tool.name)} ${muted(`(${tool.cli})`)}  ${color.red("not installed")}\n`,
			);
			process.stdout.write(`    ${muted(`npm i -g ${tool.npm}`)}\n`);
			process.stdout.write("\n");
			continue;
		}

		// Determine status icon
		let icon: string;
		if (tool.latestError !== undefined || tool.upToDate === undefined) {
			icon = muted("-");
		} else if (tool.upToDate) {
			icon = color.green("-");
		} else {
			icon = color.yellow("!");
		}

		process.stdout.write(`  ${icon} ${accent(tool.name)} ${muted(`(${tool.cli})`)}\n`);

		// Version line
		let versionLine = `Version: ${tool.version}`;
		if (tool.latestError !== undefined) {
			versionLine += ` ${muted("(version check failed)")}`;
		} else if (tool.upToDate === true) {
			versionLine += ` ${color.green("(up to date)")}`;
		} else if (tool.upToDate === false) {
			versionLine += ` ${color.yellow(`(outdated, latest: ${tool.latest})`)}`;
		}
		process.stdout.write(`    ${versionLine}\n`);

		// Doctor summary (overstory only)
		if (tool.doctorSummary !== undefined) {
			process.stdout.write(`    Doctor:  ${formatDoctorLine(tool.doctorSummary)}\n`);
		}

		process.stdout.write("\n");
	}

	const installed = results.filter((t) => t.installed).length;
	const missing = results.filter((t) => !t.installed).length;
	const outdated = results.filter(
		(t) => t.installed && t.upToDate === false && t.latestError === undefined,
	).length;

	let summary = `Summary: ${installed}/${results.length} installed`;
	if (missing > 0) summary += `, ${missing} missing`;
	if (outdated > 0) summary += `, ${outdated} outdated`;
	process.stdout.write(`${summary}\n`);
}

export async function executeEcosystem(opts: EcosystemOptions): Promise<void> {
	const json = opts.json ?? false;

	let results: ToolResult[];
	try {
		results = await Promise.all(TOOLS.map((tool) => checkTool(tool)));
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (json) {
			jsonError("ecosystem", msg);
		} else {
			process.stderr.write(`Error: ${msg}\n`);
		}
		process.exitCode = 1;
		return;
	}

	if (json) {
		const installed = results.filter((t) => t.installed).length;
		const missing = results.filter((t) => !t.installed).length;
		const outdated = results.filter(
			(t) => t.installed && t.upToDate === false && t.latestError === undefined,
		).length;

		jsonOutput("ecosystem", {
			tools: results.map((t) => {
				const entry: Record<string, unknown> = {
					name: t.name,
					cli: t.cli,
					npm: t.npm,
					installed: t.installed,
				};
				if (t.installed) {
					entry.version = t.version;
					entry.latest = t.latest;
					entry.upToDate = t.upToDate;
					if (t.doctorSummary !== undefined) {
						entry.doctorSummary = t.doctorSummary;
					}
					if (t.latestError !== undefined) {
						entry.latestError = t.latestError;
					}
				}
				return entry;
			}),
			summary: {
				total: results.length,
				installed,
				missing,
				outdated,
			},
		});
		return;
	}

	printHumanOutput(results);
}

export function createEcosystemCommand(): Command {
	return new Command("ecosystem")
		.description("Show a summary dashboard of all installed os-eco tools")
		.option("--json", "Output as JSON")
		.action(async (opts: EcosystemOptions) => {
			await executeEcosystem(opts);
		});
}

/**
 * CLI command: ov doctor [options]
 *
 * Runs health checks on overstory subsystems and reports problems.
 */

import { join } from "node:path";
import { Command } from "commander";
import { loadConfig } from "../config.ts";
import { checkAgents } from "../doctor/agents.ts";
import { checkConfig } from "../doctor/config-check.ts";
import { checkConsistency } from "../doctor/consistency.ts";
import { checkDatabases } from "../doctor/databases.ts";
import { checkDependencies } from "../doctor/dependencies.ts";
import { checkEcosystem } from "../doctor/ecosystem.ts";
import { checkLogs } from "../doctor/logs.ts";
import { checkMergeQueue } from "../doctor/merge-queue.ts";
import { checkProviders } from "../doctor/providers.ts";
import { checkStructure } from "../doctor/structure.ts";
import type { DoctorCategory, DoctorCheck, DoctorCheckFn } from "../doctor/types.ts";
import { checkVersion } from "../doctor/version.ts";
import { checkWatchdog } from "../doctor/watchdog.ts";
import { ValidationError } from "../errors.ts";
import { jsonOutput } from "../json.ts";
import { color } from "../logging/color.ts";
import { renderHeader } from "../logging/theme.ts";

/** Registry of all check modules in execution order. */
const ALL_CHECKS: Array<{ category: DoctorCategory; fn: DoctorCheckFn }> = [
	{ category: "dependencies", fn: checkDependencies },
	{ category: "config", fn: checkConfig },
	{ category: "structure", fn: checkStructure },
	{ category: "databases", fn: checkDatabases },
	{ category: "consistency", fn: checkConsistency },
	{ category: "agents", fn: checkAgents },
	{ category: "merge", fn: checkMergeQueue },
	{ category: "logs", fn: checkLogs },
	{ category: "version", fn: checkVersion },
	{ category: "ecosystem", fn: checkEcosystem },
	{ category: "providers", fn: checkProviders },
	{ category: "watchdog", fn: checkWatchdog },
];

/**
 * Execute all fix functions on non-passing fixable checks.
 * Returns a list of human-readable actions taken.
 */
async function applyFixes(checks: DoctorCheck[]): Promise<string[]> {
	const fixable = checks.filter((c) => c.fixable && c.status !== "pass" && c.fix);
	const fixed: string[] = [];
	for (const check of fixable) {
		if (check.fix) {
			const actions = await check.fix();
			fixed.push(...actions);
		}
	}
	return fixed;
}

/**
 * Format human-readable output for doctor checks.
 */
function printHumanReadable(
	checks: DoctorCheck[],
	verbose: boolean,
	checkRegistry: Array<{ category: DoctorCategory; fn: DoctorCheckFn }>,
	fixedItems?: string[],
): void {
	const w = process.stdout.write.bind(process.stdout);

	w(`${renderHeader("Overstory Doctor")}\n\n`);

	// Group checks by category
	const byCategory = new Map<DoctorCategory, DoctorCheck[]>();
	for (const check of checks) {
		const existing = byCategory.get(check.category);
		if (existing) {
			existing.push(check);
		} else {
			byCategory.set(check.category, [check]);
		}
	}

	// Print each category
	for (const { category } of checkRegistry) {
		const categoryChecks = byCategory.get(category) ?? [];
		if (categoryChecks.length === 0 && !verbose) {
			continue; // Skip empty categories unless verbose
		}

		w(`${color.bold(`[${category}]`)}\n`);

		if (categoryChecks.length === 0) {
			w(`  ${color.dim("No checks")}\n`);
		} else {
			for (const check of categoryChecks) {
				// Skip passing checks unless verbose
				if (check.status === "pass" && !verbose) {
					continue;
				}

				const icon =
					check.status === "pass"
						? color.green("-")
						: check.status === "warn"
							? color.yellow("!")
							: color.red("x");

				w(`  ${icon} ${check.message}\n`);

				// Print details if present
				if (check.details && check.details.length > 0) {
					for (const detail of check.details) {
						w(`    ${color.dim(`→ ${detail}`)}\n`);
					}
				}
			}
		}

		w("\n");
	}

	// Summary
	const pass = checks.filter((c) => c.status === "pass").length;
	const warn = checks.filter((c) => c.status === "warn").length;
	const fail = checks.filter((c) => c.status === "fail").length;

	w(
		`${color.bold("Summary:")} ${color.green(`${pass} passed`)}, ${color.yellow(`${warn} warning${warn === 1 ? "" : "s"}`)}, ${color.red(`${fail} failure${fail === 1 ? "" : "s"}`)}\n`,
	);

	if (fixedItems && fixedItems.length > 0) {
		w(`\n${color.bold("Fixed:")}\n`);
		for (const item of fixedItems) {
			w(`  ${color.green("-")} ${item}\n`);
		}
	}
}

/**
 * Format JSON output for doctor checks.
 */
function printJSON(checks: DoctorCheck[], fixed?: string[]): void {
	const pass = checks.filter((c) => c.status === "pass").length;
	const warn = checks.filter((c) => c.status === "warn").length;
	const fail = checks.filter((c) => c.status === "fail").length;

	jsonOutput("doctor", {
		checks,
		summary: { pass, warn, fail },
		...(fixed && fixed.length > 0 ? { fixed } : {}),
	});
}

/** Options for dependency injection in doctorCommand. */
export interface DoctorCommandOptions {
	/** Override the check runners (defaults to ALL_CHECKS). Pass [] to skip all checks. */
	checkRunners?: Array<{ category: DoctorCategory; fn: DoctorCheckFn }>;
}

/**
 * Create the Commander command for `overstory doctor`.
 */
export function createDoctorCommand(options?: DoctorCommandOptions): Command {
	return new Command("doctor")
		.description("Run health checks on overstory setup")
		.option("--json", "Output as JSON")
		.option("--verbose", "Show passing checks (default: only problems)")
		.option("--category <name>", "Run only one category")
		.option("--fix", "Attempt to auto-fix issues")
		.addHelpText(
			"after",
			"\nCategories: dependencies, structure, config, databases, consistency, agents, merge, logs, version, ecosystem, providers, watchdog",
		)
		.action(
			async (opts: { json?: boolean; verbose?: boolean; category?: string; fix?: boolean }) => {
				const json = opts.json ?? false;
				const verbose = opts.verbose ?? false;
				const categoryFilter = opts.category;
				const fix = opts.fix ?? false;

				// Validate category filter if provided
				if (categoryFilter !== undefined) {
					const validCategories = ALL_CHECKS.map((c) => c.category);
					if (!validCategories.includes(categoryFilter as DoctorCategory)) {
						throw new ValidationError(
							`Invalid category: ${categoryFilter}. Valid categories: ${validCategories.join(", ")}`,
							{
								field: "category",
								value: categoryFilter,
							},
						);
					}
				}

				const cwd = process.cwd();
				const config = await loadConfig(cwd);
				const overstoryDir = join(config.project.root, ".overstory");

				// Filter checks by category if specified
				const allChecks = options?.checkRunners ?? ALL_CHECKS;
				const checksToRun = categoryFilter
					? allChecks.filter((c) => c.category === categoryFilter)
					: allChecks;

				// Run all checks sequentially
				let results: DoctorCheck[] = [];
				for (const { fn } of checksToRun) {
					const checkResults = await fn(config, overstoryDir);
					results.push(...checkResults);
				}

				// Apply fixes if requested
				let fixedItems: string[] | undefined;
				if (fix) {
					const applied = await applyFixes(results);
					if (applied.length > 0) {
						fixedItems = applied;
						// Re-run all checks to get fresh results after fixes
						results = [];
						for (const { fn } of checksToRun) {
							const checkResults = await fn(config, overstoryDir);
							results.push(...checkResults);
						}
					}
				}

				// Output results
				if (json) {
					printJSON(results, fixedItems);
				} else {
					printHumanReadable(results, verbose, allChecks, fixedItems);
				}

				// Set exit code if any check failed
				const hasFailures = results.some((c) => c.status === "fail");
				if (hasFailures) {
					process.exitCode = 1;
				}
			},
		);
}

/**
 * Entry point for `overstory doctor [--json] [--verbose] [--category <name>]`.
 *
 * @returns Exit code (1 if any check failed, undefined otherwise)
 */
export async function doctorCommand(
	args: string[],
	options?: DoctorCommandOptions,
): Promise<number | undefined> {
	const cmd = createDoctorCommand(options);
	cmd.exitOverride();

	const prevExitCode = process.exitCode as number | undefined;
	// Bun does not reliably clear a nonzero exitCode when reassigned to undefined,
	// so use 0 as the neutral sentinel while this command runs.
	process.exitCode = 0;

	try {
		await cmd.parseAsync(args, { from: "user" });
	} catch (err: unknown) {
		process.exitCode = prevExitCode ?? 0;
		if (err && typeof err === "object" && "code" in err) {
			const code = (err as { code: string }).code;
			if (code === "commander.helpDisplayed" || code === "commander.version") {
				return undefined;
			}
		}
		throw err;
	}

	const exitCode = process.exitCode === 1 ? 1 : undefined;
	process.exitCode = prevExitCode ?? 0;
	return exitCode;
}

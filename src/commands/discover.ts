/**
 * CLI command: ov discover
 *
 * Spawns scout agents with the ov-discovery canopy profile to explore a
 * brownfield codebase and produce structured mulch records. Each category
 * runs as a parallel scout agent assigned to a focused research area.
 */

import { join } from "node:path";
import { Command } from "commander";
import { loadConfig } from "../config.ts";
import { ValidationError } from "../errors.ts";
import { jsonOutput } from "../json.ts";
import { accent, muted, printSuccess } from "../logging/color.ts";
import { createMailClient } from "../mail/client.ts";
import { createMailStore } from "../mail/store.ts";

/** A single discovery category with its research focus. */
export interface DiscoveryCategory {
	name: string;
	subject: string;
	body: string;
}

/** All discovery categories that scouts will explore. */
export const DISCOVERY_CATEGORIES: DiscoveryCategory[] = [
	{
		name: "architecture",
		subject: "Discover: architecture",
		body: "Explore directory structure, module boundaries, layering conventions, and design patterns. Identify the core architectural style (monolith, layered, hexagonal, etc.), note major subsystems and their relationships, and document any implicit layering rules or boundary conventions.",
	},
	{
		name: "dependencies",
		subject: "Discover: dependencies",
		body: "Catalog all npm packages, CLI tool dependencies, and version constraints. Identify runtime vs dev dependencies, note any unusual or pinned versions, and flag deprecated or potentially problematic packages. Document any external CLIs invoked as subprocesses.",
	},
	{
		name: "testing",
		subject: "Discover: testing",
		body: "Map the test framework, file locations, mock strategy, and coverage gaps. Identify what test runner is used, where tests live relative to source, what mocking patterns are used (and why), and which subsystems lack adequate test coverage.",
	},
	{
		name: "apis",
		subject: "Discover: apis",
		body: "Document exported functions and types, interfaces, error handling patterns, and CLI structure. Identify the public API surface, note how errors are typed and propagated, and document any conventions around return types or async patterns.",
	},
	{
		name: "config",
		subject: "Discover: config",
		body: "Catalog config file formats, environment variables, loading and validation patterns, and default values. Note how configuration is structured (YAML, JSON, env), how it's validated at runtime, and what the expected defaults are.",
	},
	{
		name: "implicit",
		subject: "Discover: implicit",
		body: "Surface naming conventions, error handling style, TODOs, and unwritten rules. Look for patterns in variable naming, file naming, comment style, and any informal conventions that aren't documented. Note recurring TODOs or FIXMEs that indicate known debt.",
	},
];

/** Set of valid category names for validation. */
export const VALID_CATEGORY_NAMES: ReadonlySet<string> = new Set(
	DISCOVERY_CATEGORIES.map((c) => c.name),
);

export interface DiscoverOptions {
	skip?: string;
	name?: string;
	taskId?: string;
	json?: boolean;
}

interface SpawnResult {
	category: string;
	success: boolean;
	error?: string;
}

/** Parse and validate the --skip option, returning a set of category names to skip. */
function parseSkipCategories(skip: string | undefined): Set<string> {
	if (!skip) return new Set();
	const names = skip
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
	const invalid = names.filter((n) => !VALID_CATEGORY_NAMES.has(n));
	if (invalid.length > 0) {
		throw new ValidationError(
			`Invalid category name(s): ${invalid.join(", ")}. Valid categories: ${[...VALID_CATEGORY_NAMES].join(", ")}`,
		);
	}
	return new Set(names);
}

/**
 * Build the ov sling args for a single discovery scout.
 * Exported for unit testing without side effects.
 */
export function buildScoutArgs(
	taskId: string,
	categoryName: string,
	parentName: string,
	totalCategories: number,
): string[] {
	const scoutTaskId = `${taskId}-${categoryName}`;
	return [
		"ov",
		"sling",
		scoutTaskId,
		"--capability",
		"scout",
		"--name",
		`discover-${categoryName}`,
		"--profile",
		"ov-discovery",
		"--parent",
		parentName,
		"--depth",
		"1",
		"--skip-task-check",
		"--max-agents",
		String(totalCategories),
	];
}

/** Main handler for ov discover. */
export async function discoverCommand(opts: DiscoverOptions): Promise<void> {
	const json = opts.json ?? false;
	const parentName = opts.name ?? "discover";
	const taskId = opts.taskId ?? `discover-${Date.now()}`;

	// Validate and parse skip list
	const skipSet = parseSkipCategories(opts.skip);
	const categories = DISCOVERY_CATEGORIES.filter((c) => !skipSet.has(c.name));

	if (categories.length === 0) {
		throw new ValidationError("All categories skipped — nothing to discover.");
	}

	// Load config to find project root for mail db
	const config = await loadConfig(process.cwd());
	const projectRoot = config.project.root;
	const mailDbPath = join(projectRoot, ".overstory", "mail.db");
	const mailStore = createMailStore(mailDbPath);
	const mailClient = createMailClient(mailStore);

	const results: SpawnResult[] = [];

	try {
		for (const category of categories) {
			const agentName = `discover-${category.name}`;
			const args = buildScoutArgs(taskId, category.name, parentName, categories.length);

			const proc = Bun.spawn(args, {
				stdout: "pipe",
				stderr: "pipe",
			});
			const exitCode = await proc.exited;

			if (exitCode !== 0) {
				const stderr = await new Response(proc.stderr).text();
				results.push({
					category: category.name,
					success: false,
					error: stderr.trim() || `exit code ${exitCode}`,
				});
				process.stderr.write(
					`  ${muted("!")} Failed to spawn ${accent(agentName)}: ${stderr.trim()}\n`,
				);
				continue;
			}

			// Send dispatch mail with research focus
			mailClient.send({
				from: parentName,
				to: agentName,
				subject: category.subject,
				body: category.body,
				type: "dispatch",
			});

			results.push({ category: category.name, success: true });
		}
	} finally {
		mailStore.close();
	}

	const succeeded = results.filter((r) => r.success);
	const failed = results.filter((r) => !r.success);

	if (json) {
		jsonOutput("discover", {
			taskId,
			parentName,
			categories: results,
			summary: {
				total: results.length,
				spawned: succeeded.length,
				failed: failed.length,
			},
		});
		return;
	}

	// Human-readable output
	printSuccess(`Discovery swarm launched`, taskId);
	process.stdout.write(`\n`);
	process.stdout.write(`  ${muted("Task ID:")}  ${accent(taskId)}\n`);
	process.stdout.write(`  ${muted("Parent: ")}  ${accent(parentName)}\n`);
	process.stdout.write(`  ${muted("Scouts: ")}  ${succeeded.length} spawned`);
	if (failed.length > 0) {
		process.stdout.write(`, ${failed.length} failed`);
	}
	process.stdout.write(`\n\n`);

	for (const r of results) {
		const icon = r.success ? "✓" : "✗";
		process.stdout.write(`  ${r.success ? accent(icon) : muted(icon)} discover-${r.category}\n`);
	}

	process.stdout.write(`\n`);
	process.stdout.write(`${muted("Monitor progress:")}\n`);
	process.stdout.write(`  ${muted("$")} ov status\n`);
	process.stdout.write(`\n`);
	process.stdout.write(`${muted("Review results when complete:")}\n`);
	process.stdout.write(`  ${muted("$")} ml prime\n`);
}

/** Commander command factory. */
export function createDiscoverCommand(): Command {
	return new Command("discover")
		.description("Discover a brownfield codebase via scout swarm")
		.option(
			"--skip <categories>",
			"Skip specific categories (comma-separated: architecture,dependencies,testing,apis,config,implicit)",
		)
		.option("--name <name>", "Parent agent name (default: discover)")
		.option("--task-id <id>", "Task ID for the discovery swarm (default: auto-generated)")
		.option("--json", "Output as JSON")
		.action(async (opts: DiscoverOptions) => {
			await discoverCommand(opts);
		});
}

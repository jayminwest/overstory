/**
 * CLI command: ov discover
 *
 * Launches a coordinator session with the ov-discovery profile to explore a
 * brownfield codebase and produce structured mulch records. The coordinator
 * autonomously spawns leads, which spawn scouts per category, synthesizes
 * results, and writes mulch records.
 */

import { Command } from "commander";
import { ValidationError } from "../errors.ts";
import type { CoordinatorDeps, CoordinatorSessionOptions } from "./coordinator.ts";
import { startCoordinatorSession } from "./coordinator.ts";

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
	attach?: boolean;
	watchdog?: boolean;
	json?: boolean;
}

/** Dependency injection for discoverCommand. Used in tests. */
export interface DiscoverDeps {
	_startCoordinatorSession?: (
		opts: CoordinatorSessionOptions,
		deps: CoordinatorDeps,
	) => Promise<void>;
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
 * Build the discovery beacon — the initial prompt sent to the discover coordinator
 * after Claude Code initializes. Instructs it to spawn one lead per category.
 */
export function buildDiscoveryBeacon(
	categories: DiscoveryCategory[],
	coordinatorName: string,
): string {
	const timestamp = new Date().toISOString();
	const categoryNames = categories.map((c) => c.name).join(", ");
	const categoryDetails = categories.map((c) => `${c.name}: ${c.body}`).join(" | ");
	const parts = [
		`[OVERSTORY] ${coordinatorName} (coordinator) ${timestamp}`,
		`Role: discovery coordinator | Categories: ${categoryNames}`,
		`Startup: run mulch prime, then spawn one lead per active category. Each lead spawns a scout to explore its category area. After all scouts report back, synthesize findings into mulch records.`,
		`Categories: ${categoryDetails}`,
	];
	return parts.join(" — ");
}

/**
 * Build the scout args for a given discovery category and task ID.
 * Kept for reference and for callers that need per-category sling arguments.
 */
export function buildScoutArgs(
	category: DiscoveryCategory,
	taskId: string,
	parentName: string,
): string[] {
	return [
		"ov",
		"sling",
		taskId,
		"--capability",
		"scout",
		"--name",
		`discover-${category.name}`,
		"--profile",
		"ov-discovery",
		"--parent",
		parentName,
		"--depth",
		"1",
		"--skip-task-check",
	];
}

/** Main handler for ov discover. */
export async function discoverCommand(
	opts: DiscoverOptions,
	deps: DiscoverDeps = {},
): Promise<void> {
	const json = opts.json ?? false;
	const coordinatorName = opts.name ?? "discover-coordinator";

	// Validate and parse skip list
	const skipSet = parseSkipCategories(opts.skip);
	const categories = DISCOVERY_CATEGORIES.filter((c) => !skipSet.has(c.name));

	if (categories.length === 0) {
		throw new ValidationError("All categories skipped — nothing to discover.");
	}

	const attach = opts.attach !== undefined ? opts.attach : !!process.stdout.isTTY;

	const startSession = deps._startCoordinatorSession ?? startCoordinatorSession;

	await startSession(
		{
			json,
			attach,
			watchdog: opts.watchdog ?? false,
			monitor: false,
			profile: "ov-discovery",
			coordinatorName,
			beaconBuilder: (_trackerCli) => buildDiscoveryBeacon(categories, coordinatorName),
		},
		{},
	);
}

/** Commander command factory. */
export function createDiscoverCommand(): Command {
	return new Command("discover")
		.description("Discover a brownfield codebase via coordinator-driven scout swarm")
		.option(
			"--skip <categories>",
			"Skip specific categories (comma-separated: architecture,dependencies,testing,apis,config,implicit)",
		)
		.option("--name <name>", "Coordinator agent name (default: discover-coordinator)")
		.option("--task-id <id>", "Task ID (unused — kept for backward compatibility)")
		.option("--attach", "Always attach to tmux session after start")
		.option("--no-attach", "Never attach to tmux session after start")
		.option("--watchdog", "Auto-start watchdog daemon with coordinator")
		.option("--json", "Output as JSON")
		.action(
			async (opts: {
				skip?: string;
				name?: string;
				taskId?: string;
				attach?: boolean;
				watchdog?: boolean;
				json?: boolean;
			}) => {
				const attach = opts.attach !== undefined ? opts.attach : !!process.stdout.isTTY;
				await discoverCommand({ ...opts, attach });
			},
		);
}

/**
 * CLI command: overstory agents <sub> [--json]
 *
 * Discover and query agents by capability.
 */

import { join } from "node:path";
import { getInstructionLayout, resolveCliBase } from "../cli-base.ts";
import { loadConfig } from "../config.ts";
import { ValidationError } from "../errors.ts";
import { openSessionStore } from "../sessions/compat.ts";
import { type AgentSession, SUPPORTED_CAPABILITIES } from "../types.ts";

/**
 * Parse a named flag value from args.
 */
function getFlag(args: string[], flag: string): string | undefined {
	const idx = args.indexOf(flag);
	if (idx === -1 || idx + 1 >= args.length) {
		return undefined;
	}
	return args[idx + 1];
}

function hasFlag(args: string[], flag: string): boolean {
	return args.includes(flag);
}

/**
 * Discovered agent information including file scope.
 */
export interface DiscoveredAgent {
	agentName: string;
	capability: string;
	state: string;
	beadId: string;
	branchName: string;
	parentAgent: string | null;
	depth: number;
	fileScope: string[];
	startedAt: string;
	lastActivity: string;
}

/**
 * Extract file scope from an agent's overlay instructions document.
 * Returns empty array if overlay doesn't exist, has no file scope restrictions,
 * or can't be read.
 *
 * @param worktreePath - Absolute path to the agent's worktree
 * @param instructionsPath - Relative overlay path (e.g. ".claude/CLAUDE.md" or "AGENTS.md")
 * @returns Array of file paths (relative to worktree root)
 */
export async function extractFileScope(
	worktreePath: string,
	instructionsPath = ".claude/CLAUDE.md",
): Promise<string[]> {
	try {
		const overlayPath = join(worktreePath, instructionsPath);
		const overlayFile = Bun.file(overlayPath);

		if (!(await overlayFile.exists())) {
			return [];
		}

		const content = await overlayFile.text();

		// Find the section between "## File Scope (exclusive ownership)" and "## Expertise"
		const startMarker = "## File Scope (exclusive ownership)";
		const endMarker = "## Expertise";

		const startIdx = content.indexOf(startMarker);
		if (startIdx === -1) {
			return [];
		}

		const endIdx = content.indexOf(endMarker, startIdx);
		if (endIdx === -1) {
			return [];
		}

		const section = content.slice(startIdx, endIdx);

		// Check for "No file scope restrictions"
		if (section.includes("No file scope restrictions")) {
			return [];
		}

		// Extract file paths from markdown list items: - `path`
		const paths: string[] = [];
		const regex = /^- `(.+)`$/gm;
		let match = regex.exec(section);

		while (match !== null) {
			if (match[1]) {
				paths.push(match[1]);
			}
			match = regex.exec(section);
		}

		return paths;
	} catch {
		// Best effort: return empty array if anything fails
		return [];
	}
}

/**
 * Discover agents in the project.
 *
 * @param root - Absolute path to project root
 * @param opts - Filter options
 * @returns Array of discovered agents with file scopes
 */
export async function discoverAgents(
	root: string,
	opts?: { capability?: string; includeAll?: boolean; instructionsPath?: string },
): Promise<DiscoveredAgent[]> {
	const overstoryDir = join(root, ".overstory");
	const { store } = openSessionStore(overstoryDir);

	try {
		const sessions: AgentSession[] = opts?.includeAll ? store.getAll() : store.getActive();

		// Filter by capability if specified
		let filteredSessions = sessions;
		if (opts?.capability) {
			filteredSessions = sessions.filter((s) => s.capability === opts.capability);
		}

		// Extract file scopes for each agent
		const agents: DiscoveredAgent[] = await Promise.all(
			filteredSessions.map(async (session) => {
				return {
					agentName: session.agentName,
					capability: session.capability,
					state: session.state,
					beadId: session.beadId,
					branchName: session.branchName,
					parentAgent: session.parentAgent,
					depth: session.depth,
					fileScope: await extractFileScope(
						session.worktreePath,
						opts?.instructionsPath ?? ".claude/CLAUDE.md",
					),
					startedAt: session.startedAt,
					lastActivity: session.lastActivity,
				};
			}),
		);

		return agents;
	} finally {
		store.close();
	}
}

/**
 * Format the state icon for display.
 */
function getStateIcon(state: string): string {
	switch (state) {
		case "working":
			return "●";
		case "booting":
			return "○";
		case "stalled":
			return "◌";
		default:
			return " ";
	}
}

/**
 * Print discovered agents in human-readable format.
 */
function printAgents(agents: DiscoveredAgent[]): void {
	const w = process.stdout.write.bind(process.stdout);

	if (agents.length === 0) {
		w("No agents found.\n");
		return;
	}

	w(`Found ${agents.length} agent${agents.length === 1 ? "" : "s"}:\n\n`);

	for (const agent of agents) {
		const icon = getStateIcon(agent.state);
		w(`  ${icon} ${agent.agentName} [${agent.capability}]\n`);
		w(`    State: ${agent.state} | Task: ${agent.beadId}\n`);
		w(`    Branch: ${agent.branchName}\n`);
		w(`    Parent: ${agent.parentAgent ?? "none"} | Depth: ${agent.depth}\n`);

		if (agent.fileScope.length === 0) {
			w("    Files: (unrestricted)\n");
		} else {
			w(`    Files: ${agent.fileScope.join(", ")}\n`);
		}

		w("\n");
	}
}

const DISCOVER_HELP = `overstory agents discover — Find active agents by capability

Usage: overstory agents discover [--capability <type>] [--all] [--json]

Options:
  --capability <type>   Filter by capability (builder, scout, reviewer, lead, merger, coordinator, supervisor)
  --all                 Include completed and zombie agents (default: active only)
  --json                Output as JSON
  --help, -h            Show this help`;

const AGENTS_HELP = `overstory agents — Discover and query agents

Usage: overstory agents <subcommand> [options]

Subcommands:
  discover              Find active agents by capability

Options:
  --json                Output as JSON
  --help, -h            Show this help

Run 'overstory agents <subcommand> --help' for subcommand-specific help.`;

/**
 * Handle the 'discover' subcommand.
 */
async function discoverCommand(args: string[]): Promise<void> {
	if (hasFlag(args, "--help") || hasFlag(args, "-h")) {
		process.stdout.write(`${DISCOVER_HELP}\n`);
		return;
	}

	const json = hasFlag(args, "--json");
	const includeAll = hasFlag(args, "--all");
	const capability = getFlag(args, "--capability");

	// Validate capability if provided
	if (capability && !SUPPORTED_CAPABILITIES.includes(capability as never)) {
		throw new ValidationError(
			`Invalid capability: ${capability}. Must be one of: ${SUPPORTED_CAPABILITIES.join(", ")}`,
			{
				field: "capability",
				value: capability,
			},
		);
	}

	const cwd = process.cwd();
	const config = await loadConfig(cwd);
	const root = config.project.root;
	const instructionLayout = getInstructionLayout(resolveCliBase(config));

	const agents = await discoverAgents(root, {
		capability,
		includeAll,
		instructionsPath: instructionLayout.startupPath,
	});

	if (json) {
		process.stdout.write(`${JSON.stringify(agents, null, "\t")}\n`);
	} else {
		printAgents(agents);
	}
}

/**
 * Entry point for `overstory agents <subcommand>`.
 */
export async function agentsCommand(args: string[]): Promise<void> {
	if (hasFlag(args, "--help") || hasFlag(args, "-h")) {
		process.stdout.write(`${AGENTS_HELP}\n`);
		return;
	}

	// Extract subcommand: first arg that is not a flag
	const subcommand = args.find((arg) => !arg.startsWith("-"));

	if (!subcommand) {
		process.stdout.write(`${AGENTS_HELP}\n`);
		return;
	}

	// Remove the subcommand from args before passing to handler
	const subArgs = args.filter((arg) => arg !== subcommand);

	switch (subcommand) {
		case "discover":
			await discoverCommand(subArgs);
			break;
		default:
			throw new ValidationError(`Unknown subcommand: ${subcommand}`, {
				field: "subcommand",
				value: subcommand,
			});
	}
}

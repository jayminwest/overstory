/**
 * CLI command: ov agents <sub> [--json]
 *
 * Discover and query agents by capability.
 */

import { join } from "node:path";
import { Command } from "commander";
import { loadConfig } from "../config.ts";
import { ValidationError } from "../errors.ts";
import { jsonOutput } from "../json.ts";
import { accent, color } from "../logging/color.ts";
import { getAllRuntimes, getRuntime } from "../runtimes/registry.ts";
import { openSessionStore } from "../sessions/compat.ts";
import { type AgentSession, SUPPORTED_CAPABILITIES } from "../types.ts";

/**
 * Discovered agent information including file scope.
 */
export interface DiscoveredAgent {
	agentName: string;
	capability: string;
	state: string;
	taskId: string;
	branchName: string;
	parentAgent: string | null;
	depth: number;
	fileScope: string[];
	startedAt: string;
	lastActivity: string;
}

/** Build the list of known instruction file paths from all registered runtimes. */
function getKnownInstructionPaths(): string[] {
	return [...new Set(getAllRuntimes().map((r) => r.instructionPath))];
}

/**
 * Extract file scope from an agent's overlay instruction file.
 * Returns empty array if no overlay exists, has no file scope restrictions,
 * or can't be read.
 *
 * @param worktreePath - Absolute path to the agent's worktree
 * @param runtimeInstructionPath - Optional runtime-specific instruction path to try first
 * @returns Array of file paths (relative to worktree root)
 */
export async function extractFileScope(
	worktreePath: string,
	runtimeInstructionPath?: string,
): Promise<string[]> {
	try {
		let content: string | null = null;
		const knownPaths = getKnownInstructionPaths();
		const pathsToTry = runtimeInstructionPath
			? [runtimeInstructionPath, ...knownPaths]
			: knownPaths;
		for (const relPath of pathsToTry) {
			const overlayPath = join(worktreePath, relPath);
			const overlayFile = Bun.file(overlayPath);
			if (await overlayFile.exists()) {
				content = await overlayFile.text();
				break;
			}
		}
		if (content === null) {
			return [];
		}

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
	opts?: { capability?: string; includeAll?: boolean },
): Promise<DiscoveredAgent[]> {
	const overstoryDir = join(root, ".overstory");
	const { store } = openSessionStore(overstoryDir);

	// Resolve runtime instruction path from config; fall back gracefully if config is absent.
	let runtimeInstructionPath: string | undefined;
	try {
		const config = await loadConfig(root);
		const runtime = getRuntime(undefined, config);
		runtimeInstructionPath = runtime.instructionPath;
	} catch {
		// Config may not exist in all contexts; KNOWN_INSTRUCTION_PATHS will be used as fallback.
	}

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
				const fileScope = await extractFileScope(session.worktreePath, runtimeInstructionPath);
				return {
					agentName: session.agentName,
					capability: session.capability,
					state: session.state,
					taskId: session.taskId,
					branchName: session.branchName,
					parentAgent: session.parentAgent,
					depth: session.depth,
					fileScope,
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
 *
 * `in_turn` and `between_turns` (overstory-3087) render with the same cyan
 * accent as `working` so a spawn-per-turn worker is visually grouped with
 * other healthy/active agents in `ov agents` output. They use distinct
 * glyphs ('>' vs '~') to mirror the dashboard / theme.ts mapping.
 */
function getStateIcon(state: string): string {
	switch (state) {
		case "working":
			return color.cyan(">");
		case "in_turn":
			return color.cyan(">");
		case "between_turns":
			return color.cyan("~");
		case "booting":
			return color.green("-");
		case "stalled":
			return color.yellow("!");
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
		w(`  ${icon} ${accent(agent.agentName)} [${agent.capability}]\n`);
		w(`    State: ${agent.state} | Task: ${accent(agent.taskId)}\n`);
		w(`    Branch: ${accent(agent.branchName)}\n`);
		w(
			`    Parent: ${agent.parentAgent ? accent(agent.parentAgent) : "none"} | Depth: ${agent.depth}\n`,
		);

		if (agent.fileScope.length === 0) {
			w("    Files: (unrestricted)\n");
		} else {
			w(`    Files: ${agent.fileScope.join(", ")}\n`);
		}

		w("\n");
	}
}

/**
 * Create the Commander command for `ov agents`.
 */
export function createAgentsCommand(): Command {
	const cmd = new Command("agents").description("Discover and query agents");

	cmd
		.command("discover")
		.description("Find active agents by capability")
		.option(
			"--capability <type>",
			"Filter by capability (builder, scout, reviewer, lead, merger, orchestrator, coordinator, supervisor)",
		)
		.option("--all", "Include completed and zombie agents (default: active only)")
		.option("--json", "Output as JSON")
		.action(async (opts: { capability?: string; all?: boolean; json?: boolean }) => {
			const capability = opts.capability;

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

			const agents = await discoverAgents(root, {
				capability,
				includeAll: opts.all ?? false,
			});

			if (opts.json) {
				jsonOutput("agents discover", { agents });
			} else {
				printAgents(agents);
			}
		});

	return cmd;
}

/**
 * Entry point for `ov agents <subcommand>`.
 */
export async function agentsCommand(args: string[]): Promise<void> {
	const cmd = createAgentsCommand();
	cmd.exitOverride();

	if (args.length === 0) {
		process.stdout.write(cmd.helpInformation());
		return;
	}

	try {
		await cmd.parseAsync(args, { from: "user" });
	} catch (err: unknown) {
		if (err && typeof err === "object" && "code" in err) {
			const code = (err as { code: string }).code;
			if (code === "commander.helpDisplayed" || code === "commander.version") {
				return;
			}
			if (code === "commander.unknownCommand") {
				const message = err instanceof Error ? err.message : String(err);
				throw new ValidationError(message, { field: "subcommand" });
			}
		}
		throw err;
	}
}

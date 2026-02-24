/**
 * CLI command: overstory spec write <bead-id> --body <content>
 *
 * Writes a task specification to `.overstory/specs/<bead-id>.md`.
 * Scouts use this to persist spec documents as files instead of
 * sending entire specs via mail messages.
 *
 * Supports reading body content from --body flag or stdin.
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { ValidationError } from "../errors.ts";

/** Boolean flags that do NOT consume the next arg. */
const BOOLEAN_FLAGS = new Set(["--help", "-h", "--template"]);

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

/**
 * Extract positional arguments, skipping flag-value pairs.
 */
function getPositionalArgs(args: string[]): string[] {
	const positional: string[] = [];
	let i = 0;
	while (i < args.length) {
		const arg = args[i];
		if (arg?.startsWith("-")) {
			if (BOOLEAN_FLAGS.has(arg)) {
				i += 1;
			} else {
				i += 2;
			}
		} else {
			if (arg !== undefined) {
				positional.push(arg);
			}
			i += 1;
		}
	}
	return positional;
}

/**
 * The 14-section spec template structure based on the user's spec-builder agent.
 * Each section is a heading that scaffolds a comprehensive task specification.
 * Execution sections (Agent Assignments, Execution Order, etc.) follow the core 14.
 */
const SPEC_TEMPLATE_SECTIONS = [
	"## Why",
	"## Design Principles",
	"## On-Disk Format",
	"## Data Model",
	"## CLI",
	"## JSON Output Format",
	"## Concurrency Model",
	"## Migration",
	"## Integration",
	"## What It Does NOT Do",
	"## Tech Stack",
	"## Project Infrastructure",
	"## Estimated Size",
	"## Agent Assignments",
	"## Execution Order",
	"## Failure Modes",
	"## Success Criteria",
] as const;

/**
 * Generate a spec scaffold from the 14-section template.
 * If body content is provided, it is placed under the title heading.
 * Otherwise, each section gets a placeholder comment.
 */
export function generateSpecTemplate(beadId: string, body?: string): string {
	const lines: string[] = [];
	lines.push(`# ${beadId}`);
	lines.push("");
	if (body && body.trim().length > 0) {
		lines.push(body.trim());
		lines.push("");
	}
	for (const section of SPEC_TEMPLATE_SECTIONS) {
		lines.push(section);
		lines.push("");
		lines.push("<!-- TODO: fill in this section -->");
		lines.push("");
	}
	return lines.join("\n");
}

/**
 * Read all of stdin as a string. Returns empty string if stdin is a TTY
 * (no piped input).
 */
async function readStdin(): Promise<string> {
	// Bun.stdin is a ReadableStream when piped, a TTY otherwise
	if (process.stdin.isTTY) {
		return "";
	}
	return await new Response(Bun.stdin.stream()).text();
}

const SPEC_HELP = `overstory spec -- Manage task specifications

Usage: overstory spec <subcommand> [args...]

Subcommands:
  write <bead-id>          Write a spec file to .overstory/specs/<bead-id>.md

Options for 'write':
  --body <content>         Spec content (or pipe via stdin)
  --agent <name>           Agent writing the spec (for attribution)
  --template               Scaffold with 14-section spec-builder template
  --help, -h               Show this help

Examples:
  overstory spec write task-abc --body "# Spec\\nDetails here..."
  echo "# Spec" | overstory spec write task-abc
  overstory spec write task-abc --body "..." --agent scout-1
  overstory spec write task-abc --template
  overstory spec write task-abc --template --body "Context for this task"`;

/**
 * Write a spec file to .overstory/specs/<bead-id>.md.
 *
 * Exported for direct use in tests.
 */
export async function writeSpec(
	projectRoot: string,
	beadId: string,
	body: string,
	agent?: string,
): Promise<string> {
	const specsDir = join(projectRoot, ".overstory", "specs");
	await mkdir(specsDir, { recursive: true });

	// Build the spec content with optional attribution header
	let content = "";
	if (agent) {
		content += `<!-- written-by: ${agent} -->\n`;
	}
	content += body;

	// Ensure trailing newline
	if (!content.endsWith("\n")) {
		content += "\n";
	}

	const specPath = join(specsDir, `${beadId}.md`);
	await Bun.write(specPath, content);

	return specPath;
}

/**
 * Entry point for `overstory spec <subcommand>`.
 */
export async function specCommand(args: string[]): Promise<void> {
	if (args.includes("--help") || args.includes("-h") || args.length === 0) {
		process.stdout.write(`${SPEC_HELP}\n`);
		return;
	}

	const subcommand = args[0];
	const subArgs = args.slice(1);

	switch (subcommand) {
		case "write": {
			const positional = getPositionalArgs(subArgs);
			const beadId = positional[0];
			if (!beadId || beadId.trim().length === 0) {
				throw new ValidationError(
					"Bead ID is required: overstory spec write <bead-id> --body <content>",
					{ field: "beadId" },
				);
			}

			const agent = getFlag(subArgs, "--agent");
			const useTemplate = subArgs.includes("--template");
			let body = getFlag(subArgs, "--body");

			// If no --body flag and not in template mode, try reading from stdin
			if (body === undefined && !useTemplate) {
				const stdinContent = await readStdin();
				if (stdinContent.trim().length > 0) {
					body = stdinContent;
				}
			}

			// --template mode: generate scaffold (body is optional context)
			if (useTemplate) {
				body = generateSpecTemplate(beadId, body ?? undefined);
			} else if (body === undefined || body.trim().length === 0) {
				throw new ValidationError("Spec body is required: use --body <content> or pipe via stdin", {
					field: "body",
				});
			}

			const { resolveProjectRoot } = await import("../config.ts");
			const projectRoot = await resolveProjectRoot(process.cwd());

			const specPath = await writeSpec(projectRoot, beadId, body as string, agent);
			process.stdout.write(`${specPath}\n`);
			break;
		}

		default:
			throw new ValidationError(
				`Unknown spec subcommand: ${subcommand}. Run 'overstory spec --help' for usage.`,
				{ field: "subcommand", value: subcommand },
			);
	}
}

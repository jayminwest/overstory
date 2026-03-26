/**
 * CLI command: ov spec write <bead-id> --body <content>
 *
 * Writes a task specification to `.overstory/specs/<task-id>.md`.
 * Scouts use this to persist spec documents as files instead of
 * sending entire specs via mail messages.
 *
 * Supports reading body content from --body flag or stdin.
 */

import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { loadProjectDefaultProfile, resolveProjectRoot } from "../config.ts";
import { ValidationError } from "../errors.ts";
import { jsonOutput } from "../json.ts";
import { printSuccess } from "../logging/color.ts";
import { resolveSpecPathForWorkflow } from "../workflow.ts";

export interface SpecWriteOptions {
	body?: string;
	agent?: string;
	workflow?: string;
	openspec?: boolean;
	json?: boolean;
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

/**
 * Write a spec file to .overstory/specs/<task-id>.md.
 *
 * Exported for direct use in tests.
 */
export async function writeSpec(
	projectRoot: string,
	taskId: string,
	body: string,
	agent?: string,
	opts: { workflow?: string; openspec?: boolean } = {},
): Promise<string> {
	const specPath = resolveSpecPathForWorkflow(projectRoot, taskId, opts.workflow, opts.openspec);
	await mkdir(dirname(specPath), { recursive: true });

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

	await Bun.write(specPath, content);

	return specPath;
}

/**
 * Entry point for `ov spec write <bead-id> [flags]`.
 *
 * @param taskId - The task ID for the spec file
 * @param opts - Command options
 */
export async function specWriteCommand(taskId: string, opts: SpecWriteOptions): Promise<void> {
	if (!taskId || taskId.trim().length === 0) {
		throw new ValidationError("Task ID is required: ov spec write <task-id> --body <content>", {
			field: "taskId",
		});
	}

	let body = opts.body;

	// If no --body flag, try reading from stdin
	if (body === undefined) {
		const stdinContent = await readStdin();
		if (stdinContent.trim().length > 0) {
			body = stdinContent;
		}
	}

	if (body === undefined || body.trim().length === 0) {
		throw new ValidationError("Spec body is required: use --body <content> or pipe via stdin", {
			field: "body",
		});
	}

	const projectRoot = await resolveProjectRoot(process.cwd());
	const defaultProfile = await loadProjectDefaultProfile(projectRoot);
	const workflow = opts.workflow ?? process.env.OVERSTORY_PROFILE ?? defaultProfile;

	const specPath = await writeSpec(projectRoot, taskId, body, opts.agent, {
		workflow,
		openspec: opts.openspec ?? false,
	});
	if (opts.json) {
		jsonOutput("spec-write", { taskId, path: specPath });
	} else {
		printSuccess("Spec written", taskId);
	}
}

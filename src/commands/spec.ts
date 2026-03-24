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
	title?: string;
	agent?: string;
	seed?: string;
	reference?: string[];
	constraint?: string[];
	acceptance?: string[];
	workflow?: string;
	trellis?: boolean;
	openspec?: boolean;
	force?: boolean;
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
	opts: {
		title?: string;
		seed?: string;
		reference?: string[];
		constraint?: string[];
		acceptance?: string[];
		workflow?: string;
		trellis?: boolean;
		openspec?: boolean;
		force?: boolean;
	} = {},
): Promise<string> {
	const specPath = resolveSpecPathForWorkflow(
		projectRoot,
		taskId,
		opts.workflow,
		opts.trellis ?? opts.openspec,
	);
	await mkdir(dirname(specPath), { recursive: true });
	if (specPath.endsWith(".yaml") && !opts.force && (await Bun.file(specPath).exists())) {
		throw new ValidationError(
			`Trellis spec already exists for '${taskId}'. Use 'trellis spec update ${taskId} ...' for ongoing edits or pass --force to replace it.`,
			{ field: "taskId", value: taskId },
		);
	}

	const content = specPath.endsWith(".yaml")
		? buildTrellisSpec(taskId, body, agent, opts)
		: buildMarkdownSpec(body, agent);

	await Bun.write(specPath, content);

	return specPath;
}

function buildMarkdownSpec(body: string, agent?: string): string {
	let content = "";
	if (agent) content += `<!-- written-by: ${agent} -->\n`;
	content += body;
	if (!content.endsWith("\n")) content += "\n";
	return content;
}

function buildTrellisSpec(
	taskId: string,
	body: string,
	agent?: string,
	opts: {
		title?: string;
		seed?: string;
		reference?: string[];
		constraint?: string[];
		acceptance?: string[];
	} = {},
): string {
	const timestamp = new Date().toISOString();
	const objective = body.trimEnd();
	const title = (opts.title?.trim() || deriveTrellisTitle(taskId, objective)).trim();
	const lines: string[] = [];
	if (agent) {
		lines.push(`# written-by: ${agent}`);
	}
	lines.push(`id: ${quoteYamlScalar(taskId)}`);
	lines.push(`title: ${quoteYamlScalar(title)}`);
	if (opts.seed?.trim()) {
		lines.push(`seed: ${quoteYamlScalar(opts.seed.trim())}`);
	}
	lines.push("status: draft");
	lines.push(`createdAt: ${quoteYamlScalar(timestamp)}`);
	lines.push(`updatedAt: ${quoteYamlScalar(timestamp)}`);
	lines.push("objective: |");
	for (const line of objective.split("\n")) {
		lines.push(`  ${line}`);
	}
	if (objective.length === 0) lines.push("  ");
	lines.push("constraints:");
	for (const constraint of opts.constraint ?? []) {
		lines.push(`  - ${quoteYamlScalar(constraint)}`);
	}
	lines.push("acceptance:");
	for (const item of opts.acceptance ?? []) {
		lines.push(`  - ${quoteYamlScalar(item)}`);
	}
	lines.push("references:");
	for (const reference of opts.reference ?? []) {
		lines.push(`  - ${quoteYamlScalar(reference)}`);
	}
	return `${lines.join("\n")}\n`;
}

function deriveTrellisTitle(taskId: string, body: string): string {
	for (const rawLine of body.split("\n")) {
		const line = rawLine.trim();
		if (!line || line.startsWith("<!--")) continue;
		if (line.startsWith("#")) {
			const heading = line.replace(/^#+\s*/, "").trim();
			return shortenTrellisTitle(heading || taskId);
		}
		return shortenTrellisTitle(line);
	}
	return taskId;
}

function shortenTrellisTitle(input: string, maxLength = 72): string {
	const collapsed = input.replace(/\s+/g, " ").trim();
	if (collapsed.length <= maxLength) return collapsed;
	return `${collapsed.slice(0, maxLength - 1).trimEnd()}…`;
}

function quoteYamlScalar(value: string): string {
	if (value === "" || /[:#[\]{}]/.test(value) || value.includes("\n") || value.startsWith(" ")) {
		return JSON.stringify(value);
	}
	return value;
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
		title: opts.title,
		seed: opts.seed,
		reference: opts.reference,
		constraint: opts.constraint,
		acceptance: opts.acceptance,
		workflow,
		trellis: opts.trellis ?? opts.openspec ?? false,
		force: opts.force ?? false,
	});
	if (opts.json) {
		jsonOutput("spec-write", { taskId, path: specPath });
	} else {
		printSuccess("Spec written", taskId);
	}
}

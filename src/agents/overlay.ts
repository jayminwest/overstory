import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { AgentError } from "../errors.ts";
import type { OverlayConfig } from "../types.ts";

/**
 * Resolve the path to the overlay template file.
 * The template lives at `templates/overlay.md.tmpl` relative to the repo root.
 */
function getTemplatePath(): string {
	// src/agents/overlay.ts -> repo root is ../../
	return join(dirname(import.meta.dir), "..", "templates", "overlay.md.tmpl");
}

/**
 * Format the file scope list as a markdown bullet list.
 * Returns a human-readable fallback if no files are scoped.
 */
function formatFileScope(fileScope: readonly string[]): string {
	if (fileScope.length === 0) {
		return "No file scope restrictions";
	}
	return fileScope.map((f) => `- \`${f}\``).join("\n");
}

/**
 * Format mulch domains as a `mulch prime` command.
 * Returns a human-readable fallback if no domains are configured.
 */
function formatMulchDomains(domains: readonly string[]): string {
	if (domains.length === 0) {
		return "No specific expertise domains configured";
	}
	return `\`\`\`bash\nmulch prime ${domains.join(" ")}\n\`\`\``;
}

/**
 * Format pre-fetched mulch expertise for embedding in the overlay.
 * Returns empty string if no expertise was provided (omits the section entirely).
 * When expertise IS provided, renders it under a 'Pre-loaded Expertise' heading
 * with a brief intro explaining it was loaded at spawn time based on file scope.
 */
function formatMulchExpertise(expertise: string | undefined): string {
	if (!expertise || expertise.trim().length === 0) {
		return "";
	}
	return [
		"### Pre-loaded Expertise",
		"",
		"The following expertise was automatically loaded at spawn time based on your file scope:",
		"",
		expertise,
	].join("\n");
}

/** Capabilities that are read-only and should not get quality gates for commits/tests/lint. */
const READ_ONLY_CAPABILITIES = new Set(["scout", "reviewer"]);

/**
 * The skip-scout section injected into lead overlays when --skip-scout is passed.
 * Instructs the lead to bypass Phase 1 (exploration) and go straight to Phase 2 (build).
 */
const SKIP_SCOUT_SECTION = `
## Skip Scout Mode

**IMPORTANT**: You have been spawned with \`--skip-scout\`. Skip Phase 1 (Scout) entirely.
Go directly to Phase 2 (Build): write specs from your existing knowledge and the
pre-loaded expertise above, then spawn builders immediately.

Do NOT spawn scout agents. Do NOT explore the codebase extensively.
Your parent has already gathered the context you need.
`;

/**
 * Format the quality gates section. Read-only agents (scout, reviewer) get
 * a lightweight section that only tells them to close the issue and report.
 * Writable agents get the full quality gates (tests, lint, build, commit).
 */
function formatQualityGates(config: OverlayConfig): string {
	if (READ_ONLY_CAPABILITIES.has(config.capability)) {
		return [
			"## Completion",
			"",
			"Before reporting completion:",
			"",
			`1. **Record mulch learnings:** \`mulch record <domain> --type <convention|pattern|reference> --description "..."\` — capture reusable knowledge from your work`,
			`2. **Close issue:** \`bd close ${config.beadId} --reason "summary of findings"\``,
			`3. **Send results:** \`overstory mail send --to ${config.parentAgent ?? "orchestrator"} --subject "done" --body "Summary" --type result --agent ${config.agentName}\``,
			"",
			"You are a read-only agent. Do NOT commit, modify files, or run quality gates.",
		].join("\n");
	}

	return [
		"## Quality Gates",
		"",
		"Before reporting completion, you MUST pass all quality gates:",
		"",
		"1. **Tests:** `bun test` — all tests must pass",
		"2. **Lint:** `bun run lint` — zero errors",
		"3. **Typecheck:** `bun run typecheck` — no TypeScript errors",
		`4. **Commit:** all changes committed to your branch (${config.branchName})`,
		`5. **Record mulch learnings:** \`mulch record <domain> --type <convention|pattern|failure|decision> --description "..." --outcome-status success --outcome-agent ${config.agentName}\` — capture insights from your work`,
		`6. **Signal completion:** send \`worker_done\` mail to ${config.parentAgent ?? "orchestrator"}: \`overstory mail send --to ${config.parentAgent ?? "orchestrator"} --subject "Worker done: ${config.beadId}" --body "Quality gates passed." --type worker_done --agent ${config.agentName}\``,
		`7. **Close issue:** \`bd close ${config.beadId} --reason "summary of changes"\``,
		"",
		"Do NOT push to the canonical branch. Your work will be merged by the",
		"orchestrator via `overstory merge`.",
	].join("\n");
}

/**
 * Format the constraints section. Read-only agents get read-only constraints.
 * Writable agents get file-scope and branch constraints.
 */
function formatConstraints(config: OverlayConfig): string {
	if (READ_ONLY_CAPABILITIES.has(config.capability)) {
		return [
			"## Constraints",
			"",
			"- You are **read-only**: do NOT modify, create, or delete any files",
			"- Do NOT commit, push, or make any git state changes",
			"- Report completion via `bd close` AND `overstory mail send --type result`",
			"- If you encounter a blocking issue, send mail with `--priority urgent --type error`",
		].join("\n");
	}

	return [
		"## Constraints",
		"",
		`- **WORKTREE ISOLATION**: All writes MUST target files within your worktree at \`${config.worktreePath}\``,
		"- NEVER write to the canonical repo root — all writes go to your worktree copy",
		"- Only modify files in your File Scope",
		`- Commit only to your branch: ${config.branchName}`,
		"- Never push to the canonical branch",
		"- Report completion via `bd close` AND `overstory mail send --type result`",
		"- If you encounter a blocking issue, send mail with `--priority urgent --type error`",
	].join("\n");
}

/**
 * Format the can-spawn section. If the agent can spawn sub-workers,
 * include an example sling command. Otherwise, state the restriction.
 */
function formatCanSpawn(config: OverlayConfig): string {
	if (!config.canSpawn) {
		return "You may NOT spawn sub-workers.";
	}
	return [
		"You may spawn sub-workers using `overstory sling`. Example:",
		"",
		"```bash",
		"overstory sling <task-id> --capability builder --name <worker-name> \\",
		`  --parent ${config.agentName} --depth ${config.depth + 1}`,
		"```",
	].join("\n");
}

/**
 * Generate a per-worker CLAUDE.md overlay from the template.
 *
 * Reads `templates/overlay.md.tmpl` and replaces all `{{VARIABLE}}`
 * placeholders with values derived from the provided config.
 *
 * @param config - The overlay configuration for this agent/task
 * @returns The rendered overlay content as a string
 * @throws {AgentError} If the template file cannot be found or read
 */
export async function generateOverlay(config: OverlayConfig): Promise<string> {
	const templatePath = getTemplatePath();
	const file = Bun.file(templatePath);
	const exists = await file.exists();

	if (!exists) {
		throw new AgentError(`Overlay template not found: ${templatePath}`, {
			agentName: config.agentName,
		});
	}

	let template: string;
	try {
		template = await file.text();
	} catch (err) {
		throw new AgentError(`Failed to read overlay template: ${templatePath}`, {
			agentName: config.agentName,
			cause: err instanceof Error ? err : undefined,
		});
	}

	const specInstruction = config.specPath
		? "Read your task spec at the path above. It contains the full description of\nwhat you need to build or review."
		: "No task spec was provided. Check your mail or ask your parent agent for details.";

	const replacements: Record<string, string> = {
		"{{AGENT_NAME}}": config.agentName,
		"{{BEAD_ID}}": config.beadId,
		"{{SPEC_PATH}}": config.specPath ?? "No spec file provided",
		"{{BRANCH_NAME}}": config.branchName,
		"{{WORKTREE_PATH}}": config.worktreePath,
		"{{PARENT_AGENT}}": config.parentAgent ?? "orchestrator",
		"{{DEPTH}}": String(config.depth),
		"{{FILE_SCOPE}}": formatFileScope(config.fileScope),
		"{{MULCH_DOMAINS}}": formatMulchDomains(config.mulchDomains),
		"{{MULCH_EXPERTISE}}": formatMulchExpertise(config.mulchExpertise),
		"{{CAN_SPAWN}}": formatCanSpawn(config),
		"{{QUALITY_GATES}}": formatQualityGates(config),
		"{{CONSTRAINTS}}": formatConstraints(config),
		"{{SPEC_INSTRUCTION}}": specInstruction,
		"{{SKIP_SCOUT}}": config.skipScout ? SKIP_SCOUT_SECTION : "",
		"{{BASE_DEFINITION}}": config.baseDefinition,
	};

	let result = template;
	for (const [placeholder, value] of Object.entries(replacements)) {
		// Replace all occurrences — some placeholders appear multiple times
		while (result.includes(placeholder)) {
			result = result.replace(placeholder, value);
		}
	}

	return result;
}

/**
 * Check whether a directory is the canonical project root by comparing resolved paths.
 *
 * Agent overlays must NEVER be written to the canonical repo root -- they belong
 * in worktrees. Writing an overlay to the project root overwrites the orchestrator's
 * `.claude/CLAUDE.md`, breaking the user's own Claude Code session (overstory-uwg4).
 *
 * Uses deterministic path comparison instead of checking for `.overstory/config.yaml`
 * because when dogfooding (running overstory on its own repo), that file is tracked
 * in git and appears in every worktree checkout (overstory-p4st).
 *
 * @param dir - Absolute path to check
 * @param canonicalRoot - Absolute path to the canonical project root
 * @returns true if dir resolves to the same path as canonicalRoot
 */
export function isCanonicalRoot(dir: string, canonicalRoot: string): boolean {
	return resolve(dir) === resolve(canonicalRoot);
}

/**
 * Generate the overlay and write it to `{worktreePath}/.claude/CLAUDE.md`.
 * Creates the `.claude/` directory if it does not exist.
 *
 * Includes a safety guard that prevents writing to the canonical project root.
 * Agent overlays belong in worktrees, never at the orchestrator's root.
 *
 * @param worktreePath - Absolute path to the agent's git worktree
 * @param config - The overlay configuration for this agent/task
 * @param canonicalRoot - Absolute path to the canonical project root (for guard check)
 * @throws {AgentError} If worktreePath is the canonical project root, or if
 *   the directory cannot be created or the file cannot be written
 */
export async function writeOverlay(
	worktreePath: string,
	config: OverlayConfig,
	canonicalRoot: string,
): Promise<void> {
	// Guard: never write agent overlays to the canonical project root.
	// The project root's .claude/CLAUDE.md belongs to the orchestrator/user.
	// Uses path comparison instead of file-existence heuristic to handle
	// dogfooding scenarios where .overstory/config.yaml is tracked in git
	// and appears in every worktree checkout (overstory-p4st).
	if (isCanonicalRoot(worktreePath, canonicalRoot)) {
		throw new AgentError(
			`Refusing to write overlay to canonical project root: ${worktreePath}. Agent overlays must target a worktree, not the orchestrator's root directory. This prevents overwriting the user's .claude/CLAUDE.md.`,
			{ agentName: config.agentName },
		);
	}

	const content = await generateOverlay(config);
	const claudeDir = join(worktreePath, ".claude");
	const outputPath = join(claudeDir, "CLAUDE.md");

	try {
		await mkdir(claudeDir, { recursive: true });
	} catch (err) {
		throw new AgentError(`Failed to create .claude/ directory at: ${claudeDir}`, {
			agentName: config.agentName,
			cause: err instanceof Error ? err : undefined,
		});
	}

	try {
		await Bun.write(outputPath, content);
	} catch (err) {
		throw new AgentError(`Failed to write overlay to: ${outputPath}`, {
			agentName: config.agentName,
			cause: err instanceof Error ? err : undefined,
		});
	}
}

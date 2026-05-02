import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { DEFAULT_QUALITY_GATES } from "../config.ts";
import { AgentError } from "../errors.ts";
import type { OverlayConfig, QualityGate } from "../types.ts";
import { terminalMailTypesFor } from "./capabilities.ts";

/**
 * Capability-specific completion-mail guidance for the dynamic overlay.
 *
 * Returns the terminal mail-type name and a one-line example fragment so the
 * overlay can render: "ov mail send ... --type <terminalType> ...".
 *
 * Crucial: this MUST stay in sync with `terminalMailTypesFor()` — overstory-1a4c
 * found that overlay text saying `--type result` while the runner watched only
 * for `worker_done` left worker sessions stuck in `working`.
 */
function completionMailTypeFor(capability: string): string {
	const types = terminalMailTypesFor(capability);
	// `terminalMailTypesFor` returns the canonical type first
	// (worker_done for workers, merged for mergers). Use that for prose;
	// agents may also use the secondary types (`merge_failed`, etc.) where
	// applicable per their base prompt.
	return types[0] ?? "worker_done";
}

/**
 * Resolve the path to the overlay template file.
 * The template lives at `templates/overlay.md.tmpl` relative to the repo root.
 */
function getTemplatePath(): string {
	// src/agents/overlay.ts -> repo root is ../../
	return join(dirname(import.meta.dir), "..", "templates", "overlay.md.tmpl");
}

/**
 * Format the parallel-siblings section (overstory-f76a). Returns empty string
 * when no siblings are configured. When set, renders a markdown section that
 * names each sibling and instructs the agent to rebase onto `main` BEFORE
 * sending `merge_ready`. Reason: parallel leads branch off pre-merge `main`;
 * whichever merges second carries a stale base and risks reverting sibling
 * work (mx-c0c122 stale-base-revert).
 *
 * Exported for unit-testing.
 */
export function formatSiblings(config: OverlayConfig): string {
	const siblings = config.siblings;
	if (!siblings || siblings.length === 0) return "";

	const bullets = siblings.map((name) => `- ${name}`).join("\n");
	return [
		"## Parallel Siblings",
		"",
		"The coordinator has dispatched the following sibling agents in parallel that may share file scope with you:",
		"",
		bullets,
		"",
		"**CRITICAL**: rebase your branch onto the latest `main` BEFORE sending `merge_ready`, then re-run quality gates AFTER the rebase. Sibling work may have landed on `main` while you were working — sending `merge_ready` from a stale base risks reverting their changes (mx-c0c122 stale-base-revert).",
		"",
		"```bash",
		"git fetch origin main:main",
		"git rebase main",
		"# re-run quality gates here, then signal merge_ready",
		"```",
	].join("\n");
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
 * Format mulch domains as a `ml prime` command.
 * Returns a human-readable fallback if no domains are configured.
 */
function formatMulchDomains(domains: readonly string[]): string {
	if (domains.length === 0) {
		return "No specific expertise domains configured";
	}
	return `\`\`\`bash\nml prime ${domains.join(" ")}\n\`\`\``;
}

/**
 * Format profile content (Layer 2: deployment-specific WHAT KIND) for embedding in the overlay.
 * Returns empty string if no profile was provided (omits the section entirely).
 * When profile IS provided, renders it as-is — the caller (canopy) owns the formatting.
 */
function formatProfile(profileContent: string | undefined): string {
	if (!profileContent || profileContent.trim().length === 0) {
		return "";
	}
	return profileContent;
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
 * Build the dispatch overrides section for lead overlays.
 * Only generates content when overrides are actually set.
 * The overlay is the source of truth -- leads read these directives, not mail.
 */
function formatDispatchOverrides(config: OverlayConfig): string {
	if (config.capability !== "lead") return "";

	const sections: string[] = [];

	if (config.skipReview) {
		sections.push(
			"- **SKIP REVIEW**: You have been instructed to skip the review phase. " +
				"Self-verify by reading the diff and running quality gates instead of spawning a reviewer.",
		);
	}

	if (config.maxAgentsOverride !== undefined && config.maxAgentsOverride > 0) {
		if (config.maxAgentsOverride === 1) {
			sections.push(
				"- **MAX AGENTS**: Your per-lead agent ceiling has been set to **1**. " +
					"Spend that slot on a single builder for the whole task — skip scouts and reviewers and self-verify the builder's diff yourself. " +
					"Leads cannot implement directly (Write/Edit/`git add`/`git commit` are blocked by the harness), so the one slot must be a builder.",
			);
		} else if (config.maxAgentsOverride === 2) {
			sections.push(
				"- **MAX AGENTS**: Your per-lead agent ceiling has been set to **2**. " +
					"Operate in compressed mode: spend the slots on builders (one or two), skip scouts and reviewers, and self-verify each diff yourself. " +
					"Leads do not implement; every change requires a builder spawn.",
			);
		} else {
			sections.push(
				`- **MAX AGENTS**: Your per-lead agent ceiling has been set to **${config.maxAgentsOverride}**. ` +
					"Do not spawn more than this many sub-workers.",
			);
		}
	}

	if (sections.length === 0) return "";

	return [
		"## Dispatch Overrides",
		"",
		"Your coordinator has set the following overrides for this work stream:",
		"",
		...sections,
		"",
		"Honor these directives. They override the default workflow described in your base definition.",
	].join("\n");
}

/**
 * Format the quality gates section. Read-only agents (scout, reviewer) get
 * a lightweight section that only tells them to close the issue and report.
 * Writable agents get the full quality gates (tests, lint, build, commit).
 */
/**
 * Resolve quality gates: use provided gates if non-empty, otherwise fall back to defaults.
 */
function resolveGates(gates: QualityGate[] | undefined): QualityGate[] {
	return gates && gates.length > 0 ? gates : DEFAULT_QUALITY_GATES;
}

/**
 * Format quality gates as inline backtick-delimited commands for prose sections.
 * Example: `bun test`, `bun run lint`, `bun run typecheck`
 */
export function formatQualityGatesInline(gates: QualityGate[] | undefined): string {
	return resolveGates(gates)
		.map((g) => `\`${g.command}\``)
		.join(", ");
}

/**
 * Format quality gates as a numbered step list for completion-protocol sections.
 * Example:
 *   1. Run `bun test` -- all tests must pass.
 *   2. Run `bun run lint` -- lint and formatting must be clean.
 */
export function formatQualityGatesSteps(gates: QualityGate[] | undefined): string {
	return resolveGates(gates)
		.map((g, i) => `${i + 1}. Run \`${g.command}\` -- ${g.description}.`)
		.join("\n");
}

/**
 * Format quality gates as a bash code block for workflow sections.
 * Example:
 *   ```bash
 *   bun test              # All tests must pass
 *   bun run lint          # Lint and format must be clean
 *   ```
 */
export function formatQualityGatesBash(gates: QualityGate[] | undefined): string {
	const resolved = resolveGates(gates);
	// Pad commands to align comments
	const maxLen = Math.max(...resolved.map((g) => g.command.length));
	const lines = resolved.map((g) => {
		const padded = g.command.padEnd(maxLen + 2);
		return `${padded}# ${g.description[0]?.toUpperCase() ?? ""}${g.description.slice(1)}`;
	});
	return ["```bash", ...lines, "```"].join("\n");
}

/**
 * Format quality gates as a bullet list for capabilities sections.
 * Example:
 *   - `bun test` (run tests)
 *   - `bun run lint` (lint and format check via biome)
 */
export function formatQualityGatesCapabilities(gates: QualityGate[] | undefined): string {
	return resolveGates(gates)
		.map((g) => `  - \`${g.command}\` (${g.description})`)
		.join("\n");
}

function formatQualityGates(config: OverlayConfig): string {
	if (READ_ONLY_CAPABILITIES.has(config.capability)) {
		const completionType = completionMailTypeFor(config.capability);
		return [
			"## Completion",
			"",
			"Before reporting completion:",
			"",
			`1. **Record mulch learnings:** \`ml record <domain> --type <convention|pattern|reference> --description "..."\` — capture reusable knowledge from your work`,
			`2. **Signal completion:** send \`${completionType}\` mail to ${config.parentAgent ?? "coordinator"}: \`ov mail send --to ${config.parentAgent ?? "coordinator"} --subject "Worker done: ${config.taskId}" --body "Summary of findings" --type ${completionType} --agent ${config.agentName}\``,
			`3. **Close issue:** \`${config.trackerCli ?? "sd"} close ${config.taskId} --reason "summary of findings"\``,
			"",
			"You are a read-only agent. Do NOT commit, modify files, or run quality gates.",
		].join("\n");
	}

	const gates =
		config.qualityGates && config.qualityGates.length > 0
			? config.qualityGates
			: DEFAULT_QUALITY_GATES;

	const gateLines = gates.map(
		(gate, i) => `${i + 1}. **${gate.name}:** \`${gate.command}\` — ${gate.description}`,
	);

	return [
		"## Quality Gates",
		"",
		"Before reporting completion, you MUST pass all quality gates:",
		"",
		...gateLines,
		`${gateLines.length + 1}. **Commit:** all changes committed to your branch (${config.branchName})`,
		`${gateLines.length + 2}. **Record mulch learnings:** \`ml record <domain> --type <convention|pattern|failure|decision> --description "..." --outcome-status success --outcome-agent ${config.agentName}\` — capture insights from your work`,
		`${gateLines.length + 3}. **Signal completion:** send \`worker_done\` mail to ${config.parentAgent ?? "coordinator"}: \`ov mail send --to ${config.parentAgent ?? "coordinator"} --subject "Worker done: ${config.taskId}" --body "Quality gates passed." --type worker_done --agent ${config.agentName}\``,
		`${gateLines.length + 4}. **Close issue:** \`${config.trackerCli ?? "sd"} close ${config.taskId} --reason "summary of changes"\``,
		"",
		"Do NOT push to the canonical branch. Your work will be merged by the",
		"coordinator via `ov merge`.",
	].join("\n");
}

/**
 * Format the constraints section. Read-only agents get read-only constraints.
 * Writable agents get file-scope and branch constraints.
 */
function formatConstraints(config: OverlayConfig): string {
	const completionType = completionMailTypeFor(config.capability);
	if (READ_ONLY_CAPABILITIES.has(config.capability)) {
		return [
			"## Constraints",
			"",
			"- You are **read-only**: do NOT modify, create, or delete any files",
			"- Do NOT commit, push, or make any git state changes",
			`- Report completion via \`${config.trackerCli ?? "sd"} close\` AND \`ov mail send --type ${completionType}\``,
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
		`- Report completion via \`${config.trackerCli ?? "sd"} close\` AND \`ov mail send --type ${completionType}\``,
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
		"You may spawn sub-workers using `ov sling`. Example:",
		"",
		"```bash",
		"ov sling <task-id> --capability builder --name <worker-name> \\",
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
		"{{TASK_ID}}": config.taskId,
		"{{SPEC_PATH}}": config.specPath ?? "No spec file provided",
		"{{BRANCH_NAME}}": config.branchName,
		"{{WORKTREE_PATH}}": config.worktreePath,
		"{{PARENT_AGENT}}": config.parentAgent ?? "coordinator",
		"{{DEPTH}}": String(config.depth),
		"{{FILE_SCOPE}}": formatFileScope(config.fileScope),
		"{{MULCH_DOMAINS}}": formatMulchDomains(config.mulchDomains),
		"{{MULCH_EXPERTISE}}": formatMulchExpertise(config.mulchExpertise),
		"{{CAN_SPAWN}}": formatCanSpawn(config),
		"{{QUALITY_GATES}}": formatQualityGates(config),
		"{{CONSTRAINTS}}": formatConstraints(config),
		"{{SPEC_INSTRUCTION}}": specInstruction,
		"{{SKIP_SCOUT}}": config.skipScout ? SKIP_SCOUT_SECTION : "",
		"{{DISPATCH_OVERRIDES}}": formatDispatchOverrides(config),
		"{{SIBLINGS}}": formatSiblings(config),
		"{{BASE_DEFINITION}}": config.baseDefinition,
		"{{PROFILE_INSTRUCTIONS}}": formatProfile(config.profileContent),
		"{{QUALITY_GATE_INLINE}}": formatQualityGatesInline(config.qualityGates),
		"{{QUALITY_GATE_STEPS}}": formatQualityGatesSteps(config.qualityGates),
		"{{QUALITY_GATE_BASH}}": formatQualityGatesBash(config.qualityGates),
		"{{QUALITY_GATE_CAPABILITIES}}": formatQualityGatesCapabilities(config.qualityGates),
		"{{TRACKER_CLI}}": config.trackerCli ?? "sd",
		"{{TRACKER_NAME}}": config.trackerName ?? "seeds",
		"{{INSTRUCTION_PATH}}": config.instructionPath ?? ".claude/CLAUDE.md",
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
	instructionPath = ".claude/CLAUDE.md",
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
	const outputPath = join(worktreePath, instructionPath);
	const outputDir = dirname(outputPath);

	try {
		await mkdir(outputDir, { recursive: true });
	} catch (err) {
		throw new AgentError(`Failed to create directory for instruction file at: ${outputDir}`, {
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

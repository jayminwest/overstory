/**
 * Session insight analyzer.
 *
 * Analyzes EventStore data from a completed session to extract structured
 * patterns about tool usage, file edits, and errors. Produces SessionInsight
 * objects suitable for recording to mulch.
 */

import type {
	FileProfile,
	InsightAnalysis,
	SessionInsight,
	StoredEvent,
	ToolProfile,
	ToolStats,
} from "../types.ts";

/**
 * Infer mulch domain from a file path.
 *
 * Maps file paths to domain names based on directory structure.
 * Returns null if no clear mapping exists.
 */
export function inferDomain(filePath: string): string | null {
	if (filePath.includes("src/mail/")) {
		return "messaging";
	}
	if (filePath.includes("src/commands/")) {
		return "cli";
	}
	if (filePath.includes("src/agents/") || filePath.includes("agents/")) {
		return "agents";
	}
	if (
		filePath.includes("src/events/") ||
		filePath.includes("src/logging/") ||
		filePath.includes("src/metrics/")
	) {
		return "cli";
	}
	if (filePath.includes("src/merge/") || filePath.includes("src/worktree/")) {
		return "architecture";
	}
	if (filePath.endsWith(".test.ts")) {
		return "typescript";
	}
	if (filePath.includes("src/")) {
		return "typescript";
	}
	return null;
}

/**
 * Analyze session data to extract structured insights.
 *
 * Processes EventStore events and tool stats to identify patterns in:
 * - Tool usage (workflow approach)
 * - File edit frequency (complexity signals)
 * - Error patterns
 *
 * Returns an InsightAnalysis with insights, toolProfile, and fileProfile.
 */
export function analyzeSessionInsights(params: {
	events: StoredEvent[];
	toolStats: ToolStats[];
	agentName: string;
	capability: string;
	domains: string[];
}): InsightAnalysis {
	const insights: SessionInsight[] = [];
	const fallbackDomain = params.domains[0] ?? "agents";

	// Build tool profile
	const topTools = params.toolStats
		.sort((a, b) => b.count - a.count)
		.slice(0, 5)
		.map((stat) => ({
			name: stat.toolName,
			count: stat.count,
			avgMs: Math.round(stat.avgDurationMs),
		}));

	const totalToolCalls = params.toolStats.reduce((sum, stat) => sum + stat.count, 0);
	const errorCount = params.events.filter((e) => e.level === "error").length;

	const toolProfile: ToolProfile = {
		topTools,
		totalToolCalls,
		errorCount,
	};

	// Build file profile
	const fileEditCounts = new Map<string, number>();
	for (const event of params.events) {
		if (
			event.eventType === "tool_start" &&
			(event.toolName === "Edit" || event.toolName === "Write") &&
			event.toolArgs !== null
		) {
			try {
				const args = JSON.parse(event.toolArgs) as { file_path?: string };
				if (args.file_path !== undefined) {
					const currentCount = fileEditCounts.get(args.file_path) ?? 0;
					fileEditCounts.set(args.file_path, currentCount + 1);
				}
			} catch {
				// Skip malformed tool args
			}
		}
	}

	const hotFiles = Array.from(fileEditCounts.entries())
		.filter(([_, count]) => count >= 3)
		.map(([path, count]) => ({ path, editCount: count }))
		.sort((a, b) => b.editCount - a.editCount)
		.slice(0, 3); // Limit to top 3 hot files

	const totalEdits = Array.from(fileEditCounts.values()).reduce((sum, count) => sum + count, 0);

	const fileProfile: FileProfile = {
		hotFiles,
		totalEdits,
	};

	// Generate insights

	// 1. Tool workflow pattern (if totalToolCalls >= 10)
	if (totalToolCalls >= 10) {
		const readTools = ["Read", "Grep", "Glob"];
		const writeTools = ["Edit", "Write"];
		const bashTools = ["Bash"];

		const readCount = params.toolStats
			.filter((s) => readTools.includes(s.toolName))
			.reduce((sum, s) => sum + s.count, 0);
		const writeCount = params.toolStats
			.filter((s) => writeTools.includes(s.toolName))
			.reduce((sum, s) => sum + s.count, 0);
		const bashCount = params.toolStats
			.filter((s) => bashTools.includes(s.toolName))
			.reduce((sum, s) => sum + s.count, 0);

		const readPct = readCount / totalToolCalls;
		const writePct = writeCount / totalToolCalls;
		const bashPct = bashCount / totalToolCalls;

		let workflowType: string;
		if (readPct > 0.5) {
			workflowType = "read-heavy";
		} else if (writePct > 0.5) {
			workflowType = "write-heavy";
		} else if (bashPct > 0.5) {
			workflowType = "bash-heavy";
		} else {
			workflowType = "balanced";
		}

		const topToolsDesc = topTools
			.slice(0, 3)
			.map((t) => `${t.name} (${t.count})`)
			.join(", ");

		insights.push({
			type: "pattern",
			domain: fallbackDomain,
			description: `Session tool profile: ${topToolsDesc} — ${workflowType} workflow`,
			tags: ["auto-insight", "tool-profile", params.capability],
		});
	}

	// 2. Hot files pattern (for files with 3+ edits)
	for (const hotFile of hotFiles) {
		const domain = inferDomain(hotFile.path) ?? fallbackDomain;
		insights.push({
			type: "pattern",
			domain,
			description: `File ${hotFile.path} required ${hotFile.editCount} edits during session — high iteration suggests complexity`,
			tags: ["auto-insight", "hot-file", params.capability],
		});
	}

	// 3. Error pattern (if errorCount > 0)
	if (errorCount > 0) {
		const errorEvents = params.events.filter((e) => e.level === "error");
		const errorTools = Array.from(
			new Set(errorEvents.map((e) => e.toolName).filter((name): name is string => name !== null)),
		);
		const errorToolsList = errorTools.length > 0 ? errorTools.join(", ") : "unknown";

		insights.push({
			type: "failure",
			domain: fallbackDomain,
			description: `Session encountered ${errorCount} error(s). Error tools: ${errorToolsList}`,
			tags: ["auto-insight", "error-pattern", params.capability],
		});
	}

	return {
		insights,
		toolProfile,
		fileProfile,
	};
}

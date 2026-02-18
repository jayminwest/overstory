/**
 * CLI command: overstory dashboard [--interval <ms>] [--all]
 *
 * Rich terminal dashboard using raw ANSI escape codes (zero runtime deps).
 * Polls existing data sources and renders multi-panel layout with agent status,
 * mail activity, merge queue, and metrics.
 *
 * By default, all panels are scoped to the current run (current-run.txt).
 * Use --all to show data across all runs.
 */

import { join } from "node:path";
import { loadConfig } from "../config.ts";
import { ValidationError } from "../errors.ts";
import { color } from "../logging/color.ts";
import { createMailStore } from "../mail/store.ts";
import { createMergeQueue } from "../merge/queue.ts";
import { createMetricsStore } from "../metrics/store.ts";
import type { MailMessage } from "../types.ts";
import { gatherStatus, type StatusData } from "./status.ts";

/**
 * Terminal control codes (cursor movement, screen clearing).
 * These are not colors, so they stay separate from the color module.
 */
const CURSOR = {
	clear: "\x1b[2J\x1b[H", // Clear screen and home cursor
	cursorTo: (row: number, col: number) => `\x1b[${row};${col}H`,
	hideCursor: "\x1b[?25l",
	showCursor: "\x1b[?25h",
} as const;

/**
 * Box drawing characters for panel borders.
 */
const BOX = {
	topLeft: "┌",
	topRight: "┐",
	bottomLeft: "└",
	bottomRight: "┘",
	horizontal: "─",
	vertical: "│",
	tee: "├",
	teeRight: "┤",
	cross: "┼",
};

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
 * Format a duration in ms to a human-readable string.
 */
function formatDuration(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remainSec = seconds % 60;
	if (minutes < 60) return `${minutes}m ${remainSec}s`;
	const hours = Math.floor(minutes / 60);
	const remainMin = minutes % 60;
	return `${hours}h ${remainMin}m`;
}

/**
 * Format a timestamp to "time ago" format.
 */
function timeAgo(timestamp: string): string {
	const now = Date.now();
	const then = new Date(timestamp).getTime();
	const diffMs = now - then;
	const diffSec = Math.floor(diffMs / 1000);

	if (diffSec < 60) return `${diffSec}s ago`;
	const diffMin = Math.floor(diffSec / 60);
	if (diffMin < 60) return `${diffMin}m ago`;
	const diffHr = Math.floor(diffMin / 60);
	if (diffHr < 24) return `${diffHr}h ago`;
	const diffDay = Math.floor(diffHr / 24);
	return `${diffDay}d ago`;
}

/**
 * Truncate a string to fit within maxLen characters, adding ellipsis if needed.
 */
function truncate(str: string, maxLen: number): string {
	if (str.length <= maxLen) return str;
	return `${str.slice(0, maxLen - 1)}…`;
}

/**
 * Pad or truncate a string to exactly the given width.
 */
function pad(str: string, width: number): string {
	if (str.length >= width) return str.slice(0, width);
	return str + " ".repeat(width - str.length);
}

/**
 * Draw a horizontal line with left/right/middle connectors.
 */
function horizontalLine(width: number, left: string, _middle: string, right: string): string {
	return left + BOX.horizontal.repeat(width - 2) + right;
}

interface DashboardData {
	currentRunId?: string | null;
	status: StatusData;
	recentMail: MailMessage[];
	mergeQueue: Array<{ branchName: string; agentName: string; status: string }>;
	metrics: {
		totalSessions: number;
		avgDuration: number;
		byCapability: Record<string, number>;
	};
}

/**
 * Read the current run ID from current-run.txt, or null if no active run.
 */
async function readCurrentRunId(overstoryDir: string): Promise<string | null> {
	const path = join(overstoryDir, "current-run.txt");
	const file = Bun.file(path);
	if (!(await file.exists())) {
		return null;
	}
	const text = await file.text();
	const trimmed = text.trim();
	return trimmed.length > 0 ? trimmed : null;
}

/**
 * Load all data sources for the dashboard.
 * When runId is provided, all panels are scoped to agents in that run.
 */
async function loadDashboardData(root: string, runId?: string | null): Promise<DashboardData> {
	const rawStatus = await gatherStatus(root, "orchestrator", false);

	// If run-scoped, filter agents to only those belonging to the current run
	const filteredAgents = runId
		? rawStatus.agents.filter((a) => a.runId === runId)
		: rawStatus.agents;

	const status: StatusData = { ...rawStatus, agents: filteredAgents };

	// Load recent mail
	let recentMail: MailMessage[] = [];
	try {
		const mailDbPath = join(root, ".overstory", "mail.db");
		const mailFile = Bun.file(mailDbPath);
		if (await mailFile.exists()) {
			const mailStore = createMailStore(mailDbPath);
			if (runId && filteredAgents.length > 0) {
				const agentNames = new Set(filteredAgents.map((a) => a.agentName));
				const allMail = mailStore.getAll();
				recentMail = allMail
					.filter((m) => agentNames.has(m.from) || agentNames.has(m.to))
					.slice(0, 5);
			} else {
				recentMail = mailStore.getAll().slice(0, 5);
			}
			mailStore.close();
		}
	} catch {
		// Mail db might not exist
	}

	// Load merge queue
	let mergeQueue: Array<{ branchName: string; agentName: string; status: string }> = [];
	try {
		const queuePath = join(root, ".overstory", "merge-queue.db");
		const queue = createMergeQueue(queuePath);
		let entries = queue.list();
		if (runId && filteredAgents.length > 0) {
			const agentNames = new Set(filteredAgents.map((a) => a.agentName));
			entries = entries.filter((e) => agentNames.has(e.agentName));
		}
		mergeQueue = entries.map((e) => ({
			branchName: e.branchName,
			agentName: e.agentName,
			status: e.status,
		}));
		queue.close();
	} catch {
		// Queue db might not exist
	}

	// Load metrics
	let totalSessions = 0;
	let avgDuration = 0;
	const byCapability: Record<string, number> = {};
	try {
		const metricsDbPath = join(root, ".overstory", "metrics.db");
		const metricsFile = Bun.file(metricsDbPath);
		if (await metricsFile.exists()) {
			const store = createMetricsStore(metricsDbPath);
			const sessions = store.getRecentSessions(100);

			const filtered =
				runId && filteredAgents.length > 0
					? (() => {
							const agentNames = new Set(filteredAgents.map((a) => a.agentName));
							return sessions.filter((s) => agentNames.has(s.agentName));
						})()
					: sessions;

			totalSessions = filtered.length;

			// When run-scoped, compute avg duration from filtered sessions manually
			if (runId && filteredAgents.length > 0) {
				const completedSessions = filtered.filter((s) => s.completedAt !== null);
				if (completedSessions.length > 0) {
					avgDuration =
						completedSessions.reduce((sum, s) => sum + s.durationMs, 0) / completedSessions.length;
				}
			} else {
				avgDuration = store.getAverageDuration();
			}

			for (const session of filtered) {
				const cap = session.capability;
				byCapability[cap] = (byCapability[cap] ?? 0) + 1;
			}

			store.close();
		}
	} catch {
		// Metrics db might not exist
	}

	return {
		currentRunId: runId,
		status,
		recentMail,
		mergeQueue,
		metrics: { totalSessions, avgDuration, byCapability },
	};
}

/**
 * Render the header bar (line 1).
 */
function renderHeader(width: number, interval: number, currentRunId?: string | null): string {
	const left = `${color.bold}overstory dashboard v0.2.0${color.reset}`;
	const now = new Date().toLocaleTimeString();
	const scope = currentRunId ? ` [run: ${currentRunId.slice(0, 8)}]` : " [all runs]";
	const right = `${now}${scope} | refresh: ${interval}ms`;
	const leftStripped = "overstory dashboard v0.2.0"; // for length calculation
	const padding = width - leftStripped.length - right.length;
	const line = left + " ".repeat(Math.max(0, padding)) + right;
	const separator = horizontalLine(width, BOX.topLeft, BOX.horizontal, BOX.topRight);
	return `${line}\n${separator}`;
}

/**
 * Get color for agent state.
 */
function getStateColor(state: string): string {
	switch (state) {
		case "working":
			return color.green;
		case "booting":
			return color.yellow;
		case "stalled":
			return color.red;
		case "zombie":
			return color.dim;
		case "completed":
			return color.cyan;
		default:
			return color.white;
	}
}

/**
 * Get status icon for agent state.
 */
function getStateIcon(state: string): string {
	switch (state) {
		case "working":
			return "●";
		case "booting":
			return "◐";
		case "stalled":
			return "⚠";
		case "zombie":
			return "○";
		case "completed":
			return "✓";
		default:
			return "?";
	}
}

/**
 * Render the agent panel (top ~40% of screen).
 */
function renderAgentPanel(
	data: DashboardData,
	width: number,
	height: number,
	startRow: number,
): string {
	const panelHeight = Math.floor(height * 0.4);
	let output = "";

	// Panel header
	const headerLine = `${BOX.vertical} ${color.bold}Agents${color.reset} (${data.status.agents.length})`;
	const headerPadding = " ".repeat(
		width - headerLine.length - 1 + color.bold.length + color.reset.length,
	);
	output += `${CURSOR.cursorTo(startRow, 1)}${headerLine}${headerPadding}${BOX.vertical}\n`;

	// Column headers
	const colHeaders = `${BOX.vertical} St Name            Capability    State      Bead ID          Duration  Tmux ${BOX.vertical}`;
	output += `${CURSOR.cursorTo(startRow + 1, 1)}${colHeaders}\n`;

	// Separator
	const separator = horizontalLine(width, BOX.tee, BOX.horizontal, BOX.teeRight);
	output += `${CURSOR.cursorTo(startRow + 2, 1)}${separator}\n`;

	// Sort agents: active first (working, booting, stalled), then completed, then zombie
	const agents = [...data.status.agents].sort((a, b) => {
		const activeStates = ["working", "booting", "stalled"];
		const aActive = activeStates.includes(a.state);
		const bActive = activeStates.includes(b.state);
		if (aActive && !bActive) return -1;
		if (!aActive && bActive) return 1;
		return 0;
	});

	const now = Date.now();
	const maxRows = panelHeight - 4; // header + col headers + separator + border
	const visibleAgents = agents.slice(0, maxRows);

	for (let i = 0; i < visibleAgents.length; i++) {
		const agent = visibleAgents[i];
		if (!agent) continue;

		const icon = getStateIcon(agent.state);
		const stateColor = getStateColor(agent.state);
		const name = pad(truncate(agent.agentName, 15), 15);
		const capability = pad(truncate(agent.capability, 12), 12);
		const state = pad(agent.state, 10);
		const beadId = pad(truncate(agent.beadId, 16), 16);
		const endTime =
			agent.state === "completed" || agent.state === "zombie"
				? new Date(agent.lastActivity).getTime()
				: now;
		const duration = formatDuration(endTime - new Date(agent.startedAt).getTime());
		const durationPadded = pad(duration, 9);
		const tmuxAlive = data.status.tmuxSessions.some((s) => s.name === agent.tmuxSession);
		const tmuxDot = tmuxAlive ? `${color.green}●${color.reset}` : `${color.red}○${color.reset}`;

		const line = `${BOX.vertical} ${stateColor}${icon}${color.reset}  ${name} ${capability} ${stateColor}${state}${color.reset} ${beadId} ${durationPadded} ${tmuxDot}    ${BOX.vertical}`;
		output += `${CURSOR.cursorTo(startRow + 3 + i, 1)}${line}\n`;
	}

	// Fill remaining rows with empty lines
	for (let i = visibleAgents.length; i < maxRows; i++) {
		const emptyLine = `${BOX.vertical}${" ".repeat(width - 2)}${BOX.vertical}`;
		output += `${CURSOR.cursorTo(startRow + 3 + i, 1)}${emptyLine}\n`;
	}

	// Bottom border
	const bottomBorder = horizontalLine(width, BOX.tee, BOX.horizontal, BOX.teeRight);
	output += `${CURSOR.cursorTo(startRow + 3 + maxRows, 1)}${bottomBorder}\n`;

	return output;
}

/**
 * Get color for mail priority.
 */
function getPriorityColor(priority: string): string {
	switch (priority) {
		case "urgent":
			return color.red;
		case "high":
			return color.yellow;
		case "normal":
			return color.white;
		case "low":
			return color.dim;
		default:
			return color.white;
	}
}

/**
 * Render the mail panel (middle-left ~30% height, ~60% width).
 */
function renderMailPanel(
	data: DashboardData,
	width: number,
	height: number,
	startRow: number,
): string {
	const panelHeight = Math.floor(height * 0.3);
	const panelWidth = Math.floor(width * 0.6);
	let output = "";

	const unreadCount = data.status.unreadMailCount;
	const headerLine = `${BOX.vertical} ${color.bold}Mail${color.reset} (${unreadCount} unread)`;
	const headerPadding = " ".repeat(
		panelWidth - headerLine.length - 1 + color.bold.length + color.reset.length,
	);
	output += `${CURSOR.cursorTo(startRow, 1)}${headerLine}${headerPadding}${BOX.vertical}\n`;

	const separator = horizontalLine(panelWidth, BOX.tee, BOX.horizontal, BOX.cross);
	output += `${CURSOR.cursorTo(startRow + 1, 1)}${separator}\n`;

	const maxRows = panelHeight - 3; // header + separator + border
	const messages = data.recentMail.slice(0, maxRows);

	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		if (!msg) continue;

		const priorityColor = getPriorityColor(msg.priority);
		const priority = msg.priority === "normal" ? "" : `[${msg.priority}] `;
		const from = truncate(msg.from, 12);
		const to = truncate(msg.to, 12);
		const subject = truncate(msg.subject, panelWidth - 40);
		const time = timeAgo(msg.createdAt);

		const line = `${BOX.vertical} ${priorityColor}${priority}${color.reset}${from} → ${to}: ${subject} (${time})`;
		const padding = " ".repeat(
			Math.max(
				0,
				panelWidth -
					line.length -
					1 +
					priorityColor.length +
					color.reset.length +
					priorityColor.length +
					color.reset.length,
			),
		);
		output += `${CURSOR.cursorTo(startRow + 2 + i, 1)}${line}${padding}${BOX.vertical}\n`;
	}

	// Fill remaining rows with empty lines
	for (let i = messages.length; i < maxRows; i++) {
		const emptyLine = `${BOX.vertical}${" ".repeat(panelWidth - 2)}${BOX.vertical}`;
		output += `${CURSOR.cursorTo(startRow + 2 + i, 1)}${emptyLine}\n`;
	}

	return output;
}

/**
 * Get color for merge queue status.
 */
function getMergeStatusColor(status: string): string {
	switch (status) {
		case "pending":
			return color.yellow;
		case "merging":
			return color.blue;
		case "conflict":
			return color.red;
		case "merged":
			return color.green;
		default:
			return color.white;
	}
}

/**
 * Render the merge queue panel (middle-right ~30% height, ~40% width).
 */
function renderMergeQueuePanel(
	data: DashboardData,
	width: number,
	height: number,
	startRow: number,
	startCol: number,
): string {
	const panelHeight = Math.floor(height * 0.3);
	const panelWidth = width - startCol + 1;
	let output = "";

	const headerLine = `${BOX.vertical} ${color.bold}Merge Queue${color.reset} (${data.mergeQueue.length})`;
	const headerPadding = " ".repeat(
		panelWidth - headerLine.length - 1 + color.bold.length + color.reset.length,
	);
	output += `${CURSOR.cursorTo(startRow, startCol)}${headerLine}${headerPadding}${BOX.vertical}\n`;

	const separator = horizontalLine(panelWidth, BOX.cross, BOX.horizontal, BOX.teeRight);
	output += `${CURSOR.cursorTo(startRow + 1, startCol)}${separator}\n`;

	const maxRows = panelHeight - 3; // header + separator + border
	const entries = data.mergeQueue.slice(0, maxRows);

	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		if (!entry) continue;

		const statusColor = getMergeStatusColor(entry.status);
		const status = pad(entry.status, 10);
		const agent = truncate(entry.agentName, 15);
		const branch = truncate(entry.branchName, panelWidth - 30);

		const line = `${BOX.vertical} ${statusColor}${status}${color.reset} ${agent} ${branch}`;
		const padding = " ".repeat(
			Math.max(0, panelWidth - line.length - 1 + statusColor.length + color.reset.length),
		);
		output += `${CURSOR.cursorTo(startRow + 2 + i, startCol)}${line}${padding}${BOX.vertical}\n`;
	}

	// Fill remaining rows with empty lines
	for (let i = entries.length; i < maxRows; i++) {
		const emptyLine = `${BOX.vertical}${" ".repeat(panelWidth - 2)}${BOX.vertical}`;
		output += `${CURSOR.cursorTo(startRow + 2 + i, startCol)}${emptyLine}\n`;
	}

	return output;
}

/**
 * Render the metrics panel (bottom strip).
 */
function renderMetricsPanel(
	data: DashboardData,
	width: number,
	_height: number,
	startRow: number,
): string {
	let output = "";

	const separator = horizontalLine(width, BOX.tee, BOX.horizontal, BOX.teeRight);
	output += `${CURSOR.cursorTo(startRow, 1)}${separator}\n`;

	const headerLine = `${BOX.vertical} ${color.bold}Metrics${color.reset}`;
	const headerPadding = " ".repeat(
		width - headerLine.length - 1 + color.bold.length + color.reset.length,
	);
	output += `${CURSOR.cursorTo(startRow + 1, 1)}${headerLine}${headerPadding}${BOX.vertical}\n`;

	const totalSessions = data.metrics.totalSessions;
	const avgDuration = formatDuration(data.metrics.avgDuration);
	const byCapability = Object.entries(data.metrics.byCapability)
		.map(([cap, count]) => `${cap}:${count}`)
		.join(", ");

	const metricsLine = `${BOX.vertical} Total sessions: ${totalSessions} | Avg duration: ${avgDuration} | By capability: ${byCapability}`;
	const metricsPadding = " ".repeat(Math.max(0, width - metricsLine.length - 1));
	output += `${CURSOR.cursorTo(startRow + 2, 1)}${metricsLine}${metricsPadding}${BOX.vertical}\n`;

	const bottomBorder = horizontalLine(width, BOX.bottomLeft, BOX.horizontal, BOX.bottomRight);
	output += `${CURSOR.cursorTo(startRow + 3, 1)}${bottomBorder}\n`;

	return output;
}

/**
 * Render the full dashboard.
 */
function renderDashboard(data: DashboardData, interval: number): void {
	const width = process.stdout.columns ?? 100;
	const height = process.stdout.rows ?? 30;

	let output = CURSOR.clear;

	// Header (rows 1-2)
	output += renderHeader(width, interval, data.currentRunId);

	// Agent panel (rows 3 to ~40% of screen)
	const agentPanelStart = 3;
	output += renderAgentPanel(data, width, height, agentPanelStart);

	// Calculate middle panels start row
	const agentPanelHeight = Math.floor(height * 0.4);
	const middlePanelStart = agentPanelStart + agentPanelHeight + 1;

	// Mail panel (left 60%)
	output += renderMailPanel(data, width, height, middlePanelStart);

	// Merge queue panel (right 40%)
	const mergeQueueCol = Math.floor(width * 0.6) + 1;
	output += renderMergeQueuePanel(data, width, height, middlePanelStart, mergeQueueCol);

	// Metrics panel (bottom strip)
	const middlePanelHeight = Math.floor(height * 0.3);
	const metricsStart = middlePanelStart + middlePanelHeight + 1;
	output += renderMetricsPanel(data, width, height, metricsStart);

	process.stdout.write(output);
}

/**
 * Entry point for `overstory dashboard [--interval <ms>] [--all]`.
 */
const DASHBOARD_HELP = `overstory dashboard — Live TUI dashboard for agent monitoring

Usage: overstory dashboard [--interval <ms>] [--all]

Options:
  --interval <ms>    Poll interval in milliseconds (default: 2000, min: 500)
  --all              Show data from all runs (default: current run only)
  --help, -h         Show this help

Dashboard panels:
  - Agent panel: Active agents with status, capability, bead ID, duration
  - Mail panel: Recent messages with priority and time
  - Merge queue: Pending/merging/conflict entries
  - Metrics: Session counts, avg duration, by-capability breakdown

By default the dashboard scopes all panels to the current run (current-run.txt).
Use --all to see data across all runs.

Press Ctrl+C to exit.`;

export async function dashboardCommand(args: string[]): Promise<void> {
	if (args.includes("--help") || args.includes("-h")) {
		process.stdout.write(`${DASHBOARD_HELP}\n`);
		return;
	}

	const intervalStr = getFlag(args, "--interval");
	const interval = intervalStr ? Number.parseInt(intervalStr, 10) : 2000;
	const showAll = args.includes("--all");

	if (Number.isNaN(interval) || interval < 500) {
		throw new ValidationError("--interval must be a number >= 500 (milliseconds)", {
			field: "interval",
			value: intervalStr,
		});
	}

	const cwd = process.cwd();
	const config = await loadConfig(cwd);
	const root = config.project.root;

	// Read current run ID unless --all flag is set
	let runId: string | null | undefined;
	if (!showAll) {
		const overstoryDir = join(root, ".overstory");
		runId = await readCurrentRunId(overstoryDir);
	}

	// Hide cursor
	process.stdout.write(CURSOR.hideCursor);

	// Clean exit on Ctrl+C
	let running = true;
	process.on("SIGINT", () => {
		running = false;
		process.stdout.write(CURSOR.showCursor);
		process.stdout.write(CURSOR.clear);
		process.exit(0);
	});

	// Poll loop
	while (running) {
		const data = await loadDashboardData(root, runId);
		renderDashboard(data, interval);
		await Bun.sleep(interval);
	}
}

/**
 * CLI command: overstory dashboard [--interval <ms>]
 *
 * Rich terminal dashboard using raw ANSI escape codes (zero runtime deps).
 * Polls existing data sources and renders multi-panel layout with agent status,
 * mail activity, merge queue, and metrics.
 */

import { join } from "node:path";
import { loadConfig } from "../config.ts";
import { ValidationError } from "../errors.ts";
import { createMailStore } from "../mail/store.ts";
import { createMetricsStore } from "../metrics/store.ts";
import type { MailMessage } from "../types.ts";
import { gatherStatus, type StatusData } from "./status.ts";

/**
 * ANSI escape codes for rendering.
 */
const ANSI = {
	// Cursor control
	clear: "\x1b[2J\x1b[H", // Clear screen and home cursor
	cursorTo: (row: number, col: number) => `\x1b[${row};${col}H`,
	hideCursor: "\x1b[?25l",
	showCursor: "\x1b[?25h",

	// Text styling
	reset: "\x1b[0m",
	bold: "\x1b[1m",
	dim: "\x1b[2m",

	// Foreground colors
	red: "\x1b[31m",
	green: "\x1b[32m",
	yellow: "\x1b[33m",
	blue: "\x1b[34m",
	magenta: "\x1b[35m",
	cyan: "\x1b[36m",
	white: "\x1b[37m",
};

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
 * Load all data sources for the dashboard.
 */
async function loadDashboardData(root: string): Promise<DashboardData> {
	const status = await gatherStatus(root, "orchestrator", false);

	// Load recent mail
	let recentMail: MailMessage[] = [];
	try {
		const mailDbPath = join(root, ".overstory", "mail.db");
		const mailFile = Bun.file(mailDbPath);
		if (await mailFile.exists()) {
			const mailStore = createMailStore(mailDbPath);
			recentMail = mailStore.getAll().slice(0, 5);
			mailStore.close();
		}
	} catch {
		// Mail db might not exist
	}

	// Load merge queue
	let mergeQueue: Array<{ branchName: string; agentName: string; status: string }> = [];
	try {
		const queuePath = join(root, ".overstory", "merge-queue.json");
		const queueFile = Bun.file(queuePath);
		if (await queueFile.exists()) {
			const text = await queueFile.text();
			const entries = JSON.parse(text) as Array<{
				branchName: string;
				agentName: string;
				status: string;
			}>;
			mergeQueue = entries;
		}
	} catch {
		// Queue might not exist
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
			totalSessions = sessions.length;
			avgDuration = store.getAverageDuration();

			// Count by capability
			for (const session of sessions) {
				const cap = session.capability;
				byCapability[cap] = (byCapability[cap] ?? 0) + 1;
			}

			store.close();
		}
	} catch {
		// Metrics db might not exist
	}

	return {
		status,
		recentMail,
		mergeQueue,
		metrics: { totalSessions, avgDuration, byCapability },
	};
}

/**
 * Render the header bar (line 1).
 */
function renderHeader(width: number, interval: number): string {
	const left = `${ANSI.bold}overstory dashboard v0.2.0${ANSI.reset}`;
	const now = new Date().toLocaleTimeString();
	const right = `${now} | refresh: ${interval}ms`;
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
			return ANSI.green;
		case "booting":
			return ANSI.yellow;
		case "stalled":
			return ANSI.red;
		case "zombie":
			return ANSI.dim;
		case "completed":
			return ANSI.cyan;
		default:
			return ANSI.white;
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
	const headerLine = `${BOX.vertical} ${ANSI.bold}Agents${ANSI.reset} (${data.status.agents.length})`;
	const headerPadding = " ".repeat(
		width - headerLine.length - 1 + ANSI.bold.length + ANSI.reset.length,
	);
	output += `${ANSI.cursorTo(startRow, 1)}${headerLine}${headerPadding}${BOX.vertical}\n`;

	// Column headers
	const colHeaders = `${BOX.vertical} St Name            Capability    State      Bead ID          Duration  Tmux ${BOX.vertical}`;
	output += `${ANSI.cursorTo(startRow + 1, 1)}${colHeaders}\n`;

	// Separator
	const separator = horizontalLine(width, BOX.tee, BOX.horizontal, BOX.teeRight);
	output += `${ANSI.cursorTo(startRow + 2, 1)}${separator}\n`;

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
		const color = getStateColor(agent.state);
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
		const tmuxDot = tmuxAlive ? `${ANSI.green}●${ANSI.reset}` : `${ANSI.red}○${ANSI.reset}`;

		const line = `${BOX.vertical} ${color}${icon}${ANSI.reset}  ${name} ${capability} ${color}${state}${ANSI.reset} ${beadId} ${durationPadded} ${tmuxDot}    ${BOX.vertical}`;
		output += `${ANSI.cursorTo(startRow + 3 + i, 1)}${line}\n`;
	}

	// Fill remaining rows with empty lines
	for (let i = visibleAgents.length; i < maxRows; i++) {
		const emptyLine = `${BOX.vertical}${" ".repeat(width - 2)}${BOX.vertical}`;
		output += `${ANSI.cursorTo(startRow + 3 + i, 1)}${emptyLine}\n`;
	}

	// Bottom border
	const bottomBorder = horizontalLine(width, BOX.tee, BOX.horizontal, BOX.teeRight);
	output += `${ANSI.cursorTo(startRow + 3 + maxRows, 1)}${bottomBorder}\n`;

	return output;
}

/**
 * Get color for mail priority.
 */
function getPriorityColor(priority: string): string {
	switch (priority) {
		case "urgent":
			return ANSI.red;
		case "high":
			return ANSI.yellow;
		case "normal":
			return ANSI.white;
		case "low":
			return ANSI.dim;
		default:
			return ANSI.white;
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
	const headerLine = `${BOX.vertical} ${ANSI.bold}Mail${ANSI.reset} (${unreadCount} unread)`;
	const headerPadding = " ".repeat(
		panelWidth - headerLine.length - 1 + ANSI.bold.length + ANSI.reset.length,
	);
	output += `${ANSI.cursorTo(startRow, 1)}${headerLine}${headerPadding}${BOX.vertical}\n`;

	const separator = horizontalLine(panelWidth, BOX.tee, BOX.horizontal, BOX.cross);
	output += `${ANSI.cursorTo(startRow + 1, 1)}${separator}\n`;

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

		const line = `${BOX.vertical} ${priorityColor}${priority}${ANSI.reset}${from} → ${to}: ${subject} (${time})`;
		const padding = " ".repeat(
			Math.max(
				0,
				panelWidth -
					line.length -
					1 +
					priorityColor.length +
					ANSI.reset.length +
					priorityColor.length +
					ANSI.reset.length,
			),
		);
		output += `${ANSI.cursorTo(startRow + 2 + i, 1)}${line}${padding}${BOX.vertical}\n`;
	}

	// Fill remaining rows with empty lines
	for (let i = messages.length; i < maxRows; i++) {
		const emptyLine = `${BOX.vertical}${" ".repeat(panelWidth - 2)}${BOX.vertical}`;
		output += `${ANSI.cursorTo(startRow + 2 + i, 1)}${emptyLine}\n`;
	}

	return output;
}

/**
 * Get color for merge queue status.
 */
function getMergeStatusColor(status: string): string {
	switch (status) {
		case "pending":
			return ANSI.yellow;
		case "merging":
			return ANSI.blue;
		case "conflict":
			return ANSI.red;
		case "merged":
			return ANSI.green;
		default:
			return ANSI.white;
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

	const headerLine = `${BOX.vertical} ${ANSI.bold}Merge Queue${ANSI.reset} (${data.mergeQueue.length})`;
	const headerPadding = " ".repeat(
		panelWidth - headerLine.length - 1 + ANSI.bold.length + ANSI.reset.length,
	);
	output += `${ANSI.cursorTo(startRow, startCol)}${headerLine}${headerPadding}${BOX.vertical}\n`;

	const separator = horizontalLine(panelWidth, BOX.cross, BOX.horizontal, BOX.teeRight);
	output += `${ANSI.cursorTo(startRow + 1, startCol)}${separator}\n`;

	const maxRows = panelHeight - 3; // header + separator + border
	const entries = data.mergeQueue.slice(0, maxRows);

	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		if (!entry) continue;

		const statusColor = getMergeStatusColor(entry.status);
		const status = pad(entry.status, 10);
		const agent = truncate(entry.agentName, 15);
		const branch = truncate(entry.branchName, panelWidth - 30);

		const line = `${BOX.vertical} ${statusColor}${status}${ANSI.reset} ${agent} ${branch}`;
		const padding = " ".repeat(
			Math.max(0, panelWidth - line.length - 1 + statusColor.length + ANSI.reset.length),
		);
		output += `${ANSI.cursorTo(startRow + 2 + i, startCol)}${line}${padding}${BOX.vertical}\n`;
	}

	// Fill remaining rows with empty lines
	for (let i = entries.length; i < maxRows; i++) {
		const emptyLine = `${BOX.vertical}${" ".repeat(panelWidth - 2)}${BOX.vertical}`;
		output += `${ANSI.cursorTo(startRow + 2 + i, startCol)}${emptyLine}\n`;
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
	output += `${ANSI.cursorTo(startRow, 1)}${separator}\n`;

	const headerLine = `${BOX.vertical} ${ANSI.bold}Metrics${ANSI.reset}`;
	const headerPadding = " ".repeat(
		width - headerLine.length - 1 + ANSI.bold.length + ANSI.reset.length,
	);
	output += `${ANSI.cursorTo(startRow + 1, 1)}${headerLine}${headerPadding}${BOX.vertical}\n`;

	const totalSessions = data.metrics.totalSessions;
	const avgDuration = formatDuration(data.metrics.avgDuration);
	const byCapability = Object.entries(data.metrics.byCapability)
		.map(([cap, count]) => `${cap}:${count}`)
		.join(", ");

	const metricsLine = `${BOX.vertical} Total sessions: ${totalSessions} | Avg duration: ${avgDuration} | By capability: ${byCapability}`;
	const metricsPadding = " ".repeat(Math.max(0, width - metricsLine.length - 1));
	output += `${ANSI.cursorTo(startRow + 2, 1)}${metricsLine}${metricsPadding}${BOX.vertical}\n`;

	const bottomBorder = horizontalLine(width, BOX.bottomLeft, BOX.horizontal, BOX.bottomRight);
	output += `${ANSI.cursorTo(startRow + 3, 1)}${bottomBorder}\n`;

	return output;
}

/**
 * Render the full dashboard.
 */
function renderDashboard(data: DashboardData, interval: number): void {
	const width = process.stdout.columns ?? 100;
	const height = process.stdout.rows ?? 30;

	let output = ANSI.clear;

	// Header (rows 1-2)
	output += renderHeader(width, interval);

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
 * Entry point for `overstory dashboard [--interval <ms>]`.
 */
const DASHBOARD_HELP = `overstory dashboard — Live TUI dashboard for agent monitoring

Usage: overstory dashboard [--interval <ms>]

Options:
  --interval <ms>    Poll interval in milliseconds (default: 2000, min: 500)
  --help, -h         Show this help

Dashboard panels:
  - Agent panel: Active agents with status, capability, bead ID, duration
  - Mail panel: Recent messages with priority and time
  - Merge queue: Pending/merging/conflict entries
  - Metrics: Session counts, avg duration, by-capability breakdown

Press Ctrl+C to exit.`;

export async function dashboardCommand(args: string[]): Promise<void> {
	if (args.includes("--help") || args.includes("-h")) {
		process.stdout.write(`${DASHBOARD_HELP}\n`);
		return;
	}

	const intervalStr = getFlag(args, "--interval");
	const interval = intervalStr ? Number.parseInt(intervalStr, 10) : 2000;

	if (Number.isNaN(interval) || interval < 500) {
		throw new ValidationError("--interval must be a number >= 500 (milliseconds)", {
			field: "interval",
			value: intervalStr,
		});
	}

	const cwd = process.cwd();
	const config = await loadConfig(cwd);
	const root = config.project.root;

	// Hide cursor
	process.stdout.write(ANSI.hideCursor);

	// Clean exit on Ctrl+C
	let running = true;
	process.on("SIGINT", () => {
		running = false;
		process.stdout.write(ANSI.showCursor);
		process.stdout.write(ANSI.clear);
		process.exit(0);
	});

	// Poll loop
	while (running) {
		const data = await loadDashboardData(root);
		renderDashboard(data, interval);
		await Bun.sleep(interval);
	}
}

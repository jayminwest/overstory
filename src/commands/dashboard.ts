/**
 * CLI command: ov dashboard [--interval <ms>] [--all]
 *
 * Rich terminal dashboard using raw ANSI escape codes (zero runtime deps).
 * Polls existing data sources and renders multi-panel layout with agent status,
 * mail activity, merge queue, metrics, tasks, and recent event feed.
 *
 * Layout:
 *   Row 1-2:   Header
 *   Row 3-N:   Agents (60% width, dynamic height) | Tasks (upper-right 40%) + Feed (lower-right 40%)
 *   Row N+1:   Mail (50%) | Merge Queue (50%)
 *   Row M:     Metrics
 *
 * By default, all panels are scoped to the current run (current-run.txt).
 * Use --all to show data across all runs.
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { Command } from "commander";
import { loadConfig } from "../config.ts";
import { ValidationError } from "../errors.ts";
import { createEventStore } from "../events/store.ts";
import { accent, brand, color, visibleLength } from "../logging/color.ts";
import {
	buildAgentColorMap,
	extendAgentColorMap,
	formatDuration,
	formatEventLine,
	formatRelativeTime,
	mergeStatusColor,
	numericPriorityColor,
	priorityColor,
} from "../logging/format.ts";
import { stateColor, stateIcon } from "../logging/theme.ts";
import { createMailStore, type MailStore } from "../mail/store.ts";
import { createMergeQueue, type MergeQueue } from "../merge/queue.ts";
import { createMetricsStore, type MetricsStore } from "../metrics/store.ts";
import { openSessionStore } from "../sessions/compat.ts";
import type { SessionStore } from "../sessions/store.ts";
import { createTrackerClient, resolveBackend } from "../tracker/factory.ts";
import type { TrackerIssue } from "../tracker/types.ts";
import type { EventStore, MailMessage, StoredEvent } from "../types.ts";
import { evaluateHealth } from "../watchdog/health.ts";
import { isProcessAlive } from "../worktree/process-utils.ts";
import { getCachedTmuxSessions, getCachedWorktrees, type StatusData } from "./status.ts";

const pkgPath = resolve(import.meta.dir, "../../package.json");
const PKG_VERSION: string = JSON.parse(await Bun.file(pkgPath).text()).version ?? "unknown";

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
 * Box drawing characters for panel borders (plain — not used for rendering,
 * kept for backward compat with tests and horizontalLine helper).
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
 * Dimmed version of BOX characters — for subdued borders that do not
 * compete visually with panel content.
 */
export const dimBox = {
	topLeft: color.dim("┌"),
	topRight: color.dim("┐"),
	bottomLeft: color.dim("└"),
	bottomRight: color.dim("┘"),
	horizontal: color.dim("─"),
	vertical: color.dim("│"),
	tee: color.dim("├"),
	teeRight: color.dim("┤"),
	cross: color.dim("┼"),
} as const;

/**
 * Truncate a string to fit within maxLen characters, adding ellipsis if needed.
 */
function truncate(str: string, maxLen: number): string {
	if (maxLen <= 0) return "";
	if (str.length <= maxLen) return str;
	return `${str.slice(0, maxLen - 1)}…`;
}

/**
 * Pad or truncate a string to exactly the given width.
 */
function pad(str: string, width: number): string {
	if (width <= 0) return "";
	if (str.length >= width) return str.slice(0, width);
	return str + " ".repeat(width - str.length);
}

/**
 * Draw a horizontal line with left/right connectors using plain BOX chars.
 * Exported for backward compat in tests.
 */
function horizontalLine(width: number, left: string, _middle: string, right: string): string {
	return left + BOX.horizontal.repeat(Math.max(0, width - 2)) + right;
}

/**
 * Draw a horizontal line using dimmed border characters.
 * ANSI-aware: uses visibleLength() for padding calculations.
 */
function dimHorizontalLine(width: number, left: string, right: string): string {
	const fillCount = Math.max(0, width - visibleLength(left) - visibleLength(right));
	return left + dimBox.horizontal.repeat(fillCount) + right;
}

export { pad, truncate, horizontalLine };

/**
 * Compute agent panel height from screen height and agent count.
 * min 8 rows, max floor(height * 0.35), grows with agent count (+4 for chrome).
 */
export function computeAgentPanelHeight(height: number, agentCount: number): number {
	return Math.max(8, Math.min(Math.floor(height * 0.35), agentCount + 4));
}

/**
 * Filter agents by run ID. When run-scoped, also includes sessions with null
 * runId (e.g. coordinator) because SQL WHERE run_id = ? never matches NULL.
 */
export function filterAgentsByRun<T extends { runId: string | null }>(
	agents: T[],
	runId: string | null | undefined,
): T[] {
	if (!runId) return agents;
	return agents.filter((a) => a.runId === runId || a.runId === null);
}

/**
 * Pre-opened database handles for the dashboard poll loop.
 * Stores are opened once and reused across ticks to avoid
 * repeated open/close/PRAGMA/WAL checkpoint overhead.
 */
export interface DashboardStores {
	sessionStore: SessionStore;
	mailStore: MailStore | null;
	mergeQueue: MergeQueue | null;
	metricsStore: MetricsStore | null;
	eventStore: EventStore | null;
}

/**
 * Open all database connections needed by the dashboard.
 * Returns null handles for databases that do not exist on disk.
 */
export function openDashboardStores(root: string): DashboardStores {
	const overstoryDir = join(root, ".overstory");
	const { store: sessionStore } = openSessionStore(overstoryDir);

	let mailStore: MailStore | null = null;
	try {
		const mailDbPath = join(overstoryDir, "mail.db");
		if (existsSync(mailDbPath)) {
			mailStore = createMailStore(mailDbPath);
		}
	} catch {
		// mail db might not be openable
	}

	let mergeQueue: MergeQueue | null = null;
	try {
		const queuePath = join(overstoryDir, "merge-queue.db");
		if (existsSync(queuePath)) {
			mergeQueue = createMergeQueue(queuePath);
		}
	} catch {
		// queue db might not be openable
	}

	let metricsStore: MetricsStore | null = null;
	try {
		const metricsDbPath = join(overstoryDir, "metrics.db");
		if (existsSync(metricsDbPath)) {
			metricsStore = createMetricsStore(metricsDbPath);
		}
	} catch {
		// metrics db might not be openable
	}

	let eventStore: EventStore | null = null;
	try {
		const eventsDbPath = join(overstoryDir, "events.db");
		if (existsSync(eventsDbPath)) {
			eventStore = createEventStore(eventsDbPath);
		}
	} catch {
		// events db might not be openable
	}

	return { sessionStore, mailStore, mergeQueue, metricsStore, eventStore };
}

/**
 * Close all dashboard database connections.
 */
export function closeDashboardStores(stores: DashboardStores): void {
	try {
		stores.sessionStore.close();
	} catch {
		/* best effort */
	}
	try {
		stores.mailStore?.close();
	} catch {
		/* best effort */
	}
	try {
		stores.mergeQueue?.close();
	} catch {
		/* best effort */
	}
	try {
		stores.metricsStore?.close();
	} catch {
		/* best effort */
	}
	try {
		stores.eventStore?.close();
	} catch {
		/* best effort */
	}
}

/**
 * Rolling event buffer with incremental dedup by lastSeenId.
 * Maintains a fixed-size window of the most recent events.
 */
export class EventBuffer {
	private events: StoredEvent[] = [];
	private lastSeenId = 0;
	private colorMap: Map<string, (s: string) => string> = new Map();
	private readonly maxSize: number;

	constructor(maxSize = 100) {
		this.maxSize = maxSize;
	}

	poll(eventStore: EventStore): void {
		const since = new Date(Date.now() - 60 * 1000).toISOString();
		const allEvents = eventStore.getTimeline({ since, limit: 1000 });
		const newEvents = allEvents.filter((e) => e.id > this.lastSeenId);

		if (newEvents.length === 0) return;

		extendAgentColorMap(this.colorMap, newEvents);
		this.events = [...this.events, ...newEvents].slice(-this.maxSize);

		const lastEvent = newEvents[newEvents.length - 1];
		if (lastEvent) {
			this.lastSeenId = lastEvent.id;
		}
	}

	getEvents(): StoredEvent[] {
		return this.events;
	}

	getColorMap(): Map<string, (s: string) => string> {
		return this.colorMap;
	}

	get size(): number {
		return this.events.length;
	}
}

/** Tracker data cached between dashboard ticks (10s TTL). */
interface TrackerCache {
	tasks: TrackerIssue[];
	fetchedAt: number; // Date.now() ms
}

/** Module-level tracker cache (persists across poll ticks). */
let trackerCache: TrackerCache | null = null;
const TRACKER_CACHE_TTL_MS = 10_000; // 10 seconds

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
	tasks: TrackerIssue[];
	recentEvents: StoredEvent[];
	feedColorMap: Map<string, (s: string) => string>;
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
 * Load all data sources for the dashboard using pre-opened store handles.
 * When runId is provided, all panels are scoped to agents in that run.
 * No stores are opened or closed here — that is the caller's responsibility.
 */
async function loadDashboardData(
	root: string,
	stores: DashboardStores,
	runId?: string | null,
	thresholds?: { staleMs: number; zombieMs: number },
	eventBuffer?: EventBuffer,
): Promise<DashboardData> {
	// Get all sessions from the pre-opened session store
	const allSessions = stores.sessionStore.getAll();

	// Get worktrees and tmux sessions via cached subprocess helpers
	const worktrees = await getCachedWorktrees(root);
	const tmuxSessions = await getCachedTmuxSessions();

	// Evaluate health for active agents using the same logic as the watchdog.
	const tmuxSessionNames = new Set(tmuxSessions.map((s) => s.name));
	const healthThresholds = thresholds ?? { staleMs: 300_000, zombieMs: 600_000 };
	for (const session of allSessions) {
		if (session.state === "completed") continue;
		const tmuxAlive = tmuxSessionNames.has(session.tmuxSession);
		const check = evaluateHealth(session, tmuxAlive, healthThresholds);
		if (check.state !== session.state) {
			try {
				stores.sessionStore.updateState(session.agentName, check.state);
				session.state = check.state;
			} catch {
				// Best effort: don't fail dashboard if update fails
			}
		}
	}

	// If run-scoped, filter agents to only those belonging to the current run.
	const filteredAgents = filterAgentsByRun(allSessions, runId);

	// Count unread mail
	let unreadMailCount = 0;
	if (stores.mailStore) {
		try {
			const unread = stores.mailStore.getAll({ to: "orchestrator", unread: true });
			unreadMailCount = unread.length;
		} catch {
			// best effort
		}
	}

	// Count merge queue pending entries
	let mergeQueueCount = 0;
	if (stores.mergeQueue) {
		try {
			mergeQueueCount = stores.mergeQueue.list("pending").length;
		} catch {
			// best effort
		}
	}

	// Count recent metrics sessions
	let recentMetricsCount = 0;
	if (stores.metricsStore) {
		try {
			recentMetricsCount = stores.metricsStore.countSessions();
		} catch {
			// best effort
		}
	}

	const status: StatusData = {
		currentRunId: runId,
		agents: filteredAgents,
		worktrees,
		tmuxSessions,
		unreadMailCount,
		mergeQueueCount,
		recentMetricsCount,
	};

	// Load recent mail from pre-opened mail store
	let recentMail: MailMessage[] = [];
	if (stores.mailStore) {
		try {
			if (runId && filteredAgents.length > 0) {
				const agentNames = new Set(filteredAgents.map((a) => a.agentName));
				const allMail = stores.mailStore.getAll({ limit: 50 });
				recentMail = allMail
					.filter((m) => agentNames.has(m.from) || agentNames.has(m.to))
					.slice(0, 5);
			} else {
				recentMail = stores.mailStore.getAll({ limit: 5 });
			}
		} catch {
			// best effort
		}
	}

	// Load merge queue entries from pre-opened merge queue
	let mergeQueueEntries: Array<{ branchName: string; agentName: string; status: string }> = [];
	if (stores.mergeQueue) {
		try {
			let entries = stores.mergeQueue.list();
			if (runId && filteredAgents.length > 0) {
				const agentNames = new Set(filteredAgents.map((a) => a.agentName));
				entries = entries.filter((e) => agentNames.has(e.agentName));
			}
			mergeQueueEntries = entries.map((e) => ({
				branchName: e.branchName,
				agentName: e.agentName,
				status: e.status,
			}));
		} catch {
			// best effort
		}
	}

	// Load metrics from pre-opened metrics store
	let totalSessions = 0;
	let avgDuration = 0;
	const byCapability: Record<string, number> = {};
	if (stores.metricsStore) {
		try {
			if (runId && filteredAgents.length > 0) {
				const agentNames = new Set(filteredAgents.map((a) => a.agentName));
				const sessions = stores.metricsStore.getRecentSessions(100);
				const filtered = sessions.filter((s) => agentNames.has(s.agentName));

				totalSessions = filtered.length;

				const completedSessions = filtered.filter((s) => s.completedAt !== null);
				if (completedSessions.length > 0) {
					avgDuration =
						completedSessions.reduce((sum, s) => sum + s.durationMs, 0) / completedSessions.length;
				}

				for (const session of filtered) {
					const cap = session.capability;
					byCapability[cap] = (byCapability[cap] ?? 0) + 1;
				}
			} else {
				totalSessions = stores.metricsStore.countSessions();
				avgDuration = stores.metricsStore.getAverageDuration();

				const sessions = stores.metricsStore.getRecentSessions(100);
				for (const session of sessions) {
					const cap = session.capability;
					byCapability[cap] = (byCapability[cap] ?? 0) + 1;
				}
			}
		} catch {
			// best effort
		}
	}

	// Load tasks from tracker with cache
	let tasks: TrackerIssue[] = [];
	const now2 = Date.now();
	if (!trackerCache || now2 - trackerCache.fetchedAt > TRACKER_CACHE_TTL_MS) {
		try {
			const backend = await resolveBackend("auto", root);
			const tracker = createTrackerClient(backend, root);
			tasks = await tracker.list({ limit: 10 });
			trackerCache = { tasks, fetchedAt: now2 };
		} catch {
			// tracker unavailable — graceful degradation
			tasks = trackerCache?.tasks ?? [];
		}
	} else {
		tasks = trackerCache.tasks;
	}

	// Load recent events via incremental buffer (or fallback to empty)
	let recentEvents: StoredEvent[] = [];
	let feedColorMap: Map<string, (s: string) => string> = new Map();
	if (eventBuffer && stores.eventStore) {
		try {
			eventBuffer.poll(stores.eventStore);
			recentEvents = [...eventBuffer.getEvents()].reverse();
			feedColorMap = eventBuffer.getColorMap();
		} catch {
			/* best effort */
		}
	}

	return {
		currentRunId: runId,
		status,
		recentMail,
		mergeQueue: mergeQueueEntries,
		metrics: { totalSessions, avgDuration, byCapability },
		tasks,
		recentEvents,
		feedColorMap,
	};
}

/**
 * Render the header bar (line 1).
 */
function renderHeader(width: number, interval: number, currentRunId?: string | null): string {
	const left = brand.bold(`ov dashboard v${PKG_VERSION}`);
	const now = new Date().toLocaleTimeString();
	const scope = currentRunId ? ` [run: ${accent(currentRunId.slice(0, 8))}]` : " [all runs]";
	const right = `${now}${scope} | refresh: ${interval}ms`;
	const padding = width - visibleLength(left) - right.length;
	const line = left + " ".repeat(Math.max(0, padding)) + right;
	const separator = horizontalLine(width, BOX.topLeft, BOX.horizontal, BOX.topRight);
	return `${line}\n${separator}`;
}

/**
 * Render the agent panel (left 60%, dynamic height).
 */
export function renderAgentPanel(
	data: DashboardData,
	fullWidth: number,
	panelHeight: number,
	startRow: number,
): string {
	const leftWidth = fullWidth;
	let output = "";

	// Panel header
	const headerLine = `${dimBox.vertical} ${brand.bold("Agents")} (${data.status.agents.length})`;
	const headerPadding = " ".repeat(
		Math.max(0, leftWidth - visibleLength(headerLine) - visibleLength(dimBox.vertical)),
	);
	output += `${CURSOR.cursorTo(startRow, 1)}${headerLine}${headerPadding}${dimBox.vertical}\n`;

	// Column headers
	const colStr = `${dimBox.vertical} St Name            Capability    State      Task ID          Duration  Live `;
	const colPadding = " ".repeat(
		Math.max(0, leftWidth - visibleLength(colStr) - visibleLength(dimBox.vertical)),
	);
	output += `${CURSOR.cursorTo(startRow + 1, 1)}${colStr}${colPadding}${dimBox.vertical}\n`;

	// Separator
	const separator = dimHorizontalLine(leftWidth, dimBox.tee, dimBox.teeRight);
	output += `${CURSOR.cursorTo(startRow + 2, 1)}${separator}\n`;

	// Sort agents: active first, then completed, then zombie
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

		const icon = stateIcon(agent.state);
		const stateColorFn = stateColor(agent.state);
		const name = accent(pad(truncate(agent.agentName, 15), 15));
		const capability = pad(truncate(agent.capability, 12), 12);
		const state = pad(agent.state, 10);
		const taskId = accent(pad(truncate(agent.taskId, 16), 16));
		const endTime =
			agent.state === "completed" || agent.state === "zombie"
				? new Date(agent.lastActivity).getTime()
				: now;
		const duration = formatDuration(endTime - new Date(agent.startedAt).getTime());
		const durationPadded = pad(duration, 9);
		const isHeadless = agent.tmuxSession === "" && agent.pid !== null;
		const alive = isHeadless
			? agent.pid !== null && isProcessAlive(agent.pid)
			: data.status.tmuxSessions.some((s) => s.name === agent.tmuxSession);
		const aliveDot = alive ? color.green(">") : color.red("x");

		const lineContent = `${dimBox.vertical} ${stateColorFn(icon)}  ${name} ${capability} ${stateColorFn(state)} ${taskId} ${durationPadded} ${aliveDot}    `;
		const linePadding = " ".repeat(
			Math.max(0, leftWidth - visibleLength(lineContent) - visibleLength(dimBox.vertical)),
		);
		output += `${CURSOR.cursorTo(startRow + 3 + i, 1)}${lineContent}${linePadding}${dimBox.vertical}\n`;
	}

	// Fill remaining rows with empty lines
	for (let i = visibleAgents.length; i < maxRows; i++) {
		const emptyLine = `${dimBox.vertical}${" ".repeat(Math.max(0, leftWidth - 2))}${dimBox.vertical}`;
		output += `${CURSOR.cursorTo(startRow + 3 + i, 1)}${emptyLine}\n`;
	}

	// Bottom border (joins the right column)
	const bottomBorder = dimHorizontalLine(leftWidth, dimBox.tee, dimBox.teeRight);
	output += `${CURSOR.cursorTo(startRow + 3 + maxRows, 1)}${bottomBorder}\n`;

	return output;
}

/**
 * Render the tasks panel (upper-right quadrant).
 */
export function renderTasksPanel(
	data: DashboardData,
	startCol: number,
	panelWidth: number,
	panelHeight: number,
	startRow: number,
): string {
	let output = "";

	// Header
	const headerLine = `${dimBox.vertical} ${brand.bold("Tasks")} (${data.tasks.length})`;
	const headerPadding = " ".repeat(
		Math.max(0, panelWidth - visibleLength(headerLine) - visibleLength(dimBox.vertical)),
	);
	output += `${CURSOR.cursorTo(startRow, startCol)}${headerLine}${headerPadding}${dimBox.vertical}\n`;

	// Separator
	const separator = dimHorizontalLine(panelWidth, dimBox.tee, dimBox.teeRight);
	output += `${CURSOR.cursorTo(startRow + 1, startCol)}${separator}\n`;

	const maxRows = panelHeight - 2; // header + separator
	const visibleTasks = data.tasks.slice(0, maxRows);

	if (visibleTasks.length === 0) {
		const emptyMsg = color.dim("No tracker data");
		const emptyLine = `${dimBox.vertical} ${emptyMsg}`;
		const emptyPadding = " ".repeat(
			Math.max(0, panelWidth - visibleLength(emptyLine) - visibleLength(dimBox.vertical)),
		);
		output += `${CURSOR.cursorTo(startRow + 2, startCol)}${emptyLine}${emptyPadding}${dimBox.vertical}\n`;
		// Fill remaining rows
		for (let i = 1; i < maxRows; i++) {
			const blankLine = `${dimBox.vertical}${" ".repeat(Math.max(0, panelWidth - 2))}${dimBox.vertical}`;
			output += `${CURSOR.cursorTo(startRow + 2 + i, startCol)}${blankLine}\n`;
		}
		return output;
	}

	for (let i = 0; i < visibleTasks.length; i++) {
		const task = visibleTasks[i];
		if (!task) continue;

		const idStr = accent(pad(truncate(task.id, 14), 14));
		const priorityStr = numericPriorityColor(task.priority)(`P${task.priority}`);
		const statusStr = pad(task.status, 12);
		const titleMaxLen = Math.max(4, panelWidth - 44);
		const titleStr = truncate(task.title, titleMaxLen);

		const lineContent = `${dimBox.vertical} ${idStr} ${titleStr} ${priorityStr} ${statusStr}`;
		const linePadding = " ".repeat(
			Math.max(0, panelWidth - visibleLength(lineContent) - visibleLength(dimBox.vertical)),
		);
		output += `${CURSOR.cursorTo(startRow + 2 + i, startCol)}${lineContent}${linePadding}${dimBox.vertical}\n`;
	}

	// Fill remaining rows
	for (let i = visibleTasks.length; i < maxRows; i++) {
		const blankLine = `${dimBox.vertical}${" ".repeat(Math.max(0, panelWidth - 2))}${dimBox.vertical}`;
		output += `${CURSOR.cursorTo(startRow + 2 + i, startCol)}${blankLine}\n`;
	}

	return output;
}

/**
 * Render the feed panel (lower-right quadrant).
 */
export function renderFeedPanel(
	data: DashboardData,
	startCol: number,
	panelWidth: number,
	panelHeight: number,
	startRow: number,
): string {
	let output = "";

	// Header
	const headerLine = `${dimBox.vertical} ${brand.bold("Feed")} (live)`;
	const headerPadding = " ".repeat(
		Math.max(0, panelWidth - visibleLength(headerLine) - visibleLength(dimBox.vertical)),
	);
	output += `${CURSOR.cursorTo(startRow, startCol)}${headerLine}${headerPadding}${dimBox.vertical}\n`;

	// Separator
	const separator = dimHorizontalLine(panelWidth, dimBox.tee, dimBox.teeRight);
	output += `${CURSOR.cursorTo(startRow + 1, startCol)}${separator}\n`;

	const maxRows = panelHeight - 2; // header + separator

	if (data.recentEvents.length === 0) {
		const emptyMsg = color.dim("No recent events");
		const emptyLine = `${dimBox.vertical} ${emptyMsg}`;
		const emptyPadding = " ".repeat(
			Math.max(0, panelWidth - visibleLength(emptyLine) - visibleLength(dimBox.vertical)),
		);
		output += `${CURSOR.cursorTo(startRow + 2, startCol)}${emptyLine}${emptyPadding}${dimBox.vertical}\n`;
		for (let i = 1; i < maxRows; i++) {
			const blankLine = `${dimBox.vertical}${" ".repeat(Math.max(0, panelWidth - 2))}${dimBox.vertical}`;
			output += `${CURSOR.cursorTo(startRow + 2 + i, startCol)}${blankLine}\n`;
		}
		return output;
	}

	const colorMap =
		data.feedColorMap.size > 0 ? data.feedColorMap : buildAgentColorMap(data.recentEvents);
	const visibleEvents = data.recentEvents.slice(0, maxRows);

	for (let i = 0; i < visibleEvents.length; i++) {
		const event = visibleEvents[i];
		if (!event) continue;

		const formatted = formatEventLine(event, colorMap);
		// ANSI-safe truncation: trim to panelWidth - 4 (border + space each side)
		const maxLineLen = panelWidth - 4;
		let displayLine = formatted;
		if (visibleLength(displayLine) > maxLineLen) {
			// Truncate by stripping to visible characters
			let count = 0;
			let end = 0;
			// biome-ignore lint/suspicious/noControlCharactersInRegex: needed for ANSI
			const ANSI = /\x1b\[[0-9;]*m/g;
			let lastIndex = 0;
			let match = ANSI.exec(displayLine);
			while (match !== null) {
				const plainSegLen = match.index - lastIndex;
				if (count + plainSegLen >= maxLineLen - 1) {
					end = lastIndex + (maxLineLen - 1 - count);
					count = maxLineLen - 1;
					break;
				}
				count += plainSegLen;
				lastIndex = match.index + match[0].length;
				end = lastIndex;
				match = ANSI.exec(displayLine);
			}
			if (count < maxLineLen - 1) {
				end = displayLine.length;
			}
			displayLine = `${displayLine.slice(0, end)}…`;
		}

		const lineContent = `${dimBox.vertical} ${displayLine}`;
		const contentLen = visibleLength(lineContent) + visibleLength(dimBox.vertical);
		const linePadding = " ".repeat(Math.max(0, panelWidth - contentLen));
		output += `${CURSOR.cursorTo(startRow + 2 + i, startCol)}${lineContent}${linePadding}${dimBox.vertical}\n`;
	}

	// Fill remaining rows
	for (let i = visibleEvents.length; i < maxRows; i++) {
		const blankLine = `${dimBox.vertical}${" ".repeat(Math.max(0, panelWidth - 2))}${dimBox.vertical}`;
		output += `${CURSOR.cursorTo(startRow + 2 + i, startCol)}${blankLine}\n`;
	}

	return output;
}

/**
 * Render the mail panel (bottom-left 50%).
 */
function renderMailPanel(
	data: DashboardData,
	panelWidth: number,
	panelHeight: number,
	startRow: number,
): string {
	let output = "";

	const unreadCount = data.status.unreadMailCount;
	const headerLine = `${dimBox.vertical} ${brand.bold("Mail")} (${unreadCount} unread)`;
	const headerPadding = " ".repeat(
		Math.max(0, panelWidth - visibleLength(headerLine) - visibleLength(dimBox.vertical)),
	);
	output += `${CURSOR.cursorTo(startRow, 1)}${headerLine}${headerPadding}${dimBox.vertical}\n`;

	const separator = dimHorizontalLine(panelWidth, dimBox.tee, dimBox.cross);
	output += `${CURSOR.cursorTo(startRow + 1, 1)}${separator}\n`;

	const maxRows = panelHeight - 3; // header + separator + border
	const messages = data.recentMail.slice(0, maxRows);

	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		if (!msg) continue;

		const priorityColorFn = priorityColor(msg.priority);
		const priority = msg.priority === "normal" ? "" : `[${msg.priority}] `;
		const from = accent(truncate(msg.from, 12));
		const to = accent(truncate(msg.to, 12));
		const subject = truncate(msg.subject, panelWidth - 40);
		const time = formatRelativeTime(msg.createdAt);

		const coloredPriority = priority ? priorityColorFn(priority) : "";
		const lineContent = `${dimBox.vertical} ${coloredPriority}${from} → ${to}: ${subject} (${time})`;
		const padding = " ".repeat(
			Math.max(0, panelWidth - visibleLength(lineContent) - visibleLength(dimBox.vertical)),
		);
		output += `${CURSOR.cursorTo(startRow + 2 + i, 1)}${lineContent}${padding}${dimBox.vertical}\n`;
	}

	// Fill remaining rows with empty lines
	for (let i = messages.length; i < maxRows; i++) {
		const emptyLine = `${dimBox.vertical}${" ".repeat(Math.max(0, panelWidth - 2))}${dimBox.vertical}`;
		output += `${CURSOR.cursorTo(startRow + 2 + i, 1)}${emptyLine}\n`;
	}

	return output;
}

/**
 * Render the merge queue panel (bottom-right 50%).
 */
function renderMergeQueuePanel(
	data: DashboardData,
	panelWidth: number,
	panelHeight: number,
	startRow: number,
	startCol: number,
): string {
	let output = "";

	const headerLine = `${dimBox.vertical} ${brand.bold("Merge Queue")} (${data.mergeQueue.length})`;
	const headerPadding = " ".repeat(
		Math.max(0, panelWidth - visibleLength(headerLine) - visibleLength(dimBox.vertical)),
	);
	output += `${CURSOR.cursorTo(startRow, startCol)}${headerLine}${headerPadding}${dimBox.vertical}\n`;

	const separator = dimHorizontalLine(panelWidth, dimBox.cross, dimBox.teeRight);
	output += `${CURSOR.cursorTo(startRow + 1, startCol)}${separator}\n`;

	const maxRows = panelHeight - 3; // header + separator + border
	const entries = data.mergeQueue.slice(0, maxRows);

	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		if (!entry) continue;

		const statusColorFn = mergeStatusColor(entry.status);
		const status = pad(entry.status, 10);
		const agent = accent(truncate(entry.agentName, 15));
		const branch = truncate(entry.branchName, panelWidth - 30);

		const lineContent = `${dimBox.vertical} ${statusColorFn(status)} ${agent} ${branch}`;
		const padding = " ".repeat(
			Math.max(0, panelWidth - visibleLength(lineContent) - visibleLength(dimBox.vertical)),
		);
		output += `${CURSOR.cursorTo(startRow + 2 + i, startCol)}${lineContent}${padding}${dimBox.vertical}\n`;
	}

	// Fill remaining rows with empty lines
	for (let i = entries.length; i < maxRows; i++) {
		const emptyLine = `${dimBox.vertical}${" ".repeat(Math.max(0, panelWidth - 2))}${dimBox.vertical}`;
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

	const separator = dimHorizontalLine(width, dimBox.tee, dimBox.teeRight);
	output += `${CURSOR.cursorTo(startRow, 1)}${separator}\n`;

	const totalSessions = data.metrics.totalSessions;
	const avgDur = formatDuration(data.metrics.avgDuration);
	const byCapability = Object.entries(data.metrics.byCapability)
		.map(([cap, count]) => `${cap}:${count}`)
		.join(", ");

	const metricsLine = `${dimBox.vertical} ${brand.bold("Metrics")}  Total: ${totalSessions} | Avg: ${avgDur} | ${byCapability}`;
	const metricsPadding = " ".repeat(
		Math.max(0, width - visibleLength(metricsLine) - visibleLength(dimBox.vertical)),
	);
	output += `${CURSOR.cursorTo(startRow + 1, 1)}${metricsLine}${metricsPadding}${dimBox.vertical}\n`;

	const bottomBorder = dimHorizontalLine(width, dimBox.bottomLeft, dimBox.bottomRight);
	output += `${CURSOR.cursorTo(startRow + 2, 1)}${bottomBorder}\n`;

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

	// Agent panel: full width, capped at 35% of height
	const agentPanelStart = 3;
	const agentCount = data.status.agents.length;
	const agentPanelHeight = computeAgentPanelHeight(height, agentCount);
	output += renderAgentPanel(data, width, agentPanelHeight, agentPanelStart);

	// Middle zone: Feed (left 60%) | Tasks (right 40%)
	const middleStart = agentPanelStart + agentPanelHeight + 1;
	const compactPanelHeight = 5; // fixed for mail/merge panels
	const metricsHeight = 3; // separator + data + border
	const middleHeight = Math.max(6, height - middleStart - compactPanelHeight - metricsHeight);

	const feedWidth = Math.floor(width * 0.6);
	output += renderFeedPanel(data, 1, feedWidth, middleHeight, middleStart);

	const taskWidth = width - feedWidth;
	const taskStartCol = feedWidth + 1;
	output += renderTasksPanel(data, taskStartCol, taskWidth, middleHeight, middleStart);

	// Compact panels: Mail (left 50%) | Merge Queue (right 50%) — fixed 5 rows
	const compactStart = middleStart + middleHeight;
	const mailWidth = Math.floor(width * 0.5);
	output += renderMailPanel(data, mailWidth, compactPanelHeight, compactStart);

	const mergeStartCol = mailWidth + 1;
	const mergeWidth = width - mailWidth;
	output += renderMergeQueuePanel(
		data,
		mergeWidth,
		compactPanelHeight,
		compactStart,
		mergeStartCol,
	);

	// Metrics footer
	const metricsStart = compactStart + compactPanelHeight;
	output += renderMetricsPanel(data, width, height, metricsStart);

	process.stdout.write(output);
}

interface DashboardOpts {
	interval?: string;
	all?: boolean;
}

async function executeDashboard(opts: DashboardOpts): Promise<void> {
	const intervalStr = opts.interval;
	const interval = intervalStr ? Number.parseInt(intervalStr, 10) : 2000;
	const showAll = opts.all ?? false;

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

	// Open stores once for the entire poll loop lifetime
	const stores = openDashboardStores(root);

	// Create rolling event buffer (persisted across poll ticks)
	const eventBuffer = new EventBuffer(100);

	// Compute health thresholds once from config (reused across poll ticks)
	const thresholds = {
		staleMs: config.watchdog.staleThresholdMs,
		zombieMs: config.watchdog.zombieThresholdMs,
	};

	// Hide cursor
	process.stdout.write(CURSOR.hideCursor);

	// Clean exit on Ctrl+C
	let running = true;
	process.on("SIGINT", () => {
		running = false;
		closeDashboardStores(stores);
		process.stdout.write(CURSOR.showCursor);
		process.stdout.write(CURSOR.clear);
		process.exit(0);
	});

	// Poll loop
	while (running) {
		const data = await loadDashboardData(root, stores, runId, thresholds, eventBuffer);
		renderDashboard(data, interval);
		await Bun.sleep(interval);
	}
}

export function createDashboardCommand(): Command {
	return new Command("dashboard")
		.description("Live TUI dashboard for agent monitoring (Ctrl+C to stop)")
		.option("--interval <ms>", "Poll interval in milliseconds (default: 2000, min: 500)")
		.option("--all", "Show data from all runs (default: current run only)")
		.action(async (opts: DashboardOpts) => {
			await executeDashboard(opts);
		});
}

export async function dashboardCommand(args: string[]): Promise<void> {
	const cmd = createDashboardCommand();
	cmd.exitOverride();
	try {
		await cmd.parseAsync(args, { from: "user" });
	} catch (err: unknown) {
		if (err && typeof err === "object" && "code" in err) {
			const code = (err as { code: string }).code;
			if (code === "commander.helpDisplayed" || code === "commander.version") {
				return;
			}
			if (code.startsWith("commander.")) {
				const message = err instanceof Error ? err.message : String(err);
				throw new ValidationError(message, { field: "args" });
			}
		}
		throw err;
	}
}

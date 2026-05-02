/**
 * Canonical visual theme for overstory CLI output.
 *
 * Single source of truth for state colors, event labels, agent palette,
 * separators, and header rendering. All observability commands import from here.
 */

import type { AgentState, EventType } from "../types.ts";
import type { ColorFn } from "./color.ts";
import { brand, color, noColor, visibleLength } from "./color.ts";

// === Agent State Theme ===

/** Maps agent states to their visual color functions. */
const STATE_COLORS: Record<AgentState, ColorFn> = {
	working: color.green,
	in_turn: color.green,
	between_turns: color.cyan,
	booting: color.yellow,
	stalled: color.red,
	zombie: color.dim,
	completed: color.cyan,
};

/** Maps agent states to their icon characters. */
const STATE_ICONS: Record<AgentState, string> = {
	working: ">",
	in_turn: ">",
	between_turns: "~",
	booting: "~",
	stalled: "!",
	zombie: "x",
	completed: "\u2713",
};

/** Returns the color function for a given agent state. Falls back to noColor. */
export function stateColor(state: string): ColorFn {
	return STATE_COLORS[state as AgentState] ?? noColor;
}

/** Returns the raw icon character for a given agent state. Falls back to "?". */
export function stateIcon(state: string): string {
	return STATE_ICONS[state as AgentState] ?? "?";
}

/** Returns a colored icon string for a given agent state. */
export function stateIconColored(state: string): string {
	return stateColor(state)(stateIcon(state));
}

// === Event Label Theme ===

export interface EventLabel {
	/** 5-character compact label (for feed). */
	compact: string;
	/** 10-character full label (for trace/replay). */
	full: string;
	/** Color function for this event type. */
	color: ColorFn;
}

/** Maps event types to their compact (5-char) and full (10-char) labels, plus color. */
const EVENT_LABELS: Record<EventType, EventLabel> = {
	tool_start: { compact: "TOOL+", full: "TOOL START", color: color.blue },
	tool_end: { compact: "TOOL-", full: "TOOL END  ", color: color.blue },
	session_start: { compact: "SESS+", full: "SESSION  +", color: color.green },
	session_end: { compact: "SESS-", full: "SESSION  -", color: color.yellow },
	mail_sent: { compact: "MAIL>", full: "MAIL SENT ", color: color.cyan },
	mail_received: { compact: "MAIL<", full: "MAIL RECV ", color: color.cyan },
	spawn: { compact: "SPAWN", full: "SPAWN     ", color: color.magenta },
	error: { compact: "ERROR", full: "ERROR     ", color: color.red },
	custom: { compact: "CUSTM", full: "CUSTOM    ", color: color.gray },
	turn_start: { compact: "TURN+", full: "TURN START", color: color.green },
	turn_end: { compact: "TURN-", full: "TURN END  ", color: color.yellow },
	progress: { compact: "PROG ", full: "PROGRESS  ", color: color.cyan },
	result: { compact: "RSULT", full: "RESULT    ", color: color.green },
};

/** Returns the EventLabel for a given event type. */
export function eventLabel(eventType: EventType): EventLabel {
	return EVENT_LABELS[eventType];
}

// === Agent Colors (for multi-agent displays) ===

/** Stable palette for assigning distinct colors to agents in multi-agent displays. */
export const AGENT_COLORS: readonly ColorFn[] = [
	color.blue,
	color.green,
	color.yellow,
	color.cyan,
	color.magenta,
] as const;

// === Separators ===

/** Unicode thin horizontal box-drawing character. */
export const SEPARATOR_CHAR = "\u2500";

/** Unicode double horizontal box-drawing character (thick). */
export const THICK_SEPARATOR_CHAR = "\u2550";

/** Default line width for separators and headers. */
export const DEFAULT_WIDTH = 70;

/** Returns a thin separator line of the given width (default 70). */
export function separator(width?: number): string {
	return SEPARATOR_CHAR.repeat(width ?? DEFAULT_WIDTH);
}

/** Returns a thick (double-line) separator of the given width (default 70). */
export function thickSeparator(width?: number): string {
	return THICK_SEPARATOR_CHAR.repeat(width ?? DEFAULT_WIDTH);
}

// === Header Rendering ===

/**
 * Pads a string to the given visible width, accounting for ANSI escape codes.
 * If the string is already wider than width, returns it unchanged.
 */
export function padVisible(str: string, width: number): string {
	const visible = visibleLength(str);
	if (visible >= width) return str;
	return str + " ".repeat(width - visible);
}

/**
 * Renders a primary header: brand bold title + newline + thin separator.
 */
export function renderHeader(title: string, width?: number): string {
	return `${brand.bold(title)}\n${separator(width)}`;
}

/**
 * Renders a secondary header: color bold title + newline + dim thin separator.
 */
export function renderSubHeader(title: string, width?: number): string {
	return `${color.bold(title)}\n${color.dim(separator(width))}`;
}

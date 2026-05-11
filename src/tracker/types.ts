/**
 * Unified tracker types — shared across beads and seeds backends.
 * This module is self-contained and does NOT import from src/types.ts.
 */

/**
 * A tracker issue — unified across beads and seeds backends.
 */
export interface TrackerIssue {
	id: string;
	title: string;
	status: string;
	priority: number;
	type: string;
	assignee?: string;
	description?: string;
	blocks?: string[];
	blockedBy?: string[];
}

/**
 * Unified tracker client interface.
 * Both beads and seeds backends implement this.
 */
export interface TrackerClient {
	/** List issues that are ready for work (open, unblocked). */
	ready(): Promise<TrackerIssue[]>;

	/** Show details for a specific issue. */
	show(id: string): Promise<TrackerIssue>;

	/** Create a new issue. Returns the new issue ID. */
	create(
		title: string,
		options?: { type?: string; priority?: number; description?: string },
	): Promise<string>;

	/** Claim an issue (mark as in_progress). */
	claim(id: string): Promise<void>;

	/** Close an issue with an optional reason. */
	close(id: string, reason?: string): Promise<void>;

	/** List issues with optional filters. */
	list(options?: { status?: string; limit?: number }): Promise<TrackerIssue[]>;

	/** Sync tracker state with git (if supported). */
	sync(): Promise<void>;
}

/** Which tracker backend to use. */
export type TrackerBackend = "beads" | "beads_rust" | "seeds";

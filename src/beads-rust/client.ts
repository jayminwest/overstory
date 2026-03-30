/**
 * Beads Rust (br) CLI client.
 *
 * Wraps the `br` command-line tool for issue tracking operations.
 * All commands use `--json` for parseable output where supported.
 * Uses Bun.spawn — zero runtime dependencies.
 *
 * Key differences from the bd (beads) client:
 * - list: returns envelope { issues: [], total, limit, offset, has_more }
 * - create: returns single object with id field (not { id } wrapper)
 * - claim: atomic via `update --claim` flag
 * - sync: requires `--flush-only` mode flag
 */

import { AgentError } from "../errors.ts";

/**
 * A beads_rust issue as returned by the br CLI.
 * Defined locally since it comes from an external CLI tool.
 */
export interface BeadsRustIssue {
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

export interface BeadsRustClient {
	/** List issues that are ready for work (open, unblocked). */
	ready(): Promise<BeadsRustIssue[]>;

	/** Show details for a specific issue. */
	show(id: string): Promise<BeadsRustIssue>;

	/** Create a new issue. Returns the new issue ID. */
	create(
		title: string,
		options?: { type?: string; priority?: number; description?: string },
	): Promise<string>;

	/** Claim an issue (atomic: assignee=actor + status=in_progress). */
	claim(id: string): Promise<void>;

	/** Close an issue with an optional reason. */
	close(id: string, reason?: string): Promise<void>;

	/** List issues with optional filters. */
	list(options?: { status?: string; limit?: number }): Promise<BeadsRustIssue[]>;

	/** Sync tracker state (export DB to JSONL). */
	sync(): Promise<void>;
}

/**
 * Run a shell command and capture its output.
 */
async function runCommand(
	cmd: string[],
	cwd: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const proc = Bun.spawn(cmd, {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	const exitCode = await proc.exited;
	return { stdout, stderr, exitCode };
}

/**
 * Parse JSON output from a br command.
 * Handles the case where output may be empty or malformed.
 */
function parseJsonOutput<T>(stdout: string, context: string): T {
	const trimmed = stdout.trim();
	if (trimmed === "") {
		throw new AgentError(`Empty output from br ${context}`);
	}
	try {
		return JSON.parse(trimmed) as T;
	} catch {
		throw new AgentError(
			`Failed to parse JSON output from br ${context}: ${trimmed.slice(0, 200)}`,
		);
	}
}

/**
 * Raw issue shape from the br CLI.
 * br uses `issue_type` instead of `type`.
 */
interface RawBrIssue {
	id: string;
	title: string;
	status: string;
	priority: number;
	issue_type?: string;
	type?: string;
	assignee?: string;
	description?: string;
	blocks?: string[];
	blockedBy?: string[];
}

/** Envelope for br list --json responses. */
interface BrListEnvelope {
	issues: RawBrIssue[];
	total: number;
	limit: number;
	offset: number;
	has_more: boolean;
}

/** Shape of br create --json response. */
interface BrCreateResponse {
	id: string;
	title: string;
	status: string;
	[key: string]: unknown;
}

/**
 * Normalize a raw br issue into a BeadsRustIssue.
 * Maps `issue_type` -> `type` to match the BeadsRustIssue interface.
 */
function normalizeIssue(raw: RawBrIssue): BeadsRustIssue {
	return {
		id: raw.id,
		title: raw.title,
		status: raw.status,
		priority: raw.priority,
		type: raw.issue_type ?? raw.type ?? "unknown",
		assignee: raw.assignee,
		description: raw.description,
		blocks: raw.blocks,
		blockedBy: raw.blockedBy,
	};
}

/**
 * Create a BeadsRustClient bound to the given working directory.
 *
 * @param cwd - Working directory where br commands should run
 * @returns A BeadsRustClient instance wrapping the br CLI
 */
export function createBeadsRustClient(cwd: string): BeadsRustClient {
	async function runBr(
		args: string[],
		context: string,
	): Promise<{ stdout: string; stderr: string }> {
		const { stdout, stderr, exitCode } = await runCommand(["br", ...args], cwd);
		if (exitCode !== 0) {
			throw new AgentError(`br ${context} failed (exit ${exitCode}): ${stderr.trim()}`);
		}
		return { stdout, stderr };
	}

	return {
		async ready() {
			const { stdout } = await runBr(["ready", "--json"], "ready");
			const raw = parseJsonOutput<RawBrIssue[]>(stdout, "ready");
			return raw.map(normalizeIssue);
		},

		async show(id) {
			const { stdout } = await runBr(["show", id, "--json"], `show ${id}`);
			const raw = parseJsonOutput<RawBrIssue[]>(stdout, `show ${id}`);
			const first = raw[0];
			if (!first) {
				throw new AgentError(`br show ${id} returned empty array`);
			}
			return normalizeIssue(first);
		},

		async create(title, options) {
			const args = ["create", title, "--json"];
			if (options?.type) {
				args.push("--type", options.type);
			}
			if (options?.priority !== undefined) {
				args.push("--priority", String(options.priority));
			}
			if (options?.description) {
				args.push("--description", options.description);
			}
			const { stdout } = await runBr(args, "create");
			const result = parseJsonOutput<BrCreateResponse>(stdout, "create");
			return result.id;
		},

		async claim(id) {
			await runBr(["update", id, "--claim"], `claim ${id}`);
		},

		async close(id, reason) {
			const args = ["close", id];
			if (reason) {
				args.push("--reason", reason);
			}
			await runBr(args, `close ${id}`);
		},

		async list(options) {
			const args = ["list", "--json"];
			if (options?.status) {
				args.push("--status", options.status);
			}
			if (options?.limit !== undefined) {
				args.push("--limit", String(options.limit));
			}
			const { stdout } = await runBr(args, "list");
			const envelope = parseJsonOutput<BrListEnvelope>(stdout, "list");
			return envelope.issues.map(normalizeIssue);
		},

		async sync() {
			await runBr(["sync", "--flush-only"], "sync");
		},
	};
}

/**
 * Beads Rust (br) tracker adapter.
 *
 * Implements the unified TrackerClient interface by calling the `br` CLI directly
 * via Bun.spawn. The br CLI has different JSON output shapes than bd:
 * - ready/show: flat arrays
 * - list: envelope { issues: [], total, limit, offset, has_more }
 * - create: single object with id field
 * - claim: atomic via `update --claim` flag
 * - sync: requires `--flush-only` mode flag
 */

import { AgentError } from "../errors.ts";
import type { TrackerClient, TrackerIssue } from "./types.ts";

/**
 * Run a br command and return its output.
 */
async function runBr(
	args: string[],
	cwd: string,
	context: string,
): Promise<{ stdout: string; stderr: string }> {
	const proc = Bun.spawn(["br", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		throw new AgentError(`br ${context} failed (exit ${exitCode}): ${stderr.trim()}`);
	}
	return { stdout, stderr };
}

/**
 * Parse JSON from br output.
 */
function parseBrJson<T>(stdout: string, context: string): T {
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

/** Raw issue shape from the br CLI. Uses `issue_type` instead of `type`. */
interface BrRawIssue {
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
	issues: BrRawIssue[];
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

function normalizeIssue(raw: BrRawIssue): TrackerIssue {
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
 * Create a TrackerClient backed by the beads_rust (br) CLI.
 *
 * @param cwd - Working directory for br commands
 */
export function createBeadsRustTracker(cwd: string): TrackerClient {
	return {
		async ready() {
			const { stdout } = await runBr(["ready", "--json"], cwd, "ready");
			const raw = parseBrJson<BrRawIssue[]>(stdout, "ready");
			return raw.map(normalizeIssue);
		},

		async show(id) {
			const { stdout } = await runBr(["show", id, "--json"], cwd, `show ${id}`);
			const raw = parseBrJson<BrRawIssue[]>(stdout, `show ${id}`);
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
			const { stdout } = await runBr(args, cwd, "create");
			const result = parseBrJson<BrCreateResponse>(stdout, "create");
			return result.id;
		},

		async claim(id) {
			await runBr(["update", id, "--claim"], cwd, `claim ${id}`);
		},

		async close(id, reason) {
			const args = ["close", id];
			if (reason) {
				args.push("--reason", reason);
			}
			await runBr(args, cwd, `close ${id}`);
		},

		async list(options) {
			const args = ["list", "--json"];
			if (options?.status) {
				args.push("--status", options.status);
			}
			if (options?.limit !== undefined) {
				args.push("--limit", String(options.limit));
			}
			const { stdout } = await runBr(args, cwd, "list");
			const envelope = parseBrJson<BrListEnvelope>(stdout, "list");
			return envelope.issues.map(normalizeIssue);
		},

		async sync() {
			await runBr(["sync", "--flush-only"], cwd, "sync");
		},
	};
}

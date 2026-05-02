/**
 * Mulch CLI client.
 *
 * Wraps the `mulch` command-line tool for structured expertise operations.
 * record(), search(), and query() use the @os-eco/mulch-cli programmatic API
 * via a variable-based dynamic import so tsc cannot statically resolve the
 * module (avoiding type errors in mulch's raw .ts source files).
 * Remaining methods (prime, status, diff, learn, prune, doctor, ready, compact)
 * remain as Bun.spawn CLI wrappers.
 */

import { AgentError } from "../errors.ts";
import type {
	MulchCompactResult,
	MulchDiffResult,
	MulchDoctorResult,
	MulchLearnResult,
	MulchPruneResult,
	MulchReadyResult,
	MulchStatus,
} from "../types.ts";

export interface MulchClient {
	/** Generate a priming prompt, optionally scoped to specific domains. */
	prime(
		domains?: string[],
		format?: "markdown" | "xml" | "json",
		options?: {
			files?: string[];
			excludeDomain?: string[];
			sortByScore?: boolean;
		},
	): Promise<string>;

	/** Append an outcome entry to an existing record by ID in the given domain. */
	appendOutcome(
		domain: string,
		id: string,
		outcome: {
			status: "success" | "failure" | "partial";
			agent?: string;
			notes?: string;
			duration?: number;
		},
	): Promise<void>;

	/** Show domain statistics. */
	status(): Promise<MulchStatus>;

	/** Record an expertise entry for a domain. */
	record(
		domain: string,
		options: {
			type: string;
			name?: string;
			description?: string;
			title?: string;
			rationale?: string;
			tags?: string[];
			classification?: string;
			stdin?: boolean;
			evidenceBead?: string;
			outcomeStatus?: "success" | "failure" | "partial";
			outcomeDuration?: number;
			outcomeTestResults?: string;
			outcomeAgent?: string;
		},
	): Promise<void>;

	/** Query expertise records, optionally scoped to a domain. */
	query(domain?: string): Promise<string>;

	/** Search records across all domains. */
	search(
		query: string,
		options?: {
			file?: string;
			sortByScore?: boolean;
			classification?: string;
			outcomeStatus?: "success" | "failure";
		},
	): Promise<string>;

	/** Show expertise record changes since a git ref. */
	diff(options?: { since?: string }): Promise<MulchDiffResult>;

	/** Show changed files and suggest domains for recording learnings. */
	learn(options?: { since?: string }): Promise<MulchLearnResult>;

	/** Remove unused or stale records. */
	prune(options?: { dryRun?: boolean }): Promise<MulchPruneResult>;

	/** Run health checks on mulch repository. */
	doctor(options?: { fix?: boolean }): Promise<MulchDoctorResult>;

	/** Show recently added or updated expertise records. */
	ready(options?: { limit?: number; domain?: string; since?: string }): Promise<MulchReadyResult>;

	/** Compact and optimize domain storage. */
	compact(
		domain?: string,
		options?: {
			analyze?: boolean;
			apply?: boolean;
			auto?: boolean;
			dryRun?: boolean;
			minGroup?: number;
			maxRecords?: number;
			yes?: boolean;
			records?: string[];
		},
	): Promise<MulchCompactResult>;
}

/**
 * Local type matching @os-eco/mulch-cli ExpertiseRecord.
 * Defined locally to avoid tsc following into mulch's raw .ts source
 * (which conflicts with our noUncheckedIndexedAccess setting).
 */
type MulchClassification = "foundational" | "tactical" | "observational";

interface MulchEvidence {
	commit?: string;
	date?: string;
	issue?: string;
	file?: string;
	bead?: string;
}

interface MulchOutcome {
	status: "success" | "failure" | "partial";
	duration?: number;
	test_results?: string;
	agent?: string;
	notes?: string;
	recorded_at?: string;
}

type MulchExpertiseRecord =
	| {
			type: "convention";
			content: string;
			classification: MulchClassification;
			recorded_at: string;
			id?: string;
			tags?: string[];
			evidence?: MulchEvidence;
			outcomes?: MulchOutcome[];
			relates_to?: string[];
			supersedes?: string[];
	  }
	| {
			type: "pattern";
			name: string;
			description: string;
			files?: string[];
			classification: MulchClassification;
			recorded_at: string;
			id?: string;
			tags?: string[];
			evidence?: MulchEvidence;
			outcomes?: MulchOutcome[];
			relates_to?: string[];
			supersedes?: string[];
	  }
	| {
			type: "failure";
			description: string;
			resolution: string;
			classification: MulchClassification;
			recorded_at: string;
			id?: string;
			tags?: string[];
			evidence?: MulchEvidence;
			outcomes?: MulchOutcome[];
			relates_to?: string[];
			supersedes?: string[];
	  }
	| {
			type: "decision";
			title: string;
			rationale: string;
			classification: MulchClassification;
			recorded_at: string;
			id?: string;
			tags?: string[];
			evidence?: MulchEvidence;
			outcomes?: MulchOutcome[];
			relates_to?: string[];
			supersedes?: string[];
	  }
	| {
			type: "reference";
			name: string;
			description: string;
			files?: string[];
			classification: MulchClassification;
			recorded_at: string;
			id?: string;
			tags?: string[];
			evidence?: MulchEvidence;
			outcomes?: MulchOutcome[];
			relates_to?: string[];
			supersedes?: string[];
	  }
	| {
			type: "guide";
			name: string;
			description: string;
			classification: MulchClassification;
			recorded_at: string;
			id?: string;
			tags?: string[];
			evidence?: MulchEvidence;
			outcomes?: MulchOutcome[];
			relates_to?: string[];
			supersedes?: string[];
	  };

/**
 * Interface for mulch programmatic API functions.
 * Uses a dynamic import with a variable specifier so tsc cannot statically
 * resolve the module (avoiding type errors in mulch's raw .ts source files).
 */
interface MulchProgrammaticApi {
	recordExpertise(
		domain: string,
		record: MulchExpertiseRecord,
		options?: { force?: boolean; cwd?: string },
	): Promise<{ action: "created" | "updated" | "skipped"; record: MulchExpertiseRecord }>;
	searchExpertise(
		query: string,
		options?: {
			domain?: string;
			type?: string;
			tag?: string;
			classification?: string;
			outcomeStatus?: "success" | "failure";
			sortByScore?: boolean;
			file?: string;
			cwd?: string;
		},
	): Promise<Array<{ domain: string; records: MulchExpertiseRecord[] }>>;
	queryDomain(
		domain: string,
		options?: { type?: string; classification?: string; file?: string; cwd?: string },
	): Promise<MulchExpertiseRecord[]>;
	appendOutcome(
		domain: string,
		id: string,
		outcome: {
			status: "success" | "failure" | "partial";
			agent?: string;
			notes?: string;
			duration?: number;
			recorded_at?: string;
		},
		options?: { cwd?: string },
	): Promise<{
		record: MulchExpertiseRecord;
		outcome: { status: string; agent?: string; notes?: string; recorded_at?: string };
		total_outcomes: number;
	}>;
}

const MULCH_PKG = "@os-eco/mulch-cli";
let _mulchApi: MulchProgrammaticApi | undefined;

async function loadMulchApi(): Promise<MulchProgrammaticApi> {
	if (!_mulchApi) {
		_mulchApi = (await import(MULCH_PKG)) as MulchProgrammaticApi;
	}
	return _mulchApi;
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
 * Build an ExpertiseRecord from record() options.
 *
 * CRITICAL MAPPING: --description maps to record.content for convention records,
 * but to record.description for all other types.
 */
function buildExpertiseRecord(options: {
	type: string;
	name?: string;
	description?: string;
	title?: string;
	rationale?: string;
	tags?: string[];
	classification?: string;
	evidenceBead?: string;
	outcomeStatus?: "success" | "failure" | "partial";
	outcomeDuration?: number;
	outcomeTestResults?: string;
	outcomeAgent?: string;
}): MulchExpertiseRecord {
	const base = {
		classification: (options.classification ?? "tactical") as
			| "foundational"
			| "tactical"
			| "observational",
		recorded_at: new Date().toISOString(),
		tags: options.tags,
		evidence: options.evidenceBead ? { bead: options.evidenceBead } : undefined,
		outcomes: options.outcomeStatus
			? [
					{
						status: options.outcomeStatus,
						duration: options.outcomeDuration,
						test_results: options.outcomeTestResults,
						agent: options.outcomeAgent,
						recorded_at: new Date().toISOString(),
					},
				]
			: undefined,
	};

	switch (options.type) {
		case "convention":
			return { ...base, type: "convention", content: options.description ?? "" };
		case "pattern":
			return {
				...base,
				type: "pattern",
				name: options.name ?? "",
				description: options.description ?? "",
			};
		case "failure":
			return {
				...base,
				type: "failure",
				description: options.description ?? "",
				resolution: "",
			};
		case "decision":
			return {
				...base,
				type: "decision",
				title: options.title ?? "",
				rationale: options.rationale ?? "",
			};
		case "reference":
			return {
				...base,
				type: "reference",
				name: options.name ?? "",
				description: options.description ?? "",
			};
		case "guide":
			return {
				...base,
				type: "guide",
				name: options.name ?? "",
				description: options.description ?? "",
			};
		default:
			return {
				...base,
				type: "convention",
				content: options.description ?? "",
			} as MulchExpertiseRecord;
	}
}

/**
 * Format search/query results as a plain string for callers that expect string output.
 * Preserves behavior for parseConflictPatterns regex in resolver.ts.
 */
function formatSearchResults(
	results: Array<{ domain: string; records: MulchExpertiseRecord[] }>,
): string {
	const lines: string[] = [];
	for (const result of results) {
		for (const record of result.records) {
			lines.push(formatRecordText(record));
		}
	}
	return lines.join("\n");
}

function formatRecordText(record: MulchExpertiseRecord): string {
	switch (record.type) {
		case "convention":
			return record.content;
		case "pattern":
			return record.description;
		case "failure":
			return record.description;
		case "decision":
			return `${record.title}: ${record.rationale}`;
		case "reference":
			return record.description;
		case "guide":
			return record.description;
	}
}

/**
 * Create a MulchClient bound to the given working directory.
 *
 * @param cwd - Working directory where mulch commands should run
 * @returns A MulchClient instance wrapping the mulch CLI
 */
export function createMulchClient(cwd: string): MulchClient {
	async function runMulch(
		args: string[],
		context: string,
	): Promise<{ stdout: string; stderr: string }> {
		const { stdout, stderr, exitCode } = await runCommand(["ml", ...args], cwd);
		if (exitCode !== 0) {
			throw new AgentError(`mulch ${context} failed (exit ${exitCode}): ${stderr.trim()}`);
		}
		return { stdout, stderr };
	}

	return {
		async prime(domains, format, options) {
			const args = ["prime"];
			if (domains && domains.length > 0) {
				args.push(...domains);
			}
			if (format) {
				args.push("--format", format);
			}
			if (options?.files && options.files.length > 0) {
				args.push("--files", ...options.files);
			}
			if (options?.excludeDomain && options.excludeDomain.length > 0) {
				args.push("--exclude-domain", ...options.excludeDomain);
			}
			if (options?.sortByScore) {
				args.push("--sort-by-score");
			}
			const { stdout } = await runMulch(args, "prime");
			return stdout;
		},

		async status() {
			const { stdout } = await runMulch(["status", "--json"], "status");
			const trimmed = stdout.trim();
			if (trimmed === "") {
				return { domains: [] };
			}
			try {
				return JSON.parse(trimmed) as MulchStatus;
			} catch {
				throw new AgentError(
					`Failed to parse JSON output from mulch status: ${trimmed.slice(0, 200)}`,
				);
			}
		},

		async record(domain, options) {
			// stdin mode: no programmatic API equivalent, fall back to CLI
			if (options.stdin) {
				const args = ["record", domain, "--type", options.type];
				if (options.description) args.push("--description", options.description);
				args.push("--stdin");
				await runMulch(args, `record ${domain}`);
				return;
			}

			const expertiseRecord = buildExpertiseRecord(options);
			const api = await loadMulchApi();
			try {
				await api.recordExpertise(domain, expertiseRecord, { cwd });
			} catch (error) {
				if (error instanceof Error && error.message.includes("not found in config")) {
					// Auto-create domain (matching mulch CLI 0.6.1+ behavior)
					await runMulch(["add", domain], `add ${domain}`);
					await api.recordExpertise(domain, expertiseRecord, { cwd });
				} else {
					throw new AgentError(
						`mulch record ${domain} failed: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			}
		},

		async query(domain) {
			if (!domain) {
				throw new AgentError("mulch query failed (exit 1): domain argument required");
			}
			try {
				const api = await loadMulchApi();
				const records = await api.queryDomain(domain, { cwd });
				return formatSearchResults([{ domain, records }]);
			} catch (error) {
				throw new AgentError(
					`mulch query failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		},

		async search(query, options) {
			try {
				const api = await loadMulchApi();
				const results = await api.searchExpertise(query, {
					file: options?.file,
					classification: options?.classification,
					outcomeStatus: options?.outcomeStatus,
					sortByScore: options?.sortByScore,
					cwd,
				});
				return formatSearchResults(results);
			} catch (error) {
				throw new AgentError(
					`mulch search failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		},

		async diff(options) {
			const args = ["diff", "--json"];
			if (options?.since) {
				args.push("--since", options.since);
			}
			const { stdout } = await runMulch(args, "diff");
			const trimmed = stdout.trim();
			try {
				return JSON.parse(trimmed) as MulchDiffResult;
			} catch {
				throw new AgentError(`Failed to parse JSON from mulch diff: ${trimmed.slice(0, 200)}`);
			}
		},

		async learn(options) {
			const args = ["learn", "--json"];
			if (options?.since) {
				args.push("--since", options.since);
			}
			const { stdout } = await runMulch(args, "learn");
			const trimmed = stdout.trim();
			try {
				return JSON.parse(trimmed) as MulchLearnResult;
			} catch {
				throw new AgentError(`Failed to parse JSON from mulch learn: ${trimmed.slice(0, 200)}`);
			}
		},

		async prune(options) {
			const args = ["prune", "--json"];
			if (options?.dryRun) {
				args.push("--dry-run");
			}
			const { stdout } = await runMulch(args, "prune");
			const trimmed = stdout.trim();
			try {
				return JSON.parse(trimmed) as MulchPruneResult;
			} catch {
				throw new AgentError(`Failed to parse JSON from mulch prune: ${trimmed.slice(0, 200)}`);
			}
		},

		async doctor(options) {
			const args = ["doctor", "--json"];
			if (options?.fix) {
				args.push("--fix");
			}
			const { stdout } = await runMulch(args, "doctor");
			const trimmed = stdout.trim();
			try {
				return JSON.parse(trimmed) as MulchDoctorResult;
			} catch {
				throw new AgentError(`Failed to parse JSON from mulch doctor: ${trimmed.slice(0, 200)}`);
			}
		},

		async ready(options) {
			const args = ["ready", "--json"];
			if (options?.limit !== undefined) {
				args.push("--limit", String(options.limit));
			}
			if (options?.domain) {
				args.push("--domain", options.domain);
			}
			if (options?.since) {
				args.push("--since", options.since);
			}
			const { stdout } = await runMulch(args, "ready");
			const trimmed = stdout.trim();
			try {
				return JSON.parse(trimmed) as MulchReadyResult;
			} catch {
				throw new AgentError(`Failed to parse JSON from mulch ready: ${trimmed.slice(0, 200)}`);
			}
		},

		async compact(domain, options) {
			const args = ["compact", "--json"];
			if (domain) {
				args.push(domain);
			}
			if (options?.analyze) {
				args.push("--analyze");
			}
			if (options?.apply) {
				args.push("--apply");
			}
			if (options?.auto) {
				args.push("--auto");
			}
			if (options?.dryRun) {
				args.push("--dry-run");
			}
			if (options?.minGroup !== undefined) {
				args.push("--min-group", String(options.minGroup));
			}
			if (options?.maxRecords !== undefined) {
				args.push("--max-records", String(options.maxRecords));
			}
			if (options?.yes) {
				args.push("--yes");
			}
			if (options?.records && options.records.length > 0) {
				args.push("--records", options.records.join(","));
			}
			const { stdout } = await runMulch(args, domain ? `compact ${domain}` : "compact");
			const trimmed = stdout.trim();
			try {
				return JSON.parse(trimmed) as MulchCompactResult;
			} catch {
				throw new AgentError(`Failed to parse JSON from mulch compact: ${trimmed.slice(0, 200)}`);
			}
		},

		async appendOutcome(domain, id, outcome) {
			const api = await loadMulchApi();
			try {
				await api.appendOutcome(
					domain,
					id,
					{ ...outcome, recorded_at: new Date().toISOString() },
					{ cwd },
				);
			} catch (error) {
				throw new AgentError(
					`mulch appendOutcome ${domain}/${id} failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		},
	};
}

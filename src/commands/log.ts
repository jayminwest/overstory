/**
 * CLI command: overstory log <event> --agent <name> [--stdin]
 *
 * Called by Pre/PostToolUse and Stop hooks.
 * Events: tool-start, tool-end, session-end.
 * Writes to .overstory/logs/{agent-name}/{session-timestamp}/.
 *
 * When --stdin is passed, reads one line of JSON from stdin containing the full
 * hook payload (tool_name, tool_input, transcript_path, session_id, etc.)
 * and writes structured events to the EventStore for observability.
 */

import { join } from "node:path";
import { updateIdentity } from "../agents/identity.ts";
import { loadConfig } from "../config.ts";
import { ValidationError } from "../errors.ts";
import { createEventStore } from "../events/store.ts";
import { filterToolArgs } from "../events/tool-filter.ts";
import { analyzeSessionInsights } from "../insights/analyzer.ts";
import { createLogger } from "../logging/logger.ts";
import { createMailClient } from "../mail/client.ts";
import { createMailStore } from "../mail/store.ts";
import { createMetricsStore } from "../metrics/store.ts";
import { estimateCost, parseTranscriptUsage } from "../metrics/transcript.ts";
import { createMulchClient, type MulchClient } from "../mulch/client.ts";
import { openSessionStore } from "../sessions/compat.ts";
import type { AgentSession } from "../types.ts";

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
 * Get or create a session timestamp directory for the agent.
 * Uses a file-based marker to track the current session directory.
 */
async function getSessionDir(logsBase: string, agentName: string): Promise<string> {
	const agentLogsDir = join(logsBase, agentName);
	const markerPath = join(agentLogsDir, ".current-session");

	const markerFile = Bun.file(markerPath);
	if (await markerFile.exists()) {
		const sessionDir = (await markerFile.text()).trim();
		if (sessionDir.length > 0) {
			return sessionDir;
		}
	}

	// Create a new session directory
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	const sessionDir = join(agentLogsDir, timestamp);
	const { mkdir } = await import("node:fs/promises");
	await mkdir(sessionDir, { recursive: true });
	await Bun.write(markerPath, sessionDir);
	return sessionDir;
}

/**
 * Update the lastActivity timestamp for an agent in the SessionStore.
 * Non-fatal: silently ignores errors to avoid breaking hook execution.
 */
function updateLastActivity(projectRoot: string, agentName: string): void {
	try {
		const overstoryDir = join(projectRoot, ".overstory");
		const { store } = openSessionStore(overstoryDir);
		try {
			const session = store.getByName(agentName);
			if (session) {
				store.updateLastActivity(agentName);
				if (session.state === "booting") {
					store.updateState(agentName, "working");
				}
			}
		} finally {
			store.close();
		}
	} catch {
		// Non-fatal: don't break logging if session update fails
	}
}

/**
 * Agent capabilities that run as persistent interactive sessions.
 * The Stop hook fires every turn for these agents (not just at session end),
 * so they must NOT auto-transition to 'completed' on session-end events.
 */
const PERSISTENT_CAPABILITIES = new Set(["coordinator", "monitor"]);

/**
 * Transition agent state to 'completed' in the SessionStore.
 * Called when session-end event fires.
 *
 * Skips the transition for persistent agent types (coordinator, monitor)
 * whose Stop hook fires every turn, not just at true session end.
 *
 * Non-fatal: silently ignores errors to avoid breaking hook execution.
 */
function transitionToCompleted(projectRoot: string, agentName: string): void {
	try {
		const overstoryDir = join(projectRoot, ".overstory");
		const { store } = openSessionStore(overstoryDir);
		try {
			const session = store.getByName(agentName);
			if (session && PERSISTENT_CAPABILITIES.has(session.capability)) {
				// Persistent agents: only update activity, don't mark completed
				store.updateLastActivity(agentName);
				return;
			}
			store.updateState(agentName, "completed");
			store.updateLastActivity(agentName);
		} finally {
			store.close();
		}
	} catch {
		// Non-fatal: don't break logging if session update fails
	}
}

/**
 * Look up an agent's session record.
 * Returns null if not found.
 */
function getAgentSession(projectRoot: string, agentName: string): AgentSession | null {
	try {
		const overstoryDir = join(projectRoot, ".overstory");
		const { store } = openSessionStore(overstoryDir);
		try {
			return store.getByName(agentName);
		} finally {
			store.close();
		}
	} catch {
		return null;
	}
}

/**
 * Read one line of JSON from stdin. Returns parsed object or null on failure.
 * Used when --stdin flag is present to receive hook payload from Claude Code.
 */
async function readStdinJson(): Promise<Record<string, unknown> | null> {
	try {
		const reader = Bun.stdin.stream().getReader();
		const { value } = await reader.read();
		reader.releaseLock();
		if (!value) return null;
		const text = new TextDecoder().decode(value).trim();
		if (text.length === 0) return null;
		return JSON.parse(text) as Record<string, unknown>;
	} catch {
		return null;
	}
}

/**
 * Resolve the path to a Claude Code transcript JSONL file.
 * Tries direct construction first, then searches all project directories.
 * Caches the found path for faster subsequent lookups.
 */
async function resolveTranscriptPath(
	projectRoot: string,
	sessionId: string,
	logsBase: string,
	agentName: string,
): Promise<string | null> {
	// Check cached path first
	const cachePath = join(logsBase, agentName, ".transcript-path");
	const cacheFile = Bun.file(cachePath);
	if (await cacheFile.exists()) {
		const cached = (await cacheFile.text()).trim();
		if (cached.length > 0 && (await Bun.file(cached).exists())) {
			return cached;
		}
	}

	const homeDir = process.env.HOME ?? "";
	const claudeProjectsDir = join(homeDir, ".claude", "projects");

	// Try direct construction from project root
	const projectKey = projectRoot.replace(/\//g, "-");
	const directPath = join(claudeProjectsDir, projectKey, `${sessionId}.jsonl`);
	if (await Bun.file(directPath).exists()) {
		await Bun.write(cachePath, directPath);
		return directPath;
	}

	// Search all project directories for the session file
	const { readdir } = await import("node:fs/promises");
	try {
		const projects = await readdir(claudeProjectsDir);
		for (const project of projects) {
			const candidate = join(claudeProjectsDir, project, `${sessionId}.jsonl`);
			if (await Bun.file(candidate).exists()) {
				await Bun.write(cachePath, candidate);
				return candidate;
			}
		}
	} catch {
		// Claude projects dir may not exist
	}

	return null;
}

/**
 * Auto-record expertise from mulch learn results.
 * Called during session-end for non-persistent agents.
 * Records a reference entry for each suggested domain at the canonical root,
 * then sends a slim notification mail to the parent agent.
 *
 * @returns List of successfully recorded domains
 */
export async function autoRecordExpertise(params: {
	mulchClient: MulchClient;
	agentName: string;
	capability: string;
	beadId: string | null;
	mailDbPath: string;
	parentAgent: string | null;
	projectRoot: string;
	sessionStartedAt: string;
}): Promise<string[]> {
	const learnResult = await params.mulchClient.learn({ since: "HEAD~1" });
	if (learnResult.suggestedDomains.length === 0) {
		return [];
	}

	const recordedDomains: string[] = [];
	const filesList = learnResult.changedFiles.join(", ");

	for (const domain of learnResult.suggestedDomains) {
		try {
			await params.mulchClient.record(domain, {
				type: "reference",
				description: `${params.capability} agent ${params.agentName} completed work in this domain. Files: ${filesList}`,
				tags: ["auto-session-end", params.capability],
				evidenceBead: params.beadId ?? undefined,
			});
			recordedDomains.push(domain);
		} catch {
			// Non-fatal per domain: skip failed records
		}
	}

	// Analyze session events for deeper insights (tool usage, file edits, errors)
	let insightSummary = "";
	try {
		const eventsDbPath = join(params.projectRoot, ".overstory", "events.db");
		const eventStore = createEventStore(eventsDbPath);

		const events = eventStore.getByAgent(params.agentName, {
			since: params.sessionStartedAt,
		});
		const toolStats = eventStore.getToolStats({
			agentName: params.agentName,
			since: params.sessionStartedAt,
		});

		eventStore.close();

		const analysis = analyzeSessionInsights({
			events,
			toolStats,
			agentName: params.agentName,
			capability: params.capability,
			domains: learnResult.suggestedDomains,
		});

		// Record each insight to mulch
		for (const insight of analysis.insights) {
			try {
				await params.mulchClient.record(insight.domain, {
					type: insight.type,
					description: insight.description,
					tags: insight.tags,
					evidenceBead: params.beadId ?? undefined,
				});
				if (!recordedDomains.includes(insight.domain)) {
					recordedDomains.push(insight.domain);
				}
			} catch {
				// Non-fatal per insight: skip failed records
			}
		}

		// Build insight summary for mail
		if (analysis.insights.length > 0) {
			const insightTypes = new Map<string, number>();
			for (const insight of analysis.insights) {
				const count = insightTypes.get(insight.type) ?? 0;
				insightTypes.set(insight.type, count + 1);
			}
			const typeCounts = Array.from(insightTypes.entries())
				.map(([type, count]) => `${count} ${type}`)
				.join(", ");
			insightSummary = `\n\nAuto-insights: ${typeCounts} (${analysis.toolProfile.totalToolCalls} tool calls, ${analysis.fileProfile.totalEdits} edits)`;
		}
	} catch {
		// Non-fatal: insight analysis should not break session-end handling
	}

	if (recordedDomains.length > 0) {
		const mailStore = createMailStore(params.mailDbPath);
		const mailClient = createMailClient(mailStore);
		const recipient = params.parentAgent ?? "orchestrator";
		const domainsList = recordedDomains.join(", ");
		mailClient.send({
			from: params.agentName,
			to: recipient,
			subject: `mulch: auto-recorded insights in ${domainsList}`,
			body: `Session completed. Auto-recorded expertise in: ${domainsList}.\n\nChanged files: ${filesList}${insightSummary}`,
			type: "status",
			priority: "low",
		});
		mailClient.close();
	}

	return recordedDomains;
}

/**
 * Entry point for `overstory log <event> --agent <name>`.
 */
const LOG_HELP = `overstory log — Log a hook event

Usage: overstory log <event> --agent <name> [--stdin]

Arguments:
  <event>            Event type: tool-start, tool-end, session-end

Options:
  --agent <name>            Agent name (required)
  --tool-name <name>        Tool name (for tool-start/tool-end events, legacy)
  --transcript <path>       Path to Claude Code transcript JSONL (for session-end, legacy)
  --stdin                   Read hook payload JSON from stdin (preferred)
  --help, -h                Show this help`;

export async function logCommand(args: string[]): Promise<void> {
	if (args.includes("--help") || args.includes("-h")) {
		process.stdout.write(`${LOG_HELP}\n`);
		return;
	}

	const event = args.find((a) => !a.startsWith("--"));
	const agentName = getFlag(args, "--agent");
	const useStdin = args.includes("--stdin");
	const toolNameFlag = getFlag(args, "--tool-name") ?? "unknown";
	const transcriptPathFlag = getFlag(args, "--transcript");

	if (!event) {
		throw new ValidationError("Event is required: overstory log <event> --agent <name>", {
			field: "event",
		});
	}

	const validEvents = ["tool-start", "tool-end", "session-end"];
	if (!validEvents.includes(event)) {
		throw new ValidationError(`Invalid event "${event}". Valid: ${validEvents.join(", ")}`, {
			field: "event",
			value: event,
		});
	}

	if (!agentName) {
		throw new ValidationError("--agent is required for log command", {
			field: "agent",
		});
	}

	// Read stdin payload if --stdin flag is set
	let stdinPayload: Record<string, unknown> | null = null;
	if (useStdin) {
		stdinPayload = await readStdinJson();
	}

	// Extract fields from stdin payload (preferred) or fall back to flags
	const toolName =
		typeof stdinPayload?.tool_name === "string" ? stdinPayload.tool_name : toolNameFlag;
	const toolInput =
		stdinPayload?.tool_input !== undefined &&
		stdinPayload?.tool_input !== null &&
		typeof stdinPayload.tool_input === "object"
			? (stdinPayload.tool_input as Record<string, unknown>)
			: null;
	const sessionId = typeof stdinPayload?.session_id === "string" ? stdinPayload.session_id : null;
	const transcriptPath =
		typeof stdinPayload?.transcript_path === "string"
			? stdinPayload.transcript_path
			: transcriptPathFlag;

	const cwd = process.cwd();
	const config = await loadConfig(cwd);
	const logsBase = join(config.project.root, ".overstory", "logs");
	const sessionDir = await getSessionDir(logsBase, agentName);

	const logger = createLogger({
		logDir: sessionDir,
		agentName,
		verbose: config.logging.verbose,
		redactSecrets: config.logging.redactSecrets,
	});

	switch (event) {
		case "tool-start": {
			// Backward compatibility: always write to per-agent log files
			logger.toolStart(toolName, toolInput ?? {});
			updateLastActivity(config.project.root, agentName);

			// When --stdin is used, also write to EventStore for structured observability
			if (useStdin) {
				try {
					const eventsDbPath = join(config.project.root, ".overstory", "events.db");
					const eventStore = createEventStore(eventsDbPath);
					const filtered = toolInput
						? filterToolArgs(toolName, toolInput)
						: { args: {}, summary: toolName };
					eventStore.insert({
						runId: null,
						agentName,
						sessionId,
						eventType: "tool_start",
						toolName,
						toolArgs: JSON.stringify(filtered.args),
						toolDurationMs: null,
						level: "info",
						data: JSON.stringify({ summary: filtered.summary }),
					});
					eventStore.close();
				} catch {
					// Non-fatal: EventStore write should not break hook execution
				}
			}
			break;
		}
		case "tool-end": {
			// Backward compatibility: always write to per-agent log files
			logger.toolEnd(toolName, 0);
			updateLastActivity(config.project.root, agentName);

			// When --stdin is used, write to EventStore and correlate with tool-start
			if (useStdin) {
				try {
					const eventsDbPath = join(config.project.root, ".overstory", "events.db");
					const eventStore = createEventStore(eventsDbPath);
					const filtered = toolInput
						? filterToolArgs(toolName, toolInput)
						: { args: {}, summary: toolName };
					eventStore.insert({
						runId: null,
						agentName,
						sessionId,
						eventType: "tool_end",
						toolName,
						toolArgs: JSON.stringify(filtered.args),
						toolDurationMs: null,
						level: "info",
						data: JSON.stringify({ summary: filtered.summary }),
					});
					const correlation = eventStore.correlateToolEnd(agentName, toolName);
					if (correlation) {
						logger.toolEnd(toolName, correlation.durationMs);
					}
					eventStore.close();
				} catch {
					// Non-fatal: EventStore write should not break hook execution
				}

				// Throttled token snapshot recording
				if (sessionId) {
					try {
						// Throttle check
						const snapshotMarkerPath = join(logsBase, agentName, ".last-snapshot");
						const SNAPSHOT_INTERVAL_MS = 30_000;
						const snapshotMarkerFile = Bun.file(snapshotMarkerPath);
						let shouldSnapshot = true;

						if (await snapshotMarkerFile.exists()) {
							const lastTs = Number.parseInt(await snapshotMarkerFile.text(), 10);
							if (!Number.isNaN(lastTs) && Date.now() - lastTs < SNAPSHOT_INTERVAL_MS) {
								shouldSnapshot = false;
							}
						}

						if (shouldSnapshot) {
							const transcriptPath = await resolveTranscriptPath(
								config.project.root,
								sessionId,
								logsBase,
								agentName,
							);
							if (transcriptPath) {
								const usage = await parseTranscriptUsage(transcriptPath);
								const cost = estimateCost(usage);
								const metricsDbPath = join(config.project.root, ".overstory", "metrics.db");
								const metricsStore = createMetricsStore(metricsDbPath);
								metricsStore.recordSnapshot({
									agentName,
									inputTokens: usage.inputTokens,
									outputTokens: usage.outputTokens,
									cacheReadTokens: usage.cacheReadTokens,
									cacheCreationTokens: usage.cacheCreationTokens,
									estimatedCostUsd: cost,
									modelUsed: usage.modelUsed,
									createdAt: new Date().toISOString(),
								});
								metricsStore.close();
								await Bun.write(snapshotMarkerPath, String(Date.now()));
							}
						}
					} catch {
						// Non-fatal: snapshot recording should not break tool-end handling
					}
				}
			}
			break;
		}
		case "session-end":
			logger.info("session.end", { agentName });
			// Transition agent state to completed
			transitionToCompleted(config.project.root, agentName);
			// Look up agent session for identity update and metrics recording
			{
				const agentSession = getAgentSession(config.project.root, agentName);
				const beadId = agentSession?.beadId ?? null;

				// Update agent identity with completed session
				const identityBaseDir = join(config.project.root, ".overstory", "agents");
				try {
					await updateIdentity(identityBaseDir, agentName, {
						sessionsCompleted: 1,
						completedTask: beadId ? { beadId, summary: `Completed task ${beadId}` } : undefined,
					});
				} catch {
					// Non-fatal: identity may not exist for this agent
				}

				// Auto-nudge coordinator when a lead completes so it wakes up
				// to process merge_ready / worker_done messages without waiting
				// for user input (see decision mx-728f8d).
				if (agentSession?.capability === "lead") {
					try {
						const nudgesDir = join(config.project.root, ".overstory", "pending-nudges");
						const { mkdir } = await import("node:fs/promises");
						await mkdir(nudgesDir, { recursive: true });
						const markerPath = join(nudgesDir, "coordinator.json");
						const marker = {
							from: agentName,
							reason: "lead_completed",
							subject: `Lead ${agentName} completed — check mail for merge_ready/worker_done`,
							messageId: `auto-nudge-${agentName}-${Date.now()}`,
							createdAt: new Date().toISOString(),
						};
						await Bun.write(markerPath, `${JSON.stringify(marker, null, "\t")}\n`);
					} catch {
						// Non-fatal: nudge failure should not break session-end
					}
				}

				// Record session metrics (with optional token data from transcript)
				if (agentSession) {
					try {
						const metricsDbPath = join(config.project.root, ".overstory", "metrics.db");
						const metricsStore = createMetricsStore(metricsDbPath);
						const now = new Date().toISOString();
						const durationMs = new Date(now).getTime() - new Date(agentSession.startedAt).getTime();

						// Parse token usage from transcript if path provided
						let inputTokens = 0;
						let outputTokens = 0;
						let cacheReadTokens = 0;
						let cacheCreationTokens = 0;
						let estimatedCostUsd: number | null = null;
						let modelUsed: string | null = null;

						if (transcriptPath) {
							try {
								const usage = await parseTranscriptUsage(transcriptPath);
								inputTokens = usage.inputTokens;
								outputTokens = usage.outputTokens;
								cacheReadTokens = usage.cacheReadTokens;
								cacheCreationTokens = usage.cacheCreationTokens;
								modelUsed = usage.modelUsed;
								estimatedCostUsd = estimateCost(usage);
							} catch {
								// Non-fatal: transcript parsing should not break metrics
							}
						}

						metricsStore.recordSession({
							agentName,
							beadId: agentSession.beadId,
							capability: agentSession.capability,
							startedAt: agentSession.startedAt,
							completedAt: now,
							durationMs,
							exitCode: null,
							mergeResult: null,
							parentAgent: agentSession.parentAgent,
							inputTokens,
							outputTokens,
							cacheReadTokens,
							cacheCreationTokens,
							estimatedCostUsd,
							modelUsed,
						});
						metricsStore.close();
					} catch {
						// Non-fatal: metrics recording should not break session-end handling
					}

					// Auto-record expertise via mulch learn + record (post-session).
					// Skip persistent agents whose Stop hook fires every turn.
					if (!PERSISTENT_CAPABILITIES.has(agentSession.capability)) {
						try {
							const mulchClient = createMulchClient(config.project.root);
							const mailDbPath = join(config.project.root, ".overstory", "mail.db");
							await autoRecordExpertise({
								mulchClient,
								agentName,
								capability: agentSession.capability,
								beadId,
								mailDbPath,
								parentAgent: agentSession.parentAgent,
								projectRoot: config.project.root,
								sessionStartedAt: agentSession.startedAt,
							});
						} catch {
							// Non-fatal: mulch learn/record should not break session-end handling
						}
					}
				}

				// Write session-end event to EventStore when --stdin is used
				if (useStdin) {
					try {
						const eventsDbPath = join(config.project.root, ".overstory", "events.db");
						const eventStore = createEventStore(eventsDbPath);
						eventStore.insert({
							runId: null,
							agentName,
							sessionId,
							eventType: "session_end",
							toolName: null,
							toolArgs: null,
							toolDurationMs: null,
							level: "info",
							data: transcriptPath ? JSON.stringify({ transcriptPath }) : null,
						});
						eventStore.close();
					} catch {
						// Non-fatal: EventStore write should not break session-end
					}
				}
			}
			// Clear the current session marker
			{
				const markerPath = join(logsBase, agentName, ".current-session");
				try {
					const { unlink } = await import("node:fs/promises");
					await unlink(markerPath);
				} catch {
					// Marker may not exist
				}
			}
			break;
	}

	logger.close();
}

/**
 * Helpers for dispatching user turns through `runTurn` (Phase 2 spawn-per-turn).
 *
 * `runTurn` (src/agents/turn-runner.ts) needs ~12 inputs to drive one builder
 * turn. Most of those derive from the agent's `AgentSession` row plus
 * project-level paths. Consumers that route mail or nudges through the
 * spawn-per-turn engine — `ov serve`, `ov nudge` — need the same setup
 * boilerplate, so it lives here.
 *
 * The exported `buildRunTurnOptsFactory()` resolves the runtime adapter and
 * model once per agent and returns a `(userTurnNdjson) => RunTurnOpts`
 * closure. The closure is small and disposable; callers re-resolve it when
 * the underlying session metadata changes (e.g. on rescan).
 */

import { join } from "node:path";
import { getRuntime } from "../runtimes/registry.ts";
import type { AgentRuntime } from "../runtimes/types.ts";
import type { AgentManifest, AgentSession, OverstoryConfig, ResolvedModel } from "../types.ts";
import { resolveModel } from "./manifest.ts";
import type { RunTurnOpts } from "./turn-runner.ts";

export interface BuildOptsFactoryInput {
	session: AgentSession;
	config: OverstoryConfig;
	manifest: AgentManifest;
	overstoryDir: string;
	/** Optional override (test injection). Defaults to `getRuntime`. */
	_getRuntime?: typeof getRuntime;
	/** Optional override (test injection). Defaults to `resolveModel`. */
	_resolveModel?: typeof resolveModel;
}

export interface BuiltOptsFactory {
	runtime: AgentRuntime;
	resolvedModel: ResolvedModel;
	/** Produces a fresh `RunTurnOpts` for the given user turn payload. */
	build: (userTurnNdjson: string) => RunTurnOpts;
}

/**
 * Resolve runtime + model for a session and return a factory that produces
 * `RunTurnOpts` given a user-turn NDJSON payload.
 *
 * The factory closes over the per-agent metadata (worktreePath, capability,
 * runId, etc.) so callers only have to supply the dynamic payload. The
 * factory's outputs are otherwise identical run-to-run.
 */
export function buildRunTurnOptsFactory(input: BuildOptsFactoryInput): BuiltOptsFactory {
	const { session, config, manifest, overstoryDir } = input;
	const _getRuntime = input._getRuntime ?? getRuntime;
	const _resolveModel = input._resolveModel ?? resolveModel;

	const runtime = _getRuntime(undefined, config, session.capability);
	const fallback = manifest.agents[session.capability]?.model ?? "claude-sonnet";
	const resolvedModel = _resolveModel(config, manifest, session.capability, fallback);

	const mailDbPath = join(overstoryDir, "mail.db");
	const eventsDbPath = join(overstoryDir, "events.db");
	const sessionsDbPath = join(overstoryDir, "sessions.db");

	const build = (userTurnNdjson: string): RunTurnOpts => ({
		agentName: session.agentName,
		overstoryDir,
		worktreePath: session.worktreePath,
		projectRoot: config.project.root,
		taskId: session.taskId,
		userTurnNdjson,
		runtime,
		resolvedModel,
		runId: session.runId,
		mailDbPath,
		eventsDbPath,
		sessionsDbPath,
	});

	return { runtime, resolvedModel, build };
}

/**
 * Predicate: is this agent eligible for spawn-per-turn dispatch?
 *
 * Phase 2 capability gate: only builders with `runtime.claudeSpawnPerTurn`
 * enabled and a runtime that implements `buildDirectSpawn`/`parseEvents`
 * (today: claude). Non-terminal state required — completed/zombie sessions
 * are never re-spawned.
 */
export function isSpawnPerTurnAgent(
	session: AgentSession,
	config: OverstoryConfig,
	runtime: AgentRuntime,
): boolean {
	if (config.runtime?.claudeSpawnPerTurn !== true) return false;
	if (session.capability !== "builder") return false;
	if (session.state === "completed" || session.state === "zombie") return false;
	if (typeof runtime.buildDirectSpawn !== "function") return false;
	if (typeof runtime.parseEvents !== "function") return false;
	return true;
}

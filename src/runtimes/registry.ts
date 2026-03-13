// Runtime registry — maps runtime names to adapter factory functions.
// This is the ONLY module that imports concrete adapter classes.

import type { OverstoryConfig } from "../types.ts";
import { AiderRuntime } from "./aider.ts";
import { AmpRuntime } from "./amp.ts";
import { ClaudeRuntime } from "./claude.ts";
import { CodexRuntime } from "./codex.ts";
import { CopilotRuntime } from "./copilot.ts";
import { CursorRuntime } from "./cursor.ts";
import { GeminiRuntime } from "./gemini.ts";
import { GooseRuntime } from "./goose.ts";
import { OpenCodeRuntime } from "./opencode.ts";
import { PiRuntime } from "./pi.ts";
import { SaplingRuntime } from "./sapling.ts";
import type { AgentRuntime } from "./types.ts";

/** Registry of config-independent runtime adapters (name → factory). */
const runtimes = new Map<string, () => AgentRuntime>([
	["aider", () => new AiderRuntime()],
	["amp", () => new AmpRuntime()],
	["claude", () => new ClaudeRuntime()],
	["codex", () => new CodexRuntime()],
	["copilot", () => new CopilotRuntime()],
	["cursor", () => new CursorRuntime()],
	["gemini", () => new GeminiRuntime()],
	["goose", () => new GooseRuntime()],
	["opencode", () => new OpenCodeRuntime()],
	["pi", () => new PiRuntime()],
	["sapling", () => new SaplingRuntime()],
]);

/**
 * Return all registered runtime adapter instances.
 *
 * Used by callers that need to enumerate all runtimes (e.g. to build a
 * dynamic list of known instruction file paths from each runtime's
 * `instructionPath` property).
 *
 * @returns Array of one fresh instance per registered runtime.
 */
export function getAllRuntimes(): AgentRuntime[] {
	return [
		new AiderRuntime(),
		new AmpRuntime(),
		new ClaudeRuntime(),
		new CodexRuntime(),
		new CopilotRuntime(),
		new CursorRuntime(),
		new GeminiRuntime(),
		new GooseRuntime(),
		new OpenCodeRuntime(),
		new PiRuntime(),
		new SaplingRuntime(),
	];
}

/**
 * Resolve a runtime adapter by name.
 *
 * Lookup order:
 * 1. Explicit `name` argument (if provided)
 * 2. `config.runtime.capabilities[capability]` (if capability provided)
 * 3. `config.runtime.default` (if config is provided)
 * 4. `"claude"` (hardcoded fallback)
 *
 * Special cases:
 * - Pi runtime receives `config.runtime.pi` for model alias expansion.
 *
 * @param name - Runtime name to resolve (e.g. "claude"). Omit to use config default.
 * @param config - Overstory config for reading the default runtime.
 * @param capability - Agent capability (e.g. "coordinator", "builder") for per-capability routing.
 * @throws {Error} If the resolved runtime name is not registered.
 * @returns A fresh AgentRuntime instance.
 */
export function getRuntime(
	name?: string,
	config?: OverstoryConfig,
	capability?: string,
): AgentRuntime {
	const capabilityRuntime =
		capability && config?.runtime?.capabilities
			? config.runtime.capabilities[capability]
			: undefined;
	const runtimeName = name ?? capabilityRuntime ?? config?.runtime?.default ?? "claude";

	// Pi runtime needs config for model alias expansion.
	if (runtimeName === "pi") {
		return new PiRuntime(config?.runtime?.pi);
	}

	const factory = runtimes.get(runtimeName);
	if (!factory) {
		throw new Error(
			`Unknown runtime: "${runtimeName}". Available: ${[...runtimes.keys()].join(", ")}`,
		);
	}
	return factory();
}

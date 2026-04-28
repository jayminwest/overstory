/**
 * Regression test for overstory-6d42: bun test must not be redirectable to a
 * real .overstory/ via inherited OVERSTORY_PROJECT_ROOT (or sibling) env vars.
 *
 * The preload in bunfig.toml runs src/test-setup.ts before any test loads,
 * deleting OVERSTORY_* env vars and clearing the project-root override. By
 * the time this test executes, those values must already be gone — even if a
 * worker agent's environment had them set when bun test was invoked.
 */

import { expect, test } from "bun:test";
import { getProjectRootOverride } from "./config.ts";

const ENV_KEYS = [
	"OVERSTORY_PROJECT_ROOT",
	"OVERSTORY_AGENT_NAME",
	"OVERSTORY_WORKTREE_PATH",
	"OVERSTORY_TASK_ID",
	"OVERSTORY_PROFILE",
	"OVERSTORY_RUN_ID",
] as const;

for (const key of ENV_KEYS) {
	test(`${key} is unset by the test preload`, () => {
		expect(process.env[key]).toBeUndefined();
	});
}

test("project-root override is cleared by the test preload", () => {
	expect(getProjectRootOverride()).toBeUndefined();
});

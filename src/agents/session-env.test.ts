import { describe, expect, test } from "bun:test";
import { buildOverstorySessionEnv } from "./session-env.ts";

describe("buildOverstorySessionEnv", () => {
	test("sets all required fields", () => {
		expect(
			buildOverstorySessionEnv({
				sessionKind: "worker",
				agentName: "builder-1",
				capability: "builder",
				worktreePath: "/tmp/worktree",
				projectRoot: "/tmp/project",
			}),
		).toEqual({
			OVERSTORY_SESSION_KIND: "worker",
			OVERSTORY_AGENT_NAME: "builder-1",
			OVERSTORY_CAPABILITY: "builder",
			OVERSTORY_WORKTREE_PATH: "/tmp/worktree",
			OVERSTORY_PROJECT_ROOT: "/tmp/project",
		});
	});

	test("omits optional taskId and profile when undefined", () => {
		const env = buildOverstorySessionEnv({
			sessionKind: "monitor",
			agentName: "monitor",
			capability: "monitor",
			worktreePath: "/tmp/project",
			projectRoot: "/tmp/project",
		});

		expect(env.OVERSTORY_TASK_ID).toBeUndefined();
		expect(env.OVERSTORY_PROFILE).toBeUndefined();
	});

	test("includes optional taskId and profile when provided", () => {
		expect(
			buildOverstorySessionEnv({
				sessionKind: "supervisor",
				agentName: "supervisor-1",
				capability: "supervisor",
				worktreePath: "/tmp/project",
				projectRoot: "/tmp/project",
				taskId: "task-123",
				profile: "ov-delivery",
			}),
		).toMatchObject({
			OVERSTORY_SESSION_KIND: "supervisor",
			OVERSTORY_TASK_ID: "task-123",
			OVERSTORY_PROFILE: "ov-delivery",
		});
	});

	test("overstory keys override colliding baseEnv values", () => {
		expect(
			buildOverstorySessionEnv({
				baseEnv: {
					OVERSTORY_SESSION_KIND: "standalone",
					OVERSTORY_AGENT_NAME: "wrong",
					EXTRA_VAR: "kept",
				},
				sessionKind: "coordinator",
				agentName: "coordinator",
				capability: "coordinator",
				worktreePath: "/tmp/project",
				projectRoot: "/tmp/project",
			}),
		).toEqual({
			OVERSTORY_SESSION_KIND: "coordinator",
			OVERSTORY_AGENT_NAME: "coordinator",
			OVERSTORY_CAPABILITY: "coordinator",
			OVERSTORY_WORKTREE_PATH: "/tmp/project",
			OVERSTORY_PROJECT_ROOT: "/tmp/project",
			EXTRA_VAR: "kept",
		});
	});
});

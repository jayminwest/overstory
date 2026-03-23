import type { OverstorySessionEnvOpts } from "../types.ts";

export function buildOverstorySessionEnv(opts: OverstorySessionEnvOpts): Record<string, string> {
	return {
		...(opts.baseEnv ?? {}),
		OVERSTORY_SESSION_KIND: opts.sessionKind,
		OVERSTORY_AGENT_NAME: opts.agentName,
		OVERSTORY_CAPABILITY: opts.capability,
		OVERSTORY_WORKTREE_PATH: opts.worktreePath,
		OVERSTORY_PROJECT_ROOT: opts.projectRoot,
		...(opts.taskId !== undefined ? { OVERSTORY_TASK_ID: opts.taskId } : {}),
		...(opts.profile !== undefined ? { OVERSTORY_PROFILE: opts.profile } : {}),
	};
}

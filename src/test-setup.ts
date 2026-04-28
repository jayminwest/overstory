/**
 * Global test preload (referenced from bunfig.toml [test] preload).
 *
 * Prevents test runs from leaking into a real .overstory/ when bun test is
 * executed inside an agent worktree (where ov sling injects OVERSTORY_PROJECT_ROOT
 * into the spawned process — see src/commands/sling.ts:928).
 *
 * Without this preload, resolveProjectRoot() short-circuits to the env var
 * before consulting the per-test temp dir, so tests calling cleanCommand,
 * coordinatorCommand, mailCommand, etc. silently target the live project.
 * That's how overstory-6d42 contamination occurred: a worker agent ran
 * bun test, clean.test.ts wiped the live .overstory/, coordinator.test.ts
 * left dozens of bogus runs, and mail.test.ts inserted fixture messages.
 *
 * Tests that need OVERSTORY_PROJECT_ROOT set (e.g. config.test.ts) set it
 * explicitly inside the test body and restore it in afterEach.
 */

import { clearProjectRootOverride } from "./config.ts";

delete process.env.OVERSTORY_PROJECT_ROOT;
delete process.env.OVERSTORY_AGENT_NAME;
delete process.env.OVERSTORY_WORKTREE_PATH;
delete process.env.OVERSTORY_TASK_ID;
delete process.env.OVERSTORY_PROFILE;
delete process.env.OVERSTORY_RUN_ID;

clearProjectRootOverride();

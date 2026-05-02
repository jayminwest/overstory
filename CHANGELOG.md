# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.11.0] - 2026-05-02

### Added

#### Spawn-per-turn substates split (overstory-3087)
- **`in_turn` and `between_turns` AgentState variants** — split the legacy `working` state for spawn-per-turn workers so the UI distinguishes a worker actively executing a turn from one idling between mail batches. The turn-runner advances `between_turns → in_turn` on first parser event of a fresh turn and settles back `in_turn → between_turns` when the turn ends without a terminal mail. `working` remains the active state for tmux/long-lived headless capabilities (coordinator, orchestrator, monitor, sapling). Spawn-per-turn workers (builder/scout/reviewer/lead/merger under the headless default) transition through `in_turn ↔ between_turns` instead.
- **`migrateRelaxStateCheck`** — drops the SQLite inline `CHECK(state IN (...))` constraint on `sessions.state` so future state extensions don't require schema rebuilds. Detects the constraint via `sqlite_master.sql` and rebuilds the table inside a transaction (copy → drop → rename); idempotent. Type system enforces values at writer boundary.
- **`getActive()` widened** to return `booting | working | in_turn | between_turns | stalled` so watchdog/dashboards see spawn-per-turn workers as alive.
- **Transition matrix updated** — `in_turn` and `between_turns` cycle freely; both can advance forward to `stalled`/`zombie`/`completed`. Kept separate from the tmux/long-lived `working` rank — neither lists `working` as a predecessor.

#### Scope-violation detection + parallel sibling guidance (overstory-9f4d, overstory-f76a)
- **`src/agents/scope-detect.ts`** — soft, advisory detection of files modified outside the agent's declared FILE_SCOPE without an `expansion_reason:` justification. Builder/merger only (`IMPLEMENTATION_CAPABILITIES`); read-only roles (scout/reviewer/lead) are no-ops. Glob-aware (`Bun.Glob`) and supports literal scope entries. Pre-existing `scope_expansion`-prefixed status mail from the agent suppresses the warning. Observability only — never a hard block; all errors swallowed.
- **`ov sling --siblings <names>`** — comma-separated parallel sibling agent names. Renders a "Parallel Siblings" section into the overlay with rebase-before-`merge_ready` guidance so siblings working in adjacent files coordinate without conflict-amplification at merge time. `OverlayConfig.siblings` plumbed through sling → overlay generator → builder. `parseSiblings()` exported for unit tests.
- **`resolveParentAgent()`** — preserves the prior session's `parent_agent` on `ov sling --recover` when `--parent` is not explicitly passed. Pre-fix, the recover path overwrote `parentAgent` with null whenever a coordinator/lead invoked `ov sling --recover --name <existing>` without threading `--parent`, and the runner's in-band `worker_died` notify on a resumed-turn parser stall silently skipped — leaving the lead waiting forever.

#### Conflict prediction in `ov merge --dry-run` (overstory-inxu)
- **`src/merge/predict.ts`** — side-effect-free `predictConflicts()` using `git merge-tree --write-tree --merge-base=<base> <ours> <theirs>` to compute the conflict set without mutating HEAD, the working tree, or the merge lock. Each conflict file is classified into a predicted resolution tier by reusing the same primitives the live resolver uses (`hasContentfulCanonical`, `checkMergeUnion`), so prediction stays in lock step with how `ov merge` would actually behave. Requires git ≥ 2.38.
- **`ov merge --dry-run`** and **`ov merge --all --dry-run`** print the predicted tier, conflict files, and a short operator-readable reason. JSON output exposes the full `ConflictPrediction` envelope including `wouldRequireAgent` (true for ai-resolve / reimagine tiers) so a lead/operator/greenhouse can branch on agent-required vs auto-mergeable. Per-entry prediction failures are swallowed into a deterministic `ai-resolve` envelope so `--all --dry-run` keeps going.
- **`ConflictPrediction`** type added to `src/types.ts`.
- **Lead dispatch overlay** receives merge-prediction guidance so leads can sequence `merger` agents based on predicted tier.

#### Quality-gate outcome status threaded into mulch records
- **`src/insights/quality-gates.ts`** — `runQualityGates(gates, cwd)` runs each configured quality gate (test/lint/typecheck) at session-end and aggregates into `success` (all passed), `failure` (none passed), or `partial` (mixed). `hasWorkToVerify(worktreePath, baseRef)` cheap precheck lets read-only agents (scout/reviewer) skip gate execution entirely when no commits or uncommitted changes exist.
- **`autoRecordExpertise` and `appendOutcomeToAppliedRecords`** thread `outcomeStatus` into every session-end mulch record write so confirmation scoring reflects whether tests/lint/typecheck actually passed. The outcome appears in record `outcomes[].status` and as a `Quality gates: <status>` note on applied-record outcomes.

#### Bash mail-poll runtime backstop (overstory-c92c)
- **`src/agents/mail-poll-detect.ts`** — defense-in-depth detector for forbidden Bash mail-polling patterns. The lead.md prompt forbids the pattern (overstory-fa84) as the primary mitigation; this is the runtime backstop if a future overlay or contributed agent definition silently reintroduces it. Detects `until`/`while` loops where the condition references `ov mail check`/`ov mail list` (directly, negated with `!`, or wrapped in `[ "$(...)" ... ]`) and the body contains `sleep`. Bounded `for` loops are never classified — `for i in 1 2 3; do ov mail send ...; done` is a legitimate batched send. Warn-only via custom event surfaced in `ov logs`/`ov feed`/UI.

#### Worktree creation pre-check (overstory-6878)
- **`WorktreeManager` pre-check rejects creation when branch is already checked out** elsewhere in the repo. Pre-fix, `git worktree add` reported success but produced an unusable worktree at the contested branch.
- **Validates worktree creation before reporting success** — the manager confirms the worktree directory exists and is registered with git before returning.

#### Per-event runner stall recovery (overstory-8e61)
- **`lastActivity` refreshed inside the parser loop** on every event (throttled at `lastActivityRefreshIntervalMs`, default 2000ms) so a long turn doesn't appear stalled to the watchdog mid-flight. The watchdog at `src/watchdog/health.ts` documents its design as "the turn-runner updates lastActivity on every parser event during a turn, and the watchdog refreshes it from events.db between turns" — pre-fix, the runner only updated lastActivity at turn boundaries, so multi-minute turns were zombified despite live tool events.
- **`_onLastActivityRefresh` test injection hook** lets tests count refresh attempts directly rather than inferring from observable timestamps.

### Fixed

#### Coordinator + sling
- **`fix(coordinator)`: detect leftover watchdog before spawning (overstory-3f0c)** — coordinator startup now detects an orphaned watchdog from a prior run and aligns orphan-watchdog detection with the lead's spec, preventing duplicate watchdog daemons and the resulting double-zombie-classification storms.
- **`fix(sling)`: use slinger env var for auto-dispatch `from` field (overstory-235f)** — `--parent` describes the new agent's hierarchical parent, not the slinger; auto-dispatch mail now reads `OVERSTORY_AGENT_NAME` for the `from` field and falls back to `parentAgent` only when unset.
- **`fix(watchdog): never call tmux.killSession("") for headless agents`** — empty `tmux_session` (the spawn-per-turn convention; cleared on terminal transitions per overstory-14c0) no longer triggers a doomed `tmux kill-session ""` invocation that flooded stderr.
- **`fix(agents): forbid lead Bash mail polling, document spawn-per-turn turn boundary (overstory-fa84)`** — lead.md updated; the lead capability does not have a "wait for mail" loop because spawn-per-turn means the lead exits between turns and is re-spawned by the mail-injection loop on new mail.

#### CI + tests
- **`ci`: build UI before tests** so root `bun test` can resolve react and `ui/dist`.
- **`fix(tests)`: lead close-gate and serve static fallback tests CI-safe** — removed environment assumptions that diverged between local dev and the GitHub Actions runner.

### Changed

#### UI consolidation (overstory-e174)
- **`ui/src/routes/mail/{api,ws}.ts` consolidated into `ui/src/lib/{api,ws}.ts`** — mail-route shims deleted; consumers point directly at `lib/*`. Reduces the in-tree surface area of duplicate fetch/WS plumbing.

### Testing

- 4374 tests across 137 files (10285 `expect()` calls) — up from 4213 / 133 / 9935 in 0.10.3
- New `src/agents/mail-poll-detect.test.ts` (153 lines) covering loop-construct detection, negation/subshell variants, `for`-loop exclusion
- New `src/agents/scope-detect.test.ts` (190 lines) covering glob matching, expansion-reason suppression, capability gating
- New `src/insights/quality-gates.test.ts` (141 lines) covering `success`/`partial`/`failure` aggregation and `hasWorkToVerify` precheck
- New `src/merge/predict.test.ts` (387 lines) covering tier classification, error envelopes, integration with the live resolver primitives
- New `src/commands/coordinator.test.ts`, `src/commands/log.test.ts`, `src/commands/merge.test.ts`, `src/commands/sling.test.ts`, `src/commands/stop.test.ts` for the recovery, prediction-output, and parent-resolution paths above
- Expanded coverage in `src/agents/turn-runner.test.ts` (mail-poll detection, scope-violation events, mid-turn `lastActivity` refresh), `src/sessions/store.test.ts` (substate transitions, `migrateRelaxStateCheck` idempotency), `src/worktree/manager.test.ts` (creation pre-check), and `src/watchdog/{daemon,health}.test.ts` (substate-aware health evaluation)

## [0.10.3] - 2026-04-30

### Added

#### Recovery + parent-notification primitives
- **`ov sling --recover`** (overstory-629f) — re-dispatch a fresh agent against an already-closed task. Bypasses the workable-status check via a new `isTaskWorkable` helper so a coordinator can recover when a lead exits without sending `merge_ready` and the task was auto-closed. The terminal-state nudge error now embeds the exact `ov sling --recover` form as a copy-paste recovery hint.
- **Watchdog `worker_died` mail to parent** (overstory-c111) — the watchdog now sends a synthetic `worker_died` protocol mail from a dead child to `session.parentAgent` on first transition to `zombie`, fixing the #1 systemic cause of zombie cascades (parents blocking forever on `worker_done` that will never arrive). Dedup via pre-tick state-snapshot prevents re-fire on idempotent zombie→zombie transitions. Gated by `watchdog.notifyParentOnDeath` (default `true`).
- **Runner-synthesized `worker_died` for in-band gaps** (overstory-4159, overstory-c772) — when a turn ends with `finalState=zombie` (runner aborted the subprocess) or `terminalMailMissing` (claude exited cleanly without sending the expected terminal mail), the runner itself emits `worker_died` so leads don't block when out-of-band death detection misses. `WorkerDiedPayload.terminatedBy` gains a `"runner"` variant.
- **Per-event stall watchdog in spawn-per-turn engine** (overstory-ddb3) — `eventStallTimeoutMs` (default 600000ms) arms before parser iteration and resets on every parser event; on timeout the runner kills claude via the existing SIGTERM/SIGKILL escalation. Stall-aborted turns settle to `zombie`. Pre-fix a hung claude (Anthropic API stall, deadlock) hung the runner indefinitely. `TurnResult` gains `stallAborted` and `terminalMailMissing` booleans for caller-side auditing.
- **`docs/direction-multi-swarm-and-containers.md`** — design/direction note for the next axis after the headless / UI-first shift: one always-running surface for many concurrent swarms, then per-swarm container isolation. Extends `docs/direction-ui-and-ipc.md`.

### Changed

#### Default port + spawn-per-turn observability
- **`ov serve` default port is 7321** (overstory-eaba) — Colima's SSH mux tunnel and other dev proxies (Tomcat / Jenkins / Docker) listen on 8080, and the kernel routes `*:8080` vs `127.0.0.1:8080` inconsistently. Users saw foreign error JSON instead of the overstory UI. The constant is hoisted into `DEFAULT_SERVE_PORT` and imported by `dev.ts` and `doctor/serve.ts` so the three sites can't drift again.
- **`PERSISTENT_CAPABILITIES` consolidated into a single source of truth** (overstory-2724, Phase 4 of the spawn-per-turn epic) — hoists the previously duplicated sets out of `log.ts`, `watchdog/health.ts`, and `watchdog/daemon.ts` into `src/agents/capabilities.ts`. Two sets now live there as canonical: `PERSISTENT_CAPABILITIES = {coordinator, orchestrator, monitor}` (watchdog stale/zombie exemption + run-completion accounting) and `STOP_HOOK_PERSISTENT_CAPABILITIES = PERSISTENT_CAPABILITIES + lead` (gates the per-turn Stop hook in `log.ts`). The split is load-bearing — tmux-mode leads span many model turns within a single dispatch, so the per-turn Stop hook is NOT a "done" signal, but leads still exit at terminal `worker_done` and should count toward run-completion.
- **`agents/lead.md` tightened to coordination-only** (overstory-3172) — the lead capability docs advertised Edit/Write/git add/git commit, but the deployed PreToolUse hooks unconditionally block those for `lead`. Resolution is to tighten the docs, not loosen the hooks: forced delegation is the value proposition of the lead capability. Rewrote propulsion-principle, role, capabilities, constraints, failure-modes (replaced `UNNECESSARY_SPAWN` with `LEAD_DOES_WORK`), task-complexity-assessment (Simple Tasks now spawns a builder + self-verifies), and Phase 2 (use `ov spec write` CLI with `$OVERSTORY_PROJECT_ROOT` paths). `agents/coordinator.md` updated so `--dispatch-max-agents 1/2` means the lead spends slots on builders only (skipping scouts/reviewers, self-verifying), not that the lead acts as a worker. `src/agents/overlay.ts` MAX AGENTS=1/2 directive text rewritten to match.
- **`ov mail send` rejects sends to terminal-state recipients** (overstory-f5be) — once an agent transitions to `completed`/`zombie`, `installMailInjectors` reaps the dispatch loop, so any mail addressed after that would sit unread forever. `handleSend` now checks the recipient's session state before insert and throws `MailError` on terminal states. Recipients without a session row (orchestrator, coordinator, operator roles) and group addresses are unaffected.

### Fixed

#### Spawn-per-turn engine + state machine
- **`runs.agent_count` derived from sessions table at read time** (overstory-8e69) — the cached column drifted because only sling incremented it; coordinator startup never did, so for every run with a coordinator the count was off by one. Switch all run-row reads to `SELECT (SELECT COUNT(*) FROM sessions WHERE run_id = runs.id) AS agent_count` so the count always matches the sessions table. `RunStore` now ensures the sessions table exists when it opens. `incrementAgentCount()` kept as a no-op for API stability.
- **Spawn-per-turn workers no longer misclassified as zombie** (overstory-7a34) — headless detection in `evaluateHealth`/dashboard/status/daemon required `pid !== null`, so spawn-per-turn workers (`pid=null` by design — `turn.pid` is per-turn) fell into the TUI/tmux path where `tmuxAlive=false → ZFC Rule 1 → zombie` within seconds of sling, despite `ov feed` showing live tool events. Adds `isSpawnPerTurnSession` + spawn-per-turn branch in `evaluateHealth` that skips PID/tmux checks and uses lastActivity-only time-based evaluation; daemon registers tailers and refreshes lastActivity from events for `pid=null` headless agents; dashboard/status add a third topology branch (alive iff state is non-terminal — between turns is normal idle).
- **Matrix-guarded state CAS eliminates writer races** (overstory-a993) — three writers raced against `session.state` with no compare-and-swap (turn-runner end-of-turn settle, `ov stop`, watchdog terminate), producing observable e2e symptoms like `state=zombie` + `claude --resume` alive that no single code path produces. Adds `SessionStore.tryTransitionState` — atomic `UPDATE...WHERE state IN (allowed_from)` per target state — and wires the race-prone writers through it. Matrix: `completed` is sticky; `zombie` is sticky except `ov stop` may promote `zombie→completed`; `booting`/`working`/`stalled` can settle into `completed`/`zombie`. The PreToolUse hook revival in `log.ts` is also guarded so a zombie classification cannot be silently revived to `working`.
- **Per-tick state guard closes `ov stop` mail-leak window** (overstory-eb7c) — `ov stop` wrote `state=completed` and killed the in-flight claude, but the per-agent injector setInterval kept ticking at 2s until the 5s `SessionStore` rescan in `serve.ts` reaped it. Within that window the loop saw unread mail and dispatched a fresh `runTurn` against the stopped agent. `startTurnRunnerMailLoop` now accepts an optional `isAgentLive` predicate re-checked on every tick; `serve.ts` wires a predicate that re-reads `SessionStore`.
- **Clean exit without terminal mail surfaced as contract violation** (overstory-6071) — when the parser sees a `result` event with `isError:false` but the agent never sent the capability's terminal mail (`worker_done`/`merged`/etc.), the runner now logs at error level via the diagnostic sink and settles to `completed` instead of leaving the session at `working` forever.
- **`turn.pid` write failure aborts the turn** (overstory-62a6) — `turn.pid` is the cross-process kill primitive for headless task-scoped agents. A warn-and-proceed write failure left `ov stop` and the watchdog unable to find the live PID, silently degrading the kill path. Upgrade the failure to error level, SIGKILL the just-spawned subprocess, and throw — symmetric with the cleanup-side contract assertion that `turn.pid` must not survive the runner.
- **Mail snapshot baseline + parser-error subprocess kill + resume-mismatch event** (overstory-088b) — snapshot the terminal-mail baseline at `SELECT MAX(created_at)` of the agent's prior terminal mail rather than wall-clock `now()`, closing the misattribution window where a prior turn's `worker_done` landing between baseline capture and spawn would falsely trip `terminalMailObserved`. `onSessionId` emits a structured `custom/warn` event into `events.db` carrying `{requestedSessionId, observedSessionId}` on resume mismatch. The `parseEvents` iteration is wrapped in try/catch that SIGKILLs the live subprocess before rethrowing — without the kill, a parser throw orphaned the claude process past `lock.release`. Drops the transitional `DirectSpawnOptsWithResume` local alias.
- **Headless mail metadata escapes pipe and newline** (overstory-2231) — the `[MAIL] From: ... | Subject: ... | Priority: ...\n\n<body>` framing used `|` as a field delimiter and `\n\n` as the metadata-body separator without escaping either in field values. A subject containing `|` or a newline could inject a fake field or smuggle a fake body. Backslash-escape `\`, `|`, `\r`, `\n` in metadata via a shared `formatMailBatch` helper.

#### Tmux lifecycle + session bookkeeping
- **Close tmux orphan, nudge, and session-end gaps** (overstory-505d, overstory-8ff4, overstory-e74b) — tmux wrapper now uses `exec` so claude replaces the bash wrapper and SIGHUP from a dying tmux server reaches claude directly. New `orphan-spawns` doctor check flags sessions with alive PIDs whose container is gone or whose state already terminal; `ov clean --all` reaps surviving spawn PIDs before `sessions.db` is wiped. Tmux nudge fallback waits for `paneAppearsBusy` (Claude Code's "esc to interrupt" marker) to clear before `send-keys`, returning a `deferred` result instead of corrupting the in-flight prompt. Session-end `transitionToCompleted` retries 5x with exponential backoff (50/100/200/400/800ms) on transient SQLite contention; persistent failure logs an `error` event so missed signals are auditable. Watchdog ZFC Rule 1 now distinguishes "completed but missed signal" from "true zombie" via new `HealthCheck.action="complete"`, preventing promotion of cleanly-exited agents.
- **`tmux_session` cleared on terminal-state transitions** (overstory-14c0) — `updateState` and `tryTransitionState` now set `tmux_session = ''` when target state is `completed` or `zombie`. The tmux session is torn down by `ov stop`, the watchdog, or coordinator cleanup before the row lands at terminal state, so the stored string was stale immediately. Without the clear, `AgentSession` records returned by `data.agents` carried dead session names forever in `ov status`'s agents-side view.
- **`zombie`-as-terminal in `checkRunCompletion` + defensive `current-run.txt` read** (overstory-e130, overstory-87bf) — closes a watchdog-side gap where runs containing zombie sessions failed to mark complete.
- **`lead_completed` subject reflects `merge_ready` presence** (overstory-41fe) — `ov stop` outbound notification subject now indicates whether the lead managed to send `merge_ready` before stopping.

#### Serve + UI shipping
- **Ship prebuilt `ui/dist` and skip build when `ui/src` absent** (overstory-916d) — `ov serve` crashed on every fresh `ov init` because `ensureUiBuild` expected `<project>/ui/src` to exist while `ov init` does not create a `ui/` workspace. `ensureUiBuild` no-ops when `ui/src` is missing (production install); `resolveUiDistPath` prefers `<projectRoot>/ui/dist`, falls back to the package-bundled `ui/dist` via `import.meta.url`. `package.json` `files` += `ui/dist`; new `prepack` hook builds `ui/` before pack. `ServeDeps` gains `_resolveUiDistPath` so tests can force project-relative resolution (preserves the 503 branch coverage).

#### CLI ergonomics + observability labels
- **`ov mail send --help` (and other subcommands) now render correctly** (overstory-57d4) — Commander captured `--help` before delegating to the inner mail parser. Disable the outer help option for `mail` and swallow the inner `CommanderError` when help is the requested action.
- **`--project <path>` accepted after a subcommand** (overstory-e736) — root-program options weren't accepted past the subcommand under `enablePositionalOptions()`. Recursively copy the propagated globals (`--project`, `-q/--quiet`, `--timing`) onto every non-delegated subcommand and read them via `actionCommand.optsWithGlobals()` in pre/post action hooks.
- **`ov group <sub> <name>` resolves by name with active-status tiebreak** (overstory-4670) — `ov group status <name>` errored even when the group was visible in `ov group list`, forcing operators to grep for the UUID. New `resolveGroup` with ID-wins / single-name-match / active-tiebreak precedence; throws `GroupError` listing matching IDs when ambiguity remains. CLI arguments relabeled `<group-id-or-name>`.
- **`ov status` labels mail-unread scope** (overstory-cf1e) — `ov status`, `ov mail check`, and `ov mail list --unread` reported unread mail with three different scopes (per-agent, per-agent + read-marking, system-wide). Operators read disagreeing counts as a stale-cache bug. Scopes are intentional; only labels were ambiguous. `ov status` now prints `Mail: N unread (to <agent>)` and exposes `unreadMailScope` in JSON.

### Testing

- 4213 tests across 133 files (9935 `expect()` calls) — up from 4101 / 133 / 9620 in 0.10.2
- New tests in `src/agents/turn-runner.test.ts` for the per-event stall watchdog, contract-violation surfacing, runner-synthesized `worker_died`, and resume-mismatch event paths
- Expanded coverage in `src/sessions/store.test.ts` for `tryTransitionState` matrix and `tmux_session` clearing on terminal transitions
- New tests in `src/watchdog/daemon.test.ts` and `src/watchdog/health.test.ts` for `notifyParentOnDeath`, spawn-per-turn health evaluation, and `checkRunCompletion` zombie handling
- New tests in `src/commands/group.test.ts`, `src/commands/mail.test.ts`, `src/commands/nudge.test.ts`, `src/commands/dashboard.test.ts`, `src/commands/status.test.ts`, `src/commands/stop.test.ts`, and `src/commands/sling.test.ts` for the recovery, name-resolution, and labeling fixes above
- New `src/doctor/consistency.test.ts` cases for the `orphan-spawns` check

## [0.10.2] - 2026-04-30

### Added

#### Spawn-per-turn engine for headless Claude task workers (Phase 1–3)
- **`src/agents/turn-runner.ts`** — `runTurn(opts)` drives a single user turn end-to-end: acquires the per-agent lock, re-reads `SessionStore` for fresh `claudeSessionId`, builds argv with `resumeSessionId`, spawns `claude` with a real stdin pipe (not a FIFO), drains `runtime.parseEvents`, captures `session_id`, tees events into `events.db`, snapshots `mail.db` for `worker_done` detection, applies state transitions (`booting → working`, `completed` when terminal mail observed), handles abort with `SIGTERM → SIGKILL` escalation, and releases the lock on every exit path (overstory-7b8c).
- **`src/agents/turn-lock.ts`** — per-agent serialization with in-process `Promise` mutex plus a cross-process SQLite-backed lease at `.overstory/turn-locks.db`. Stale leases (dead PID) are stolen on next acquire.
- **`src/agents/turn-runner-dispatch.ts`** — shared `buildRunTurnOptsFactory` and `isSpawnPerTurnAgent` helpers consumed by both `serve.ts` and `nudge.ts` so spawn-per-turn dispatch lives in one place.
- **`src/agents/capabilities.ts`** — `isTaskScopedCapability()`, `terminalMailTypesFor()`, and `completionMailTypeFor()` define the canonical set of task-scoped capabilities and their terminal mail contracts. The dynamic overlay generator and runtime now derive the terminal `--type` from this single source of truth.
- **Phase 3 generalization (overstory-2cf9)** — capability gate in dispatch swaps the builder-only check for `isTaskScopedCapability()`, routing builder, scout, reviewer, merger, and lead through the spawn-per-turn engine. The `claudeSpawnPerTurn` config flag is removed (no longer opt-in); legacy long-lived FIFO infrastructure (`headless-stdin.ts`, `headless-finalize.ts`, `watch-exit.ts`) is deleted.
- **`ov sling` first user turn** is now driven through `runTurn` instead of spawning a long-lived headless process; subsequent turns are driven by `ov serve` (mail injection loop) and `ov nudge`.
- **`ClaudeRuntime.buildDirectSpawn` `resumeSessionId`** — Phase 1 plumbing (overstory-7b8c) wires `--resume <id>` after `--model` when the field is non-empty. The headless tailer parses `session_id` from stream-json system/result events and pins it once per lifetime via `SessionStore.updateClaudeSessionId`; observed value wins on resume mismatch with a stderr warning and `_onResumeMismatch` DI hook for tests.

#### Headless-equivalent hooks system (overstory-1c32)
- **`HooksDef.isHeadless`** flag on `ClaudeRuntime.deployConfig` — headless agents skip `settings.local.json` template hooks (SessionStart / UserPromptSubmit / PostToolUse / Stop / PreCompact) but **still receive the dynamic `PreToolUse` security guards** (path boundary, capability blocks, bash danger patterns, tracker close, lead-close gate) so destructive operations are blocked equivalently to tmux mode.
- **`src/agents/headless-prompt.ts`** — `buildInitialHeadlessPrompt()`, `encodeUserTurn()`, and `formatMailSection()` build the first user turn (prime + mail + beacon) for headless spawns.
- **`src/agents/headless-mail-injector.ts`** — `startTurnRunnerMailLoop()` polls `mail.db`, batches unread messages into a single user turn, awaits `runTurn`, and only marks messages read on `exitCode === 0`. Re-entrancy guard prevents overlapping spawns; throws and non-zero exits leave messages unread for the next iteration.
- **`docs/headless-hooks-design.md`** — full design doc for the headless-equivalent hooks pipeline (overstory-1c32).

#### Coordinator console + mail compose in the web UI
- **`/coordinator` chat console** — new `ui/src/routes/coordinator/{ConsolePage,Composer,Thread,EmptyState,PendingBubble,StatusPill,NewRunDialog,api}.tsx` providing a chat-style operator surface for the persistent coordinator: send / ask flows, thread rendering, status pill, slash-command popover with explicit dismissal, and a "start new run" affordance for stopped coordinators (overstory-82b4 / overstory-08a3 / overstory-0d64).
- **`/api/coordinator/*` REST endpoints** — `state`, `send`, `ask`, `check-complete`, `start`, `stop` under `src/commands/serve/coordinator-actions.ts`. All write paths route through the headless connection registry and reject `409` when the active coordinator is tmux-only (overstory-82b4).
- **Mail compose, reply, and per-row delete in the UI** — `ui/src/routes/mail/Composer.tsx` plus mail compose REST API in `src/commands/serve/mail-actions.ts` (overstory-2740).
- **UI polish foundations** (overstory-d108) — `command-palette`, `connection-status`, `theme-toggle`, shadcn `command` / `dialog` / `dropdown-menu` / `sonner` primitives, `use-auto-scroll` / `use-scroll-fade` hooks, theme provider + toast helper, and `ws-status` integration into the app shell.
- **os-eco forest branding** (overstory-29da) — `ui/src/index.css` adopts forest primary/accent/ring tokens with semantic `--success` / `--warning` colors; `ui/src/lib/brand.ts` exposes `TOOL_BRAND` + `toolHex`/`toolRgb` helpers; new stacked-bars `Logo.tsx`, `favicon.svg`, and `apple-touch-icon.png` ship in `ui/public/`.

#### `ov serve` build pipeline + `--dev` HMR proxy
- **Auto-build UI in production** — `src/commands/serve/build.ts` `ensureUiBuild()` runs `bun install` (when `node_modules` missing) and `bun run build` whenever `ui/dist/index.html` is absent or older than any tracked source/config under `ui/`. `runServe` invokes it before binding the port unless `--dev` or the `_skipAutoBuild` test hook is set.
- **`--dev` / `--dev-port` flags** — `src/commands/serve/dev.ts` spawns `ui/dev-server.ts` (Bun HMR with `/api`+`/ws` proxy back to the main port) and threads its `stop()` into the graceful-shutdown chain. `ui/package.json` `dev` script now points at `./dev-server.ts` so HMR runs through the proxy script.

#### Watchdog: atomic PID lock + multi-daemon recovery (overstory-8ef6)
- **`acquirePidLock()`** in `src/utils/pid.ts` uses the write-temp-then-link pattern for true atomic PID-file acquisition. `fs.open(..., 'wx')` alone is insufficient: the file appears at the lock path before `writeFile` completes, letting a racing reader reclaim mid-write. `link()` is the proper atomic primitive — the lock path appears with full content already present.
- **Foreground `ov watch`** acquires the lock atomically and refuses on contested lock instead of trampling. **Background mode** keeps the friendly pre-check and adds a post-spawn atomic acquire; if a racing writer wins, the just-spawned child is `SIGTERM`'d.
- **`ov watch --kill-others`** flag for explicit recovery from pre-fix multi-daemon state. Polls for killed PIDs to be reaped before reclaiming the PID file so the immediate self-start does not race a still-alive zombie.
- **`findRunningWatchdogProcesses()`** in `src/utils/process-scan.ts` scans `ps` for live `ov watch` daemons.
- **`ov doctor --category watchdog`** gains a multi-daemon check (fixable): flags any case with > 1 live `ov watch` and points at `--kill-others`.

#### Headless RuntimeConnection scaffold (overstory-63d5 / overstory-1f66 / overstory-32cd)
- **`HeadlessClaudeConnection`** in `src/runtimes/headless-connection.ts` wraps a `Bun.Subprocess` stdin/PID into the `RuntimeConnection` interface: stdin write → `sendPrompt`/`followUp`, `kill(pid, 0)` → `getState`, `SIGTERM`+`SIGKILL` → `abort`. `registerHeadlessConnection()` factory in `src/runtimes/connections.ts`.
- **`ov nudge` headless path** — `HeadlessClaudeConnection.nudge()` writes a stream-json user-message envelope to the agent's stdin. `nudge.ts` checks `getConnection()` first and routes headless agents through `conn.nudge()`; tmux agents fall through to `send-keys` unchanged. Debounce and `EventStore` recording apply to both paths. `NudgeableConnection` interface + `hasNudge()` type guard let `nudge.ts` detect headless support without modifying `RuntimeConnection`.
- **Watchdog runtime-agnostic kill** — `killAgent()` prefers `conn.abort()` when a `RuntimeConnection` is registered, falling back to PID/tmux kill only if `abort()` throws. The liveness check is unified: `conn.getState()` drives `tmuxAlive` when a connection exists, falling back to `tmux.isSessionAlive()` otherwise.

#### Direction & Design Docs
- **`docs/design/containerize-swarms.md`** — design proposal for sandboxing swarm runs in containers (overstory-e2f1).
- **`docs/headless-hooks-design.md`** — design doc for the headless-equivalent hooks system (overstory-1c32).
- **`docs/direction-ui-and-ipc.md`** — "Operator surface" section gains a shipped-status callout now that Phase 3 and the default flip have landed (overstory-9cee).

### Changed

#### Headless Claude is the new default for new projects (overstory-caec / overstory-9cee)
- **`ov init` now writes `runtime.claudeHeadlessByDefault: true`** into the freshly-generated `.overstory/config.yaml` (`src/commands/init.ts`). New projects spawn Claude agents headless out of the box; the web UI (`ov serve`, then open http://localhost:8080) is the primary operator surface and tmux is opt-in via `ov sling --no-headless` (overstory-caec).
- **Existing projects keep tmux behavior on upgrade.** The fallback default in `resolveUseHeadless` (`src/commands/sling.ts`) remains `false`, so projects that already have a `config.yaml` without the field continue to spawn into tmux until they explicitly add `runtime.claudeHeadlessByDefault: true` (or pass `--headless` per spawn). To opt in: edit `.overstory/config.yaml` and add the field under `runtime:`, or re-run `ov init --yes` to regenerate the config from the new template.
- **CLAUDE.md template updated** (`templates/CLAUDE.md.tmpl`) to describe the headless-default + UI-first workflow with `--no-headless` documented as the tmux escape hatch.
- **Onboarding docs sweep** to align with the default flip (overstory-9cee):
  - `README.md` — Quick Start now leads with `ov coordinator start && ov serve` (http://localhost:8080); architecture and runtime-adapters paragraphs invert the tmux/headless framing; `tmux` is documented as an optional install dependency for live attach.
  - `CLAUDE.md` — Runtime Modes section reorders headless first as the shipped default for new projects, with tmux flagged as the opt-in escape hatch and the legacy-fallback behavior called out explicitly.
  - `ov init` post-init hint and `ov coordinator start` post-start hint both point operators at `ov serve` first.
  - `templates/CLAUDE.md.tmpl` — adds a top-level "web UI is your primary operator surface" paragraph and reframes "Checking Status" to lead with the UI before listing the CLI alternatives.
  - `docs/direction-ui-and-ipc.md` — "Operator surface" section gains a shipped-status callout (Phase 3 + default flip both landed).

#### Operator console polish (overstory-1041)
- Standardized spacing, border weight, and typography hierarchy across the Coordinator console, Fleet, Mail, and Agent surfaces. The chosen scale is documented as a comment block in `ui/src/index.css` so future surfaces can reach for the same tokens.
- Coordinator: `text-xl tracking-tight` headers, `max-w-4xl` thread, rounded-xl bubbles with `shadow-sm`, readable `text-xs` timestamps, composer breathing room and focus-ring polish.
- Fleet: page max-width, uppercase `tabular-nums` summary cards, table wrapped in `rounded-xl/border-border` shell with `h-11` headers.

### Fixed

#### Headless agent observability + reachability
- **`ov nudge` and mail delivery to headless agents** — `ov sling` and `ov serve` are separate processes, so the in-memory connection registry that the mail injector and nudge subscribed to was always empty in serve's process; headless agents were structurally unreachable for the entire duration of their run. Fixed by routing through the shared `RuntimeConnection` registry and (for spawn-per-turn agents) the dispatcher (overstory-41eb / overstory-1f66).
- **PreToolUse security hooks deployed for headless Claude agents** — the original overstory-1c32 design assumed headless mode did not load `.claude/settings.local.json` PreToolUse hooks. Verified empirically that it does, so `deployHooks(headlessOnly=true)` now drops the template entries and keeps the dynamic `PreToolUse` guards (path boundary, capability blocks, bash danger, tracker close, lead close gate) for both modes (overstory-e24b).
- **Headless agent sessions finalize on subprocess exit** — pre-Phase 3, headless mode's per-turn `Stop` hook never fired, so `SessionStore` stayed at `working` indefinitely after `ov sling` exited. Fixed via a detached `__watch-exit` polling subprocess (later subsumed by Phase 3 / overstory-2cf9, which deletes the helper now that `runTurn` owns lifecycle) (overstory-267e).
- **Headless leads self-terminate after `sd close`** — fixed a path where headless leads stayed alive after closing their own task (overstory-6fc9).

#### Spawn-per-turn correctness
- **`worker_done` terminal contract enforced** (overstory-1a4c) — workers were sending `--type result` instead of `--type worker_done` as their terminal exit signal, leaving spawn-per-turn sessions stuck in `working` until the watchdog flipped them to `zombie`. Root cause: the dynamic overlay (`src/agents/overlay.ts` and `templates/overlay.md.tmpl`) injected `--type result` as the per-task completion instruction in three places, overriding the `worker_done` guidance in the base agent `.md` prompts. Two-part fix: (A) backstop in `capabilities.ts` so `terminalMailTypesFor()` accepts both `worker_done` and `result` for builder/scout/reviewer/lead — safe because the runner also requires `cleanResult` (Claude exited cleanly at end-of-turn); (B) tightened prompts so the dynamic overlay derives the terminal `--type` from `capabilities.ts` via `completionMailTypeFor()`, with all base agent docs updated to use `worker_done` (or `merged` for merger).
- **`runTurn` cleanup-contract violations are diagnosable** (overstory-4af3) — silent catches around `SessionStore` writes and `turn.pid` I/O hid the original symptom (`turn.pid` leaked + `lastActivity` frozen at `startedAt`). Per-turn `RunnerLogger` now writes to `<turnLogDir>/runner.log` + `process.stderr` with a `[turn-runner:level]` prefix; explicit contract assertions (`existsSync(turn.pid)` after `unlink`, `updateSessionLastActivity` returning `false`) surface loudly instead of disappearing.

#### UI
- **Coordinator slash menu hidden by default** — empty input was treated as "slash-only", so the hint menu rendered on mount and required a click-off to dismiss before typing.
- **Slash-command popover dismissal** — explicit dismissal in the composer prevents stuck popover state.

#### Tests
- **`log.test.ts` `--stdin` subprocess isolation** (overstory-6830) — subprocesses no longer inherit the parent shell's `OVERSTORY_PROJECT_ROOT`, so the suite is robust to the environment-injection added in 0.9.4.

### Testing

- 4101 tests across 133 files (9620 `expect()` calls)
- New: `src/agents/turn-runner.test.ts` (959 lines), `src/agents/turn-lock.test.ts` (181 lines), `src/agents/turn-runner-dispatch.test.ts` (182 lines) — spawn-per-turn engine coverage
- New: `src/agents/headless-mail-injector.test.ts`, `src/agents/headless-prompt.test.ts`, `src/agents/capabilities.test.ts`
- New: `src/runtimes/headless-connection.test.ts` (264 lines), expanded `src/runtimes/connections.test.ts` and `src/runtimes/claude.test.ts`
- New: `src/commands/serve/build.test.ts` (188 lines), `src/commands/serve/dev.test.ts` (168 lines), `src/commands/serve/coordinator-actions.test.ts` (339 lines), `src/commands/serve/mail-actions.test.ts` (312 lines), expanded `src/commands/serve/rest.test.ts`
- New: `src/commands/coordinator.test.ts` (127 lines), `src/commands/dashboard.test.ts` (mixed-swarm and headless-dead-with-tmux-list regressions), expanded `src/commands/nudge.test.ts` (307 lines), `src/commands/watch.test.ts`
- New: `src/utils/process-scan.test.ts`, expanded `src/utils/pid.test.ts` (atomic acquire, link-based primitive)
- New: `src/watchdog/daemon.test.ts` expansion (363 lines — runtime-agnostic abort path), `src/worktree/process.test.ts`
- New: `src/events/tailer.test.ts` (235 lines — session_id capture, resume mismatch handling)

## [0.10.1] - 2026-04-28

### Added

#### `ov serve` HTTP Surface
- **`ov serve [--port <n>] [--host <addr>]`** — new top-level command (`src/commands/serve.ts`) backed by `Bun.serve` that exposes `/healthz`, REST handlers under `/api/*`, a `/ws` WebSocket upgrade, and SPA static fallback to `ui/dist/`. Designed as the operator surface for the new web UI; defaults to `127.0.0.1:8080` (overstory-ba9c)
- **Extensible route registry** — `registerApiHandler(handler)` and `registerWsHandler(handler)` let downstream streams register REST and WebSocket handlers without touching `serve.ts`. First non-null API handler wins; only one WS handler may be active at a time. `_resetHandlers()` exported for test isolation
- **`createServeServer(opts, deps)`** — dependency-injectable factory used by tests to control lifecycle directly without binding to process signals; `deps._restDeps` accepts `false` to skip REST registration
- **CLI command count: 37 → 38** (new `ov serve`)

#### REST Endpoints over Existing Stores
- **`src/commands/serve/rest.ts`** — read-only REST surface over `EventStore`, `MailStore`, `SessionStore`, and `RunStore` with no new persistence (overstory-9e8b)
- **Endpoints** — `GET /api/runs`, `GET /api/runs/:id`, `GET /api/agents`, `GET /api/agents/:name`, `GET /api/events` (filters: `?agent`, `?run`, `?since`, `?cursor`), `GET /api/mail`, `GET /api/mail/:id`, `POST /api/mail/:id/read`
- **Cursor pagination** — base64url-encoded `{ts, id}` cursors for all list endpoints; `limit` capped at 500. Invalid cursors return `400` via `ValidationError`
- **`apiJson(data, init?)` / `apiError(message, status)`** in `src/json.ts` — HTTP envelope helpers (`{ success, command: "serve", data, nextCursor? }`) matching the existing `jsonOutput` / `jsonError` envelope shape
- **Path-traversal guard** in `src/commands/serve/static.ts` — rejects requests escaping `ui/dist/` via decoded `..`/absolute-path tricks
- **`/healthz` envelope** — now returns `{ uptimeMs, version }` via `apiJson`; `503` for missing `ui/dist` is also a JSON envelope

#### WebSocket Broadcaster
- **`src/commands/serve/ws.ts`** — `installBroadcaster()` subscribes to `EventStore` writes and `MailStore` inserts, multicasting to per-room socket sets registered via `registerWsHandler` (overstory-22ac)
- **Per-run / per-agent rooms** — clients connect to `/ws?run=<id>`, `/ws?agent=<name>`, or `/ws?mail=true`; `getUpgradeData()` rejects connections with no recognized query parameter (`400`); each socket is added to the matching `rooms` map and removed on close
- **Outbound frame schema** — `{ type: "event" | "mail" | "agent_state", ts, payload }`; assistant text events are coalesced in 250 ms windows into a `{ batched: true, events: [...] }` envelope to keep UI render rates manageable

#### `ov doctor --category serve`
- **`src/doctor/serve.ts`** — new doctor category validating `ui/dist/index.html` presence and probing `127.0.0.1:8080` non-blockingly. Warns on missing build / unreachable port; passes on healthy state. Wired into `ALL_CHECKS` in `src/commands/doctor.ts`; `DoctorCategory` union extended with `"serve"`
- **Doctor check categories: 12 → 13**

#### Web UI: Fleet, Mail, Live Timeline
- **Fleet view (`/`)** — `ui/src/routes/Home.tsx` replaced with a real fleet dashboard: `RunPicker`, `SummaryCards`, `AgentTable` polling `/api/runs` and `/api/agents` at 5 s via TanStack Query; row click navigates to `/agents/:name` (overstory-6c4f)
- **Mail inbox (`/mail`)** — new `ui/src/routes/Mail.tsx` with `ResizablePanelGroup` layout (`ThreadList` + `MessageDetail`), `FilterChips` (unread toggle, from/to agent selects), JSON payload viewer, thread reply rendering, and `useMailSocket` hook subscribing to `/ws?mail=true` (overstory-0ddb)
- **Per-agent live timeline (`/agents/:name`)** — `ui/src/routes/AgentDetail.tsx` + `agent/EventRow.tsx` stream `/ws?agent=<name>` events into a chronological feed (overstory-fc04)
- **REST API client** — `ui/src/lib/api.ts` typed fetchers for runs, agents, events, and mail; `ui/src/lib/ws.ts` reusable WebSocket hook with reconnect + room scoping
- **shadcn primitives** — added `ui/src/components/ui/{table,resizable}.tsx` and `react-resizable-panels` dep; `@biomejs/biome` devDep + `lint` script added to `ui/package.json`

#### Direction Doc
- **`docs/direction-ui-and-ipc.md`** — new "Operator surface" section commits to the UI as primary operator surface with tmux as opt-in (`--no-headless`); documents the rationale (one mental model, honest fidelity, broken pane-steering) and gates the default flip on Phase 3 landing (overstory-caec, overstory-9cee)

### Fixed

- **UI sidebar `/agents` link removed** — the link pointed to a route that was never registered, so clicking it showed the 404 fallback. The Fleet view at `/` already lists agents
- **Biome lint/format issues** in serve scaffold — sorted named exports alphabetically to satisfy `organizeImports`; resolved leftover format violations

### Testing

- 3881 tests across 119 files (9072 `expect()` calls)
- New: `src/commands/serve.test.ts` (171 lines — `createServeServer` lifecycle, `/healthz`, handler registry, SPA fallback, port validation)
- New: `src/commands/serve/rest.test.ts` (787 lines — every endpoint, cursor pagination, filters, `400`/`404`/`503` paths, path traversal)
- New: `src/commands/serve/ws.test.ts` (361 lines — room scoping, mail upgrade, broadcaster wiring, text batching window)
- New: `src/doctor/serve.test.ts` (95 lines — `ui/dist` presence, `index.html` check, port-probe pass/warn)

## [0.10.0] - 2026-04-28

### Added

#### Headless Claude Code Execution
- **`buildDirectSpawn(opts)` on `ClaudeRuntime`** (`src/runtimes/claude.ts`) — returns the exact argv to launch Claude Code as a non-tmux subprocess: `-p --output-format stream-json --input-format stream-json --verbose --strict-mcp-config --permission-mode bypassPermissions [--model <m>]`. Claude Code reads `.claude/CLAUDE.md` from cwd; the initial prompt is the caller's responsibility (overstory-46ad)
- **`async *parseEvents(stream, opts)` on `ClaudeRuntime`** — parses NDJSON stream-json stdout into typed `AgentEvent` objects (`assistant_message`, `tool_use`, `tool_result`, `status`, `result`). Adjacent assistant text deltas are coalesced into a single `assistant_message` per batch with configurable `flushIntervalMs` (default 500ms) and `flushSizeBytes` (default 4096). Skips malformed lines and unknown message types
- **Eager `session_id` pinning** — `parseEvents` now invokes `opts.onSessionId` synchronously on the first event carrying a non-empty `sessionId`. New `claudeSessionId` field on `AgentSession` and `claude_session_id` column on the sessions table (with `migrateAddClaudeSessionId` migration), populated via the new `SessionStore.updateClaudeSessionId(agentName, sessionId)` API (overstory-2916)
- **Text-event batching** — assistant text deltas batch on a timer, size cap, any non-text event, or stream end — whichever comes first. Caller errors in `onSessionId` are swallowed so a buggy consumer cannot crash the parser (overstory-d854)
- **`ov sling --headless` / `--no-headless` flag** — per-spawn override for the headless path on Claude Code agents. `--headless` is rejected with a `ValidationError` for runtimes without `buildDirectSpawn` (Pi, Codex, Cursor) and is a no-op for runtimes that statically declare `headless: true` (Sapling) (overstory-268b)
- **`runtime.claudeHeadlessByDefault` config knob** — flips the project-wide default to headless for Claude Code; explicit per-spawn flags still win
- **`resolveUseHeadless(runtime, flag, config)`** in `src/commands/sling.ts` — single source of truth for the headless decision with explicit precedence: static `runtime.headless` → flag → config knob → tmux default

#### Merge-Ready Enforcement Gate
- **`buildLeadCloseGateScript()`** in `src/agents/hooks-deployer.ts` — PreToolUse guard that blocks `sd close <task-id>` / `bd close <task-id>` when a lead tries to close its own task without first sending the required `merge_ready` mail to the coordinator. Counts merge_ready outgoing vs worker_done incoming via `ov mail list --json` and grep, requiring ≥ 1 merge_ready and ≥ 1 merge_ready per worker_done (overstory-3899)
- **Branch-merged ancestor check** — gate also verifies the lead's worktree HEAD is reachable from the merge target (`session-branch.txt` > `main`) via `git merge-base --is-ancestor`. Fails open when worktree path is unset or the target ref is missing locally; otherwise blocks with a descriptive reason instructing the lead to wait for the coordinator to merge (overstory-da9b)
- **`agents/lead.md` updated** — new `MISSING_MERGE_READY_BEFORE_CLOSE` named failure documents the gate and recovery path. Lead now uses YAML frontmatter and may run `{{TRACKER_CLI}} create` directly (worktree-issue restriction lifted)

#### Concurrent Merge Race Prevention
- **`src/merge/lock.ts`** — sentinel-file lock at `.overstory/merge-{sanitized-target}.lock` prevents parallel `ov merge` runs against the same canonical branch from producing transient false-conflict reports. Atomic creation via `writeFileSync(..., { flag: "wx" })`, holder PID checked on collision: live → fail fast, dead → take over
- **`MergeLockHandle`, `mergeLockPath()`, `sanitizeBranchForFilename()`** exported helpers; lock is wired into `mergeCommand` with try/finally release (overstory-9610)

#### UI Scaffold
- **`ui/`** — new web UI package scaffolded with React 19 + Tailwind v4 + shadcn/ui components (`Layout`, `Home`, `badge`, `card`, `scroll-area`, `tabs`)
- **Bun-native bundler** — `ui/build.ts` replaces Vite for both dev and production builds; tighter integration with the rest of the Bun-only toolchain
- **`docs/direction-ui-and-ipc.md`** — direction document outlining UI architecture and IPC plans

### Fixed

- **`ov sling` startup failures now mark the agent as `zombie`** rather than `completed` so the watchdog detects them. `completed` is a terminal success state the watchdog skips entirely (overstory-c40e)
- **Lead does not auto-complete on per-turn `Stop` hook** — leads now stay alive across turns instead of being torn down on each `Stop` event
- **`ov doctor` exit-code race eliminated** — `process.exitCode` is no longer set asynchronously inside `doctorCommand`, removing a window where parallel test commands inherited a stale failing exit code
- **`bun test` clears `process.exitCode` to 0 in `afterEach`** — prevents a single failure from leaking a non-zero exit code through the rest of the suite
- **Test isolation for `OVERSTORY_PROJECT_ROOT`** — `bun test` no longer inherits an external `OVERSTORY_PROJECT_ROOT` from the parent shell, which previously corrupted multi-DB tests (overstory-6d42)
- **`agents/coordinator.md` merge step** — wording realigned with the new `merge_ready` contract: coordinators must process `merge_ready` mails before closing tasks (overstory-ad45)

### Changed

- **`agents/lead.md` rewritten** — adopts YAML frontmatter (`name: lead`), simplifies dispatch override handling, lifts the worktree-create-issue restriction, and removes the duplicate role-compression block (kept in overlay generation)
- **Mulch onboarding refreshed to v2** — `CLAUDE.md` mulch section updated to reflect the v2 record/learn/sync workflow
- **Biome config cleanup** — `chore(lint)` flattens nested config and resolves leftover format/keys violations
- **Maintenance cadence documented** — `CONTRIBUTING.md` now states the part-time review cadence (2-week PR batches, 30-day inactivity close)

### Testing

- 3815 tests across 115 files (8907 `expect()` calls)
- New: `src/merge/lock.test.ts` (149 lines — sentinel acquire/release, stale-PID takeover, branch-name sanitization)
- New: `src/runtimes/__fixtures__/claude-stream-fixture.ts` (canonical stream-json fixture for parser tests)
- New: `src/test-setup.ts` + `src/test-setup.test.ts` (shared global test setup; `OVERSTORY_PROJECT_ROOT` isolation; `process.exitCode` reset)
- Expanded: `src/runtimes/claude.test.ts` (+668 lines — `buildDirectSpawn`, `parseEvents`, text batching, eager session_id pinning, error swallowing)
- Expanded: `src/agents/hooks-deployer.test.ts` (+505 lines — `buildLeadCloseGateScript` merge_ready / worker_done counting, ancestor checks, fail-open paths)
- Expanded: `src/commands/merge.test.ts` (+113 lines — concurrent merge lock acquisition, stale-lock takeover, error path cleanup)
- Expanded: `src/commands/sling.test.ts` (+54 lines — `resolveUseHeadless` precedence, `--headless` validation, headless spawn path)
- Expanded: `src/sessions/store.test.ts` (+40 lines — `claude_session_id` column migration, update API)
- Expanded: `src/mail/store.test.ts`, `src/commands/log.test.ts`, `src/commands/mail.test.ts`, `src/commands/stop.test.ts`, `src/watchdog/daemon.test.ts`

## [0.9.4] - 2026-04-07

### Fixed

#### Submodule Cascade
- **`resolveProjectRoot()` env var + walk-up detection** in `src/config.ts` — now checks `OVERSTORY_PROJECT_ROOT` env var (priority 2) and walks up from worktree paths (priority 3) before falling through to `git rev-parse`. Fixes silent multi-DB split where slung agents in nested git submodules wrote to a different `.overstory/` than the host project (overstory-5804)
- **`OVERSTORY_PROJECT_ROOT` injected into spawned agent env** — `ov sling` now adds the canonical project root to all three agent env dicts (headless `directEnv`, tmux `buildSpawnCommand` env, tmux `createSession` env) so child agents always inherit the correct root
- **`ov worktree clean` live-children guard** — `handleClean()` now calls `checkLiveChildren()` before removing each worktree. Live nested sessions block removal unless `--force` is passed, which cascade-SIGTERMs them. New `blockedByChildren` field added to JSON output and human summary (overstory-329a)

#### Tmux Session Name Sanitization
- **Project names containing dots** (e.g., `consulting.jayminwest.com`) caused tmux to interpret the dots as `session.window.pane` separators in `-t` target strings, breaking all pane lookups after session creation
- **`sanitizeTmuxName()`** added to `src/worktree/tmux.ts` — replaces dots and colons with underscores, applied at all 6 tmux name construction sites (`clean.ts`, `coordinator.ts`, `monitor.ts`, `sling.ts`, `supervisor.ts`, `doctor/consistency.ts`)

### Testing

- 3708 tests across 113 files (8656 `expect()` calls)
- Expanded: `src/commands/worktree.test.ts` (+322 lines — live-children guard, cascade SIGTERM, `blockedByChildren` JSON output)
- Expanded: `src/config.test.ts` (+78 lines — `OVERSTORY_PROJECT_ROOT` env var resolution, worktree walk-up)
- Expanded: `src/commands/sling.test.ts` (+12 lines — env var injection across all three spawn paths)
- Expanded: `src/worktree/tmux.test.ts` (+36 lines — `sanitizeTmuxName()` for dots and colons)

## [0.9.3] - 2026-03-23

### Added

#### Tmux Socket Isolation
- **`tmux -L overstory` socket** — all agent sessions now run on a dedicated tmux server socket, isolating them from the user's personal tmux config (themes, plugins, keybindings). Prevents spawn failures caused by incompatible tmux configurations. See GitHub #93
- **`TMUX_SOCKET` constant and `tmuxCmd()` helper** in `src/worktree/tmux.ts` — all tmux operations (create, list, kill, capture, send-keys) route through the shared socket builder

#### Copilot Runtime Enhancements
- **Model alias expansion** — Copilot runtime now maps short aliases (`sonnet`, `opus`, `haiku`) to fully-qualified model names (`claude-sonnet-4-6`, etc.) via `MODEL_MAP`; unknown names pass through unchanged (#77)
- **Hooks support** — new `src/agents/copilot-hooks-deployer.ts` and `templates/copilot-hooks.json.tmpl` deploy `.github/hooks.json` to copilot worktrees for event logging
- **Folder trust auto-configuration** — `ensureCopilotTrustedFolders()` pre-registers worktree paths in `~/.config/github-copilot/config.json` to suppress trust prompts
- **Auto-detection in `ov init`** — runtime detection now checks for `copilot` CLI and sets it as the default if Claude Code is not installed

#### Init Runtime Auto-Detection
- **`detectDefaultRuntime()`** in `src/commands/init.ts` — `ov init` now probes for installed coding agent CLIs (claude, copilot, gemini, opencode, sapling, pi) and sets the first match as `runtime.default` in config

### Fixed

- **Dashboard "No tracker data" with beads backend** — `bd list --json` now handles both flat array and tree-format (`{ mol: [...] }`) output, with fallback to `bd ready --json`
- **Codex provider prefix stripping** — `CodexRuntime` now strips `provider/` prefix from model names before passing to the `codex` CLI
- **Pi ready-state regex** — updated pattern to match M-scale context windows (e.g., `1M`)
- **Coordinator completion protocol ordering** — mulch recording now runs before worktree cleanup, preventing lost expertise when worktrees are removed early

### Changed

- All tmux operations use dedicated `overstory` socket instead of default server
- Copilot runtime instruction path: `.github/copilot-instructions.md`

### Testing

- 3689 tests across 113 files (8627 `expect()` calls)
- New test file: `src/agents/copilot-hooks-deployer.test.ts` (162 lines)
- Expanded: `src/runtimes/copilot.test.ts` (+220 lines — model aliases, folder trust, hooks, auto-detect)
- Expanded: `src/worktree/tmux.test.ts` (+140 lines — socket isolation, `tmuxCmd()` builder)
- Expanded: `src/runtimes/codex.test.ts` (+35 lines — provider prefix stripping)
- Expanded: `src/runtimes/pi.test.ts` (+24 lines — M-scale context regex)
- Expanded: `src/tracker/factory.test.ts` (+10 lines)

## [0.9.2] - 2026-03-23

### Added

#### Aider, Goose, and Amp Runtime Adapters
- **`src/runtimes/aider.ts`** — new experimental runtime adapter for [Aider](https://aider.chat) (`aider` CLI), Paul Gauthier's AI pair programming tool — interactive REPL with `--yes-always`, writes overlay to `CONVENTIONS.md`, no hook system — thanks to **@arosstale** (#80)
- **`src/runtimes/goose.ts`** — new experimental runtime adapter for [Goose](https://github.com/block/goose) (`goose` CLI), Block's AI developer agent — interactive REPL with profile-based permissions, writes overlay to `.goosehints` — thanks to **@arosstale** (#80)
- **`src/runtimes/amp.ts`** — new experimental runtime adapter for [Amp](https://amp.dev) (`amp` CLI), Sourcegraph's AI coding agent — interactive chat with built-in approval system, writes overlay to `.amp/AGENT.md` — thanks to **@arosstale** (#80)
- Runtime count: 8 → 11 adapters

#### Orchestrator Command Surface
- **`ov orchestrator`** — new top-level command for ecosystem-level multi-repo orchestration; shares the same start/stop/status/send/ask/output subcommands as `ov coordinator` via a reusable `PersistentAgentSpec` abstraction (#126)
- **`src/commands/orchestrator.ts`** — defines `ORCHESTRATOR_SPEC` and routes through shared persistent agent machinery
- **Refactored `coordinator.ts`** — extracted `PersistentAgentSpec` interface and `startPersistentAgent()` / `stopPersistentAgent()` / `statusPersistentAgent()` helpers for code reuse between coordinator and orchestrator

#### Role Compression for Low-Budget Agents
- **Budget compression rules in `agents/lead.md`** — leads now compress roles when `MAX_AGENTS` is constrained: `=1` means act as combined lead/worker, `=2` means one helper at a time then finish yourself (#127)
- **`agents/coordinator.md` updated** — coordinators may now spawn scouts/builders directly for low-budget or narrow work instead of always going through leads
- **`src/agents/overlay.ts` enhanced** — `formatDispatchOverrides()` generates compression-aware messaging for `MAX_AGENTS = 1` and `MAX_AGENTS = 2`

#### Watchdog Enhancements
- **`TriageResult` type** in `src/watchdog/triage.ts` — replaces bare strings with structured `{ verdict, fallback, reason }` for better triage observability
- **New watchdog config options** — `rpcTimeoutMs` (default 5000), `triageTimeoutMs` (default 30000), `maxEscalationLevel` (default 3) with validation ranges
- **`ov doctor --category watchdog`** — new doctor check category validating PID file integrity, process liveness, tier availability

#### Utilities Module
- **`src/utils/bin.ts`** — `resolveOverstoryBin()` for re-launch scenarios
- **`src/utils/fs.ts`** — SQLite wipe, JSON reset, directory clear, file delete helpers
- **`src/utils/pid.ts`** — PID file read/write/remove
- **`src/utils/time.ts`** — parse relative time formats (`1h`, `30m`, `2d`, `10s`)
- **`src/utils/version.ts`** — version detection (current, npm registry, CLI tools)

#### Pi Runtime
- **AGENTS.md overlay support** — Pi runtime now writes overlays to `AGENTS.md` in addition to guard extensions (#122)

### Fixed

- **Doctor false positives** — reduced spurious failures across multiple check categories (#125)
- **Dashboard alternate screen buffer** — `ov dashboard` now uses the alternate screen buffer, preventing TUI artifacts from polluting the terminal after exit — thanks to **@mustafamagdy** (#111)
- **Network-dependent provider tests** — replaced external HTTP calls with local HTTP servers for CI reliability — thanks to **@0xLeathery** (#110)
- **Event tailer graceful degradation** — `startEventTailer()` returns a no-op handle when EventStore creation fails instead of crashing
- **Tailer registry cleanup** — watchdog daemon now properly cleans up the event tailer registry on `stop()` to prevent resource leaks
- **Canopy client test resilience** — tests skip gracefully when `cn` CLI is unavailable

### Changed

- CLI command count: 36 → 37 (new `ov orchestrator` command)
- Doctor check categories: 11 → 12 (new `watchdog` category)
- Runtime adapter count: 8 → 11 (new `aider`, `goose`, `amp`)

### Testing

- 3654 tests across 112 files (8566 `expect()` calls)
- New runtime adapter tests: `aider.test.ts`, `goose.test.ts`, `amp.test.ts`
- New utility tests: `bin.test.ts`, `fs.test.ts`, `pid.test.ts`, `time.test.ts`, `version.test.ts`
- New doctor category test: `watchdog.test.ts`
- Expanded coverage: `coordinator.test.ts`, `errors.test.ts`, `logs.test.ts`, `prime.test.ts`, `feed.test.ts`, `group.test.ts`, `config.test.ts`, `mail/store.test.ts`, `watchdog/daemon.test.ts`
- Test coverage uplift by exporting private helpers and adding targeted tests — thanks to **@0xLeathery** (#109)

## [0.9.1] - 2026-03-12

### Changed

#### Discover Command Rewrite
- **`ov discover` now coordinator-driven** — replaced direct scout spawning with a coordinator session that autonomously spawns leads and scouts per category, synthesizes results, and writes mulch records
- **`startCoordinatorSession()` extracted** from `coordinator.ts` — reusable core for commands that need coordinator-like sessions with custom names or beacons (used by `ov discover`)
- **New flags:** `--attach` / `--no-attach` and `--watchdog` on `ov discover`; default agent name changed from `discover` to `discover-coordinator`
- **`buildDiscoveryBeacon()` and `buildScoutArgs()` helpers** exported from `discover.ts` for testability

### Fixed

- **Task-lock collision in `ov discover`** — each scout now gets a unique task ID (`taskId-categoryName`) instead of sharing one, preventing `checkTaskLock()` from blocking scouts 2–6
- **`maxAgentsPerLead` rejection in `ov discover`** — scout count now passed via `--max-agents` to avoid exceeding the default cap of 5 when all 6 categories are active

### Testing

- 3398 tests across 102 files (8038 `expect()` calls)
- Added 6 unit tests for `buildScoutArgs()` covering all acceptance criteria

## [0.9.0] - 2026-03-11

### Added

#### Codebase Discovery Command
- **`ov discover`** — new top-level command that spawns parallel scout agents to explore a brownfield codebase and produce structured mulch records, with categories for architecture, conventions, testing, dependencies, and more
- **`src/commands/discover.ts`** — implementation with `DiscoveryCategory` interface and `DISCOVERY_CATEGORIES` constant defining research areas
- **`src/commands/discover.test.ts`** — test suite for the discover command

#### Canopy Client & Prompt Versioning
- **`src/canopy/client.ts`** — new `CanopyClient` wrapper providing programmatic access to canopy prompt rendering, listing, and emission
- **`src/canopy/client.test.ts`** — test suite for the canopy client
- **`promptVersion` session tracking** — `SessionStore` now records which canopy prompt version was active when a session started, enabling prompt-change auditing

#### Profile System
- **`--profile` flag on `ov sling` and `ov coordinator start`** — pass a named profile to customize agent behavior via canopy prompt overlays
- **`PROFILE_INSTRUCTIONS` placeholder** in `overlay.md.tmpl` — the overlay pipeline now supports injecting profile-specific instructions into agent overlays

#### Co-Creation Workflow
- **`agents/ov-co-creation.md`** — new canopy prompt extending ov-delivery for collaborative human-in-the-loop workflows
- **`decision_gate` mail type** — new semantic mail type for human-in-the-loop decision points, enabling agents to pause and request human approval before proceeding

#### Guided Workflow Setup
- **`.claude/commands/customize.md`** — new guided workflow setup skill for interactive agent customization
- **`.claude/commands/discover.md`** — new discover skill for brownfield codebase exploration

### Fixed

- **`process.exit()` replaced with `process.exitCode`** in `watch.ts` and `dashboard.ts` — prevents abrupt termination that could skip cleanup handlers
- **Ecosystem test CI resilience** — `ecosystem.test.ts` no longer fails in CI environments where `ov` is not globally installed

### Changed

- CLI command count: 35 → 36 (new `ov discover` command)

### Testing

- 3387 tests across 102 files (7997 `expect()` calls)

## [0.8.7] - 2026-03-10

### Added

#### Cursor CLI Runtime Adapter
- **`src/runtimes/cursor.ts`** — new runtime adapter for [Cursor CLI](https://cursor.com/docs/cli/overview) (`agent` binary), implementing the `AgentRuntime` interface with TUI spawning via tmux, `.cursor/rules/overstory.md` instruction delivery, `--yolo` permission bypass, and headless one-shot mode — thanks to **@XavierChevalier** (#104, #66)
- **`src/runtimes/cursor.test.ts`** — comprehensive test suite (497 lines) covering spawn command building, overlay generation, readiness detection, and transcript parsing

#### Runtime Stability Classification
- **`stability` field on `AgentRuntime`** — new `"stable" | "beta" | "experimental"` field on the runtime interface; Claude and Sapling marked `stable`, Pi and Codex as `beta`, Copilot/Gemini/OpenCode/Cursor as `experimental`
- Stability surfaced in `ov agents` and runtime documentation

#### Per-Coordinator Run Isolation
- **Per-coordinator session tracking** — `SessionStore` now tracks `coordinator_name` per session with auto-migration for existing databases, enabling isolated run tracking when multiple coordinators operate in the same project
- **`OVERSTORY_TASK_ID` env var** — slung agents now receive their task ID as an environment variable; tracker `close` commands are guarded to prevent agents from closing issues outside their assigned scope

#### Dashboard Runtime Column
- **Runtime column in dashboard agent panel** — the live TUI dashboard now shows which runtime each agent is using (e.g., `claude`, `cursor`, `sapling`) — thanks to **@mustafamagdy** (#99)

### Fixed

- **Dashboard crash on SQLite lock contention** — `ov dashboard` no longer crashes when concurrent agents cause `SQLITE_BUSY`; database reads are wrapped with retry logic
- **Silent content loss in merge auto-resolve** — merge resolver Tier 2 (hunk-level) no longer silently drops non-conflicting content when resolving conflicts; the entire file is now preserved correctly
- **`ov init` ENOENT on spawner calls** — `spawner()` calls for ecosystem tool detection are now wrapped in try/catch to prevent crashes when `mulch`/`sd`/`cn` CLIs are not installed
- **Shift+tab false positive in `detectReady`** — the `hasStatusBar` check no longer matches shift+tab escape sequences as a status bar indicator, preventing premature ready detection
- **Claude bypass dialog and Codex shared state** — Claude runtime's `detectReady()` now recognizes the "bypass" dialog phase; Codex runtime correctly handles `sharedWritableDirs` spawn option — thanks to **@Ilanbux** (#101)
- **Tmux pane retry for WSL2 race condition** — `capturePaneContent()` and `sendKeys()` now retry on transient tmux failures caused by WSL2 timing issues — thanks to **@arosstale** (#78)
- **Fish shell tmux spawn** — tmux session commands are now wrapped in `/bin/bash -c` to prevent failures when the user's default shell is fish
- **`coordinator_name` column migration** — `createSessionStore()` now auto-migrates existing `sessions` tables to add the `coordinator_name` column without data loss

### Testing

- 3364 tests across 100 files (7924 `expect()` calls)
- New: `src/runtimes/cursor.test.ts`, `src/commands/ecosystem.test.ts`

## [0.8.6] - 2026-03-06

### Added

#### Coordinator Completion Protocol
- **`ov coordinator check-complete`** — new subcommand that evaluates configured exit triggers (`allAgentsDone`, `taskTrackerEmpty`, `onShutdownSignal`) and returns per-trigger status; complete = true only when ALL enabled triggers are met
- **`coordinator.exitTriggers` config** — new `coordinator` section in `config.yaml` with three boolean triggers controlling automatic coordinator shutdown (all default to `false`)
- Exit-trigger evaluation integrated into coordinator completion protocol — the coordinator can now self-terminate when configured conditions are met
- `allAgentsDone` trigger also checks the merge queue to prevent premature shutdown while branches are still pending merge

#### Spawn Rollback
- **`rollbackWorktree()`** — new helper in `src/worktree/manager.ts` that removes a worktree and deletes its branch (best-effort, errors swallowed)
- **`ov sling` rollback on spawn failure** — if agent spawn fails after worktree creation, the worktree and branch are automatically rolled back to avoid orphaned resources

#### Per-Agent Cleanup
- **`ov clean --agent <name>`** — targeted cleanup of a single agent: kills tmux session or process tree, removes worktree, deletes branch, clears agent and log directories, logs synthetic session-end event, and marks session as completed
- **`ov stop --clean-worktree` on completed agents** — previously threw an error for completed agents; now skips the kill step and proceeds directly to worktree+branch cleanup

#### Merge Reliability
- **Auto-commit os-eco state files before merge** — runtime state files (`.seeds/`, `.overstory/`, `.mulch/`, `.canopy/`, `.greenhouse/`, `.claude/`, `CLAUDE.md`) are automatically committed with `chore: sync os-eco runtime state` to prevent dirty-tree merge errors
- **Stash/pop dirty files during merge** — uncommitted changes are stashed before merge and popped afterward, with proper cleanup on failure
- **`onMergeSuccess` callback** — `createMergeResolver()` now accepts an optional `onMergeSuccess` hook called after successful merge of each entry
- **Untracked file handling** in merge resolver improved to prevent conflicts between tracked and untracked files

#### Init Scaffold Commit
- **Auto-commit scaffold files at end of `ov init`** — ecosystem directories (`.overstory/`, `.seeds/`, `.mulch/`, `.canopy/`, `.gitattributes`, `CLAUDE.md`) are committed so agent branches don't cause untracked-vs-tracked conflicts during merge

### Fixed

- **Headless agent kill blast radius** — `killSession("")` with tmux prefix matching could kill ALL tmux sessions; watchdog now uses `killAgent()` helper that routes headless agents through PID-based `killProcessTree()` and TUI agents through named tmux sessions
- **Stale headless agent detection** — watchdog now checks `isProcessAlive(pid)` for headless agents instead of only checking tmux session liveness
- **Coordinator state file commit** — completion protocols now commit os-eco state files before final steps to prevent dirty-tree errors downstream
- **Coordinator premature issue closure** — coordinator no longer closes seeds issues before the lead agent merges its branch; `allAgentsDone` trigger checks merge queue for pending branches
- **Coordinator auto-complete on session-end** — `ov run complete` is no longer called automatically from the per-turn Stop hook, preventing premature run completion
- **Self-exiting coordinator** — session-end hook now handles coordinators that exit themselves (e.g., via exit triggers) without throwing errors
- **`--json` flag stolen by parent Commander** — `.enablePositionalOptions()` added to the root program so subcommand `--json` flags are not consumed by the parent parser
- **Pi runtime transcript parsing** — Pi v3 JSONL format stores token usage inside `message` events at `message.usage.{input, output, cacheRead}`, not in `message_end` events; parser now handles both formats with `cacheRead` counted toward input tokens (#82)
- **Pi `getTranscriptDir()`** — now returns `~/.pi/agent/sessions/{encoded-project-path}/` instead of `null`, enabling `ov costs` for Pi agents (#82)

### Changed

- CLI command count: 34 → 35 (new `check-complete` subcommand under `ov coordinator`)

### Testing

- 3248 tests across 98 files (7677 `expect()` calls)

## [0.8.5] - 2026-03-05

### Added

#### OpenCode Runtime Adapter
- **`src/runtimes/opencode.ts`** — new runtime adapter for [SST OpenCode](https://opencode.ai) (`opencode` CLI), implementing the `AgentRuntime` interface with model flag support, `AGENTS.md` instruction file, and headless subprocess spawning
- **`src/runtimes/opencode.test.ts`** — test suite (325 lines) covering spawn command building, overlay generation, guard rules, and environment setup

#### NDJSON Event Tailer for Headless Agents
- **`src/events/tailer.ts`** — background NDJSON event tailer that polls `stdout.log` files from headless agents (e.g. Sapling, OpenCode), parses new lines, and writes them into `events.db` via EventStore — enabling `ov status`, `ov dashboard`, and `ov feed` to show live progress for headless agents
- **`src/events/tailer.test.ts`** — test suite (461 lines) covering line parsing, file tailing, stop/cleanup, and edge cases
- **Watchdog integration** — `runDaemonTick()` now automatically starts/stops event tailers for active headless agents, with module-level tailer registry persisting across ticks

#### Headless Agent Inspection
- **`ov inspect` stdout.log fallback** — when `--no-tmux` or tmux capture fails, inspect now falls back to reading the agent's `stdout.log` NDJSON file, parsing recent events to display tool activity and progress for headless agents

### Fixed

- **Sapling `buildDirectSpawn()` crash** — model resolution logic now guards against `undefined` model parameter instead of unconditionally calling `.toUpperCase()` on it; `--model` flag is only appended when a model is actually specified
- **Sapling API key leak** — `ANTHROPIC_API_KEY` is now explicitly cleared in the child process environment to prevent the parent session's key from leaking into sapling subprocesses; gateway providers re-set it as needed

### Testing

- 3201 tests across 98 files (7551 `expect()` calls)

## [0.8.4] - 2026-03-04

### Added

#### Per-Capability Runtime Routing
- **`runtime.capabilities` config field** — maps capability names (e.g. `builder`, `scout`, `coordinator`) to runtime adapter names, enabling heterogeneous fleets where different agent roles use different runtimes
- `getRuntime()` now accepts a `capability` parameter; lookup chain: explicit `--runtime` flag > `capabilities[cap]` > `default` > `"claude"`
- 4 tests covering capability routing, fallback, explicit override, and undefined capabilities

#### Runtime-Agnostic Transcript Discovery
- **`getTranscriptDir()` method** added to `AgentRuntime` interface — each runtime adapter now owns its transcript directory resolution instead of hardcoding Claude Code paths in the costs command
- All 6 runtime adapters implement `getTranscriptDir()` (Claude returns project-specific path; others return `null`)

#### Dynamic Instruction Path Discovery
- `getKnownInstructionPaths()` in `agents.ts` now queries all registered runtimes via `getAllRuntimes()` instead of maintaining a hardcoded list, so new runtimes are automatically discovered

### Fixed

- **Dirty working tree merge guard** — `ov merge` now detects uncommitted changes to tracked files before attempting a merge and throws a clear error, preventing cascading failures through all 4 tiers with misleading empty conflict lists
- 5 tests covering the dirty-tree detection in `resolver.test.ts`

### Changed

- **Decoupled Claude Code specifics** from costs, transcript, and agent discovery modules — `estimateCost` re-export removed from `transcript.ts` (import directly from `pricing.ts`), transcript dir resolution moved from costs command into runtime adapters, instruction path list derived from runtime registry

### Testing

- 3137 tests across 96 files (7420 `expect()` calls)

## [0.8.3] - 2026-03-04

### Added

#### Auto-Generated Agent Names
- **`ov sling` no longer requires `--name`** — when omitted, generates a unique name from `{capability}-{taskId}`, with `-2`, `-3` suffixes to avoid collisions against active sessions
- `generateAgentName()` helper exported from `src/commands/sling.ts` with collision-avoidance logic

#### Direct Scout/Builder Spawn
- **Coordinator can now spawn scouts and builders directly** — previously only `lead` was allowed without `--parent`; scouts and builders are now also permitted for lightweight tasks that don't need a lead intermediary

#### Runtime-Aware Instruction Path
- **`{{INSTRUCTION_PATH}}` placeholder** in agent definitions — all agent `.md` files now use a runtime-resolved placeholder instead of hardcoded `.claude/CLAUDE.md`, enabling Codex (`AGENTS.md`), Sapling (`SAPLING.md`), and other runtimes to place overlays at their native instruction path
- `instructionPath` field added to `OverlayConfig` type and `generateOverlay()` function

### Fixed

- **Codex runtime startup** — `buildSpawnCommand()` now uses interactive `codex` (not `codex exec`) so sessions stay alive in tmux; omits `--model` for Anthropic aliases that Codex CLI doesn't accept (thanks @vidhatanand)
- **Zombie agent cleanup** — `ov stop` now cleans up zombie agents (marks them completed) instead of erroring with "already zombie"
- **Headless stdout redirect** — `ov sling` always redirects headless agent stdout to file, preventing backpressure-induced zombie processes
- **Config warning deduplication** — non-Anthropic model warnings in `validateConfig` now emit once per process instead of on every `loadConfig()` call
- **Codex bare model refs** — `validateConfig` now accepts bare model references (e.g., `gpt-5.3-codex`) when the default runtime is `codex`, instead of requiring provider-prefixed format

### Changed

- Agent definition `.md` files updated to use `{{INSTRUCTION_PATH}}` placeholder (builder, lead, merger, reviewer, scout, supervisor, orchestrator)

### Testing

- 3130 tests across 96 files (7406 `expect()` calls)

## [0.8.2] - 2026-03-04

### Added

#### RuntimeConnection Registry
- **`src/runtimes/connections.ts`** — module-level connection registry for active `RuntimeConnection` instances, tracking RPC connections to headless agent processes (e.g., Sapling) keyed by agent name
- `getConnection()`, `setConnection()`, `removeConnection()` for lifecycle management with automatic `close()` on removal
- 6 tests in `src/runtimes/connections.test.ts`

#### Sapling RPC Enhancements
- **RuntimeConnection for SaplingRuntime** — full RPC support enabling direct stdin/stdout communication with Sapling agent processes
- Model alias resolution in `buildEnv()` and `buildDirectSpawn()` — expands `sonnet`/`opus`/`haiku` aliases correctly

### Fixed

- **Headless backpressure zombie** — `ov sling` now redirects headless agent stdout/stderr to log files to prevent backpressure from causing zombie processes
- **`deployConfig` guard write** — always writes `guards.json` even when overlay is undefined, preventing missing guard files for headless runtimes
- **Sapling model alias resolution** — correct alias expansion in both `buildEnv()` and `buildDirectSpawn()` paths

### Testing

- 3116 tests across 96 files (7373 `expect()` calls)

## [0.8.1] - 2026-03-04

### Added

#### Sapling Runtime Adapter
- **Sapling** (`sp`) runtime adapter — full `AgentRuntime` implementation for the Sapling headless coding agent
- Headless: runs as a Bun subprocess (no tmux TUI), communicates via NDJSON event stream on stdout (`--json`)
- Instruction file: `SAPLING.md` written to worktree root (agent overlay content)
- Guard deployment: `.sapling/guards.json` written from `guard-rules.ts` constants
- Model alias resolution: expands `sonnet`/`opus`/`haiku` aliases via `ANTHROPIC_DEFAULT_*_MODEL` env vars
- `buildEnv()` configures `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, provider routing
- Registered in runtime registry as `"sapling"`, available via `ov sling --runtime sapling`
- Sapling v0.1.5 event types added to `EventType` union and theme labels
- 972 lines of test coverage in `src/runtimes/sapling.test.ts`

#### Headless Agent Spawn Path
- **Headless spawn** in `ov sling` — when `runtime.headless === true`, bypasses tmux entirely and spawns agents as direct Bun subprocesses
- New `src/worktree/process.ts` module: `spawnHeadlessAgent()` for direct `Bun.spawn()` invocation, `HeadlessProcess` interface for PID/stdin/stdout management
- `DirectSpawnOpts` and `AgentEvent` types added to `src/runtimes/types.ts`
- Headless fields added to `AgentRuntime` interface

#### Headless Agent Lifecycle Support
- **`ov status`**, **`ov dashboard`**, **`ov inspect`** updated to handle tmux-less (headless) agents gracefully
- **`ov stop`** updated with headless process termination via PID-based `killProcessTree()`
- Health evaluation in `src/watchdog/health.ts` supports headless agent lifecycle (PID liveness instead of tmux session checks)

### Fixed

- **CLAUDECODE env clearing** — clear `CLAUDECODE` env var in tmux sessions for Claude Code >=2.1.66 compatibility
- **Stale comment** — update `--mode rpc` comment to `--json` in `process.ts`

### Changed

- Runtime adapters grew from 5 to 6 (added Sapling)

### Testing

- 3089 tests across 95 files (7324 `expect()` calls)
- New test files: `src/runtimes/sapling.test.ts`, `src/agents/guard-rules.test.ts`, `src/worktree/process.test.ts`, `src/commands/stop.test.ts`, `src/commands/status.test.ts`, `src/commands/dashboard.test.ts`, `src/watchdog/health.test.ts`

## [0.8.0] - 2026-03-03

### Added

#### Coordinator Interaction Subcommands
- **`ov coordinator send`** — fire-and-forget message to the running coordinator via mail + auto-nudge, replacing the two-step `ov mail send` + `ov nudge` pattern
- **`ov coordinator ask`** — synchronous request/response to the coordinator; sends a dispatch mail with a `correlationId`, auto-nudges, polls for a reply in the same thread, and exits with the reply body (configurable `--timeout`, default 120s)
- **`ov coordinator output`** — show recent coordinator output via tmux `capture-pane` (configurable `--lines`, default 100)
- 334 lines of new test coverage in `src/commands/coordinator.test.ts`

#### Orchestrator Agent Definition
- **`agents/orchestrator.md`** — new base agent definition for multi-repo coordination above the coordinator level
- Defines the orchestrator role: dispatches coordinators per sub-repo via `ov coordinator start --project`, monitors via mail, never modifies code directly
- Named failure modes: `DIRECT_SLING`, `CODE_MODIFICATION`, `SPEC_WRITING`, `OVERLAPPING_REPO_SCOPE`, `OVERLAPPING_FILE_SCOPE`, `DIRECT_MERGE`, `PREMATURE_COMPLETION`, `SILENT_FAILURE`, `POLLING_LOOP`
- 239 lines of agent definition

#### Operator Message Protocol for Coordinator
- **`operator-messages`** section added to `agents/coordinator.md` — defines how coordinators handle synchronous human requests from the CLI
- Reply format: always reply via `ov mail reply` with `correlationId` echo
- Status request format: structured `Active leads` / `Completed` / `Blockers` / `Next actions`
- Dispatch, stop, merge, and unrecognized request handling rules

#### `--project` Global Flag
- **`ov --project <path>`** — target a different project root for any command, overriding auto-detection
- Validates that the target path contains `.overstory/config.yaml`; throws `ConfigError` if missing
- `setProjectRootOverride()` / `getProjectRootOverride()` / `clearProjectRootOverride()` in `src/config.ts`
- 66 lines of new test coverage in `src/config.test.ts`

#### `ov update` Command
- **`ov update`** — refresh `.overstory/` managed files from the installed npm package without requiring a full `ov init`
- Refreshes: agent definitions (`agent-defs/*.md`), `agent-manifest.json`, `hooks.json`, `.gitignore`, `README.md`
- Does NOT touch: `config.yaml`, `config.local.yaml`, SQLite databases, agent state, worktrees, specs, logs, or `.claude/settings.local.json`
- Flags: `--agents`, `--manifest`, `--hooks`, `--dry-run`, `--json`
- Excludes deprecated agent defs (`supervisor.md`)
- 464 lines of test coverage in `src/commands/update.test.ts`

### Changed

- Agent types grew from 7 to 8 (added orchestrator)
- CLI commands grew from 32 to 34 (added `update`, `coordinator send`, `coordinator ask`, `coordinator output`)

### Testing

- 2923 tests across 92 files (6852 `expect()` calls)

## [0.7.9] - 2026-03-03

### Added

#### Gemini CLI Runtime Adapter
- **Gemini CLI** (`gemini`) runtime adapter — full `AgentRuntime` implementation for Google's Gemini coding agent
- TUI-based interactive mode via tmux (Ink-based TUI, similar to Copilot adapter)
- Instruction file: `GEMINI.md` written to worktree root (agent overlay content)
- Sandbox support via `--sandbox` flag, `--approval-mode yolo` for auto-approval
- Headless mode: `gemini -p "prompt"` for one-shot calls
- Transcript parsing from `--output-format stream-json` NDJSON events
- Registered in runtime registry as `"gemini"`, available via `ov sling --runtime gemini`
- 537 lines of test coverage in `src/runtimes/gemini.test.ts`

#### Model Alias Expansion via Environment Variables
- **`ANTHROPIC_DEFAULT_{ALIAS}_MODEL`** env vars — expand model aliases (`sonnet`, `opus`, `haiku`) to specific model IDs at runtime
- `expandAliasFromEnv()` in `src/agents/manifest.ts` checks `ANTHROPIC_DEFAULT_SONNET_MODEL`, `ANTHROPIC_DEFAULT_OPUS_MODEL`, `ANTHROPIC_DEFAULT_HAIKU_MODEL`
- Applied during `resolveModel()` — env var values override default alias resolution
- 169 lines of new test coverage in `src/agents/manifest.test.ts`

### Fixed

- **`.overstory/.gitignore`** — un-ignore `agent-defs/` contents so custom agent definitions are tracked by git
- **CI lint** — fix import sort order in `sling.test.ts`

### Testing

- 2888 tests across 91 files (6768 `expect()` calls)

## [0.7.8] - 2026-03-02

### Added

#### Shell Init Delay
- **`runtime.shellInitDelayMs`** config option — configurable delay between tmux session creation and TUI readiness polling, giving slow shells (oh-my-zsh, nvm, starship, etc.) time to initialize before the agent command starts
- Applied to both `ov sling` and `ov coordinator start` spawn paths
- Validation: must be non-negative number; values above 30s trigger a warning

#### `--base-branch` Flag for `ov sling`
- **`ov sling --base-branch <branch>`** — override the base branch for worktree creation instead of using the canonical branch
- Resolution order: `--base-branch` flag > current HEAD > `config.project.canonicalBranch`
- New `getCurrentBranch()` helper in `src/commands/sling.ts`

#### Token Snapshot Run Tracking
- **`run_id`** column added to `token_snapshots` table — snapshots are now tagged with the active run ID when recorded
- `getLatestSnapshots()` accepts optional `runId` parameter to filter snapshots by run
- `ov costs --live` now scopes to current run when `--run` is provided
- Migration `migrateSnapshotRunIdColumn()` safely adds the column to existing databases

#### Tmux Session State Detection
- **`checkSessionState()`** in `src/worktree/tmux.ts` — detailed session state reporting that distinguishes `"alive"`, `"dead"`, and `"no_server"` states (vs the boolean `isSessionAlive()`)
- Used by coordinator to provide targeted error messages and clean up stale sessions

### Fixed

#### Coordinator Zombie Detection
- **`src/commands/coordinator.ts`** — `ov coordinator start` now detects zombie coordinator sessions (tmux pane exists but agent process has exited) and automatically reclaims them instead of blocking with "already running"
- Stale sessions where tmux is dead or server is not running are now cleaned up before re-spawning
- Handles pid-null edge case (sessions from older schema) conservatively

#### Shell Init Delay Validation
- **`src/config.ts`** — validates `shellInitDelayMs` is a non-negative finite number; warns on values above 30s; falls back to default (0) on invalid input

### Testing
- 2830 tests across 90 files (6689 `expect()` calls)
- **`src/metrics/pricing.test.ts`** — new test suite covering `getPricingForModel()` and `estimateCost()`
- **`src/metrics/store.test.ts`** — snapshot run_id recording and filtering tests
- **`src/commands/coordinator.test.ts`** — zombie detection, stale session cleanup, and pid-null edge case tests
- **`src/commands/sling.test.ts`** — `--base-branch` flag and `getCurrentBranch()` tests
- **`src/config.test.ts`** — `shellInitDelayMs` validation tests
- **`src/worktree/tmux.test.ts`** — `checkSessionState()` tests

## [0.7.7] - 2026-02-27

### Added

#### Codex Runtime Adapter
- **`src/runtimes/codex.ts`** — new `CodexRuntime` adapter implementing the `AgentRuntime` interface for OpenAI's `codex` CLI, with headless `codex exec` mode, OS-level sandbox security (Seatbelt/Landlock), `AGENTS.md` instruction path, and NDJSON event stream parsing for token usage
- **`src/runtimes/codex.test.ts`** — comprehensive test suite (741 lines) covering spawn command building, config deployment, readiness detection, and transcript parsing
- **Runtime registry** now includes `codex` alongside `claude`, `pi`, and `copilot`

#### Documentation
- **`docs/runtime-adapters.md`** — contributor guide (991 lines) covering the `AgentRuntime` interface, all four built-in adapters, the registry pattern, and a step-by-step walkthrough for adding new runtimes

### Changed

#### Dashboard Redesign
- **`src/commands/dashboard.ts`** — rewritten with rolling event buffer, compact panels, and new multi-panel layout (Agents 60% + Tasks/Feed 40%, Mail + Merge Queue row, Metrics row)

### Fixed
- **`src/commands/init.test.ts`** — use no-op spawner in init tests to avoid CI failures from tmux/subprocess side effects

### Testing
- 2779 tests across 89 files (6591 `expect()` calls)

## [0.7.6] - 2026-02-27

### Added

#### Copilot Runtime Adapter
- **`src/runtimes/copilot.ts`** — new `CopilotRuntime` adapter implementing the `AgentRuntime` interface for GitHub Copilot's `copilot` CLI, with `--allow-all-tools` permission mode, `.github/copilot-instructions.md` instruction path, and transcript parsing support
- **`src/runtimes/copilot.test.ts`** — comprehensive test suite (507 lines) covering spawn command building, config deployment, readiness detection, and transcript parsing
- **Runtime registry** now includes `copilot` alongside `claude` and `pi`

#### Ecosystem Bootstrap in `ov init`
- **`ov init` now bootstraps sibling os-eco tools** — automatically runs `mulch init`, `sd init`, and `cn init` when the respective CLIs are available; adds CLAUDE.md onboarding sections for each tool
- **New flags:** `--tools <list>` (comma-separated tool selection), `--skip-mulch`, `--skip-seeds`, `--skip-canopy`, `--skip-onboard`, `--json`
- **`src/commands/init.test.ts`** — expanded with ecosystem bootstrap tests (335 lines total)

#### Doctor Provider Checks
- **`src/doctor/providers.ts`** — new `providers` check category (11th category) validating gateway provider reachability, auth token environment variables, and tool-use compatibility for multi-runtime configurations
- **`src/doctor/providers.test.ts`** — test suite (373 lines) covering provider validation scenarios

#### Multi-Provider Model Pricing
- **`src/metrics/pricing.ts`** — extended with OpenAI (GPT-4o, GPT-4o-mini, GPT-5, o1, o3) and Google Gemini (Flash, Pro) pricing alongside existing Claude tiers

#### Cost Analysis Enhancements
- **`--bead <id>` flag for `ov costs`** — filter cost breakdown by task/bead ID via new `MetricsStore.getSessionsByTask()` method
- **Runtime-aware transcript discovery** — `ov costs --self` now resolves transcript paths through the runtime adapter instead of hardcoding Claude Code paths

#### Agent Discovery Improvements
- **Runtime-aware instruction path** in `ov agents discover` — `extractFileScope()` now tries the configured runtime's `instructionPath` before falling back to `KNOWN_INSTRUCTION_PATHS`

### Changed

- **CI: CHANGELOG-based GitHub release notes** — publish workflow now extracts the version's CHANGELOG.md section for release notes instead of auto-generating from commits; falls back to `--generate-notes` if no entry found

### Fixed

- **Pi coding agent URL** updated in README to correct repository path

#### Testing
- 2714 tests across 88 files (6481 `expect()` calls)

## [0.7.5] - 2026-02-26

### Fixed

- **tmux "command too long" error** — coordinator, monitor, and supervisor commands now pass agent definition file paths instead of inlining content via `--append-system-prompt`; the shell inside the tmux pane reads the file via `$(cat ...)` at runtime, keeping the tmux IPC message small regardless of agent definition size (fixes #45)
- **Biome formatting** in seeds tracker test (`src/tracker/seeds.test.ts`)

### Changed

- **`SpawnOpts.appendSystemPromptFile`** — new option in `AgentRuntime` interface (`src/runtimes/types.ts`) for file-based system prompt injection; both Claude and Pi runtime adapters support it with fallback to inline `appendSystemPrompt`
- **README and package description** updated to be runtime-agnostic, reflecting the `AgentRuntime` abstraction

#### Testing
- 2612 tests across 86 files (6277 `expect()` calls)

## [0.7.4] - 2026-02-26

### Added

#### Runtime-Agnostic Pricing Module
- **`src/metrics/pricing.ts`** — extracted pricing logic from `transcript.ts` into a standalone module with `TokenUsage`, `ModelPricing`, `getPricingForModel()`, and `estimateCost()` exports, enabling any runtime (not just Claude Code) to use cost estimation without pulling in JSONL-specific parsing logic

#### Multi-Runtime Instruction File Discovery
- **`KNOWN_INSTRUCTION_PATHS`** in `agents.ts` — `extractFileScope()` now tries `.claude/CLAUDE.md` then `AGENTS.md` (future Codex support) instead of hardcoding Claude Code's overlay path

#### Mulch Classification Guidance
- **`--classification` guidance in all 8 agent definitions** — builder, coordinator, lead, merger, monitor, reviewer, and scout definitions updated with `--classification <foundational|tactical|observational>` guidance for `ml record` commands, with inline descriptions of when to use each classification level

#### Pi Runtime Improvements
- **`agent_end` handler in Pi guard extensions** — Pi agents now log `session-end` when the agentic loop completes (via `agent_end` event), preventing watchdog false-positive zombie escalation; `session_shutdown` handler kept as a safety net for crashes and force-kills
- **`--tool-name` forwarding** in Pi guard extensions — `ov log tool-start` and `ov log tool-end` calls now correctly forward the tool name

#### Testing
- **Tracker adapter test suites** — comprehensive tests for beads (`src/tracker/beads.test.ts`, 454 lines) and seeds (`src/tracker/seeds.test.ts`, 469 lines) backends covering CLI invocation, JSON parsing, error handling, and edge cases
- Test suite grew from 2550 to 2607 tests across 86 files (6269 expect() calls)

### Fixed
- **`OVERSTORY_GITIGNORE` import in `prime.ts`** — removed duplicate constant definition, now imports from `init.ts` where the canonical constant lives
- **Pi agent zombie-state bug** — without the `agent_end` handler, completed Pi agents were never marked "completed" in the SessionStore, causing the watchdog to escalate them through stalled → nudge → triage → terminate
- **Shell completions for `sling`** — added missing `--runtime` flag to shell completion definitions (PR #39, thanks [@lucabarak](https://github.com/lucabarak))
- **`cleanupTempDir` ENOENT/EBUSY handling** — tightened catch block for ENOENT errors and added retry logic for EBUSY from SQLite WAL handles on Windows (#41)

## [0.7.3] - 2026-02-26

### Added

#### Outcome Feedback Loop
- **Mulch outcome tracking** — sling now captures applied mulch record IDs at spawn time (saved to `.overstory/agents/{name}/applied-records.json`) and `ov log session-end` appends "success" outcomes back to those records, closing the expertise feedback loop
- `MulchClient.appendOutcome()` method for programmatic outcome recording with status, duration, agent, notes, and test results fields

#### Mulch Search/Prime Enrichment
- `--classification` filter for mulch search (foundational, tactical, observational)
- `--outcome-status` filter for mulch search (success, failure)
- `--sort-by-score` support in mulch prime for relevance-ranked expertise injection

#### Dashboard Redesign
- **Tasks panel** — upper-right quadrant displays tracker issues with priority colors
- **Feed panel** — lower-right quadrant shows recent events from the last 5 minutes
- `dimBox` — dimmed box-drawing characters for less aggressive panel borders
- `computeAgentPanelHeight()` — dynamic agent panel sizing (min 8, max 50% screen, scales with agent count)
- Tracker caching with 10s TTL to reduce repeated CLI calls
- Layout restructured to 60/40 split (agents left, tasks+feed right) with 50/50 mail/merge at bottom

#### Formatting
- `formatEventLine()` — centralized compact event formatting with agent colors and event labels (used by both feed and dashboard)
- `numericPriorityColor()` — maps numeric priorities (1–4) to semantic colors
- `buildAgentColorMap()` and `extendAgentColorMap()` — stable color assignment for agents by appearance order

#### Sling
- `--no-scout-check` flag to suppress scout-before-build warning
- `shouldShowScoutWarning()` — testable logic for when to warn about missing scouts

#### Testing
- 2550 tests across 84 files (6167 `expect()` calls), up from 2476/83/6044
- New `src/logging/format.test.ts` — coverage for event line formatting and color utilities

### Fixed

#### Pi Runtime
- **EventStore visibility** — removed stdin-only gate on EventStore writes so Pi agents get full event tracking without stdin payload (`ov log tool-start`/`tool-end`)
- **Tool name forwarding** — Pi guard extensions now pass `--tool-name` to `ov log` calls, fixing missing tool names in event timelines

#### Shell Completions
- Added missing `--runtime` flag to sling completions
- Synced all shell completion scripts (bash/zsh/fish) with current CLI commands and flags
- Added `--no-scout-check` and `--all` (dashboard) to completions

#### Feed
- Restored `formatEventLine()` usage lost during dashboard-builder merge conflict

#### Testing Infrastructure
- Retry temp dir cleanup on EBUSY from SQLite WAL handles (exponential backoff, 5 retries) — fixes flaky cleanup on Windows
- Tightened `cleanupTempDir()` ENOENT handling

### Changed

- Dashboard layout restructured from single-column to multi-panel grid with dynamic sizing
- Feed and dashboard now share centralized event formatting via `formatEventLine()`
- Brand color lightened for better terminal contrast

## [0.7.2] - 2026-02-26

### Added

#### Pi Runtime Enhancements
- **Configurable model alias expansion** — `PiRuntimeConfig` type with `provider` + `modelMap` fields so bare aliases like "opus" are correctly expanded to provider-qualified model IDs (e.g., "anthropic/claude-opus-4-6"), configurable via `config.yaml` runtime.pi section
- **`requiresBeaconVerification?()`** — optional method on `AgentRuntime` interface; Pi returns `false` to skip the beacon resend loop that spams duplicate startup messages (Pi's idle/processing states are indistinguishable via pane content)
- Config validation for `runtime.pi.provider` and `runtime.pi.modelMap` entries

### Fixed

#### Pi Runtime
- **Zombie-state bug** — Pi agents were stuck in zombie state because pi-guards.ts used the old `() => Extension` object-style API instead of the correct `(pi: ExtensionAPI) => void` factory style; guards were never firing. Rewritten to ExtensionAPI factory format with proper `event.toolName` and `{ block, reason }` returns
- **Activity tracking** — Added `pi.on(tool_call/tool_execution_end/session_shutdown)` handlers so `lastActivity` updates and the watchdog no longer misclassifies active Pi agents as zombies
- **Beacon verification loop** — `sling.ts` now skips the beacon resend loop when `runtime.requiresBeaconVerification()` returns `false`, preventing duplicate startup messages for Pi agents
- **`detectReady()`** — Fixed to check for Pi TUI header (`pi v`) + token-usage status bar regex instead of `model:` which Pi never emits
- Pi guard extension tests updated for ExtensionAPI format (8 fixes + 7 new tests)

#### Agent Definitions
- Replaced 54 hardcoded "bead" references in agent base definitions with tracker-agnostic terminology (task/issue); `{{TRACKER_CLI}}` and `{{TRACKER_NAME}}` placeholders remain for CLI commands
- Fixed overlay fallback default from "bd" to "sd" (seeds is the preferred tracker)

### Changed

- **Supervisor agent soft-deprecated** — `ov supervisor` commands marked `[DEPRECATED]` with stderr warning on `start`; supervisor removed from default agent manifest and `ov init` agent-defs copy; `supervisor.md` retains deprecation notice but code is preserved for backward compatibility
- `biome.json` excludes `.pi/` directory from linting (generated extension files)

### Testing

- 2476 tests across 83 files (6044 `expect()` calls)

## [0.7.1] - 2026-02-26

### Added

#### Pi Runtime Adapter
- **`src/runtimes/pi.ts`** — `PiRuntime` adapter implementing `AgentRuntime` for Mario Zechner's Pi coding agent — `buildSpawnCommand()` maps to `pi --model`, `deployConfig()` writes `.pi/extensions/overstory-guard.ts` + `.pi/settings.json`, `detectReady()` looks for Pi TUI header, `parseTranscript()` handles Pi's top-level `message_end` / `model_change` JSONL format
- **`src/runtimes/pi-guards.ts`** — Pi guard extension generator (`generatePiGuardExtension()`) — produces self-contained TypeScript files for `.pi/extensions/` that enforce the same security policies as Claude Code's `settings.local.json` PreToolUse hooks (team tool blocking, write tool blocking, path boundary enforcement, dangerous bash pattern detection)
- **`src/runtimes/types.ts`** — `RuntimeConnection` interface for RPC lifecycle: `sendPrompt()`, `followUp()`, `abort()`, `getState()`, `close()` — enables direct stdin/stdout communication with runtimes that support it (Pi JSON-RPC), bypassing tmux for mail delivery, shutdown, and health checks
- **`src/runtimes/types.ts`** — `RpcProcessHandle` and `ConnectionState` supporting types for the RPC connection interface
- **`AgentRuntime.connect?()`** — optional method on the runtime interface for establishing direct RPC connections; orchestrator checks `if (runtime.connect)` before calling, falls back to tmux when absent
- Pi runtime registered in `src/runtimes/registry.ts`

#### Guard Rule Extraction
- **`src/agents/guard-rules.ts`** — extracted shared guard constants (`NATIVE_TEAM_TOOLS`, `INTERACTIVE_TOOLS`, `WRITE_TOOLS`, `DANGEROUS_BASH_PATTERNS`, `SAFE_BASH_PREFIXES`) from `hooks-deployer.ts` into a pure data module — single source of truth consumed by both Claude Code hooks and Pi guard extensions

#### Transcript Path Decoupling
- **`transcriptPath` field on `AgentSession`** — new nullable column in sessions.db, populated by runtimes that report their transcript location directly instead of relying on `~/.claude/projects/` path inference
- **`SessionStore.updateTranscriptPath()`** — new method to set transcript path per agent
- **`ov log` transcript resolution** — now checks `session.transcriptPath` first before falling back to legacy `~/.claude/projects/` heuristic; discovered paths are also written back to the session store for future lookups
- SQLite migration (`migrateAddTranscriptPath`) adds the column to existing databases safely

#### `runtime.printCommand` Config Field
- **`OverstoryConfig.runtime.printCommand`** — new optional config field for routing headless one-shot AI calls (merge resolver, watchdog triage) through a specific runtime adapter, independent of the default interactive runtime

#### Testing
- **`src/runtimes/pi.test.ts`** — 526-line test suite covering all 7 `AgentRuntime` methods for the Pi adapter
- **`src/runtimes/pi-guards.test.ts`** — 389-line test suite for Pi guard extension generation across capabilities, path boundaries, and edge cases
- Test suite: 2458 tests across 83 files (6026 `expect()` calls)

### Fixed
- **Watchdog completion nudges clarified as informational** — `buildCompletionMessage()` now says "Awaiting lead verification" instead of "Ready for merge/cleanup", preventing coordinators from prematurely merging based on watchdog nudges
- **Coordinator `PREMATURE_MERGE` anti-pattern strengthened** — coordinator.md now explicitly states that watchdog nudges are informational only and that only a typed `merge_ready` mail from the owning lead authorizes a merge
- **`transcriptPath: null` added to all `AgentSession` constructions** — fixes schema consistency across coordinator, supervisor, monitor, and sling agent creation paths

### Changed
- **`deployHooks()` replaced by `runtime.deployConfig()`** — coordinator, supervisor, monitor, and sling now use the runtime abstraction for deploying hooks/guards instead of calling `deployHooks()` directly, enabling Pi (and future runtimes) to deploy their native guard mechanisms
- **`merge/resolver.ts` wired through `runtime.buildPrintCommand()`** — AI-assisted merge resolution (Tier 3 and Tier 4) now uses the configured runtime for headless calls instead of hardcoding `claude --print`
- **`watchdog/triage.ts` wired through `runtime.buildPrintCommand()`** — AI-assisted failure triage now uses the configured runtime for headless calls instead of hardcoding `claude --print`
- **`writeOverlay()` receives `runtime.instructionPath`** — sling now threads the runtime's instruction file path through overlay generation, so beacon and auto-dispatch messages reference the correct file (e.g. `.claude/CLAUDE.md` for Claude, same for Pi)

## [0.7.0] - 2026-02-25

### Added

#### AgentRuntime Abstraction Layer
- **`src/runtimes/types.ts`** — `AgentRuntime` interface defining the contract for multi-provider agent support: `buildSpawnCommand()`, `buildPrintCommand()`, `deployConfig()`, `detectReady()`, `parseTranscript()`, `buildEnv()`, plus supporting types (`SpawnOpts`, `ReadyState`, `OverlayContent`, `HooksDef`, `TranscriptSummary`)
- **`src/runtimes/claude.ts`** — `ClaudeRuntime` adapter implementing `AgentRuntime` for Claude Code CLI — delegates to existing subsystems (hooks-deployer, transcript parser) without new behavior
- **`src/runtimes/registry.ts`** — Runtime registry with `getRuntime()` factory — lookup by name, config default, or hardcoded "claude" fallback
- **`docs/runtime-abstraction.md`** — Design document covering coupling inventory, phased migration plan, and adapter contract rationale
- **`--runtime <name>` flag** on `ov sling` — allows per-agent runtime override (defaults to config or "claude")
- **`runtime.default` config field** — new optional `OverstoryConfig.runtime.default` property for setting the default runtime adapter

#### Testing
- **`src/runtimes/claude.test.ts`** — 616-line test suite for ClaudeRuntime adapter covering all 7 interface methods
- **`src/runtimes/registry.test.ts`** — Registry tests for name lookup, config default fallback, and unknown runtime errors
- **`src/commands/sling.test.ts`** — Additional sling tests for runtime integration
- **`src/agents/overlay.test.ts`** — Tests for parameterized `instructionPath` in `writeOverlay()`
- 2357 tests across 81 files (5857 `expect()` calls)

### Changed

#### Runtime Rewiring (Phase 2)
- **`src/commands/sling.ts`** — Rewired to use `AgentRuntime.buildSpawnCommand()` and `detectReady()` instead of hardcoded `claude` CLI construction and TUI heuristics
- **`src/commands/coordinator.ts`** — Rewired to use `AgentRuntime` for spawn command building, env construction, and TUI readiness detection
- **`src/commands/supervisor.ts`** — Rewired to use `AgentRuntime` for spawn command building and TUI readiness detection
- **`src/commands/monitor.ts`** — Rewired to use `AgentRuntime` for spawn command building and env construction
- **`src/worktree/tmux.ts`** — `waitForTuiReady()` now accepts a `detectReady` callback instead of hardcoded Claude Code TUI heuristics, making it runtime-agnostic
- **`src/agents/overlay.ts`** — `writeOverlay()` now accepts an optional `instructionPath` parameter (default: `.claude/CLAUDE.md`), enabling runtime-specific instruction file paths

#### Branding
- README.md: replaced ASCII ecosystem diagram with os-eco logo image

## [0.6.12] - 2026-02-25

### Added

#### Shared Visual Primitives
- **`src/logging/theme.ts`** — canonical visual theme for CLI output: agent state colors/icons, event type labels (compact + full), agent color palette for multi-agent displays, separator characters, and header/sub-header rendering helpers
- **`src/logging/format.ts`** — shared formatting utilities: duration formatting (`formatDuration`), absolute/relative/date timestamp formatting, event detail builder (`buildEventDetail`), agent color mapping (`buildAgentColorMap`/`extendAgentColorMap`), status color helpers for merge/priority/log-level

#### Theme/Format Adoption Across Observability Commands
- Dashboard, status, inspect, metrics, run, and costs commands refactored to use shared theme/format primitives — eliminates duplicated color maps, duration formatters, and separator rendering across 6 commands
- Errors, feed, logs, replay, and trace commands refactored to use shared theme/format primitives — eliminates duplicated event label rendering, timestamp formatting, and agent color assignment across 5 commands
- Net code reduction: ~826 lines removed, replaced by ~214+132 lines of shared primitives

#### Mulch Programmatic API Migration
- `MulchClient.record()`, `search()`, and `query()` migrated from `Bun.spawn` CLI wrappers to `@os-eco/mulch-cli` programmatic API — eliminates subprocess overhead for high-frequency expertise operations
- **`@os-eco/mulch-cli` added as runtime dependency** (^0.6.2) — first programmatic API dependency in the ecosystem
- Variable-based dynamic import pattern (`const MULCH_PKG = "..."; import(MULCH_PKG)`) prevents tsc from statically resolving into mulch's raw `.ts` source files
- Local `MulchExpertiseRecord` and `MulchProgrammaticApi` type definitions avoid cross-project `noUncheckedIndexedAccess` conflicts

#### MetricsStore Improvements
- **`countSessions()`** method — returns total session count without the `LIMIT` cap that `getRecentSessions()` applies, fixing accurate session count reporting in metrics views

#### Lead Agent Workflow Improvements
- **`WORKTREE_ISSUE_CREATE` failure mode** — prevents leads from running `{{TRACKER_CLI}} create` in worktrees, where issues are lost on cleanup
- Lead workflow updated to **mail coordinator for issue creation** instead of direct tracker CLI calls — coordinator creates issues on main branch
- Scout/builder/reviewer spawning simplified with `--skip-task-check` — removes the pattern of creating separate tracker issues for each sub-agent
- `{{TRACKER_CLI}} create` removed from lead capabilities list

#### Testing
- Test suite grew from 2283 to 2288 tests across 79 files (5744 expect() calls)

### Changed
- 12 observability commands consolidated onto shared `theme.ts` + `format.ts` primitives — reduces per-command boilerplate and ensures visual consistency across all CLI output
- `@types/js-yaml` added as dev dependency (^4.0.9)

### Fixed
- Static imports of `theme.ts`/`format.ts` replaced with variable-based dynamic pattern to fix typecheck errors when tsc follows into mulch's raw `.ts` source files
- `getRecentSessions()` limit cap no longer affects session count reporting — dedicated `countSessions()` method provides uncapped counts

## [0.6.11] - 2026-02-25

### Added

#### Per-Lead Agent Budget Ceiling
- **`agents.maxAgentsPerLead` config** (default: 5) — limits how many active children a single lead agent can spawn; set to 0 for unlimited
- **`--max-agents <n>` flag on `ov sling`** — CLI override for the per-lead ceiling when spawning under a parent
- **`checkParentAgentLimit()`** — pure-function guard that counts active children per parent and blocks spawns at the limit

#### Dispatch-Level Overrides
- **`--skip-review` flag on `ov sling`** — instructs a lead agent to skip Phase 3 review and self-verify instead (reads builder diff + runs quality gates)
- **`--dispatch-max-agents <n>` flag on `ov sling`** — per-lead agent ceiling override injected into the overlay so the lead knows its budget
- **`formatDispatchOverrides()`** in overlay system — generates a `## Dispatch Overrides` section in lead overlays when `skipReview` or `maxAgentsOverride` are set
- **`dispatch-overrides` section in `agents/lead.md`** — documents the override protocol so leads know to check their overlay before following the default three-phase workflow
- **`DispatchPayload` extended** with `skipScouts`, `skipReview`, and `maxAgents` optional fields

#### Duplicate Lead Prevention
- **`checkDuplicateLead()`** — prevents two lead agents from concurrently working the same task ID, avoiding the duplicate work stream anti-pattern (overstory-gktc postmortem)

#### Mail Refactoring
- **`shouldAutoNudge()` and `isDispatchNudge()`** exported from mail.ts for testability — previously inlined logic now unit-testable
- **`AUTO_NUDGE_TYPES`** exported as `ReadonlySet` for direct test assertions

#### Testing
- **`sling.test.ts`** — expanded (201 lines added) covering `checkDuplicateLead`, `checkParentAgentLimit`, per-lead budget ceiling enforcement, and dispatch override validation
- **`overlay.test.ts`** — expanded (236 lines added) covering `formatDispatchOverrides`, skip-review overlay, max-agents overlay, and combined overrides
- **`mail.test.ts`** — expanded (64 lines added) covering `shouldAutoNudge`, `isDispatchNudge`, and dispatch nudge behavior
- **`hooks-deployer.test.ts`** — new test file (105 lines) covering hooks deployment and configurable safe prefix extraction
- **`config.test.ts`** — expanded (22 lines added) covering `maxAgentsPerLead` validation

### Changed

- **Terminology normalization** — replaced "beads" with "task" throughout CLI copy and generic code: `checkBeadLock` → `checkTaskLock`, `{{BEAD_ID}}` → `{{TASK_ID}}` in overlay template, error messages updated ("Bead is already being worked" → "Task is already being worked")
- **README unified** to canonical os-eco template — shortened, restructured with table-based CLI reference, consistent badge style
- **`agents/lead.md`** — added `dispatch-overrides` section documenting SKIP REVIEW and MAX AGENTS override protocol
- **Default tracker name** changed from `"beads"` to `"seeds"` in overlay fallback

### Fixed

- **`ov trace` description** — changed from "agent/bead" to "agent or task" for consistency with terminology normalization

### Testing
- 2283 tests across 79 files (5749 `expect()` calls)

## [0.6.10] - 2026-02-25

### Added

#### New CLI Commands
- **`ov ecosystem`** — dashboard showing all installed os-eco tools (overstory, mulch, seeds, canopy) with version info, update status (current vs latest from npm), and overstory doctor health summary; supports `--json` output
- **`ov upgrade`** — upgrade overstory (or all ecosystem tools with `--all`) to their latest npm versions via `bun install -g`; `--check` flag compares versions without installing; supports `--json` output

#### `ov doctor` Enhancements
- **`--fix` flag** — auto-fix capability for doctor checks; fixable checks now include repair closures that are executed when `--fix` is passed, with human-readable action summaries
- **Fix closures added to all check modules** — structure, databases, merge-queue, and ecosystem checks now return fix functions that can recreate missing directories, reinitialize databases, and reinstall tools
- **`ecosystem` check category** — new 10th doctor category validating that os-eco CLI tools (ml, sd, cn) are on PATH and report valid semver versions; fix closures reinstall via `bun install -g`

#### Global CLI Flag
- **`--timing` flag** — prints command execution time to stderr after any command completes (e.g., `Done in 42ms`)

#### Configurable Quality Gates
- **Quality gate placeholders in agent prompts** — agent base definitions (builder, merger, reviewer, lead) now use `{{QUALITY_GATE_*}}` placeholders instead of hardcoded `bun test`/`bun run lint`/`bun run typecheck` commands, driven by `project.qualityGates` config
- **4 quality gate formatter functions** — `formatQualityGatesInline`, `formatQualityGateSteps`, `formatQualityGateBash`, `formatQualityGateCapabilities` added to overlay system for flexible placeholder resolution
- **Configurable safe command prefixes** — `SAFE_BASH_PREFIXES` in hooks-deployer now dynamically extracted from quality gate config via `extractQualityGatePrefixes()`, replacing hardcoded `bun test`/`bun run lint`/`bun run typecheck` entries
- **Config-driven hooks deployment** — `sling.ts` now passes `config.project.qualityGates` through to `deployHooks()` so non-implementation agents can run project-specific quality gate commands

#### Testing
- **`ecosystem.test.ts`** — new test file (307 lines) covering ecosystem command output, JSON mode, and tool detection
- **`upgrade.test.ts`** — new test file (46 lines) covering upgrade command registration and option parsing
- **`databases.test.ts`** — new test file (38 lines) covering database health check fix closures
- **`merge-queue.test.ts`** — new test file (98 lines) covering merge queue health check and fix closures
- **`structure.test.ts`** — expanded (131 lines added) covering structure check fix closures for missing directories
- **`overlay.test.ts`** — expanded (157 lines added) covering quality gate formatters and placeholder resolution
- **`hooks-deployer.test.ts`** — expanded (52 lines added) covering configurable safe prefix extraction

### Changed

- **Agent base definitions updated** — builder, merger, reviewer, and lead `.md` files now use `{{QUALITY_GATE_*}}` template placeholders instead of hardcoded bun commands
- **`DEFAULT_QUALITY_GATES` consolidated** — removed duplicate definition from `overlay.ts`, now imported from `config.ts` as single source of truth

### Fixed

- **`DoctorCheck.fix` return type** — changed from `void` to `string[]` so fix closures can report what actions were taken
- **Feed follow-mode `--json` output** — now uses `jsonOutput` envelope instead of raw `JSON.stringify`
- **`--timing` preAction** — correctly reads `opts.timing` from global options instead of hardcoded check
- **`process.exit(1)` in completions.ts** — replaced with `process.exitCode = 1; return` to avoid abrupt process termination

### Testing
- 2241 tests across 79 files (5694 `expect()` calls)

## [0.6.9] - 2026-02-25

### Added

#### `ov init` Enhancements
- **`--yes` / `-y` flag** — skip interactive confirmation prompts for scripted/automated initialization (contributed by @lucabarak via PR #37)
- **`--name <name>` flag** — explicitly set the project name instead of auto-detecting from git remote or directory name

#### Standardized JSON Output Across All Commands
- **JSON envelope applied to all remaining commands** — four batches (A, B, C, D) migrated every `--json` code path to use the `jsonOutput()`/`jsonError()` envelope format (`{ success, command, ...data }`), completing the ecosystem-wide standardization started in 0.6.8

#### Accented ID Formatting
- **`accent()` applied to IDs in human-readable output** — agent names, mail IDs, group IDs, run IDs, and task IDs now render with accent color formatting across status, dashboard, inspect, agents, mail, merge, group, run, trace, and errors commands

#### Testing
- **`hooks-deployer.test.ts`** — new test file (180 lines) covering hooks deployment to worktrees
- **`init.test.ts`** — new test file (104 lines) covering `--yes` and `--name` flag behavior

### Changed

#### Print Helper Adoption
- **Completions, prime, and watch commands migrated to print helpers** — remaining commands that used raw `console.log`/`console.error` now use `printSuccess`/`printWarning`/`printError`/`printHint` for consistent output formatting

### Fixed

- **PATH prefix for hook commands** — deployed hooks now include `~/.bun/bin` in the PATH prefix, fixing resolution failures when bun-installed CLIs (like `ov` itself) weren't found by hook subprocesses
- **Reinit messaging for `--yes` flag** — corrected output messages when re-initializing an existing `.overstory/` directory with the `--yes` flag

### Testing
- 2186 tests across 77 files (5535 `expect()` calls)

## [0.6.8] - 2026-02-25

### Added

#### Standardized CLI Output Helpers
- **`jsonOutput()` / `jsonError()` helpers** (`src/json.ts`) — standard JSON envelope format (`{ success, command, ...data }`) matching the ecosystem convention used by mulch, seeds, and canopy
- **`printSuccess()` / `printWarning()` / `printError()` / `printHint()` helpers** (`src/logging/color.ts`) — branded message formatters with consistent color/icon treatment (brand checkmark, yellow `!`, red cross, dim indent)

#### Enhanced CLI Help & Error Experience
- **Custom branded help screen** — `ov --help` now shows a styled layout with colored command names, dim arguments, and version header instead of Commander.js defaults
- **`--version --json` flag** — `ov -v --json` outputs machine-readable JSON (`{ name, version, runtime, platform }`)
- **Unknown command fuzzy matching** — typos like `ov stauts` now suggest the closest match via Levenshtein edit distance ("Did you mean 'status'?")

#### TUI Trust Dialog Handling
- **Auto-confirm workspace trust dialog** — `waitForTuiReady` now detects "trust this folder" prompts and sends Enter automatically, preventing agents from stalling on first-time workspace access

### Changed

#### Consistent Message Formatting Across All Commands
- **All 30 commands migrated to message helpers** — three batches (A, B, C) updated every command to use `printSuccess`/`printWarning`/`printError`/`printHint` instead of ad-hoc `console.log`/`console.error` calls, ensuring uniform output style
- **Global error handler uses `jsonError()`** — top-level catch in `index.ts` now outputs structured JSON envelopes when `--json` is passed, instead of raw `console.error`

#### TUI Readiness Detection
- **Two-phase readiness check** — `waitForTuiReady` now requires both a prompt indicator (`❯` or `Try "`) AND status bar text (`bypass permissions` or `shift+tab`) before declaring the TUI ready, preventing premature beacon submission

#### Agent Definition Cleanup
- **Slash-command prompts moved to `.claude/commands/`** — `issue-reviews.md`, `pr-reviews.md`, `prioritize.md`, and `release.md` removed from `agents/` directory (they are skill definitions, not agent base definitions)
- **Agent definition wording updates** — minor reference fixes across coordinator, lead, merger, reviewer, scout, and supervisor base definitions

### Fixed

- **`color.test.ts` mocking** — tests now mock `process.stdout.write`/`process.stderr.write` instead of `console.log`/`console.error` to match actual implementation
- **`mulch client test`** updated for auto-create domain behavior
- **`mulch` → `ml` alias in tests** — test files migrated to use the `ml` short alias consistently

### Testing
- 2167 tests across 77 files (5465 `expect()` calls)

## [0.6.7] - 2026-02-25

### Fixed

#### Permission Flag Migration
- **Replace `--dangerously-skip-permissions` with `--permission-mode bypassPermissions`** across all agent spawn paths (coordinator, supervisor, sling, monitor) — adapts to updated Claude Code CLI flag naming

#### Status Output
- **Remove remaining emoji from `ov status` output** — section headers (Agents, Worktrees, Mail, Merge queue, Sessions recorded) and deprecation warning now use plain text; alive markers use colored `>`/`x` instead of `●`/`○`

### Changed

#### Agent Spawn Reliability
- **Increase TUI readiness timeout from 15s to 30s** — `waitForTuiReady` now waits longer for Claude Code TUI to initialize, reducing false-negative timeouts on slower machines
- **Smarter TUI readiness detection** — `waitForTuiReady` now checks for actual TUI markers (`❯` prompt or `Try "` text) instead of any pane content, preventing premature readiness signals
- **Extend follow-up Enter delays** — beacon submission retries expanded from `[1s, 2s]` to `[1s, 2s, 3s, 5s]` in sling, coordinator, and supervisor, improving reliability when Claude Code TUI initializes slowly

### Testing
- 2151 tests across 76 files (5424 `expect()` calls)

## [0.6.6] - 2026-02-24

### Changed

#### CLI Alias Migration
- **`overstory` → `ov` across all CLI-facing text** — every user-facing string, error message, help text, and command comment across all `src/commands/*.ts` files now references `ov` instead of `overstory`
- **`mulch` → `ml` in agent definitions and overlay** — all 8 base agent definitions (`agents/*.md`), overlay template (`templates/overlay.md.tmpl`), and overlay generator (`src/agents/overlay.ts`) updated to use the `ml` short alias
- **Templates and hooks updated** — `templates/CLAUDE.md.tmpl`, `templates/hooks.json.tmpl`, and deployed agent defs all reference `ov`/`ml` aliases
- **Canopy prompts re-emitted** — all canopy-managed prompts regenerated with alias-aware content

#### Emoji-Free CLI Output (Set D Icons)
- **Status icons replaced with ASCII Set D** — dashboard, status, and sling output now use `>` (working), `-` (booting), `!` (stalled), `x` (zombie/completed), `?` (unknown) instead of Unicode circles and checkmarks
- **All emoji removed from CLI output** — warning prefixes, launch messages, and status indicators no longer use emoji characters, improving compatibility with terminals that lack Unicode support

### Added

#### Sling Reliability
- **Auto-dispatch mail before tmux session** — `buildAutoDispatch()` sends dispatch mail to the agent's mailbox before creating the tmux session, eliminating the race where coordinator dispatch arrives after the agent boots and sits idle
- **Beacon verification loop** — after beacon send, sling polls the tmux pane up to 5 times (2s intervals) to detect if the agent is still on the welcome screen; if so, resends the beacon automatically (fixes overstory-3271)
- **`capturePaneContent()` exported from tmux.ts** — new helper for reading tmux pane text, used by beacon verification

#### Binary Detection
- **`detectOverstoryBinDir()` tries both `ov` and `overstory`** — loops through both command names when resolving the binary directory, ensuring compatibility regardless of how the tool was installed

#### Claude Code Skills
- **`/release` skill** — prepares releases by analyzing changes, bumping versions, updating CHANGELOG/README/CLAUDE.md
- **`/issue-reviews` skill** — reviews GitHub issues from within Claude Code
- **`/pr-reviews` skill** — reviews GitHub pull requests from within Claude Code

#### Testing
- Test suite: 2151 tests across 76 files (5424 expect() calls)

### Fixed
- **Mail dispatch race for newly slung agents** — dispatch mail is now written to SQLite before tmux session creation, ensuring it exists when the agent's SessionStart hook fires `ov mail check`
- **`process.exit(1)` replaced with `process.exitCode = 1`** — CLI entry point no longer calls `process.exit()` directly, allowing Bun to clean up gracefully (async handlers, open file descriptors)
- **Remaining `beadId` → `taskId` references** — completed rename in `trace.ts`, `trace.test.ts`, `spec.ts`, `worktree.test.ts`, and canopy prompts for coordinator/supervisor
- **Post-merge quality gate failures** — fixed lint and type errors introduced during multi-agent merge sessions
- **Mail test assertions** — updated to match lowercase Warning/Note output after emoji removal

## [0.6.5] - 2026-02-24

### Added

#### Seeds Preservation for Lead Branches
- **`preserveSeedsChanges()` in worktree manager** — extracts `.seeds/` diffs from lead agent branches and applies them to the canonical branch via patch before worktree cleanup, preventing loss of issue files created by leads whose branches are never merged through the normal merge pipeline
- Integrated into `overstory worktree clean` — automatically preserves seeds changes before removing completed worktrees

#### Merge Union Gitattribute Support
- **`resolveConflictsUnion()` in merge resolver** — new auto-resolve strategy for files with `merge=union` gitattribute that keeps all lines from both sides (canonical + incoming), relying on dedup-on-read to handle duplicates
- **`checkMergeUnion()` helper** — queries `git check-attr merge` to detect union merge strategy per file
- Auto-resolve tier now checks gitattributes before choosing between keep-incoming and union resolution strategies

#### Sling Preflight
- **`ensureTmuxAvailable()` preflight in sling command** — verifies tmux is available before attempting session creation, providing a clear error instead of cryptic spawn failures

#### Testing
- Test suite: 2145 tests across 76 files (5410 expect() calls)

### Changed
- **`beadId` → `taskId` rename across all TypeScript source** — comprehensive rename of the `beadId` field to `taskId` in all source files, types, interfaces, and tests, completing the tracker abstraction naming migration started in v0.6.0
- **`gatherStatus()` uses `evaluateHealth()`** — status command now applies the full health evaluation from the watchdog module for agent state reconciliation, matching dashboard and watchdog behavior (handles tmux-dead→zombie, persistent capability booting→working, and time-based stale/zombie detection)

### Fixed
- **Single quote escaping in blockGuard shell commands** — fixed shell escaping in blockGuard patterns that could cause guard failures when arguments contained single quotes
- **Dashboard version from package.json** — dashboard now reads version dynamically from `package.json` instead of a hardcoded value
- **Seeds config project name** — renamed project from "seeds" to "overstory" in `.seeds/config.yaml` and fixed 71 misnamed issue IDs

## [0.6.4] - 2026-02-24

### Added

#### Commander.js CLI Framework
- **Full CLI migration to Commander.js** — all 30+ commands migrated from custom `args` array parsing to Commander.js with typed options, subcommand hierarchy, and auto-generated `--help`; migration completed in 6 incremental commits covering core workflow, nudge, mail, observability, infrastructure, and final cleanup
- **Shell completions via Commander** — `createCompletionsCommand()` now uses Commander's built-in completion infrastructure

#### Chalk v5 Color System
- **Chalk-based color module** — `src/logging/color.ts` rewritten from custom ANSI escape code strings to Chalk v5 wrapper functions with native `NO_COLOR`/`FORCE_COLOR`/`TERM=dumb` support
- **Brand palette** — three named brand colors exported: `brand` (forest green), `accent` (amber), `muted` (stone gray) via `chalk.rgb()`
- **Chainable color API** — `color.bold`, `color.dim`, `color.red`, etc. now delegate to Chalk for composable styling

#### Testing
- Merge queue SQL schema consistency tests added
- Test suite: 2128 tests across 76 files (5360 expect() calls)

### Changed
- **Runtime dependencies** — chalk v5 added as first runtime dependency (previously zero runtime deps); chalk is ESM-only and handles color detection natively
- **CLI parsing** — all commands converted from manual `args` array indexing to Commander.js `.option()` / `.argument()` declarations with automatic type coercion and validation
- **Color module API** — `color` export changed from a record of ANSI string constants to a record of Chalk wrapper functions; consumers call `color.red("text")` (function) instead of `${color.red}text${color.reset}` (string interpolation)
- **`noColor` identity function** — replaces the old `color.white` default for cases where no coloring is needed

### Fixed
- **Merge queue migration** — added missing `bead_id` → `task_id` column migration for `merge-queue.db`, aligning with the schema migration already applied to sessions.db, events.db, and metrics.db in v0.6.0
- **npm publish auth** — fixed authentication issues in publish workflow and cleaned up post-merge artifacts from Commander migration
- **Commander direct parse** — fixed 6 command wrapper functions that incorrectly delegated to Commander instead of using direct `.action()` pattern (metrics, replay, status, trace, supervisor, and others)

## [0.6.3] - 2026-02-24

### Added

#### Interactive Tool Blocking for Agents
- **PreToolUse guards block interactive tools** — `AskUserQuestion`, `EnterPlanMode`, and `EnterWorktree` are now blocked for all overstory agents via hooks-deployer, preventing indefinite hangs in non-interactive tmux sessions; agents must use `overstory mail --type question` to escalate instead

#### Doctor Ecosystem CLI Checks
- **Expanded `overstory doctor` dependency checks** — now validates all ecosystem CLIs (overstory, mulch, seeds, canopy) with alias availability checks (`ov`, `ml`) and install hints (`npm install -g @os-eco/<pkg>`)
- Short alias detection: when a primary tool passes, doctor also checks if its short alias (e.g., `ov` for `overstory`, `ml` for `mulch`) is available, with actionable fix hints

#### CLI Improvements
- **`ov` short alias** — `overstory` CLI is now also available as `ov` via `package.json` bin entry
- **`/prioritize` skill** — new Claude Code command that analyzes open GitHub Issues and Seeds issues, cross-references with codebase health, and recommends the top ~5 issues to tackle next
- **Skill headers** — all Claude Code slash commands now include descriptive headers for better discoverability

#### CI/CD
- **Publish workflow** — replaced `auto-tag.yml` with `publish.yml` that runs quality gates, checks version against npm, publishes with provenance, creates git tags and GitHub releases automatically

#### Performance
- **`SessionStore.count()`** — lightweight `SELECT COUNT(*)` method replacing `getAll().length` pattern in `openSessionStore()` existence checks

#### Testing
- Test suite grew from 2090 to 2137 tests across 76 files (5370 expect() calls)
- SQL schema consistency tests for all four SQLite stores (sessions.db, mail.db, events.db, metrics.db)
- Provider config and model resolution edge case tests
- Sling provider environment variable injection building block tests

### Fixed
- **Tmux dead session detection in `waitForTuiReady()`** — now checks `isSessionAlive()` on each poll iteration and returns early if the session died, preventing 15-second timeout waits on already-dead sessions
- **`ensureTmuxAvailable()` guard** — new pre-flight check throws a clear `AgentError` when tmux is not installed, replacing cryptic spawn failures
- **`package.json` files array** — reformatted for Biome compatibility

### Changed
- **CI workflow**: `auto-tag.yml` replaced by `publish.yml` with npm publish, provenance, and GitHub release creation
- Config field references updated: `beads` → `taskTracker` in remaining locations

## [0.6.2] - 2026-02-24

### Added

#### Sling Guard Improvements
- **`--skip-task-check` flag for `overstory sling`** — skips task existence validation and issue claiming, designed for leads spawning builders with worktree-created issues that don't exist in the canonical tracker yet
- **Bead lock parent bypass** — parent agent can now delegate its own task ID to a child without triggering the concurrent-work lock (sling allows spawn when the lock holder matches `--parent`)
- Lead agent `--skip-task-check` added to default sling template in `agents/lead.md`

#### Lead Agent Spec Writing
- Leads now use `overstory spec write <id> --body "..." --agent $OVERSTORY_AGENT_NAME` instead of Write/Edit tools for creating spec files — enforces read-only tool posture while still enabling spec creation

#### Testing
- Test suite grew from 2087 to 2090 tests across 75 files (5137 expect() calls)

### Fixed
- **Dashboard health evaluation** — dashboard now applies the full `evaluateHealth()` function from the watchdog module instead of only checking tmux liveness; correctly transitions persistent capabilities (coordinator, monitor) from `booting` → `working` when tmux is alive, and detects stale/zombie states using configured thresholds
- **Default tracker resolution to seeds** — `resolveBackend()` now falls back to `"seeds"` when no tracker directory exists (previously defaulted to `"beads"`)
- **Coordinator beacon uses `resolveBackend()`** — properly resolves `"auto"` backend instead of a simple conditional that didn't handle auto-detection
- **Doctor dependency checks use `resolveBackend()`** — properly resolves `"auto"` backend for tracker CLI availability checks instead of assuming beads
- **Hardcoded 'orchestrator' replaced with 'coordinator'** — overlay template default parent address, agent definitions (builder, merger, monitor, scout), and test assertions all updated to use `coordinator` as the default parent/mail recipient

### Changed
- Lead agent definition: Write/Edit tools removed from capabilities, replaced with `overstory spec write` CLI command
- Agent definitions (builder, merger, monitor, scout) updated to reference "coordinator" instead of "orchestrator" in mail examples and constraints

## [0.6.1] - 2026-02-23

### Added

#### Canopy Integration for Agent Prompt Management
- All 8 agent definitions (`agents/*.md`) restructured for Canopy prompt composition — behavioral sections (`propulsion-principle`, `cost-awareness`, `failure-modes`, `overlay`, `constraints`, `communication-protocol`, `completion-protocol`) moved to the top of each file with kebab-case headers, core content sections (`intro`, `role`, `capabilities`, `workflow`) placed after
- Section headers converted from Title Case (`## Role`) to kebab-case (`## role`) across all agent definitions for Canopy schema compatibility

#### Hooks Deployer Merge Behavior
- `deployHooks()` now preserves existing `settings.local.json` content when deploying hooks — merges with non-hooks keys (permissions, env, `$schema`, etc.) instead of overwriting the entire file
- `isOverstoryHookEntry()` exported for detecting overstory-managed hook entries — enables stripping stale overstory hooks while preserving user-defined hooks
- Overstory hooks placed before user hooks per event type so security guards always run first

#### Testing
- Test suite grew from 2075 to 2087 tests across 75 files (5150 expect() calls)

### Changed
- **Dogfooding tracker migrated from beads to seeds** — `.beads/` directory removed, `.seeds/` directory added with all issues migrated
- Biome ignore pattern updated: `.beads/` → `.seeds/`

### Fixed
- `deployHooks()` no longer overwrites existing `settings.local.json` — previously deploying hooks for coordinator/supervisor/monitor agents at the project root would destroy any existing settings (permissions, user hooks, env vars)

## [0.6.0] - 2026-02-23

### Added

#### Tracker Abstraction Layer
- **`src/tracker/` module** — pluggable task tracker backend system replacing the hardcoded beads dependency
  - `TrackerClient` interface with unified API: `ready()`, `show()`, `create()`, `claim()`, `close()`, `list()`, `sync()`
  - `TrackerIssue` type for backend-agnostic issue representation
  - `createTrackerClient()` factory function dispatching to concrete backends
  - `resolveBackend()` auto-detection — probes `.seeds/` then `.beads/` directories when configured as `"auto"`
  - `trackerCliName()` helper returning `"sd"` or `"bd"` based on resolved backend
  - Beads adapter (`src/tracker/beads.ts`) — wraps `bd` CLI with `--json` parsing
  - Seeds adapter (`src/tracker/seeds.ts`) — wraps `sd` CLI with `--json` parsing
  - Factory tests (`src/tracker/factory.test.ts`) — 80 lines covering resolution and client creation

#### Configurable Quality Gates
- `QualityGate` type (`{ name, command, description }`) in `types.ts` — replaces hardcoded `bun test && bun run lint && bun run typecheck`
- `project.qualityGates` config field — projects can now define custom quality gate commands in `config.yaml`
- `DEFAULT_QUALITY_GATES` constant in `config.ts` — preserves the default 3-gate pipeline (Tests, Lint, Typecheck)
- Quality gate validation in `validateConfig()` — ensures each gate has non-empty `name`, `command`, and `description`
- Overlay template renders configured gates dynamically instead of hardcoded commands
- `OverlayConfig.qualityGates` field threads gates from config through to agent overlays

#### Config Migration for Task Tracker
- `taskTracker: { backend, enabled }` config field replaces legacy `beads:` and `seeds:` sections
- Automatic migration: `beads: { enabled: true }` → `taskTracker: { backend: "beads", enabled: true }` (and same for `seeds:`)
- `TaskTrackerBackend` type: `"auto" | "beads" | "seeds"` with `"auto"` as default
- Deprecation warnings emitted when legacy config keys are detected

#### Template & Agent Definition Updates
- `TRACKER_CLI` and `TRACKER_NAME` template variables in overlay.ts — agent defs no longer hardcode `bd`/`beads`
- All 8 agent definitions (`agents/*.md`) updated: `bd` → `TRACKER_CLI`, `beads` → `TRACKER_NAME`
- Coordinator beacon updated with tracker-aware context
- Hooks-deployer safe prefixes updated for tracker CLI commands

#### Hooks Improvements
- `mergeHooksByEventType()` — `overstory hooks install --force` now merges hooks per event type with deduplication instead of wholesale replacement, preserving user-added hooks

#### Testing
- Test suite grew from 2026 to 2075 tests across 75 files (5128 expect() calls)

### Changed
- **beads → taskTracker config**: `config.beads` renamed to `config.taskTracker` with backward-compatible migration
- **bead_id → task_id**: Column renamed across all SQLite schemas (metrics.db, merge-queue.db, sessions.db, events.db) with automatic migration for existing databases
- `group.ts` and `supervisor.ts` now use tracker abstraction instead of direct beads client calls
- `sling.ts` uses `resolveBackend()` and `trackerCliName()` from factory module
- Doctor dependency checks updated to detect the active tracker CLI (`bd` or `sd`)

### Fixed
- `overstory hooks install --force` now merges hooks by event type instead of replacing the entire settings file — preserves non-overstory hooks
- `detectCanonicalBranch()` now accepts any branch name (removed restrictive regex)
- `bead_id` → `task_id` SQLite column migration for existing databases (metrics, merge-queue, sessions, events)
- `config.seeds` → `config.taskTracker` bootstrap path in `sling.ts`
- `group.ts` and `supervisor.ts` now use `resolveBackend()` for proper tracker resolution instead of hardcoded backend
- Seeds adapter validates envelope `success` field before unwrapping response data
- Hooks tests use literal keys instead of string indexing for `noUncheckedIndexedAccess` compliance
- Removed old `src/beads/` directory (replaced by `src/tracker/`)

## [0.5.9] - 2026-02-21

### Added

#### New CLI Commands
- `overstory stop <agent-name>` — explicitly terminate a running agent by killing its tmux session, marking the session as completed in SessionStore, with optional `--clean-worktree` to remove the agent's worktree (17 tests, DI pattern via `StopDeps`)

#### Sling Guard Features
- **Bead lock** — `checkBeadLock()` pure function prevents concurrent agents from working the same bead ID, enforced in `slingCommand` before spawning
- **Run session cap** — `checkRunSessionLimit()` pure function with `maxSessionsPerRun` config field (default 0 = unlimited), enforced in `slingCommand` to limit concurrent agents per run
- **`--skip-scout` flag** — passes through to overlay via `OverlayConfig.skipScout`, renders `SKIP_SCOUT_SECTION` in template for lead agents that want to skip scout phase

#### Agent Pipeline Improvements
- **Complexity-tiered pipeline** in lead agent definition — leads now assess task complexity (simple/moderate/complex) before deciding whether to spawn scouts, builders, and reviewers
- Scouts made optional for simple/moderate tasks (SHOULD vs MUST)
- Reviewers made optional with self-verification path for simple/moderate tasks
- `SCOUT_SKIP` and `REVIEW_SKIP` failure modes softened to warnings
- Scout and reviewer agents simplified: replaced `INSIGHT:` protocol with plain notable findings

#### Testing
- Test suite grew from 1996 to 2026 tests across 74 files (5023 expect() calls)

### Changed
- Lead agent role reframed to reflect that leads can be doers for simple tasks, not just delegators
- Lead propulsion principle updated to assess complexity before acting
- Lead cost awareness section no longer mandates reviewers

### Fixed
- Biome formatting in `stop.test.ts` (pre-existing lint issue)

## [0.5.8] - 2026-02-20

### Added

#### Provider Model Resolution
- `ResolvedModel` type and provider gateway support in `resolveModel()` — resolves `ModelRef` strings (e.g., `openrouter/openai/gpt-5.3`) through configured provider gateways with `baseUrl` and `authTokenEnv`
- Provider and model validation in `validateConfig()` — validates provider types (`native`/`gateway`), required gateway fields (`baseUrl`), and model reference format at config load time
- Provider environment variables now threaded through all agent spawn commands (`sling`, `coordinator`, `supervisor`, `monitor`) — gateway `authTokenEnv` values are passed to spawned agent processes

#### Mulch Integration
- Auto-infer mulch domains from file scope in `overstory sling` — `inferDomainsFromFiles()` maps file paths to domains (e.g., `src/commands/*.ts` → `cli`, `src/agents/*.ts` → `agents`) instead of always using configured defaults
- Outcome flags for `MulchClient.record()` — `--outcome-status`, `--outcome-duration`, `--outcome-test-results`, `--outcome-agent` for structured outcome tracking
- File-scoped search in `MulchClient.search()` — `--file` and `--sort-by-score` options for targeted expertise queries
- PostToolUse Bash hook in hooks template and init — runs `mulch diff` after git commits to auto-detect expertise changes

#### Agent Definition Updates
- Builder completion protocol includes outcome data flags (`--outcome-status success --outcome-agent $OVERSTORY_AGENT_NAME`)
- Lead and supervisor agents get file-scoped mulch search capability (`mulch search <query> --file <path>`)
- Overlay quality gates include outcome flags for mulch recording

#### Dashboard Performance
- `limit` option added to `MailStore.getAll()` — dashboard now fetches only the most recent messages instead of the full mailbox
- Persistent DB connections across dashboard poll ticks — `SessionStore`, `EventStore`, `MailStore`, and `MetricsStore` connections are now opened once and reused, eliminating per-tick open/close overhead

#### Testing
- Test suite grew from 1916 to 1996 tests across 73 files (4960 expect() calls)

### Fixed
- Zombie agent recovery — `updateLastActivity` now recovers agents from "zombie" state when hooks prove they're alive (previously only recovered from "booting")
- Dashboard `.repeat()` crash when negative values were passed — now clamps repeat count to minimum of 0
- Set-based tmux session lookup in `status.ts` replacing O(n) array scans with O(1) Set membership checks
- Subprocess cache in `status.ts` preventing redundant `tmux list-sessions` calls during a single status gather
- Null-runId sessions (coordinator) now included in run-scoped status and dashboard views — previously filtered out when `--all` was not specified
- Sparse file used in logs doctor test to prevent timeout on large log directory scans
- Beacon submission reliability — replaced fixed sleep with poll-based TUI readiness check (PR #19, thanks [@dmfaux](https://github.com/dmfaux)!)
- Biome formatting in hooks-deployer test and sling

## [0.5.7] - 2026-02-19

### Added

#### Provider Types
- `ModelAlias`, `ModelRef`, and `ProviderConfig` types in `types.ts` — foundation for multi-provider model routing (`native` and `gateway` provider types with `baseUrl` and `authTokenEnv` configuration)
- `providers` field in `OverstoryConfig` — `Record<string, ProviderConfig>` for configuring model providers per project
- `resolveModel()` signature updated to accept `ModelRef` (provider-qualified strings like `openrouter/openai/gpt-5.3`) alongside simple `ModelAlias` values

#### Costs Command
- `--self` flag for `overstory costs` — parse the current orchestrator session's Claude Code transcript directly, bypassing metrics.db, useful for real-time cost visibility without agent infrastructure

#### Metrics
- `run_id` column added to `metrics.db` sessions table — enables `overstory costs --run <id>` filtering to work correctly; includes automatic migration for existing databases

#### Watchdog
- Phase-aware `buildCompletionMessage()` in watchdog daemon — generates targeted completion nudge messages based on worker capability composition (single-capability batches get phase-specific messages like "Ready for next phase", mixed batches get a summary with breakdown)

#### Testing
- Test suite grew from 1892 to 1916 tests across 73 files (4866 expect() calls)

## [0.5.6] - 2026-02-18

### Added

#### Safety Guards
- Root-user pre-flight guard on all agent spawn commands (`sling`, `coordinator start`, `supervisor start`, `monitor start`) — blocks spawning when running as UID 0, since the `claude` CLI rejects `--dangerously-skip-permissions` as root causing tmux sessions to die immediately
- Unmerged branch safety check in `overstory worktree clean` — skips worktrees with unmerged branches by default, warns about skipped branches, and requires `--force` to delete them

#### Init Improvements
- `.overstory/README.md` generation during `overstory init` — explains the directory to contributors who encounter `.overstory/` in a project, whitelisted in `.gitignore`

#### Tier 2 Monitor Config Gating
- `overstory monitor start` now gates on `watchdog.tier2Enabled` config flag — throws a clear error when Tier 2 is disabled instead of silently proceeding
- `overstory coordinator start --monitor` respects `tier2Enabled` — skips monitor auto-start with a message when disabled

#### Tmux Error Handling
- `sendKeys` now distinguishes "tmux server not running" from "session not found" — provides actionable error messages for each case (e.g., root-user hint for server-not-running)

#### Documentation
- Lead agent definition (`agents/lead.md`) reframed as coordinator-not-doer — emphasizes the lead's role as a delegation specialist rather than an implementer

#### Testing
- Test suite grew from 1868 to 1892 tests across 73 files (4807 expect() calls)

### Fixed
- Biome formatting in merged builder code

## [0.5.5] - 2026-02-18

### Added

#### Run Scoping
- `overstory status` now scopes to the current run by default with `--all` flag to show all runs — `gatherStatus()` filters sessions by `runId` when present
- `overstory dashboard` now scopes all panels to the current run by default with `--all` flag to show data across all runs

#### Config Local Overrides
- `config.local.yaml` support for machine-specific configuration overrides — values in `config.local.yaml` are deep-merged over `config.yaml`, allowing per-machine settings (model overrides, paths, watchdog intervals) without modifying the tracked config file (PR #9)

#### Universal Push Guard
- PreToolUse hooks template now includes a universal `git push` guard — blocks all `git push` commands for all agents (previously only blocked push to canonical branches)

#### Watchdog Run-Completion Detection
- Watchdog daemon tick now detects when all agents in the current run have completed and auto-reports run completion

#### Lead Agent Streaming
- Lead agents now stream `merge_ready` messages per-builder as each completes, instead of batching all merge signals — enables earlier merge pipeline starts

#### Claude Code Command Skills
- Added `issue-reviews` and `pr-reviews` skills for reviewing GitHub issues and pull requests from within Claude Code

#### Testing
- Test suite grew from 1848 to 1868 tests across 73 files (4771 expect() calls)

### Fixed
- `overstory sling` now uses `resolveModel()` for config-level model overrides — previously ignored `models:` config section when spawning agents
- `overstory doctor` dependency check now detects `bd` CGO/Dolt backend failures — catches cases where `bd` binary exists but crashes due to missing CGO dependencies (PR #11)
- Biome line width formatting in `src/doctor/consistency.ts`

## [0.5.4] - 2026-02-17

### Added

#### Reviewer Coverage Enforcement
- Reviewer-coverage doctor check in `overstory doctor` — warns when leads spawn builders without corresponding reviewers, reports partial coverage ratios per lead
- `merge_ready` reviewer validation in `overstory mail send` — advisory warning when sending `merge_ready` without reviewer sessions for the sender's builders

#### Scout-First Workflow Enforcement
- Scout-before-builder warning in `overstory sling` — warns when a lead spawns a builder without having spawned any scouts first
- `parentHasScouts()` helper exported from sling for testability

#### Run Auto-Completion
- `overstory coordinator stop` now auto-completes the active run (reads `current-run.txt`, marks run completed, cleans up)
- `overstory log session-end` auto-completes the run when the coordinator exits (handles tmux window close without explicit stop)

#### Gitignore Wildcard+Whitelist Model
- `.overstory/.gitignore` flipped from explicit blocklist to wildcard `*` + whitelist pattern — ignore everything, whitelist only tracked files (`config.yaml`, `agent-manifest.json`, `hooks.json`, `groups.json`, `agent-defs/`)
- `overstory prime` auto-heals `.overstory/.gitignore` on each session start — ensures existing projects get the updated gitignore
- `OVERSTORY_GITIGNORE` constant and `writeOverstoryGitignore()` exported from init.ts for reuse

#### Testing
- Test suite grew from 1812 to 1848 tests across 73 files (4726 expect() calls)

### Changed
- Lead agent definition (`agents/lead.md`) — scouts made mandatory (not optional), Phase 3 review made MANDATORY with stronger language, added `SCOUT_SKIP` failure mode, expanded cost awareness section explaining why scouts and reviewers are investments not overhead
- `overstory init` .gitignore now always overwrites (supports `--force` reinit and auto-healing)

### Fixed
- Hooks template (`templates/hooks.json.tmpl`) — removed fragile `read -r INPUT; echo "$INPUT" |` stdin relay pattern; `overstory log` now reads stdin directly via `--stdin` flag
- `readStdinJson()` in log command — reads all stdin chunks for large payloads instead of only the first line
- Doctor gitignore structure check updated for wildcard+whitelist model

## [0.5.3] - 2026-02-17

### Added

#### Configurable Agent Models
- `models:` section in `config.yaml` — override the default model (`sonnet`, `opus`, `haiku`) for any agent role (coordinator, supervisor, monitor, etc.)
- `resolveModel()` helper in agent manifest — resolution chain: config override > manifest default > fallback
- Supervisor and monitor entries added to `agent-manifest.json` with model and capability metadata
- `overstory init` now seeds the default `models:` section in generated `config.yaml`

#### Testing
- Test suite grew from 1805 to 1812 tests across 73 files (4638 expect() calls)

## [0.5.2] - 2026-02-17

### Added

#### New Flags
- `--into <branch>` flag for `overstory merge` — target a specific branch instead of always merging to canonicalBranch

#### Session Branch Tracking
- `overstory prime` now records the orchestrator's starting branch to `.overstory/session-branch.txt` at session start
- `overstory merge` reads `session-branch.txt` as the default merge target when `--into` is not specified — resolution chain: `--into` flag > `session-branch.txt` > config `canonicalBranch`

#### Testing
- Test suite grew from 1793 to 1805 tests across 73 files (4615 expect() calls)

### Changed
- Git push blocking for agents now blocks ALL `git push` commands (previously only blocked push to canonical branches) — agents should use `overstory merge` instead
- Init-deployed hooks now include a PreToolUse Bash guard that blocks `git push` for the orchestrator's project

### Fixed
- Test cwd pollution in agents test afterEach — restored cwd to prevent cross-file pollution

## [0.5.1] - 2026-02-16

### Added

#### New CLI Commands
- `overstory agents discover` — discover and query agents by capability, state, file scope, and parent with `--capability`, `--state`, `--parent` filters and `--json` output

#### New Subsystems
- Session insight analyzer (`src/insights/analyzer.ts`) — analyzes EventStore data from completed sessions to extract structured patterns about tool usage, file edits, and errors for automatic mulch expertise recording
- Conflict history intelligence in merge resolver — tracks past conflict resolution patterns per file to skip historically-failing tiers and enrich AI resolution prompts with successful strategies

#### Agent Improvements
- INSIGHT recording protocol for agent definitions — read-only agents (scout, reviewer) use INSIGHT prefix for structured expertise observations; parent agents (lead, supervisor) record insights to mulch automatically

#### Testing
- Test suite grew from 1749 to 1793 tests across 73 files (4587 expect() calls)

### Changed
- `session-end` hook now calls `mulch record` directly instead of sending `mulch_learn` mail messages — removes mail indirection for expertise recording

### Fixed
- Coordinator tests now always inject fake monitor/watchdog for proper isolation

## [0.5.0] - 2026-02-16

### Added

#### New CLI Commands
- `overstory feed` — unified real-time event stream across all agents with `--follow` mode for continuous polling, agent/run filtering, and JSON output
- `overstory logs` — query NDJSON log files across agents with level filtering (`--level`), time range queries (`--since`/`--until`), and `--follow` tail mode
- `overstory costs --live` — real-time token usage display for active agents

#### New Flags
- `--monitor` flag for `coordinator start/stop/status` — manage the Tier 2 monitor agent alongside the coordinator

#### Agent Improvements
- Mulch recording as required completion gate for all agent types — agents must record learnings before session close
- Mulch learn extraction added to Stop hooks for orchestrator and all agents
- Scout-spawning made default in lead.md Phase 1 with parallel support
- Reviewer spawning made mandatory in lead.md

#### Infrastructure
- Real-time token tracking infrastructure (`src/metrics/store.ts`, `src/commands/costs.ts`) — live session cost monitoring via transcript JSONL parsing

#### Testing
- Test suite grew from 1673 to 1749 tests across 71 files (4460 expect() calls)

### Fixed
- Duplicate `feed` entry in CLI command router and help text

## [0.4.1] - 2026-02-16

### Added

#### New CLI Commands & Flags
- `overstory --completions <shell>` — shell completion generation for bash, zsh, and fish
- `--quiet` / `-q` global flag — suppress non-error output across all commands
- `overstory mail send --to @all` — broadcast messaging with group addresses (`@all`, `@builders`, `@scouts`, `@reviewers`, `@leads`, `@mergers`, etc.)

#### Output Control
- Central `NO_COLOR` convention support (`src/logging/color.ts`) — respects `NO_COLOR`, `FORCE_COLOR`, and `TERM=dumb` environment variables per https://no-color.org
- All ANSI color output now goes through centralized color module instead of inline escape codes

#### Infrastructure
- Merge queue migrated from JSON file to SQLite (`merge-queue.db`) for durability and concurrent access

#### Testing
- Test suite grew from 1612 to 1673 tests across 69 files (4267 expect() calls)

### Fixed
- Freeze duration counter for completed/zombie agents in status and dashboard displays

## [0.4.0] - 2026-02-15

### Added

#### New CLI Commands
- `overstory doctor` — comprehensive health check system with 9 check modules (dependencies, config, structure, databases, consistency, agents, merge-queue, version, logs) and formatted output with pass/warn/fail status
- `overstory inspect <agent>` — deep per-agent inspection aggregating session data, metrics, events, and live tmux capture with `--follow` polling mode

#### New Flags
- `--watchdog` flag for `coordinator start` — auto-starts the watchdog daemon alongside the coordinator
- `--debounce <ms>` flag for `mail check` — prevents excessive mail checking by skipping if called within the debounce window
- PostToolUse hook entry for debounced mail checking

#### Observability Improvements
- Automated failure recording in watchdog via mulch — records failure patterns for future reference
- Mulch learn extraction in `log session-end` — captures session insights automatically
- Mulch health checks in `overstory clean` — validates mulch installation and domain health during cleanup

#### Testing
- Test suite grew from 1435 to 1612 tests across 66 files (3958 expect() calls)

### Fixed

- Wire doctor command into CLI router and update command groups

## [0.3.0] - 2026-02-13

### Added

#### New CLI Commands
- `overstory run` command — orchestration run lifecycle management (`list`, `show`, `complete` subcommands) with RunStore backed by sessions.db
- `overstory trace` command — agent/bead timeline viewing for debugging and post-mortem observability
- `overstory clean` command — cleanup worktrees, sessions, and artifacts with auto-cleanup on agent teardown

#### Observability & Persistence
- Run tracking via `run_id` integrated into sling and clean commands
- `RunStore` in sessions.db for durable run state
- `SessionStore` (SQLite) — migrated from sessions.json for concurrent access and crash safety
- Phase 2 CLI query commands and Phase 3 event persistence for the observability pipeline

#### Agent Improvements
- Project-scoped tmux naming (`overstory-{projectName}-{agentName}`) to prevent cross-project session collisions
- `ENV_GUARD` on all hooks — prevents hooks from firing outside overstory-managed worktrees
- Mulch-informed lead decomposition — leader agents use mulch expertise when breaking down tasks
- Mulch conflict pattern recording — merge resolver records conflict patterns to mulch for future reference

#### MulchClient Expansion
- New commands and flags for the mulch CLI wrapper
- `--json` parsing support with corrected types and flag spread

#### Community & Documentation
- `STEELMAN.md` — comprehensive risk analysis for agent swarm deployments
- Community files: CONTRIBUTING.md, CODE_OF_CONDUCT.md, SECURITY.md
- Package metadata (keywords, repository, homepage) for npm/GitHub presence

#### Testing
- Test suite grew from 912 to 1435 tests across 55 files (3416 expect() calls)

### Fixed

- Fix `isCanonicalRoot` guard blocking all worktree overlays when dogfooding overstory on itself
- Fix auto-nudge tmux corruption and deploy coordinator hooks correctly
- Fix 4 P1 issues: orchestrator nudge routing, bash guard bypass, hook capture isolation, overlay guard
- Fix 4 P1/P2 issues: ENV_GUARD enforcement, persistent agent state, project-scoped tmux kills, auto-nudge coordinator
- Strengthen agent orchestration with additional P1 bug fixes

### Changed

- CLI commands grew from 17 to 20 (added run, trace, clean)

## [0.2.0] - 2026-02-13

### Added

#### Coordinator & Supervisor Agents
- `overstory coordinator` command — persistent orchestrator that runs at project root, decomposes objectives into subtasks, dispatches agents via sling, and tracks batches via task groups
  - `start` / `stop` / `status` subcommands
  - `--attach` / `--no-attach` with TTY-aware auto-detection for tmux sessions
  - Scout-delegated spec generation for complex tasks
- Supervisor agent definition — per-project team lead (depth 1) that receives dispatch mail from coordinator, decomposes into worker-sized subtasks, manages worker lifecycle, and escalates unresolvable issues
- 7 base agent types (added coordinator + supervisor to existing scout, builder, reviewer, lead, merger)

#### Task Groups & Session Lifecycle
- `overstory group` command — batch coordination (`create` / `status` / `add` / `remove` / `list`) with auto-close when all member beads issues complete, mail notification to coordinator on auto-close
- Session checkpoint save/restore for compaction survivability (`prime --compact` restores from checkpoint)
- Handoff orchestration (initiate/resume/complete) for crash recovery

#### Typed Mail Protocol
- 8 protocol message types: `worker_done`, `merge_ready`, `merged`, `merge_failed`, `escalation`, `health_check`, `dispatch`, `assign`
- Type-safe `sendProtocol<T>()` and `parsePayload<T>()` for structured agent coordination
- JSON payload column with schema migration handling 3 upgrade paths

#### Agent Nudging
- `overstory nudge` command with retry (3x), debounce (500ms), and `--force` to skip debounce
- Auto-nudge on urgent/high priority mail send

#### Structural Tool Enforcement
- PreToolUse hooks mechanically block file-modifying tools (Write/Edit/NotebookEdit) for non-implementation agents (scout, reviewer, coordinator, supervisor)
- PreToolUse Bash guards block dangerous git operations (`push`, `reset --hard`, `clean -f`, etc.) for all agents
- Whitelist git add/commit for coordinator/supervisor capabilities while keeping git push blocked
- Block Claude Code native team/task tools (Task, TeamCreate, etc.) for all overstory agents — enforces overstory sling delegation

#### Watchdog Improvements
- ZFC principle: tmux liveness as primary signal, pid check as secondary, sessions.json as tertiary
- Descendant tree walking for process cleanup — `getPanePid()`, `getDescendantPids()`, `killProcessTree()` with SIGTERM → grace → SIGKILL
- Re-check zombies on every tick, handle investigate action
- Stalled state added to zombie reconciliation

#### Worker Self-Propulsion (Phase 3)
- Builder agents send `worker_done` mail on task completion
- Overlay quality gates include worker_done signal step
- Prime activation context injection for bound tasks
- `MISSING_WORKER_DONE` failure mode in builder definition

#### Interactive Agent Mode
- Switch sling from headless (`claude -p`) to interactive mode with tmux sendKeys beacon — hooks now fire, enabling mail, metrics, logs, and lastActivity updates
- Structured `buildBeacon()` with identity context and startup protocol
- Fix beacon sendKeys multiline bug (increase initial sleep, follow-up Enter after 500ms)

#### CLI Improvements
- `--verbose` flag for `overstory status`
- `--json` flag for `overstory sling`
- `--background` flag for `overstory watch`
- Help text for unknown subcommands
- `SUPPORTED_CAPABILITIES` constant and `Capability` type

#### Init & Deployment
- `overstory init` now deploys agent definitions (copies `agents/*.md` to `.overstory/agent-defs/`) via `import.meta.dir` resolution
- E2E lifecycle test validates full init → config → manifest → overlay pipeline on throwaway external projects

#### Testing Improvements
- Colocated tests with source files (moved from `__tests__/` to `src/`)
- Shared test harness: `createTempGitRepo()`, `cleanupTempDir()`, `commitFile()` in `src/test-helpers.ts`
- Replaced `Bun.spawn` mocks with real implementations in 3 test files
- Optimized test harness: 38.1s → 11.7s (-69%)
- Comprehensive metrics command test coverage
- E2E init-sling lifecycle test
- Test suite grew from initial release to 515 tests across 24 files (1286 expect() calls)

### Fixed

- **60+ bugs** resolved across 8 dedicated fix sessions, covering P1 criticals through P4 backlog items:
  - Hooks enforcement: tool guard sed patterns now handle optional space after JSON colons
  - Status display: filter completed sessions from active agent count
  - Session lifecycle: move session recording before beacon send to fix booting → working race condition
  - Stagger delay (`staggerDelayMs`) now actually enforced between agent spawns
  - Hardcoded `main` branch replaced with dynamic branch detection in worktree/manager and merge/resolver
  - Sling headless mode fixes for E2E validation
  - Input validation, environment variable handling, init improvements, cleanup lifecycle
  - `.gitignore` patterns for `.overstory/` artifacts
  - Mail, merge, and worktree subsystem edge cases

### Changed

- Agent propulsion principle: failure modes, cost awareness, and completion protocol added to all agent definitions
- Agent quality gates updated across all base definitions
- Test file paths updated from `__tests__/` convention to colocated `src/**/*.test.ts`

## [0.1.0] - 2026-02-12

### Added

- CLI entry point with command router (`overstory <command>`)
- `overstory init` — initialize `.overstory/` in a target project
- `overstory sling` — spawn worker agents in git worktrees via tmux
- `overstory prime` — load context for orchestrator or agent sessions
- `overstory status` — show active agents, worktrees, and project state
- `overstory mail` — SQLite-based inter-agent messaging (send/check/list/read/reply)
- `overstory merge` — merge agent branches with 4-tier conflict resolution
- `overstory worktree` — manage git worktrees (list/clean)
- `overstory log` — hook event logging (NDJSON + human-readable)
- `overstory watch` — watchdog daemon with health monitoring and AI-assisted triage
- `overstory metrics` — session metrics storage and reporting
- Agent manifest system with 5 base agent types (scout, builder, reviewer, lead, merger)
- Two-layer agent definition: base `.md` files (HOW) + dynamic overlays (WHAT)
- Persistent agent identity and CV system
- Hooks deployer for automatic worktree configuration
- beads (`bd`) CLI wrapper for issue tracking integration
- mulch CLI wrapper for structured expertise management
- Multi-format logging with secret redaction
- SQLite metrics storage for session analytics
- Full test suite using `bun test`
- Biome configuration for formatting and linting
- TypeScript strict mode with `noUncheckedIndexedAccess`

[Unreleased]: https://github.com/jayminwest/overstory/compare/v0.11.0...HEAD
[0.11.0]: https://github.com/jayminwest/overstory/compare/v0.10.3...v0.11.0
[0.10.3]: https://github.com/jayminwest/overstory/compare/v0.10.2...v0.10.3
[0.10.2]: https://github.com/jayminwest/overstory/compare/v0.10.1...v0.10.2
[0.10.1]: https://github.com/jayminwest/overstory/compare/v0.10.0...v0.10.1
[0.10.0]: https://github.com/jayminwest/overstory/compare/v0.9.4...v0.10.0
[0.9.4]: https://github.com/jayminwest/overstory/compare/v0.9.3...v0.9.4
[0.9.3]: https://github.com/jayminwest/overstory/compare/v0.9.2...v0.9.3
[0.9.2]: https://github.com/jayminwest/overstory/compare/v0.9.1...v0.9.2
[0.9.1]: https://github.com/jayminwest/overstory/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/jayminwest/overstory/compare/v0.8.7...v0.9.0
[0.8.7]: https://github.com/jayminwest/overstory/compare/v0.8.6...v0.8.7
[0.8.6]: https://github.com/jayminwest/overstory/compare/v0.8.5...v0.8.6
[0.8.5]: https://github.com/jayminwest/overstory/compare/v0.8.4...v0.8.5
[0.8.4]: https://github.com/jayminwest/overstory/compare/v0.8.3...v0.8.4
[0.8.3]: https://github.com/jayminwest/overstory/compare/v0.8.2...v0.8.3
[0.8.2]: https://github.com/jayminwest/overstory/compare/v0.8.1...v0.8.2
[0.8.1]: https://github.com/jayminwest/overstory/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/jayminwest/overstory/compare/v0.7.9...v0.8.0
[0.7.9]: https://github.com/jayminwest/overstory/compare/v0.7.8...v0.7.9
[0.7.8]: https://github.com/jayminwest/overstory/compare/v0.7.7...v0.7.8
[0.7.7]: https://github.com/jayminwest/overstory/compare/v0.7.6...v0.7.7
[0.7.6]: https://github.com/jayminwest/overstory/compare/v0.7.5...v0.7.6
[0.7.5]: https://github.com/jayminwest/overstory/compare/v0.7.4...v0.7.5
[0.7.4]: https://github.com/jayminwest/overstory/compare/v0.7.3...v0.7.4
[0.7.3]: https://github.com/jayminwest/overstory/compare/v0.7.2...v0.7.3
[0.7.2]: https://github.com/jayminwest/overstory/compare/v0.7.1...v0.7.2
[0.7.1]: https://github.com/jayminwest/overstory/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/jayminwest/overstory/compare/v0.6.12...v0.7.0
[0.6.12]: https://github.com/jayminwest/overstory/compare/v0.6.11...v0.6.12
[0.6.11]: https://github.com/jayminwest/overstory/compare/v0.6.10...v0.6.11
[0.6.10]: https://github.com/jayminwest/overstory/compare/v0.6.9...v0.6.10
[0.6.9]: https://github.com/jayminwest/overstory/compare/v0.6.8...v0.6.9
[0.6.8]: https://github.com/jayminwest/overstory/compare/v0.6.7...v0.6.8
[0.6.7]: https://github.com/jayminwest/overstory/compare/v0.6.6...v0.6.7
[0.6.6]: https://github.com/jayminwest/overstory/compare/v0.6.5...v0.6.6
[0.6.5]: https://github.com/jayminwest/overstory/compare/v0.6.4...v0.6.5
[0.6.4]: https://github.com/jayminwest/overstory/compare/v0.6.3...v0.6.4
[0.6.3]: https://github.com/jayminwest/overstory/compare/v0.6.2...v0.6.3
[0.6.2]: https://github.com/jayminwest/overstory/compare/v0.6.1...v0.6.2
[0.6.1]: https://github.com/jayminwest/overstory/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/jayminwest/overstory/compare/v0.5.9...v0.6.0
[0.5.9]: https://github.com/jayminwest/overstory/compare/v0.5.8...v0.5.9
[0.5.8]: https://github.com/jayminwest/overstory/compare/v0.5.7...v0.5.8
[0.5.7]: https://github.com/jayminwest/overstory/compare/v0.5.6...v0.5.7
[0.5.6]: https://github.com/jayminwest/overstory/compare/v0.5.5...v0.5.6
[0.5.5]: https://github.com/jayminwest/overstory/compare/v0.5.4...v0.5.5
[0.5.4]: https://github.com/jayminwest/overstory/compare/v0.5.3...v0.5.4
[0.5.3]: https://github.com/jayminwest/overstory/compare/v0.5.2...v0.5.3
[0.5.2]: https://github.com/jayminwest/overstory/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/jayminwest/overstory/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/jayminwest/overstory/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/jayminwest/overstory/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/jayminwest/overstory/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/jayminwest/overstory/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/jayminwest/overstory/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/jayminwest/overstory/releases/tag/v0.1.0

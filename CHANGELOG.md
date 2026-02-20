# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.8] - 2026-02-20

### Added

#### Provider Model Resolution
- `ResolvedModel` type and provider gateway support in `resolveModel()` — resolves `ModelRef` strings (e.g., `openrouter/openai/gpt-5.3`) through configured provider gateways with `baseUrl` and `authTokenEnv`
- Provider and model validation in `validateConfig()` — validates provider types (`native`/`gateway`), required gateway fields (`baseUrl`), and model reference format at config load time

#### Dashboard Performance
- `limit` option added to `MailStore.getAll()` — dashboard now fetches only the most recent messages instead of the full mailbox
- Persistent DB connections across dashboard poll ticks — `SessionStore`, `EventStore`, `MailStore`, and `MetricsStore` connections are now opened once and reused, eliminating per-tick open/close overhead

#### Testing
- Test suite grew from 1916 to 1974 tests across 73 files (4933 expect() calls)

### Fixed
- Dashboard `.repeat()` crash when negative values were passed — now clamps repeat count to minimum of 0
- Set-based tmux session lookup in `status.ts` replacing O(n) array scans with O(1) Set membership checks
- Subprocess cache in `status.ts` preventing redundant `tmux list-sessions` calls during a single status gather
- Null-runId sessions (coordinator) now included in run-scoped status and dashboard views — previously filtered out when `--all` was not specified
- Sparse file used in logs doctor test to prevent timeout on large log directory scans
- Beacon submission reliability — replaced fixed sleep with poll-based TUI readiness check (PR #19, thanks [@dmfaux](https://github.com/dmfaux)!)

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

[Unreleased]: https://github.com/jayminwest/overstory/compare/v0.5.8...HEAD
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

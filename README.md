# Overstory

[![CI](https://img.shields.io/github/actions/workflow/status/jayminwest/overstory/ci.yml?branch=main)](https://github.com/jayminwest/overstory/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Bun](https://img.shields.io/badge/Bun-%E2%89%A51.0-orange)](https://bun.sh)
[![GitHub release](https://img.shields.io/github/v/release/jayminwest/overstory)](https://github.com/jayminwest/overstory/releases)

Project-agnostic swarm system for Claude Code agent orchestration. Overstory turns a single Claude Code session into a multi-agent team by spawning worker agents in git worktrees via tmux, coordinating them through a custom SQLite mail system, and merging their work back with tiered conflict resolution.

> **⚠️ Warning: Agent swarms are not a universal solution.** Do not deploy Overstory without understanding the risks of multi-agent orchestration — compounding error rates, cost amplification, debugging complexity, and merge conflicts are the normal case, not edge cases. Read [STEELMAN.md](STEELMAN.md) for a full risk analysis and the [Agentic Engineering Book](https://github.com/jayminwest/agentic-engineering-book) ([web version](https://jayminwest.com/agentic-engineering-book)) before using this tool in production.

## How It Works

CLAUDE.md + hooks + the `overstory` CLI turn your Claude Code session into a multi-agent orchestrator. A persistent coordinator agent manages task decomposition and dispatch, while a mechanical watchdog daemon monitors agent health in the background.

```
Coordinator (persistent orchestrator at project root)
  --> Supervisor (per-project team lead, depth 1)
        --> Workers: Scout, Builder, Reviewer, Merger (depth 2)
```

### Agent Types

| Agent | Role | Access |
|-------|------|--------|
| **Coordinator** | Persistent orchestrator — decomposes objectives, dispatches agents, tracks task groups | Read-only |
| **Supervisor** | Per-project team lead — manages worker lifecycle, handles nudge/escalation | Read-only |
| **Scout** | Read-only exploration and research | Read-only |
| **Builder** | Implementation and code changes | Read-write |
| **Reviewer** | Validation and code review | Read-only |
| **Lead** | Team coordination, can spawn sub-workers | Read-write |
| **Merger** | Branch merge specialist | Read-write |
| **Monitor** | Tier 2 continuous fleet patrol — ongoing health monitoring | Read-only |

### Key Architecture

- **Agent Definitions**: Two-layer system — base `.md` files define the HOW (workflow), per-task overlays define the WHAT (task scope). Base definition content is injected into spawned agent overlays automatically.
- **Messaging**: Custom SQLite mail system with typed protocol — 8 message types (`worker_done`, `merge_ready`, `dispatch`, `escalation`, etc.) for structured agent coordination, plus broadcast messaging with group addresses (`@all`, `@builders`, etc.)
- **Worktrees**: Each agent gets an isolated git worktree — no file conflicts between agents
- **Merge**: FIFO merge queue (SQLite-backed) with 4-tier conflict resolution
- **Watchdog**: Tiered health monitoring — Tier 0 mechanical daemon (tmux/pid liveness), Tier 1 AI-assisted failure triage, Tier 2 monitor agent for continuous fleet patrol
- **Tool Enforcement**: PreToolUse hooks mechanically block file modifications for non-implementation agents and dangerous git operations for all agents
- **Task Groups**: Batch coordination with auto-close when all member issues complete
- **Session Lifecycle**: Checkpoint save/restore for compaction survivability, handoff orchestration for crash recovery
- **Token Instrumentation**: Session metrics extracted from Claude Code transcript JSONL files

## Requirements

- [Bun](https://bun.sh) (v1.0+)
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code)
- git
- tmux

## Installation

```bash
# Clone the repository
git clone https://github.com/jayminwest/overstory.git
cd overstory

# Install dev dependencies
bun install

# Link the CLI globally
bun link
```

## Quick Start

```bash
# Initialize overstory in your project
cd your-project
overstory init

# Install hooks into .claude/settings.local.json
overstory hooks install

# Start a coordinator (persistent orchestrator)
overstory coordinator start

# Or spawn individual worker agents
overstory sling <task-id> --capability builder --name my-builder

# Check agent status
overstory status

# Live dashboard for monitoring the fleet
overstory dashboard

# Nudge a stalled agent
overstory nudge <agent-name>

# Check mail from agents
overstory mail check --inject
```

## CLI Reference

```
overstory agents discover               Discover agents by capability/state/parent
  --capability <type>                    Filter by capability type
  --state <state>                        Filter by agent state
  --parent <name>                        Filter by parent agent
  --json                                 JSON output

overstory init                          Initialize .overstory/ in current project
                                        (deploys agent definitions automatically)

overstory coordinator start             Start persistent coordinator agent
  --attach / --no-attach                 TTY-aware tmux attach (default: auto)
  --watchdog                             Auto-start watchdog daemon with coordinator
  --monitor                              Auto-start Tier 2 monitor agent
overstory coordinator stop              Stop coordinator
overstory coordinator status            Show coordinator state

overstory supervisor start              Start per-project supervisor agent
  --attach / --no-attach                 TTY-aware tmux attach (default: auto)
overstory supervisor stop               Stop supervisor
overstory supervisor status             Show supervisor state

overstory sling <task-id>              Spawn a worker agent
  --capability <type>                    builder | scout | reviewer | lead | merger
                                         | coordinator | supervisor | monitor
  --name <name>                          Unique agent name
  --spec <path>                          Path to task spec file
  --files <f1,f2,...>                    Exclusive file scope
  --parent <agent-name>                  Parent (for hierarchy tracking)
  --depth <n>                            Current hierarchy depth
  --json                                 JSON output

overstory prime                         Load context for orchestrator/agent
  --agent <name>                         Per-agent priming
  --compact                              Restore from checkpoint (compaction)

overstory status                        Show all active agents, worktrees, beads state
  --json                                 JSON output
  --verbose                              Show detailed agent info

overstory dashboard                     Live TUI dashboard for agent monitoring
  --interval <ms>                        Refresh interval (default: 2000)

overstory hooks install                 Install orchestrator hooks to .claude/settings.local.json
  --force                                Overwrite existing hooks
overstory hooks uninstall               Remove orchestrator hooks
overstory hooks status                  Check if hooks are installed

overstory mail send                     Send a message
  --to <agent>  --subject <text>  --body <text>
  --to @all | @builders | @scouts ...    Broadcast to group addresses
  --type <status|question|result|error>
  --priority <low|normal|high|urgent>    (urgent/high auto-nudges recipient)

overstory mail check                    Check inbox (unread messages)
  --agent <name>  --inject  --json
  --debounce <ms>                        Skip if checked within window

overstory mail list                     List messages with filters
  --from <name>  --to <name>  --unread

overstory mail read <id>                Mark message as read
overstory mail reply <id> --body <text> Reply in same thread

overstory nudge <agent> [message]       Send a text nudge to an agent
  --from <name>                          Sender name (default: orchestrator)
  --force                                Skip debounce check
  --json                                 JSON output

overstory group create <name>           Create a task group for batch tracking
overstory group status <name>           Show group progress
overstory group add <name> <issue-id>   Add issue to group
overstory group list                    List all groups

overstory merge                         Merge agent branches into canonical
  --branch <name>                        Specific branch
  --all                                  All completed branches
  --into <branch>                        Target branch (default: session-branch.txt > canonicalBranch)
  --dry-run                              Check for conflicts only

overstory worktree list                 List worktrees with status
overstory worktree clean                Remove completed worktrees
  --completed                            Only finished agents
  --all                                  Force remove all

overstory monitor start                 Start Tier 2 monitor agent
overstory monitor stop                  Stop monitor agent
overstory monitor status                Show monitor state

overstory log <event>                   Log a hook event
overstory watch                         Start watchdog daemon (Tier 0)
  --interval <ms>                        Health check interval
  --background                           Run as background process
overstory run list                      List orchestration runs
overstory run show <id>                 Show run details
overstory run complete <id>             Mark a run complete

overstory trace                         View agent/bead timeline
  --agent <name>                         Filter by agent
  --run <id>                             Filter by run

overstory clean                         Clean up worktrees, sessions, artifacts
  --completed                            Only finished agents
  --all                                  Force remove all
  --run <id>                             Clean a specific run

overstory doctor                        Run health checks on overstory setup
  --json                                 JSON output
  --category <name>                      Run a specific check category only

overstory inspect <agent>               Deep per-agent inspection
  --json                                 JSON output
  --follow                               Polling mode (refreshes periodically)
  --interval <ms>                        Refresh interval for --follow
  --no-tmux                              Skip tmux capture
  --limit <n>                            Limit events shown

overstory spec write <bead-id>          Write a task specification
  --body <content>                       Spec content (or pipe via stdin)

overstory errors                        Aggregated error view across agents
  --agent <name>                         Filter by agent
  --run <id>                             Filter by run
  --since <ts>  --until <ts>             Time range filter
  --limit <n>  --json

overstory replay                        Interleaved chronological replay
  --run <id>                             Filter by run
  --agent <name>                         Filter by agent(s)
  --since <ts>  --until <ts>             Time range filter
  --limit <n>  --json

overstory feed [options]                Unified real-time event stream across agents
  --follow, -f                           Continuously poll for new events
  --interval <ms>                        Polling interval (default: 2000)
  --agent <name>  --run <id>             Filter by agent or run
  --json                                 JSON output

overstory logs [options]                Query NDJSON logs across agents
  --agent <name>                         Filter by agent
  --level <level>                        Filter by log level (debug|info|warn|error)
  --since <ts>  --until <ts>             Time range filter
  --follow                               Tail logs in real time
  --json                                 JSON output

overstory costs                         Token/cost analysis and breakdown
  --live                                 Show real-time token usage for active agents
  --agent <name>                         Filter by agent
  --run <id>                             Filter by run
  --by-capability                        Group by capability type
  --last <n>  --json

overstory metrics                       Show session metrics
  --last <n>                             Last N sessions
  --json                                 JSON output

Global Flags:
  --quiet, -q                            Suppress non-error output
  --completions <shell>                  Generate shell completions (bash, zsh, fish)
```

## Tech Stack

- **Runtime**: Bun (TypeScript directly, no build step)
- **Dependencies**: Zero runtime dependencies — only Bun built-in APIs
- **Database**: SQLite via `bun:sqlite` (WAL mode for concurrent access)
- **Linting**: Biome (formatter + linter)
- **Testing**: `bun test` (1848 tests across 73 files, colocated with source)
- **External CLIs**: `bd` (beads), `mulch`, `git`, `tmux` — invoked as subprocesses

## Development

```bash
# Run tests (1848 tests across 73 files)
bun test

# Run a single test
bun test src/config.test.ts

# Lint + format check
biome check .

# Type check
tsc --noEmit

# All quality gates
bun test && biome check . && tsc --noEmit
```

### Versioning

Version is maintained in two places that must stay in sync:

1. `package.json` — `"version"` field
2. `src/index.ts` — `VERSION` constant

Use the bump script to update both:

```bash
bun run version:bump <major|minor|patch>
```

Git tags are created automatically by GitHub Actions when a version bump is pushed to `main`.

## Project Structure

```
overstory/
  src/
    index.ts                      CLI entry point (command router)
    types.ts                      Shared types and interfaces
    config.ts                     Config loader + validation
    errors.ts                     Custom error types
    commands/                     One file per CLI subcommand (29 commands)
      agents.ts                   Agent discovery and querying
      coordinator.ts              Persistent orchestrator lifecycle
      supervisor.ts               Team lead management
      dashboard.ts                Live TUI dashboard (ANSI, zero deps)
      hooks.ts                    Orchestrator hooks management
      sling.ts                    Agent spawning
      group.ts                    Task group batch tracking
      nudge.ts                    Agent nudging
      mail.ts                     Inter-agent messaging
      monitor.ts                  Tier 2 monitor management
      merge.ts                    Branch merging
      status.ts                   Fleet status overview
      prime.ts                    Context priming
      init.ts                     Project initialization
      worktree.ts                 Worktree management
      watch.ts                    Watchdog daemon
      log.ts                      Hook event logging
      logs.ts                     NDJSON log query
      feed.ts                     Unified real-time event stream
      run.ts                      Orchestration run lifecycle
      trace.ts                    Agent/bead timeline viewing
      clean.ts                    Worktree/session cleanup
      doctor.ts                   Health check runner (9 check modules)
      inspect.ts                  Deep per-agent inspection
      spec.ts                     Task spec management
      errors.ts                   Aggregated error view
      replay.ts                   Interleaved event replay
      costs.ts                    Token/cost analysis
      metrics.ts                  Session metrics
      completions.ts              Shell completion generation (bash/zsh/fish)
    agents/                       Agent lifecycle management
      manifest.ts                 Agent registry (load + query)
      overlay.ts                  Dynamic CLAUDE.md overlay generator
      identity.ts                 Persistent agent identity (CVs)
      checkpoint.ts               Session checkpoint save/restore
      lifecycle.ts                Handoff orchestration
      hooks-deployer.ts           Deploy hooks + tool enforcement
    worktree/                     Git worktree + tmux management
    mail/                         SQLite mail system (typed protocol, broadcast)
    merge/                        FIFO queue + conflict resolution
    watchdog/                     Tiered health monitoring (daemon, triage, health)
    logging/                      Multi-format logger + sanitizer + reporter + color control
    metrics/                      SQLite metrics + transcript parsing
    doctor/                       Health check modules (9 checks)
    insights/                     Session insight analyzer for auto-expertise
    beads/                        bd CLI wrapper + molecules
    mulch/                        mulch CLI wrapper
    e2e/                          End-to-end lifecycle tests
  agents/                         Base agent definitions (.md, 8 roles)
  templates/                      Templates for overlays and hooks
```

## License

MIT

---

Inspired by: https://github.com/steveyegge/gastown/

# Overstory

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
- **Messaging**: Custom SQLite mail system with typed protocol — 8 message types (`worker_done`, `merge_ready`, `dispatch`, `escalation`, etc.) for structured agent coordination
- **Worktrees**: Each agent gets an isolated git worktree — no file conflicts between agents
- **Merge**: FIFO merge queue with 4-tier conflict resolution
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
overstory init                          Initialize .overstory/ in current project
                                        (deploys agent definitions automatically)

overstory coordinator start             Start persistent coordinator agent
  --attach / --no-attach                 TTY-aware tmux attach (default: auto)
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
  --type <status|question|result|error>
  --priority <low|normal|high|urgent>    (urgent/high auto-nudges recipient)

overstory mail check                    Check inbox (unread messages)
  --agent <name>  --inject  --json

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
overstory metrics                       Show session metrics
  --last <n>                             Last N sessions
  --json                                 JSON output
```

## Tech Stack

- **Runtime**: Bun (TypeScript directly, no build step)
- **Dependencies**: Zero runtime dependencies — only Bun built-in APIs
- **Database**: SQLite via `bun:sqlite` (WAL mode for concurrent access)
- **Linting**: Biome (formatter + linter)
- **Testing**: `bun test` (912 tests across 44 files, colocated with source)
- **External CLIs**: `bd` (beads), `mulch`, `git`, `tmux` — invoked as subprocesses

## Development

```bash
# Run tests (912 tests across 44 files)
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
    commands/                     One file per CLI subcommand (17 commands)
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
      metrics.ts                  Session metrics
    agents/                       Agent lifecycle management
      manifest.ts                 Agent registry (load + query)
      overlay.ts                  Dynamic CLAUDE.md overlay generator
      identity.ts                 Persistent agent identity (CVs)
      checkpoint.ts               Session checkpoint save/restore
      lifecycle.ts                Handoff orchestration
      hooks-deployer.ts           Deploy hooks + tool enforcement
    worktree/                     Git worktree + tmux management
    mail/                         SQLite mail system (typed protocol)
    merge/                        FIFO queue + conflict resolution
    watchdog/                     Tiered health monitoring (daemon, triage, health)
    logging/                      Multi-format logger + sanitizer + reporter
    metrics/                      SQLite metrics + transcript parsing
    beads/                        bd CLI wrapper + molecules
    mulch/                        mulch CLI wrapper
    e2e/                          End-to-end lifecycle tests
  agents/                         Base agent definitions (.md, 8 roles)
  templates/                      Templates for overlays and hooks
```

## License

MIT

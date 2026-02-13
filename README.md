# Overstory

Project-agnostic swarm system for Claude Code agent orchestration. Overstory turns a single Claude Code session into a multi-agent team by spawning worker agents in git worktrees via tmux, coordinating them through a custom SQLite mail system, and merging their work back with tiered conflict resolution.

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

### Key Architecture

- **Agent Definitions**: Two-layer system — base `.md` files define the HOW (workflow), per-task overlays define the WHAT (task scope)
- **Messaging**: Custom SQLite mail system with typed protocol — 8 message types (`worker_done`, `merge_ready`, `dispatch`, `escalation`, etc.) for structured agent coordination
- **Worktrees**: Each agent gets an isolated git worktree — no file conflicts between agents
- **Merge**: FIFO merge queue with 4-tier conflict resolution
- **Watchdog**: ZFC-principled health monitoring — tmux liveness as primary signal, pid check as secondary, with descendant tree walking for process cleanup
- **Tool Enforcement**: PreToolUse hooks mechanically block file modifications for non-implementation agents and dangerous git operations for all agents
- **Task Groups**: Batch coordination with auto-close when all member issues complete
- **Session Lifecycle**: Checkpoint save/restore for compaction survivability, handoff orchestration for crash recovery

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

# Start a coordinator (persistent orchestrator)
overstory coordinator start

# Or spawn individual worker agents
overstory sling <task-id> --capability builder --name my-builder

# Check agent status
overstory status

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

overstory sling <task-id>              Spawn a worker agent
  --capability <type>                    builder | scout | reviewer | lead | merger
                                         | coordinator | supervisor
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
  --watch                                Live updating
  --verbose                              Show detailed agent info

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

overstory log <event>                   Log a hook event
overstory watch                         Start watchdog daemon
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
- **Testing**: `bun test` (515 tests, colocated with source files)
- **External CLIs**: `bd` (beads), `mulch`, `git`, `tmux` — invoked as subprocesses

## Development

```bash
# Run tests (515 tests across 24 files)
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
    commands/                     One file per CLI subcommand
      coordinator.ts              Persistent orchestrator lifecycle
      supervisor.ts               Team lead management
      sling.ts                    Agent spawning
      group.ts                    Task group batch tracking
      nudge.ts                    Agent nudging
      mail.ts                     Inter-agent messaging
      ...
    agents/                       Agent lifecycle management
      checkpoint.ts               Session checkpoint save/restore
      lifecycle.ts                Handoff orchestration
      hooks-deployer.ts           Deploy hooks + tool enforcement
      ...
    worktree/                     Git worktree + tmux management
    mail/                         SQLite mail system (typed protocol)
    merge/                        Conflict resolution
    watchdog/                     ZFC-principled health monitoring
    logging/                      Multi-format logger
    metrics/                      SQLite metrics storage
    beads/                        bd CLI wrapper
    mulch/                        mulch CLI wrapper
    e2e/                          End-to-end lifecycle tests
  agents/                         Base agent definitions (.md)
  templates/                      Templates for overlays and hooks
```

## License

MIT

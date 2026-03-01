# Overstory

Multi-agent orchestration for AI coding agents.

[![npm](https://img.shields.io/npm/v/@os-eco/overstory-cli)](https://www.npmjs.com/package/@os-eco/overstory-cli)
[![CI](https://github.com/jayminwest/overstory/actions/workflows/ci.yml/badge.svg)](https://github.com/jayminwest/overstory/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Overstory turns a single coding session into a multi-agent team by spawning worker agents in git worktrees via tmux, coordinating them through a custom SQLite mail system, and merging their work back with tiered conflict resolution. A pluggable `AgentRuntime` interface lets you swap between runtimes — Claude Code, [Pi](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent), or your own adapter.

> **Warning: Agent swarms are not a universal solution.** Do not deploy Overstory without understanding the risks of multi-agent orchestration — compounding error rates, cost amplification, debugging complexity, and merge conflicts are the normal case, not edge cases. Read [STEELMAN.md](STEELMAN.md) for a full risk analysis and the [Agentic Engineering Book](https://github.com/jayminwest/agentic-engineering-book) ([web version](https://jayminwest.com/agentic-engineering-book)) before using this tool in production.

## Install

Requires [Bun](https://bun.sh) v1.0+, git, and tmux. At least one supported agent runtime must be installed:

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (`claude` CLI)
- [Pi](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) (`pi` CLI)
- [GitHub Copilot](https://github.com/features/copilot) (`copilot` CLI)
- [Codex](https://github.com/openai/codex) (`codex` CLI)

```bash
bun install -g @os-eco/overstory-cli
```

Or try without installing:

```bash
npx @os-eco/overstory-cli --help
```

### Development

```bash
git clone https://github.com/jayminwest/overstory.git
cd overstory
bun install
bun link              # Makes 'ov' available globally

bun test              # Run all tests
bun run lint          # Biome check
bun run typecheck     # tsc --noEmit
```

## Quick Start

```bash
# Initialize overstory in your project
cd your-project
ov init

# Install hooks into .claude/settings.local.json
ov hooks install

# Start a coordinator (persistent orchestrator)
ov coordinator start

# Or spawn individual worker agents
ov sling <task-id> --capability builder --name my-builder

# Check agent status
ov status

# Live dashboard for monitoring the fleet
ov dashboard

# Nudge a stalled agent
ov nudge <agent-name>

# Check mail from agents
ov mail check --inject
```

## Commands

Every command supports `--json` where noted. Global flags: `-q`/`--quiet`, `--timing`. ANSI colors respect `NO_COLOR`.

### Core Workflow

| Command | Description |
|---------|-------------|
| `ov init` | Initialize `.overstory/` and bootstrap os-eco tools (`--yes`, `--name`, `--tools`, `--skip-mulch`, `--skip-seeds`, `--skip-canopy`, `--skip-onboard`, `--json`) |
| `ov sling <task-id>` | Spawn a worker agent (`--capability`, `--name`, `--spec`, `--files`, `--parent`, `--depth`, `--skip-scout`, `--skip-review`, `--max-agents`, `--dispatch-max-agents`, `--skip-task-check`, `--no-scout-check`, `--runtime`, `--base-branch`, `--json`) |
| `ov stop <agent-name>` | Terminate a running agent (`--clean-worktree`, `--json`) |
| `ov prime` | Load context for orchestrator/agent (`--agent`, `--compact`) |
| `ov spec write <task-id>` | Write a task specification (`--body`) |

### Coordination

| Command | Description |
|---------|-------------|
| `ov coordinator start` | Start persistent coordinator agent (`--attach`/`--no-attach`, `--watchdog`, `--monitor`) |
| `ov coordinator stop` | Stop coordinator |
| `ov coordinator status` | Show coordinator state |
| `ov supervisor start` | **[DEPRECATED]** Start per-project supervisor agent |
| `ov supervisor stop` | **[DEPRECATED]** Stop supervisor |
| `ov supervisor status` | **[DEPRECATED]** Show supervisor state |

### Messaging

| Command | Description |
|---------|-------------|
| `ov mail send` | Send a message (`--to`, `--subject`, `--body`, `--type`, `--priority`) |
| `ov mail check` | Check inbox — unread messages (`--agent`, `--inject`, `--debounce`, `--json`) |
| `ov mail list` | List messages with filters (`--from`, `--to`, `--unread`) |
| `ov mail read <id>` | Mark message as read |
| `ov mail reply <id>` | Reply in same thread (`--body`) |
| `ov nudge <agent> [message]` | Send a text nudge to an agent (`--from`, `--force`, `--json`) |

### Task Groups

| Command | Description |
|---------|-------------|
| `ov group create <name>` | Create a task group for batch tracking |
| `ov group status <name>` | Show group progress |
| `ov group add <name> <issue-id>` | Add issue to group |
| `ov group list` | List all groups |

### Merge

| Command | Description |
|---------|-------------|
| `ov merge` | Merge agent branches into canonical (`--branch`, `--all`, `--into`, `--dry-run`, `--json`) |

### Observability

| Command | Description |
|---------|-------------|
| `ov status` | Show all active agents, worktrees, tracker state (`--json`, `--verbose`, `--all`) |
| `ov dashboard` | Live TUI dashboard for agent monitoring (`--interval`, `--all`) |
| `ov inspect <agent>` | Deep per-agent inspection (`--follow`, `--interval`, `--no-tmux`, `--limit`, `--json`) |
| `ov trace` | View agent/task timeline (`--agent`, `--run`, `--since`, `--until`, `--limit`, `--json`) |
| `ov errors` | Aggregated error view across agents (`--agent`, `--run`, `--since`, `--until`, `--limit`, `--json`) |
| `ov replay` | Interleaved chronological replay (`--run`, `--agent`, `--since`, `--until`, `--limit`, `--json`) |
| `ov feed` | Unified real-time event stream (`--follow`, `--interval`, `--agent`, `--run`, `--json`) |
| `ov logs` | Query NDJSON logs across agents (`--agent`, `--level`, `--since`, `--until`, `--follow`, `--json`) |
| `ov costs` | Token/cost analysis and breakdown (`--live`, `--self`, `--agent`, `--run`, `--bead`, `--by-capability`, `--last`, `--json`) |
| `ov metrics` | Show session metrics (`--last`, `--json`) |
| `ov run list` | List orchestration runs (`--last`, `--json`) |
| `ov run show <id>` | Show run details |
| `ov run complete` | Mark current run as completed |

### Infrastructure

| Command | Description |
|---------|-------------|
| `ov hooks install` | Install orchestrator hooks to `.claude/settings.local.json` (`--force`) |
| `ov hooks uninstall` | Remove orchestrator hooks |
| `ov hooks status` | Check if hooks are installed |
| `ov worktree list` | List worktrees with status |
| `ov worktree clean` | Remove completed worktrees (`--completed`, `--all`, `--force`) |
| `ov watch` | Start watchdog daemon — Tier 0 (`--interval`, `--background`) |
| `ov monitor start` | Start Tier 2 monitor agent |
| `ov monitor stop` | Stop monitor agent |
| `ov monitor status` | Show monitor state |
| `ov log <event>` | Log a hook event (`--agent`) |
| `ov clean` | Clean up worktrees, sessions, artifacts (`--completed`, `--all`, `--run`) |
| `ov doctor` | Run health checks on overstory setup — 11 categories (`--category`, `--fix`, `--json`) |
| `ov ecosystem` | Show os-eco tool versions and health (`--json`) |
| `ov upgrade` | Upgrade overstory to latest npm version (`--check`, `--all`, `--json`) |
| `ov agents discover` | Discover agents by capability/state/parent (`--capability`, `--state`, `--parent`, `--json`) |
| `ov completions <shell>` | Generate shell completions (bash, zsh, fish) |

## Architecture

Overstory uses instruction overlays and tool-call guards to turn agent sessions into orchestrated workers. Each agent runs in an isolated git worktree via tmux. Inter-agent messaging is handled by a custom SQLite mail system (WAL mode, ~1-5ms per query) with typed protocol messages and broadcast support. A FIFO merge queue with 4-tier conflict resolution merges agent branches back to canonical. A tiered watchdog system (Tier 0 mechanical daemon, Tier 1 AI-assisted triage, Tier 2 monitor agent) ensures fleet health. See [CLAUDE.md](CLAUDE.md) for full technical details.

### Runtime Adapters

Overstory is runtime-agnostic. The `AgentRuntime` interface (`src/runtimes/types.ts`) defines the contract — each adapter handles spawning, config deployment, guard enforcement, readiness detection, and transcript parsing for its runtime. Set the default in `config.yaml` or override per-agent with `ov sling --runtime <name>`.

| Runtime | CLI | Guard Mechanism | Status |
|---------|-----|-----------------|--------|
| Claude Code | `claude` | `settings.local.json` hooks | Stable |
| Pi | `pi` | `.pi/extensions/` guard extension | Active development |
| Copilot | `copilot` | (none — `--allow-all-tools`) | Active development |
| Codex | `codex` | OS-level sandbox (Seatbelt/Landlock) | Active development |

## How It Works

Instruction overlays + tool-call guards + the `ov` CLI turn your coding session into a multi-agent orchestrator. A persistent coordinator agent manages task decomposition and dispatch, while a mechanical watchdog daemon monitors agent health in the background.

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
- **Tool Enforcement**: Runtime-specific guards (hooks for Claude Code, extensions for Pi) mechanically block file modifications for non-implementation agents and dangerous git operations for all agents
- **Task Groups**: Batch coordination with auto-close when all member issues complete
- **Session Lifecycle**: Checkpoint save/restore for compaction survivability, handoff orchestration for crash recovery
- **Token Instrumentation**: Session metrics extracted from runtime transcript files (JSONL)

## Project Structure

```
overstory/
  src/
    index.ts                      CLI entry point (Commander.js program)
    types.ts                      Shared types and interfaces
    config.ts                     Config loader + validation
    errors.ts                     Custom error types
    json.ts                       Standardized JSON envelope helpers
    commands/                     One file per CLI subcommand (32 commands)
      agents.ts                   Agent discovery and querying
      coordinator.ts              Persistent orchestrator lifecycle
      supervisor.ts               Team lead management [DEPRECATED]
      dashboard.ts                Live TUI dashboard (ANSI via Chalk)
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
      trace.ts                    Agent/task timeline viewing
      clean.ts                    Worktree/session cleanup
      doctor.ts                   Health check runner (11 check modules)
      inspect.ts                  Deep per-agent inspection
      spec.ts                     Task spec management
      errors.ts                   Aggregated error view
      replay.ts                   Interleaved event replay
      stop.ts                     Agent termination
      costs.ts                    Token/cost analysis
      metrics.ts                  Session metrics
      ecosystem.ts                os-eco tool dashboard
      upgrade.ts                  npm version upgrades
      completions.ts              Shell completion generation (bash/zsh/fish)
    agents/                       Agent lifecycle management
      manifest.ts                 Agent registry (load + query)
      overlay.ts                  Dynamic CLAUDE.md overlay generator
      identity.ts                 Persistent agent identity (CVs)
      checkpoint.ts               Session checkpoint save/restore
      lifecycle.ts                Handoff orchestration
      hooks-deployer.ts           Deploy hooks + tool enforcement
      guard-rules.ts              Shared guard constants (tool lists, bash patterns)
    worktree/                     Git worktree + tmux management
    mail/                         SQLite mail system (typed protocol, broadcast)
    merge/                        FIFO queue + conflict resolution
    watchdog/                     Tiered health monitoring (daemon, triage, health)
    logging/                      Multi-format logger + sanitizer + reporter + color control + shared theme/format
    metrics/                      SQLite metrics + pricing + transcript parsing
    doctor/                       Health check modules (11 checks)
    insights/                     Session insight analyzer for auto-expertise
    runtimes/                     AgentRuntime abstraction (registry + adapters: Claude, Pi, Copilot, Codex)
    tracker/                      Pluggable task tracker (beads + seeds backends)
    mulch/                        mulch client (programmatic API + CLI wrapper)
    e2e/                          End-to-end lifecycle tests
  agents/                         Base agent definitions (.md, 8 roles) + skill definitions
  templates/                      Templates for overlays and hooks
```

## Part of os-eco

Overstory is part of the [os-eco](https://github.com/jayminwest/os-eco) AI agent tooling ecosystem.

<p align="center">
  <img src="https://raw.githubusercontent.com/jayminwest/os-eco/main/branding/logo.png" alt="os-eco" width="444" />
</p>

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

MIT

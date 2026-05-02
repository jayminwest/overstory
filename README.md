# Overstory

Multi-agent orchestration for AI coding agents.

[![npm](https://img.shields.io/npm/v/@os-eco/overstory-cli)](https://www.npmjs.com/package/@os-eco/overstory-cli)
[![CI](https://github.com/jayminwest/overstory/actions/workflows/ci.yml/badge.svg)](https://github.com/jayminwest/overstory/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Overstory turns a single coding session into a multi-agent team by spawning worker agents in isolated git worktrees, coordinating them through a custom SQLite mail system, and merging their work back with tiered conflict resolution. New projects spawn Claude agents headless and surface them through a web UI (`ov serve`); `tmux attach` is the opt-in escape hatch for live steering. A pluggable `AgentRuntime` interface lets you swap between 11 runtimes — Claude Code, [Pi](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent), [Gemini CLI](https://github.com/google-gemini/gemini-cli), [Aider](https://aider.chat), [Goose](https://github.com/block/goose), [Amp](https://amp.dev), or your own adapter.

> **Warning: Agent swarms are not a universal solution.** Do not deploy Overstory without understanding the risks of multi-agent orchestration — compounding error rates, cost amplification, debugging complexity, and merge conflicts are the normal case, not edge cases. Read [STEELMAN.md](STEELMAN.md) for a full risk analysis and the [Agentic Engineering Book](https://github.com/jayminwest/agentic-engineering-book) ([web version](https://jayminwest.com/agentic-engineering-book)) before using this tool in production.

> **Maintenance status.** Overstory is maintained part-time. PRs are reviewed in roughly 2-week batches; PRs inactive for 30+ days are closed (reopen anytime). For features larger than ~200 lines, open an issue or discussion first. See [CONTRIBUTING.md](CONTRIBUTING.md#review-cadence).

## Install

Requires [Bun](https://bun.sh) v1.0+ and git. `tmux` is optional — only needed if you want to spawn workers with `--no-headless` or attach to a coordinator/worker pane directly. At least one supported agent runtime must be installed:

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (`claude` CLI)
- [Pi](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) (`pi` CLI)
- [GitHub Copilot](https://github.com/features/copilot) (`copilot` CLI)
- [Codex](https://github.com/openai/codex) (`codex` CLI)
- [Gemini CLI](https://github.com/google-gemini/gemini-cli) (`gemini` CLI)
- [Cursor CLI](https://cursor.com/docs/cli/overview) (`agent` CLI)
- [Sapling](https://github.com/jayminwest/sapling) (`sp` CLI)
- [OpenCode](https://opencode.ai) (`opencode` CLI)
- [Aider](https://aider.chat) (`aider` CLI)
- [Goose](https://github.com/block/goose) (`goose` CLI)
- [Amp](https://amp.dev) (`amp` CLI)

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

# Open the web UI — primary operator surface for the swarm
ov serve   # then open http://localhost:7321
```

`ov serve` is where you watch the fleet, read the mail bus, and inspect
per-agent timelines. New projects spawn Claude workers headless by default,
so the UI sees them with full structured-event fidelity.

Other common commands:

```bash
# Spawn an individual worker agent (coordinator usually does this for you)
ov sling <task-id> --capability builder --name my-builder

# Force a worker into tmux when you want to attach mid-session
ov sling <task-id> --capability builder --name my-builder --no-headless
tmux attach -t ov-my-builder

# Inspect state from the CLI (also visible in the UI)
ov status
ov dashboard          # live TUI alternative to the web UI
ov mail check --inject
ov nudge <agent-name> # send a follow-up to a stalled agent
```

## Commands

Every command supports `--json` where noted. Global flags: `-q`/`--quiet`, `--timing`, `--project <path>`. ANSI colors respect `NO_COLOR`.

### Core Workflow

| Command | Description |
|---------|-------------|
| `ov init` | Initialize `.overstory/` and bootstrap os-eco tools (`--yes`, `--name`, `--tools`, `--skip-mulch`, `--skip-seeds`, `--skip-canopy`, `--skip-onboard`, `--json`) |
| `ov sling <task-id>` | Spawn a worker agent (`--capability`, `--name`, `--spec`, `--files`, `--parent`, `--depth`, `--skip-scout`, `--skip-review`, `--max-agents`, `--dispatch-max-agents`, `--skip-task-check`, `--no-scout-check`, `--runtime`, `--base-branch`, `--profile`, `--headless`, `--no-headless`, `--recover`, `--json`) |
| `ov stop <agent-name>` | Terminate a running agent (`--clean-worktree`, `--json`) |
| `ov prime` | Load context for orchestrator/agent (`--agent`, `--compact`) |
| `ov spec write <task-id>` | Write a task specification (`--body`) |
| `ov discover` | Discover a brownfield codebase via coordinator-driven scout swarm (`--skip`, `--name`, `--attach`, `--watchdog`, `--json`) |
| `ov update` | Refresh `.overstory/` managed files from installed package (`--agents`, `--manifest`, `--hooks`, `--dry-run`, `--json`) |

### Coordination

| Command | Description |
|---------|-------------|
| `ov coordinator start` | Start persistent coordinator agent (`--attach`/`--no-attach`, `--watchdog`, `--monitor`, `--profile`) |
| `ov coordinator stop` | Stop coordinator |
| `ov coordinator status` | Show coordinator state |
| `ov coordinator send` | Fire-and-forget message to coordinator (`--subject`) |
| `ov coordinator ask` | Synchronous request/response to coordinator (`--subject`, `--timeout`) |
| `ov coordinator output` | Show recent coordinator output (`--lines`) |
| `ov coordinator check-complete` | Evaluate exit triggers, return completion status |
| `ov orchestrator start` | Start multi-repo orchestrator agent (`--attach`/`--no-attach`, `--watchdog`, `--profile`) |
| `ov orchestrator stop` | Stop orchestrator |
| `ov orchestrator status` | Show orchestrator state |
| `ov orchestrator send` | Fire-and-forget message to orchestrator (`--subject`) |
| `ov orchestrator ask` | Synchronous request/response to orchestrator (`--subject`, `--timeout`) |
| `ov orchestrator output` | Show recent orchestrator output (`--lines`) |
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
| `ov doctor` | Run health checks on overstory setup — 13 categories (`--category`, `--fix`, `--json`) |
| `ov serve` | HTTP + WebSocket surface for the web UI (`--port`, `--host`, `--json`) |
| `ov ecosystem` | Show os-eco tool versions and health (`--json`) |
| `ov upgrade` | Upgrade overstory to latest npm version (`--check`, `--all`, `--json`) |
| `ov agents discover` | Discover agents by capability/state/parent (`--capability`, `--state`, `--parent`, `--json`) |
| `ov completions <shell>` | Generate shell completions (bash, zsh, fish) |

## Architecture

Overstory uses instruction overlays and tool-call guards to turn agent sessions into orchestrated workers. Each agent runs in an isolated git worktree; new projects spawn Claude workers as headless subprocesses (stream-json over stdout) and surface them through `ov serve`'s web UI, with tmux available as an opt-in for live attach. Inter-agent messaging is handled by a custom SQLite mail system (WAL mode, ~1-5ms per query) with typed protocol messages and broadcast support. A FIFO merge queue with 4-tier conflict resolution merges agent branches back to canonical. A tiered watchdog system (Tier 0 mechanical daemon, Tier 1 AI-assisted triage, Tier 2 monitor agent) ensures fleet health. See [CLAUDE.md](CLAUDE.md) for full technical details.

### Runtime Adapters

Overstory is runtime-agnostic. The `AgentRuntime` interface (`src/runtimes/types.ts`) defines the contract — each adapter handles spawning, config deployment, guard enforcement, readiness detection, and transcript parsing for its runtime. Set the default in `config.yaml` or override per-agent with `ov sling --runtime <name>`.

Claude Code agents can run in **headless mode** (the default for new projects — `-p --output-format stream-json` subprocess, NDJSON events parsed by `ClaudeRuntime.parseEvents`, surfaced through `ov serve`'s web UI) or **tmux mode** (escape hatch for live attach — operator can `tmux attach` to watch and steer mid-session). `ov init` writes `runtime.claudeHeadlessByDefault: true` for new projects; legacy projects upgrading from earlier overstory versions keep tmux until they edit config. Override per-spawn with `ov sling --no-headless` (force tmux) or `--headless` (force headless). Sapling is statically headless; Pi, Codex, and Cursor have no `buildDirectSpawn` and reject `--headless`.

| Runtime | CLI | Guard Mechanism | Stability |
|---------|-----|-----------------|-----------|
| Claude Code | `claude` | `settings.local.json` hooks | Stable |
| Sapling | `sp` | `.sapling/guards.json` | Stable |
| Pi | `pi` | `.pi/extensions/` guard extension | Experimental |
| Copilot | `copilot` | (none — `--allow-all-tools`) | Experimental |
| Cursor | `agent` | (none — `--yolo`) | Experimental |
| Codex | `codex` | OS-level sandbox (Seatbelt/Landlock) | Experimental |
| Gemini | `gemini` | `--sandbox` flag | Experimental |
| Aider | `aider` | (none — `--yes-always`) | Experimental |
| Goose | `goose` | Profile-based permissions | Experimental |
| Amp | `amp` | Built-in approval system | Experimental |
| OpenCode | `opencode` | (none) | Experimental |

## How It Works

Instruction overlays + tool-call guards + the `ov` CLI turn your coding session into a multi-agent orchestrator. A persistent coordinator agent manages task decomposition and dispatch, while a mechanical watchdog daemon monitors agent health in the background.

```
Orchestrator (multi-repo coordinator of coordinators)
  --> Coordinator (persistent orchestrator at project root)
        --> Supervisor / Lead (team lead, depth 1)
              --> Workers: Scout, Builder, Reviewer, Merger (depth 2)
```

### Agent Types

| Agent | Role | Access |
|-------|------|--------|
| **Orchestrator** | Multi-repo coordinator of coordinators — dispatches coordinators per sub-repo | Read-only |
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
    commands/                     One file per CLI subcommand (38 commands)
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
      doctor.ts                   Health check runner (13 check modules)
      inspect.ts                  Deep per-agent inspection
      spec.ts                     Task spec management
      errors.ts                   Aggregated error view
      replay.ts                   Interleaved event replay
      stop.ts                     Agent termination
      costs.ts                    Token/cost analysis
      metrics.ts                  Session metrics
      ecosystem.ts                os-eco tool dashboard
      update.ts                   Refresh managed files
      upgrade.ts                  npm version upgrades
      discover.ts                 Brownfield codebase discovery via coordinator-driven scout swarm
      orchestrator.ts             Multi-repo coordination (PersistentAgentSpec)
      completions.ts              Shell completion generation (bash/zsh/fish)
      serve.ts                    HTTP + WebSocket surface for the web UI
      serve/                      REST handlers, WebSocket broadcaster, static SPA fallback
    canopy/
      client.ts                   Canopy client (prompt rendering, listing, emission)
    agents/                       Agent lifecycle management
      manifest.ts                 Agent registry (load + query)
      overlay.ts                  Dynamic CLAUDE.md overlay generator
      identity.ts                 Persistent agent identity (CVs)
      checkpoint.ts               Session checkpoint save/restore
      lifecycle.ts                Handoff orchestration
      hooks-deployer.ts           Deploy hooks + tool enforcement
      copilot-hooks-deployer.ts   Deploy hooks config to Copilot worktrees
      guard-rules.ts              Shared guard constants (tool lists, bash patterns)
      mail-poll-detect.ts         Bash mail-poll pattern detector (runtime backstop)
      scope-detect.ts             Soft FILE_SCOPE violation detection (builder/merger)
    worktree/                     Git worktree + tmux management
    mail/                         SQLite mail system (typed protocol, broadcast)
    merge/                        FIFO queue + conflict resolution + sentinel-file lock + dry-run prediction
    watchdog/                     Tiered health monitoring (daemon, triage, health)
    logging/                      Multi-format logger + sanitizer + reporter + color control + shared theme/format
    metrics/                      SQLite metrics + pricing + transcript parsing
    doctor/                       Health check modules (13 checks)
    utils/                        Shared utilities (bin, fs, pid, time, version)
    insights/                     Session insight analyzer + quality-gate runner (success/partial/failure)
    runtimes/                     AgentRuntime abstraction (registry + adapters: Claude, Pi, Copilot, Codex, Gemini, Sapling, OpenCode, Cursor, Aider, Goose, Amp)
    tracker/                      Pluggable task tracker (beads + seeds backends)
    mulch/                        mulch client (programmatic API + CLI wrapper)
    e2e/                          End-to-end lifecycle tests
  agents/                         Base agent definitions (.md, 9 roles) + skill definitions
  templates/                      Templates for overlays and hooks
```

## Configuration

### Gateway Providers

Route agent API calls through custom gateway endpoints (z.ai, OpenRouter, self-hosted proxies). Configure providers in `.overstory/config.yaml`:

```yaml
providers:
  anthropic:
    type: native
  zai:
    type: gateway
    baseUrl: https://api.z.ai/v1
    authTokenEnv: ZAI_API_KEY
  openrouter:
    type: gateway
    baseUrl: https://openrouter.ai/api/v1
    authTokenEnv: OPENROUTER_API_KEY
models:
  builder: zai/claude-sonnet-4-6
  scout: openrouter/openai/gpt-4o
```

**How it works:** Model refs use `provider/model-id` format. Overstory sets `ANTHROPIC_BASE_URL` to the gateway `baseUrl`, `ANTHROPIC_AUTH_TOKEN` from the env var named in `authTokenEnv`, and `ANTHROPIC_API_KEY=""` to prevent direct Anthropic calls. The agent receives `"sonnet"` as a model alias and Claude Code routes via env vars.

**Environment variable notes:**
- `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_API_KEY` are mutually exclusive per-agent
- Gateway agents get `ANTHROPIC_API_KEY=""` and `ANTHROPIC_AUTH_TOKEN` from provider config
- Direct Anthropic API calls (merge resolver, watchdog triage) still need `ANTHROPIC_API_KEY` in the orchestrator env

**Validation:** `ov doctor --category providers` checks reachability, auth tokens, model-provider refs, and tool-use compatibility.

**`ProviderConfig` fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `native` or `gateway` | Yes | Provider type |
| `baseUrl` | string | Gateway only | API endpoint URL |
| `authTokenEnv` | string | Gateway only | Env var name holding auth token |

## Troubleshooting

### Recovering a dead lead (or any agent that exited mid-task)

If a lead exits without sending `merge_ready` (process termination, watchdog kill, manual `ov stop`) and the task was already closed, both `ov nudge` and `ov sling` would normally refuse to re-engage:

- `ov nudge <name>` reports `No active session for agent "..." (state: completed)`. The agent's process is gone, so there's nothing to send keystrokes to.
- `ov sling <task-id> --capability lead` reports `Task "..." is not workable (status: closed)`.

To re-dispatch a fresh lead against the same task, pass `--recover`:

```bash
ov sling <task-id> --capability lead --recover --name <fresh-name>
```

`--recover` bypasses the workable-status check so the new lead can pick up where the dead one left off (the task remains closed; the new lead reads the spec and proceeds). The terminal-state nudge error itself includes a copy-paste hint to this exact form.

### Coordinator died during startup

This error means the coordinator tmux session exited before the TUI became ready. The most common cause is slow shell initialization.

**Step 1: Measure shell startup time**

```bash
time zsh -i -c exit   # For zsh
time bash -i -c exit  # For bash
```

If startup takes more than 1 second, slow shell init is likely the cause.

**Step 2: Common slow-startup causes**

| Cause | Typical delay | Fix |
|-------|---------------|-----|
| oh-my-zsh with many plugins | 1-5s | Reduce plugins, switch to lighter framework (zinit with lazy loading) |
| nvm (Node Version Manager) | 1-3s | Use `--no-use` + lazy-load nvm, or switch to fnm/volta |
| pyenv init | 0.5-2s | Lazy-load pyenv |
| rbenv init | 0.5-1s | Lazy-load rbenv |
| starship prompt | 0.5-1s | Check starship timings |
| conda auto-activate | 1-3s | `auto_activate_base: false` in `.condarc` |
| Homebrew shellenv | 0.5-1s | Cache output instead of evaluating every shell start |

**Step 3: Configure `shellInitDelayMs`** in `.overstory/config.yaml`:

```yaml
runtime:
  shellInitDelayMs: 3000
```

- Default: `0` (no delay)
- Typical values: `1000`–`5000` depending on shell startup time
- Values above `30000` (30s) trigger a warning
- Inserts a delay between tmux session creation and TUI readiness polling

**Step 4: Optimization examples**

Lazy-load nvm (add to `~/.zshrc` or `~/.bashrc`):

```bash
# Lazy-load nvm — only activates when you first call nvm/node/npm
export NVM_DIR="$HOME/.nvm"
nvm() { unset -f nvm node npm npx; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"; nvm "$@"; }
node() { unset -f nvm node npm npx; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"; node "$@"; }
npm()  { unset -f nvm node npm npx; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"; npm  "$@"; }
npx()  { unset -f nvm node npm npx; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"; npx  "$@"; }
```

Reduce oh-my-zsh plugins (edit `~/.zshrc`):

```bash
# Before: plugins=(git zsh-autosuggestions zsh-syntax-highlighting node npm python ruby rbenv pyenv ...)
# After: keep only what you use regularly
plugins=(git)
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

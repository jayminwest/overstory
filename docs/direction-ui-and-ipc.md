# Direction: A Multica-Style UI Over Overstory

> Working notes on where overstory is heading: bringing a polished,
> swarm-aware web UI to the orchestration engine that already exists.

## Premise

Overstory is the swarm. The Coordinator → Lead → Worker hierarchy, the
SQLite mail bus, the git-worktree isolation, the FIFO merger, the watchdog
tiers — all of that is built. What's missing isn't another orchestrator;
it's an observability and control shell that's actually pleasant to live in.

The tool that has nailed that shell — for a single-agent world — is
[Multica](https://github.com/multica). The lesson from spending hours in
its UI isn't "we should have what they have." It's a clearer one: **the
quality of the UI is downstream of the IPC**. Multica's UI works because
its agents emit structured events over stdout, not because the frontend
is clever. Overstory's UI is hard to build because the agents emit human
text into a tmux pane, and pane scraping is fundamentally lossy.

This doc is the direction we're committing to: **borrow Multica's IPC
pattern, do not fork Multica, and lean entirely into overstory.**

## What Multica gets right (and we'll copy)

In Multica's daemon, every Claude Code agent is spawned with stream-json:

```
claude -p \
  --output-format stream-json \
  --input-format stream-json \
  --verbose \
  --strict-mcp-config \
  --permission-mode bypassPermissions
```

(See `multica/server/pkg/agent/claude.go:62`.) Each line on stdout is
one JSON event — assistant message, tool use, tool result, status,
result. The daemon reads with a line scanner, batches text events on
500ms windows, persists session IDs to the DB on the **first** assistant
message so a crash never loses the resume pointer
(`multica/server/internal/daemon/daemon.go:1407–1421`), and publishes
typed events to an in-process bus. The bus fans out to a WebSocket
broadcaster scoped to a workspace room
(`multica/server/cmd/server/listeners.go:24–193`,
`multica/server/internal/realtime/hub.go`). The web frontend connects
to `/ws?workspace=...` and renders structured events live.

Adding a new agent backend is ~300–500 lines: implement
`Backend.Execute(ctx, prompt, opts) -> *Session`, where `Session`
exposes a `Messages` channel and a `Result` channel
(`multica/server/pkg/agent/agent.go:16–21`). That's the entire surface.

The pattern is portable. Nothing in it is Go-specific or Multica-specific.

## What we are not doing

- **Not forking Multica.** Its license forbids SaaS resale, the codebase
  is ~150k LOC of Go + Next.js + Electron, and most of what makes it
  work is a pattern, not a program. We import the pattern.
- **Not continuing grove.** The "every agent gets its own machine" thesis
  was solving the wrong problem given how cheap one-machine-many-agents
  actually is. Anything we end up needing from grove (Postgres
  backplane, durable merge queue) we will lift as standalone modules
  if and when we need them — not as a foundation.
- **Not switching languages.** Overstory stays TypeScript on Bun.
- **Not adopting K8s.** The isolation knob we want is "machine per
  swarm," not "machine per agent" (see Containerization below).

## Architectural direction

The endpoint we are building toward:

```
┌─────────────────────────────────────────────────────────┐
│  Browser (or Electron, eventually)                      │
│  ┌─────────────────────────────────────────────────┐    │
│  │ Web UI: live agent panels, mail inbox,          │    │
│  │ swarm topology view, fork/resume affordances    │    │
│  └─────────────────────────────────────────────────┘    │
│                       ▲ WebSocket                       │
└───────────────────────┼─────────────────────────────────┘
                        │
┌───────────────────────┼─────────────────────────────────┐
│  ov serve (new)       ▼                                 │
│  HTTP + WS server: subscribes to EventStore, mail,      │
│  SessionStore. Exposes /api/runs, /api/agents,          │
│  /api/mail, /api/events, /ws.                           │
└──────┬──────────────────────────────────────────────────┘
       │
       │ reads / publishes
       ▼
┌─────────────────────────────────────────────────────────┐
│  EventStore (SQLite, exists)  +  Mail (SQLite, exists)  │
│  +  SessionStore (SQLite, exists)                       │
└──────▲──────────────────────────────────────────────────┘
       │ writes
       │
┌──────┴──────────────────────────────────────────────────┐
│  Agents (subprocess each, headless stream-json)         │
│  Claude Code via process.ts → parseEvents()             │
│  → AgentEvent → EventStore                              │
└─────────────────────────────────────────────────────────┘
```

The two new pieces are `ov serve` (HTTP + WS server) and a **headless
Claude Code adapter** that goes through `src/worktree/process.ts`
instead of `src/worktree/tmux.ts`. Everything else already exists.

## CLI subprocess first, SDK later

We start by spawning the Claude Code CLI with the same stream-json
flags Multica uses, and parse line-delimited JSON in
`AgentRuntime.parseEvents()`. The interface for this already exists in
`src/runtimes/types.ts:234–248` (`buildDirectSpawn`, `parseEvents`,
`headless: true`). The Claude Code adapter today targets the tmux
path; the work is adding the headless branch.

The Anthropic Claude Agent SDK is the cleaner long-term substrate —
fork, resume, and session introspection are first-class — but we're
not going there yet. Reasons:

1. The CLI subprocess pattern is what Multica is shipping in
   production today. It works. The risk is known.
2. We already have a working CLI runtime; the change is incremental.
3. The runtime abstraction we keep is what gives us optionality:
   when we move to the SDK later, it slots in as another adapter
   alongside the CLI one.

So the order is: stream-json subprocess first, prove the UI on top,
then migrate Claude specifically to the SDK once the UI's hunger for
session-introspection primitives makes the case.

## Phases

### Phase 1 — UI shell over the existing event surface

Goal: a working web UI that reads structured data, without touching
tmux or the runtime layer.

- Add `ov serve` command that boots an HTTP + WS server.
- Endpoints over existing stores: `EventStore` (`src/events/store.ts`),
  mail (`src/mail/store.ts`), sessions (`src/sessions/store.ts`),
  runs (`src/coordinator/state.ts`).
- WebSocket scoped per run / per agent. Broadcasts on EventStore writes.
- Minimal frontend: list of agents, live event timeline per agent,
  mail inbox, fleet status.

This is roughly the scope of `~500` lines of new server code plus a
small frontend. **Tmux stays untouched.** The UI is degraded for
Claude Code agents (events come from the hook system, not stream-json,
so they're coarser) but the UI ships.

### Phase 2 — Headless Claude Code adapter via stream-json

Goal: structured events for Claude Code agents, matching the fidelity
Multica gets.

- Implement `buildDirectSpawn` and `parseEvents` for the Claude Code
  runtime. Use the same flags Multica uses
  (`-p --output-format stream-json --input-format stream-json
  --verbose --strict-mcp-config --permission-mode bypassPermissions`).
- Pin `session_id` to `SessionStore` on the **first** assistant message,
  not on completion. This is the resume-on-crash guarantee.
- The runtime opt-in is per-agent: existing tmux Claude agents
  continue to work; new headless agents go through `process.ts`.
- The UI now gets per-token streaming, per-tool-call timing,
  per-result completion — the events Multica's UI is built on.

Tmux is still available. Anyone who wants to attach to a running
agent can still spawn it via the tmux runtime. The headless runtime
is the new default for swarms driven by the UI.

### Phase 3 — Make tmux optional in the supporting subsystems

Goal: stop assuming tmux when the runtime is headless.

- `src/watchdog/daemon.ts`: swap `isSessionAlive(tmuxSession)` /
  `killSession()` for `RuntimeConnection.getState()` /
  `connection.abort()`.
- `src/commands/nudge.ts`: route nudges through the runtime's
  follow-up channel (stdin write for headless, sendKeys for tmux).
- `src/commands/dashboard.ts`: minor; only uses `isProcessAlive`,
  which is runtime-agnostic.
- `src/agents/hooks-deployer.ts`: hooks are Claude-Code-specific
  today and tied to `.claude/settings.local.json`. Headless mode
  needs an equivalent — likely server-side guards in the parser
  rather than client-side hooks.

This is the bigger refactor. Roughly `~1500` LOC. It is **not
required to ship the UI** — Phase 2 already gives the UI structured
events. Phase 3 is the polish that lets us drop tmux from a swarm
entirely, which matters for "machine per swarm" containerization
because tmux + DBus + a real terminal are not what you want inside
a container.

### Phase 4 — Migrate Claude to the Agent SDK

Goal: first-class session primitives.

- New runtime adapter `src/runtimes/claude-sdk.ts` using
  `@anthropic-ai/claude-agent-sdk`.
- Session IDs, message history, fork, and resume become structured
  API calls instead of CLI flags + JSONL truncation.
- The CLI subprocess adapter stays for non-Claude runtimes
  (Codex, Sapling, OpenCode, etc.) and as a fallback.

This is when fork-from-turn-N becomes a real UI feature, not a
hack on top of `~/.claude/projects/*.jsonl`.

## Stretch goals (gated on upstream)

These features are what would make the UI noticeably better than
Multica. They're not blockers, and some are not in our hands.

- **Mid-task steering.** Sending a new message to a running agent
  without restarting it. Today this is broken upstream — Claude Code
  doesn't reliably poll stdin while the API is streaming, and
  `kill -INT` ends the process. The honest design move is to make
  *abort + fork-from-last-turn + resume with new context* feel as
  good as steering would, since those primitives actually work.
- **Conversation forking.** Cheap once on the SDK
  (`--fork-session` exists today on the CLI but is awkward to drive
  from a UI). Plan to expose this as "branch from this turn" in the
  UI in Phase 4.
- **Rewind / move back N steps.** JSONL truncation works in
  principle but has no safety rails — truncating mid-tool-use leaves
  the agent confused about file state. Treat as risky until the
  SDK exposes a supported rewind primitive.

## Containerization: machine per swarm

The framing we're committing to is "**one machine, many agents, one
swarm per container/VM**." Not "one machine per agent."

What this requires from overstory:
- Everything a swarm needs is already under `.overstory/` in the
  project root: worktrees, mail.db, sessions.db, events.db, logs.
- The UI is reachable over HTTP + WS from `ov serve` (Phase 1).
  That's the only port the container needs to expose.
- Tmux must be optional inside the container (Phase 3). Containers
  do not have a friendly tmux story; headless is the right default
  there.

Concretely: a swarm in a container looks like
`docker run -p 8080:8080 overstory-swarm` where the entrypoint runs
`ov coordinator start && ov serve`. The user opens
`http://localhost:8080` and gets the UI. Same swarm, but isolated
from the host filesystem, host shell, and host network — which
solves most of what grove was trying to solve with K8s pods, at
roughly 1% of the operational complexity.

This isn't a separate phase. It falls out of Phases 1 + 3 with a
Dockerfile.

## What stays, what changes

**Stays:**
- The Coordinator → Lead → Worker hierarchy and `ov sling` dispatch.
- The SQLite mail bus and `ov mail` CLI.
- Git worktrees as the per-agent file-isolation mechanism.
- The `AgentRuntime` interface and the existing 11 runtime adapters.
- The watchdog tiers and existing health/triage logic.
- All the durable knowledge integrations (`ml`, `sd`, `cn`).

**Changes:**
- A new `ov serve` command and HTTP/WS server.
- A headless Claude Code runtime adapter alongside the tmux one.
- Watchdog and nudge become runtime-aware (Phase 3).
- A web UI lives in a new top-level `ui/` directory: **React +
  Tailwind + shadcn/ui**, served as a static bundle by `ov serve`.

**Eventually changes:**
- Claude Code runtime moves from CLI subprocess to Agent SDK (Phase 4).
- Hooks system gets a non-`.claude/`-coupled equivalent for headless
  agents.

## Reference patterns from Multica (exact pointers)

For when we're implementing and want to copy the right thing:

- **Stream-json spawn flags:** `multica/server/pkg/agent/claude.go:416–439`.
- **Line-scanner stdout parsing:** `multica/server/pkg/agent/claude.go:143–186`.
- **Eager session-id pinning:** `multica/server/internal/daemon/daemon.go:1407–1421`.
- **Batched text flushing (500ms windows):** `multica/server/internal/daemon/daemon.go:1348–1396`.
- **Pub/sub event bus:** `multica/server/internal/events/bus.go`.
- **WebSocket broadcaster + per-workspace rooms:** `multica/server/cmd/server/listeners.go:24–193`, `multica/server/internal/realtime/hub.go`.
- **Backend interface (the abstraction we're mirroring):** `multica/server/pkg/agent/agent.go:16–21`.
- **Workspace isolation pattern:** `multica/server/internal/daemon/execenv/execenv.go:77–131`.

## Decisions

- **UI stack: React + Tailwind + shadcn/ui.** Served as a static
  bundle by `ov serve`. No Electron, no Next.js — a single SPA is
  enough since we control the server.
- **No auth.** Overstory is not a SaaS. `ov serve` binds localhost
  by default; if someone exposes the port (e.g. via a container),
  they're opting into trust by configuration. We'll revisit if and
  when there's a multi-user use case.

## Open questions

These are not blockers; they're the things worth thinking about
before Phase 1 starts in earnest.

1. **Mail UX.** Today mail injects into agent context via a
   `UserPromptSubmit` hook. The UI gives us a second surface — should
   the user be able to inject mail directly, bypassing agents? Probably
   yes for the human-in-the-loop case.
2. **Hook replacement for headless.** Server-side parsing of
   stream-json events lets us enforce guards in the parser instead
   of via `.claude/settings.local.json`. Need to design that surface.

---

**Bottom line.** We've already built the swarm. The next twelve
weeks are about giving it the UI it deserves, by stealing Multica's
IPC pattern wholesale and discarding everything else. Phase 1 is
near-term and unblocked. Phases 2–4 stack cleanly. Steering and
rewind are stretch goals gated on Anthropic.

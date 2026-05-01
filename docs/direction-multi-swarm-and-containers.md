# Direction: Multi-Swarm Operator Surface and Container Isolation

> Working notes on the next axis after the headless / UI-first shift:
> letting one operator (and eventually one orchestrator agent) drive
> many concurrent swarms from a single always-running surface, then
> isolating each swarm in its own container.
>
> This doc **extends** [direction-ui-and-ipc.md](./direction-ui-and-ipc.md).
> Read that one first. Phases 1–3 of the prior doc — `ov serve`,
> headless Claude adapter, runtime-aware watchdog/nudge — are the
> foundation everything here builds on. The "Containerization: machine
> per swarm" section there sketches the end state for a single swarm
> in a container; this doc is what comes after, when one operator
> needs to see and steer many such swarms at once.

## Premise

The prior direction doc ended with: *"docker run -p 8080:8080
overstory-swarm" → operator opens localhost:8080 and gets the UI.*
That gets us **one swarm in a container**, observable through a
browser. Good — but it stops short of how the operator actually
wants to live.

The operator wants to:

1. Run `ov setup` (or the moral equivalent) once on their machine and
   leave a daemon + UI running at a stable local URL forever, the way
   `multica setup` does.
2. Open that URL whenever, and see **all** swarms — past, present,
   running concurrently — in one place.
3. Start a new swarm from the UI without touching the terminal.
4. Click into any running coordinator and have a chat with it the way
   they'd `tmux attach` today, then click out and into another one.
5. Eventually delegate that operator role itself to a higher-level
   agent (the `agents/orchestrator.md` shape, but lifted to live in
   the daemon, not in a transient session).

Everything in the prior doc is single-swarm. This doc is the multi-
swarm and isolation story that takes overstory from "I can run one
coordinator at a time and watch it in a browser" to "I can run
multiple coordinators concurrently, each isolated, each with its own
chat thread, with the UI as the only operator surface I need."

## What we are not doing

- **Not a SaaS.** No multi-user accounts, no auth model, no cloud
  control plane. The daemon runs on the operator's machine. If they
  want it on a remote box, they SSH-tunnel the port. Same posture as
  the prior doc.
- **Not Kubernetes.** "Machine per swarm" stays the isolation knob.
  Container-per-swarm via plain Docker is the target.
- **Not a separate orchestration engine.** The orchestrator-of-
  coordinators is an *agent*, running on top of the same swarm
  primitives, not a new daemon role. `agents/orchestrator.md` already
  describes most of the shape.
- **Not skipping multi-coord-on-host to go straight to containers.**
  Containers add isolation; they don't change the IPC. If the daemon
  can't run two coordinators side by side on bare host, putting each
  in a container won't fix that — it'll just hide the coordination
  bugs behind a docker boundary. Host first, container second.

## End-state architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Operator's browser → http://localhost:8080                 │
│  ┌─────────────────────────────────────────────────────┐    │
│  │ Run picker (sidebar): all runs, past + active       │    │
│  │ Per-run pane: fleet, coordinator chat, mail, events │    │
│  │ "New run" affordance → modal → spawn coordinator    │    │
│  └─────────────────────────────────────────────────────┘    │
│                       ▲ WebSocket (per-run rooms exist)     │
└───────────────────────┼─────────────────────────────────────┘
                        │
┌───────────────────────┼─────────────────────────────────────┐
│  ov daemon (the always-on `ov serve`, started by ov setup)  │
│  - Tracks N active runs (no more `current-run.txt`)         │
│  - Subscribes to events.db, mail.db, sessions.db            │
│  - Routes WS frames to per-run rooms                        │
│  - Hosts coordinator-chat REST endpoints                    │
│  - Optional: brokers between host and per-swarm containers  │
└──────┬──────────────────────────────────────────────────────┘
       │
       ▼ aggregates from
┌─────────────────────────────────────────────────────────────┐
│  Per-swarm storage roots (one per active coordinator):      │
│   - host mode:   .overstory/runs/<run-id>/                  │
│   - container:   /workspace/.overstory/ inside container,   │
│                  exposed to host via bind mount             │
│  Each root has its own worktrees, mail.db, sessions.db,     │
│  events.db, logs. Run-id is the namespacing primitive.      │
└─────────────────────────────────────────────────────────────┘
```

The two structural changes vs today:

1. **Run-id replaces `current-run.txt` as the active-swarm primitive.**
   Today there's exactly one "current" run; the daemon needs to track
   a *set* of active runs and route by run-id.
2. **Storage is run-namespaced.** Today `.overstory/worktrees/<agent>/`
   is global; tomorrow it's `.overstory/runs/<run-id>/worktrees/<agent>/`
   so two coordinators can each spawn a `builder-1` without colliding.

Everything else — the agent hierarchy, sling, mail, merge queue, the
runtime adapters, the watchdog tiers — survives unchanged in shape.
They just need to read the run-id from caller context instead of from
a single global file.

## What's already aligned

The architectural skeleton is more multi-run-ready than it looks:

- `runId` is first-class in `EventStore`, `SessionStore`, `RunStore`.
  Events are run-scoped end to end (`src/events/store.ts`).
- WebSocket broadcaster already supports per-run rooms via
  `/ws?run=<id>` (see `src/commands/serve/ws.ts:199-227`).
- `ov run list / show` exists — the multi-run history concept is
  already part of the CLI vocabulary.
- Mail.db is intentionally cross-run; that helps the orchestrator-
  agent story (a higher agent can see traffic across swarms without
  special wiring).
- The runtime adapter interface (`buildDirectSpawn`, `parseEvents`)
  has no notion of "the current run" — it's already pure.

## What pins us to single-coordinator today

The single-run artifacts that need to be unwound. These are the
load-bearing changes:

1. **`current-run.txt`.** Used in ~18 files including
   `src/watchdog/daemon.ts`, `src/commands/status.ts`,
   `src/commands/coordinator.ts`, `src/commands/dashboard.ts`,
   `src/commands/nudge.ts`, `src/commands/replay.ts`,
   `src/commands/mail.ts`, `src/commands/sling.ts`,
   `src/commands/log.ts`, `src/commands/run.ts`,
   `src/commands/clean.ts`. Each call site needs to either accept an
   explicit `--run` flag, infer from caller context, or default to
   "the user's most recently-touched run." The default-fallback
   behavior is the design call: silent vs explicit.
2. **`ov coordinator start` has no `--name`.** Implicitly there's one
   coordinator. To run two we need named coordinators and a way for
   the daemon to track which one is active in which run.
3. **Worktree namespacing.** `.overstory/worktrees/<agent-name>/` is
   global. Two coordinators each dispatching `builder-1` collide on
   disk. Either make worktree paths run-scoped, or enforce globally-
   unique names across active runs (probably the former — names
   should be human-pickable per swarm).
4. **`session-branch.txt`.** Captures the merge-target branch *at
   session start* for the current run. Per-run state — needs to live
   under the run's directory.
5. **Watchdog scope.** `src/watchdog/daemon.ts` scans all of
   `.overstory/` and reasons about agents globally. With multiple
   runs it would mis-attribute zombies and merge stalls across runs
   unless it learns to scope its scans by run.
6. **`ov coordinator output` and `ov coordinator send/ask`.** Single-
   coordinator commands. With multi-coord, every command needs a
   coordinator-name (or run-id) selector. The REST endpoints under
   `/api/coordinator/*` (see `src/commands/serve/rest.ts:501-590`)
   inherit the same singleton assumption today.
7. **Merge queue.** `merge-queue.db` is single-target. Two coords
   merging into different bases is fine (different lock files via
   `src/merge/lock.ts`), but two coords trying to merge into the
   same base needs the queue to remain authoritative across them.
   Probably already correct; needs verification.

This is a real refactor — call it ~1500-2500 LOC across 18+ files
once the call sites and tests are touched. It is **mechanical**,
though, not architectural. The hard thinking is the run-default
behavior (point 1) and the coordinator selector grammar (point 6).

## Multi-Swarm Phase A — Run-aware host daemon

Goal: two coordinators run side by side on the same host, each with
its own UI run-pane, each isolated on disk, no containers yet.

- Replace `current-run.txt` with `RunStore`-backed "active runs" set
  + a per-shell `OVERSTORY_RUN_ID` env override. CLI commands
  default to `OVERSTORY_RUN_ID` if set, then to "most-recently-
  active run" (the loosest viable default), with explicit `--run`
  always winning.
- Namespace worktrees, `session-branch.txt`, `current-run.txt`'s
  former responsibilities under `.overstory/runs/<run-id>/`.
  Migrate existing single-run projects on first daemon start
  (single in-place rename).
- Add `--name` to `ov coordinator start`; require it once a second
  coordinator is being started while the first is still active.
- Run-scope the watchdog: scan per-run, not globally.
- REST: add run-id to coordinator routes; deprecate the singleton
  routes behind a redirect.
- UI: run picker in the sidebar, becomes the home screen.
  "New run" modal triggers `POST /api/runs` which spawns a
  coordinator under a new run-id.

This phase ships without containers. The `ov setup` shape lands
here — it's just `ov serve` configured to start with the user's
session and bind a stable port. (On macOS: launchd plist; Linux:
systemd user unit; both managed by `ov setup` the same way
`multica setup` manages its daemon.)

## Multi-Swarm Phase B — Coordinator chat as the operator surface

Goal: clicking into a run replaces `tmux attach` for live operator
work.

- Coordinator chat REST already exists (`/api/coordinator/send`,
  `/api/coordinator/ask`, `/api/coordinator/output`). Generalize
  to per-coordinator (i.e. per-run) and surface as a real chat
  view, not a buried CLI-output blob.
- Stream coordinator stdout/stderr (or its stream-json output, in
  the headless-coordinator world) into the chat pane, not just
  mail-thread synthetic messages.
- Add UI affordances for the operator commands that today are
  CLI-only and that bypass the agent system: spawn a worker
  (`POST /api/agents/spawn`), nudge a worker
  (`POST /api/agents/<name>/nudge`), trigger a merge.
- Fork-from-here / abort + resume becomes a button in the chat
  view. This is the "steering primitive that actually works" the
  prior doc describes — finally surfaces in the UI.

After Phase B, the operator can do the day-to-day swarm-driving
loop without opening a terminal. tmux remains as `ov sling
--no-headless` for "I want to literally watch this one agent
type" — the niche case the prior doc projects.

## Multi-Swarm Phase C — Container per swarm

Goal: each swarm runs in its own container, the host daemon
aggregates across them.

Two viable models. Decide which when we start Phase C, not now:

**Model 1: Shared volume, per-run filesystem root.**
- Each container mounts the host's
  `.overstory/runs/<run-id>/` as `/workspace`.
- The container runs `ov coordinator start` against its mounted
  root. Its events.db, mail.db, sessions.db live on the host
  filesystem via the bind mount.
- Host `ov daemon` reads from those SQLite files directly — no
  network call between host and container for IPC. The container
  is purely a filesystem + process isolation layer.
- Pro: zero new IPC. Same code paths as host mode.
- Con: container needs read/write to host paths; security
  boundary is filesystem permissions, not network.

**Model 2: Per-container `ov serve`, host aggregator.**
- Each container runs its own `ov serve` on an internal port.
- Host `ov daemon` is an aggregator: it discovers running
  containers (Docker socket or registry file), opens REST/WS
  connections to each, and multiplexes their event streams to
  the operator's browser.
- Pro: stronger isolation; host doesn't read container DBs
  directly. Future-proof for remote-machine swarms.
- Con: real distributed system. New IPC layer. WS-of-WS.

Model 1 is the cheap shot and probably correct for v1; Model 2 is
the natural evolution if we end up running swarms on remote
machines.

Either way, "machine per swarm" stays the isolation philosophy.
Inside the container, headless is mandatory (no tmux), which is
exactly why Phase 3 of the prior doc was a prerequisite.

## What stays, what changes

**Stays:**
- The Coordinator → Lead → Worker hierarchy.
- Mail bus, runtime adapter interface, merge queue, watchdog tiers.
- The `ov` CLI as a usable surface for power users — even after
  the UI becomes primary.
- Single-coordinator as a special case: when there's only one
  active run, the UI behaves identically to today's single-run
  experience. No regression for the simple case.

**Changes (Phase A):**
- `current-run.txt` → run-aware resolution.
- `.overstory/worktrees/<agent>/` → `.overstory/runs/<run-id>/worktrees/<agent>/`.
- `ov coordinator` commands gain a coordinator/run selector.
- Watchdog becomes run-scoped.
- New `ov setup` (or rename of `ov init` + service-installation
  step) that boots the always-on daemon.

**Changes (Phase B):**
- New REST endpoints: `POST /api/agents/spawn`,
  `POST /api/agents/<name>/nudge`, `POST /api/runs`,
  merge triggers.
- Coordinator chat becomes a real view, not a debug blob.
- Operator workflows (sling, nudge, merge) move from CLI-only to
  CLI-and-UI.

**Changes (Phase C):**
- A `Dockerfile` per swarm (probably one shared image, parameterized).
- Decide host-aggregator IPC model.
- Documentation for "remote swarms" if we get there.

**Eventually changes:**
- `agents/orchestrator.md` becomes a *long-running daemon agent*
  spawned by the host daemon, not a transient session. The operator
  delegates "drive these N swarms toward outcome X" to it the same
  way a coordinator delegates to a lead today.

## Decisions

- **Run-id is the namespacing primitive.** Not project name, not
  coordinator name. Everything else (worktree paths, session
  attribution, REST routing) hangs off run-id.
- **`ov setup` mirrors `multica setup`.** One command that registers
  the daemon with the OS service manager and binds the UI port.
  Same idempotent re-run semantics.
- **Phase A ships before any container work.** No exceptions.
  Container isolation cannot mask multi-coord coordination bugs.
- **No new IPC layer in Phase A.** Aggregation in the host daemon
  reads from the same SQLite stores it reads from today. Containers
  may eventually warrant a real network IPC; that's a Phase C
  decision, not a Phase A one.

## Open questions

These are the actual decision points. None block Phase A from
starting; all need to be answered before it ships.

1. **Default-run resolution when no `--run` is passed.** "Most-
   recently-active run" is loose; "explicit error if multiple
   active and no flag" is safe but annoying for one-swarm use.
   Probably: error in CLI when ambiguous, fall back to most-recent
   in scripts via env var. Pick one and stick to it.
2. **Migration for existing single-run projects.** First time the
   new daemon sees a project with no `runs/` subdirectory and a
   live `current-run.txt`, what does it do? Probably: silent in-
   place rename to `runs/<that-run-id>/`. Needs to be
   bullet-proof — operators have real state in those projects.
3. **Coordinator chat fidelity.** What does it mean to "chat with
   a headless coordinator"? Coordinator capability is currently
   long-lived, not spawn-per-turn — but the chat UI needs an
   abstraction that works for both. Probably: chat is mail-
   driven (it always was), with the coordinator's stream-json
   output rendered as ambient context, not as the chat thread
   itself. Worth a design sketch before Phase B.
4. **Multi-run cost accounting.** `ov costs` aggregates today.
   Per-run cost views are easy; cross-run cost views are easy;
   "cost for this hierarchy across runs" (e.g. an orchestrator
   agent driving multiple coordinators) is harder. Defer until
   we have a real orchestrator-agent use case.
5. **Process supervision for the daemon.** If `ov daemon` crashes,
   what happens to the running swarms? Today coordinators are
   independent of `ov serve` — they keep running. That property
   should hold. Confirm `ov serve` failure doesn't take coords
   with it.

## Sequencing summary

In order, gated:

1. **Foundation verification** — current orientation pass. No code.
2. **Backlog cleanup** — close the open headless-reliability
   tickets (`overstory-c111`, `overstory-37da`, `overstory-629f`,
   `overstory-4159`, `overstory-7b0e`, `overstory-b869`, the
   blocked `overstory-2724`, `overstory-088b`, `overstory-0b27`).
   Dogfood the system to fix itself.
3. **Multi-Swarm Phase A** — run-aware daemon, host-mode multi-
   coordinator, `ov setup`.
4. **Multi-Swarm Phase B** — coordinator chat + UI-first operator
   workflows.
5. **Multi-Swarm Phase C** — container per swarm.

Phase 4 of the prior doc (Claude Agent SDK migration) can interleave
with any of these — it's an independent axis.

---

**Bottom line.** The prior doc got us from "tmux is the operator
surface" to "the UI is the operator surface for one swarm." This
doc is what comes next: many swarms, one operator (or one
orchestrator agent), one always-on local daemon, eventually one
container per swarm. The architectural lift is real but mechanical
— `runId` is already first-class everywhere except the
single-coordinator artifacts listed above. Once those are unwound,
the rest falls into place.

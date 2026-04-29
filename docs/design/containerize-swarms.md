<!-- written-by: containerize-research-lead -->
# Containerizing Overstory Swarms

> Design proposal for decoupling overstory from a single local repo +
> `.overstory/` directory on the operator's disk. Companion to
> `docs/direction-ui-and-ipc.md` (which commits to "machine per swarm" as
> the deployment shape) and `docs/headless-hooks-design.md` (which removed
> tmux as a hard dependency for Claude Code).

## Premise

Overstory today assumes one swarm per host filesystem. The
coordinator runs at `projectRoot`, every CLI command resolves a single
`.overstory/` directory there, and `current-run.txt` is a process-and-
filesystem singleton. As the UI becomes the primary operator surface
(`ov serve` shipped in Phase 1) and headless agents become the default
(Phase 3 landed 2026-04-29), the next bottleneck is operational:

- Multiple operators on one host can't run swarms side by side.
- Greenhouse can't safely dispatch concurrent runs against the same repo.
- Hosted swarm execution ("run this swarm somewhere else") has no story.
- Reproducibility — same agents, same CLIs, same locked versions — has no
  story either.

The framing question is: **what's the engineering work that unblocks
multi-swarm execution, and what's the deployment shape that ships on top
of it?** This doc answers both, in that order.

## The five coupling points

All five points from `overstory-e2f1` are verified by source read. File
references are pinned to commit `9804428` (current `main`).

### 1. Project root + `.overstory/` layout (`src/config.ts`)

`OVERSTORY_DIR = ".overstory"` is a module constant (`config.ts:122`).
`resolveProjectRoot()` (`config.ts:900-961`) walks five fallbacks:
explicit `--project` override, `OVERSTORY_PROJECT_ROOT` env,
worktree-segment match, `git rev-parse --git-common-dir`, then
`startDir`. The `--project` override sets a **module-level**
`_projectRootOverride: string | undefined` (`config.ts:11`) — one
overstory process can hold exactly one project root.

`DEFAULT_CONFIG` (`config.ts:47-118`) hard-codes child paths
(`agent-manifest.json`, `agent-defs/`, `worktrees/`) relative to
`project.root`. These are derivable from the root, so they're fine —
the singleton is the root itself, not the children.

### 2. `current-run.txt` is a singleton

The lead-issue mentioned 6-7 readers; the verified count is **9
production paths**:

- `src/commands/coordinator.ts:562, 684, 932, 1430` (writes + reads)
- `src/commands/sling.ts:639, 645-655` (parent inheritance + fallback)
- `src/commands/dashboard.ts:335-338`
- `src/commands/replay.ts:158-159`
- `src/commands/mail.ts:338, 420` (annotates `runId` on outgoing mail)
- `src/commands/nudge.ts:152-155`
- `src/commands/run.ts:26-29`
- `src/commands/status.ts:93`
- `src/watchdog/daemon.ts:101-105`

Two coordinators in one `.overstory/` clobber each other's run ID.
Greenhouse assumes one coordinator per project
(`greenhouse/src/dispatcher.ts:130-148`), and has five
`TODO(v0.2.0): use per-run clone dir` markers (`dispatcher.ts:94, 114,
132, 144, 206`) — the team has already named this gap.

### 3. Worktree manager assumes a live local git repo

`createWorktree()` (`src/worktree/manager.ts:46-64`) calls
`git worktree add -b overstory/{agent}/{task} <baseDir>/{agent}` against
`repoRoot`. Branch naming is fine for namespacing; **worktree path
collisions** are not — two swarms on the same `repoRoot` with the same
agent name race on the ref database.

Implication: each swarm needs its own clone, not just its own
`.overstory/`. Sharing one git repo across swarms is unsafe.

### 4. `.claude/` hooks deployed to project root

Claude Code reads `.claude/CLAUDE.md` from cwd. Hooks are deployed to
`.claude/settings.local.json` (`src/agents/hooks-deployer.ts:78,
123-124`). The hooks-deployer's `ENV_GUARD` (`hooks-deployer.ts:78`)
gates on `OVERSTORY_AGENT_NAME`, so hooks no-op for the operator's own
session — good. But:

- The coordinator deploys hooks **at projectRoot**, not its own worktree
  (`coordinator.ts:568, 694`: `worktreePath: projectRoot`). Two
  coordinators on one host clobber each other's `settings.local.json`.
- Hook commands shell out to `ov`, `ml`, `sd`, `cn` — all assumed in
  PATH (`PATH_PREFIX` at `hooks-deployer.ts:94` adds `~/.bun/bin`).
  Inside a container, those CLIs must be baked into the image.

Sapling materially differs: `SAPLING.md` and `.sapling/guards.json` are
per-worktree (`src/runtimes/sapling.ts:478-495`). Sapling never writes
to projectRoot. Sapling-only swarms are the natural lowest-risk
container target.

### 5. Coordinator runs at project root

Both headless and tmux paths set `worktreePath: projectRoot` for the
coordinator (`src/commands/coordinator.ts:568, 694`). The coordinator
therefore sees the operator's working tree (uncommitted changes, branch
HEAD), writes `.claude/settings.local.json` to projectRoot, and
reads/writes `current-run.txt` at projectRoot. There is no isolation
between the coordinator and the operator.

### Bonus: SQLite databases at `.overstory/`

All five DBs (`mail.db`, `sessions.db`, `events.db`, `metrics.db`,
`merge-queue.db`) live at `{projectRoot}/.overstory/{name}.db`. WAL mode
allows multi-process readers within one project but does not isolate
between swarms. Mail addressing assumes a flat namespace per
`mail.db` — two swarms in one DB see each other's traffic.

### Bonus: runtime-layer host coupling

Surfaced by the runtimes scout:

- **9 of 11 runtime adapters require tmux** to spawn. Only Sapling
  (always headless) and Claude (opt-in headless) implement
  `buildDirectSpawn`. `resolveUseHeadless` (`src/commands/sling.ts:483`)
  hard-rejects `--headless` for the rest.
- **POSIX FIFO at `{overstoryDir}/agents/{agentName}/stdin.fifo`** is
  the cross-process input channel for headless agents
  (`src/agents/headless-stdin.ts`). Filesystem-local; doesn't cross
  container boundaries without a shared volume.
- **`RuntimeConnection` registry is a module-local Map**
  (`src/runtimes/connections.ts`). One orchestrator process — no
  cross-process handoff.
- **Copilot mutates `~/.config/github-copilot/config.json`'s
  `trustedFolders[]`** on every spawn (`src/runtimes/copilot.ts:44-64`).
  Non-atomic against concurrent writers; the only adapter that mutates
  global host state.
- **Claude and Pi read host-rooted transcript dirs**
  (`~/.claude/projects/<projectKey>/`, `~/.pi/agent/sessions/`). Path
  encoding uses absolute projectRoot, so containers with different
  mount paths silo silently.
- **Codex `--full-auto` sandbox** (Seatbelt/Landlock) silently degrades
  inside Linux containers without a custom seccomp profile.

## The three approaches

### A. Local Docker per swarm

Ship a container image with `ov`, `ml`, `sd`, `cn`, and the agent CLIs
baked in. Operator runs `docker run -p 8080:8080 overstory-swarm`. The
container holds its own clone, its own `.overstory/`, its own
coordinator, and exposes only `ov serve` on a port.

- Solves isolation between swarms (different filesystems,
  different process trees, different network namespaces).
- Solves reproducibility (image pins toolchain).
- Does not, by itself, solve the singleton problem inside the
  container — if the *internal* code still assumes one swarm per
  filesystem, `ov serve` cannot host multiple swarms in one process,
  and a hosted "fleet view" is impossible.
- Adds significant ops surface: image build, registry, mount
  strategy for `~/.bun/bin`, secret injection for `ANTHROPIC_API_KEY`,
  network for `ov serve`.
- Doesn't help greenhouse, which calls `ov coordinator send` on the
  same host today.

This is a deployment shape, not an engineering refactor.

### B. Remote runners

A central control plane dispatches swarms to remote workers via API.
Workers pull work, execute, and stream events back.

- Solves "swarm somewhere else" directly.
- Major architectural rewrite. The current execution model is
  "orchestrator process spawns child processes via `Bun.spawn`."
  Remote dispatch turns that into RPC against a queue, with
  authentication, retry, and observability problems.
- Requires a backplane (Postgres, message queue) overstory does not
  have today. `direction-ui-and-ipc.md` explicitly says "Anything we
  end up needing from grove (Postgres backplane, durable merge queue)
  we will lift as standalone modules if and when we need them — not
  as a foundation."
- Doesn't solve concurrent-swarms-per-host either, unless the
  runner itself can host many.

Right answer eventually, wrong answer now.

### C. Logical namespacing only

Add a `SwarmContext` carrying `(projectRoot, runId, overstoryDir,
swarmId)` and thread it through every command. Two swarms on one host
each get their own `.overstory/swarms/{swarmId}/` subtree (DBs, logs,
worktrees). `ov serve` holds a `Map<swarmId, swarmHandles>` and routes
REST + WS by `swarmId`. No container runtime required.

- Solves the singleton problem at the source: every singleton
  becomes a function of `swarmId`.
- Multiple swarms on one host work immediately.
- Greenhouse's `TODO(v0.2.0): use per-run clone dir` markers close
  with the same plumbing.
- Cheapest engineering: no image, no registry, no network plumbing.
- No isolation guarantee. Two swarms still share a host kernel,
  HOME directory, and PATH. Copilot's host-config mutation still
  collides. A misbehaving agent can still escape its worktree if guards
  fail open.
- Reproducibility is best-effort (whatever versions of `ov`, `sp`,
  `claude`, etc. happen to be on PATH).

This is an engineering refactor without a deployment shape.

## Recommendation: namespacing **as** the engineering work, container per swarm **as** the deployment

The two are not in tension — they are sequenced. The dominant coupling
in the codebase is to a single filesystem path, not to a host. Once
`SwarmContext` is plumbed end-to-end, putting a container around it
becomes mechanical. Putting a container around the codebase **without**
the namespacing work leaves the singleton problem inside the container
and forecloses fleet-mode `ov serve`.

The recommendation is therefore:

1. **Phase 1 (engineering): Logical namespacing.** Plumb `SwarmContext`
   through every command. Move the coordinator into its own worktree.
   Add `OVERSTORY_DIR_OVERRIDE` for per-swarm state in one clone.
   Upgrade `ov serve` to host multiple swarms.
2. **Phase 2 (deployment): Container per swarm.** Sapling-only first
   (cleanest host coupling), then a multi-runtime image. The
   `direction-ui-and-ipc.md` framing of `docker run -p 8080:8080
   overstory-swarm` falls out of Phase 1 with a Dockerfile and a
   handful of XDG/transcript-root overrides.
3. **Phase 3 (deferred): Remote runners.** Only if and when hosted
   execution is the actual bottleneck. The control-plane / queue
   substrate is large and out of scope for this issue.

This sequencing matches `direction-ui-and-ipc.md`'s commitment to
"machine per swarm" — namespacing is what makes that commitment
implementable.

## Architectural sketch (Phase 1)

```
ov serve (one process, fleet mode)
  REST: /api/{swarmId}/{runs,agents,events,mail}
  WS:   /ws?swarm={swarmId}&run={runId}

Swarm A                Swarm B                Swarm C
projectRoot:           projectRoot:           projectRoot:
  /repos/foo             /repos/foo             /repos/bar
overstoryDir:          overstoryDir:          overstoryDir:
  .overstory/            .overstory/            .overstory/
    swarms/A/              swarms/B/              swarms/C/
runId: run-...         runId: run-...         runId: run-...
coordinator wt:        coordinator wt:        coordinator wt:
  .../wt/coord           .../wt/coord           .../wt/coord
```

A Phase-2 container runs exactly **one** of those columns, with the
container's filesystem providing the isolation that Phase 1
namespacing did not.

## Migration plan for the five coupling points

Numbering matches the coupling-points section.

### 1. `.overstory/` layout — make it relative to `SwarmContext`

- Add `SwarmContext` to `src/types.ts` with fields `projectRoot`,
  `overstoryDir`, `swarmId`, `runId`.
- Replace `getOverstoryDir(projectRoot)` (`config.ts`) with
  `getOverstoryDir(ctx: SwarmContext): string`. Default resolution:
  `${projectRoot}/.overstory` if `swarmId === "default"`, else
  `${projectRoot}/.overstory/swarms/${swarmId}`.
- Add `OVERSTORY_DIR_OVERRIDE` env var as a sibling to
  `OVERSTORY_PROJECT_ROOT`. `ov sling` already injects the latter
  (`config.ts:910-913`); extend to inject the former.
- Make `_projectRootOverride` a `Map<swarmId, projectRoot>` — or,
  better, drop the module-singleton pattern and thread `ctx`
  explicitly. The Map is the cheaper migration.

### 2. `current-run.txt` — keep as a write-only hint, stop reading it

- All 9 callsites take `runId` from `SwarmContext` instead of reading
  the file. The file remains for CLI ergonomics ("what was the last
  run") — running `ov status` from a fresh shell still finds something.
- Test contract already exists: `src/commands/run.test.ts:38-45` shows
  the right pattern.
- Greenhouse's dispatcher passes `swarmId` on `ov coordinator send`;
  greenhouse's TODO(v0.2.0) markers (`dispatcher.ts:94, 114, 132, 144,
  206`) close with the same plumbing.

### 3. Worktree manager — one clone per swarm, not one repo per host

- Adapter unchanged. The constraint moves up: each swarm's `repoRoot`
  is a fresh clone, not the operator's working tree.
- Greenhouse already creates per-run clone dirs in `shipper.ts`; the
  dispatcher needs to pass `cwd` instead of relying on `cwd: "."`.
- For the operator's local development case (one swarm, one clone),
  nothing changes.

### 4. `.claude/` hooks — coordinator runs in its own worktree

- Change `coordinator.ts:568, 694` to create a coordinator worktree
  (call `createWorktree()` like `sling` does, branch
  `overstory/coordinator/{swarmId}`, base
  `config.project.canonicalBranch`). The coordinator's
  `.claude/settings.local.json` then lands in *its* worktree, not
  projectRoot.
- Operator-side `.claude/` becomes inert (no `OVERSTORY_AGENT_NAME` →
  `ENV_GUARD` exits 0). Operator's own Claude Code session keeps
  working.
- `PATH_PREFIX` (`hooks-deployer.ts:94`) is unchanged; inside a
  container the image bakes `~/.bun/bin`.

### 5. Coordinator at projectRoot — same fix as #4

The coordinator's `worktreePath` becomes its own worktree path. Every
existing `worktreePath: projectRoot` site (`coordinator.ts:568, 694`)
flips. The session row's `worktreePath` is now meaningfully isolated
from the operator.

### Bonus: runtime-layer migrations

Touch points (in priority order):

1. **Add `buildDirectSpawn` to codex, pi, opencode, goose** where the
   upstream CLI supports headless. Eliminates tmux as a hard dep for
   those runtimes. Sapling's `buildDirectSpawn` (`sapling.ts:430-464`)
   is the template.
2. **Replace the FIFO with a Unix socket** (or generalize the
   abstraction in `RuntimeConnection`). FIFO works inside one
   container; sockets work across container boundaries with a shared
   volume. Touch points: `src/agents/headless-stdin.ts`,
   `src/worktree/process.ts:124-160`, `src/runtimes/connections.ts`,
   the `ov serve` mail injector. **Only required for "container per
   agent"; not blocking for "container per swarm."**
3. **Route Copilot config through `XDG_CONFIG_HOME`** instead of raw
   `homedir()`. One-line change in
   `src/runtimes/copilot.ts:46`. Trust list becomes per-swarm.
4. **Accept `transcriptRoot` override on `getTranscriptDir`** for
   Claude (`claude.ts:564`) and Pi (`pi.ts:297`). Containerized swarms
   keep transcripts inside their volume.
5. **(Optional) Add `runtime.binaryPath?: string`** for per-capability
   binary selection (lightweight scout image vs full builder image).

## Risk assessment

### Sapling

Lowest risk of any runtime. `SAPLING.md` and `.sapling/guards.json` are
per-worktree. NDJSON-only — no host transcript dir. RPC over
stdin/stdout. The only residual risk is the in-process
`RuntimeConnection` map, shared with headless Claude.

Containerization sequencing: **Sapling-first swarms can ship before the
runtime-layer migration completes**, because Sapling already covers all
the constraints.

Behavior change for Sapling under namespacing: `eventConfig` calls
`["ov", "log", ...]`, which today resolves `OVERSTORY_PROJECT_ROOT`
from sling's injection. Under namespacing, the same env var must also
disambiguate which swarm's `.overstory/` to write into — extend the
existing injection to include `OVERSTORY_DIR_OVERRIDE`.

### Greenhouse

Moderately affected. The work is already named in the codebase
(`dispatcher.ts:94, 114, 132, 144, 206` — five `TODO(v0.2.0)` markers).
Required changes:

- Dispatcher passes `cwd` to `ov coordinator send` per run.
- Dispatcher passes `swarmId` (or accepts the coordinator's swarmId on
  start) so subsequent `ov coordinator status --json` queries can
  disambiguate.
- `ensureCoordinatorRunning` becomes "ensure coordinator running for
  this swarmId."

Greenhouse's overall contract with overstory does not change shape —
greenhouse still talks to overstory exclusively through the coordinator
(`greenhouse/CLAUDE.md` "Greenhouse–Overstory Contract"). The change is
plumbing.

### Other runtimes (Codex, Pi, Cursor, Aider, Gemini, Goose, Amp, Copilot, OpenCode)

All inherit `SwarmContext` from the orchestrator. Per-runtime risk:

- **Codex** loses its OS-level sandbox (Seatbelt/Landlock) inside Linux
  containers without a custom seccomp profile. Document as "container:
  reduced security" until seccomp posture is sorted.
- **Copilot** is the noisiest blocker for concurrent swarms on one
  host. Fix is small (XDG re-route) but until it lands, two concurrent
  Copilot swarms race on `~/.config/github-copilot/config.json`.
- **Pi** transcript dir is host-rooted with absolute-path encoding —
  same fix shape as Claude.
- The remaining seven need `buildDirectSpawn` to fully shed tmux.

### `ov serve` fleet mode

Today `ov serve` resolves one project at startup
(`src/commands/serve.ts:312-324`), opens that project's DBs once, and
holds the file handles for the process lifetime. Fleet mode requires:

- A `Map<swarmId, SwarmHandles>` keyed by swarm.
- REST routes prefixed with `/api/{swarmId}/...`.
- WebSocket rooms scoped by `swarmId` in addition to `runId`.
- A registry of known swarms (file under `~/.overstory/serve.yaml`?
  scanned dirs? this is an open question).

This is the largest single Phase-1 deliverable. The web UI must also
gain a swarm-picker.

### Watchdog

`src/watchdog/daemon.ts:101-105` reads `current-run.txt`. Already in
the migration list. The daemon also holds a PID file; under
namespacing, the PID file path becomes per-swarm
(`{overstoryDir}/watchdog.pid`).

### Mail / merge queue / metrics

All SQLite, all per-swarm under namespacing. Cross-swarm mail
("operator broadcast to all swarms") is not a current feature; if it
becomes one, it's a `ov serve`-level concern, not a per-swarm-DB
concern.

## Followup issues to file

These are the implementation phases. **Titles + 1-line descriptions
only — do not create the seeds issues from this worktree** (per the
worktree-issue-create constraint).

1. **Define `SwarmContext` and thread through `ov sling`, `ov
   coordinator`, `ov status`, `ov dashboard`.** Stop reading
   `current-run.txt` in production; keep the file as a write-only CLI
   ergonomics hint.
2. **Move the coordinator into its own worktree.** Flip
   `worktreePath: projectRoot` at `coordinator.ts:568, 694` to a
   coordinator-owned worktree; `.claude/settings.local.json` follows.
3. **Add `OVERSTORY_DIR_OVERRIDE` env var and `--overstory-dir` global
   flag** for per-swarm state isolation in a single clone (the
   `.overstory/swarms/{swarmId}/` layout).
4. **`ov serve` fleet mode.** REST/WS swarmId routing, fleet-aware UI,
   swarm registry.
5. **Greenhouse: per-run clone dirs in `dispatcher.ts`.** Resolve the
   five existing `TODO(v0.2.0)` markers; pass `swarmId` on
   `ov coordinator send`.
6. **Add `buildDirectSpawn` to codex, pi, opencode, goose.** Eliminate
   tmux as a hard dep for runtimes whose upstream supports headless.
7. **Route Copilot config through `XDG_CONFIG_HOME`.** One-line fix
   in `src/runtimes/copilot.ts:46`; per-swarm trust list.
8. **`transcriptRoot` override on `getTranscriptDir`.** Claude
   (`claude.ts:564`) and Pi (`pi.ts:297`) — keep transcripts inside
   the swarm's volume under containerization.
9. **(Phase 2) Container image for Sapling-only swarms.** Lowest blast
   radius — Sapling has no host coupling. Dockerfile + Compose example
   that runs `ov coordinator start && ov serve` as the entrypoint.
10. **(Phase 2) Multi-runtime container image.** After items 6–8 land,
    bake the full toolchain. Recommended seccomp profile for Codex.
11. **(Deferred) FIFO → Unix socket replacement** in
    `src/agents/headless-stdin.ts`. Only blocking for "container per
    agent"; not needed for "container per swarm."

## Open questions

- **Container per swarm vs container per agent.** Phase 2 of this doc
  commits to "container per swarm." "Container per agent" is a much
  larger refactor (FIFO replacement, RPC handoff across processes,
  cross-container `RuntimeConnection`) and is not motivated by any
  current pain point. Recommend deferring indefinitely.
- **Long-term tmux story.** `direction-ui-and-ipc.md` says the UI is
  primary and tmux is the escape hatch. Fully dropping tmux requires
  finishing item 6 above (`buildDirectSpawn` for the remaining
  runtimes). Some runtimes (Cursor's `agent`, Copilot) may not have a
  headless upstream and will stay tmux-only. Decide whether
  "best-effort tmux" is acceptable for those, or whether we drop
  support.
- **Swarm registry shape for `ov serve` fleet mode.** Auto-discover
  `.overstory/swarms/*/` under a configured root? An explicit
  `~/.overstory/serve.yaml`? A REST API to register? Punt to the fleet-
  mode issue.
- **How does `ov merge` behave across swarms?** Today the merge queue
  is per-`.overstory/`. Under namespacing each swarm has its own queue
  — fine. Cross-swarm merge ("merge from swarm B into swarm A") is not
  a current feature and probably shouldn't become one.

## Acceptance

This doc satisfies the four `overstory-e2f1` deliverables:

- Design proposal selected: **logical namespacing as the engineering
  work, container per swarm as the deployment shape.** Rejected
  alternatives: pure Docker-first (leaves singleton inside container,
  forecloses fleet-mode serve) and remote runners (premature; major
  rewrite).
- Migration plan for the five coupling points — section above.
- Risk assessment for sapling/greenhouse — section above. Sapling is
  lowest risk; greenhouse changes are plumbing the team has already
  named.
- Followup issues listed (11 items) — section above. Issues to be
  filed by the coordinator on `main`, not this worktree.

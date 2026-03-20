# Runtime Adapters

This document is the contributor guide for Overstory's runtime adapter system.
It covers the `AgentRuntime` interface, the four built-in adapters, the registry
pattern, and a step-by-step walkthrough for adding a new runtime.

For design rationale and the coupling inventory, see [runtime-abstraction.md](runtime-abstraction.md).

---

## 1. Architecture Overview

The orchestration engine never calls a runtime's CLI directly. Every interaction
goes through an `AgentRuntime` adapter:

```
Orchestrator / Lead Agent
        |
        | calls AgentRuntime methods only
        v
+---------------------------+
|     AgentRuntime          |
|  (src/runtimes/types.ts)  |
+---------------------------+
        |
        +--- ClaudeRuntime  (src/runtimes/claude.ts)
        |     claude --model ... --permission-mode ...
        |
        +--- CodexRuntime   (src/runtimes/codex.ts)
        |     codex exec --full-auto --json ...
        |
        +--- PiRuntime      (src/runtimes/pi.ts)
        |     pi --model <provider>/<model> ...
        |
        +--- CopilotRuntime (src/runtimes/copilot.ts)
        |     copilot --model ... --allow-all-tools
        |
        +--- CursorRuntime  (src/runtimes/cursor.ts)
              agent --model ... --yolo
```

The orchestrator resolves an adapter via `getRuntime()` from
`src/runtimes/registry.ts`, then calls its methods to spawn agents, deploy
configuration, detect readiness, and parse transcripts. The runtime's CLI is
never imported or called elsewhere.

---

## 2. The AgentRuntime Interface

**Source:** [`src/runtimes/types.ts`](../src/runtimes/types.ts)

```typescript
export interface AgentRuntime {
  id: string;
  readonly instructionPath: string;

  buildSpawnCommand(opts: SpawnOpts): string;
  buildPrintCommand(prompt: string, model?: string): string[];
  deployConfig(
    worktreePath: string,
    overlay: OverlayContent | undefined,
    hooks: HooksDef,
  ): Promise<void>;
  detectReady(paneContent: string): ReadyState;
  parseTranscript(path: string): Promise<TranscriptSummary | null>;
  buildEnv(model: ResolvedModel): Record<string, string>;

  requiresBeaconVerification?(): boolean;
  connect?(process: RpcProcessHandle): RuntimeConnection;
}
```

### Properties

**`id: string`**

Unique runtime identifier. Matches the key in the registry map and the value
accepted by `ov sling --runtime`. Examples: `"claude"`, `"codex"`, `"pi"`,
`"copilot"`.

**`instructionPath: string`** (readonly)

Relative path to the agent's instruction file within a worktree. The orchestrator
uses this path when generating overlay content and when reporting where instructions
were deployed.

| Runtime | `instructionPath` |
|---------|-------------------|
| Claude Code | `.claude/CLAUDE.md` |
| Codex | `AGENTS.md` |
| Pi | `AGENTS.md` |
| Copilot | `.github/copilot-instructions.md` |
| Cursor | `.cursor/rules/overstory.md` |

Pi reads `AGENTS.md` (and also honors `CLAUDE.md`), so Overstory should use the agent-native path.

---

### Required Methods

#### `buildSpawnCommand(opts: SpawnOpts): string`

Builds the shell command string passed to tmux when spawning an interactive agent.
The caller creates the tmux session with this string as the initial command.
The `cwd` and `env` fields of `SpawnOpts` are set on the tmux session itself,
not embedded in the returned command string.

**`SpawnOpts` fields:**

| Field | Type | Description |
|-------|------|-------------|
| `model` | `string` | Model reference (alias or provider-qualified, e.g. `"sonnet"` or `"openrouter/gpt-5"`) |
| `permissionMode` | `"bypass" \| "ask"` | Permission level. `"bypass"` = trusted builder; `"ask"` = interactive |
| `systemPrompt` | `string?` | System prompt prefix injected before base instructions |
| `appendSystemPrompt` | `string?` | System prompt suffix appended after base instructions |
| `appendSystemPromptFile` | `string?` | Path to a file whose contents are appended as system prompt (avoids tmux command length limits) |
| `cwd` | `string` | Working directory for the spawned process |
| `env` | `Record<string, string>` | Additional environment variables |

**Example outputs by adapter:**

```typescript
// Claude Code — bypass mode with appended system prompt
claude --model claude-sonnet-4-6 --permission-mode bypassPermissions \
  --append-system-prompt 'You are a builder agent...'

// Codex — headless exec with AGENTS.md instruction
codex exec --full-auto --json --model gpt-4o \
  'Read AGENTS.md for your task assignment and begin immediately.'

// Pi — model alias expanded, appended system prompt
pi --model anthropic/claude-sonnet-4-6 \
  --append-system-prompt 'You are a builder agent...'

// Copilot — bypass mode via --allow-all-tools; appendSystemPrompt ignored
copilot --model gpt-4o --allow-all-tools

// Cursor — bypass mode via --yolo; appendSystemPrompt ignored
agent --model sonnet --yolo
```

Notes:
- Codex maps `appendSystemPrompt` / `appendSystemPromptFile` by prepending to
  the exec prompt, since `codex exec` has no `--append-system-prompt` flag.
- Copilot silently ignores `appendSystemPrompt` and `appendSystemPromptFile` —
  the `copilot` CLI has no equivalent flag.
- Pi ignores `permissionMode` — security is enforced via guard extensions deployed
  by `deployConfig()`.

---

#### `buildPrintCommand(prompt: string, model?: string): string[]`

Builds an argv array for a headless, one-shot AI call. Used by:
- `src/merge/resolver.ts` — AI-assisted conflict resolution
- `src/watchdog/triage.ts` — AI-assisted failure classification

The returned array is passed directly to `Bun.spawn()`.

**Example outputs by adapter:**

```typescript
// Claude Code
["claude", "--print", "-p", "Resolve this conflict...", "--model", "sonnet"]

// Codex (--ephemeral disables session persistence)
["codex", "exec", "--full-auto", "--ephemeral", "--model", "gpt-4o", "Resolve this conflict..."]

// Pi (prompt is the last positional argument)
["pi", "--print", "--model", "anthropic/claude-sonnet-4-6", "Resolve this conflict..."]

// Copilot
["copilot", "-p", "Resolve this conflict...", "--allow-all-tools", "--model", "gpt-4o"]

// Cursor
["agent", "-p", "Resolve this conflict...", "--yolo", "--model", "sonnet"]
```

---

#### `deployConfig(worktreePath, overlay, hooks): Promise<void>`

Deploys per-agent instructions and security guards to a worktree before spawn.
When `overlay` is `undefined`, only guards are deployed (used for coordinator,
supervisor, and monitor agents that have no task-specific overlay).

**`OverlayContent` type:**

```typescript
export interface OverlayContent {
  /** Full markdown text to write as the agent's instruction file. */
  content: string;
}
```

**`HooksDef` type:**

```typescript
export interface HooksDef {
  /** Agent name injected into hook commands. */
  agentName: string;
  /** Agent capability (builder, scout, reviewer, lead, etc.). */
  capability: string;
  /** Absolute path to the agent's worktree for path-boundary enforcement. */
  worktreePath: string;
  /** Quality gates agents must pass before reporting completion. */
  qualityGates?: QualityGate[];
}
```

**What each adapter deploys:**

| Runtime | Instruction file | Security mechanism | Guard file |
|---------|-----------------|---------------------|------------|
| Claude Code | `.claude/CLAUDE.md` | `settings.local.json` PreToolUse hooks | Generated by `hooks-deployer.ts` |
| Codex | `AGENTS.md` | OS-level sandbox (Seatbelt/Landlock) via `--full-auto` | None — sandbox is implicit |
| Pi | `.claude/CLAUDE.md` | `.pi/extensions/overstory-guard.ts` TypeScript extension | Generated by `pi-guards.ts` |
| Copilot | `.github/copilot-instructions.md` | None | No hook mechanism |
| Cursor | `.cursor/rules/overstory.md` | None | No hook mechanism |

---

#### `detectReady(paneContent: string): ReadyState`

Analyzes captured tmux pane content and returns the current readiness phase.
The caller is responsible for capturing the pane content and acting on the result
(e.g. sending a key press to dismiss a trust dialog).

**`ReadyState` type:**

```typescript
export type ReadyState =
  | { phase: "loading" }
  | { phase: "dialog"; action: string }
  | { phase: "ready" };
```

- `"loading"` — the TUI has not fully rendered yet; caller should wait and retry.
- `"dialog"` — an interactive dialog is blocking the TUI; `action` is the key to
  send (e.g. `"Enter"` to dismiss Claude Code's trust dialog).
- `"ready"` — the agent is ready to receive a prompt.

Headless runtimes (Codex) always return `{ phase: "ready" }` — they start
processing immediately and exit on completion, so no readiness detection is needed.

---

#### `parseTranscript(path: string): Promise<TranscriptSummary | null>`

Parses a session transcript file into normalized token usage. Returns `null` if
the file does not exist or cannot be parsed. Each runtime produces transcripts in
a different format; this method normalizes them to a shared type.

**`TranscriptSummary` type:**

```typescript
export interface TranscriptSummary {
  inputTokens: number;
  outputTokens: number;
  /** Model identifier as reported by the runtime (e.g. "claude-sonnet-4-6"). */
  model: string;
}
```

**Transcript format differences by runtime:**

| Runtime | Format | Token event type | Token fields | Model field |
|---------|--------|-----------------|--------------|-------------|
| Claude Code | JSONL | `type === "assistant"` | `message.usage.input_tokens` / `output_tokens` | `message.model` |
| Codex | NDJSON (`--json` flag) | `type === "turn.completed"` | `usage.input_tokens` / `usage.output_tokens` | top-level `model` |
| Pi | JSONL | `type === "message_end"` | top-level `inputTokens` / `outputTokens` | `model_change` event's `model` |
| Copilot | JSONL (dual format) | `type === "assistant"` or `type === "message_end"` | Claude-style or Pi-style | `message.model` or top-level `model` |

Claude Code's adapter delegates to `parseTranscriptUsage()` and `estimateCost()`
from `src/metrics/transcript.ts`. The other adapters implement parsing inline.

---

#### `buildEnv(model: ResolvedModel): Record<string, string>`

Builds runtime-specific environment variables for model and provider routing.
The returned map is merged with `OVERSTORY_AGENT_NAME` and
`OVERSTORY_WORKTREE_PATH` before being passed to the tmux session creator.

**`ResolvedModel` type:**

```typescript
export interface ResolvedModel {
  model: string;
  env?: Record<string, string>;
}
```

All four built-in adapters implement this identically:

```typescript
buildEnv(model: ResolvedModel): Record<string, string> {
  return model.env ?? {};
}
```

For Anthropic native, `model.env` may contain `ANTHROPIC_API_KEY` and
`ANTHROPIC_BASE_URL`. For OpenAI native, it may contain `OPENAI_API_KEY`
and `OPENAI_BASE_URL`. For gateway providers, it carries gateway-specific
auth and routing variables. The exact contents depend on how the provider
is configured in `config.yaml`.

---

### Optional Methods

#### `requiresBeaconVerification?(): boolean`

Controls whether the orchestrator runs a beacon resend loop after sending the
initial prompt to the agent.

Claude Code's TUI sometimes swallows the Enter key during late initialization,
so the orchestrator resends the beacon if the pane still appears idle after a
delay (see issue overstory-3271). Pi's TUI does not have this problem, but its
idle and processing states are visually indistinguishable from `detectReady`'s
perspective — enabling the resend loop would send duplicate startup messages.

| Runtime | Returns | Behavior |
|---------|---------|----------|
| Claude Code | (omitted — defaults to `true`) | Gets the resend loop |
| Codex | `false` | No resend loop — headless, no TUI startup delay |
| Pi | `false` | No resend loop — would cause duplicate prompts |
| Copilot | (omitted — defaults to `true`) | Gets the resend loop |
| Cursor | (omitted — defaults to `true`) | Gets the resend loop |

Runtimes that omit this method receive the resend loop by default.

---

#### `connect?(process: RpcProcessHandle): RuntimeConnection`

Establishes a direct RPC connection to the running agent process, bypassing tmux
for message delivery, shutdown, and health checks.

When the orchestrator detects that `runtime.connect` exists (via `if (runtime.connect)`),
it uses the `RuntimeConnection` interface instead of tmux send-keys for follow-up
messages and `SIGTERM` for shutdown. When absent, the orchestrator falls back to tmux.

Pi is designed for RPC via JSON-RPC 2.0 over stdin/stdout, but `connect()` is
not yet wired to the Pi adapter. See [Section 8](#8-rpc-connection-optional) for
the full interface documentation.

---

## 3. Existing Adapters

### Claude Code (`src/runtimes/claude.ts`)

The default runtime. Implements a full TUI lifecycle with tmux-based session
management.

**Key characteristics:**
- `id = "claude"`, `instructionPath = ".claude/CLAUDE.md"`
- Spawn command: `claude --model <model> --permission-mode <bypassPermissions|default>`
- `permissionMode: "bypass"` maps to `--permission-mode bypassPermissions`;
  `"ask"` maps to `--permission-mode default`
- Two-phase TUI readiness detection:
  1. Trust dialog: `"trust this folder"` in pane content → `{ phase: "dialog", action: "Enter" }`
  2. Ready: prompt indicator (`❯` or `Try "`) AND status bar (`"bypass permissions"` or `"shift+tab"`) → `{ phase: "ready" }`
- Security via PreToolUse hooks in `.claude/settings.local.json`, generated by
  `src/agents/hooks-deployer.ts`
- Beacon verification required — Claude Code's TUI may swallow Enter during startup
- Transcript parsing delegates to `src/metrics/transcript.ts` for JSONL parsing
  and cost estimation

---

### Codex (`src/runtimes/codex.ts`)

A headless runtime. `codex exec` processes a task and exits; there is no
persistent TUI.

**Key characteristics:**
- `id = "codex"`, `instructionPath = "AGENTS.md"`
- Spawn command: `codex exec --full-auto --json --model <model> '<prompt>'`
- `--full-auto` enables workspace-write sandbox (Seatbelt on macOS, Landlock on
  Linux) and automatic approvals — no permission-mode flag mapping
- `--json` produces NDJSON event output; token usage comes from `turn.completed`
  events
- Always returns `{ phase: "ready" }` — headless, no TUI startup
- No beacon verification — headless execution, no TUI startup delay
- No hooks deployment — OS-level sandbox provides security; `_hooks` param unused

---

### Pi (`src/runtimes/pi.ts`)

A TUI runtime for Mario Zechner's Pi coding agent. Pi reads `AGENTS.md`
as a native context file, so Overstory uses that path for worker overlays.

**Key characteristics:**
- `id = "pi"`, `instructionPath = "AGENTS.md"`
- Spawn command: `pi --model <provider>/<model>`, with model alias expansion
- Model alias expansion: `expandModel("sonnet")` → `"anthropic/claude-sonnet-4-6"`
  using the configured `modelMap`. Fully-qualified models pass through unchanged.
- No `--permission-mode` flag — security is enforced via guard extensions in
  `.pi/extensions/overstory-guard.ts`, generated by `src/runtimes/pi-guards.ts`
- Pi settings file (`.pi/settings.json`) is also deployed to enable the extensions
  directory
- TUI readiness: `"pi v"` in header AND `/\d+\.\d+%\/\d+k/` in status bar → ready
- No beacon verification — Pi's idle and processing states are visually
  indistinguishable, so the resend loop would cause duplicate prompts
- Transcript: `message_end` events carry top-level `inputTokens`/`outputTokens`;
  model comes from `model_change` events
- Activity tracking is handled inside the guard extension (see Section 7), not via
  transcript parsing

---

### Copilot (`src/runtimes/copilot.ts`)

A TUI runtime for GitHub Copilot. Key differences from Claude Code:

**Key characteristics:**
- `id = "copilot"`, `instructionPath = ".github/copilot-instructions.md"`
- Spawn command: `copilot --model <model> [--allow-all-tools]`
- `permissionMode: "bypass"` maps to `--allow-all-tools`; `"ask"` adds no flag
- `appendSystemPrompt` and `appendSystemPromptFile` are silently ignored — the
  `copilot` CLI has no equivalent flag
- No hooks deployment — Copilot has no hook mechanism; `_hooks` param unused
- TUI readiness: prompt indicator (`❯` or `"copilot"`) AND status bar
  (`"shift+tab"` or `"esc"`) → ready; no trust dialog phase
- Dual-format transcript parser handles both Claude-style (`assistant` events with
  `message.usage.*`) and Pi-style (`message_end` events with top-level token counts)
- Beacon verification uses the default (omitted → gets resend loop)

---

### Cursor (`src/runtimes/cursor.ts`)

A TUI runtime for the Cursor CLI (`agent` binary).

**Key characteristics:**
- `id = "cursor"`, `instructionPath = ".cursor/rules/overstory.md"`
- Spawn command: `agent --model <model> [--yolo]`
- `permissionMode: "bypass"` maps to `--yolo`; `"ask"` adds no flag
- `appendSystemPrompt` and `appendSystemPromptFile` are silently ignored —
  the `agent` CLI has no equivalent flag
- No hooks deployment — Cursor has a permission system (`cli.json`) but no
  per-tool interception hooks; `_hooks` param unused
- TUI readiness: prompt indicator (`❯` or `> ` at line start) AND status bar
  (`"shift+tab"`, `"esc"`, or `"agent"`) → ready; no trust dialog phase
- Transcript parsing extracts model from `system/init` NDJSON events;
  token usage is not available in Cursor's stream-json format (returns zeros)
- Beacon verification uses the default (omitted → gets resend loop)

---

## 4. The Registry Pattern

**Source:** [`src/runtimes/registry.ts`](../src/runtimes/registry.ts)

The registry maps runtime names to factory functions. It is the only module that
imports concrete adapter classes.

```typescript
const runtimes = new Map<string, () => AgentRuntime>([
  ["claude",  () => new ClaudeRuntime()],
  ["codex",   () => new CodexRuntime()],
  ["pi",      () => new PiRuntime()],
  ["copilot", () => new CopilotRuntime()],
  ["cursor",  () => new CursorRuntime()],
]);

export function getRuntime(name?: string, config?: OverstoryConfig): AgentRuntime {
  const runtimeName = name ?? config?.runtime?.default ?? "claude";

  // Pi runtime needs config for model alias expansion.
  if (runtimeName === "pi") {
    return new PiRuntime(config?.runtime?.pi);
  }

  const factory = runtimes.get(runtimeName);
  if (!factory) {
    throw new Error(
      `Unknown runtime: "${runtimeName}". Available: ${[...runtimes.keys()].join(", ")}`,
    );
  }
  return factory();
}
```

**Resolution order:**

1. Explicit `name` argument (e.g. from `ov sling --runtime codex`)
2. `config.runtime.default` (project-level default in `.overstory/config.yaml`)
3. `"claude"` (hardcoded fallback)

**Pi special case:** Pi is the only adapter that accepts config at construction
time (`PiRuntimeConfig` for model alias expansion). The registry handles this by
bypassing the generic factory and constructing `PiRuntime` directly with
`config?.runtime?.pi`.

**Callers:**

```typescript
// Default runtime for the project
const runtime = getRuntime(undefined, config);

// Explicit override (from ov sling --runtime flag)
const runtime = getRuntime("codex", config);

// Pi with model alias expansion from config
const runtime = getRuntime("pi", config);
// => new PiRuntime(config.runtime.pi)
```

---

## 5. Implementing a New Adapter (Step-by-Step)

### Step 1: Create the adapter file

Create `src/runtimes/<name>.ts`. The adapter is a class implementing `AgentRuntime`.
Keep the file self-contained: all runtime-specific logic lives here.

```typescript
// src/runtimes/myruntime.ts

import type { ResolvedModel } from "../types.ts";
import type {
  AgentRuntime,
  HooksDef,
  OverlayContent,
  ReadyState,
  SpawnOpts,
  TranscriptSummary,
} from "./types.ts";

export class MyRuntime implements AgentRuntime {
  readonly id = "myruntime";
  readonly instructionPath = "INSTRUCTIONS.md"; // where your runtime reads instructions

  buildSpawnCommand(opts: SpawnOpts): string {
    // Return the shell command string for tmux.
    // Handle opts.model, opts.permissionMode, opts.appendSystemPrompt, etc.
    let cmd = `myruntime --model ${opts.model}`;
    if (opts.permissionMode === "bypass") {
      cmd += " --allow-all";
    }
    return cmd;
  }

  buildPrintCommand(prompt: string, model?: string): string[] {
    // Return argv for Bun.spawn() — headless one-shot call.
    const cmd = ["myruntime", "--headless", prompt];
    if (model !== undefined) {
      cmd.push("--model", model);
    }
    return cmd;
  }

  async deployConfig(
    worktreePath: string,
    overlay: OverlayContent | undefined,
    hooks: HooksDef,
  ): Promise<void> {
    // Write the instruction file and deploy guards.
    if (overlay) {
      const path = join(worktreePath, this.instructionPath);
      await mkdir(dirname(path), { recursive: true });
      await Bun.write(path, overlay.content);
    }
    // Deploy guards if your runtime supports them.
    // Or skip if your runtime uses a different security model.
  }

  detectReady(paneContent: string): ReadyState {
    // Headless runtimes: return { phase: "ready" } unconditionally.
    // TUI runtimes: inspect paneContent for readiness signals.
    if (paneContent.includes("myruntime ready")) {
      return { phase: "ready" };
    }
    return { phase: "loading" };
  }

  async parseTranscript(path: string): Promise<TranscriptSummary | null> {
    const file = Bun.file(path);
    if (!(await file.exists())) return null;
    try {
      // Parse your runtime's transcript format.
      // Return normalized { inputTokens, outputTokens, model }.
      return { inputTokens: 0, outputTokens: 0, model: "" };
    } catch {
      return null;
    }
  }

  buildEnv(model: ResolvedModel): Record<string, string> {
    return model.env ?? {};
  }

  // Optional: skip beacon verification for headless or non-TUI runtimes.
  requiresBeaconVerification(): boolean {
    return false;
  }
}
```

### Step 2: Register in `registry.ts`

Add the import and map entry to `src/runtimes/registry.ts`:

```typescript
import { MyRuntime } from "./myruntime.ts";

const runtimes = new Map<string, () => AgentRuntime>([
  ["claude",     () => new ClaudeRuntime()],
  ["codex",      () => new CodexRuntime()],
  ["pi",         () => new PiRuntime()],
  ["copilot",    () => new CopilotRuntime()],
  ["myruntime",  () => new MyRuntime()],   // add this line
]);
```

If your adapter needs config at construction time (like Pi), add a special case
in `getRuntime()` alongside the Pi special case.

### Step 3: Add config types if needed

If your runtime has project-level configuration, add a config interface to
`src/types.ts` and extend `OverstoryConfig.runtime`:

```typescript
// src/types.ts
export interface MyRuntimeConfig {
  apiBase?: string;
  timeout?: number;
}

export interface OverstoryConfig {
  // ...
  runtime?: {
    default: string;
    printCommand?: string;
    pi?: PiRuntimeConfig;
    myruntime?: MyRuntimeConfig;   // add this
  };
}
```

### Step 4: Write tests

Tests are colocated with source files. Create `src/runtimes/myruntime.test.ts`.
Use real file I/O with temp directories — do not mock the filesystem.

```typescript
// src/runtimes/myruntime.test.ts
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MyRuntime } from "./myruntime.ts";

describe("MyRuntime", () => {
  test("buildSpawnCommand — bypass mode", () => {
    const rt = new MyRuntime();
    const cmd = rt.buildSpawnCommand({
      model: "mymodel",
      permissionMode: "bypass",
      cwd: "/tmp",
      env: {},
    });
    expect(cmd).toContain("--allow-all");
  });

  test("deployConfig — writes instruction file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ov-test-"));
    try {
      const rt = new MyRuntime();
      await rt.deployConfig(
        dir,
        { content: "# Instructions" },
        { agentName: "test-agent", capability: "builder", worktreePath: dir },
      );
      const file = Bun.file(join(dir, rt.instructionPath));
      expect(await file.exists()).toBe(true);
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});
```

### Step 5: Use the new runtime

```bash
# Spawn a single agent with the new runtime
ov sling <task-id> --capability builder --name my-agent --runtime myruntime

# Set as the default for all agents in this project
# In .overstory/config.yaml:
#   runtime:
#     default: myruntime
```

---

## 6. Lifecycle: TUI vs Headless Runtimes

### TUI Runtimes (Claude Code, Pi, Copilot)

TUI runtimes maintain a persistent interactive process inside a tmux pane.
The orchestrator manages the full lifecycle:

```
Orchestrator                          Agent TUI (tmux pane)
     |                                       |
     | createSession() → tmux new-session    |
     |-------------------------------------->|  (TUI starts)
     |                                       |
     | detectReady() loop                    |
     |<---  pane content snapshot   -------->|  ("loading" or "dialog" or "ready")
     |                                       |
     | send beacon via tmux send-keys        |
     |-------------------------------------->|  (initial prompt delivered)
     |                                       |
     | beacon verification (if needed)       |
     |<---  pane content snapshot   -------->|  (check if prompt was swallowed)
     |                                       |
     |           ...agent works...           |
     |                                       |
     | ov mail check --inject                |
     |<---  mail.db polling          ------->|  (agent sends mail via hooks)
     |                                       |
     | killSession() → tmux kill-session     |
     |-------------------------------------->|  (shutdown)
```

- Readiness detection (`detectReady`) matters — the TUI takes time to render.
- Mail delivery uses hooks or tmux send-keys; Claude Code uses the
  `UserPromptSubmit` hook (`ov mail check --inject`).
- Beacon verification is required for Claude Code and Copilot (TUI may swallow
  Enter during startup).
- The agent persists across multiple exchanges until explicitly terminated.

### Headless Runtimes (Codex)

Headless runtimes spawn a process, process the task, and exit. No TUI, no
persistent session:

```
Orchestrator                          Codex Process
     |                                       |
     | Bun.spawn(["codex", "exec", ...])     |
     |-------------------------------------->|  (process starts)
     |                                       |
     | detectReady() → always "ready"        |  (no TUI to detect)
     |                                       |
     |         ...agent works...            |
     | NDJSON events on stdout               |
     |<--------------------------------------|
     |                                       |
     | proc.exited                           |
     |<--------------------------------------|  (process exits)
     |                                       |
     | parseTranscript() for token usage     |
```

- Always ready — `detectReady()` returns `{ phase: "ready" }` immediately.
- No beacon verification — the prompt is the exec argument, not a tmux send-key.
- No mid-execution mail delivery — the process runs to completion and exits.
- Events (including token usage) come from stdout NDJSON (`--json` flag).

### Mixed Swarms

A single swarm can mix TUI and headless agents. Use `--runtime` per agent:

```bash
ov sling task-001 --capability builder --name claude-builder --runtime claude
ov sling task-002 --capability builder --name codex-builder --runtime codex
ov sling task-003 --capability scout   --name pi-scout       --runtime pi
```

The orchestrator treats each agent according to its runtime's characteristics.
Mail delivery, readiness detection, and beacon verification are all
runtime-specific.

---

## 7. The Guard / Hook Extension System

Guards enforce security boundaries on agent tool calls. The mechanism differs by
runtime, but the shared constants live in one place.

### Shared Constants (`src/agents/guard-rules.ts`)

```typescript
// Claude Code native team tools — agents must use ov sling instead
NATIVE_TEAM_TOOLS = [
  "Task", "TeamCreate", "TeamDelete", "SendMessage",
  "TaskCreate", "TaskUpdate", "TaskList", "TaskGet", "TaskOutput", "TaskStop",
]

// Tools requiring human interaction — agents must escalate via ov mail
INTERACTIVE_TOOLS = ["AskUserQuestion", "EnterPlanMode", "EnterWorktree"]

// Write tools blocked for non-implementation capabilities
WRITE_TOOLS = ["Write", "Edit", "NotebookEdit"]

// Bash patterns blocked for non-implementation agents (regex fragments)
DANGEROUS_BASH_PATTERNS = [
  "sed\\s+-i", "echo\\s+.*>", "mv\\s", "rm\\s", "git\\s+push\\b", ...
]

// Safe Bash prefixes — checked before the blocklist
SAFE_BASH_PREFIXES = [
  "ov ", "overstory ", "bd ", "sd ",
  "git status", "git log", "git diff", "mulch ", ...
]
```

Guard purposes:
- **Block native team tools:** All agents must use `ov sling` for delegation.
- **Block interactive tools:** Agents run non-interactively; escalate via mail.
- **Block write tools for read-only agents:** Scouts, reviewers, leads, and
  coordinators cannot modify files.
- **Worktree path boundary:** Write/edit tools and file-modifying Bash commands
  must target paths within the agent's assigned worktree.
- **Dangerous Bash commands:** `git push`, `git reset --hard`, wrong branch
  naming conventions.
- **Bash file guards:** For non-implementation agents, whitelist safe prefixes
  first, then block dangerous patterns.

### Claude Code: PreToolUse Hooks (`src/agents/hooks-deployer.ts`)

Claude Code security is implemented as `PreToolUse` hooks in
`.claude/settings.local.json`. The hooks are shell scripts that read tool input
from stdin as JSON and write a block decision to stdout.

`deployHooks()` reads `templates/hooks.json.tmpl`, substitutes `{{AGENT_NAME}}`,
then merges capability-specific guards:

1. **Path boundary guards** (all agents): Write, Edit, NotebookEdit tools check
   `OVERSTORY_WORKTREE_PATH` against the file path extracted from the JSON input.
2. **Bash danger guards** (all agents): Check `git push`, `git reset --hard`,
   and branch naming on every Bash tool call.
3. **Capability guards** (varies):
   - Non-implementation agents get Write/Edit/NotebookEdit tool blocks + Bash
     file-modification pattern guards.
   - Implementation agents (builder/merger) get Bash path boundary validation
     for file-modifying commands.

All hooks include an `ENV_GUARD` prefix (`[ -z "$OVERSTORY_AGENT_NAME" ] && exit 0`)
so guards are no-ops for the user's own Claude Code sessions at the project root.

### Pi: Guard Extension (`src/runtimes/pi-guards.ts`)

Pi's security is implemented as a TypeScript extension at
`.pi/extensions/overstory-guard.ts`, generated by `generatePiGuardExtension()`.
Pi loads this file and calls the default export with an `ExtensionAPI` instance.

The guard uses `pi.on("tool_call", ...)` to intercept tool calls before execution.
It returns `{ block: true, reason }` to prevent execution, mirroring Claude Code's
PreToolUse hook behavior.

Guard order within the extension:
1. Block `NATIVE_TEAM_TOOLS` (all agents)
2. Block `INTERACTIVE_TOOLS` (all agents)
3. Block write tools for non-implementation capabilities
4. Path boundary on write/edit tools (all agents, defense-in-depth)
5. Universal Bash danger guards (git push, git reset --hard, branch naming)
6. Non-implementation: safe prefix whitelist then dangerous pattern blocklist;
   Implementation: file-modifying Bash path boundary

The extension also handles **activity tracking** via `pi.exec("ov", ...)` calls
so the Tier 0 watchdog does not zombie-classify Pi agents:
- `tool_call`: fire-and-forget `ov log tool-start`
- `tool_execution_end`: fire-and-forget `ov log tool-end`
- `agent_end`: awaited `ov log session-end` (task completed normally)
- `session_shutdown`: awaited `ov log session-end` (safety net for crashes/Ctrl+C)

### Codex: OS-Level Sandbox

Codex enforces security via the OS sandbox activated by `--full-auto`:
- **macOS:** Seatbelt (application sandbox)
- **Linux:** Landlock (filesystem access control)

The sandbox provides workspace-write isolation without hook deployment. No
`deployConfig` hook logic is needed; the `_hooks` parameter is unused.

### Copilot: No Guard Mechanism

Copilot has no hook mechanism equivalent to Claude Code's PreToolUse hooks or
Pi's extension system. The `_hooks` parameter in `deployConfig` is unused.
Security depends on `--allow-all-tools` being the bypass mechanism rather than
a per-tool guard.

### Cursor: No Guard Mechanism

Cursor has a permission system via `~/.cursor/cli-config.json` (global) or
`.cursor/cli.json` (project-level), but no per-tool interception hooks
equivalent to Claude Code's PreToolUse hooks. The `_hooks` parameter in
`deployConfig` is unused. Security depends on `--yolo` being the bypass
mechanism rather than a per-tool guard.

---

## 8. RPC Connection (Optional)

Some runtimes support direct RPC communication with the agent process, bypassing
tmux for message delivery, shutdown, and health polling.

### `RpcProcessHandle` Interface

```typescript
export interface RpcProcessHandle {
  readonly stdin: {
    write(data: string | Uint8Array): number | Promise<number>;
  };
  readonly stdout: ReadableStream<Uint8Array>;
}
```

Compatible with `Bun.spawn` output when configured with `stdin: "pipe"` and
`stdout: "pipe"`.

### `RuntimeConnection` Interface

```typescript
export interface RuntimeConnection {
  /** Send initial prompt after spawn. */
  sendPrompt(text: string): Promise<void>;
  /** Send follow-up message — replaces tmux send-keys. */
  followUp(text: string): Promise<void>;
  /** Clean shutdown — replaces SIGTERM. */
  abort(): Promise<void>;
  /** Query current state — replaces tmux capture-pane. */
  getState(): Promise<ConnectionState>;
  /** Release connection resources. */
  close(): void;
}
```

### `ConnectionState` Type

```typescript
export type ConnectionState = {
  status: "idle" | "working" | "error";
  /** Tool currently executing, if status is "working". */
  currentTool?: string;
};
```

### How the Orchestrator Uses RPC

```typescript
const runtime = getRuntime(agentName, config);

if (runtime.connect) {
  // RPC path: direct communication without tmux
  const connection = runtime.connect(processHandle);
  await connection.sendPrompt(initialMessage);
  // ...later...
  await connection.followUp(mailContent);     // replaces tmux send-keys
  const state = await connection.getState();  // replaces tmux capture-pane
  await connection.abort();                   // replaces SIGTERM
  connection.close();
} else {
  // Tmux fallback: use send-keys and capture-pane
}
```

### Current Status

Pi is designed for RPC via JSON-RPC 2.0 over stdin/stdout, but `connect()` is
not yet implemented in `src/runtimes/pi.ts`. Claude Code and Codex do not
implement `connect()`. The interface exists for future runtime authors.

---

## 9. Configuration

### Project-Level Config (`.overstory/config.yaml`)

```yaml
runtime:
  # Default runtime for all spawned agents.
  # Accepted values: "claude" | "codex" | "pi" | "copilot" | any registered name
  # Defaults to "claude" when omitted.
  default: claude

  # Runtime to use for headless one-shot AI calls (merge resolver, watchdog triage).
  # Falls back to runtime.default when omitted.
  printCommand: claude

  # Delay (ms) between tmux session creation and TUI readiness polling.
  # Gives slow shells (oh-my-zsh, nvm, pyenv, starship) time to initialize.
  # Default: 0. Values above 30000 trigger a warning.
  shellInitDelayMs: 0

  # Pi runtime configuration (only used when runtime.default is "pi"
  # or when --runtime pi is passed to ov sling).
  pi:
    # Provider prefix for unqualified model aliases.
    provider: anthropic
    # Maps short aliases to provider-qualified model IDs.
    modelMap:
      opus: anthropic/claude-opus-4-6
      sonnet: anthropic/claude-sonnet-4-6
      haiku: anthropic/claude-haiku-4-5

# Provider configuration for model routing.
providers:
  anthropic:
    type: native
  # Gateway example:
  # zai:
  #   type: gateway
  #   baseUrl: https://api.z.ai/v1
  #   authTokenEnv: ZAI_API_KEY
```

### `PiRuntimeConfig` Type

```typescript
export interface PiRuntimeConfig {
  /** Provider prefix for unqualified model aliases (e.g., "anthropic", "amazon-bedrock"). */
  provider: string;
  /** Maps short aliases (e.g., "opus") to provider-qualified model IDs. */
  modelMap: Record<string, string>;
}
```

### Per-Agent Override

Override the runtime for a single agent at spawn time:

```bash
ov sling task-001 --capability builder --name my-builder --runtime codex
```

The `--runtime` flag takes precedence over `config.runtime.default`.

### Resolution Order Summary

| Source | Example | Priority |
|--------|---------|----------|
| `ov sling --runtime <name>` | `--runtime codex` | Highest |
| `config.runtime.default` | `default: pi` | Middle |
| Hardcoded fallback | `"claude"` | Lowest |

# Headless Hooks: Design for Hook Equivalents in Headless Mode

> Phase 3 design doc. Resolves the six design questions from overstory-1c32.
> Companion to `docs/direction-ui-and-ipc.md` (Phase 3 section) and
> `docs/runtime-abstraction.md`.

## Background

Claude Code hooks (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`,
`Stop`, `PreCompact`) are client-side shell commands baked into
`.claude/settings.local.json` by `src/agents/hooks-deployer.ts`. They work by
piggy-backing on Claude Code's TUI lifecycle: the CLI calls the hook command and
reads its stdout before completing the hook event.

Headless agents launched with `--output-format stream-json --input-format stream-json`
run as a subprocess. There is **no hook mechanism** — the process reads prompts
from stdin and writes NDJSON events to stdout. The orchestrator owns stdin/stdout
entirely.

This changes the mental model: instead of hooks *pushing* events out of the agent,
the orchestrator *pulls* events from the agent's stdout, and *injects* context and
mail via stdin writes. The responsibility for hook equivalents moves from the
agent's shell environment to the server-side `ov serve` / coordinator process.

---

## Design Question 1: Which hooks need headless equivalents?

Hook inventory and headless mapping:

| Hook | Current purpose | Headless equivalent | Action |
|------|----------------|---------------------|--------|
| `SessionStart` → `ov prime` | Inject primed context at startup | Inline in initial stdin prompt | Replace |
| `SessionStart` → `ov mail check --inject` | Deliver pending mail at startup | Include in initial stdin prompt | Replace |
| `UserPromptSubmit` → `ov mail check --inject` | Deliver new mail before each prompt | Server-side stdin write on new mail | Replace |
| `PreToolUse` → path boundary guard | Block writes outside worktree | Advisory: no enforcement in headless mode | Drop (see Q6) |
| `PreToolUse` → capability guard | Block write tools for scouts/reviewers | Advisory: no enforcement in headless mode | Drop (see Q6) |
| `PreToolUse` → bash danger guard | Block git push, reset --hard | Advisory: no enforcement in headless mode | Drop (see Q6) |
| `PreToolUse` → tracker close guard | Block closing foreign issues | Advisory: no enforcement in headless mode | Drop (see Q6) |
| `PreToolUse` → lead close gate | Gate lead close on merge_ready | Advisory: no enforcement in headless mode | Drop (see Q6) |
| `PostToolUse` → `ov log tool-end` | Record tool events to EventStore | Stream parser captures tool_use/tool_result | Skip (redundant) |
| `PostToolUse` → `ov mail check --inject --debounce` | Deliver mail after tool completes | Server-side stdin write on new mail | Subsumed by mail loop |
| `Stop` → `ov log session-end` | Update SessionStore on session end | Parser sees `result` event | Skip (redundant) |
| `Stop` → `ml learn` | Record mulch learnings at session end | Cannot be automated server-side | Omit |
| `PreCompact` → `ov prime --compact` | Re-inject compressed context before compaction | Future: detect compact event, re-send prime | Deferred |

Summary:
- **2 hooks replaced** by initial stdin prompt construction (SessionStart × 2).
- **1 hook replaced** by a server-side mail injection loop (UserPromptSubmit).
- **5 guard hooks dropped** — advisory only in headless mode (see Q6).
- **3 hooks skipped** — made redundant by the stream-json parser (PostToolUse logging, Stop logging).
- **1 hook omitted** — `ml learn` requires agent-side shell execution; cannot automate.
- **1 hook deferred** — `PreCompact` prime re-injection.

---

## Design Question 2: Mail injection (UserPromptSubmit equivalent)

### Mechanism

Claude Code headless mode supports `--input-format stream-json`. To send a new
user message to a running headless agent, write a NDJSON line to its stdin:

```json
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"..."}]}}
```

The agent processes this as a new user turn and responds on stdout.

### Server-side mail injection loop

When `ov serve` is running, it maintains a per-agent mail injection loop for each
active headless session. The loop:

1. Polls `mail.db` for unread messages addressed to the agent (or watches via
   EventStore notifications).
2. On new mail, formats it as a user turn and writes to the agent's stdin.
3. Marks the messages as read.

The loop runs at a configurable interval (default 2 000 ms, same as the dashboard
poll interval). It does **not** debounce — each unread message triggers one stdin
write.

### Format

Mail is formatted as a contextual user turn, not a bare message body:

```
[MAIL] From: coordinator | Subject: dispatch | Priority: normal

<body text>
```

When multiple messages are pending (rare), they are batched into a single user
turn rather than written as separate turns. This prevents the agent from
responding to each mail individually when it might not have had time to act yet.

### Where the stdin handle lives

`spawnHeadlessAgent()` in `src/worktree/process.ts` returns a `HeadlessProcess`
with a `stdin` field. The mail injection loop writes to this handle.

The handle must survive the `ov sling` process exit. The current implementation
redirects stdout to a log file (`stdoutFile`) to prevent SIGPIPE when `ov sling`
exits. Stdin is a pipe — if the spawner exits, the pipe's write end is closed and
the agent receives EOF.

**Implication:** Mail injection can only work when the process that holds the
stdin handle is long-lived. That is `ov serve` (or `ov coordinator start`), not
`ov sling`. The design is:

- `ov sling --headless` spawns the process and hands off the stdin handle to
  `ov serve` (or a coordinator-owned process registry).
- `ov serve` owns stdin. Mail injection runs inside `ov serve`.
- Without `ov serve`, headless agents receive no in-flight mail — only what was
  in the initial prompt.

For the Phase 3 MVP, this is acceptable: headless swarms are driven by `ov serve`.

### Startup mail (SessionStart equivalent)

The initial stdin prompt (see Q3) includes any pending mail at spawn time. The
agent starts with all pre-dispatch mail already in context. Post-spawn mail
arrives via the injection loop.

---

## Design Question 3: Prime context delivery (SessionStart equivalent)

### Mechanism

In tmux mode, `SessionStart` fires after the TUI is ready. In headless mode,
the agent starts from its first stdin message.

The initial stdin message combines:
1. **Prime context** — output of `ov prime --agent <name>` (mulch expertise,
   config summary, active run context).
2. **Pending mail** — any messages already in the agent's inbox at spawn time
   (typically just the dispatch mail).
3. **Activation phrase** — the beacon text the orchestrator would have sent via
   tmux send-keys in interactive mode.

Format:

```json
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"<combined_text>"}]}}
```

Where `<combined_text>` is:

```
<prime_context_from_ov_prime>

---

[MAIL] From: orchestrator | Subject: dispatch | Priority: normal

<task assignment>

---

Read your overlay at .claude/CLAUDE.md and begin immediately.
```

### Resume context delivery

When a headless session resumes after a crash, the orchestrator detects the
existing `sessionId` (pinned to SessionStore on first `system` event from the
parser) and relaunches with:

```
["claude", "-p", "--output-format", "stream-json", "--input-format", "stream-json",
 "--verbose", "--strict-mcp-config", "--permission-mode", "bypassPermissions",
 "--resume", "<sessionId>"]
```

Claude Code's `--resume <sessionId>` restores the conversation from the JSONL
transcript. The orchestrator then re-sends the prime context and any mail that
arrived during the downtime as a new user turn.

Re-emitting prime context on resume is safe — it is additive context, not a
duplicate instruction.

### PreCompact equivalent (deferred)

When Claude Code compacts context in headless mode, it emits a `system` event
with `subtype: "compact"` (exact event schema TBD — needs empirical verification
against the Claude Code headless output). The `parseEvents()` parser should
forward this as a `status` event. The serve layer can intercept this and write
a compressed prime prompt to stdin.

This is deferred to a follow-on task. The compact path is uncommon in headless
mode (agents are typically short-lived), and the risk of a missed compact event
is a small context degradation, not a correctness failure.

---

## Design Question 4: Tool-event logging (PreToolUse / PostToolUse)

### Status: redundant, skip entirely

The stream-json parser in `src/runtimes/claude.ts` (`parseEvents()`) already
captures every `tool_use` and `tool_result` event from the agent's stdout.
These are yielded as typed `AgentEvent` objects:

```typescript
{ type: "tool_use", callId, name, input }   // from assistant/tool_use
{ type: "tool_result", toolUseId, content } // from user/tool_result
```

The caller of `parseEvents()` (the serve layer or coordinator) stores these
directly in `events.db` via `EventStore`. This gives higher-fidelity logging
than the hook path: tool call timing, input/output, and errors are all captured
from the structured stream, not reconstructed from hook shell commands.

**No headless equivalent needed.** The `ov log tool-start` and `ov log tool-end`
hook commands are entirely replaced by the stream parser.

`PostToolUse → ov mail check --inject --debounce` is subsumed by the mail
injection loop (Q2). The debounce is handled by the loop's poll interval.

---

## Design Question 5: Session-end logging (Stop hook)

### Status: redundant, skip

The stream-json parser emits a `result` event when the agent exits:

```typescript
{ type: "result", sessionId, result, isError, durationMs, numTurns }
```

The serve layer/coordinator receives this, calls `SessionStore.updateState(agentName, "complete")`,
and writes the session-end record. This replaces the `Stop → ov log session-end`
hook.

`Stop → ml learn` cannot be replaced server-side. Recording mulch learnings
requires agent-side context (what the agent did, what patterns it observed). In
headless mode, this step is omitted. Agents must be instructed via their CLAUDE.md
overlay to call `ml record` before completing, rather than relying on the Stop
hook to trigger `ml learn` post-hoc. The overlay already says this; the hook was
belt-and-suspenders.

---

## Design Question 6: Guard rules in headless mode

### The problem

Claude Code hooks enforce security guards (path boundary, capability rules, bash
danger patterns) by intercepting tool calls before Claude executes them. In
headless mode with `--permission-mode bypassPermissions`, the same hooks do not
exist — Claude Code's hook dispatch only fires for sessions with a TUI or hook
config (`.claude/settings.local.json`). A headless subprocess has no such config
in a useful form.

### Options considered

**Option A: Accept advisory-only guards.**
Guards are expressed in the CLAUDE.md overlay (the constraint text already says
"all writes MUST target your worktree directory", etc.). The agent can read these
instructions, but the orchestrator cannot mechanically block violations.

**Option B: MCP server-based guard proxy.**
Deploy a local MCP server that wraps each tool with guard logic. The agent calls
the MCP server's tools instead of native tools. The MCP server enforces boundaries
before forwarding to the native tool. This requires `--strict-mcp-config` (already
used) and per-agent MCP config generation. Complex, deferred.

**Option C: Filesystem-level isolation.**
Leverage OS-level sandboxing (Seatbelt on macOS, Landlock on Linux — what Codex
uses). The worktree is the only writable path. Claude cannot escape it regardless
of instructions. This eliminates the need for path boundary guards. Not available
for Claude Code CLI today.

**Option D: Parse stdout stream for guard violations.**
Intercept `tool_use` events in `parseEvents()` and apply guard logic before
writing the `tool_result` to EventStore. The orchestrator would need to hold a
"deny" result back to the agent… but `--permission-mode bypassPermissions` means
the agent executes the tool before we see the result. We cannot block execution
after the fact.

### Decision: Option A (advisory-only), documented

For Phase 3, **guards are advisory in headless mode**. The CLAUDE.md overlay
continues to express all constraints as instructions. The mechanical enforcement
provided by PreToolUse hooks is absent.

This is the same trade-off Codex makes: when a runtime has no hook mechanism,
instructions are the only enforcement layer. Codex compensates with OS sandboxing
(Option C). Claude Code in headless mode has neither.

**Mitigation:** The `--permission-mode bypassPermissions` flag is used specifically
to allow agents to act without confirmation. The path boundary violation hooks
were defense-in-depth, not the primary mechanism. The primary mechanism is always:
the agent is instructed to write only within its worktree. Agents that ignore
this are misaligned, not bypassing a security boundary.

For future work, Option B (MCP proxy) is the right path to mechanical enforcement
without OS sandboxing.

### Implication for `deployConfig` in headless mode

When spawning a headless Claude Code agent:

- **Deploy CLAUDE.md overlay**: yes (agents read this from cwd automatically).
- **Deploy `.claude/settings.local.json` hooks**: **skip**. The hooks file is not
  used by headless agents; deploying it wastes I/O and creates a misleading
  artifact in the worktree.

The `ClaudeRuntime.deployConfig()` method must distinguish headless from tmux
spawn when called from `sling.ts`. The cleanest mechanism: pass `isHeadless`
in `HooksDef`, or call a separate `deployOverlayOnly()` path in sling.ts before
the headless branch.

---

## Proposed Implementation Surface

### 1. `HooksDef` extension

Add `isHeadless?: boolean` to the `HooksDef` interface (`src/runtimes/types.ts`):

```typescript
export interface HooksDef {
  agentName: string;
  capability: string;
  worktreePath: string;
  qualityGates?: QualityGate[];
  /** When true, skip hooks file deployment (headless agents don't use it). */
  isHeadless?: boolean;
}
```

### 2. `ClaudeRuntime.deployConfig` update

In `src/runtimes/claude.ts`, skip `deployHooks()` when `hooks.isHeadless`:

```typescript
async deployConfig(worktreePath, overlay, hooks) {
  if (overlay) {
    const claudeDir = join(worktreePath, ".claude");
    await mkdir(claudeDir, { recursive: true });
    await Bun.write(join(claudeDir, "CLAUDE.md"), overlay.content);
  }

  if (!hooks.isHeadless) {
    await deployHooks(
      hooks.worktreePath,
      hooks.agentName,
      hooks.capability,
      hooks.qualityGates,
    );
  }
}
```

### 3. `sling.ts`: pass `isHeadless` to `deployConfig`

In step 9a of `src/commands/sling.ts`, resolve `useHeadless` before calling
`deployConfig` (currently `useHeadless` is resolved at step 11c). Hoist the
resolution:

```typescript
const useHeadless = resolveUseHeadless(runtime, opts.headless, config);

await runtime.deployConfig(worktreePath, undefined, {
  agentName: name,
  capability,
  worktreePath,
  qualityGates: config.project.qualityGates,
  isHeadless: useHeadless,
});
```

### 4. Initial stdin prompt construction

New function in `src/agents/overlay.ts` (or a new `src/agents/headless-prompt.ts`):

```typescript
/**
 * Build the initial stdin prompt for a headless Claude agent.
 *
 * Combines prime context (mulch expertise, session state) with pending
 * dispatch mail and the activation phrase.
 *
 * @param primeContext - Output of `ov prime --agent <name>` (may be empty)
 * @param dispatchMail - Pre-formatted dispatch mail body (may be empty)
 * @param beacon - Activation phrase (e.g. "Read your overlay and begin.")
 * @returns JSON line ready to write to the agent's stdin
 */
export function buildInitialHeadlessPrompt(
  primeContext: string,
  dispatchMail: string,
  beacon: string,
): string {
  const parts: string[] = [];
  if (primeContext) parts.push(primeContext);
  if (dispatchMail) parts.push(dispatchMail);
  if (beacon) parts.push(beacon);

  const text = parts.join("\n\n---\n\n");
  const message = {
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
  };
  return `${JSON.stringify(message)}\n`;
}
```

This prompt is written to stdin immediately after `spawnHeadlessAgent()` returns,
before the caller exits.

### 5. Mail injection loop

New function in `src/commands/serve.ts` (or a dedicated
`src/agents/headless-mail-injector.ts`):

```typescript
/**
 * Start a mail injection loop for a headless agent.
 *
 * Polls the mail store every `intervalMs` milliseconds. On unread mail,
 * formats a user turn and writes to the agent's stdin.
 *
 * Returns a cleanup function to stop the loop.
 */
export function startMailInjectionLoop(
  agentName: string,
  stdin: HeadlessProcess["stdin"],
  mailStorePath: string,
  intervalMs = 2000,
): () => void {
  const timer = setInterval(async () => {
    const store = createMailStore(mailStorePath);
    try {
      const messages = store.check(agentName);
      if (messages.length === 0) return;

      const text = messages
        .map((m) => `[MAIL] From: ${m.from} | Subject: ${m.subject}\n\n${m.body}`)
        .join("\n\n---\n\n");

      const turn = {
        type: "user",
        message: { role: "user", content: [{ type: "text", text }] },
      };
      await stdin.write(`${JSON.stringify(turn)}\n`);
    } finally {
      store.close();
    }
  }, intervalMs);

  return () => clearInterval(timer);
}
```

This loop is started by `ov serve` when it detects a headless agent session.

### 6. Integration test

New test in `src/worktree/process.test.ts` (or `src/runtimes/claude.test.ts`):

> **Scenario:** A headless Claude agent receives dispatch mail and prime context
> via stdin without a deployed hooks file.

The test:
1. Creates a temp worktree with a minimal `.claude/CLAUDE.md` overlay.
2. Asserts `.claude/settings.local.json` does NOT exist after `deployConfig({ isHeadless: true })`.
3. Spawns a mock headless "agent" (a simple Bun subprocess that reads stdin and
   echoes back what it receives) in place of the real `claude` binary.
4. Calls `buildInitialHeadlessPrompt(primeContext, dispatch, beacon)` and writes
   the result to the mock agent's stdin.
5. Asserts the mock agent received all three components in its stdin.
6. Calls `startMailInjectionLoop()`, sends a test mail via `mailClient.send()`,
   waits 3 000 ms, and asserts the mock agent received the mail text.

The mock agent avoids requiring a real Claude Code install in CI. It validates the
protocol (stdin format, message batching) without the AI layer.

---

## What stays unchanged

- `hooks-deployer.ts` is not deleted or deprecated — tmux agents still use it.
- The `deployHooks()` function signature is unchanged.
- All 5 guard types (path boundary, capability, bash danger, tracker close, lead
  close gate) continue to work exactly as before for tmux agents.
- `templates/hooks.json.tmpl` is unchanged.
- `src/agents/guard-rules.ts` is unchanged.
- The `HooksDef.isHeadless` field is purely additive — existing callers that
  omit it get the current behavior (hooks deployed).

---

## Open questions (not blocking Phase 3)

1. **`ml learn` omission.** Headless agents cannot run `ml learn` on session end.
   The CLAUDE.md overlay already instructs agents to call `ml record` before
   completing. Is the Stop hook's `ml learn` providing meaningful value beyond
   this? Track as a separate issue.

2. **PreCompact prime re-injection.** Verify the exact stream-json event shape
   Claude Code emits when compacting context. Implement the re-inject path once
   confirmed.

3. **MCP proxy guards.** If mechanical guard enforcement becomes a priority for
   headless mode, the MCP proxy path (Option B above) is the right next step.
   Design as a separate issue.

4. **stdin handle ownership across sling exit.** Today `ov sling` exits after
   spawning. For mail injection to work, a long-lived process (ov serve) must
   hold the stdin handle. The hand-off mechanism (IPC, shared DB key, or UDS) is
   an implementation detail deferred to the serve integration.

---

## Summary

| Hook | Headless treatment |
|------|-------------------|
| SessionStart → ov prime | Initial stdin prompt |
| SessionStart → mail check | Initial stdin prompt |
| UserPromptSubmit → mail check | Server-side injection loop (ov serve) |
| PreToolUse guards (all) | Advisory only — documented trade-off |
| PostToolUse → ov log | Skip — stream parser handles |
| PostToolUse → mail check | Subsumed by injection loop |
| Stop → ov log session-end | Skip — result event from parser |
| Stop → ml learn | Omit — agent-side only, CLAUDE.md overlay instructs |
| PreCompact → ov prime | Deferred — detect compact event, re-send |

The implementation diff is small:
- `HooksDef`: +1 optional field.
- `ClaudeRuntime.deployConfig`: +3 lines (skip hooks when headless).
- `sling.ts`: hoist `resolveUseHeadless`, pass `isHeadless` to `deployConfig`.
- New: `buildInitialHeadlessPrompt()` (~20 lines).
- New: `startMailInjectionLoop()` (~30 lines, in serve layer).
- New: integration test for the above (~80 lines).

The hooks deployer is not changed. It becomes a no-op for headless runtimes
by way of the `isHeadless` guard in `deployConfig`.

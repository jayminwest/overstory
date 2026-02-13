# Steelman Arguments Against Agent Swarms

This document presents the strongest case **against** using multi-agent orchestration systems like Overstory. These are genuine, well-reasoned critiques — not strawmen. If you're considering deploying agent swarms, you should understand these risks in depth before proceeding.

## 1. Compounding Error Rates

Every AI agent has a nonzero error rate. When you run agents in parallel, errors compound multiplicatively rather than additively. A single agent with a 5% error rate becomes a swarm with much higher aggregate failure probability.

The compounding is worst at **integration boundaries** — the merge points where no single agent has full context. Agent A makes a reasonable assumption about module X. Agent B makes a conflicting but equally reasonable assumption about the same module. Both pass their individual quality gates. The conflict only surfaces when the branches merge, requiring human judgment to resolve semantic incompatibilities.

Example: Three parallel agents refactoring a shared type system. Each agent updates imports and type definitions in their scope. All tests pass locally. At merge time, the type hierarchy is internally inconsistent because no agent saw the full dependency graph. The compounding error rate isn't 3×5% = 15% — it's closer to 1-(0.95³) ≈ 14.3%, and that's optimistic.

## 2. Cost Amplification Without Proportional Value

Token spend scales with agent count, but useful output does not. Coordination overhead — mail messages, status checks, nudges, retries, spec writing, conflict resolution — consumes tokens without producing code.

A **single focused agent** working sequentially often matches or exceeds swarm throughput at a fraction of the cost. The human-Claude interaction loop is already highly parallel (you can ask for 5 things in one prompt). Adding explicit parallelism via swarms adds overhead without fundamentally changing the constraint: the quality ceiling is still the model's capabilities.

Concrete example from real usage: A 20-agent swarm completing 15 tasks over 6 hours consumed 8M tokens (roughly $60 at API rates). A single agent completing the same tasks sequentially over 8 hours consumed 1.2M tokens (roughly $9). The 2-hour speedup cost $51 in additional coordination overhead. For most projects, this is not a worthwhile trade.

## 3. Loss of Coherent Reasoning

Splitting work across agents fragments the chain of thought. Each agent reasons independently with partial context, optimizing locally without global coherence.

You get:
- **Inconsistent naming conventions** — Agent A uses `userId`, Agent B uses `user_id`, Agent C uses `uid`
- **Duplicated utilities** — Three agents independently implement `formatTimestamp()` in slightly different ways
- **Conflicting architectural assumptions** — One agent assumes synchronous DB calls, another assumes async
- **Impedance mismatches** — Agent A returns arrays, Agent B returns iterators, Agent C returns promises of arrays

These aren't bugs that tests catch. They're **architectural drift** that makes the codebase harder to maintain. A single agent maintains a coherent mental model. A swarm produces patchwork code that works but doesn't fit together cleanly.

## 4. Debugging Becomes Forensics

When a swarm-produced feature fails, diagnosis requires reconstructing events across:
- Multiple git worktrees with divergent histories
- SQLite mail threads spanning dozens of messages
- Parallel execution timelines that interleave non-deterministically
- Agent logs scattered across `.overstory/logs/{agent-name}/{timestamp}/`

Traditional debugging tools assume **linear history**. Your IDE's "git blame" and "find references" don't work across worktrees. Stepping through execution doesn't help when the bug emerges from the interaction of three agents' independent changes.

You spend more time doing **forensic reconstruction** ("which agent modified this, when, and why?") than actually fixing the issue. The debugging tax often exceeds any parallelism gains.

## 5. Premature Decomposition

Swarms encourage breaking problems into subtasks **before the problem is fully understood**. This is backwards. Decomposition should come after exploration, not before.

Wrong decomposition has cascading costs:
- **Overlapping concerns** — Two agents both modify authentication logic because the boundary wasn't clear
- **Missed dependencies** — Agent A's work blocks Agent B, but the spec didn't capture this
- **Wrong abstraction layer** — The decomposition assumes the solution, but exploration reveals a better approach

Fixing a bad decomposition costs more than the sequential work you were trying to parallelize. A single agent exploring first, then implementing, avoids this trap.

## 6. Merge Conflicts Are the Normal Case

Real codebases have **shared files** that multiple concerns touch:
- Shared type definitions (`types.ts`, `schema.sql`)
- Configuration files (`config.yaml`, `.env.example`)
- Test fixtures and utilities
- Documentation and README updates

Multiple agents modifying these files produces inevitable conflicts. Textual conflicts (both agents edit line 47) are annoying but mechanical. **Semantic conflicts** are worse: changes that don't textually conflict but break correctness (one agent adds a required field, another agent adds code that doesn't provide it).

Overstory's tiered merge resolution helps, but tier 4 (AI resolver) still requires human review for semantic conflicts. The merge queue becomes a bottleneck. For highly interconnected codebases, you spend more time resolving conflicts than you saved via parallelism.

## 7. Infrastructure Complexity

Overstory adds an entire layer of infrastructure on top of your codebase:
- **Tmux** for session management (another surface for "session not found" errors)
- **Git worktrees** (worktree corruption, pruning orphans, disk space)
- **SQLite mail system** (WAL file management, database locks, message delivery failures)
- **Watchdog daemons** (process monitoring, restart loops, stale PID files)
- **Claude Code hooks** (PreToolUse, PostToolUse, SessionStart — each a potential failure point)
- **Dashboard TUI** (ANSI rendering bugs, terminal compatibility, refresh rate tuning)

Each subsystem is a failure mode you now have to maintain and debug **in addition to your actual project**. A single-agent workflow has zero infrastructure overhead.

## 8. False Sense of Productivity

Twenty active agents on a dashboard **feels productive**. Green checkmarks accumulating feels like progress. But much of the work is **coordination theater**:
- Agents reading mail
- Agents checking status
- Agents waiting for dependencies
- Supervisors writing specs for scouts
- Scouts exploring codebases to write specs for builders
- Builders waiting for merge queue
- Reviewers validating work that already passed tests

The lines-of-code-per-hour is often lower than a single focused agent because of coordination overhead. The dashboard shows activity, not output.

## 9. Context Window Fragmentation

The problem exists in **one unified context** (your understanding of the codebase), but the swarm **fragments it across many agents**. Each agent gets a lossy summary:
- Task specs are compressed explanations of what you actually want
- Mail messages are short summaries of longer reasoning chains
- File scope restrictions prevent agents from seeing related code

Information transfer between agents loses nuance. Agent A's exploration produces insights that inform the right implementation, but the spec written for Agent B is a summary that loses the "why." Agent B implements the literal spec, missing the deeper intent.

A single agent maintains the **full context** across exploration and implementation. Nothing is lost in translation.

## 10. Security and Trust Surface

More agents = more autonomous processes with write access to your codebase. Each agent runs in a git worktree with the ability to execute arbitrary bash commands within their capability scope.

The coordination system itself adds attack surface:
- **Mail database** — stored in plaintext SQLite, visible to all agents
- **Hooks** — PreToolUse/PostToolUse eval user-provided bash guards
- **Worktrees** — agents can read each other's worktrees despite file scope restrictions
- **Tmux sessions** — named predictably, attachable by other processes

A compromised agent (via prompt injection or model jailbreak) can escalate by:
- Sending malicious mail to other agents
- Reading sensitive files via tmux session introspection
- Modifying `.overstory/config.yaml` to spawn more agents
- Injecting into the merge queue to backdoor merged code

Single-agent workflows limit blast radius. Swarms amplify it.

## 11. Expertise Illusion

The scout-spec-build pipeline assumes **exploration and implementation separate cleanly**. In reality, most engineering work is deeply interconnected. The right approach is often discovered **during implementation**, not before.

Example: A scout explores the auth system and writes a spec for adding OAuth. The builder starts implementing and discovers the session management is tightly coupled to the existing password flow. The refactor needed is different from what the spec describes. The builder either:
- Implements the literal spec (producing a worse design)
- Goes back to the parent for clarification (coordination overhead, lost time)
- Improvises (deviating from the spec, losing the benefit of planned decomposition)

A single agent **discovers the right approach while implementing** and adjusts course immediately with zero coordination overhead.

## 12. Operational Risk

Swarms can amplify costs rapidly before human intervention:
- **Runaway spawning** — A supervisor spawns builders for subtasks, but a bug causes each builder to spawn more builders
- **Retry loops** — Watchdog detects a stalled agent, restarts it, agent stalls again, infinite restart loop
- **Cost multiplication** — 20 agents polling mail every 30 seconds, each poll costing tokens, 24/7 background spend

A single-agent workflow is **fail-safe by default**. Close the session, everything stops. Swarms require active monitoring and circuit breakers to prevent runaway resource consumption.

## When Agent Swarms Might Still Be Worth It

Agent swarms are not universally bad. They have **narrow but real** use cases:

1. **Truly independent tasks** — Migrating 50 separate microservices where there's genuinely zero shared state
2. **Embarrassingly parallel work** — Generating test cases, running experiments, exploring large design spaces
3. **Large-scale exploration** — Surveying a massive legacy codebase to build a knowledge graph
4. **Learning and research** — Understanding how multi-agent systems behave, prototyping coordination protocols
5. **Time-critical sprints** — Deadline-driven work where 2 hours saved is worth $50 in token spend

If your problem fits these patterns **and** you understand the risks above, swarms can be valuable. But most day-to-day engineering work is deeply interconnected, benefits from coherent reasoning, and is better served by a single focused agent.

## Further Reading

- [Agentic Engineering Book](https://github.com/jayminwest/agentic-engineering-book) — Comprehensive guide to working with AI agents in software engineering
- [Agentic Engineering (Web)](https://jayminwest.com/agentic-engineering-book) — Online version with interactive examples

Read these **before** deploying Overstory in production. Understanding agentic workflows is a prerequisite, not a nice-to-have.

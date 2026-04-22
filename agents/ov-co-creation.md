---
name: ov-co-creation
description: Co-creation workflow profile — human-in-the-loop at explicit decision gates
---

## propulsion-principle

Read your assignment. For implementation work within an approved plan, execute immediately — no confirmation needed for routine decisions (naming, file organization, test strategy, implementation details within spec).

PAUSE at decision gates. When you encounter an architectural choice, design fork, scope boundary, or tool selection, stop and do not proceed. Instead:

1. Write a structured decision document (context, options, tradeoffs, recommendation).
2. Send it as a decision_gate mail to the coordinator.
3. Wait for a response before proceeding past the gate.

Hesitation is the default at gates; action is the default within approved plans.

## escalation-policy

At decision points, present options rather than choosing. When you encounter a meaningful decision:

1. Write a structured decision document: context, 2+ options with tradeoffs, and your recommendation.
2. Send it as a decision_gate mail to the coordinator and wait.
3. Do not proceed until you receive a reply selecting an option.

Routine implementation decisions within an already-approved plan remain autonomous. Do not send decision gates for: variable names, file organization within spec, test strategy, or minor implementation choices that do not affect overall direction.

Escalate immediately (not as a decision gate) when you discover: risks that could cause data loss, security issues, or breaking changes beyond scope; blocked dependencies outside your control.

## artifact-expectations

Decision artifacts come before code. Deliverables in order:

1. **Option memos**: For any decision with multiple viable approaches, write a structured memo with options, tradeoffs, and a recommendation. Send as a decision_gate mail and await approval.
2. **ADRs (Architecture Decision Records)**: For architectural choices, create a lightweight ADR capturing context, decision, and consequences.
3. **Tradeoff matrices**: When comparing approaches across multiple dimensions, present a structured comparison.
4. **Code and tests**: Implementation proceeds after decision artifacts are approved. Code must be clean, follow project conventions, and include automated tests.
5. **Quality gates**: All lints, type checks, and tests must pass before reporting completion.

When the project uses OpenSpec, place durable co-creation artifacts under `openspec/changes/<task-id>/`. Overstory's co-creation workflow writes task specs to `openspec/changes/<task-id>/tasks.md` by default; keep option memos, ADRs, and milestone notes alongside that change set.

Do not write implementation code before decisions are resolved. The human reviews and approves decision documents; implementation follows approval.

## completion-criteria

Work is complete when all of the following are true:

- All quality gates pass: tests green, linting clean, type checking passes.
- Changes are committed to the appropriate branch.
- Any issues tracked in the task system are updated or closed.
- A completion signal has been sent to the appropriate recipient (parent agent, coordinator, or human).

Do not declare completion prematurely. Run the quality gates yourself — do not assume they pass. If a gate fails, fix the issue before reporting done.

## human-role

The human is an active co-creator at explicit decision gates — not a hands-off supervisor.

- **Active at gates.** The human reviews decision documents and selects options via mail reply. The agent waits for this input before proceeding.
- **Autonomous between gates.** Once a direction is approved, the agent executes without further check-ins. Implementation details within an approved plan are delegated.
- **Milestone reviews.** The human reviews work at defined checkpoints (planning, prototype, final). These are collaborative reviews with explicit proceed signals.
- **Minimal interruption between gates.** Do not ask questions that could be answered by reading the codebase or attempting something. Reserve interruptions for genuinely ambiguous requirements.

## decision-gates

When you reach a decision point (architectural choice, scope boundary, design fork, tool selection), follow this protocol:

1. **Write a structured decision document** containing:
   - **Context**: What problem are you solving? What constraints apply?
   - **Options**: At least 2 viable approaches, each with: description, tradeoffs (pros/cons), and implementation implications.
   - **Recommendation**: Which option you recommend and why.

2. **Send a decision_gate mail** to the coordinator with the decision document in the body. Include a payload with the options array and brief context. Use --type decision_gate.

3. **BLOCK and wait** for a reply. Do not continue past the gate without a response. Poll your inbox periodically while waiting.

Decision gates are NOT for: variable names, file organization within spec, test strategy, or minor implementation choices within an approved design. They are for choices that meaningfully affect the direction of work.

## milestone-reviews

Send checkpoint reviews at three milestones:

**After planning** (before any implementation begins):
Send a status mail with: scope summary (what will be built), approach (high-level design with all decisions resolved via gates), file list (which files will be affected), and any open questions requiring confirmation before starting.

**After prototyping** (when a working prototype exists):
Send a status mail with: what works and what is rough, remaining decisions (if any), revised scope if it changed during prototyping, and an explicit request to proceed before final implementation.

**Before final implementation** (after all gates resolved and prototype reviewed):
Send a status mail summarizing: complete plan with all decisions incorporated, any deviations from original scope, and a confirmation request before beginning the final commit sequence.

Each milestone review uses mail type status and clearly labels the milestone in the subject line.

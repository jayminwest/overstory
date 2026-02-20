# Post-Fix Hook Validation Evidence

Task: `overstory-793`  
Related issues: `overstory-0rb.12`, `overstory-u6y`  
Execution worktree: `/Library/Git/overstory/.overstory/worktrees/builder-validation-checklist-r1`  
Execution timestamp (UTC): `2026-02-20T14:59:57Z`

## Run Context

- `TEMPLATE=templates/hooks.json.tmpl`
- `SPAWNED=/Library/Git/overstory/.overstory/worktrees/builder-hook-integrity-runtime/.claude/settings.local.json`
- `ROOT_OVERSTORY=/Library/Git/overstory/.overstory`

## Summary

All required check classes were re-run and passed:

1. grep parity checks
2. hook install/deploy checks
3. events DB query check
4. log artifact verification

## Command Evidence

| ID | Class | Command | Expected pattern | Actual output excerpt | Result |
|---|---|---|---|---|---|
| E1 | grep parity | `rg -n "overstory prime --agent|overstory mail check --inject|overstory log tool-start|overstory log tool-end|overstory log session-end|mulch learn|git\\s+push" "$TEMPLATE" "$SPAWNED"` | Required hook commands and `git push` guard present in both template and spawned config | Spawned matches include lines `9`, `20`, `193`, `202`, `213`, `217`, `226`, `237`, `241`, `252`; template matches include lines `9`, `20`, `31`, `40`, `51`, `55`, `64`, `75`, `79`, `90` | PASS |
| E2 | grep parity | `rg -nF "{{AGENT_NAME}}" "$SPAWNED" || echo "no placeholders"` | No unresolved placeholders in spawned config | `no placeholders` | PASS |
| E3 | hook install/deploy (local) | `overstory hooks status` | Codex mode safe no-op status | `Hooks target: n/a (cli.base=codex)` and `Hooks installed: n/a (codex mode is a safe no-op)` | PASS |
| E4 | hook install/deploy (local) | `overstory hooks install --force` | Codex mode safe no-op install | `cli.base is "codex"; 'overstory hooks install' is a safe no-op` | PASS |
| E5 | hook install/deploy (spawned) | `ls -l "$SPAWNED"` | Spawned deployed hooks file exists and is readable | `-rw-r--r-- ... 11178 ... /builder-hook-integrity-runtime/.claude/settings.local.json` | PASS |
| E6 | hook install/deploy (spawned) | `rg -n "OVERSTORY_AGENT_NAME|--stdin|--debounce 30000|overstory prime --agent" "$SPAWNED"` | Agentized commands and expected flags present | Includes `overstory log tool-start ... --stdin` (line `193`), `overstory log tool-end ... --stdin` (line `213`), `overstory log session-end ... --stdin` (line `237`), debounce `30000` (line `226`), prime `--agent ... --compact` (line `252`) | PASS |
| E7 | events DB query | `sqlite3 "$ROOT_OVERSTORY/events.db" ".tables"` | Includes `events` table | `events` | PASS |
| E8 | events DB query | `sqlite3 "$ROOT_OVERSTORY/events.db" "SELECT id,agent_name,event_type,created_at FROM events ORDER BY id DESC LIMIT 5;"` | Returns recent rows with ids, agent names, event types, timestamps | `812|builder-regmatrix-r2|custom|2026-02-20T14:44:56.974` ... `808|builder-longpoll-r2|custom|2026-02-20T14:43:25.290` | PASS |
| E9 | log artifact verification | `find "$ROOT_OVERSTORY/logs" -maxdepth 3 -type f | sort` | `events.ndjson`, `session.log`, `tools.ndjson` files present | Listed artifacts for `builder-hook-evidence`, `builder-hook-repro`, `builder-hook-repro-r2` | PASS |
| E10 | log artifact verification | `LOG=$(find "$ROOT_OVERSTORY/logs" -type f -name 'events.ndjson' | head -n 1); sed -n '1,6p' "$LOG"` | NDJSON includes structured hook events | `tool.start`, `tool.end`, and `session.end` events shown for `builder-hook-evidence` | PASS |

## Post-Fix Command Cross-Reference

Observed command set in current template+spawned configs matches checklist regex targets, including:

- `overstory log tool-start --agent ... --stdin`
- `overstory log tool-end --agent ... --stdin`
- `overstory log session-end --agent ... --stdin`
- `overstory mail check --inject --agent ... --debounce 500`
- `overstory mail check --inject --agent ... --debounce 30000`
- `overstory prime --agent ... --compact`
- `git push` guard expression

No checklist command updates were required after this post-fix re-run.

## Local vs Spawned Behavior Validation

- Local worktree (`builder-validation-checklist-r1`):
  - `overstory hooks status` and `overstory hooks install --force` both report codex safe no-op behavior.
- Spawned agent worktree (`builder-hook-integrity-runtime`):
  - `.claude/settings.local.json` exists and is readable.
  - `{{AGENT_NAME}}` placeholders are fully substituted.
  - Hook commands include expected `--stdin` and debounce options.

## Pending / Dynamic Data Notes

- `events.db` rows and log file listings are expected to change as parallel agents continue running.
- Re-run E8-E10 for exact latest IDs/timestamps if a later snapshot is required.

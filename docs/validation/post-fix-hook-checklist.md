# Post-Fix Hook Validation Checklist

Task: `overstory-793`  
Related issues: `overstory-0rb.12`, `overstory-u6y`

Run from worktree root:

```bash
cd /Library/Git/overstory/.overstory/worktrees/builder-validation-checklist-r1
```

## Variables

```bash
TEMPLATE="templates/hooks.json.tmpl"
SPAWNED="/Library/Git/overstory/.overstory/worktrees/<agent-worktree>/.claude/settings.local.json"
ROOT_OVERSTORY="/Library/Git/overstory/.overstory"
```

## Checklist

| ID | Class | Command | Expected diagnostics/output pattern | Pass condition |
|---|---|---|---|---|
| C1 | grep parity | `rg -n "overstory prime --agent|overstory mail check --inject|overstory log tool-start|overstory log tool-end|overstory log session-end|mulch learn|git\\s+push" "$TEMPLATE" "$SPAWNED"` | Matches in both files for core hook commands; `git push` guard present | All required patterns are present in both template and spawned deployed hooks |
| C2 | grep parity | `rg -nF "{{AGENT_NAME}}" "$SPAWNED" || echo "no placeholders"` | No placeholder tokens in spawned deployed hooks | Output confirms no `{{AGENT_NAME}}` remains |
| C3 | hook install/deploy (local worktree) | `overstory hooks status` | In codex mode, reports safe no-op with `Hooks target: n/a (cli.base=codex)` | Command exits 0 and reports codex no-op behavior |
| C4 | hook install/deploy (local worktree) | `overstory hooks install --force` | In codex mode, prints safe no-op message | Command exits 0 and confirms no-op |
| C5 | hook install/deploy (spawned worktree) | `ls -l "$SPAWNED"` | `settings.local.json` exists in spawned worktree | File exists and is readable |
| C6 | hook install/deploy (spawned worktree) | `rg -n "OVERSTORY_AGENT_NAME|--stdin|--debounce 30000|overstory prime --agent" "$SPAWNED"` | Agent name substitution present; hook commands include `--stdin` and debounce entries | Deployed spawned hooks contain expected agentized commands |
| C7 | events DB query | `sqlite3 "$ROOT_OVERSTORY/events.db" ".tables"` | Includes `events` table | `events` table exists |
| C8 | events DB query | `sqlite3 "$ROOT_OVERSTORY/events.db" "SELECT id,agent_name,event_type,created_at FROM events ORDER BY id DESC LIMIT 5;"` | Returns recent rows with ids, agent names, event types, timestamps | Query returns rows without SQL error |
| C9 | log artifact verification | `find "$ROOT_OVERSTORY/logs" -maxdepth 3 -type f | sort` | `events.ndjson`, `session.log`, and `tools.ndjson` files appear for agent sessions | Expected log artifacts present |
| C10 | log artifact verification | `LOG=$(find "$ROOT_OVERSTORY/logs" -type f -name 'events.ndjson' | head -n 1); sed -n '1,6p' "$LOG"` | NDJSON entries include events such as `tool.start`, `tool.end`, `session.end` | Structured hook log events are readable |

## Acceptance Criteria Coverage

| Acceptance criteria item | Checklist IDs |
|---|---|
| grep parity checks | C1, C2 |
| hook install/deploy checks | C3, C4, C5, C6 |
| `events.db` query | C7, C8 |
| log artifact verification | C9, C10 |

## Post-Fix Command Sync Notes

- If hook template commands change, update C1 and C6 regexes to keep parity checks aligned with `templates/hooks.json.tmpl`.
- Current post-fix command set to preserve in parity checks includes:
  - `overstory log tool-start --stdin`
  - `overstory log tool-end --stdin`
  - `overstory log session-end --stdin`
  - `overstory mail check --inject --debounce 500`
  - `overstory mail check --inject --debounce 30000`
  - `overstory prime --agent ... --compact`
  - `git push` guard expression

## Notes

- This checklist validates local worktree codex no-op hook behavior and spawned worktree deployed-hook content.
- Record exact command outputs in `docs/validation/post-fix-hook-validation-evidence.md`.

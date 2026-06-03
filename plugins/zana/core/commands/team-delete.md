---
name: zana:team:delete
description: Delete a team template. Confirms before mutating. Built-in templates won't re-seed thanks to the seed-marker.
argument-hint: <teamId>
allowed-tools: mcp__zana__zana_get_team mcp__zana__zana_delete_team
---

# /zana:team:delete

Delete a team template by id. The template file under `~/.zana/teams/<id>.json` is removed.

`$ARGUMENTS` is the team id.

## Workflow

1. If `$ARGUMENTS` is empty, ask "Which team should I delete? (paste the teamId)" and stop.

2. **Pre-flight** — call `mcp__zana__zana_get_team` with `{ "teamId": "<teamId>" }`.
   - If the response is `{ error: "team not found: ..." }`, surface it verbatim and stop.
   - Otherwise render a one-block summary: `name`, `id`, slot count, `initialPrompt` (truncate to 100 chars).

3. **Confirm** — ask: `Delete team "<id>" (<name>)? Reply 'yes' to confirm.` Stop until the user confirms.

4. **Delete** — call `mcp__zana__zana_delete_team` with `{ "teamId": "<teamId>" }`. On `{ ok: true }`, confirm `Team "<id>" deleted.` On `{ ok: false }`, say `Team "<id>" not deleted (file missing or unwritable).`

## Rules

- Never delete without explicit confirmation.
- Built-in templates can be deleted — the seed-marker prevents auto-recreate on daemon restart, so deletion is sticky.
- Do NOT call any tool other than the two listed in `allowed-tools`.

## Now run on:

$ARGUMENTS

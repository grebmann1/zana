---
name: zana:ticket:list
description: List Zana tickets, optionally filtered by status or label. Read-only.
argument-hint: "[status] [--label X]"
allowed-tools: mcp__zana__zana_ticket_list
---

# /zana:ticket:list

List tickets on the Zana work board. Read-only.

`$ARGUMENTS` is optional. First positional token (if any) is a status filter — valid values: `backlog`, `in-progress`, `review`, `done`, `cancelled` (the tool's enum). `--label <name>` filters by label.

## Workflow

1. **Parse** `$ARGUMENTS`:
   - First non-flag token → `status` (lowercased; empty if absent). Validate against the enum above; if invalid, list the valid values and stop.
   - `--label <value>` → `label` (single label string; empty if absent).
2. **Call** `mcp__zana__zana_ticket_list` with only the fields the user supplied:
   - `{}` if no filter
   - `{ "status": "<status>" }` and/or `{ "label": "<label>" }`
   The response is a bare array of ticket records, already sorted by `updatedAt` descending by the daemon.
3. **Render** a compact table — one row per ticket (preserve the server-side order; do not re-sort):
   - `id` (short, first 8 chars)
   - `status`
   - `priority` (one of `critical` / `high` / `medium` / `low`)
   - `title` (truncated to 60 chars)
   - `labels` (comma-joined, or `—` when empty)
4. If the list is empty, say so and (when no filter was given) suggest `/zana:ticket "<title>"` to create one.
5. When tickets are in `in-progress` or `review`, mention `/zana:ticket:review <ticketId>` runs the native two-phase review gate (code-reviewer → architect) before they're closed.

## Rules

- Read-only. Do not call any other tool.
- The daemon returns tickets pre-sorted by `updatedAt` desc; render in that order.
- Do not paraphrase titles; truncate with `…` instead.

## Monitoring

For ongoing visibility, prefer the Claude Code status-line footer over re-running this command. When `~/.claude/settings.json` has `statusLine` wired to `packages/core/dist/bin/statusline.js`, the footer surfaces live counts as `tickets: N doing · N review · N blocked · N todo` — refreshed on every prompt and every `refreshInterval` seconds. Use `/zana:ticket:list` for the full board (titles, ids, labels); use the footer for "is anything in flight?" at-a-glance.

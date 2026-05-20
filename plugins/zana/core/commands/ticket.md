---
name: zana:ticket
description: Quick-create a single Zana ticket with a title and optional priority/labels. Returns the ticketId.
argument-hint: "<title> [--priority critical|high|medium|low] [--label foo,bar]"
allowed-tools: mcp__zana__zana_ticket_create
---

# /zana:ticket

Create a single ticket on the Zana work board. The whole `$ARGUMENTS` string is the title unless it contains `--priority` / `--label` / `--description` flags.

## Defaults

- **priority**: `medium` (the daemon's default when omitted; valid values are `critical`, `high`, `medium`, `low`)
- **labels**: `[]`
- **description**: same as title (one-liner) when `--description` is not supplied

If `$ARGUMENTS` is empty, ask the user "What's the ticket title?" and stop. Do not invoke the tool with an empty title.

## Workflow

1. **Parse** `$ARGUMENTS`:
   - Extract `--priority <value>` if present (one of `critical`, `high`, `medium`, `low`); strip the flag + value from the title. Accept legacy `P0/P1/P2/P3` as input by mapping `P0→critical`, `P1→high`, `P2→medium`, `P3→low`.
   - Extract `--label <comma,separated,list>` if present; split on `,`, trim each, drop empties; strip the flag + value from the title.
   - Extract `--description <text>` if present (rest of token group, quoted or until next flag); strip from title.
   - If the title is wrapped in matching `"..."` or `'...'`, strip the quotes.
   - Trim whitespace. If the resulting title is empty after stripping flags, ask the user for a title and stop.
2. **Validate** priority is one of `critical|high|medium|low`; if not, list the valid values and stop.
3. **Announce** intent in one short line, e.g. `Creating ticket: "<title>" (priority medium, labels: none).`
4. **Call** `mcp__zana__zana_ticket_create` with:
   ```
   {
     "title": "<parsed title>",
     "description": "<parsed description or title>",
     "priority": "<critical|high|medium|low>",
     "labels": ["..."]
   }
   ```
   On success the tool returns the full ticket record (`{ id, title, description, status, priority, ... }`); on bad input it returns `{ error: "..." }`.
5. **Render** the result inline:
   - `ticketId` — the `id` field (full id)
   - `status` — will be `backlog` for newly-created tickets (the valid statuses are `backlog` / `in-progress` / `review` / `rework` / `blocked` / `done` / `cancelled`)
   - `priority`, `labels`
   - Title
6. **Remind** the user about sibling commands:
   - `/zana:ticket:list` to view the board
   - `/zana:ticket:complete <ticketId> <summary>` to close it

## Rules

- Do NOT call any tool other than `mcp__zana__zana_ticket_create`.
- Do NOT invent fields the tool does not accept (only `title`, `description`, `priority`, `labels`).
- Always echo the new `ticketId` so the user can copy it.

## Now run on:

$ARGUMENTS

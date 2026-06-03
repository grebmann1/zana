---
name: zana:council:list
description: List all deliberations, optionally filtered by state (PROPOSED, REVIEWING, SYNTHESIZING, CONVERGING, SETTLED, ESCALATED, EXHAUSTED).
argument-hint: [state]
allowed-tools: mcp__zana__zana_deliberation_list
---

# /zana:council:list

List deliberation summaries. **Daemon path only** — native councils convened via `/zana:council` inside this Claude Code session don't appear here.

The user's argument in `$ARGUMENTS` is an optional state filter. Valid values: `PROPOSED`, `REVIEWING`, `SYNTHESIZING`, `CONVERGING`, `SETTLED`, `ESCALATED`, `EXHAUSTED`. Empty = list all.

## Workflow

1. Trim `$ARGUMENTS`. If non-empty, validate against the enum above; if invalid, tell the user the allowed values and stop.
2. Call `mcp__zana__zana_deliberation_list`:
   - With state: `{ "state": "<UPPER_STATE>" }`
   - Without state: `{}`
3. Render a compact table — one row per deliberation:
   - `id` (short, first 8 chars)
   - `state`
   - `verdict` (or `—`)
   - `currentRound`/`rounds`
   - `voters` (count)
   - `question` (truncated to 60 chars)
   - `updatedAt`
4. If the list is empty, say so and (when no filter was given) suggest running `/zana:council <task>` to start one.

## Rules

- Read-only. Do not call any other tool.
- Sort by `updatedAt` descending so the most recent deliberation is first.

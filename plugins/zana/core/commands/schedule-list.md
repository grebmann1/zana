---
name: zana:schedule:list
description: List all Zana schedules on disk (YAML and JSON). Read-only.
allowed-tools: mcp__zana__zana_schedule_list
---

# /zana:schedule:list

List every schedule registered with the Zana daemon. Read-only.

This command takes no arguments.

## Workflow

1. If `$ARGUMENTS` is non-empty, gently note that this command takes no args and proceed anyway.
2. **Call** `mcp__zana__zana_schedule_list` with `{}`. Returns a bare array of schedule records sorted server-side by `updatedAt` descending. Each record carries `{ id, name, description?, enabled, cron?, intervalMs?, every?, action, status?, updatedAt, _format, ... }` and may also expose flat mirrors of `lastRunAt` / `lastRunResult` / `nextRunAt` (the same fields are nested inside `status` for newer schedules — check both).
3. **Render** a compact table — one row per schedule, sorted client-side by `nextRunAt` ascending (soonest first; schedules with no `nextRunAt` last). Read `nextRunAt` from `schedule.nextRunAt` first, falling back to `schedule.status?.nextRunAt`:
   - `id` (short, first 8 chars)
   - `name`
   - `enabled` (`yes` / `no`)
   - `trigger` — `cron: <expr>` if `cron` is set, else `every: <intervalMs>ms` (or the human-readable `every` shorthand if the record carries one)
   - `action.type` (e.g. `spawn-agent`, `prompt`, `team`, `command`, `workflow`, `mcp_tool`)
   - `lastRunAt` (read `schedule.lastRunAt` ?? `schedule.status?.lastRunAt`; `—` if neither)
   - `nextRunAt` (same fallback chain; `—` if neither)
4. If the list is empty, say so and suggest dropping a YAML file into `<workspace>/.zana/scheduler/` (or copying one of the `.yml.example` files) to register one.

## Rules

- Read-only. Do not call any other tool.
- Do not invent fields not present in the tool's response.
- If a schedule reports a `lastRunResult` starting with `error:` (read from `status.lastRunResult` or the flat mirror), flag it inline (e.g. `lastRunAt (error)`) so the user can investigate.

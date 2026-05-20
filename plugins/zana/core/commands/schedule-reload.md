---
name: zana:schedule:reload
description: Re-read the scheduler directory and re-register triggers. Use after hand-editing YAML schedules.
allowed-tools: mcp__zana__zana_schedule_reload
---

# /zana:schedule:reload

Reload schedules from disk. Use this after hand-editing YAML files in `<workspace>/.zana/scheduler/` so the daemon picks up your changes without a restart.

This command takes no arguments.

## Workflow

1. If `$ARGUMENTS` is non-empty, gently note that this command takes no args and proceed anyway.
2. **Announce** intent in one short line, e.g. `Reloading scheduler directory and re-registering triggers.`
3. **Call** `mcp__zana__zana_schedule_reload` with `{}`. The tool returns `{ started, skipped, total }` (integers) — no per-file error array is exposed; failures are written to the daemon log.
4. **Render** the result:
   - `total` — total schedules read from disk
   - `started` — number whose triggers were (re)registered (enabled + valid)
   - `skipped` — `total - started`; covers disabled schedules and any that failed to register (failures are silent in the response — point the user at the daemon log if they need detail)
5. Suggest `/zana:schedule:list` to confirm the reloaded set.

## Rules

- Mutating call (re-registers triggers) — always announce intent before firing.
- Do NOT call any tool other than `mcp__zana__zana_schedule_reload`.
- The response has no per-file error array; if a YAML file is malformed the daemon logs and skips silently. Note this in the rendered output so the user knows to check the daemon log if `skipped` is unexpectedly high.

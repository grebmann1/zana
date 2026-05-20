---
name: zana:autopilot:list
description: List autopilot goals, optionally filtered by status (running, completed, failed, exhausted, cancelled).
argument-hint: "[status]"
allowed-tools: mcp__zana__zana_autopilot_goal_list
---

# /zana:autopilot:list

List autopilot goal summaries.

The user's argument in `$ARGUMENTS` is an optional status filter. Valid values: `running`, `completed`, `failed`, `exhausted`, `cancelled`. Empty = list all.

## Workflow

1. Trim `$ARGUMENTS`. If non-empty, validate against the enum above; if invalid, tell the user the allowed values and stop.
2. Call `mcp__zana__zana_autopilot_goal_list`:
   - With status: `{ "status": "<status>" }`
   - Without status: `{}`
3. The response is a bare array of `{ id, title, status, iteration, createdAt }` objects. Render a compact table — one row per goal:
   - `goalId` (short, first 8 chars of `id`)
   - `title` (truncated to 60 chars)
   - `status`
   - `iteration` count (e.g. `2`; the response carries no `maxIterations` so render the integer as-is)
   - `createdAt` (epoch ms — render as ISO or `<x>m ago`)
4. If the list is empty, say so and (when no filter was given) suggest running `/zana:autopilot <goal>` to start one.

## Output format

```
> /zana:autopilot:list [status]

goalId    title                                                        status      iter  created
--------  -----------------------------------------------------------  ----------  ----  -------
abc12345  Fix flaky test in packages/work/__tests__/scheduler.test.ts  running     2     3m ago
def67890  Add JSON-mode to deliberate tool                             completed   3     1h ago
```

## Rules

- Read-only. Do not call any other tool.
- Sort by `createdAt` descending so the most recent goal is first.

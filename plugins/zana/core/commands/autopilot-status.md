---
name: zana:autopilot:status
description: Load an autopilot goal by id and render its current status, iteration count, and latest evaluator verdict.
argument-hint: <goalId>
allowed-tools: mcp__zana__zana_autopilot_goal_status
---

# /zana:autopilot:status

Load a goal by id and render its current state.

The user's argument in `$ARGUMENTS` is the goal id.

## Workflow

1. If `$ARGUMENTS` is empty, ask "Which goal? (paste the goalId)" and stop.
2. Call `mcp__zana__zana_autopilot_goal_status` with `{ "goalId": "<trimmed $ARGUMENTS>" }`.
3. Render the response (a flat goal record `{ id, title, criteria, steps, iteration, status, results, createdAt, lastEvaluation?, failureReason?, completedAt? }`):
   - `status` — one of `running` / `completed` / `failed` / `exhausted` / `cancelled`
   - `iteration` count (the response has no `maxIterations`; render it as `iteration: <n>` only)
   - `title`
   - `lastEvaluation` if present — verbatim text from the evaluator agent (a string containing a `VERDICT: PASS` or `VERDICT: FAIL` line). Show the entire string in a fenced block; do not try to parse it apart.
   - `failureReason` if present (set on `failed` / `exhausted` / `cancelled`)
   - Last step run, derived from `results[results.length-1]` if non-empty: `step` index, `agentId`, and the `summary` (already truncated to 1000 chars by the daemon)
4. Hint at next moves:
   - If `running` → `/zana:autopilot:cancel <goalId>` to stop it
   - If `exhausted` or `failed` → suggest the user re-run `/zana:autopilot` with refined criteria
   - If `completed` → done; nothing to do

## Output format

```
> /zana:autopilot:status <goalId>

Goal: <title>
  status:     <status>
  iteration:  <n>
  last step:  step <i> · <agentId> — <summary first line>

Last evaluation:
  <lastEvaluation verbatim, or "(none yet)">
```

## Rules

- Read-only. Do not mutate.
- Quote the `lastEvaluation` text verbatim — it is the raw evaluator output and may contain reasoning the user wants to see unchanged.
- The tool returns `{ error: "unknown goalId" }` when the id is not found. Surface that and stop.

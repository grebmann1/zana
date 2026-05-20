---
name: zana:schedule:trigger
description: Manually fire a Zana schedule once, regardless of its cron/interval. Returns the run result.
argument-hint: <scheduleId>
allowed-tools: mcp__zana__zana_schedule_trigger
---

# /zana:schedule:trigger

Fire a schedule manually, one time. The schedule's normal cron/interval is unaffected — this is a one-off run on top of the regular cadence.

`$ARGUMENTS` is the schedule id.

## Workflow

1. **Parse** `$ARGUMENTS` — trim. If empty, ask "Which schedule? (paste the scheduleId — see `/zana:schedule:list`)" and stop.
2. **Confirm** intent before firing — render one line summarizing what's about to happen, e.g. `Triggering schedule <shortId> now (one-off run).` This is a write operation; the user should see it in the transcript before the tool call.
3. **Call** `mcp__zana__zana_schedule_trigger` with `{ "scheduleId": "<trimmed $ARGUMENTS>" }`. The tool returns `{ ok: true, schedule, result }` on success or `{ error: "schedule not found" }` if the id is unknown. The `result` object has `{ status, startedAt, finishedAt, actionType, ...actionResult }` — there is no `runId`. For `spawn-agent` / `prompt` actions, `actionResult.agentId` is the handle for the spawned agent.
4. **Render** the result:
   - `scheduleId` (echoed) and `schedule.name` from the response
   - `result.status` — `success` / `error` / `pending`
   - `result.startedAt` and `result.finishedAt`
   - `result.actionType` (the action that fired)
   - `result.agentId` if present (for spawn-agent / prompt actions)
   - `result.error` verbatim if `status === "error"`
5. Suggest `/zana:schedule:list` to see updated `lastRunAt` once the run lands.

## Rules

- Mutating call — always announce intent before firing.
- Do NOT call any tool other than `mcp__zana__zana_schedule_trigger`.
- If the tool returns an error (unknown schedule, disabled, etc.), surface it verbatim and stop. Do not retry automatically.

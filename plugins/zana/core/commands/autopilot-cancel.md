---
name: zana:autopilot:cancel
description: Cancel a running autopilot goal by id. Confirms before mutating.
argument-hint: <goalId>
allowed-tools: mcp__zana__zana_autopilot_goal_status mcp__zana__zana_autopilot_goal_cancel
---

# /zana:autopilot:cancel

Cancel a running autopilot goal. The goal lands as `cancelled`; in-flight step agents are not interrupted, but no further iterations will be scheduled.

`$ARGUMENTS` is the `goalId`.

## Workflow

1. **Parse** `$ARGUMENTS` — first whitespace-delimited token is the `goalId`. If missing, tell the user the expected shape (`/zana:autopilot:cancel <goalId>`) and stop.

2. **Pre-flight** — call `mcp__zana__zana_autopilot_goal_status` with `{ "goalId": "<goalId>" }` to:
   - Confirm the goal exists. If not, say so and stop.
   - Show the current state to the user (title, status, iteration). If the status is already `completed`, `failed`, `exhausted`, or `cancelled`, tell the user there's nothing to cancel and stop.

3. **Confirm** — show the user a one-line preview, e.g.
   `About to cancel goal "<title>" (iteration <n>, status running). Proceed?`
   Wait for explicit confirmation before mutating.

4. **Cancel** — call `mcp__zana__zana_autopilot_goal_cancel` with:
   ```
   { "goalId": "<goalId>" }
   ```
   The tool returns `{ ok: true }` on success or `{ ok: false, error: "..." }` (e.g. unknown goal, already terminal). It does NOT echo back the goal record.

5. **Render** the result:
   - On `{ ok: true }` — confirm the goal was cancelled and echo the `goalId`. Do not invent a `status` / `iteration` field; the cancel response has neither. Suggest `/zana:autopilot:status <goalId>` if the user wants the post-cancel trace (status will land as `cancelled`).
   - On `{ ok: false, error }` — surface the error verbatim and stop.

## Rules

- Always pre-flight with a status read before mutating — never cancel blind.
- Do NOT call any tool other than the two listed in `allowed-tools`.
- If the goal is already terminal, do not call `cancel`. Report and stop.

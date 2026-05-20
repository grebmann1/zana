---
name: zana:status
description: One-shot Zana dashboard — running agents, running teams, active sprints, in-flight autopilot goals, in-flight deliberations.
allowed-tools: mcp__zana__zana_list_agents mcp__zana__zana_list_running_teams mcp__zana__zana_sprint_list mcp__zana__zana_autopilot_goal_list mcp__zana__zana_deliberation_list
---

# /zana:status

A read-only dashboard of everything currently in flight in Zana. No arguments.

## Workflow

1. **Fan out — call all five tools in parallel** in a single tool-use block:
   - `mcp__zana__zana_list_agents` with `{}`
   - `mcp__zana__zana_list_running_teams` with `{}`
   - `mcp__zana__zana_sprint_list` with `{ "status": "active" }` — the tool accepts a server-side `status` filter (`planning` | `active` | `completed`); use `active` directly
   - `mcp__zana__zana_autopilot_goal_list` with `{ "status": "running" }`
   - `mcp__zana__zana_deliberation_list` with `{}` — the tool's `state` filter only accepts a single value, so call once unfiltered and filter the response client-side to states `REVIEWING`, `SYNTHESIZING`, `CONVERGING` (the in-flight set; anything that hasn't SETTLED / ESCALATED / EXHAUSTED yet)

2. **Render** as five short sections in the order below. If a section is empty, write `none.` on its own line — do not omit the heading.

3. **Hints** — end with two or three one-liners pointing at the slash commands the user is most likely to want next.

## Output format

```
> /zana:status

Running agents (<n>):
  <agentId>  <profile>  <ticketId>  <state>
  ...

Running teams (<n>):
  <teamId>  <name>  <agents>  <started>
  ...

Active sprints (<n>):
  <sprintId>  <name>  <tickets>  <status>
  ...

Active autopilot goals (<n>):
  <goalId>  <title (truncated)>  iter=<n>
  ...

In-flight deliberations (<n>):
  <id>  <state>  <currentRound>/<rounds>  <question (truncated)>
  ...

Hints:
  /zana:autopilot <goal>           start a goal-driven run
  /zana:council <task>             convene a deliberation
  /zana:autopilot:list running     just the goals
```

## Rules

- Read-only. Do not call any tool other than the five listed in `allowed-tools`.
- Do NOT block the dashboard on a single slow tool — make all five calls in one parallel batch.
- If a tool errors, render that section as `error: <one-line message>` and continue with the rest. The dashboard is best-effort.
- Truncate long titles / questions to ~60 chars so the table stays one-row-per-record.

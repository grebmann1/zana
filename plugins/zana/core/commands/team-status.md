---
name: zana:team:status
description: Read the live state of a running Zana team — orchestrator state, worker states, run id. Read-only.
argument-hint: <teamId>
allowed-tools: mcp__zana__zana_team_status
---

# /zana:team:status

Load the live state of a running team and render it.

The user's argument in `$ARGUMENTS` is the team id.

## Workflow

1. If `$ARGUMENTS` is empty, ask "Which team? (paste the teamId)" and stop.
2. Call `mcp__zana__zana_team_status` with `{ "teamId": "<trimmed $ARGUMENTS>" }`. The response is `{ teamId, teamName, teamIcon, orchestratorAgentId, checkpointId, status, startedAt, orchestrator, workers }` (or `{ error: "team not running: ..." }` if no team is live under that id).
3. Render:
   - `teamId`, `teamName`, `teamIcon`
   - `status` (e.g. `running` / `completed` / `stopped`) and `startedAt` (epoch ms)
   - `checkpointId` (if present)
   - Orchestrator: `orchestratorAgentId` plus the `orchestrator.state` field (agent states are lowercase: `active` / `terminated` / `errored` / `error`)
   - Workers: one row per entry in the `workers` array — `id`, `profileId`, `state`, and any `lastAction` / `lastActivityAt` field on the agent record if present
4. If the response is `{ error: ... }`, surface it verbatim and suggest `/zana:team <teamId> <prompt>` to start one or `/zana:team:list` to see what's running.

## Rules

- Read-only. Do not mutate.
- Do NOT call any other tool.

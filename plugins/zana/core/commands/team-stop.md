---
name: zana:team:stop
description: Stop a running Zana team — kills the orchestrator and all worker agents. Confirms targets before mutating.
argument-hint: <teamId>
allowed-tools: mcp__zana__zana_team_status mcp__zana__zana_stop_team
---

# /zana:team:stop

Stop a running team. The orchestrator and every worker spawned under that team are killed.

The user's argument in `$ARGUMENTS` is the team id.

## Workflow

1. If `$ARGUMENTS` is empty, ask "Which team should I stop? (paste the teamId)" and stop.
2. **Pre-flight** — call `mcp__zana__zana_team_status` with `{ "teamId": "<teamId>" }` so the user can see what is about to be killed. Response shape: `{ teamId, teamName, orchestratorAgentId, status, orchestrator, workers, ... }` or `{ error: "team not running: ..." }`.
3. Render a short block listing every agent that will be terminated:
   - Orchestrator: `orchestrator.profileId` + `orchestratorAgentId` + `orchestrator.state`
   - Workers: one row each from the `workers` array — `profileId`, `id`, `state`
4. **Announce intent**, e.g. `About to stop team "<teamId>" (<teamName>): 1 orchestrator + N workers.`
5. **Stop** — call `mcp__zana__zana_stop_team` with `{ "teamId": "<teamId>" }`. Returns `{ ok: true }` on success or `{ ok: false, error }` if the team isn't running.
6. **Render the result** — on `{ ok: true }`, confirm `Team "<teamId>" stopped (1 orchestrator + N workers killed)` using counts from the pre-flight; the stop response carries no per-agent detail. On `{ ok: false }`, surface the error verbatim.
7. If the pre-flight returned `{ error: ... }`, do NOT call `zana_stop_team`. Tell the user nothing is running under that id and stop.

## Rules

- ALWAYS pre-flight with `zana_team_status` before stopping. Never blind-fire `zana_stop_team`.
- Do NOT auto-restart anything. Stop is final from this command's perspective.
- Do NOT call any tool other than the two listed in `allowed-tools`.

---
name: zana:team:list
description: List configured team templates and currently running teams in two sections.
allowed-tools: mcp__zana__zana_list_teams mcp__zana__zana_list_running_teams
---

# /zana:team:list

List both the configured team templates (what you can spawn) and the live teams (what is currently running).

This command takes no arguments.

## Workflow

1. Call `mcp__zana__zana_list_teams` with `{}` — these are the configured templates.
2. Call `mcp__zana__zana_list_running_teams` with `{}` — these are the live runs.
3. Render two sections in this order:

   **Configured teams** — compact table:
   - `id`
   - `name`
   - `description` (truncated to ~80 chars)
   - worker slot count (sum of slots)

   **Running teams** — compact table (each entry is `{ teamId, teamName, teamIcon, orchestratorAgentId, checkpointId, status, startedAt, orchestrator, workers }`):
   - `teamId` + `teamName`
   - `orchestratorAgentId` (short, first 8 chars)
   - `status` (e.g. `running` / `completed` / `stopped`) and `orchestrator.state` if it differs
   - worker count from `workers.length`
   - `startedAt` (epoch ms — render as `<x>m ago` or ISO)

4. If either list is empty, say so plainly. When no teams are running, suggest `/zana:team <teamId> <prompt>` to start one.

## Rules

- Read-only. Do not mutate.
- Call BOTH listing tools every invocation; never skip one to save a round-trip.
- Sort running teams by `startedAt` descending so the freshest run is first.

---
name: zana:team:status
description: Read live state of a running Zana team. Daemon teams poll via MCP; native in-session teams are tracked via Claude Code's /agents controls.
argument-hint: <teamId>
allowed-tools: mcp__zana__zana_team_status
---

# /zana:team:status

Load the live state of a running team and render it.

The user's argument in `$ARGUMENTS` is the team id.

Two team variants exist:
- **Daemon teams** — spawned by `mcp__zana__zana_start_team` (headless / CI / scheduled). Tracked daemon-side; this command polls them.
- **Native teams** — spawned by `/zana:team` inside this Claude Code session via `Agent` + `SendMessage`. They live in the host conversation; the daemon does not know about them.

## Workflow

1. If `$ARGUMENTS` is empty, ask "Which team? (paste the teamId)" and stop.
2. Call `mcp__zana__zana_team_status` with `{ "teamId": "<trimmed $ARGUMENTS>" }`. The response is `{ teamId, teamName, teamIcon, orchestratorAgentId, checkpointId, status, startedAt, orchestrator, workers }` (or `{ error: "team not running: ..." }` if no daemon team is live under that id).
3. **If the response is an object with `orchestratorAgentId`** (daemon team): render
   - `teamId`, `teamName`, `teamIcon`
   - `status` (e.g. `running` / `completed` / `stopped`) and `startedAt` (epoch ms)
   - `checkpointId` (if present)
   - Orchestrator: `orchestratorAgentId` plus `orchestrator.state` (lowercase: `active` / `terminated` / `errored` / `error`)
   - Workers: one row per entry in `workers[]` — `id`, `profileId`, `state`, `lastAction` / `lastActivityAt` if present
4. **If the response is `{ error: "team not running: ..." }`**: this team id is not in the daemon's running set. Render this block instead:
   ```
   No daemon team is running under "<teamId>".

   If you started this team via /zana:team in the current Claude Code session, it is a NATIVE team — it lives in this conversation as named subagents and is not tracked by the Zana daemon.

   Inspect native agents via Claude Code's built-in /agents controls (the host UI shows live subagent status and SendMessage traffic). To start a daemon team instead, use mcp__zana__zana_start_team directly (headless/CI use case) or re-run /zana:team after starting the daemon explicitly.

   To start one fresh: /zana:team <teamId> <prompt>
   To list known templates: /zana:team:list
   ```

## Rules

- Read-only. Do not mutate.
- Do NOT call any other tool.
- Do NOT attempt to "find" native agents via `mcp__zana__zana_list_agents` — those list daemon-spawned agents only, not native subagents.

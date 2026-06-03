---
name: zana:team:stop
description: Stop a running Zana team. Daemon teams killed via MCP; native in-session teams managed by Claude Code — points at the right control.
argument-hint: <teamId>
allowed-tools: mcp__zana__zana_team_status mcp__zana__zana_stop_team
---

# /zana:team:stop

Stop a running team. The behavior depends on which kind of team is running:

- **Daemon team** (spawned via `mcp__zana__zana_start_team`): orchestrator process and workers are killed daemon-side.
- **Native team** (spawned via `/zana:team` inside this Claude Code session): the agents are subagents of this conversation. Use Claude Code's built-in `/agents` controls to inspect or stop them — Zana cannot kill them because it never spawned them.

The user's argument in `$ARGUMENTS` is the team id.

## Workflow

1. If `$ARGUMENTS` is empty, ask "Which team should I stop? (paste the teamId)" and stop.

2. **Pre-flight** — call `mcp__zana__zana_team_status` with `{ "teamId": "<teamId>" }` to detect which variant we're dealing with.

3. **If pre-flight returns `{ error: "team not running: ..." }`**: this is either a native team or no team at all. Render this block and stop — do NOT call `zana_stop_team`:
   ```
   No daemon team is running under "<teamId>".

   If you started this team via /zana:team in the current Claude Code session, it is a NATIVE team. Native subagents are part of this conversation and Zana cannot stop them. Use Claude Code's built-in /agents controls (the host UI exposes per-subagent stop) to terminate them.

   If you didn't start a team under that id, /zana:team:list will show you what is currently configured and running.
   ```

4. **If pre-flight returns a status object** (daemon team is running): render a short block listing every agent that will be terminated:
   - Orchestrator: `orchestrator.profileId` + `orchestratorAgentId` + `orchestrator.state`
   - Workers: one row each from the `workers` array — `profileId`, `id`, `state`

5. **Announce intent**, e.g. `About to stop daemon team "<teamId>" (<teamName>): 1 orchestrator + N workers.`

6. **Stop** — call `mcp__zana__zana_stop_team` with `{ "teamId": "<teamId>" }`. Returns `{ ok: true }` on success or `{ ok: false, error }` if the team isn't running.

7. **Render the result** — on `{ ok: true }`, confirm `Daemon team "<teamId>" stopped (1 orchestrator + N workers killed)` using counts from the pre-flight; the stop response carries no per-agent detail. On `{ ok: false }`, surface the error verbatim.

## Rules

- ALWAYS pre-flight with `zana_team_status` before stopping. Never blind-fire `zana_stop_team`.
- For native teams, NEVER call `zana_stop_team` — it would return `{ ok: false, error }` and confuse the user. Tell them to use Claude Code's `/agents` controls instead.
- Do NOT auto-restart anything. Stop is final from this command's perspective.
- Do NOT call any tool other than the two listed in `allowed-tools`.

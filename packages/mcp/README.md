# @zana-ai/mcp

The Zana MCP server. Exposes Zana's orchestration primitives — agents,
teams, tickets, sprints, schedules, deliberation, autopilot, swarm — as
MCP tools that any MCP-aware client (Claude Code, Claude Desktop, etc.)
can call.

If you only want to *use* Zana from Claude Code with no source clone,
this is the only package you need to install.

## Install

```bash
npm install -g @zana-ai/mcp
```

This installs two binaries on your PATH:

- `zana` — top-level CLI dispatcher (`zana --help`)
- `zana-daemon` — long-lived process serving the MCP tools

## Register with Claude Code

After install:

```bash
claude mcp add --scope user zana zana-mcp-server
```

Then in any workspace:

```bash
zana headless . --background    # start the daemon (port 47402)
```

In a Claude Code session the `mcp__zana__zana_*` tools are now
available. Discover them with:

- `ToolSearch("zana <keyword>")` — surface deferred tool schemas
- `mcp__zana__zana_list_profiles` — built-in agent roles
- `mcp__zana__zana_list_teams` — curated team templates

## Tool surface

94 tools across these domains (see
[`docs/MCP-TOOL-REFERENCE.md`](../../docs/MCP-TOOL-REFERENCE.md) for the
full schema reference):

| Domain | Examples |
|---|---|
| Agents | `zana_spawn_agent`, `zana_list_agents`, `zana_kill_agent` |
| Teams | `zana_list_teams`, `zana_start_team`, `zana_team_status` |
| Tickets | `zana_ticket_create`, `zana_ticket_claim`, `zana_ticket_complete` |
| Sprints | `zana_sprint_create`, `zana_sprint_start`, `zana_sprint_board` |
| Deliberation | `zana_deliberate`, `zana_deliberation_status`, `zana_deliberation_nudge` |
| Autopilot | `zana_autopilot_goal_driven`, `zana_autopilot_goal_status` |
| Schedules | `zana_schedule_list`, `zana_schedule_trigger`, `zana_schedule_reload` |
| Memory | `zana_memory_store`, `zana_memory_search` |
| Artifacts | `zana_artifact_create`, `zana_artifact_read` |

## Native vs daemon path

For most chat-based work, prefer the **native plugin**
(`zana@zana-marketplace`) — slash commands like `/zana:team`,
`/zana:council`, and `/zana:autopilot` rewrite the work into Claude
Code's first-class `Agent` + `SendMessage` primitives with no daemon
round-trip.

The daemon path (this package) is for headless / CI / cron use cases
where work must outlive any chat session, or for multi-daemon swarms.

## Build & test

```bash
npm run -w @zana-ai/mcp build
cd packages/mcp && npx vitest run
```

After editing tool schemas or adding new tools, regenerate the doc
reference:

```bash
npm run docs:mcp-ref
```

## See also

- Top-level [README](../../README.md) — paths, getting started,
  installation
- [`INSTALL.md`](../../INSTALL.md) — step-by-step install incl.
  marketplace + MCP registration
- [`@zana-ai/core`](../core) — the engine this server wraps

# Zana

Zana is a multi-agent orchestrator for Claude Code. It runs as a long-lived daemon, exposes an MCP server that Claude Code attaches to, and lets a single conversation spawn, supervise, and synthesize the work of many specialized worker agents — each with its own profile, context, and tool surface.

## What Zana is

- Multi-agent orchestrator for Claude Code
- MCP server exposing 69+ tools for spawning agents, managing tickets/sprints, and coordinating swarms
- Pluggable module system for adding new capabilities without forking the core

## Repository layout (7 packages)

- `packages/core` — foundational engine (agents, events, project, modules, persistence)
- `packages/work` — work tracking (tickets, scheduling, teams, runs)
- `packages/server` — HTTP/IPC surface (hooks, REST API)
- `packages/swarm` — multi-daemon coordination
- `packages/intelligence` — task routing, GOAP planning, vector memory
- `packages/extras` — settings + plugin loader
- `packages/mcp` — MCP server exposing zana to Claude Code
- `plugins/zana/core` — Claude Code plugin (slash command + skills)

## Built-ins

- 11 agent profiles in `packages/core/profiles/`: architect, backend-dev, frontend-dev, test-writer, code-reviewer, full-auto-coder, doc-generator, ux-designer, orchestrator, swarm-master, swarm-orchestrator
- 1 example module in `packages/core/modules/example/`

## Getting started

- Install: `npm install`
- Build: `npm run build:runtime`
- Test: `npm test`
- CLI: `node dist/bin/zana.js init` then `node dist/bin/zana.js status`
- MCP: register the built server with Claude Code — `claude mcp add zana node packages/mcp/dist/src/mcp-server.js`

## Master mode

For multi-daemon setups, set `ZANA_MASTER_MODE=true` to expose the 6 `zana_swarm_*` tools (75 total instead of 69). For ordinary single-daemon orchestration, leave it off — the in-process agent tools are sufficient.

## Architecture notes

- Lazy require getters in core's facade break what would otherwise be circular package deps
- All packages declare workspace-relative version `*` — npm workspaces resolves siblings
- Built-in profiles ship in core's `dist/`; user profiles live in `~/.zana/profiles/`

## Status

- Tests: 140/141 (1 pre-existing migration test issue)
- Recent refactors: dropped legacy "hive" naming, split monolith into 7 themed packages, full purge of vocabulary

## Contributing

PRs welcome. Keep tests at baseline. Use the existing patterns (sed-able identifier renames, lazy require for cycle breaks).

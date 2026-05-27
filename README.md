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

- 14 agent profiles in `packages/core/profiles/`: architect, backend-dev, frontend-dev, test-writer, code-reviewer, debugger, doc-generator, full-auto-coder, ux-designer, researcher, security-reviewer, orchestrator, swarm-master, swarm-orchestrator
- 1 example module in `packages/core/modules/example/`

## Getting started

Quick path: `bash scripts/install.sh` from the repo root. Full step-by-step
(humans + agents): see [INSTALL.md](./INSTALL.md), which covers prerequisites,
manual install, marketplace + MCP registration, daemon boot, verification, and
common failure modes.

Bare-minimum cheat sheet:

- Install: `npm install`
- Build: `npm run build:runtime`
- Test: `npm test`
- CLI: `node dist/bin/zana.js init` then `node dist/bin/zana.js status`
- MCP: `claude mcp add -s local zana node packages/mcp/dist/src/mcp-server.js`

## Master mode

For multi-daemon setups, set `ZANA_MASTER_MODE=true` to expose the 6 `zana_swarm_*` tools (75 total instead of 69). For ordinary single-daemon orchestration, leave it off — the in-process agent tools are sufficient.

## Architecture notes

- Lazy require getters in core's facade break what would otherwise be circular package deps
- All packages declare workspace-relative version `*` — npm workspaces resolves siblings
- Built-in profiles ship in core's `dist/`; user profiles live in `~/.zana/profiles/`

## Status

- Tests: 458/458 (45 test files)
- Recent work:
  - Hook-server hardening (Tier 1+2): error propagation, agentId regex, graceful drain, 30s handler timeout, fan-out cap, jq-safe terminal-id injection
  - Scheduler `workflow` and `mcp_tool` actions wired
  - Opt-in run-history with retain-N policy (`history: { enabled, retain }` in YAML)
  - Event log + audit log size-based rotation (`ZANA_EVENT_LOG_MAX_BYTES`)
  - Structured logger module (`packages/core/src/util/logger.ts`)
  - Hook installer drift detection (re-deploys stale `~/.zana/bin/post-hook.sh` on upgrade)

For deeper docs: `packages/server/README.md` (HTTP surfaces + hook flow), `packages/work/README.md` (scheduler schema), `plugins/zana/core/commands/zana.md` (orchestrator command + diagnostics).

**Slash-command authors:** before writing a render block for any `zana_*` MCP tool, consult [`docs/MCP-TOOL-REFERENCE.md`](docs/MCP-TOOL-REFERENCE.md). It is the source of truth for input schemas, output shapes, enum values, and known field-name landmines (e.g. priority is `critical|high|medium|low`, not `P0|P1|P2|P3`; initial ticket status is `backlog`, not `open`; `zana_start_team` returns `{ ok, orchestratorAgentId, terminalId }` with no `runId`). Regenerate after MCP changes with `npm run docs:mcp-ref`.

## Contributing

PRs welcome. Keep tests at baseline. Use the existing patterns (sed-able identifier renames, lazy require for cycle breaks).

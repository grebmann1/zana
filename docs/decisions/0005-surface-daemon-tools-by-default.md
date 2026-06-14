# ADR 0005 — Surface the daemon-path MCP tools by default

- **Status:** Accepted
- **Date:** 2026-06-12
- **Relates to:** the June `c3492bf` native pivot (which introduced the gate this ADR re-tunes)

## Context

zana exposes ~88 MCP tools. 24 of them drive the **daemon path** — agent lifecycle
(`zana_spawn_agent*`, `zana_kill_agent`, …), team lifecycle (`zana_start_team`, …), P2P inbox
(`zana_ask_agent`, …), autopilot (`zana_autopilot_goal_*`), and deliberation (`zana_deliberate*`).

When the slash commands were re-pointed to native `Agent`+`SendMessage` (commit `c3492bf`), these
24 tools were **hidden behind an opt-in `ZANA_DAEMON_TOOLS=1` gate** (`packages/mcp/src/gating.ts`,
`DAEMON_GATED_TOOL_NAMES`) to keep the in-chat surface lean — the reasoning being that a Claude
Code user has the slash commands and doesn't need the MCP variants.

In practice this made the daemon path **undiscoverable**. The tools never appeared in `tools/list`
unless the user knew to set an env var, so the persistent, cross-session, headless-capable half of
zana (scheduled autopilot, deliberation with audit trail, teams that outlive a chat) was invisible
by default. The daemon is a first-class part of zana, not an advanced add-on — hiding its entire
tool surface undersold it.

## Decision

Flip the default: **the daemon-path tools are surfaced by default.** `ZANA_DAEMON_TOOLS` becomes
an opt-**out** — set `ZANA_DAEMON_TOOLS=0` (or `=false`) for the lean native-only surface.

```ts
// packages/mcp/src/gating.ts
export const ZANA_DAEMON_TOOLS =
  process.env.ZANA_DAEMON_TOOLS !== "0" && process.env.ZANA_DAEMON_TOOLS !== "false";
```

Only the default flips. The `DAEMON_GATED_TOOL_NAMES` set, and the two enforcement points in
`mcp-server.ts` (the `tools/list` filter and the `tools/call`-time rejection), are unchanged — so
`ZANA_DAEMON_TOOLS=0` still both hides *and* refuses the tools, exactly as `=1` used to gate them.

`ZANA_MASTER_MODE` (the 6 `zana_swarm_*` tools) stays **opt-in**. Multi-daemon swarm control is
genuinely advanced and headless-only; surfacing it by default would be noise for everyone else.

## Consequences

- Default `npx -y @zana-ai/mcp` now registers all ~88 tools; the daemon path is discoverable
  without env spelunking.
- Users who want the minimal in-chat surface set `ZANA_DAEMON_TOOLS=0` once — the capability the
  old default gave for free, now one flag away.
- Docs that described the old opt-in default were corrected in lockstep: `CLAUDE.md` (MCP tool
  surface), `plugins/zana/core/skills/orchestration/GUIDE.md` (daemon-tool gate callout), root
  `README.md` (daemon-only tools section).
- The gating tests (`packages/mcp/test/gating.test.ts`, `tool-gating.test.ts`) were inverted to
  assert the new default (daemon tools visible with no env; hidden under `=0`).
- No behavior change for headless/CI callers that already set `ZANA_DAEMON_TOOLS=1` — that value
  still resolves to "on".

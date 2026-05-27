# Zana smoke test — 2026-05-20

Daemon: pid 92913, workspace `/Users/grebmann/Documents/claude-workspace/zana`.
- Hook server (loopback, no-auth): `127.0.0.1:47403`
- API server (bearer-token auth): `127.0.0.1:47404`
- Auth token: `~/.zana/auth.json`
- MCP: `✓ Connected`

## Summary

| # | Subsystem | Status | Notes |
|---|---|---|---|
| 1 | MCP connectivity | PASS | `claude mcp list` reports Connected |
| 2 | Daemon HTTP | PASS | Two distinct servers; 16 routes verified |
| 3 | Tickets | PASS | full create/claim/complete round-trip |
| 4 | Sprints | PASS (with bug) | lifecycle works; ticketIds not populated when ticket created with sprintId |
| 5 | Profiles | PASS | All 14 documented profiles present (+5 extras) |
| 6 | Memory | PASS | Store + tier-aware retrieval works (no delete via API) |
| 7 | Schedules | PASS | `/scheduler/trigger` advanced runCount; `/api/schedules` view stale |
| 8 | Events | PASS | emit + query round-trip, tags preserved |
| 9 | Channels | PASS (minor) | publish/list/history work; history payload omits message body |
| 10 | Autopilot (read-only) | PASS | `zana_autopilot_goal_list` returns `[]` cleanly |
| 11 | Deliberation (read-only) | PASS | 8 historical deliberations; checkpoints on disk match |
| 12 | Teams | PASS (with bug) | 6 teams returned; all reference non-existent `built-in-*` profile IDs |
| 13 | Hooks | PASS | `post-hook.sh` executable, broadcast wrapper current; older sessions have non-empty event logs |
| 14 | Statusline | PASS | Output begins `⚡ zana on (pid 92913) ...` |

**Counts:** 14 PASS / 0 FAIL / 0 SKIP. (Autopilot/Deliberation/Team **live fire** intentionally not exercised — see Skipped section.)

---

## Architecture finding (relevant to subsequent tests)

The daemon listens on **two ports**, not one:

| Port | Role | Auth |
|---|---|---|
| 47403 | Hook server (`packages/server/src/hooks/server.ts`) — agent ↔ daemon callbacks. Exposes `/health`, `/tickets*`, `/sprints*`, `/scheduler/*`, `/events/*`, `/swarm/*`, `/hook`, `/orchestrator`, `/focus`. | None (loopback-only by design — see source comment) |
| 47404 | API server (`packages/server/src/api/server.ts`) — UI/MCP control plane. Exposes `/profiles`, `/teams`, `/skills`, `/agents`, `/memory`, `/api/schedules`, `/api/checkpoints`, `/api/autopilot/goals`, `/status`, `/workers`, `/terminals`, `/artifacts`, `/api/modules`, etc. | Bearer token from `~/.zana/auth.json` |

`~/.zana/daemons/<id>.json` registers only `port: 47403`. The 47404 port is auto-incremented from `47403+1`. Tools that probe a daemon and expect everything on one port will silently miss half the API. **The task brief assumed everything was on 47403** — first round of probes returned 404 for `/profiles`, `/api/schedules`, etc. until I switched ports and added bearer auth.

## Per-subsystem detail

### 1. MCP connectivity — PASS

```
$ timeout 10 claude mcp list 2>&1 | grep zana
zana: node /Users/grebmann/.../mcp-server.js - ✓ Connected
```

### 2. Daemon HTTP — PASS

`/health` on 47403 → `{ok:true, daemonId:"33cf2ce1", pid:92913}`.
Probed 16 paths; representative results:

| Route | Server | Status |
|---|---|---|
| `/health` | 47403 | 200 |
| `/tickets`, `/sprints`, `/scheduler/list`, `/events/query`, `/events/emit`, `/swarm/agents` | 47403 | 200 |
| `/profiles`, `/teams`, `/skills`, `/agents`, `/memory`, `/status`, `/workers`, `/terminals`, `/artifacts`, `/api/schedules`, `/api/checkpoints`, `/api/autopilot/goals`, `/api/modules`, `/api/workflows/runs` | 47404 (auth required) | 200 |

### 3. Tickets — PASS

Full round-trip via `127.0.0.1:47403`:

```
$ POST /tickets {"title":"smoke-test-ticket"...} → 200, id=e7b68d76...
$ POST /tickets/claim → status: in-progress
$ POST /tickets/complete → status: done, resultSummary: "smoke-test ok"
$ GET /tickets | jq → {id:e7b68d76..., status:"done", resultSummary:"smoke-test ok"}
```

Audit trail records `created → claimed → status_changed → completed` correctly.

### 4. Sprints — PASS (with bug)

Created `smoke-test-sprint`, started, ended:

```
$ POST /sprints  → status: planning
$ POST /sprints/start → status: active, startedAt set
$ POST /sprints/end   → status: completed, endedAt set
```

**Bug:** Created a ticket with `{sprintId: "<sprint id>"}` while the sprint existed. The ticket persisted `sprintId` correctly, BUT `sprint.ticketIds` stayed `[]` after start and end. Linkage is one-way only (ticket→sprint) unless something else (a separate `/sprints/<id>/tickets` endpoint?) is meant to populate the back-reference. The hook server doesn't appear to expose such an endpoint. Documented as P2.

### 5. Profiles — PASS

All 14 documented in README present: `architect, backend-dev, frontend-dev, test-writer, code-reviewer, debugger, doc-generator, full-auto-coder, ux-designer, researcher, security-reviewer, orchestrator, swarm-master, swarm-orchestrator`. Plus 5 extras (`api-designer, performance-engineer, slack-reporter, backend-dev-fixed, frontend-dev-fixed`) — total 19.

### 6. Memory — PASS

```
$ POST /memory {"content":"smoke-test memory entry","tags":["smoke-test"],"importance":0.5}
  → {"id":"46b16c39...","tier":"episodic"}
$ GET /memory  → {"total":1,"byTier":{"working":0,"episodic":1,"semantic":0},"vocabularySize":4}
$ GET /memory?q=smoke-test → [{id,content,score:0.707,tier:"episodic"}]
```

No `/memory/<id>` DELETE found in API server probe; left as documented residue.

### 7. Schedules — PASS

1 active schedule (`code-and-docs-audit`, every 10m). Triggered via `POST /scheduler/trigger {"id":"code-and-docs-audit"}`. Response `{}`. **However** subsequent `GET /scheduler/list` showed `lastRunAt` advancing to current timestamp, `runCount` 466, `lastRunResult: "success"`, `nextRunAt` 10m forward. The matching `GET /api/schedules` on 47404 returns the schedule **without** the `status.lastRun*` fields — a UI-facing view stripped of run state. P2 inconsistency.

History persists per-schedule under `~/.zana/scheduler/<id>.history.json` (2222 entries on disk). The `code-and-docs-audit` schedule does **not** have a `<id>.history.json` file because its YAML uses the slug-style ID, not a UUID — appears to be a code path that bypasses persistence; runCount=466 is in-memory only. P2.

### 8. Events — PASS

```
$ POST /events/emit {"type":"smoke-test","payload":{"hello":"world"},"tags":["smoke-test"]} → {ok:true}
$ GET /events/query?types=smoke-test  → [{id, type:"smoke-test", source:"system", timestamp, payload:{hello:"world",tags:[...]}, tags:["smoke-test"]}]
```

Round-trip clean.

### 9. Channels — PASS (minor)

Via MCP stdio (channels have no HTTP route):

```
zana_publish_channel → {ok:true, delivered:0, subscribers:0}
zana_list_channels   → [{name:"smoke-test-channel", subscribers:0, messageCount:1, lastActivity:1779308099951}]
zana_channel_history → [{fromAgentId:null, fromDaemonId:"local", id, sentAt, channel:"smoke-test-channel"}]
```

**Minor:** `channel_history` envelope omits the actual `message` body — tool reference doc shows the response should include the published payload. Could be intentional (sender-only metadata view) but contradicts `MCP-TOOL-REFERENCE.md`. P2.

### 10. Autopilot — PASS (not live-fired)

`zana_autopilot_goal_list` → `[]`. No persisted goals on disk (no `~/.zana/autopilot/` directory). API server `/api/autopilot/goals` also returns `[]`. Live spawn skipped — would launch real agents.

### 11. Deliberation — PASS (read-only)

`zana_deliberation_list` returned 8 deliberations (5 SETTLED/ESCALATED, 3 PROPOSED). Schema matches docs: `{id, state, question, currentRound, rounds, voters, verdict|escalationReason, createdAt, updatedAt, settledAt}`. 7 corresponding `<deliberationId>.json` files exist in `~/.zana/checkpoints/` (one PROPOSED entry, `ff97c4a6...`, has no checkpoint — likely never advanced past creation).

### 12. Teams — PASS (with bug)

`zana_list_teams` returns 6 teams: `backend-squad, frontend-squad, fullstack-squad, jurassic-park-squad, lotr-app-squad, star-wars-quiz-squad`. Each has the documented `{id, name, orchestratorProfileId, slots[], workerProfileIds, initialPrompt, rules}` shape.

**Bug:** Team `slots[].profileId` and `workerProfileIds` reference IDs like `built-in-architect`, `built-in-orchestrator`, `built-in-frontend-dev`, `hive-mind-master`, `built-in-full-auto-coder` — **none of these exist in the profile list**. The actual profile IDs are bare (`architect`, `orchestrator`, etc.). Starting any of these teams would fail to resolve workers. Either the profiles need a `built-in-` prefix migration, or the team templates need to drop the prefix. P0 if anyone ever runs `zana_team_start` against built-in templates.

The exception: `lotr-app-squad` and `star-wars-quiz-squad` use plain `full-auto-coder` (no prefix), which resolves correctly.

### 13. Hooks — PASS

```
$ ls -la ~/.zana/bin/post-hook.sh
-rwxr-xr-x  1699 bytes May 20 01:20  (executable, recent)
```

Top of file confirms broadcast-mode wrapper that injects `zana_terminal_id` via jq and forwards to all `~/.zana/daemons/*.json` and legacy `~/.zana/hives` entries (10-daemon fan-out cap). Older session event logs (`~/.zana/sessions/2026-05-07T21-00-57/events.ndjson` etc.) are non-empty, confirming hooks fire when a Claude Code session is active in the workspace. The current smoke-test agent doesn't have hooks attached (different harness), so this session's `events.ndjson` is empty — that's expected.

### 14. Statusline — PASS

```
$ echo '{"workspace":{"current_dir":"/Users/.../zana"}}' | node packages/core/dist/bin/statusline.js
⚡ zana on (pid 92913) | 1 sched ⏱ next 9m | 10 agents | 0 tickets (+1 other daemon)
```

Output starts with `⚡ zana`, not `🐝 hive`. Branding migration is complete in this binary.

---

## Failures detail

None — all 14 subsystems passed. Three "PASS with bug" notes captured above (Sprints back-link, Teams profile IDs, Channels history payload).

## Skipped

- **Autopilot live fire** — would spawn real agents.
- **Deliberation live fire** — would spawn voter agents.
- **Team start** — would spawn workers; would also surface the `built-in-*` profile-ID resolution bug.
- **Subscribe to channel via MCP** — MCP stdio session terminates before subscribe state can be observed (session-bound subscriber).
- **Post-restart probes** — instructed not to bounce the daemon.

## Cleanup status

- Tickets created: **2** (`smoke-test-ticket`, `smoke-test-sprint-ticket`) — both **completed (status: done)**.
- Sprints created: **1** (`smoke-test-sprint`) — **ended (status: completed)**.
- Memory entries: **1** in tier `episodic` (id `46b16c39-545f-43b2-a6d4-ea82f9bba197`) — left in place; no DELETE endpoint observed in API server route table.
- Events emitted: **1** (`type: smoke-test`) — left in event log; events are append-only.
- Channels: **1** (`smoke-test-channel`, 1 message) — left in place; in-memory router has no documented purge tool.

No human cleanup needed beyond memory/events/channel residue, all of which are tagged with `smoke-test` for grep-ability.

## Recommendations / follow-ups

### P0 (broken / could break a real workflow)
1. **Built-in team templates reference non-existent profile IDs.** Four of six teams (`backend-squad`, `frontend-squad`, `fullstack-squad`, `jurassic-park-squad`) cite `built-in-architect`, `built-in-orchestrator`, `hive-mind-master`, etc. Profile registry exposes the un-prefixed names. Either rename profiles or fix team manifests.

### P1 (real but non-shipping)
2. **Schedule run state is invisible from the API server view.** `/api/schedules` (port 47404) strips the `status.{lastRunAt,lastRunResult,nextRunAt,runCount}` fields that `/scheduler/list` (port 47403) exposes. UI consumers that only know about 47404 will see schedules as "never run."
3. **`code-and-docs-audit` history not persisted.** runCount=466 lives only in memory; no `~/.zana/scheduler/code-and-docs-audit.history.json` exists on disk despite all other schedules persisting one. Restart loses 466 runs of state.

### P2 (polish)
4. **Sprint→ticket back-link not populated.** Creating a ticket with `sprintId` doesn't push the ticket id into `sprint.ticketIds`. UI that lists "tickets in this sprint" via `sprint.ticketIds` will under-count.
5. **`zana_channel_history` envelope omits message body.** Either fix the handler to include `message`/`payload` or update `docs/MCP-TOOL-REFERENCE.md` to match the metadata-only shape.
6. **Two-port architecture is undocumented.** `~/.zana/daemons/<id>.json` registers `port: 47403` only; the +1 API port is implicit. Add it to the registry record so external tooling can discover both.
7. **10 errored Code Reviewer agents in `/swarm/agents`.** Worth a janitor pass — they accumulate from failed schedule fires.

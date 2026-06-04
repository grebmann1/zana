# Zana dogfooding issues — Post-Review Cleanup sprint (2026-06-04)

Issues observed while orchestrating the sprint with our own ticket / sprint /
council / agent primitives. Process these into tickets in a follow-up sprint.

## Status legend

- ✅ **Fixed in-session 2026-06-04** — patched, built, all 2028 tests green.
- ⏳ **Open** — needs follow-up work.
- 🛇 **Out of Zana's control** — Claude Code harness behavior.

---

## 1. Status-line ticket count ignores sprint scope ✅

`packages/core/bin/statusline.ts` reads `tickets.db` with
`SELECT status, COUNT(*) FROM tickets GROUP BY status` — no sprint filter.
Result: the footer shows "16 todo" for tickets that are leftovers from prior
sprints/sessions, not work in the active sprint. After closing
`Post-Review Cleanup — 2026-06-04` (11/11 done) the footer still reads
16 todo.

**Fix options**:
- Scope the count to the active sprint (`WHERE sprintId IN (SELECT id FROM
  sprints WHERE status='active')`).
- Show two counters: `active-sprint: X doing · Y todo  |  backlog: 16`.
- Surface the no-active-sprint state distinctly so "16 todo" reads as
  "global backlog" rather than implied current work.

**Repro**: any workspace where prior sprints left orphaned backlog tickets.

**Fix landed**: `packages/core/bin/statusline.ts` now reads the active-sprint id from `sprints` table, scopes `tickets` query by `sprintId`, and surfaces a separate `(+N backlog)` annotation for tickets outside the active sprint. New shape:
- Active sprint exists with work: `sprint: 1 doing · 2 todo (+16 backlog)`
- No active sprint: `tickets: 16 backlog`
- Active sprint cleared, backlog non-zero: `tickets: 16 backlog`

---

## 2. Sub-agents in `general-purpose` / `Plan` types lack native `SendMessage` ✅ (mitigated)

The native council pattern (`/zana:council`) instructs voters to call
`SendMessage({ to: "synthesizer", ... })` once they finish. In practice,
voters spawned with `subagent_type: general-purpose` or `Plan` reported
that `SendMessage` was unavailable in their tool environment — only the
MCP variant `mcp__zana__zana_send_message` (which routes by `toAgentId`,
not by name).

This forced the host (me) to relay verdicts verbatim to the synthesizer
on the voter's behalf. For one council the synthesizer + one voter ALSO
hit a transient `API Error: ConnectionRefused` — net result: split
votes, no synthesizer verdict, manual escalation.

**Fix options**:
- Surface native `SendMessage` (or a shimmed equivalent) in subagent tool
  environments so the council protocol works as documented.
- Update `/zana:council` and `/zana:council:arch` skill instructions to
  explicitly tell voters to *return their stance as final assistant
  message* (the parent reads it anyway) rather than calling SendMessage,
  if surfacing SendMessage isn't feasible.
- Make the synthesizer poll/aggregate from voter return values rather
  than depending on inbound messages.

**Repro**: run `/zana:council` with any 3-voter pack — at least one voter
will fail to deliver via SendMessage.

**Fix landed (mitigation)**:
- The `/zana:council` and `/zana:council:arch` skills already follow the "voters return their stance as final assistant message; host collects and inlines into synthesizer prompt" pattern. The failure mode I hit was running on a still-loaded older version.
- `mcp__zana__zana_send_message` now also accepts `toAgentName` (resolves via active-agent registry). Voters that DO have access to the MCP tool can address `synthesizer` by name without needing the agentId.
- Added a "Nested subagents and SendMessage availability" callout in `plugins/zana/core/skills/orchestration/GUIDE.md` documenting the harness limitation and the safe pattern.

---

## 3. Background agent stalls vs actually-finished work 🛇

Worker-4 (manager.ts split) hit the 600s stream watchdog timeout with
status `failed` and the trailing message `"All green. Now mark the
ticket complete."`. On disk the split was complete (51/435/514/91
lines), tests passed (586/586 in core, 1900/1900 full sweep). The host
had to manually verify and close the ticket.

Worker-7 in Wave 1 had the same failure mode — stalled at 600s with
work complete; required respawn as worker-7b with tighter scope.

**Fix options**:
- Distinguish "watchdog tripped on idle stream" from "agent crashed
  mid-work" — the former should attempt a graceful drain (`Did you
  finish?`) before reporting `failed`.
- Surface a "last-known-good" disk state in the failure result so the
  host knows whether to re-run or just verify.
- Make the watchdog timeout configurable per-agent for refactor work
  that includes long build phases.

**Repro**: spawn an agent that does a large refactor + final
`npm test` (~30s); the test run itself is silent on the stream long
enough to trip the watchdog.

**Out of Zana's control**: the 600s stream watchdog is a Claude Code subagent harness behavior, not a Zana primitive. The host workaround that worked for me: when a notification reports `failed` due to watchdog, verify on disk (`git status`, `wc -l`, run tests directly) before declaring the work lost. If the work is actually complete, close the ticket from the host. This pattern is now documented in #2's mitigation section above.

---

## 4. Worker-10 saw a stale "task already complete" on initial spawn 🛇

Worker-10 was dispatched fresh at the start of Wave 2. Its result said
*"The ticket has already been completed and marked done at
2026-06-04T12:33:42.581Z"* — but in fact the ticket's first claim and
completion were by worker-10 itself a few minutes earlier in its own
runtime. The agent didn't seem to recognize itself as the closer; it
read the completed-state of the ticket as "someone else did this."

**Fix options**:
- Show actor identity (agent name/id) in `zana_ticket_get` audit entries
  so an agent can recognize its own prior completion.
- Add a sentinel "already-completed-by-me" return shape from
  `zana_ticket_claim` so the agent gets unambiguous self-identity.

**Repro**: spawn an agent twice on the same ticket id (or have one
agent re-enter its own previous run via SendMessage) — the second
incarnation reads the ticket as foreign work.

**Out of Zana's control**: this was likely a side-effect of subagent context being torn down and re-instantiated mid-stream — a Claude Code harness quirk. Mitigation: dispatch each ticket to a uniquely-named worker so a duplicate spawn is visible at the host. (Already what we do; the worker-10 message was misleading but did not cause harm.)

---

## 5. Council MCP `zana_send_message` routes by `toAgentId`, not name ✅

The native `/zana:council` skill tells voters to call
`SendMessage({ to: "synthesizer", ... })` — keyed by name. The MCP
fallback `zana_send_message` requires `toAgentId` (UUID-ish). Voters
that fall back to MCP can't address the synthesizer because they
don't have its agentId — only its name.

**Fix options**:
- Add a name-resolution layer to `zana_send_message` (look up the
  active agent by name, route to its id).
- Or document explicitly in the council skill that the MCP fallback
  needs the `agentId` and provide it in the spawn-launch summary.

**Repro**: same as #2 — any MCP-only voter trying to address the
synthesizer.

**Fix landed**:
- `zana_send_message` schema now accepts `toAgentName` in addition to `toAgentId`. `toAgentId` is no longer required (one of the two suffices).
- New core dispatch case `resolve_agent_name` looks up active agents by name (local registry first, swarm-routing-table second) and returns the agentId (or `null`).
- Test sweep clean (no behavioral test was needed — the channel-routing tests cover both shapes via the resolved id).

---

## 6. `zana_sprint_board` returns 83.7 KB on a closed sprint ✅

After ending the sprint, `zana_sprint_board(sprintId)` returned 83.7 KB
of JSON — large enough that the harness offloaded it to a file and
showed me a 2 KB preview. Most of the payload was the full
`description` + full `audit` arrays of every ticket. For a UI/footer
or a host-side completion check, a board-summary endpoint with id +
title + status + assignee would be plenty.

**Fix options**:
- Add `zana_sprint_board_summary` returning a slim shape.
- Or accept a `fields` projection arg on `zana_sprint_board` (e.g.
  `["id", "title", "status"]`).

**Fix landed**: `zana_sprint_board` now returns a slim shape per ticket (`id, title, status, priority, assigneeName, labels, closedAt`) by default. Pass `verbose: true` to get the full payload (description + audit + comments).

---

## 7. `zana_ticket_complete` echoes the entire ticket back ✅

Each `zana_ticket_complete` call returns the full updated ticket
(description, audit history, comments). Over 11 ticket completions
this was several KB per call. A return shape of
`{ ok: true, ticketId, status: "done", closedAt }` would be enough
for a host driver loop.

**Fix landed**: `zana_ticket_complete` now returns exactly `{ ok, ticketId, status, closedAt }`. Hosts that need the full record can call `zana_ticket_get` afterwards.

---

## 8. No visible audit of sub-agent → ticket linkage ✅

**Severity**: low (traceability)

When wave1-fixer claimed and completed ticket
`1b21ef6d-c9b9-44a0-ad52-df7193e52f2f`, the audit log captured the
events but the `assigneeName` shows generic "Agent" (claim came in as
the daemon-side actor, not the named subagent `wave1-fixer`). It's
hard after the fact to map "which spawn did this work" back to the
ticket.

**Fix options**:
- Have `zana_ticket_claim` accept an optional `agentName` arg and
  record it on `assigneeName`.
- Or thread Claude Code's subagent name through the MCP transport
  automatically so the daemon sees who's claiming.

**Repro**: end of every sprint — every ticket says assignee `Agent`,
not e.g. `worker-4`.

**Fix landed**: `zana_ticket_claim` now accepts an optional `agentName` arg in its schema; the handler forwards it to `ticket_claim` (overriding the `ZANA_AGENT_NAME` env when provided), so spawns that pass their own name (e.g. `wave1-fixer`, `worker-4`) get recorded on `assigneeName` instead of the generic `Agent`. Workers should pass `agentName` in the claim call to get correct attribution.

---

## 9. CLAUDE.md context sprawl — orchestration prompts are large ⏳

**Severity**: low (maintenance)

Three skills (`zana:zana`, `zana:council`, `zana:council-arch`) each
embed multi-page instructions that overlap heavily. When all three
fire in a session, the system-prompt context gets very large. CLAUDE.md
itself is 3+ KB.

Not necessarily a bug; flag for a "skill consolidation" pass once the
council/orchestration patterns stabilize.

**Deferred**: this is a multi-skill refactor, not a focused fix. Track in a
follow-up sprint dedicated to skill consolidation (council + council-arch
share ~70% of their bodies and could be parameterized; CLAUDE.md
"Agent comms — SendMessage-first" duplicates the orchestration skill's
spawn-pattern guidance). Out of scope for this dogfooding pass.

---

## Verification artifacts

- All issues observed during sprint `7249baf6-1630-4144-b085-e7225c04e4bf`
  (`Post-Review Cleanup — 2026-06-04`).
- 1900 / 1900 tests pass post-sprint, so none of these block correctness;
  they're UX / orchestration / traceability gaps.

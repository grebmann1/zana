# Review-pipeline false-`rework` bug — investigation + fix plan

Status: **IMPLEMENTED & GREEN** (full monorepo sweep: 4192 passed / 3 skipped /
7 todo). Approved scope for defect #1 was INCONCLUSIVE + workRef. Cited line
numbers are as of the investigation on this branch.

> Coordination note: a peer agent on this same working tree extracted
> `@zana-ai/contracts` concurrently. By agreement it commits its
> contracts-extraction set first (new package + all import repoints); my logic
> changes (the files listed below) commit separately. The `@zana-ai/contracts`
> import lines now present in my touched files are the peer's and are kept
> intentionally — do not revert them to `../project/workspace-context`.

## What actually happens (confirmed against source)

The incident report is from observed symptoms. Three things differ from its
write-up — corrections noted inline.

### Defect #1 — the reviewer is branch/worktree-blind (ROOT CAUSE — confirmed, with a correction)

- The "review daemon" is the **ticket-watcher**:
  `packages/work/src/tickets/watcher.ts`. It is bus-driven (`TICKET_EVENTS`,
  `watcher.ts:63-72`), not a polling daemon.
- On `status:review / reviewPhase:qa` it spawns the **`code-reviewer`** profile
  (`watcher.ts:260-262`), and on the architecture phase the **`architect`**
  profile (`watcher.ts:270-272`). The spawn runs in the workspace root:
  `dispatch.ts:74` `const cwd = getWorkspaceFn ? getWorkspaceFn() : process.env.HOME`.
- **Correction to the report:** the watcher itself runs *no* git/grep/find/ls.
  The spawned `code-reviewer` agent does, via its `Bash`/`Grep`/`Glob` tools
  (`profiles/code-reviewer.json:9,11`, system prompt: *"Use git diff and
  surrounding files… Use Bash for git, ls, grep"*). That agent inspects only
  **HEAD of the checked-out tree** — it has no branch/worktree hint, so when the
  work is on another branch/worktree it finds nothing and (per its prompt at
  `watcher.ts:262`) emits `VERDICT: FAIL`.
- The ticket schema has **no** `branch`/`commit`/`worktree` field
  (`db.ts:43-65`, `service.ts:105-126`) — nothing tells the reviewer where the
  work landed.
- **`INCONCLUSIVE` does not exist.** Verdicts are exactly
  `["PASS","FAIL","READY","BLOCKED"]` (`service.ts:530`, tool enum
  `tickets.ts:177`, parser regex `watcher.ts:663,672`). A reviewer's only way to
  express "I found nothing" is a confident `FAIL`, which
  `applyParsedVerdict` (`watcher.ts:768-770`) turns into `updateStatus("rework")`.

### Defect #2 — incoherent headless-agent / daemon permissions (confirmed, with a correction)

- Worker profiles are spawned with `--allowed-tools <profile.allowedTools>`
  (`spawner.ts:143-145`). Confirmed: `full-auto-coder` and `backend-dev`
  allowlists contain **no `mcp__zana__*` tools** (`full-auto-coder.json:10`,
  `backend-dev.json`). Yet every worker is injected with the zana MCP server
  (`spawner.ts:155-165`) **and** told to call `zana_ticket_claim` /
  `_complete` / `_update_status` / `_comment` (`spawner.ts:53-64`). So the
  preamble instructs tools the allowlist forbids → the worker falls back to
  whatever it *can* call, misattributing the audit trail. **Confirmed.**
- **Correction to the report (daemon side):** the watcher persists verdicts
  **in-process**, not via MCP. `ticket:verdict` → `service.recordVerdict`
  (`service.ts:531-546`) and the transition runs through `applyParsedVerdict`
  calling `ticketService.updateStatus` directly (`watcher.ts:768-784`). There is
  no MCP permission on this path, so "daemon couldn't persist its verdict yet the
  transition still landed" is really: *the spawned reviewer agent* couldn't call
  `zana_ticket_verdict` (not in `code-reviewer.allowedTools` —
  `code-reviewer.json:11`), so it fell back to the **text `VERDICT:` line**,
  which the watcher parsed on `agent:terminated` (`watcher.ts:158-186,701`) and
  applied in-process. The asymmetry is real; the mechanism is the worker
  allowlist, not a daemon MCP gate. (`zana_ticket_verdict/_complete/_claim` are
  **not** daemon-gated — verified against `gating.ts`.)

### Defect #3 — no reconciliation path out of a wrong review (confirmed)

- Transition table (`service.ts:49-57`): `rework → {in-progress, blocked,
  cancelled}` only. So a wrongly-failed ticket's only forward route is
  `rework → in-progress → review → …`, re-entering the same blind reviewer →
  false-fail loop. Backstop is `MAX_REWORK_CYCLES = 3` →
  `markBlocked` (`watcher.ts:549-552,787-806`): tickets end **blocked**, never
  `done`.
- `completeTicket` (`service.ts:304-319`) **already bypasses** the state table
  (pinned by `service-complete-transition-bypass.test.ts`) but accepts only
  `resultSummary` — it records **no** branch/commit/test evidence, and there is
  no attestation/override transition that carries proof.

## Fix plan (implement in order: #1 → #3 → #2)

### Defect #1 — make the reviewer admit uncertainty + give it a target

Two coordinated changes, smallest-blast-radius first:

1. **Add `INCONCLUSIVE` as a first-class verdict.**
   - `service.ts:530` `VALID_VERDICTS` += `"INCONCLUSIVE"`.
   - `tickets.ts:177` enum += `"INCONCLUSIVE"`; update the `zana_ticket_verdict`
     description (`tickets.ts:170`).
   - Parser: `watcher.ts:663,672` regex add `INCONCLUSIVE` alternative.
   - `applyParsedVerdict` (`watcher.ts:722-785`): on `INCONCLUSIVE`, **do not
     transition**. Add an audit comment (reuse the existing `addComment` block at
     `watcher.ts:753-758`) and leave the ticket in `review`. Mirror the existing
     guard style — `INCONCLUSIVE` is not `PASS_OR_FAIL`, so the `current.status
     !== "review"` early-returns at `watcher.ts:741-748` already leave it alone;
     just add an explicit `INCONCLUSIVE` branch that comments + returns.
2. **Record where the work landed, and steer the reviewer to it.**
   - Add an optional `workRef` field to the ticket (`{ branch?, commitRange?,
     worktree? }`) — additive column on `tickets` (`db.ts:43-65` CREATE,
     `_saveTicket` `db.ts:150-189`, `rowToTicket` `db.ts:90-100`,
     migration insert `migration.ts:81-125`). Additive TEXT(JSON) column, default
     null; back-compat safe (the table is `CREATE TABLE IF NOT EXISTS`, so add an
     idempotent `ALTER TABLE ADD COLUMN` in `migrateSchemaIfNeeded`,
     `migration.ts:149`).
   - Accept it on the worker's `review` handoff: `zana_ticket_update` already
     takes free-form progress; add `workRef` passthrough
     (`tickets.ts:142-166` schema, `tickets.ts:264-275` handler,
     `dispatch.ts:234-282` `ticket_update`). The `auto-implement` prompt
     (`watcher.ts:257`) is updated to ask the worker to pass `branch`/`commit`.
   - Reviewer prompts (`watcher.ts:262,272`) gain: *"The implementation may be on
     a branch/worktree other than HEAD: {{workRef}}. If you cannot locate the
     work on the inspected tree, record `INCONCLUSIVE` (not FAIL)."* `workRef` is
     surfaced through the template context (`template-context.ts`).

   Decision needed: scope of #1.2. Minimum viable is `INCONCLUSIVE` + prompt
   guidance (no schema change). The `workRef` column is the durable fix. Plan
   assumes **both**; can drop to INCONCLUSIVE-only if you want a smaller change.

### Defect #3 — authorized attestation/override to `done`

- Extend `completeTicket` (`service.ts:304-319`) to accept optional
  `evidence: { branch?, commitRange?, testResult?, attestedBy? }`, persist it
  (store on the ticket / in `resultSummary` structured block + a dedicated
  `completed` audit entry detail — `service.ts:315`), and emit it on
  `ticket:completed` (`service.ts:317`). Keeps the existing forced-terminal
  bypass (already covered by `service-complete-transition-bypass.test.ts`).
- Surface via `zana_ticket_complete` (`tickets.ts:112-122` schema +
  `tickets.ts:289-305` handler + `dispatch.ts:220-222`): add optional `evidence`.
- This gives an orchestrator a *legitimate* "verified-done on branch X, here is
  the proof" path that doesn't re-enter the blind reviewer and doesn't need the
  bulk-set guard to be loosened.

### Defect #2 — coherent headless/worker permissions

- Add the ticket-lifecycle MCP tools the preamble already demands to the worker
  profiles' allowlists: `full-auto-coder.json`, `backend-dev.json`, and the other
  implementer/reviewer profiles. Concretely add
  `mcp__zana__zana_ticket_claim`, `_complete`, `_update_status`, `_comment`,
  `_get`, `_update`; add `_verdict` to `code-reviewer.json:11` and
  `architect.json` (reviewers). (Orchestrator profiles already have
  `mcp__zana__*`.)
- Rationale to encode: if a profile is told to drive `claim → review → verdict`,
  its allowlist must contain those tools. Align the preamble
  (`spawner.ts:53-64`) and the allowlists so instruction ⊇ capability.

## Test strategy (regression tests, mirroring existing style)

All use the established `vi.mock("@zana-ai/work/src/tickets/db.ts")` +
stub-service pattern (see `service-status-transitions.test.ts`,
`watcher-apply-verdict-fail.test.ts`, `service-record-verdict.test.ts`). No real
Claude / SQLite / spawns.

1. **Reviewer not-found ⇒ not a false FAIL** (`watcher-apply-verdict-inconclusive.test.ts`,
   new): emit `agent:terminated` with `VERDICT: INCONCLUSIVE — not found on
   inspected tree`; assert ticket **stays `review`**, no `updateStatus("rework")`,
   an audit comment is added. Sibling: `service.recordVerdict` accepts
   `INCONCLUSIVE` and emits it (extend `service-record-verdict.test.ts`).
2. **Attestation transition** (`service-complete-with-evidence.test.ts`, new):
   `completeTicket` with `evidence` → status `done`, evidence persisted + on the
   `completed` audit entry; confirm it still bypasses the table from `rework`.
3. **Permissions** (`spawner-ticket-lifecycle-allowlist.test.ts`, new under
   `packages/core/test/agents/`): for implementer/reviewer profiles, every
   `mcp__zana__zana_ticket_*` tool named in `ticketLifecyclePreamble` is present
   in `profile.allowedTools` (or covered by an `mcp__zana__*` wildcard) — a
   static invariant test so the preamble and allowlists can't drift apart again.

## Build/verify

`npm run -w @zana-ai/work build && npm run -w @zana-ai/core build &&
npm run -w @zana-ai/mcp build`, then `npx vitest run` in each touched package,
then `npm test` full sweep before commit. Update `docs/MCP-TOOL-REFERENCE.md`
via `npm run docs:mcp-ref` if the verdict enum / tool schemas change.

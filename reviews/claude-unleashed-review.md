# Code Review — `claude-unleashed`

**Repo:** `https://git.soma.salesforce.com/cc-oms/claude-unleashed` (HEAD `e08cab6`)
**Reviewed:** 2026-06-12 · read-only shallow clone
**Method:** Zana native multi-agent fan-out (`/zana:zana`) — a recon scout mapped the repo, then
three specialist reviewers (architecture, feature inventory, integrations) ran in parallel; an
orchestrator synthesized this report and spot-checked the top claims against source.
**Scope:** Architecture + feature/capability inventory, with integrations (Slack, GUS CDC, MCP,
scheduler) as the deep-dive emphasis. Survey + hotspots — **not** an exhaustive line audit.
Security and performance were out of scope for this pass.

> Provenance note: every file/line reference is under the clone at `/tmp/cu-review/` (now
> removed). The highest-stakes claims were re-verified directly against source — see
> **Verification** at the end.

---

## 1. Executive summary

`claude-unleashed` is an autonomous-agent orchestration platform that launches and supervises
**Claude Code sessions** as long-running background jobs on a developer's Mac. A Node **daemon**
owns all state (SQLite) and lifecycle; a SwiftUI **menu-bar app**, a `cu` **CLI** (~111
subcommands), **Slack**, and two **MCP servers** are all thin clients of that daemon over a Unix
domain socket. The core abstraction is the **Session** — one agent turn (plan → execute →
review) in an isolated git worktree — composed upward into Workflows (DAGs), Swarms
(parameterized fan-out), and Schedules (cron).

**Overall verdict: Solid, well-engineered for its size.** Clean one-directional package
layering with a true leaf `core`, zero circular deps, serious SQLite migration discipline,
event-sourced crash recovery, and unusually candid ADRs/post-mortems that document past
incidents (with dollar costs). The integrations are thoughtfully hardened against *failure*
(circuit breakers, backoff, dedup, budget caps everywhere).

**Where it's weakest:**
1. **Concentration.** The daemon is a 230K-LOC package whose hottest files have grown into
   multi-thousand-line god-files — `daemon-main.ts` (6,505 LOC, one ~5,600-line boot function),
   `session-runner.ts` (3,119), `routes/sessions.ts` (2,848).
2. **No explicit session state machine.** ~10 statuses, transition legality enforced implicitly
   across stores + the reaper filter; this already caused a real ~$88 data-loss incident
   (ADR 0027).
3. **No authentication between components.** Every integration collapses its trust boundary onto
   same-UID access to the daemon's UDS + the operator's own credentials. Defensible for a
   single-user laptop, but two concrete sharp edges (below) deserve attention.

**Top things to act on** (detail in §5):
- `/_internal/mcp/*` approval routes don't enforce the `isInternalDispatch` guard that two other
  route families use → same-UID cross-session approval forgery.
- `request_approval` with no `timeoutSeconds` blocks a worker indefinitely and is unrecoverable
  across a daemon restart.
- Slack approvals round-trip via **thread text**, not buttons/reactions — the interactive path
  was built then deliberately disconnected (doc/expectation drift).

---

## 2. Architecture

**Verdict: Solid** (would be Strong with the daemon hotspots decomposed and an explicit
state-machine guard).

### Structure & boundaries
- Layering is clean and one-directional: `packages/core` is a true leaf (deps **only** `yaml` +
  `zod`, no sibling imports); `daemon → core`; `cli → daemon` and `apps/macos → daemon`
  **exclusively over HTTP-over-UDS**, not code. No circular deps. (CLI's few daemon imports are
  types/test-helpers, not runtime.)
- "Everything is a client of one sidecar" is the load-bearing contract (ADR 0003/0004). The Mac
  app hand-rolls a minimal HTTP/1.1-over-UDS client (`apps/macos/.../Transport.swift:27`) rather
  than sharing TS — the small HTTP surface is the only coupling, which is the right seam.
- The 230K daemon LOC concentrates in `http/` (~54K), `runtime/` (~31K), `slack/` (~22K),
  `workspaces/` (~22K). It's a god-*package*, not a god-*module* — internally well-foldered
  (`recovery/`, `overseer/`, `storage/`, `workflows/`). Slack is properly isolated behind an
  injected `SlackRoutesDeps` interface and not imported by the runtime.
- HTTP routes are ad-hoc per-file (Fastify + Zod), no shared middleware abstraction — tolerable,
  but it's why `routes/sessions.ts` reached 2,848 LOC.

### Lifecycle core
- Coherent Unix mechanism: pause = `SIGSTOP` to the worker's process group, resume = `SIGCONT`
  (`session-runner.ts:2144-2167`); workers spawned `detached:true` so kills hit the whole tree
  (`runtime/worker-launcher.ts:573-585`). `LimitEnforcer` correctly accounts for paused
  wall-clock.
- **No central transition guard.** Status legality is enforced only by SQLite CHECK constraints
  on the *value set*, not on *legal transitions* — there is no `canTransition(from,to)`. The
  system leans on event-sourced reconciliation (`reconcileFromEvents()`,
  `recovery/session-reconciler.ts:102`) as a backstop. Robust, but an illegal direct write isn't
  prevented at the source.
- **Pause/resume vs. the orphan reaper was the worst historical race** (ADR 0027): a
  cap-exceeded session parked as `paused` had a dead pid by design; the 30s `OrphanReaper`
  overwrote it to terminal `orphaned`, destroying ~$88 of resumable work across 9 sessions.
  Fixed two ways (reaper narrowed to `running`-only; cap-exceeded now terminates as
  `completed`+violation metadata) and regression-locked — but it illustrates the latent risk of
  pid-liveness sweeps racing intentional-dead-pid states.
- **In-place (branch) queue has a documented durability gap** (`runtime/in-place-queue.ts`):
  state is in-memory; across a restart, `queued` in-place sessions are restored for
  visibility/ordering only and are **not auto-redispatched** ("Cut 1 limitation"). A restart
  silently strands queued branch-mode work until manual action.
- Boot recovery is well-factored: a pure synchronous classifier `classifyBootRecovery()`
  (`lifecycle/boot-session-recovery.ts`) emits candidates with no I/O; side-effecting stages act
  later — good testability seam.

### Persistence
- Strong discipline. ~77 forward-only migrations, lexically ordered, each applied in its own
  transaction and recorded in `schema_migrations` (`storage/migrate.ts`). Policy codified in
  ADR 0029 (additive-by-default, 3-release deprecation window, one-minor-each-way client compat).
- Status-set changes use SQLite's full table-rebuild dance (`sessions_new` → copy → drop →
  rename) with `foreign_keys=OFF` during migration — the canonical pattern for CHECK changes.
- The `previousNames` re-stamp mechanism (`migrate.ts:38-50`) cleanly handles a bad-merge
  renumber without re-running non-idempotent DDL — a thoughtful answer to a common footgun.
- Backfills run as idempotent every-boot scans rather than in-migration (ADR 0029 §5) — right
  call for boot determinism.

### Extensibility
- Profiles/agents/workflows are uniform YAML + per-resource `fs-loader.ts`, parsed by `core`
  schemas, with two-tier resolution (per-repo `.claude-unleashed/` then user-global
  `~/.claude-unleashed/`). Easy to extend by dropping a file; CRUD also over HTTP.
- **Load-once at boot, no filesystem watcher** — YAML edits need a daemon reload, not hot-reload.
  A sharp edge for authors.
- Sessions compose cleanly upward: Session → Workflow (level-parallel topological DAG,
  `workflows/executor.ts:405`) → Swarm → Schedule, with injected resolver deps — a good seam for
  new node types.

---

## 3. Feature inventory

Authoritative command list: `.claude-plugin/plugins/cu-cli/skills/cu-cli/reference/cli-full.md`;
the CLI registers 49 top-level command objects (`packages/cli/src/main.ts`) expanding to ~111
subcommands.

| Feature | What it does | Where it lives | Invoked via | Maturity |
|---|---|---|---|---|
| **Sessions (`cu run`)** | Launch a Claude session as a background job (`--profile/--agent/--agent-group/--model/--effort/--max-turns/--permission-mode/--repo/--sfw/--multiturn`) | `cli/src/commands/run.ts`, `daemon/src/runtime/` | CLI, app, Slack | **GA** (README "sweet spot") |
| **Worktree / branch / in-place mode** | Isolated git worktree per session; `--run-mode worktree\|branch`; in-place serialized per-repo | `daemon/src/runtime/{worktree-protection,in-place-queue,worker-launcher}.ts` | `cu run`/`workflow run` | **GA** |
| **Session lifecycle mgmt** | ls/get/kill/cancel/rm/prune/pause/resume/unstick/vitals/export + bulk kill-all/pause-all/resume-all/ask-all; continue/tail | `cli/src/commands/{sessions,continue,tail}.ts` | CLI | **GA** |
| **Session monitor** | Block until terminal state; exit-code semantics, `--json/--progress/--reconnect` | `cli/src/commands/watch.ts` | `cu watch` | **GA** |
| **Workflows (DAG)** | Multi-node YAML pipelines, `$input.*`/`$nodes.*` placeholders; run/resume/rescue/hint/ask/build | `daemon/src/workflows/{executor,fs-loader}.ts`, `cli/src/commands/workflow.ts` | `cu workflow` | **GA** (less polished than sessions) |
| **Agents** | executor/planner/reviewer built-ins + archetypes; custom YAML w/ systemPrompt, tool allowlist, caps | `daemon/src/agents/{fs-loader,archetype-fs-loader}.ts` | `cu agents …`, `--agent` | **GA** |
| **Agent-groups** | Bundle subagents under one name w/ a coordinator (+ built-in `il-*` innerloop group) | `daemon/src/agents/{group-fs-loader,builtin-agent-groups}.ts` | `cu agent-groups …`, `--agent-group` | **GA** |
| **Profiles** | Reusable launch defaults (model+tools+caps+permission-mode+repo) | `daemon/src/profiles/fs-loader.ts` | `cu profiles …`, `cu repos set-profile` | **GA** |
| **Repos** | Register/rescan repos, attach default profile | `cli/src/commands/repos.ts` | `cu repos …` | **GA** |
| **Schedules (cron)** | Cron-triggered run/workflow w/ binding + `requireHuman`; ~15 subcommands | `daemon/src/schedules/`, `cli/src/commands/schedules.ts` | `cu schedules …` | **GA** |
| **GUS CDC** | Pub/Sub subscriptions auto-launch sessions/workflows on work-item changes | `daemon/src/gus-cdc/` (13 test files), `cli/src/commands/gus-cdc.ts` | `cu gus-cdc …` | **GA** |
| **Swarms** | Reusable parameterized fan-out blocks (forEach/when); **author-time only — no `cu swarm run`** | `daemon/src/swarms/`, `cli/src/commands/swarm.ts` | `cu swarm list/show/validate/create/save` | **beta** |
| **Multi-session orchestration** | Issue→fix→PR→release fan-out — **a playbook/skill over `cu run`/`watch`, not a runtime** | skill `cu-multi-session-orchestration`, wiki 16 | agent/CLI | **GA** (playbook) |
| **Overseer** | Always-on supervisor: stall/stuck detection, turn auto-extension (+50), auto-unstick, auto-unorphan, auto-approval cascade, build-loop detection. **Disabled by default** | `daemon/src/overseer/` | `cu overseer …`, `overseer.enabled` | **GA** |
| **Approvals** | Human-in-loop gating w/ structured choices | `daemon/src/{approvals,human}/`, `cli/src/commands/approvals.ts` | CLI / Slack / app | **GA** |
| **Post-mortem** | Auto `post-mortem.md` per session ("nice-to-have, non-fatal") | `daemon/src/postmortem/generate.ts` | `cu sessions post-mortem` | **beta** |
| **Anomaly detection** | Flags anomalous sessions (cost/turns/errors) | `daemon/src/http/routes/anomalies.ts`, `cli/src/commands/anomalies.ts` | `cu anomalies recent` | **beta** |
| **Salesforce Workspaces (`sfworkctl`)** | Provision/lease/warm/health SF dev workspaces; run sessions inside via `--sfw`; **unattended safety gate** | `daemon/src/workspaces/` | `cu workspaces …`, `cu run --sfw` | **beta** |
| **Recipes / examples** | Package & share profiles+agents+workflows+schedules+CDC as installable recipes; **security export gate** | `daemon/src/recipes/`, `cli/src/commands/recipe.ts`, `examples/` (13) | `cu recipe …` (~24 subs) | **GA** |
| **Slack integration** | Launch/monitor/approve from Slack; OAuth, Block Kit, meta-agent bridge, notifier, stuck-detector | `daemon/src/slack/` (~40 modules), `cli/src/commands/slack.ts` | `cu slack …`, Slack app | **GA** |
| **Mac app** | SwiftUI Command Center + 28-section Setup shell (⌘1/⌘2) | `apps/macos/` (566 Swift files) | app | **GA** |
| **Prompts / polish** | Saved prompt snippets + LLM prompt-polishing | `cli/src/commands/{prompts,prompt}.ts` | `cu prompts …`, `cu prompt polish` | **GA** |
| **Dashboard / report** | Live dashboard; weekly cost/turns rollup | `cli/src/commands/{dashboard,report}.ts` | `cu dashboard`, `cu report` | **GA** |
| **MCP servers** | `cu_*` tools exposed to Claude Code (meta + supervisor) | `packages/mcp-meta/`, `packages/mcp-supervisor/` | MCP (auto-registered) | **GA** |

**CLI command groups** (~49 top-level → ~111 subs): session lifecycle (`run`, `continue`,
`tail`, `watch`, `sessions`, `merge`); workflows; orchestration assets (`profiles`, `agents`,
`agent-groups`, `archetypes`, `swarm`, `repos`); automation triggers (`schedules`, `gus-cdc`);
supervision/HITL (`overseer`, `approvals`, `anomalies`); Salesforce Workspaces; sharing
(`recipe`, `prompts`/`prompt`); integrations/UI (`slack`, `app`, `dashboard`, `report`); daemon &
ops (`daemon`, `config`, `plugins`, `skills`, `diagnostics`, `doctor`, `onboarding`, `setup`,
`auth`, `update`, `caffeinate`, `wake`, `git`, `actions`, `models`, `schemas`, `permissions`,
`retention`, `version`).

### Doc/code gaps & corrections to the initial map
- **There is no "Slack skill."** Slack is a large daemon subsystem + `cu slack` command +
  `docs/wiki/05-slack.md`, but no `cu-slack` skill exists under `.claude-plugin/`.
- **Two shipped skills are easy to miss:** `cu-swarm-authoring` and `recipe-export-review` (both
  map to real code).
- **Swarms are author-time only** — deliberately no `cu swarm run` (`docs/wiki/17-swarms.md`); a
  swarm activates only when referenced by `swarm: <name>` from a profile or workflow node.
- **"Multi-session orchestration" is a playbook, not a first-class runtime** — no orchestrator
  command; it's a skill driving `cu run`/`cu watch`.
- **Production skills live in a separate repo** (`c360-ai-tooling/claude-unleashed-skill` per
  README) — the in-tree `skills/` bundle is distinct and couldn't be verified identical.

---

## 4. Integrations deep-dive (emphasis area)

> Cross-cutting up front: all four integrations collapse their trust boundary onto a single
> OS-level primitive — the daemon's UDS (`ipc/uds.ts:6`, parent dir `mode 0700`) + the macOS
> Keychain. There is **no in-band authentication on any internal channel**. Intentional ("local
> user owns the daemon"), but it is the load-bearing assumption the whole product rests on.

### Slack
- **Login** is a three-process PKCE dance: `cu slack login` → daemon `POST /slack/login/start`
  (mints verifier/challenge/state, caches verifier **in-memory**, 10-min TTL) → **the CLI** binds
  the localhost callback on **port 3118** (not the daemon) → Slack redirects → CLI checks `state`
  (CSRF) → POSTs `{code,state}` to `/slack/oauth/callback` → daemon exchanges, `auth.test`,
  persists token.
- **Inbound = long-poll, no Socket Mode / Events webhook.** `SlackPollers` runs `pollDm` /
  `pollChannel` / `pollThreads` on a timer, each through a filter chain `isOwn(ts)` →
  `SenderGate.check()` → `tryResolveAskApproval` → `hasBotPrefix`, then a `CommandDispatcher`
  (rigid verbs: run/ls/status/tail/cancel/approve/deny/hint) or `MetaAgentBridge` (free-form LLM).
- **Approvals round-trip via THREAD TEXT, not buttons/reactions.** The approval card
  (`block-kit-renderer.ts:457`) literally says *"reply `approve` / `deny` / `deny: <reason>` in
  this thread."* Block Kit buttons were removed — `block-kit-renderer.ts:745`: *"action_ids are no
  longer emitted because nothing dispatches on them."* An `interactive.ts` parser exists but **no
  daemon route invokes it.** ⚠ This contradicts ADR 0006's "Approve/Deny buttons" and the common
  mental model.
- **Auth/trust:** single-user, owner-scoped (`sender-gate.ts` — only `slack.authedUserId` may
  drive the daemon; all other senders dropped *silently*, audited ≤1/user/60s). Token is the
  **user token** (not bot) via PKCE with a public `client_id` and **no client secret**. Posts are
  attributed to the human user (no `chat:write.customize`), which is *why* owner-scoping is
  non-negotiable. At rest: Keychain, else AES-256-GCM file (key mode 0600).
- **Failure modes (well-handled):** proactive token refresh 30 min before expiry w/ in-flight
  dedup; auth-failure circuit breaker at 5 consecutive; 429 cooldown w/ jitter; network errors
  swallowed without tripping the breaker; per-thread (50) / per-conversation (100) reply budgets.
  **Restart gap:** in-memory `ownTs`/meta-threads/PKCE cache lost → documented orphan-meta-agent
  double-reply risk (ADR 0028, no orphan sweep); pending logins fail `unknown_state`.

### GUS CDC
- **Wiring:** `GUSCDCListener.start(orgAlias)` → `GUSPubSubClient` subscribes to a **single
  hardcoded topic** `/data/ADM_Work__ChangeEvent` (`pubsub-client.ts:33`). Flow: event →
  `enrichEvent` (SOQL backfill, since UPDATE events carry only changed columns) → per-subscription
  filter (`event-filter.ts`) → `dispatcher.dispatch` → `sessionRunner.create` **or**
  `workflowRunner.run`, then a history row.
- **Lifecycle:** listener auto-starts when the first subscription is enabled, stops when the last
  is disabled (frees the Pub/Sub slot).
- **No notify-only mode.** Every matched event **launches** (session or workflow). The only guard
  is `requireHuman`, which flips the spawned session out of headless so it blocks on
  approval — but a session is still spawned. The per-subscription filter is the *cost* boundary;
  `requireHuman` is the *approval* gate. Re-fires deduped by CDC `replayId`.
- **Auth/trust:** runs off the operator's own `sf` CLI session against the `gus`-aliased org
  (`sf-credentials.ts` shells `sf org display` + `org auth show-access-token`;
  `assertUsableToken` guards against `[REDACTED]`/non-`00D` tokens). **CU has the same org access
  the human has — no service principal.** Filtering is **client-side**: the whole org's
  `ADM_Work` change stream crosses the wire to the laptop, then is filtered locally.
- **Failure modes (robust):** auth-expiry → cred invalidation + reconnect, or `fatal-auth`
  breaker after 3 consecutive; transient gRPC → bounded exponential backoff (1s→60s);
  `replayIdExpired` → reset to LATEST (⚠ **silently drops events between stale id and reconnect** —
  no gap backfill); lag detector resets a wedged stream; `DISPATCH_TIMEOUT_MS` 30 min.
  **Restart:** `lastReplayId` persisted → missed events **replay** (most durable of the four).

### MCP
- **Two stdio JSON-RPC servers**, each fronting the daemon over the UDS.
  - **mcp-supervisor** (in-worker): registers **five** tools (not three) — `report_progress`,
    `emit_event`, `request_approval`, `permission_prompt`, `request_choice`
    (`mcp-supervisor/src/server.ts:14-115`). Spawned by `supervisor-launcher.ts:153-186`;
    `writeMcpConfigs` writes `<sessionDir>/mcp-config.json` the Claude CLI loads.
  - **mcp-meta** (daemon introspection): read tools (`sessions_list/get/post_mortem/todos`,
    `anomalies_recent`, `dashboard_snapshot`, `approvals_list`, `repos_list`, `workspaces_*`) +
    **write** tools (`sessions_create/cancel/hint`, `workflows_run`, `approvals_approve/deny`).
- **Approval round-trip:** worker `request_approval` → supervisor POSTs
  `/_internal/mcp/request-approval` (**sessionId injected client-side from the launch flag**) →
  daemon mints id, emits `approval-requested` SessionEvent (fans out to Slack/CLI/app), then
  **blocks** holding the HTTP response open; the resolver is stashed in an **in-memory `pending`
  Map** (`human/cli-transport.ts:71-108`). Operator resolves via public `POST
  /approvals/:id/approve|deny` → resolver settles → worker unblocks.
- **Auth/trust:** **none beyond UDS file permissions.** No token or per-session secret; the
  supervisor's only "credential" is the sessionId UUID it echoes. The meta server calls the
  *public* REST routes with no auth header — the same routes `cu` uses.
- **Failure modes:** restart while a worker is blocked → `pending` Map lost → worker's open
  request severed → MCP returns a JSON-RPC error (not a clean deny); the SQLite approval row is
  orphaned in `pending` forever. `request_approval` **with no `timeoutSeconds` blocks
  indefinitely**; `request_choice`/`permission_prompt` reject at 5 min.

### Scheduler
- **Wiring:** `ScheduleTicker` runs every 30s (timer `unref`'d) with a synchronous boot
  catch-up; each `tick()` → `store.dueTasks(now)` → `fireOne` **recomputes `next_run_at` first**
  (so it can't re-fire) **then** `executor.fire` fire-and-forget → always writes a
  `scheduled_task_history` row.
- **Overlap:** if the prior `last_session_id` is still `running`/`paused`, the fire is recorded
  `skipped` (`prev-run-still-active`). **Missed runs:** one stale `next_run_at` in the past →
  **fires exactly once**, then advances (ADR 0025 — "a cron that missed 7 daily runs doesn't fire
  7 times"). A property of storing a single `next_run_at`, not explicit dedup.
- **Auth/trust:** daemon-local SQLite; boundary is whoever reaches `/schedules` over the UDS.
  Headless safety: `headless = require_human === 0` — a headless scheduled run auto-denies
  approval gates rather than blocking forever.
- **Failure modes:** boot-error **circuit breaker** auto-disables a schedule after 3 consecutive
  session-boot failures (runtime failures deliberately don't feed it); `PostCompletionChecker`
  retroactively downgrades "success" → "degraded" when the first ≥3 tool calls all error.
  **Restart:** `next_run_at` survives; a fire mid-`launch()` at a hard restart leaves no history
  trace.

---

## 5. Hotspots & recommendations (prioritized)

| # | Finding | Severity | Where | Recommendation |
|---|---|---|---|---|
| 1 | `/_internal/mcp/*` approval routes don't enforce the `isInternalDispatch` guard that `workflows.ts:994` and `sessions.ts:1461` use → any same-UID process can forge/resolve approvals for an arbitrary session UUID, or create/cancel sessions via the meta surface | **High** (within single-user threat model) | `daemon/src/http/routes/approvals.ts` | Add the `isInternalDispatch` check to the `/_internal/mcp/*` routes; treat `resolvedBy` as untrusted until then |
| 2 | `request_approval` with no `timeoutSeconds` blocks a worker indefinitely; unrecoverable across daemon restart (in-memory `pending` Map lost, approval row orphaned) | **High** | `daemon/src/human/cli-transport.ts:36-42,71-108` | Default a sane server-side timeout; on boot, fail or re-emit orphaned `pending` approvals instead of leaving them unresolvable |
| 3 | Slack approvals are thread-text only; the interactive button/reaction path was built then disconnected — drift from ADR 0006 and operator expectation | **Medium** (UX/doc) | `slack/block-kit-renderer.ts:457,745`; `slack/interactive.ts` (orphaned) | Either wire the interactive POST route back up or update ADR 0006 + docs to declare text-reply the supported path |
| 4 | `daemon-main.ts` = 6,505 LOC with a single ~5,600-line `daemonMain()` boot function; all subsystem wiring + boot-ordering lives in one place | **Medium** (maintainability) | `daemon/src/lifecycle/daemon-main.ts` | Highest-leverage refactor: extract per-subsystem boot modules behind a small registration interface |
| 5 | No explicit session state-machine; ~10 statuses, transition legality implicit across stores + reaper filter (root of the ADR 0027 $88 data-loss incident) | **Medium** | `session-store.ts`, `session-registry.ts`, `recovery/orphan-candidate-filter.ts` | Add a `transitions.ts` `canTransition(from,to)` guard at the single write path |
| 6 | In-place (branch-mode) queue is in-memory; queued sessions are **not auto-redispatched** after a restart — work silently stranded | **Medium** | `daemon/src/runtime/in-place-queue.ts` | Persist queue state; auto-redispatch (or loudly surface) stranded queued sessions on boot |
| 7 | GUS CDC `replayIdExpired` resets to LATEST with no gap backfill → events in the gap are silently dropped | **Low-Medium** | `daemon/src/gus-cdc/listener.ts` | Document the at-least-once-with-gaps guarantee; consider a bounded backfill query for critical subscriptions |
| 8 | `session-runner.ts` (3,119) and `routes/sessions.ts` (2,848) are god-files thick with issue-number-tagged special cases | **Low-Medium** | as cited | Extract the resume/recovery sub-machine; group the HTTP handlers |
| 9 | Enrichment-on-partial-data fallback can let an UPDATE match a filter on a field the event didn't carry | **Low** | `daemon/src/gus-cdc/listener.ts` (~820) | Treat un-enriched filter fields as non-matches, or hard-require enrichment before filtering |
| 10 | Meta-tool `tier: read\|write\|destructive` metadata is documentation only, not enforced | **Low** | `mcp-meta/src/tools/` | Enforce tier as a capability gate if the meta surface is ever exposed beyond same-UID |

**Strengths worth preserving** (don't regress these in refactors):
- ADR-driven, brutally honest post-mortem culture (ADR 0027 names victim sessions + dollar cost +
  the exact buggy line).
- Supervisor/worker split (ADR 0001) giving per-worker SIGKILL isolation while keeping approvals
  first-class.
- Event-sourced recovery (`reconcileFromEvents`) as the crash backstop.
- Migration policy as a written contract (ADR 0029) with the `previousNames` merge-tolerance
  mechanism.
- Uniformly thoughtful failure handling in integrations (breakers, backoff, dedup, budgets).

---

## 6. Open questions

- **Production skills repo** (`c360-ai-tooling/claude-unleashed-skill`) is external — are the
  in-tree `skills/` and the published `cu-*` skills kept in sync, and which is canonical?
- **Threat model intent:** is the same-UID-trusts-everything posture a deliberate, documented
  boundary, or has it drifted? Findings 1–2 matter a lot more if a multi-user or remote-daemon
  future is on the roadmap.
- **In-place queue durability** (finding 6): is auto-redispatch intentionally deferred, or just
  not yet built ("Cut 1 limitation")?
- Security and performance were **out of scope** for this pass — a dedicated security review of
  the UDS trust boundary, secret handling, and the OAuth/PKCE flows is the natural next step.

---

*Generated by a Zana native review team (`/zana:zana`): recon scout (Explore) → architect +
feature-mapper + integrations reviewers (parallel fan-out, profile-driven) → orchestrator
synthesis. Top claims spot-checked against source — see Verification below.*

## Verification (provenance spot-checks)

Re-confirmed directly against the clone before publishing:
- `isInternalDispatch` **absent** in `routes/approvals.ts`, **present** at `workflows.ts:994` and
  `sessions.ts:1461` → finding #1 holds.
- Slack thread-text approval string at `block-kit-renderer.ts:457`; "nothing dispatches on them"
  at `:745` → finding #3 holds.
- GUS CDC single hardcoded topic `/data/ADM_Work__ChangeEvent` at `pubsub-client.ts:33` → holds.
- File sizes exact: `daemon-main.ts` 6,505 · `session-runner.ts` 3,119 · `routes/sessions.ts`
  2,848 LOC → findings #4/#8 hold.
- `packages/core` deps = `{yaml, zod}` only → leaf-package claim holds.

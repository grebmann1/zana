# Zana — Project Review

_Generated 2026-06-04 by a 5-reviewer native council (researcher, architect, security-reviewer, code-reviewer, docs-reviewer)._

## TL;DR

Zana's docs and external surface are in good shape post-pivot — the Vercel/RuntimeAdapter cleanup is complete, README is accurate, CLAUDE.md's MCP table is current, and every documented recipe has a smoke test. The internal health is weaker: `core` has structural cycles with `work` and `extras` that are being papered over by ~10 lazy-`require()` Proxy hacks (siblings of the abstraction `bfb50ca` just removed), the MCP surface is bloated to 91 tools (≈⅓ are daemon-only duplicates of native slash-command flows), and 14 source files exceed CLAUDE.md's 500-line cap (worst: `mcp-server.ts` at 1799). Top three risks: (1) plist XML injection in `service-manager.ts` (HIGH), (2) tickets DB silently sharing state across workspaces when uninitialized (HIGH — same shape as the CAS/deliberation bug class that already has gates), (3) the deprecated `config.ts` getters that the codebase still ships. Top three cleanup wins: (1) commit the 20 untracked test files (all genuine, none scratch), (2) split `manager.ts` (1389 LOC) and `mcp-server.ts` (1799 LOC), (3) gate or delete the daemon-only MCP tools that slash commands now subsume.

## Critical (fix before next release)

1. **Plist XML injection in `service install`**
   - Where: `packages/core/src/daemon/service-manager.ts:34-65`
   - Problem: `workspace` (defaults to `process.cwd()`) is interpolated into a launchd plist with no XML escaping. A workspace path containing `</string><string>...` or `]]>` could break out of `WorkingDirectory` and inject arbitrary `ProgramArguments` — persistent code execution as the user.
   - Fix: escape `&<>"'` in plist string contents, or build with a real plist library.
   - Effort: S
   - Reviewer: security-reviewer

2. **Tickets DB silently shares state across workspaces when uninitialized**
   - Where: `packages/work/src/tickets/db.ts:19-21` (and same shape: `plans-store.ts:19`, `tickets/migration.ts:8/15`, `tickets/store.ts:13/19`, `intelligence/task-router.ts:34`, `intelligence/vector-memory.ts:10`, `core/src/events/store.ts`)
   - Problem: When `workspaceContext.isInitialized()` is false, ticket writes land at `~/.zana/tickets.db`, mixing two workspaces' tickets. Same bug class the CAS/deliberation gates were added to prevent. CLAUDE.md only mandates the gate for CAS+deliberation, but if tickets are workspace-isolated by policy this is a tenant-isolation breach.
   - Fix: decide policy explicitly — either extend `WorkspaceNotInitializedError` to tickets/plans/task-router/vector-memory/events, or document the narrower scope in CLAUDE.md.
   - Effort: M (decision + ~7 call sites)
   - Reviewer: security-reviewer (also: architect)

3. **`packages/mcp/src/mcp-server.ts` is 1799 lines (3.6× the 500-line cap)**
   - Where: `packages/mcp/src/mcp-server.ts`
   - Problem: Worst single-file violation in the repo. Tool registration glue mixed with handler bodies; the per-domain tool implementations already live under `tools/`.
   - Fix: split into one registration file per domain (tickets, sprints, profiles, etc.); `mcp-server.ts` keeps only the server bootstrap.
   - Effort: M
   - Reviewer: researcher (also: architect)

## High priority

1. **`packages/core/src/agents/manager.ts` is a 1389-line god module**
   - Where: `packages/core/src/agents/manager.ts`
   - Problem: Owns agent lifecycle + ticket dispatch + scheduler glue + swarm dispatch + checkpoint resume + team start. Load-bearing reason `core` must depend on every sibling. Mixes `classifySpawnError` heuristics, probe-overload state, spawn args, and orchestrator-command dispatch.
   - Fix: split into `agents/lifecycle.ts`, `agents/dispatch.ts`, `agents/team-runtime.ts`; `manager.ts` becomes a thin facade.
   - Effort: L
   - Reviewer: researcher, architect, code-reviewer (all three flagged independently)

2. **Cross-package cycles: `core ↔ work ↔ extras`**
   - Where: `packages/core/src/core.ts`, `index.ts`, `agents/manager.ts`; `packages/work/src/tickets/watcher.ts`, `scheduling/service.ts`, `tickets/db.ts`; `packages/extras/src/plugins/loader.ts`
   - Problem: 3 cycles broken by ~10 `new Proxy({}, { get: (_, p) => require(...)[p] })` hacks (typed `any`). Sibling abstraction to the `RuntimeAdapter` that `bfb50ca` deleted. You cannot publish or test any one of `core/work/extras` without all three.
   - Fix: extract a thin `@zana-ai/contracts` (interfaces + types only) and invert the requires; or split `core` into `core-engine` (pure) + `core-facade` (re-exporter). At minimum, consolidate the 10 Proxy hacks into one `lazyRequire(pkg, path)` helper.
   - Effort: L
   - Reviewer: architect (also: code-reviewer)

3. **MCP tool surface bloat — 91 tools, ~25 are daemon-path duplicates of native slash flows**
   - Where: `packages/mcp/src/mcp-server.ts` and `packages/mcp/src/tools/*`
   - Problem: `zana_autopilot_*`, `zana_deliberate_*`, `zana_spawn_agent*`, `zana_kill_agent`, `zana_start_team`/`stop_team`/`team_status`/`list_running_teams` are explicitly told "do NOT call from this slash command" by `/zana:autopilot`, `/zana:council`, `/zana:team`. They're dead weight in the documented Claude Code path.
   - Fix: gate the daemon-only group behind `ZANA_DAEMON_TOOLS=1` (mirroring the `ZANA_MASTER_MODE` pattern that swarm uses). Cuts ~25 tools from the in-session surface.
   - Effort: S
   - Reviewer: architect

4. **`packages/core/src/config.ts:9-90` deprecated getters still exported**
   - Where: `packages/core/src/config.ts:9-90`
   - Problem: TICKETS_DIR, SPRINTS_DIR, ARTIFACTS_DIR, SESSIONS_DIR, EVENTS_DIR, RUNS_DIR, SCHEDULER_DIR, TMP_DIR getters proxy to workspace-context. Comment says "removed in a future sprint" — that sprint is now. CLAUDE.md mandates `getProjectPaths()` access only.
   - Fix: migrate remaining importers, delete the block.
   - Effort: M
   - Reviewer: code-reviewer

5. **Workspace-context invariant near-bypass in API server**
   - Where: `packages/server/src/api/server.ts:709`
   - Problem: `path.join(root, ".zana", "config.json")` directly. Every other call site funnels through `getProjectPaths()`.
   - Fix: add `configFile` to `getProjectPaths()` or use `workspaceContext.getWorkspaceRoot()` with a comment.
   - Effort: S
   - Reviewer: architect

6. **20 untracked test files (all genuine)**
   - Where: `packages/core/test/agents/{manager,pty-host,terminal-relay,build-claude-args}.test.ts`, `packages/core/test/{core,daemon/service-manager,events/log,events/service,modules/loader,project/}.test.ts`, `packages/mcp/test/mcp-server.test.ts`, `packages/mcp/test/tools/judge.test.ts`, `packages/server/test/{api/server,hooks/enforcer-cli,hooks/server}.test.ts`, `packages/work/test/runs/{artifact-store,checkpoint-list-filters}.test.ts`, `packages/work/test/scheduling/{triggers/,workflow-engine-execute}.test.ts`
   - Problem: All 18 inspected files look genuine (descriptive, vitest, target real modules, deterministic). Leaving them untracked indefinitely is the smell.
   - Fix: `git add` all 20, run them, commit.
   - Effort: S
   - Reviewer: researcher

7. **Internal-module mocking anti-pattern across test suite**
   - Where: `packages/core/test/core.test.ts:14-108` (94 lines mocking 13 internal modules + a CJS `Module._load` patch — tautology), and ~12 other test files: `manager.test.ts:11`, `profile-store.test.ts:32`, `project/registry.test.ts:30`, `agents/terminal-relay.test.ts:23`, `daemon/registry.test.ts:29`, `extras/test/plugins/loader.test.ts:57-58`, `extras/test/settings/skill-store.test.ts:11`, `extras/test/plugins/debug-loader.test.ts:8,18`, `intelligence/test/.../vector-memory.test.ts:16`, `server/test/hooks/server.test.ts:11,22`, `server/test/hooks/installer.test.ts:14,18`
   - Problem: Tests assert that `core.init()` calls modules they explicitly stubbed — pure tautology. Replace with thin integration tests against tmpdir.
   - Fix: rewrite `core.test.ts` first (highest density of mocks); audit and migrate the other 11.
   - Effort: M
   - Reviewer: code-reviewer

## Medium priority

1. **`packages/mcp/src/tools/deliberate.ts` is 1290 lines** — `deliberate.ts` mixes tool def, args parsing, voter assembly, runtime loop, persistence; also has 10 empty `catch {}` blocks swallowing event-bus emits, artifact reads, profile lookups (lines 237, 293, 322, 335, 450, 456, 458, 633, 777, 902). Split + replace `catch {}` with logged failures. _Effort: M. Reviewers: researcher, code-reviewer._

2. **CRUD-family tool collapse** — `list/get/save/delete` for profiles/skills/teams = 12 tools, schedule family = 9. Collapse to `zana_<entity>_resource` with `op: list|get|save|delete`. Cuts ~30 tools and the corresponding boilerplate in `mcp-server.ts`. _Effort: M. Reviewer: architect._

3. **84 empty `catch {}` blocks across `packages/*/src/`** — ~25 are legitimate (fire-and-forget shutdown), ~50+ are hiding bugs. Sample classified above; sweep + fix. _Effort: M. Reviewer: code-reviewer._

4. **96 occurrences of `as any` / `: any[]` / `<any>`** — ~70% are avoidable, mostly the lazy-require Proxy pattern and dynamic dispatch in `deliberate.ts` (lines 170-173, 492-497, 561-562). _Effort: M. Reviewer: code-reviewer._

5. **40+ legacy/deprecated/backwards-compat markers** — `daemon/registry.ts:86` "One-shot migration from legacy `~/.zana/hives`", `events/deliberation-events.ts:10-23` legacy spawn bucket, `mcp/claude-settings.ts:38-92` legacyMarkers, `server/api/server.ts:488` "Orchestrator (legacy passthrough)", `tickets/migration.ts:136` hiveId→daemonId, `scheduling/yaml-format.ts:50,74`, `scheduling/schema.ts:23`, `scheduling/service.ts:134,417`, `scheduling/store.ts:110`, `tickets/watcher.ts:68,224`, `manager.ts:533,574,663,691,844,861`. Pick a cutover, delete. _Effort: M. Reviewer: code-reviewer._

6. **Two scheduling paths share NOTHING but a documented YAML schema** — `packages/work/src/scheduling/{schema.ts,yaml-format.ts}` (325 LOC) vs. `plugins/zana/loop/skills/scheduler/SKILL.md` (markdown translation table). Drift inevitable. Fix: extract `@zana-ai/scheduler-schema`, have `/zana:loop:start` shell out to `zana scheduler validate <id>`. _Effort: M. Reviewer: architect._

7. **Files over the 500-line cap (besides the 3 above)** —
   - `packages/server/src/api/server.ts` (972)
   - `packages/work/test/deliberation/run.test.ts` (808), `quorum.test.ts` (777)
   - `packages/work/src/tickets/watcher.ts` (660)
   - `packages/core/src/modules/loader.ts` (619)
   - `packages/work/src/deliberation/quorum.ts` (606), `run.ts` (596)
   - `packages/work/src/scheduling/service.ts` (547)
   - `packages/server/src/hooks/server.ts` (525)
   _Effort: M each. Reviewer: researcher._

8. **Dual ticket format read in 5+ places** — `packages/work/src/tickets/store.ts:32-78, 130-200, 154-194, 215-225` branches on directory-format-vs-flat-file every read; line 215-225 silently re-writes during reads. Pick one, write a one-shot migration in `migration.ts`, delete the dual reads. _Effort: M. Reviewer: code-reviewer._

9. **`hiveId → daemonId` rename shims scattered** — `tickets/store.ts:215-225`, `migration.ts:136`, `scheduling/yaml-format.ts:50,74`, `scheduling/schema.ts:23`, `scheduling/service.ts:134,417`. Cut over and delete. _Effort: S. Reviewer: code-reviewer._

10. **53 inlined `JSON.parse(fs.readFileSync(p, "utf8"))` paired with empty catches** — extract one `readJsonSafe(p)` helper. _Effort: S. Reviewer: code-reviewer._

11. **`Access-Control-Allow-Origin: *` on SSE stream** — `packages/server/src/api/server.ts:135` contradicts the strict `ALLOWED_ORIGINS` set used elsewhere. Mitigated by Bearer auth, but should reflect validated origin via `getCorsOrigin(req)` for consistency. _Effort: S. Reviewer: security-reviewer._

12. **`postToSubDaemon` sends no Bearer token** — `packages/swarm/src/swarm/spawner.ts:184-207` master→sub HTTP calls carry no `Authorization`. Sub-daemon `auth-middleware.ts` will 401 — swarm instruct/broadcast is functionally broken. _Effort: S. Reviewer: security-reviewer._

13. **`packages/work/src/tickets/service.ts:339-344` six dual-named `as any` re-exports** — `(ticketStore as any).listTickets/getTicket/...`. Type the re-exports or have callers import from `tickets.store` directly. _Effort: S. Reviewer: code-reviewer._

14. **Test/production coupling in `manager.ts`** — `_resetSpawnOverloadState` and `_testSpawnOverloadProbe` exported from production purely for tests. Extract the streak counter to its own module and test it directly. _Effort: S. Reviewer: code-reviewer._

15. **`scripts/qa/results/*` are 8 committed run-output logs** — reproducible artifacts that should be gitignored. _Effort: S. Reviewer: researcher._

16. **3 orphan QA scripts with no recipe doc** — `scripts/qa/run-judge-live.sh`, `scripts/qa/run-commands-live.sh`, `scripts/qa/run-scheduler-live.sh`. Either document or delete. _Effort: S. Reviewer: docs-reviewer._

## Low priority / nits

- `tail -n ${lines}` / `journalctl ... -n ${lines}` via `execSync` in `service-manager.ts:111,192,196` — `lines` is `parseInt`'d, so safe; defense-in-depth: switch to `execFile`.
- `launchctl load -w "${plistPath}"` via `execSync` in `service-manager.ts:66,72,85` — fixed path, safe; same `execFile` recommendation.
- Skill `dynamicContext` `execSync(cmd)` in `extras/src/settings/skill-store.ts:177` — allowlist+metachar block in place; residual risk is `git --upload-pack=...` style trickery.
- `packages/work/src/tickets/store.ts:54,74,103,131,154-194` — WHAT-style comments narrating obvious code.
- `packages/core/src/agents/manager.ts:8` — "Lazy-load pty-host only when interactive mode is needed" — function name `getPtyHost` already says this.
- `packages/mcp/src/tools/deliberate.ts:228-230` — 3-line WHAT comment for an obvious set-build loop.
- `packages/mcp/src/tools/deliberate.ts:104, 352-365, 414, 893-915, 1156` — `escalationStrategy: "human" | "judge" | "hybrid"` declared 5 times; type alias.
- `packages/core/src/agents/manager.ts:392, 397, 547, 621` — `(agent as any).outputBuffer` field not on the Agent type; either add or stop monkey-patching.
- `scripts/qa/README.md` references `scenarios/runtime-deferred.md` which doesn't exist — fix link or restore file.
- `packages/work/src/scheduling/store.ts:110` — "Write the schedule as JSON (legacy default). Preferred path for new …" — if JSON is legacy, drop it.
- `packages/mcp/src/tools/deliberate.ts:166-180, 386, 1093` — `wait: true` is "legacy / test mode"; factor inline-loop branch into a test helper.
- `manager.ts:542-576` `classifySpawnError` regex — author flags false-positive risk explicitly; replace with explicit error-code detection.
- Statusline opens arbitrary sqlite path from stdin (`packages/core/bin/statusline.ts:103-123`) — source is trusted Claude Code host; flag if threat model changes.

## Remove candidates

**Deprecated code blocks**
- `packages/core/src/config.ts:9-90` — DEPRECATED getters block (covered above as HIGH)
- `packages/work/src/tickets/service.ts:339-344` — six `as any` re-exports
- `packages/core/src/agents/manager.ts:97-118` — `_resetSpawnOverloadState`, `_testSpawnOverloadProbe` test-only exports
- All 40+ `// legacy` / `// deprecated` / `// TODO: remove` markers (sweep listed under Medium)

**Daemon-only MCP tools that native slash commands replace**
- `zana_oneshot_query` (`mcp-server.ts:143`) — `Agent({})` natively replaces; no slash command, no recipe
- `zana_route_task`, `zana_plan_create`, `zana_workers_list`, `zana_discover_agents` — feature-flag bait; no slash, no recipe, no plugin reference
- `zana_module_config_get/list/set` — only consumer is `core/src/modules/loader.ts`
- `zana_workflow_run` / `_list_runs` / `_get_run` — workflow-engine has tests but no recipe, no slash; either expose via `/zana:workflow` skill or keep internal
- `zana_send_ack`, `zana_check_inbox` — duplicate `SendMessage`; `check_inbox` is polling, contradicting CLAUDE.md
- `zana_ask_agent` — same shape as `Agent` + `SendMessage`

**Committed run artifacts**
- `scripts/qa/results/*.txt` (8 files) — gitignore + delete from history (or just gitignore + leave)

**Orphan or broken doc references**
- `scripts/qa/README.md` reference to missing `scenarios/runtime-deferred.md`

**3 orphan smoke scripts**
- `scripts/qa/run-judge-live.sh`, `run-commands-live.sh`, `run-scheduler-live.sh` — either document in `RECIPES.md`/website or delete

## Investigate (decisions needed from human)

1. **Tenant-isolation policy scope** — `security-reviewer` says: "Should non-deliberation/non-CAS stores also refuse `~/.zana/` fallback? Today: tickets/db, tickets/store, tickets/migration, plans-store, intelligence/task-router, intelligence/vector-memory, core/events/store all silently fall back. CLAUDE.md is explicit only about CAS+deliberation. If the tenant-isolation goal is broader, those need the same gate; if narrower, leave as-is and document." This is the call you have to make.

2. **Real cycle vs. fixable cycle** — `code-reviewer` and `architect` both flag the lazy-require Proxy hacks. Two competing positions:
   - **architect:** "Recommend introducing a thin `@zana-ai/contracts` (interfaces + types only) and inverting these `require()`s, or splitting `core` into `core-engine` (pure) + `core-facade` (the index re-exporter). The current shape will block any modular publish/refactor."
   - **code-reviewer:** "Either consolidate into one shared `lazyRequire(pkg, path)` helper, or restructure to remove the cycle." (less aggressive — accepts the cycle if helper consolidation buys enough.)
   You decide whether the cycle is structural debt to clear or accepted complexity to standardize.

3. **Are channels still alive?** — `architect`: "`zana_publish_channel` / `_subscribe_channel` / `_list_channels` / `_channel_history` — 4 tools, no test files matching `*channel*`, no slash command exposure, partially overlaps with `SendMessage` and `event_emit/query`. Is anyone actually using channels, or is this an early pubsub experiment that lost out to direct messaging?"

4. **`postToSubDaemon` missing auth** — `security-reviewer`: confirm whether master→sub instruct/broadcast actually works in headless swarm setups today, or whether this code path has been dead since auth was added. If dead, delete; if alive, fix.

5. **`/events/stream` wildcard ACAO** — confirm intent vs. reflecting validated origin.

6. **Plist XML escape trust boundary** — confirm `service install` is meant to be reachable with an attacker-influenced cwd. If the trust boundary is "user supplies their own cwd, period", document and downgrade. Otherwise fix as Critical #1.

7. **`zana_checkpoint_*` MCP exposure** — referenced in `plugins/zana/core/skills/collaboration/`, but no qa scenario. With the daemon path being deprecated, do checkpoints still need MCP exposure or is project-local file IO enough?

8. **`packages/core/src/agents/manager.ts` unconditional `swarmPkg = require("@zana-ai/swarm")`** — swarm is supposed to be `ZANA_MASTER_MODE`-gated. Why does core depend on swarm at all? Likely the gating is at the wrong layer.

9. **20 untracked test files — why still untracked?** — `researcher`: "May indicate an in-progress test sprint that stalled. Should we commit them or are they known-flaky?"

## Per-reviewer raw findings

### Researcher

**REMOVE candidates**
- `scripts/qa/scenarios/runtime-deferred.md` — referenced by `scripts/qa/README.md` ("Deferred (legacy spec) — see `scenarios/runtime-deferred.md`") but the file does NOT exist (only `cli.md`, `daemon.md`, `mcp.md`). Either remove the README pointer or restore the file. (severity: LOW — broken doc link)
- `scripts/qa/results/*.txt` — eight committed run-output logs (`cli.txt`, `commands.txt`, `daemon.txt`, `judge.txt`, `mcp.txt`, `runtime.txt`, `scheduler-live.txt`, `live-all-20260603-073117.log`). These are reproducible run artifacts that should be gitignored, not checked in. (severity: LOW)
- The CLAUDE.md gitStatus snapshot mentioned `packages/work/src/deliberation/types.js` and `packages/extras/test/plugins/_debug_loader.test.ts` and many other now-stale entries — those files do NOT currently exist on disk. The conversation snapshot was already out of date. (severity: INFO)

**CHANGE candidates**
- `packages/mcp/src/mcp-server.ts` — **1799 lines**, ~3.6× the 500-line ceiling. Worst single-file violation. Likely splittable along tool-domain boundaries. (severity: HIGH)
- `packages/core/src/agents/manager.ts` — **1389 lines**. Mixed responsibilities. Test file `manager.test.ts` (untracked) already isolates the pure helpers — extract them into siblings. (severity: HIGH)
- `packages/mcp/src/tools/deliberate.ts` — **1290 lines**. Dominant deliberation tool surface. (severity: HIGH)
- `packages/server/src/api/server.ts` — **972 lines**. (severity: MEDIUM)
- `packages/work/test/deliberation/run.test.ts` (808) and `quorum.test.ts` (777) — test files over the cap. (severity: MEDIUM)
- `packages/work/src/tickets/watcher.ts` (660), `packages/core/src/modules/loader.ts` (619), `packages/work/src/deliberation/quorum.ts` (606), `run.ts` (596), `packages/work/src/scheduling/service.ts` (547), `packages/server/src/hooks/server.ts` (525) — over but close to the cap. (severity: LOW–MEDIUM)
- 20 untracked test files (≈18 `.ts` + 2 untracked dirs `packages/core/test/project/`, `packages/work/test/scheduling/triggers/`) — all 18 inspected look genuine: descriptive headers, vitest imports, target real source modules, deterministic. **0 look like scratch.** They should be `git add`-ed. (severity: MEDIUM)
- `scripts/qa/README.md` — fix the dangling `scenarios/runtime-deferred.md` link or remove the section. (severity: LOW)

**INVESTIGATE**
- Plugin skill duplication — both `plugins/zana/core/skills/{collaboration,orchestration}/` use the same SKILL.md shape. No command-name collisions between `plugins/zana/core/commands/` (28 cmds) and `plugins/zana/loop/commands/` (3 cmds: `loop-define`, `loop-start`, `loop-stop`); namespaces are clean.
- Claimed orphans — none of the candidates (core.ts, config.ts, persistence.ts, mcp-server.ts, claude-settings.ts, hooks/server.ts, hooks/enforcer.ts, hooks/installer.ts, api/server.ts, swarm/router.ts) are actually orphans. Naive `from.*basename` grep produces false positives because cross-package imports go through `@zana-ai/<pkg>` barrels. **No clear orphan source modules found.** Worth a deeper unused-export scan with `ts-prune`/`knip`.
- Why are 20 tests still untracked? May indicate an in-progress test sprint that stalled.
- `@zana-ai/core/src/...` direct imports in untracked tests — pierce the package barrel. Existing tracked tests follow the same pattern, so probably fine, but inconsistent with the "production code paths reach `dist/`" rule.

**Stats**
- 14 files >500 lines under `packages/`, `plugins/`, `website/` (worst: `packages/mcp/src/mcp-server.ts` at 1799)
- 0 stale `.js` in `src/`
- 20 untracked test paths (18 `.test.ts` + 2 dirs) — all genuine
- 0 confirmed orphan source modules
- 2 script-area items flagged
- 0 plugin command/skill name collisions

### Architect

**REMOVE candidates**
- `packages/mcp` daemon-only tool surface: ~25 of 91 unique tools registered are daemon-path duplicates of native slash-command flows (`zana_autopilot_*`, `zana_deliberate_*`, `zana_start_team`/`stop`/`status`/`list_running`, `zana_spawn_agent*`/`kill`/`status`/`result`/`list_agents`). Slash commands explicitly say "do NOT call from this command". Recommend gating behind `ZANA_DAEMON_TOOLS=1` like swarm uses `ZANA_MASTER_MODE`.
- `zana_oneshot_query` (`mcp-server.ts:143`) — superseded by `Agent({})` natively; no slash, no recipe.
- `zana_route_task` / `zana_plan_create` / `zana_workers_list` / `zana_discover_agents` — feature-flag bait. `task-router` and `goap-planner` have one test each, no slash command, no plugin reference. `zana_discover_agents` overlaps with `zana_list_agents`.
- `zana_module_config_*` (3 tools) — only consumer is `packages/core/src/modules/loader.ts`. Internal config plumbing leaking through MCP.
- `zana_workflow_run` / `_list_runs` / `_get_run` — workflow-engine has tests but no recipe, no slash command. The "workflows" headline primitive is effectively a private function of the daemon scheduler.
- `zana_send_ack` / `zana_check_inbox` / `zana_ask_agent` — duplicate `SendMessage`. `check_inbox` is a polling primitive — directly contradicts CLAUDE.md's "agents coordinate via SendMessage, not polling."

**CHANGE candidates**
- Cross-package coupling: core depends on every sibling. `core/src/core.ts` `require()`s `@zana-ai/server`, `@zana-ai/swarm`, `@zana-ai/intelligence`, `@zana-ai/extras`, `@zana-ai/work`. `core/src/index.ts` does the same. `agents/manager.ts` (1389 LOC) lazy-`require()`s work's ticket service, scheduler, checkpoint store, artifact store, team store/manager, plus swarm directly. Real cycle: `core ↔ work` (work also `require()`s core from `tickets/watcher.ts`, `scheduling/service.ts`, `tickets/db.ts`), `core ↔ extras`. The "lazy require to break the cycle" comment is a smell. **Recommend introducing a thin `@zana-ai/contracts` (interfaces + types only) and inverting these `require()`s, or splitting `core` into `core-engine` + `core-facade`.**
- `packages/core/src/agents/manager.ts` god module (1389 LOC). Owns lifecycle + ticket dispatch + scheduler glue + swarm dispatch + checkpoint resume + team start. Split into `agents/lifecycle.ts`, `agents/dispatch.ts`, `agents/team-runtime.ts`.
- MCP tool surface bloat (91 tools, CLAUDE.md says ~80). CRUD families are mechanical: list/get/save/delete for profiles/skills/teams = 12 tools; schedule family = 9. Collapse to `zana_<entity>_resource` with `op:` field.
- Two scheduling paths share NOTHING but a YAML convention. `packages/work/src/scheduling/{schema.ts,yaml-format.ts}` (325 LOC) parses the daemon path. `plugins/zana/loop/skills/scheduler/SKILL.md` is markdown — no shared parser, no shared validator. CLAUDE.md says they "share schema" — they share a documented schema, not a normative one. Drift inevitable. Extract `@zana-ai/scheduler-schema`.
- `extras` ↔ `work` cycle. `extras/src/plugins/loader.ts` requires `@zana-ai/work`, and `work/teams/store.ts` imports from `@zana-ai/extras`. Either move the plugin loader into `core` or split `@zana-ai/plugin-host` out of extras.
- Workspace-context invariant — one near-bypass at `packages/server/src/api/server.ts:709`.

**KEEP-AS-IS (validated)**
- Workspace context invariant broadly honored across `work`, `intelligence`, `server`. 4 of 5 spot-checks clean. The `_ctx() / isInitialized() ? getProjectPaths().X : fallback` pattern is consistent.
- `packages/swarm` correctly gated behind `ZANA_MASTER_MODE=true` in both `mcp-server.ts:33` and `core/spawner.ts:179`. Small package (642 LOC), tight surface (6 tools). This is the model the daemon-only tools should follow.
- Tickets, sprints, artifacts, profiles, skills, teams as dual-path primitives — referenced by both slash commands AND MCP tools, both have tests, have qa scenarios. They earn their tool surface.
- Memory primitive (`zana_memory_store/search`) — backed by `intelligence/vector-memory.ts` with a real test, conceptually distinct from artifacts. Worth keeping.

**INVESTIGATE**
- Channels (`zana_publish_channel`/`_subscribe_channel`/`_list_channels`/`_channel_history`) — 4 tools, no `*channel*` test files, no slash command exposure, partially overlaps with `SendMessage` and `event_emit/query`. Is anyone actually using channels?
- `zana_checkpoint_*` (4 tools) — referenced in `plugins/zana/core/skills/collaboration/`, no qa scenario. With the daemon path deprecated, do checkpoints still need MCP exposure?
- `zana_send_ack` — what calls it? Polling pattern.
- `manager.ts` `swarmPkg = require("@zana-ai/swarm")` is unconditional at module top level, but swarm is `ZANA_MASTER_MODE`-gated. Why does core depend on swarm at all if swarm is master-only?

**Dep graph summary**
3 cycles: `core ↔ work`, `core ↔ extras`, `extras → work` (with work → core completing the diamond). Core is "god package" — every sibling imports it AND core imports every sibling back via lazy `require()`s, with explicit comments admitting the cycle. Coupling health is poor: package boundaries are nominal but not structural — you cannot publish or test any one of `core/work/extras` without all three. MCP layer is a thin handler-table on top, but surface is bloated (91 tools, ~⅓ daemon-path duplicates or feature-flag bait).

### Security-reviewer

**CRITICAL** — none found. The two named invariants (CAS blob writes + `kind:"deliberation"` checkpoint writes) correctly throw `WorkspaceNotInitializedError`.

**HIGH**
- Plist XML injection: `packages/core/src/daemon/service-manager.ts:34-65` — `workspace` (defaults to `process.cwd()`) interpolated into `<string>${workspace}</string>` of a launchd plist with no XML escaping. A workspace path containing `</string><string>...` or `]]>` could break out of `WorkingDirectory` and inject arbitrary `ProgramArguments` — persistence vector. Fix: escape `&<>"'` or use a plist library.
- Tickets DB silently shares state: `packages/work/src/tickets/db.ts:19-21` — when `workspaceContext.isInitialized()` is false, writes land at `~/.zana/tickets.db`, mixing two workspaces. Same shape as the CAS/deliberation gates. Same shape: `plans-store.ts:19`, `migration.ts:8/15`, `tickets/store.ts:13/19`, `task-router.ts:34`, `vector-memory.ts:10`, `events/store.ts`.

**MEDIUM**
- `Access-Control-Allow-Origin: *` on SSE stream: `packages/server/src/api/server.ts:135` contradicts the strict `ALLOWED_ORIGINS` set. Mitigated by `authenticate(req)` (line 55), so cross-origin attacker can't reach handler. Reflect validated origin via `getCorsOrigin(req)`.
- `postToSubDaemon` sends no Bearer token: `packages/swarm/src/swarm/spawner.ts:184-207` master→sub HTTP calls (`/swarm/instruct`, `/agent/spawn`) carry no `Authorization`. Sub-daemon's `auth-middleware.ts` will reject with 401. Functional bug — swarm "instruct/broadcast" path is broken.

**LOW**
- `tail -n ${lines}` / `journalctl ... -n ${lines}` via execSync: `service-manager.ts:111,192,196`. `lines` is `parseInt`'d, so safe. Defense-in-depth: switch to `execFile`.
- `launchctl load -w "${plistPath}"` via execSync: `service-manager.ts:66,72,85`. Fixed path, safe. Same defense-in-depth.
- Statusline opens arbitrary sqlite path from stdin: `packages/core/bin/statusline.ts:103-123`. Source treated as trusted Claude Code host. No fix needed.
- Skill `dynamicContext` execSync(cmd): `packages/extras/src/settings/skill-store.ts:177`. Allowlist + metachar block. Residual `git --upload-pack=...` style risk.

**Verified clean**
- CAS blob writes refuse fallback: `artifact-store.ts:177-194` throws `WorkspaceNotInitializedError({operation:"store"})`.
- Deliberation checkpoint writes refuse fallback: `checkpoint/store.ts:149-160` gates on `kind === "deliberation"`.
- CAS path traversal hardened: `artifact-store.ts:152-169` derives blob path strictly from validated 64-hex digest.
- Checkpoint id traversal hardened: `checkpoint/store.ts:117-132` rejects ids whose joined path escapes `getDir()`.
- Daemon HTTP API: Bearer token + origin allowlist via `auth-middleware.ts` using `crypto.timingSafeEqual`, 32-byte token, file mode `0o600`. Binds to `127.0.0.1`.
- Hook server loopback-only: `hooks/server.ts:81-90` rejects non-loopback `remoteAddress` with 403; max-body 256KB; 30s timeout.
- `spawnHeadless` uses array-form `spawn(claudePath, args)`: `core/agents/spawner.ts:240-249`. No `shell:true`, control chars stripped, `validateProfile` enforces enums.
- Scheduler `command` action rejects shell strings: `scheduling/service.ts:307-340` requires `argv` array, uses `execFile(..., { shell: false })`.
- HTTP `/agents` POST cwd containment: `server.ts:152-156` rejects cwd outside `daemon.workspace`.
- Swarm `/swarm/inbox` & `/swarm/instruct` agentId validated: `AGENT_ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/`.
- No hardcoded credentials in `packages/*/src` or `plugins/`.
- SQLite parameterized everywhere: `tickets/db.ts` uses `?`/`@name` bindings.

**INVESTIGATE**
- Should non-deliberation/non-CAS stores also refuse `~/.zana/` fallback? Today: tickets, plans, task-router, vector-memory, events all silently fall back. Design call.
- `postToSubDaemon` missing auth — confirm whether master→sub instruct/broadcast actually works or has been dead since auth was added.
- `/events/stream` wildcard ACAO — confirm intent vs. reflecting validated origin.
- Plist XML escape — confirm `service install` is meant to be reachable with attacker-influenced cwd.

### Code-reviewer

**REMOVE / SIMPLIFY**
- `packages/core/src/config.ts:9-90` — entire DEPRECATED getters block (TICKETS_DIR, SPRINTS_DIR, ARTIFACTS_DIR, SESSIONS_DIR, EVENTS_DIR, RUNS_DIR, SCHEDULER_DIR, TMP_DIR getters that proxy to workspace-context). Comment says "removed in a future sprint" — that sprint is now.
- `packages/work/src/tickets/service.ts:339-344` — six dual-named re-exports `(ticketStore as any).listTickets/getTicket/...`. The `as any` casts are also lazy typing.
- `packages/core/src/agents/manager.ts:23`, `spawner.ts:7-8`, `extras/.../skill-store.ts:9-10`, `extras/.../plugins/loader.ts:8`, `intelligence/.../task-router.ts:5-6`, `server/.../hooks/server.ts:12,14` — Proxy hack pattern `new Proxy({}, { get: (_t, p) => require(...)[p] })` repeated ~10 times to break import cycles. All typed `any`. Consolidate into one shared `lazyRequire(pkg, path)` helper, or restructure to remove the cycle.
- `packages/core/src/agents/manager.ts:31-36` — six near-identical `_ticketService()`, `_ticketStore()`, ... lazy require functions. Same lazy-cycle smell.
- `packages/core/src/agents/manager.ts:97-118` — `_resetSpawnOverloadState` and `_testSpawnOverloadProbe` exported from production code purely for tests. Either extract the streak counter or inline assertions through a real spawn flow.
- Files over the 500-line cap: `manager.ts` (1389), `deliberate.ts` (1290), `mcp-server.ts` (1799), `api/server.ts` (972), `tickets/watcher.ts` (660). `manager.ts` mixes resource gates, spawn streak counters, agent CRUD, probe machinery, orchestrator-command dispatch.
- `packages/work/src/tickets/store.ts:32-78, 130-200` — Dual ticket format ("New format: read ticket.json inside directory" vs "Old format: flat file") branched in 5+ places. If migration is complete, delete the old branch.
- `packages/work/src/tickets/store.ts:215-225`, `migration.ts:136`, `scheduling/yaml-format.ts:50,74`, `scheduling/schema.ts:23`, `scheduling/service.ts:134,417` — `hiveId → daemonId` rename has migration shims scattered. Pick a cutover and delete.
- `packages/mcp/src/tools/deliberate.ts:166-180, 386, 1093` — `wait: true` is "legacy / test mode". Factor inline-loop branch into a separate test helper.

**CHANGE**
- `packages/core/test/core.test.ts:14-108` — 94 lines mocking 13 internal modules plus a CJS `Module._load` patch. Worst over-mocking case. The test asserts `core.init()` calls modules it explicitly stubs to be called — tautology. Replace with thin integration test against tmpdir.
- ~12 other test files mocking internal modules: `manager.test.ts:11`, `profile-store.test.ts:32`, `project/registry.test.ts:30`, `agents/terminal-relay.test.ts:23`, `daemon/registry.test.ts:29`, `extras/test/plugins/loader.test.ts:57-58`, `extras/test/settings/skill-store.test.ts:11`, `extras/test/plugins/debug-loader.test.ts:8,18`, `intelligence/test/.../vector-memory.test.ts:16`, `server/test/hooks/server.test.ts:11,22`, `server/test/hooks/installer.test.ts:14,18`.
- 53 occurrences of inlined `JSON.parse(fs.readFileSync(p, "utf8"))` — extract `readJsonSafe(p)` helper.
- `packages/work/src/tickets/store.ts:215-225` — Read-time migration that silently re-writes tickets ("best-effort; skip if read-only"). Reads with side effects are bug-prone. Move to explicit one-shot migration.
- `packages/core/src/agents/manager.ts:392, 397, 547, 621` — `(agent as any).outputBuffer` field that isn't on the Agent type.

**Pattern violations (rollup)**
- 84 empty `catch {}` blocks. Sample of 10: ~25 of 84 legitimate (fire-and-forget shutdown/cleanup); ~50+ hiding bugs. `deliberate.ts:237, 293, 322, 335, 450, 456, 458, 633, 777, 902` swallow event-bus emits, artifact reads, profile lookups. `manager.ts:1101` (corrupt JSON masked as missing). `persistence.ts:74,110` (delete errors silently mask permission issues).
- 96 `as any` / `: any[]` / `<any>`. ~70% avoidable, mostly the lazy-require Proxy pattern.
- 40+ legacy/deprecated/backwards-compat markers (listed in Medium #5).
- WHAT-style comments — low overall. 5 worst: `tickets/store.ts:74,103` "Sort newest first for fast listing"; `tickets/store.ts:54,131` "New format: read ticket.json inside directory"; `tickets/store.ts:154-194` cluster narrating obvious if/else; `manager.ts:8` "Lazy-load pty-host only when interactive mode is needed"; `deliberate.ts:228-230`.

**INVESTIGATE**
- Real cycle vs. fixable cycle (Proxy-on-{}+as any pattern). Is there a real cycle, or could `extras` be split? Same question for `core ↔ work`.
- `packages/mcp/src/tools/deliberate.ts:104, 352-365, 414, 893-915, 1156` — `escalationStrategy: "human" | "judge" | "hybrid"` declared 5 times. Type alias.
- `packages/work/src/scheduling/store.ts:110` — JSON legacy default vs. preferred YAML. Are both formats actually needed?
- `manager.ts` `classifySpawnError` heuristic regex (lines 542-576) — author flags false-positive risk explicitly. Replace with explicit error-code detection.
- `tickets/service.ts:339-344` — six `as any` exports. Why aren't these typed?

### Docs-reviewer

**Stale references (concepts removed but doc still mentions them)**
- None. Grep for `Vercel|RuntimeAdapter|vercel.ai|@ai-sdk` across `*.md|*.mdx|*.astro|*.ts|*.json` returned **zero hits**. The `bfb50ca` cleanup is complete.

**Recipe ↔ test orphans**
- Recipes with no test: none. Every recipe in `docs/RECIPES.md` and `website/src/pages/docs/recipes/*/index.astro` cites a real `scripts/qa/run-*.sh` (verified all 4: `run-scheduler-agent-live.sh`, `run-ticket-live.sh`, `run-autopilot-live.sh`, `run-runtime.sh`).
- Tests with no recipe (orphan scripts): `scripts/qa/run-judge-live.sh`, `scripts/qa/run-commands-live.sh`, `scripts/qa/run-scheduler-live.sh`.

**README drift**
Spot-checked first 5 paths/commands in `README.md`:
- `INSTALL.md` (line 38, 124) — exists
- `plugins/zana/core/commands/` and `plugins/zana/loop/commands/` (lines 84-85) — exists
- `bash scripts/install.sh` (line 89, 119) — exists
- `npm run build:runtime` (line 131) — script exists
- `packages/mcp/dist/bin/zana-mcp-server.js` (line 134) — exists
- `docs/MCP-TOOL-REFERENCE.md` (line 162) — exists
- `packages/core/profiles/` (line 62) — README claims **18 agent profiles** and lists 18; directory contains exactly 18 `.json` files. Clean.

No README drift detected.

**CLAUDE.md tool table drift**
Spot-checked tool names: `zana_spawn_agent`, `zana_list_agents`, `zana_kill_agent`, `zana_start_team`, `zana_deliberate`, `zana_autopilot_goal_driven`, `zana_schedule_list`, `zana_memory_store`, `zana_artifact_create`, `zana_swarm_*` — all exist. Broader probe of 19 names — all 19 matched. Table is clean.

**Stats**
- 0 stale concept refs
- 3 orphan QA scripts (no recipe), 0 orphan recipes (no script)
- 0 README drift items
- 0 CLAUDE.md table drift items

## Recommended next sprint

1. **`fix(security): close two HIGH gaps (plist injection + ticket-DB tenant fallback)`**
   - Acceptance: `service-manager.ts` plist generation escapes `&<>"'` (regression test for a malicious cwd); `tickets/db.ts` + `plans-store.ts` + `task-router.ts` + `vector-memory.ts` + `events/store.ts` either throw `WorkspaceNotInitializedError` or are explicitly documented in CLAUDE.md as "not workspace-isolated".

2. **`refactor(core): split agents/manager.ts and decide cycle policy`**
   - Acceptance: `manager.ts` < 500 lines, split into `lifecycle.ts` + `dispatch.ts` + `team-runtime.ts`; the 10 lazy-require Proxy hacks consolidated into a single `lazyRequire(pkg, path)` helper; `_resetSpawnOverloadState` / `_testSpawnOverloadProbe` test-only exports moved out of production. Decision documented re: `@zana-ai/contracts` extraction (do or defer).

3. **`refactor(mcp): split mcp-server.ts and gate daemon-only tools`**
   - Acceptance: `mcp-server.ts` < 500 lines, one registration file per domain; `ZANA_DAEMON_TOOLS=1` gate added covering `zana_autopilot_*`, `zana_deliberate_*`, `zana_spawn_agent*`, `zana_*_team*`, `zana_kill_agent`, `zana_oneshot_query`, `zana_send_ack`, `zana_check_inbox`, `zana_ask_agent`; documented in CLAUDE.md.

4. **`chore(cleanup): commit pending tests, delete deprecated config, sweep legacy markers`**
   - Acceptance: 20 untracked test files committed and green; `config.ts:9-90` deprecated getters removed and importers migrated; the 40+ legacy/deprecated/backwards-compat markers swept (each either deleted with the shim or annotated with a removal date); `scripts/qa/results/*.txt` gitignored; `scripts/qa/README.md` dangling link fixed.

5. **`refactor(work): unify ticket store format and JSON helper`**
   - Acceptance: dual directory-vs-flat ticket format collapsed (one-shot migration in `migration.ts`, dual reads deleted); `hiveId → daemonId` shims removed; one shared `readJsonSafe(p)` helper replaces the 53 inlined `JSON.parse(fs.readFileSync(...))`+`catch {}` pairs.

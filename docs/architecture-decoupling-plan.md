# Architecture decoupling — review + execution plan

**Date:** 2026-06-18. **Scope (approved):** in-process decoupling with
network-ready interfaces. Make every concern a swappable, independently
buildable package behind a clean contract — WITHOUT promoting to out-of-process
network services yet. Each concern *can* become a network service later with no
caller changes.

Produced by a 4-engineer analysis team (dependency graph, interfaces, runtime
coupling, build/release). Full findings below the plan.

## Verdict in one paragraph

Zana is ~70% decoupled already: `@zana-ai/contracts` is a clean leaf, 6/8
packages have clean façades, and real HTTP seams already exist (hook server,
orchestrator-MCP bridge, swarm). What blocks "plug-and-play" is three coupling
knots — (1) `core` is a god-façade re-exporting everything, sustaining the
`core↔work↔extras` runtime-service cycle; (2) no interface/implementation split,
so callers bind to concrete modules; (3) the 540-line `dispatch.ts` god-router
duplicated by MCP — plus build/release lockstep. We fix these with interfaces +
dependency injection in-process. We do NOT add a message bus / RPC / service
discovery (deferred until a real scaling driver exists).

## The true dependency picture

Declared package.json deps are a clean DAG rooted at `contracts`. The REAL
runtime graph has 3 interlocking lazy cycles, all via `require("@zana-ai/core")`
at call time:

- **core ↔ work** — core re-exports `work.tickets/scheduling/teams/runs`
  (`core/src/index.ts:28-42`); work calls back into `core.agents.manager` /
  `profileStore` (~53 sites, e.g. `work/src/scheduling/service.ts:72,86`).
- **core ↔ extras** — core uses `extras.settings.skillStore`
  (`dispatch.ts:21-23`, `spawner.ts:10-11`); extras' skill-store lazy-requires
  `core.agents.profileStore` (`extras/src/settings/skill-store.ts:17`).
- **core ↔ intelligence** — core re-exports intelligence; all 4 intelligence
  modules call back into core for agents/profiles/bus.

Contracts broke the *load-time* cycle (the 5 base modules). The *service-layer*
cycle remains.

## Execution plan — 5 phases, each independently shippable

Ordered by ascending risk/collision. Stop-and-review gate after Phase 1.

### Phase 0 — Build & release independence (quick wins, ~days, near-zero collision)
Foundational hygiene; no source-logic changes.
1. Add `@zana-ai/contracts` to `scripts/release.sh` (FIRST — it's the leaf) and
   `scripts/bump-version.sh` (currently both omit it).
2. Adopt TypeScript project references: `composite: true` + `references` in each
   `tsconfig.build.json`; replace the hand-maintained `build:runtime:*` chain
   with `tsc -b` (derived order + incremental). Keep the asset-copy steps.
3. Kill the 2 deep `/dist/src` production imports by exporting their symbols
   from the public API:
   - `server/src/hooks/installer.ts:4` → `isClaudeHost` (move to contracts; it's
     a pure `process.platform` check) or export from core root.
   - `mcp/src/mcp-server.ts:47` → export `project.init` sub-fns from core root.
4. Add `package.json` `exports` maps to each package (allow `.` + the 1–2
   intentional dist paths; block undocumented deep imports).
5. Switch internal deps from exact pins (`"@zana-ai/core": "0.3.0"`) to caret
   ranges so a single package can ship a patch without republishing all 8.

### Phase 1 — Service contracts layer (additive, low collision) — REVIEW GATE
Define the interfaces; do NOT yet rewire callers. Purely additive new files in
`packages/contracts/src/services/`.
1. `IEventBus` (emit/on/off + typed `EVENTS`), `IAgentManager`
   (spawn/getAgent/listAgents/kill/status), `IProfileStore`, `ISkillStore`,
   `ITicketService`, `ISchedulerService`, `IArtifactStore`.
2. Request/response payload types for each (e.g. `TicketCreateParams`,
   `VerdictKind`, `WorkRef`) — replacing the cross-package `any`.
3. Shared event payload types (move the type-only `deliberation-events` etc.
   into contracts).
**Gate:** review the interface surface before any rewiring. This is the
contract everyone will depend on; getting it right matters more than speed.

### Phase 2 — Implement interfaces + dependency injection (medium)
Make existing modules implement the Phase-1 interfaces (structural — the
functions already match; add `: ITicketService` annotations and an exported
object). Introduce a tiny `ServiceRegistry` built at daemon boot
(`core/src/core.ts`) holding the concrete impls. Callers receive interfaces via
the registry instead of `require("@zana-ai/core").tickets.service`.

### Phase 3 — Break the god-façade (higher collision)
Stop `core/src/index.ts` re-exporting work/extras/intelligence. Consumers import
the owning package (or the injected interface) directly. Migrate the remaining
`_core()` helpers that fetch registries to injected interfaces. This is what
actually severs the cycle. Done package-by-package (work first, then extras,
then intelligence) so each is a small reviewable PR.

### Phase 4 — Collapse the dual integration layer (medium)
`dispatch.ts`'s 82-case switch and the MCP `callCore` handlers are two routers
over the same services. Make MCP/HTTP thin adapters over the Phase-1 interfaces;
shrink `dispatch.ts` to a registry lookup (or retire it). One domain at a time
(tickets → agents → scheduler → artifacts), each behind passing tests.

## Explicitly OUT of scope (deferred, per decision)
- Async message bus (Redis/NATS) replacing the in-process EventEmitter.
- RPC / service discovery / out-of-process registries.
- Workspace-context as a per-call parameter (breaks tenant isolation; ~100+
  sites; two reviewers flagged "never").
- Postgres migration / unfreezing swarm (ADR 0009).

## Risks & coordination
- Two peer agents are active in this same working tree. Phases 0–1 are additive /
  config-only (low collision); Phases 3–4 touch many shared files and will be
  coordinated file-by-file over P2P, or done in a git worktree.
- Each phase keeps the full `npm test` sweep green before moving on. No phase
  changes runtime behavior — these are structural refactors with tests as the
  invariant.

---

# Appendix — consolidated team findings

(Top coupling violations, ranked, with file:line — for reference during
implementation.)

1. **`core` god-façade** — `core/src/index.ts:10-42` re-exports 5 sibling
   packages as lazy getters. Highest blast radius; sustains all 3 cycles.
2. **Singleton registry access** — ~53 `getAgent()`/`getProfile()` call sites in
   work/extras/intelligence/mcp bind to core's in-process managers
   (`work/src/scheduling/service.ts:72,86`; `work/src/teams/manager.ts:227,234`;
   `extras/src/settings/skill-store.ts:17`).
3. **`dispatch.ts` god-router** — 540 lines / 82 string cases routing to 7
   packages, duplicated by MCP `callCore` (`mcp/src/registrations/*`). 3-layer
   indirection with no typed contract.
4. **No interface/impl split** — `work/src/tickets/service.ts` exports 29
   concrete fns; callers type via `typeof import(...)`, binding to the concrete
   module. Can't swap the SQLite store for a remote one.
5. **Untyped boundaries** — `dispatch.ts:38 handleOrchestratorCommand(payload:
   any)`; `mcp callCore(...): Promise<any>`. No validation framework despite the
   "validate at boundaries" rule.
6. **Deep `/dist/src` imports** — `server/hooks/installer.ts:4`,
   `mcp/mcp-server.ts:47`; plus `spawner.ts:257` monorepo-fallback path.
7. **Build/release lockstep** — exact version pins; `release.sh`/`bump-version.sh`
   omit `contracts`; no `tsc -b` project references (hand-maintained order);
   ~640 test imports bound to internal `/src/` paths.

**Already good:** contracts is a true leaf; 6/8 packages have clean façades;
file-backed stores (tickets WAL, artifacts CAS, checkpoints w/ file locks) are
multi-process-safe; HTTP seams already exist (hook server ~14 endpoints,
orchestrator-MCP bridge, swarm daemon-to-daemon). The path to services is
"extract HTTP routes + make handlers async + inject interfaces," not "add
network boundaries from scratch."

// Integration test for packages/core/src/core.ts.
//
// Strategy: redirect HOME and the workspace root to tmpdirs, then exercise
// the real init() against the real cross-package modules. We assert observable
// outcomes — ZANA_READY emitted, shutdown function returned, daemon-registry
// file written under the redirected HOME — instead of stubbing every internal
// module we touch.
//
// External boundaries that stay mocked:
//   • hooks/installer's writes to ~/.claude/settings.json — covered by
//     installer.test.ts and not the subject of this file.
//   • Real `claude` CLI spawning never happens because init() does not spawn
//     agents; the agentManager is a passive listener here.

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ── Hoisted: override HOME before ANY @zana-ai/* module loads ──────────────
// config.ts captures os.homedir() at module-load time, so HOME must be set
// before the first `import` resolves. vi.hoisted() runs before imports.
const { fakeHome, origHome } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const _fs = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const _path = require("node:path") as typeof import("node:path");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const _os = require("node:os") as typeof import("node:os");
  const fakeHome = _fs.mkdtempSync(_path.join(_os.tmpdir(), "zana-core-home-"));
  const origHome = process.env.HOME;
  process.env.HOME = fakeHome;
  return { fakeHome, origHome };
});

// Stop hooks/installer from touching the (test-host's) real ~/.claude on
// macOS where HOME alone is not always honoured by Claude Code. The
// install-hooks code path is unit-tested in installer.test.ts.
process.env.ZANA_SKIP_MCP_INSTALL = "1";

// We don't want to mutate the real claude settings.json. Force isClaudeHost
// false so isHooksInstalled() short-circuits and installHooks() is skipped.
// (server's installer reads from @zana-ai/core/dist/src/host/detect.js.)
vi.mock("@zana-ai/core/dist/src/host/detect.js", () => ({
  isClaudeHost: () => false,
}));

// Import the BUILT core — production code path. `require("./agents/zombie-reaper")`
// inside core.ts resolves cleanly here because dist is real CJS .js (no Vite
// SSR transform required).
import * as core from "@zana-ai/core";
const init = (core as any).init;
const bus = (core as any).events.bus;
const EVENTS = (core as any).events.EVENTS;
const workspaceContext = (core as any).project.workspaceContext;

const tmpDirs: string[] = [];

afterAll(() => {
  process.env.HOME = origHome;
  delete process.env.ZANA_SKIP_MCP_INSTALL;
  delete process.env.ZANA_HOOK_PORT;
  delete process.env.ZANA_ID;
  delete process.env.ZANA_HEADLESS;
  try { fs.rmSync(fakeHome, { recursive: true, force: true }); } catch {}
});

afterEach(async () => {
  // Best-effort tmpdir cleanup
  for (const d of tmpDirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
  }
  delete process.env.ZANA_HOOK_PORT;
  delete process.env.ZANA_ID;
  delete process.env.ZANA_HEADLESS;
});

describe("core.init()", { timeout: 30000 }, () => {
  it("returns a shutdown function and emits ZANA_READY on the bus", async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "zana-core-test-ws-"));
    // Pre-create .zana/ so resolveProjectDir anchors here and doesn't walk
    // up to /tmp/.zana/ (the real workspace), which is sandbox-blocked.
    fs.mkdirSync(path.join(ws, ".zana"), { recursive: true });
    tmpDirs.push(ws);

    const ready = new Promise<any>((resolve) => {
      bus.once(EVENTS.ZANA_READY, (payload: any) => resolve(payload));
    });

    const result = await init({ workspace: ws, headless: false });

    try {
      expect(typeof result.shutdown).toBe("function");
      const readyPayload = await ready;
      expect(readyPayload.workspace).toBe(ws);
      // hookServerHandle may be null when TCP binding is unavailable (e.g. in a
      // sandboxed environment). Production code handles this gracefully; the test
      // asserts whichever code path actually ran.
      if (result.hookServerHandle !== null) {
        expect(typeof result.hookServerHandle.port).toBe("number");
        expect(result.hookServerHandle.port).toBeGreaterThan(0);
        // daemonId is generated only when a hook server is bound.
        expect(typeof result.daemonId).toBe("string");
        expect(result.daemonId.length).toBeGreaterThan(0);
      } else {
        // No hook server → daemonId must also be null.
        expect(result.daemonId).toBeNull();
      }
      // Workspace context is initialized with the tmp ws as the root.
      // (eventLog creates session dirs lazily; we check the singleton state
      // instead of relying on a specific directory side-effect.)
      expect((core as any).project.workspaceContext.isInitialized()).toBe(true);
      expect((core as any).project.workspaceContext.getWorkspaceRoot()).toBe(path.resolve(ws));
    } finally {
      await result.shutdown();
    }
  });

  it("writes a daemon-registry entry under the redirected HOME", async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "zana-core-test-ws-"));
    // Pre-create .zana/ so resolveProjectDir anchors here and doesn't walk
    // up to /tmp/.zana/ (the real workspace), which is sandbox-blocked.
    fs.mkdirSync(path.join(ws, ".zana"), { recursive: true });
    tmpDirs.push(ws);

    const result = await init({ workspace: ws, headless: true, skipApiServer: true });

    try {
      // The daemon registry is only written when the hook server binds a port.
      // In sandboxed / TCP-restricted environments hookServerHandle is null and
      // no registry file is created — that is correct production behaviour.
      if (result.hookServerHandle === null) {
        // Nothing to assert; skip rather than false-fail.
        return;
      }
      const daemonsDir = path.join(fakeHome, ".zana", "daemons");
      // The registry writes <id>.json on register().
      const files = fs.existsSync(daemonsDir)
        ? fs.readdirSync(daemonsDir).filter((f) => f.endsWith(".json"))
        : [];
      expect(files.length).toBeGreaterThan(0);
      // Sanity: one of those files should hold our daemonId.
      const found = files.some((f) => f.startsWith(result.daemonId));
      expect(found).toBe(true);
    } finally {
      await result.shutdown();
    }
  });

  // core.ts:60-62 — init() creates the workspace directory when it is absent
  // (`if (!fs.existsSync(resolvedWorkspace)) fs.mkdirSync(...)`). The other tests
  // in this file all pre-create the workspace via mkdtempSync, so that branch is
  // never exercised. Here the leaf workspace dir is deliberately left absent and
  // we assert init() materializes it. The mkdirSync runs BEFORE the
  // workspaceContext.isInitialized() guard, so this side effect is independent of
  // the singleton's state and therefore order-independent across the suite.
  it("creates the workspace directory when it does not yet exist", async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "zana-core-test-parent-"));
    // Anchor project resolution at `parent` so resolveProjectDir does not walk
    // up to /tmp/.zana (sandbox-blocked). The child workspace dir itself stays
    // absent so init()'s mkdirSync branch is the thing under test.
    fs.mkdirSync(path.join(parent, ".zana"), { recursive: true });
    tmpDirs.push(parent);

    const ws = path.join(parent, "nested", "workspace");
    expect(fs.existsSync(ws)).toBe(false);

    const result = await init({ workspace: ws, headless: false });
    try {
      // init() must have created the previously-absent workspace directory.
      expect(fs.existsSync(ws)).toBe(true);
      expect(fs.statSync(ws).isDirectory()).toBe(true);
    } finally {
      await result.shutdown();
    }
  });

  // core.ts:68-70 — when init() is called with headless:true it sets the
  // ZANA_HEADLESS=1 env var so downstream modules can detect daemon mode; with
  // headless:false (the default) it must leave the var unset. afterEach deletes
  // ZANA_HEADLESS, so each branch starts from a clean slate and the assertion is
  // order-independent.
  it("sets ZANA_HEADLESS=1 in headless mode and leaves it unset otherwise", async () => {
    delete process.env.ZANA_HEADLESS;

    const wsHeadless = fs.mkdtempSync(path.join(os.tmpdir(), "zana-core-test-ws-"));
    fs.mkdirSync(path.join(wsHeadless, ".zana"), { recursive: true });
    tmpDirs.push(wsHeadless);

    const headlessResult = await init({ workspace: wsHeadless, headless: true, skipApiServer: true });
    try {
      expect(process.env.ZANA_HEADLESS).toBe("1");
    } finally {
      await headlessResult.shutdown();
    }

    // A fresh non-headless init() must not re-set the flag (afterEach cleared it).
    delete process.env.ZANA_HEADLESS;
    const wsInteractive = fs.mkdtempSync(path.join(os.tmpdir(), "zana-core-test-ws-"));
    fs.mkdirSync(path.join(wsInteractive, ".zana"), { recursive: true });
    tmpDirs.push(wsInteractive);

    const interactiveResult = await init({ workspace: wsInteractive, headless: false });
    try {
      expect(process.env.ZANA_HEADLESS).toBeUndefined();
    } finally {
      await interactiveResult.shutdown();
    }
  });

  // core.ts:209-246 wires an auto-assign-profile listener onto the bus for
  // "ticket:created". The whole handler body runs inside a try/catch that
  // swallows any internal failure with a "[core] auto-assign profile failed"
  // warning — `bus` is a raw Node EventEmitter (events/bus.ts), so without that
  // guard a throwing listener would propagate straight out of `bus.emit(...)`
  // and crash whichever code path created the ticket. This pins that
  // fault-isolation contract: emitting "ticket:created" (here with an unknown
  // ticketId) must never throw out of emit(), no matter what the handler does
  // internally. None of the other tests fire this event, so the listener and
  // its guard are otherwise unexercised. Deterministic: no fs/timers/network,
  // and an unknown ticketId can never resolve to a real ticket.
  it("isolates the ticket:created auto-assign handler — emit never throws", async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "zana-core-test-ws-"));
    fs.mkdirSync(path.join(ws, ".zana"), { recursive: true });
    tmpDirs.push(ws);

    const result = await init({ workspace: ws, headless: false });
    try {
      expect(() =>
        bus.emit("ticket:created", { ticketId: "core-test-unknown-ticket-xyz" }),
      ).not.toThrow();
      // The daemon stays usable after a swallowed auto-assign failure.
      expect(typeof result.shutdown).toBe("function");
    } finally {
      await result.shutdown();
    }
  });

  // Companion to the unknown-ticketId isolation test above. That one fires a
  // well-formed payload carrying a ticketId that simply doesn't resolve; this
  // pins the handler against MALFORMED / EMPTY payloads — undefined, null, a
  // bare {} with no ticketId, and a non-object primitive. The handler's
  // `if (!msg?.ticketId) return` guard plus the outer try/catch must absorb all
  // of these so emitting on the shared bus never throws out of emit() and the
  // daemon stays usable. None of the other tests fire these shapes, so this
  // edge class is otherwise unpinned. Deterministic: no fs/timers/network.
  it("tolerates malformed/empty ticket:created payloads — emit never throws", async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "zana-core-test-ws-"));
    fs.mkdirSync(path.join(ws, ".zana"), { recursive: true });
    tmpDirs.push(ws);

    const result = await init({ workspace: ws, headless: false });
    try {
      for (const payload of [undefined, null, {}, { ticketId: "" }, 42, "nope"]) {
        expect(() => bus.emit("ticket:created", payload as any)).not.toThrow();
      }
      // The daemon remains usable after every swallowed malformed emit.
      expect(typeof result.shutdown).toBe("function");
    } finally {
      await result.shutdown();
    }
  });

  it("shutdown() emits ZANA_SHUTDOWN exactly once and is idempotent on repeat calls", async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "zana-core-test-ws-"));
    // Pre-create .zana/ so resolveProjectDir anchors here and doesn't walk
    // up to /tmp/.zana/ (the real workspace), which is sandbox-blocked.
    fs.mkdirSync(path.join(ws, ".zana"), { recursive: true });
    tmpDirs.push(ws);

    const result = await init({ workspace: ws, headless: false });

    let shutdownCount = 0;
    const onShutdown = () => { shutdownCount++; };
    bus.on(EVENTS.ZANA_SHUTDOWN, onShutdown);

    try {
      // First shutdown() runs the teardown path and emits ZANA_SHUTDOWN.
      await result.shutdown();
      expect(shutdownCount).toBe(1);

      // Second shutdown() must short-circuit on the `shuttingDown` guard:
      // it resolves without re-running teardown or re-emitting the event.
      await expect(result.shutdown()).resolves.toBeUndefined();
      expect(shutdownCount).toBe(1);
    } finally {
      bus.off(EVENTS.ZANA_SHUTDOWN, onShutdown);
    }
  });

  // ── REGRESSION TRIPWIRE: auto-router escalation gate (core.ts:209-246) ──────
  // core.ts wires an onTicketCreated listener that, for a ticket carrying an
  // escalation label ("architecture" | "needs-decision" | "invariant") with no
  // bound profile, routes it to the design-only lane via
  // ticketService.escalateForDesign(), which stamps the "awaiting-decision"
  // label and binds the "architect" profile (work/src/tickets/service.ts:181).
  //
  // BUG: the handler's first statement is `moduleConfig.getModuleConfig(...)`,
  // but `moduleConfig` is never imported in core.ts (only `moduleLoader` is).
  // At runtime that throws a ReferenceError which the handler's own try/catch
  // swallows ("[core] auto-assign profile failed"), so the ENTIRE auto-assign
  // and escalation path is dead code — an escalation-labeled ticket is never
  // escalated. This test pins the INTENDED behavior, so it is expected to FAIL
  // The missing `import * as moduleConfig from "./modules/config"` has since been
  // restored in core.ts (found independently by a Claude-Unleashed review pass +
  // a runtime boot probe, 2026-06-17), so this now passes as a normal regression
  // guard. Deterministic: no timers / network; createTicket emits "ticket:created"
  // synchronously on the shared core bus, so the handler has run by the time
  // createTicket() returns.
  it(
    "auto-router escalates an escalation-labeled ticket to the design lane",
    async () => {
      const ws = fs.mkdtempSync(path.join(os.tmpdir(), "zana-core-test-ws-"));
      fs.mkdirSync(path.join(ws, ".zana"), { recursive: true });
      tmpDirs.push(ws);

      const result = await init({ workspace: ws, headless: false });
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const ticketService = require("@zana-ai/work").tickets.service;
        const created = ticketService.createTicket({
          title: "Change a core invariant",
          labels: ["architecture"],
          createdBy: "core-test",
        });
        expect(created.error).toBeUndefined();

        const after = ticketService.getTicket(created.id);
        // Intended outcome of the escalation gate: parked for a human + architect bound.
        expect(after.labels).toContain("awaiting-decision");
        expect(after.assigneeProfileId).toBe("architect");
      } finally {
        await result.shutdown();
      }
    },
  );

  // ── REGRESSION TRIPWIRE: auto-router needs-triage fall-through (core.ts) ─────
  // Companion to the escalation tripwire above. core.ts's onTicketCreated bridge
  // documents that LOW router confidence is NOT escalation: a routine ticket
  // carrying no escalation label ("architecture"|"needs-decision"|"invariant")
  // falls through to ticketService.assignProfile(). With no routing history in a
  // fresh workspace the router has no confident pick (score < the 0.15 floor), so
  // assignProfile is called with a null profileId and tags the ticket
  // `needs-triage` for a human (work/src/tickets/service.ts:165-174) — it must
  // NOT burn an architect on the design lane.
  //
  // BUG (same root cause as the escalation tripwire): core.ts references
  // `moduleConfig` without importing it, so the handler throws a swallowed
  // ReferenceError and this fall-through never ran. The missing moduleConfig
  // import has since been restored in core.ts, so this now passes as a normal
  // regression guard. Deterministic: no timers/network; createTicket emits
  // "ticket:created" synchronously, and a routine low-signal title yields no
  // confident route.
  it(
    "auto-router tags a routine, unroutable ticket needs-triage (not escalated)",
    async () => {
      const ws = fs.mkdtempSync(path.join(os.tmpdir(), "zana-core-test-ws-"));
      fs.mkdirSync(path.join(ws, ".zana"), { recursive: true });
      tmpDirs.push(ws);

      const result = await init({ workspace: ws, headless: false });
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const ticketService = require("@zana-ai/work").tickets.service;
        const created = ticketService.createTicket({
          title: "Tweak the xyzzy widget margins",
          labels: [], // no escalation label → fall through to assignProfile
          createdBy: "core-test",
        });
        expect(created.error).toBeUndefined();

        const after = ticketService.getTicket(created.id);
        // Intended outcome: flagged for human triage, NOT routed to the design lane.
        expect(after.labels).toContain("needs-triage");
        expect(after.labels).not.toContain("awaiting-decision");
        expect(after.assigneeProfileId).not.toBe("architect");
      } finally {
        await result.shutdown();
      }
    },
  );

  // ── auto-router kill-switch (core.ts onTicketCreated) ───────────────────────
  // The handler's FIRST decision is the opt-out gate:
  //   const sys = moduleConfig.getModuleConfig("system") || {};
  //   if (sys.autoAssignProfile === false) return;
  // When `autoAssignProfile` is set to false on the "system" module config, the
  // handler must short-circuit BEFORE any routing/assignment — the ticket stays
  // exactly as created: no `needs-triage`, no `awaiting-decision`, and the
  // assigneeProfileId left null. Every other auto-router test runs with the gate
  // at its default (enabled), so the disabled branch — the user's kill-switch —
  // is otherwise unexercised; a regression that dropped the `=== false` guard
  // would silently auto-assign tickets a human asked it to leave alone.
  //
  // The handler reads the BUILT core's config singleton, so we toggle it through
  // the same instance ((core as any).modules.config) and restore it in finally
  // to avoid leaking the disabled state into the process-wide config cache.
  // Deterministic: no timers/network; createTicket emits "ticket:created"
  // synchronously, so the handler has run by the time createTicket() returns.
  it(
    "auto-router leaves the ticket untouched when autoAssignProfile is disabled",
    async () => {
      const ws = fs.mkdtempSync(path.join(os.tmpdir(), "zana-core-test-ws-"));
      fs.mkdirSync(path.join(ws, ".zana"), { recursive: true });
      tmpDirs.push(ws);

      const result = await init({ workspace: ws, headless: false });
      const moduleConfig = (core as any).modules.config;
      try {
        // Flip the kill-switch AFTER init() (so init's config load can't clobber
        // it) and BEFORE createTicket() fires the synchronous handler.
        moduleConfig.setModuleConfig("system", { autoAssignProfile: false });

        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const ticketService = require("@zana-ai/work").tickets.service;
        const created = ticketService.createTicket({
          title: "Tweak the xyzzy widget margins",
          labels: [],
          createdBy: "core-test",
        });
        expect(created.error).toBeUndefined();

        const after = ticketService.getTicket(created.id);
        // Gate fired first → handler returned → ticket is pristine.
        expect(after.labels).not.toContain("needs-triage");
        expect(after.labels).not.toContain("awaiting-decision");
        expect(after.assigneeProfileId).toBeNull();
      } finally {
        // Re-enable so the disabled state never leaks to later runs.
        moduleConfig.setModuleConfig("system", { autoAssignProfile: true });
        await result.shutdown();
      }
    },
  );

  // ── auto-router LATE-LABEL escalation via "ticket:updated" (core.ts:255-258) ─
  // Distinct from the create-time escalation gate: core.ts also wires a second
  // listener onto "ticket:updated" so a ticket that gains an escalation label
  // *after* creation still escalates. The handler intentionally only re-routes
  // when the update touched `labels` (`if (fields.includes("labels"))`) so a
  // routine field edit never burns an architect. Every other auto-router test
  // fires only "ticket:created", so this relabel-driven path is otherwise
  // unexercised. Here a routine ticket is created (→ needs-triage, no bound
  // profile), then relabeled "architecture"; updateTicket emits "ticket:updated"
  // with fields:["labels"] synchronously on the shared core bus, so by the time
  // updateTicket() returns the handler has run and escalateForDesign() has parked
  // the ticket (awaiting-decision) and bound the architect profile.
  // Deterministic: no timers/network.
  it(
    "auto-router escalates a ticket relabeled with an escalation label after creation",
    async () => {
      const ws = fs.mkdtempSync(path.join(os.tmpdir(), "zana-core-test-ws-"));
      fs.mkdirSync(path.join(ws, ".zana"), { recursive: true });
      tmpDirs.push(ws);

      const result = await init({ workspace: ws, headless: false });
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const ticketService = require("@zana-ai/work").tickets.service;
        // Created WITHOUT an escalation label → falls through to needs-triage,
        // assigneeProfileId stays null (no confident route in a fresh workspace).
        const created = ticketService.createTicket({
          title: "Tweak the xyzzy widget margins",
          labels: [],
          createdBy: "core-test",
        });
        expect(created.error).toBeUndefined();
        const before = ticketService.getTicket(created.id);
        expect(before.labels).toContain("needs-triage");
        expect(before.assigneeProfileId).toBeNull();
        expect(before.labels).not.toContain("awaiting-decision");

        // Relabel with an escalation label. This fires "ticket:updated" with
        // fields:["labels"], which the late-label listener acts on.
        const updated = ticketService.updateTicket(
          created.id,
          { labels: ["architecture"] },
          "core-test",
        );
        expect(updated.error).toBeUndefined();

        const after = ticketService.getTicket(created.id);
        // Intended outcome of the relabel escalation: parked + architect bound.
        expect(after.labels).toContain("awaiting-decision");
        expect(after.assigneeProfileId).toBe("architect");
      } finally {
        await result.shutdown();
      }
    },
  );

  // ── auto-router NON-LABEL update is ignored (negative arm of core.ts:255-258) ─
  // The "ticket:updated" listener guards routeTicket behind `fields.includes(
  // "labels")` so "a routine field edit never burns an architect" (core.ts
  // comment). The sibling relabel test exercises the POSITIVE arm (a labels edit
  // escalates); this pins the NEGATIVE arm — a non-label edit must NOT escalate,
  // even when the ticket is fully escalation-eligible (carries an "architecture"
  // label, has no bound profile, and is not yet parked). We manufacture that
  // eligible-but-unescalated state by creating the ticket with the kill-switch
  // OFF (so create-time routing is skipped, leaving the escalation label intact
  // and the profile null), then re-enable routing and edit only the title. If a
  // regression dropped the `fields.includes("labels")` guard, routeTicket would
  // run on the title edit and escalate the ticket to the design lane.
  // Deterministic: no timers/network; updateTicket emits "ticket:updated" with
  // fields:["title"] synchronously on the shared core bus.
  it(
    "auto-router does NOT escalate on a non-label update of an escalation-eligible ticket",
    async () => {
      const ws = fs.mkdtempSync(path.join(os.tmpdir(), "zana-core-test-ws-"));
      fs.mkdirSync(path.join(ws, ".zana"), { recursive: true });
      tmpDirs.push(ws);

      const result = await init({ workspace: ws, headless: false });
      const moduleConfig = (core as any).modules.config;
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const ticketService = require("@zana-ai/work").tickets.service;

        // Create with the kill-switch OFF so the create-time handler short-
        // circuits: the "architecture" label survives unescalated and no profile
        // is bound — exactly the eligible-but-unescalated state we need.
        moduleConfig.setModuleConfig("system", { autoAssignProfile: false });
        const created = ticketService.createTicket({
          title: "Original title",
          labels: ["architecture"],
          createdBy: "core-test",
        });
        expect(created.error).toBeUndefined();
        const before = ticketService.getTicket(created.id);
        expect(before.labels).toContain("architecture");
        expect(before.labels).not.toContain("awaiting-decision");
        expect(before.assigneeProfileId).toBeNull();

        // Re-enable routing, then edit ONLY the title. ticket:updated carries
        // fields:["title"] → the guard skips routeTicket → no escalation.
        moduleConfig.setModuleConfig("system", { autoAssignProfile: true });
        const updated = ticketService.updateTicket(
          created.id,
          { title: "Edited title" },
          "core-test",
        );
        expect(updated.error).toBeUndefined();

        const after = ticketService.getTicket(created.id);
        expect(after.title).toBe("Edited title");
        // Negative arm: a non-label edit must leave escalation untouched.
        expect(after.labels).not.toContain("awaiting-decision");
        expect(after.assigneeProfileId).toBeNull();
      } finally {
        // Restore the default so the disabled state never leaks to later runs.
        moduleConfig.setModuleConfig("system", { autoAssignProfile: true });
        await result.shutdown();
      }
    },
  );

  // ── auto-router "already parked" guard (core.ts: `if (labels.includes(
  //    "awaiting-decision")) return;`) ───────────────────────────────────────
  // routeTicket() short-circuits a ticket that already carries the
  // "awaiting-decision" label ("Already parked for a human — don't re-route.").
  // Every other auto-router test reaches that label only THROUGH escalation,
  // which also binds the "architect" profile — so the EARLIER
  // `if (ticket.assigneeProfileId) return;` guard shadows the parked guard and
  // it never gets to decide anything. This isolates the parked guard on its own:
  // a ticket created already-parked but with NO bound profile and NO escalation
  // label. Without the guard the handler would fall through to assignProfile()
  // and tag it `needs-triage` (the routine fall-through proven by a sibling
  // test); WITH the guard it returns first and the ticket stays pristine. Pins a
  // regression that dropped the parked guard from silently re-triaging a ticket a
  // human already pulled aside for a decision. Deterministic: no timers/network;
  // createTicket emits "ticket:created" synchronously on the shared core bus.
  it(
    "auto-router leaves an already-parked (awaiting-decision) ticket untouched",
    async () => {
      const ws = fs.mkdtempSync(path.join(os.tmpdir(), "zana-core-test-ws-"));
      fs.mkdirSync(path.join(ws, ".zana"), { recursive: true });
      tmpDirs.push(ws);

      const result = await init({ workspace: ws, headless: false });
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const ticketService = require("@zana-ai/work").tickets.service;
        // Parked for a human up front (no escalation label, no bound profile).
        const created = ticketService.createTicket({
          title: "Tweak the xyzzy widget margins",
          labels: ["awaiting-decision"],
          createdBy: "core-test",
        });
        expect(created.error).toBeUndefined();

        const after = ticketService.getTicket(created.id);
        // Parked guard fired first → handler returned → ticket is pristine:
        // still parked, never re-triaged, no profile burned.
        expect(after.labels).toContain("awaiting-decision");
        expect(after.labels).not.toContain("needs-triage");
        expect(after.assigneeProfileId).toBeNull();
      } finally {
        await result.shutdown();
      }
    },
  );

  // ── auto-router CONFIGURABLE escalation labels (core.ts:233-236) ─────────────
  // The escalation gate's trigger set is not hard-coded: it reads
  //   const escalationLabels = Array.isArray(sys.escalationLabels)
  //     ? sys.escalationLabels
  //     : ["architecture", "needs-decision", "invariant"];
  // so an operator can REPLACE the defaults via system.escalationLabels. Every
  // other auto-router test runs with the built-in defaults, so this override —
  // the documented config knob — is otherwise unexercised. This pins BOTH arms
  // of the override in one focused behavior: (1) a ticket carrying the custom
  // label escalates to the design lane (awaiting-decision + architect bound),
  // and (2) a ticket carrying the now-removed default label ("architecture")
  // NO LONGER escalates and instead falls through to needs-triage. A regression
  // that ignored sys.escalationLabels (reverting to the hard-coded defaults)
  // would fail arm (1); one that merged instead of replaced would fail arm (2).
  // Config is toggled on the BUILT core's singleton ((core as any).modules.config)
  // and restored in finally so the override never leaks into later runs.
  // Deterministic: no timers/network; createTicket emits "ticket:created"
  // synchronously on the shared core bus.
  it(
    "auto-router honors a custom system.escalationLabels override (replaces defaults)",
    async () => {
      const ws = fs.mkdtempSync(path.join(os.tmpdir(), "zana-core-test-ws-"));
      fs.mkdirSync(path.join(ws, ".zana"), { recursive: true });
      tmpDirs.push(ws);

      const result = await init({ workspace: ws, headless: false });
      const moduleConfig = (core as any).modules.config;
      try {
        // Replace the default escalation set with a single custom label.
        moduleConfig.setModuleConfig("system", { escalationLabels: ["red-alert"] });

        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const ticketService = require("@zana-ai/work").tickets.service;

        // Arm 1: the custom label escalates to the design lane.
        const custom = ticketService.createTicket({
          title: "Custom-escalation ticket",
          labels: ["red-alert"],
          createdBy: "core-test",
        });
        expect(custom.error).toBeUndefined();
        const afterCustom = ticketService.getTicket(custom.id);
        expect(afterCustom.labels).toContain("awaiting-decision");
        expect(afterCustom.assigneeProfileId).toBe("architect");

        // Arm 2: the now-removed default label does NOT escalate — the override
        // replaces the defaults, so "architecture" falls through to needs-triage.
        const dflt = ticketService.createTicket({
          title: "Tweak the xyzzy widget margins",
          labels: ["architecture"],
          createdBy: "core-test",
        });
        expect(dflt.error).toBeUndefined();
        const afterDflt = ticketService.getTicket(dflt.id);
        expect(afterDflt.labels).not.toContain("awaiting-decision");
        expect(afterDflt.labels).toContain("needs-triage");
        expect(afterDflt.assigneeProfileId).not.toBe("architect");
      } finally {
        // Restore the default config so the override never leaks to later runs.
        moduleConfig.setModuleConfig("system", { escalationLabels: undefined });
        await result.shutdown();
      }
    },
  );
});

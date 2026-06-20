// Tests for the scheduling store: YAML/JSON round-trip, YAML-wins-over-JSON
// deduplication in listSchedules, and run-history append/update invariants.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import * as workspaceContextTs from "@zana-ai/contracts";
import * as core from "@zana-ai/core";
import * as store from "@zana-ai/work/src/scheduling/store.ts";

// Both the .ts source and the compiled dist may be different module instances;
// initialize and reset both to avoid cross-test bleed (same pattern as events/store.test.ts).
const wcDist: any = (core as any).project?.workspaceContext ?? (core as any).default?.project?.workspaceContext;

function resetWorkspace() {
  for (const wc of [workspaceContextTs as any, wcDist]) {
    try {
      if (wc && typeof wc._resetForTesting === "function") wc._resetForTesting();
    } catch {}
  }
}

function initWorkspace(root: string) {
  // Pre-create .zana/ so resolveProjectDir stops here and does NOT walk up
  // to /tmp/.zana/ (which accumulates cross-test state from previous runs).
  mkdirSync(join(root, ".zana"), { recursive: true });
  workspaceContextTs.init(root);
  if (wcDist && typeof wcDist.init === "function") wcDist.init(root);
}

describe("scheduling/store", () => {
  let tmpRoot: string;

  function schedulerDir() {
    return wcDist.getProjectPaths().schedulerDir as string;
  }

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "zana-sched-store-"));
    initWorkspace(tmpRoot);
  });

  afterEach(() => {
    resetWorkspace();
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  });

  // ── listSchedules ──────────────────────────────────────────────────────────

  it("listSchedules returns empty array when directory is empty", () => {
    expect(store.listSchedules()).toEqual([]);
  });

  it("listSchedules picks up a JSON schedule", () => {
    const sched = { id: "s1", every: "5m", updatedAt: new Date().toISOString() };
    store.saveSchedule(sched);
    const list = store.listSchedules();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe("s1");
    expect(list[0]._format).toBe("json");
  });

  it("listSchedules prefers YAML over JSON when both exist for the same id", () => {
    const base = { id: "s2", every: "10m", updatedAt: new Date().toISOString() };
    // Write both formats — YAML should win.
    store.saveScheduleYaml(base);
    store.saveSchedule(base);
    const list = store.listSchedules();
    const entry = list.find((s) => s.id === "s2");
    expect(entry).toBeDefined();
    expect(entry!._format).toBe("yaml");
    // Only one entry per id — no duplicates.
    expect(list.filter((s) => s.id === "s2")).toHaveLength(1);
  });

  it("listSchedules ignores .example files", () => {
    // Ensure the directory exists first, then place an example file.
    store.ensureDir();
    writeFileSync(
      join(schedulerDir(), "example-schedule.yml.example"),
      "id: example\nevery: 1h\n",
      "utf8"
    );
    expect(store.listSchedules()).toHaveLength(0);
  });

  // ── getSchedule ────────────────────────────────────────────────────────────

  it("getSchedule returns null for an unknown id", () => {
    expect(store.getSchedule("nonexistent")).toBeNull();
  });

  it("getSchedule reads a JSON schedule and marks _format=json", () => {
    const sched = { id: "j1", every: "1h" };
    store.saveSchedule(sched);
    const loaded = store.getSchedule("j1");
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe("j1");
    expect(loaded!._format).toBe("json");
  });

  it("getSchedule reads a YAML schedule and marks _format=yaml", () => {
    const sched = { id: "y1", every: "1h" };
    store.saveScheduleYaml(sched);
    const loaded = store.getSchedule("y1");
    expect(loaded!._format).toBe("yaml");
  });

  it("getSchedule prefers YAML when both files exist", () => {
    const base = { id: "dual", every: "2h" };
    store.saveSchedule(base);
    store.saveScheduleYaml(base);
    expect(store.getSchedule("dual")!._format).toBe("yaml");
  });

  // ── saveScheduleSameFormat ─────────────────────────────────────────────────

  it("saveScheduleSameFormat writes JSON when _format=json", () => {
    const sched = { id: "fmt-json", every: "5m", _format: "json" };
    store.saveScheduleSameFormat(sched);
    const loaded = store.getSchedule("fmt-json");
    expect(loaded!._format).toBe("json");
  });

  it("saveScheduleSameFormat writes YAML for new schedules (no _format)", () => {
    const sched = { id: "fmt-new", every: "5m" };
    store.saveScheduleSameFormat(sched);
    const loaded = store.getSchedule("fmt-new");
    expect(loaded!._format).toBe("yaml");
  });

  // ── deleteSchedule ─────────────────────────────────────────────────────────

  it("deleteSchedule removes JSON file", () => {
    store.saveSchedule({ id: "del1", every: "1h" });
    store.deleteSchedule("del1");
    expect(store.getSchedule("del1")).toBeNull();
  });

  it("deleteSchedule removes YAML file", () => {
    store.saveScheduleYaml({ id: "del2", every: "1h" });
    store.deleteSchedule("del2");
    expect(store.getSchedule("del2")).toBeNull();
  });

  // ── appendRunResult / getRunHistory ────────────────────────────────────────

  it("appendRunResult persists a single run entry", () => {
    store.saveScheduleYaml({ id: "hist1", every: "1h" });
    const result = { runAt: "2024-01-01T00:00:00Z", agentId: "agent-1", status: "ok" };
    store.appendRunResult("hist1", result);
    const history = store.getRunHistory("hist1");
    expect(history).toHaveLength(1);
    expect(history[0].agentId).toBe("agent-1");
  });

  it("appendRunResult trims history to the retain limit", () => {
    // Schedule with retain=3 so we can observe capping without writing many entries.
    store.saveScheduleYaml({ id: "hist2", every: "1h", history: { enabled: true, retain: 3 } });
    for (let i = 0; i < 5; i++) {
      store.appendRunResult("hist2", { runAt: `2024-01-0${i + 1}T00:00:00Z`, agentId: `a${i}` });
    }
    const history = store.getRunHistory("hist2");
    expect(history).toHaveLength(3);
    // Most recent entries are kept.
    expect(history[2].agentId).toBe("a4");
  });

  it("appendRunResult does not write history when history.enabled=false", () => {
    store.saveScheduleYaml({ id: "hist3", every: "1h", history: { enabled: false } });
    store.appendRunResult("hist3", { runAt: "now", agentId: "x" });
    expect(store.getRunHistory("hist3")).toEqual([]);
    expect(existsSync(join(schedulerDir(), "hist3.history.json"))).toBe(false);
  });

  // ── updateRunResult ────────────────────────────────────────────────────────

  it("updateRunResult patches the most recent entry matching agentId", () => {
    store.saveScheduleYaml({ id: "upd1", every: "1h" });
    store.appendRunResult("upd1", { runAt: "t1", agentId: "agent-A", status: "running" });
    store.appendRunResult("upd1", { runAt: "t2", agentId: "agent-B", status: "running" });
    const patched = store.updateRunResult("upd1", "agent-A", { status: "done", summary: "all good" });
    expect(patched).not.toBeNull();
    expect(patched!.status).toBe("done");
    expect(patched!.summary).toBe("all good");
    // agent-B is unaffected.
    const history = store.getRunHistory("upd1");
    expect(history.find((h: any) => h.agentId === "agent-B")!.status).toBe("running");
  });

  it("updateRunResult returns null when agentId is not in history", () => {
    store.saveScheduleYaml({ id: "upd2", every: "1h" });
    store.appendRunResult("upd2", { runAt: "t1", agentId: "agent-X", status: "ok" });
    expect(store.updateRunResult("upd2", "agent-MISSING", { status: "done" })).toBeNull();
  });

  it("updateRunResult returns null when history is disabled", () => {
    store.saveScheduleYaml({ id: "upd3", every: "1h", history: { enabled: false } });
    expect(store.updateRunResult("upd3", "any-agent", { status: "done" })).toBeNull();
  });

  it("updateRunResult returns null (no throw, no file) when history is enabled but empty", () => {
    // History enabled by default, but appendRunResult was never called — so
    // getRunHistory() returns []. This hits the `history.length === 0` guard,
    // a distinct early-return from both the disabled and agentId-not-found paths.
    store.saveScheduleYaml({ id: "upd4", every: "1h" });
    expect(store.updateRunResult("upd4", "any-agent", { status: "done" })).toBeNull();
    // The guard must not materialize a history file as a side effect.
    expect(existsSync(join(schedulerDir(), "upd4.history.json"))).toBe(false);
  });
});

// Unit tests for agents/spawn-cwd.ts — resolveConfinedCwd.
//
// This is the security boundary for where a spawned agent runs. The tests use
// REAL temp dirs (no mocks) so realpath/symlink behaviour is exercised for
// real, and stub only the project registry (a ~/.zana/projects.json reader).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Stub the project registry — resolveConfinedCwd calls getById for projectId.
const { mockGetById } = vi.hoisted(() => ({ mockGetById: vi.fn() }));
vi.mock("@zana-ai/core/src/project/registry.ts", () => ({
  getById: mockGetById,
}));

import { resolveConfinedCwd } from "@zana-ai/core/src/agents/spawn-cwd.ts";

let workspace: string;
let outside: string;

beforeEach(() => {
  vi.clearAllMocks();
  // Real dirs, realpath'd so comparisons match what the helper computes
  // (macOS /var → /private/var symlink would otherwise trip a naive test).
  workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "scwd-ws-")));
  outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "scwd-out-")));
  fs.mkdirSync(path.join(workspace, "sub", "deep"), { recursive: true });
});

afterEach(() => {
  for (const d of [workspace, outside]) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
  }
});

describe("resolveConfinedCwd — default (no cwd, no projectId)", () => {
  it("returns the workspace root unchanged", () => {
    const r = resolveConfinedCwd({ workspace });
    expect(r).toEqual({ cwd: workspace });
  });
});

describe("resolveConfinedCwd — explicit cwd inside the workspace", () => {
  it("accepts the workspace root itself", () => {
    expect(resolveConfinedCwd({ cwd: workspace, workspace })).toEqual({ cwd: workspace });
  });

  it("accepts a nested subdirectory", () => {
    const sub = path.join(workspace, "sub", "deep");
    expect(resolveConfinedCwd({ cwd: sub, workspace })).toEqual({ cwd: sub });
  });

  it("collapses a `..` that stays inside the workspace", () => {
    const viaDotDot = path.join(workspace, "sub", "..", "sub", "deep");
    expect(resolveConfinedCwd({ cwd: viaDotDot, workspace })).toEqual({
      cwd: path.join(workspace, "sub", "deep"),
    });
  });
});

describe("resolveConfinedCwd — escape attempts are refused", () => {
  it("refuses an absolute path outside the workspace", () => {
    const r = resolveConfinedCwd({ cwd: outside, workspace });
    expect("error" in r && r.error).toMatch(/must be within the workspace/);
  });

  it("refuses a `../` traversal that climbs out", () => {
    const escape = path.join(workspace, "..", "..");
    const r = resolveConfinedCwd({ cwd: escape, workspace });
    expect("error" in r).toBe(true);
  });

  it("refuses a sibling dir that shares the workspace name prefix", () => {
    // /tmp/scwd-ws-XXXX  vs  /tmp/scwd-ws-XXXX-evil — a naive startsWith would pass.
    const evil = workspace + "-evil";
    fs.mkdirSync(evil, { recursive: true });
    try {
      const r = resolveConfinedCwd({ cwd: evil, workspace });
      expect("error" in r).toBe(true);
    } finally {
      fs.rmSync(evil, { recursive: true, force: true });
    }
  });

  it("refuses a symlink that points OUTSIDE the workspace (realpath escape)", () => {
    const link = path.join(workspace, "escape-link");
    fs.symlinkSync(outside, link);
    const r = resolveConfinedCwd({ cwd: link, workspace });
    // realpath follows the link to `outside`, so it must be refused even though
    // the link path string is lexically inside the workspace.
    expect("error" in r).toBe(true);
  });
});

describe("resolveConfinedCwd — projectId", () => {
  it("refuses an unknown projectId", () => {
    mockGetById.mockReturnValue(null);
    const r = resolveConfinedCwd({ projectId: "proj_missing", workspace });
    expect("error" in r && r.error).toMatch(/unknown projectId/);
  });

  it("uses a registered project's root as the confinement root", () => {
    mockGetById.mockReturnValue({ id: "proj_x", path: outside });
    // No cwd → runs at the project root.
    expect(resolveConfinedCwd({ projectId: "proj_x", workspace })).toEqual({ cwd: outside });
  });

  it("confines an explicit cwd to the PROJECT root, not the workspace", () => {
    mockGetById.mockReturnValue({ id: "proj_x", path: outside });
    const sub = path.join(outside, "pkg");
    fs.mkdirSync(sub, { recursive: true });
    // A cwd inside the project is fine…
    expect(resolveConfinedCwd({ projectId: "proj_x", cwd: sub, workspace })).toEqual({ cwd: sub });
    // …but a cwd inside the *workspace* (not the project) is refused.
    const r = resolveConfinedCwd({ projectId: "proj_x", cwd: workspace, workspace });
    expect("error" in r && r.error).toMatch(/must be within project proj_x/);
  });

  it("refuses a registered project whose path no longer exists", () => {
    mockGetById.mockReturnValue({ id: "proj_gone", path: path.join(outside, "deleted") });
    const r = resolveConfinedCwd({ projectId: "proj_gone", workspace });
    expect("error" in r && r.error).toMatch(/no longer exists/);
  });
});

// Deterministic coverage for migrate()'s two early-return guards in
// project/migrate.ts. The sibling migrate.test.ts only exercises dryRun() and
// explicitly punts on migrate() because GLOBAL_ZANA_DIR is hardcoded to
// ~/.zana. Both guards below run BEFORE migrate() touches require("./init")
// (the part that was hard to test), so we can drive them purely by controlling
// fs.existsSync — no real ~/.zana, no init() resolution, no shared global state.
//
// Strategy mirrors host/detect-fs-fallback.test.ts: vi.mock node:fs with a
// factory that consults a mutable slot at call time, so each test flips the
// filesystem view without re-importing production code.
import { describe, it, expect, beforeEach, vi } from "vitest";
import * as os from "node:os";
import * as path from "node:path";

// Mutable slot the mock factory consults on every existsSync() call.
let existsImpl: (p: string) => boolean = () => false;

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: (p: any) => existsImpl(String(p)),
  };
});

// Import after vi.mock so production code binds the mocked fs.
import { migrate } from "@zana-ai/core/src/project/migrate.ts";

// GLOBAL_ZANA_DIR is computed inside migrate.ts as path.join(os.homedir(), ".zana").
// os is NOT mocked here, so we can reconstruct the exact string the SUT uses.
const GLOBAL_ZANA_DIR = path.join(os.homedir(), ".zana");

describe("migrate() — early-return guards", () => {
  beforeEach(() => {
    existsImpl = () => false;
  });

  it("returns a zero-op summary with a note when ~/.zana does not exist", () => {
    existsImpl = () => false; // GLOBAL_ZANA_DIR absent

    const summary = migrate("/tmp/any-workspace");

    expect(summary.copied).toBe(0);
    expect(summary.skipped).toBe(0);
    expect(summary.errors).toEqual([]);
    expect(summary.notes).toContainEqual(
      `Global zana directory not found: ${GLOBAL_ZANA_DIR}`,
    );
  });

  it("returns a zero-op summary with a note when ~/.zana exists but holds no migratable data", () => {
    // GLOBAL_ZANA_DIR exists, but none of tickets/sprints/artifacts do →
    // hasData is false, so migrate() stops before initializing the workspace.
    existsImpl = (p) => p === GLOBAL_ZANA_DIR;

    const summary = migrate("/tmp/any-workspace");

    expect(summary.copied).toBe(0);
    expect(summary.skipped).toBe(0);
    expect(summary.errors).toEqual([]);
    expect(summary.notes).toContainEqual(
      "No tickets, sprints, or artifacts found in global directory.",
    );
  });

  it("never reports copies or errors from an early return (no workspace mutation implied)", () => {
    // Both guards must leave the summary in its pristine zero state — a caller
    // relying on copied===0 to decide 'nothing happened' must not be misled.
    existsImpl = () => false;
    const summary = migrate("/tmp/any-workspace");
    expect(summary).toMatchObject({ copied: 0, skipped: 0, errors: [] });
    expect(Array.isArray(summary.notes)).toBe(true);
  });
});

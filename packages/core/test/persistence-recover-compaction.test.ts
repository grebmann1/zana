/**
 * Tests for the self-compaction side-effect of recoverInboxes() in
 * packages/core/src/persistence.ts
 *
 * recoverInboxes() does more than return the in-memory inbox Map: as a side
 * effect it rewrites the backing NDJSON file with ONLY the current surviving
 * state (persistence.ts line ~52, "Compact: rewrite file with only current
 * state"). That makes recovery self-healing — every daemon boot collapses the
 * append-only log (messages + drain markers + superseded lines) down to one
 * line per live message, so the file can't grow unbounded across restarts.
 *
 * The existing persistence.test.ts only asserts the returned Map; the on-disk
 * compaction invariant was unasserted. This guards it against regression.
 *
 * Strategy mirrors persistence.test.ts: redirect PERSIST_DIR to a temp dir via
 * doMock BEFORE persistence.ts is imported, then exercise the real fs.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

let tmpDir: string;
let persistDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zana-persist-recover-compact-test-"));
  persistDir = path.join(tmpDir, "persistence");

  vi.resetModules();
  vi.doMock("@zana-ai/contracts", () => ({
    default: { PERSIST_DIR: persistDir },
    PERSIST_DIR: persistDir,
  }));
});

afterEach(() => {
  vi.resetModules();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function loadPersistence() {
  return await import("../src/persistence.ts");
}

function inboxLines(): string[] {
  const inboxFile = path.join(persistDir, "inboxes.ndjson");
  return fs.readFileSync(inboxFile, "utf8").split("\n").filter(Boolean);
}

describe("recoverInboxes self-compaction side-effect", () => {
  it("rewrites the on-disk file to current state only — no drain markers, one line per live message", async () => {
    const p = await loadPersistence();

    // Append-only history: 2 msgs for A, 1 for B, a drain of A, then 1 post-drain msg for A.
    p.persistInboxMessage("agent-A", { type: "old1" });
    p.persistInboxMessage("agent-A", { type: "old2" });
    p.persistInboxMessage("agent-B", { type: "keep" });
    p.persistInboxDrain("agent-A");
    p.persistInboxMessage("agent-A", { type: "fresh" });

    // Pre-recovery: every append is its own line (5 total), including the drain marker.
    expect(inboxLines()).toHaveLength(5);
    expect(inboxLines().some((l) => l.includes('"drained"'))).toBe(true);

    const recovered = p.recoverInboxes();

    // In-memory result: A keeps only the post-drain message; B is untouched.
    expect(recovered.get("agent-A")).toEqual([{ type: "fresh" }]);
    expect(recovered.get("agent-B")).toEqual([{ type: "keep" }]);

    // On-disk side effect: file is compacted to exactly the 2 surviving messages,
    // with the drain marker and superseded lines gone.
    const after = inboxLines();
    expect(after).toHaveLength(2);
    expect(after.some((l) => l.includes('"drained"'))).toBe(false);
    expect(after.some((l) => l.includes('"old1"'))).toBe(false);
    expect(after.some((l) => l.includes('"old2"'))).toBe(false);

    // And recovery is now a fixed point: re-running over the compacted file is stable.
    const second = p.recoverInboxes();
    expect(second.get("agent-A")).toEqual([{ type: "fresh" }]);
    expect(second.get("agent-B")).toEqual([{ type: "keep" }]);
    expect(inboxLines()).toHaveLength(2);
  });
});

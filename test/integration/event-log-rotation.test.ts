// Verifies size-based rotation in events/log.ts:
// when the active file exceeds the configured cap it gets renamed to a
// timestamped sibling and a fresh file starts; old rolled siblings beyond
// retainCount are pruned.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("events/log rotation", () => {
  let log: any;

  beforeEach(async () => {
    log = await import("@zana-ai/core/src/events/log.ts");
  });

  afterEach(() => {
    delete process.env.ZANA_EVENT_LOG_MAX_BYTES;
    delete process.env.ZANA_LOG_RETAIN_COUNT;
  });

  it("rotateIfNeeded is a no-op when file is below cap", () => {
    const tmp = mkdtempSync(join(tmpdir(), "elog-"));
    const f = join(tmp, "events.ndjson");
    writeFileSync(f, "small\n", "utf8");
    log.rotateIfNeeded(f, 1024 * 1024, 5);
    const files = readdirSync(tmp);
    expect(files).toEqual(["events.ndjson"]);
    rmSync(tmp, { recursive: true, force: true });
  });

  it("rotateIfNeeded renames over-cap file to a timestamped sibling", () => {
    const tmp = mkdtempSync(join(tmpdir(), "elog-"));
    const f = join(tmp, "events.ndjson");
    writeFileSync(f, "x".repeat(2048), "utf8");
    log.rotateIfNeeded(f, 1024, 5);
    const files = readdirSync(tmp);
    // active file is gone; one rolled sibling remains
    expect(files.includes("events.ndjson")).toBe(false);
    const rolled = files.filter((n) => n.startsWith("events.") && n.endsWith(".ndjson"));
    expect(rolled.length).toBe(1);
    rmSync(tmp, { recursive: true, force: true });
  });

  it("rotateIfNeeded prunes older rolled siblings beyond retainCount", () => {
    const tmp = mkdtempSync(join(tmpdir(), "elog-"));
    // Pre-seed 4 already-rolled siblings with staggered mtimes.
    const stems = [
      "events.2024-01-01T00-00-00-000Z.ndjson",
      "events.2024-02-01T00-00-00-000Z.ndjson",
      "events.2024-03-01T00-00-00-000Z.ndjson",
      "events.2024-04-01T00-00-00-000Z.ndjson",
    ];
    for (const s of stems) writeFileSync(join(tmp, s), "old", "utf8");
    // Active file exceeds cap, should rotate now and bring count to 5.
    const f = join(tmp, "events.ndjson");
    writeFileSync(f, "x".repeat(2048), "utf8");
    log.rotateIfNeeded(f, 1024, 2); // retain only 2 rolled files
    const files = readdirSync(tmp).filter((n) => n.endsWith(".ndjson"));
    // Active file freshly rotated → 0 active + 2 retained rolled
    expect(files.length).toBe(2);
    rmSync(tmp, { recursive: true, force: true });
  });

  it("append() rotates when ZANA_EVENT_LOG_MAX_BYTES is small", async () => {
    const ws = await import("@zana-ai/contracts");
    const tmpWs = mkdtempSync(join(tmpdir(), "elog-ws-"));
    // Pre-create .zana so resolveProjectDir() stops here and does not walk
    // up the tree to a pre-existing /tmp/.zana or ~/.zana directory.
    mkdirSync(join(tmpWs, ".zana"), { recursive: true });
    ws.init(tmpWs);
    const coreFacade = await import("@zana-ai/core");
    coreFacade.project.workspaceContext.init(tmpWs);
    process.env.ZANA_EVENT_LOG_MAX_BYTES = "256";
    log.init(tmpWs);
    // Each event is ~50-100 bytes; 20 events should easily trip 256.
    for (let i = 0; i < 20; i++) {
      log.append({ event: "tick", i, payload: "x".repeat(40) });
    }
    const sessionsDir = coreFacade.project.workspaceContext.getProjectPaths().sessionsDir;
    const sessions = readdirSync(sessionsDir).filter((n) => !n.startsWith("."));
    expect(sessions.length).toBeGreaterThan(0);
    const sessionPath = join(sessionsDir, sessions[0]);
    const files = readdirSync(sessionPath).filter((n) => n.endsWith(".ndjson"));
    // Expect at least one rolled sibling.
    const rolled = files.filter((n) => n !== "events.ndjson");
    expect(rolled.length).toBeGreaterThanOrEqual(1);
    // Active file should be small (newly written) — under cap.
    const active = files.find((n) => n === "events.ndjson");
    if (active) {
      const sz = statSync(join(sessionPath, active)).size;
      expect(sz).toBeLessThan(1024);
    }
    rmSync(tmpWs, { recursive: true, force: true });
  });
});

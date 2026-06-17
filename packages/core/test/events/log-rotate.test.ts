import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { rotateIfNeeded } from "@zana-ai/core/src/events/log.ts";

let tmpDir: string;

function mkTmp() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zana-log-test-"));
  return tmpDir;
}

afterEach(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("rotateIfNeeded", () => {
  it("is a no-op when the file does not exist", () => {
    const dir = mkTmp();
    const fp = path.join(dir, "events.ndjson");
    // Should not throw
    expect(() => rotateIfNeeded(fp, 100)).not.toThrow();
    expect(fs.readdirSync(dir)).toHaveLength(0);
  });

  it("is a no-op when the file is below the size cap", () => {
    const dir = mkTmp();
    const fp = path.join(dir, "events.ndjson");
    fs.writeFileSync(fp, "small");
    rotateIfNeeded(fp, 1_000);
    // Original file still present, no sibling rolled files
    expect(fs.existsSync(fp)).toBe(true);
    expect(fs.readdirSync(dir)).toHaveLength(1);
  });

  it("rotates the file when size meets or exceeds maxBytes", () => {
    const dir = mkTmp();
    const fp = path.join(dir, "events.ndjson");
    fs.writeFileSync(fp, "x".repeat(200));
    rotateIfNeeded(fp, 100);
    // Original file should be gone (renamed)
    expect(fs.existsSync(fp)).toBe(false);
    const entries = fs.readdirSync(dir);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatch(/^events\..+\.ndjson$/);
  });

  it("rolled file preserves original content", () => {
    const dir = mkTmp();
    const fp = path.join(dir, "events.ndjson");
    const content = "line1\nline2\n";
    fs.writeFileSync(fp, content);
    rotateIfNeeded(fp, 1);
    const rolled = fs.readdirSync(dir)[0];
    expect(fs.readFileSync(path.join(dir, rolled), "utf8")).toBe(content);
  });

  it("prunes rolled siblings beyond retainCount", () => {
    const dir = mkTmp();
    const fp = path.join(dir, "events.ndjson");

    // Pre-populate 5 rolled siblings (they will all have the same mtime, but
    // the prune path only deletes extras beyond retainCount)
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(path.join(dir, `events.2024-01-0${i + 1}T00-00-00.ndjson`), "old");
    }

    // Write live file large enough to trigger rotation with retainCount=2
    fs.writeFileSync(fp, "x".repeat(200));
    rotateIfNeeded(fp, 100, 2);

    // Original gone; newly-rolled file counts as one of the retainCount=2
    // retained entries, so only 2 files survive total.
    const entries = fs.readdirSync(dir);
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.startsWith("events."))).toBe(true);
  });

  // The prune step filters rolled siblings by BOTH the `${stem}.` prefix AND
  // the same extension (log.ts lines 91-92: `f.startsWith(prefix) && ... &&
  // f.endsWith(ext)`). So rotating `events.ndjson` must only ever delete other
  // `events.*.ndjson` rolls — a same-stem file with a DIFFERENT extension
  // (e.g. an `events.*.json` metadata sidecar) and any unrelated file must be
  // left untouched, even with an aggressive retainCount=0 that prunes every
  // matching roll. The existing prune test only uses same-extension siblings,
  // leaving this isolation invariant unpinned.
  it("prunes only same-extension siblings, leaving other-ext and unrelated files intact", () => {
    const dir = mkTmp();
    const fp = path.join(dir, "events.ndjson");

    const sameExtRoll = path.join(dir, "events.2024-01-01T00-00-00.ndjson"); // prunable
    const otherExtSibling = path.join(dir, "events.2024-01-01T00-00-00.json"); // same stem, diff ext
    const unrelated = path.join(dir, "other.ndjson"); // different stem
    fs.writeFileSync(sameExtRoll, "old");
    fs.writeFileSync(otherExtSibling, "meta");
    fs.writeFileSync(unrelated, "unrelated");

    // Large live file + retainCount=0 → every matching .ndjson roll is pruned
    // (including the freshly-rolled one).
    fs.writeFileSync(fp, "x".repeat(200));
    rotateIfNeeded(fp, 100, 0);

    expect(fs.existsSync(fp)).toBe(false); // live file rotated away
    // No `events.*.ndjson` rolls remain — all matching siblings pruned.
    expect(fs.readdirSync(dir).filter((f) => f.startsWith("events.") && f.endsWith(".ndjson")))
      .toHaveLength(0);
    // Different-extension same-stem sidecar is NOT swept up by rotation.
    expect(fs.existsSync(otherExtSibling)).toBe(true);
    expect(fs.readFileSync(otherExtSibling, "utf8")).toBe("meta");
    // Unrelated-stem file is untouched.
    expect(fs.existsSync(unrelated)).toBe(true);
  });

  it("works with files that have no extension", () => {
    const dir = mkTmp();
    const fp = path.join(dir, "mylog");
    fs.writeFileSync(fp, "x".repeat(50));
    rotateIfNeeded(fp, 10);
    expect(fs.existsSync(fp)).toBe(false);
    const rolled = fs.readdirSync(dir)[0];
    expect(rolled).toMatch(/^mylog\./);
  });
});

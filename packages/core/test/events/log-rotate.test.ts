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

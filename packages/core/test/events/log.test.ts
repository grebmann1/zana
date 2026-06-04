import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { rotateIfNeeded } from "../../src/events/log.ts";

// ── helpers ────────────────────────────────────────────────────────────────────

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "zana-log-test-"));
}

const created: string[] = [];
function makeTmpDir(): string {
  const d = tmpDir();
  created.push(d);
  return d;
}

afterEach(() => {
  for (const d of created.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
  }
});

function writeFile(filePath: string, sizeBytes: number): void {
  fs.writeFileSync(filePath, Buffer.alloc(sizeBytes, "x"));
}

// ── rotateIfNeeded ─────────────────────────────────────────────────────────────

describe("rotateIfNeeded", () => {
  it("is a no-op when the file does not exist", () => {
    const dir = makeTmpDir();
    const p = path.join(dir, "events.ndjson");
    // must not throw
    rotateIfNeeded(p, 100);
    expect(fs.existsSync(p)).toBe(false);
  });

  it("is a no-op when the file is under the size limit", () => {
    const dir = makeTmpDir();
    const p = path.join(dir, "events.ndjson");
    writeFile(p, 50);
    rotateIfNeeded(p, 100);
    // original file still there and unchanged
    expect(fs.existsSync(p)).toBe(true);
    expect(fs.statSync(p).size).toBe(50);
    expect(fs.readdirSync(dir)).toHaveLength(1);
  });

  it("renames the file to a timestamped sibling when it exceeds maxBytes", () => {
    const dir = makeTmpDir();
    const p = path.join(dir, "events.ndjson");
    writeFile(p, 200);
    rotateIfNeeded(p, 100);
    // original file is gone (rotated away)
    expect(fs.existsSync(p)).toBe(false);
    // exactly one rolled file remains
    const entries = fs.readdirSync(dir);
    expect(entries).toHaveLength(1);
    // rolled file preserves the stem and extension
    expect(entries[0]).toMatch(/^events\..+\.ndjson$/);
  });

  it("preserves file content in the rolled file", () => {
    const dir = makeTmpDir();
    const p = path.join(dir, "data.ndjson");
    fs.writeFileSync(p, '{"hello":"world"}\n');
    rotateIfNeeded(p, 1); // 1 byte limit forces rotation
    const rolled = fs.readdirSync(dir)[0];
    expect(fs.readFileSync(path.join(dir, rolled), "utf8")).toBe('{"hello":"world"}\n');
  });

  it("prunes oldest rolled siblings when count exceeds retainCount", () => {
    const dir = makeTmpDir();
    const p = path.join(dir, "events.ndjson");

    // Seed 5 existing rolled files with staggered mtimes
    const stem = "events";
    const ext = ".ndjson";
    for (let i = 0; i < 5; i++) {
      const rolled = path.join(dir, `${stem}.2024-01-0${i + 1}T00-00-00${ext}`);
      fs.writeFileSync(rolled, `old-${i}`);
      // space out mtimes so sort is stable
      const mtime = new Date(Date.now() - (5 - i) * 10_000);
      fs.utimesSync(rolled, mtime, mtime);
    }

    // Now rotate the current file with retainCount=3
    writeFile(p, 200);
    rotateIfNeeded(p, 100, 3);

    const remaining = fs.readdirSync(dir);
    // retainCount=3: prune keeps the 3 newest rolled files (freshly-rolled
    // counts as one of them), so exactly 3 files total survive.
    expect(remaining).toHaveLength(3);
  });

  it("handles files without an extension", () => {
    const dir = makeTmpDir();
    const p = path.join(dir, "mylog");
    writeFile(p, 200);
    rotateIfNeeded(p, 100);
    const entries = fs.readdirSync(dir);
    expect(entries).toHaveLength(1);
    // rolled file should start with the stem
    expect(entries[0]).toMatch(/^mylog\./);
  });
});

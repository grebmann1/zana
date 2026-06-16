// Formatting-contract test for packages/core/src/agents/profile-store.ts.
//
// saveProfile() writes the profile as `JSON.stringify(profile, null, 2) + "\n"`
// — i.e. 2-space-indented, human-diffable JSON terminated by a single POSIX
// trailing newline. The sibling profile-store.test.ts pins the *semantics*
// (id/timestamps/builtIn/round-trip) but never the *on-disk byte format*. A
// regression that dropped the indent (compact JSON) or the trailing newline
// would slip past every existing test while churning git diffs and breaking
// any tool that expects newline-terminated files. This pins that contract.
//
// Same HOME-redirect strategy as profile-store.test.ts: config.ts derives
// PROFILES_DIR from os.homedir() at module-load time, so the redirect must
// happen in vi.hoisted() before any @zana-ai/* import.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const { fakeHome, origHome } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const _fs = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const _path = require("node:path") as typeof import("node:path");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const _os = require("node:os") as typeof import("node:os");
  const fakeHome = _fs.mkdtempSync(_path.join(_os.tmpdir(), "zana-profile-store-format-"));
  const origHome = process.env.HOME;
  process.env.HOME = fakeHome;
  return { fakeHome, origHome };
});

import * as profileStore from "@zana-ai/core/src/agents/profile-store.ts";

const profilesTestDir = path.join(fakeHome, ".zana", "profiles");

beforeAll(() => {
  fs.mkdirSync(profilesTestDir, { recursive: true });
});

afterAll(() => {
  process.env.HOME = origHome;
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

describe("saveProfile on-disk format", () => {
  it("writes 2-space-indented JSON terminated by a single trailing newline", () => {
    profileStore.saveProfile({ id: "fmt-check", displayName: "Formatted" } as any);

    const raw = fs.readFileSync(path.join(profilesTestDir, "fmt-check.json"), "utf8");

    // Exactly one trailing newline (POSIX), not zero and not a doubled blank line.
    expect(raw.endsWith("}\n")).toBe(true);
    expect(raw.endsWith("}\n\n")).toBe(false);

    // 2-space indentation, not compact: top-level keys sit at two spaces.
    expect(raw).toContain('\n  "id": "fmt-check"');
    expect(raw).not.toContain('{"id":'); // compact form must not appear

    // The body (newline stripped) is valid JSON that round-trips the fields.
    const parsed = JSON.parse(raw);
    expect(parsed.id).toBe("fmt-check");
    expect(parsed.displayName).toBe("Formatted");
  });
});

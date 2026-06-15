// Regression test for built-in profile resolution robustness.
//
// Background: profiles/*.json are JSON assets tsc does not emit. The build's
// copy-assets step lands them at dist/src/profiles, and builtInDir() resolves
// them across dist/source layouts. Before hardening, a clean dist (or a
// resolution path that missed the source profiles/ dir) silently returned ZERO
// built-in profiles, so every auto-spawned reviewer/worker failed to find its
// persona with no error.
//
// This test runs in source mode (__dirname = src/agents), where builtInDir()
// resolves <pkg>/profiles via the ../../profiles candidate. It asserts the
// shipped personas actually load — in particular code-reviewer and architect,
// which the ticket-watcher auto-spawns — and that the source fallback (the
// last-resort net) works.
//
// The dist-mode regression itself (a clean `rm -rf dist && build` must populate
// dist/src/profiles, else zero personas resolve) is covered by the build's
// copy-assets step and verified at build time, not here — unit tests run in
// source mode and never exercise the dist layout.

import { describe, it, expect, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// Redirect HOME so the user-profile dir is an empty tmpdir — isolates the
// built-in set from any real ~/.zana/profiles on the host.
const { fakeHome, origHome } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const _fs = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const _path = require("node:path") as typeof import("node:path");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const _os = require("node:os") as typeof import("node:os");
  const fakeHome = _fs.mkdtempSync(_path.join(_os.tmpdir(), "zana-builtin-res-home-"));
  const origHome = process.env.HOME;
  process.env.HOME = fakeHome;
  return { fakeHome, origHome };
});

import * as profileStore from "@zana-ai/core/src/agents/profile-store.ts";

describe("built-in profile resolution", () => {
  it("loads the shipped built-in personas, including code-reviewer and architect", () => {
    const all = profileStore.listProfiles();
    const builtIns = all.filter((p: any) => p.builtIn === true);

    // The package ships 18 built-in personas; assert a healthy floor rather
    // than an exact count so adding a persona doesn't break the test.
    expect(builtIns.length).toBeGreaterThanOrEqual(10);

    const ids = builtIns.map((p: any) => p.id);
    expect(ids).toContain("code-reviewer");
    expect(ids).toContain("architect");
  });

  it("getProfile resolves a built-in persona with its systemPrompt and tool sandbox", () => {
    const reviewer = profileStore.getProfile("code-reviewer");
    expect(reviewer).not.toBeNull();
    expect(reviewer.builtIn).toBe(true);
    expect(typeof reviewer.systemPrompt).toBe("string");
    expect(reviewer.systemPrompt.length).toBeGreaterThan(0);
    // The reviewer must stay read-only — Write/Edit are blocked.
    expect(reviewer.disallowedTools).toContain("Write");
    expect(reviewer.disallowedTools).toContain("Edit");
  });

  it("does not warn about empty built-ins on a healthy install", () => {
    // Guards against a regression where the empty-built-ins warning fires
    // spuriously when personas ARE resolving. (The positive case — warning on a
    // genuinely empty dir — is covered by the clean-build verification in the
    // build script, not unit-mockable here without heavy fs stubbing.)
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      profileStore.listProfiles();
      const emptyWarn = warnSpy.mock.calls.find((c) =>
        String(c[0]).includes("0 built-in profiles found"),
      );
      expect(emptyWarn).toBeUndefined();
    } finally {
      warnSpy.mockRestore();
    }
  });
});

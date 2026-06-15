// dryRun() — non-empty discovery + file-filtering branch.
//
// The sibling migrate.test.ts only exercises dryRun() against the test host's
// real (typically empty) ~/.zana, so it pins structural contracts but never the
// branch where dryRun() actually discovers records: reading each MIGRATE_DIR,
// filtering out `_index.json` and non-`.json` entries, and mapping every
// surviving record to a {source, target} pair. This file covers exactly that.
//
// Determinism: GLOBAL_ZANA_DIR is computed once at module-load as
// path.join(os.homedir(), ".zana"); on POSIX os.homedir() honours $HOME. So we
// redirect HOME to a fresh tmpdir in vi.hoisted() (before any import binds the
// module), seed a fake global ~/.zana, and assert on the discovered set. No real
// ~/.zana is touched, no fs mocking, no shared global state.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// Redirect HOME before the SUT import resolves so GLOBAL_ZANA_DIR points at our
// fake home. vi.hoisted() runs before top-level imports.
const { fakeHome, origHome } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const _fs = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const _path = require("node:path") as typeof import("node:path");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const _os = require("node:os") as typeof import("node:os");
  const fakeHome = _fs.mkdtempSync(_path.join(_os.tmpdir(), "zana-migrate-dryrun-home-"));
  const origHome = process.env.HOME;
  process.env.HOME = fakeHome;
  return { fakeHome, origHome };
});

import { dryRun } from "../../src/project/migrate.ts";

const globalZana = path.join(fakeHome, ".zana");
const tmpWorkspaces: string[] = [];

beforeAll(() => {
  // Seed a global ~/.zana with two migratable dirs plus decoy files that the
  // filter must exclude.
  fs.mkdirSync(path.join(globalZana, "tickets"), { recursive: true });
  fs.mkdirSync(path.join(globalZana, "artifacts"), { recursive: true });
  // sprints/ deliberately absent → exercises the existsSync continue branch.

  fs.writeFileSync(path.join(globalZana, "tickets", "T-1.json"), "{}", "utf8");
  fs.writeFileSync(path.join(globalZana, "tickets", "T-2.json"), "{}", "utf8");
  // Decoys: the index file and a non-json file must NOT be discovered.
  fs.writeFileSync(path.join(globalZana, "tickets", "_index.json"), "[]", "utf8");
  fs.writeFileSync(path.join(globalZana, "tickets", "notes.txt"), "ignore me", "utf8");

  fs.writeFileSync(path.join(globalZana, "artifacts", "A-1.json"), "{}", "utf8");
});

afterAll(() => {
  if (origHome === undefined) delete process.env.HOME;
  else process.env.HOME = origHome;
  try { fs.rmSync(fakeHome, { recursive: true, force: true }); } catch {}
  for (const d of tmpWorkspaces) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
  }
});

function makeTmpWorkspace(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "zana-migrate-dryrun-ws-"));
  tmpWorkspaces.push(d);
  return d;
}

describe("dryRun() — discovery of migratable records", () => {
  it("discovers only .json records, excluding _index.json and non-json files", () => {
    const workspace = makeTmpWorkspace();
    const { files } = dryRun(workspace);

    const sources = files.map((f) => path.basename(f.source)).sort();
    // T-1, T-2 (tickets) + A-1 (artifacts); _index.json and notes.txt excluded.
    expect(sources).toEqual(["A-1.json", "T-1.json", "T-2.json"]);
  });

  it("maps each discovered record to a target under workspaceRoot/.zana/<dir>/", () => {
    const workspace = makeTmpWorkspace();
    const { files } = dryRun(workspace);

    const ticket = files.find((f) => path.basename(f.source) === "T-1.json");
    expect(ticket).toBeDefined();
    expect(ticket!.source).toBe(path.join(globalZana, "tickets", "T-1.json"));
    expect(ticket!.target).toBe(path.join(workspace, ".zana", "tickets", "T-1.json"));

    const artifact = files.find((f) => path.basename(f.source) === "A-1.json");
    expect(artifact!.target).toBe(path.join(workspace, ".zana", "artifacts", "A-1.json"));
  });

  it("is read-only — discovery creates nothing in the workspace", () => {
    const workspace = makeTmpWorkspace();
    dryRun(workspace);
    expect(fs.readdirSync(workspace)).toHaveLength(0);
  });
});

// Unit tests for packages/core/src/guardrails/builtins.ts
// All guards are pure value-in / {pass, feedback} out — no network, no Claude.

import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  jsonSchema,
  jsonParse,
  noSecrets,
  maxLength,
  fileExists,
  containsPattern,
  custom,
} from "../../src/guardrails/builtins.ts";

// ---------------------------------------------------------------------------
// jsonParse
// ---------------------------------------------------------------------------
describe("jsonParse", () => {
  const guard = jsonParse();

  it("passes on valid bare JSON object", () => {
    const r = guard.validate('{"a":1}');
    expect(r.pass).toBe(true);
    expect((r as any).parsedOutput).toEqual({ a: 1 });
  });

  it("passes on JSON wrapped in a markdown fence", () => {
    const r = guard.validate("```json\n{\"x\":2}\n```");
    expect(r.pass).toBe(true);
    expect((r as any).parsedOutput).toEqual({ x: 2 });
  });

  it("fails on invalid JSON and returns feedback", () => {
    const r = guard.validate("not json at all");
    expect(r.pass).toBe(false);
    expect((r as any).feedback).toMatch(/not valid JSON/i);
  });

  it("fails on empty string", () => {
    const r = guard.validate("");
    expect(r.pass).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// jsonSchema (with a minimal duck-typed schema validator)
// ---------------------------------------------------------------------------
describe("jsonSchema", () => {
  const alwaysOk = { validate: () => ({ success: true }) };
  const alwaysFail = { validate: () => ({ success: false, errors: ["bad"] }) };

  it("passes when JSON parses and schema validates", () => {
    const r = jsonSchema(alwaysOk).validate('{"k":"v"}');
    expect(r.pass).toBe(true);
  });

  it("fails when JSON is invalid", () => {
    const r = jsonSchema(alwaysOk).validate("oops");
    expect(r.pass).toBe(false);
    expect((r as any).feedback).toMatch(/not valid JSON/i);
  });

  it("fails when schema validation fails and surfaces schema errors", () => {
    const r = jsonSchema(alwaysFail).validate('{"k":"v"}');
    expect(r.pass).toBe(false);
    expect((r as any).feedback).toMatch(/schema validation/i);
    expect((r as any).feedback).toContain("bad");
  });

  it("passes when no schema object is provided (null)", () => {
    const r = jsonSchema(null).validate('{"a":1}');
    expect(r.pass).toBe(true);
  });

  // jsonSchema carries its OWN markdown-fence extraction (builtins.ts line 10),
  // separate from jsonParse's copy. The existing jsonSchema tests only feed
  // bare JSON, so the fence-stripping branch — strip ```json … ``` BEFORE
  // parsing and running the schema validator — is otherwise untested. Also
  // pins that the parsed object is surfaced as parsedOutput on success.
  it("strips a ```json markdown fence before parsing and schema validation", () => {
    const seen: unknown[] = [];
    const recordingSchema = {
      validate: (v: unknown) => {
        seen.push(v);
        return { success: true };
      },
    };
    const r = jsonSchema(recordingSchema).validate('```json\n{"k":"v"}\n```');
    expect(r.pass).toBe(true);
    expect((r as any).parsedOutput).toEqual({ k: "v" });
    // The schema validator must receive the parsed object from inside the
    // fence, not the raw fenced string.
    expect(seen).toEqual([{ k: "v" }]);
  });
});

// ---------------------------------------------------------------------------
// noSecrets
// ---------------------------------------------------------------------------
describe("noSecrets", () => {
  const guard = noSecrets();

  it("passes on clean output", () => {
    expect(guard.validate("Here is some plain text.").pass).toBe(true);
  });

  it("fails when output contains an OpenAI-style sk- key", () => {
    const r = guard.validate("my key is sk-abcdefghijklmnopqrstu");
    expect(r.pass).toBe(false);
    expect((r as any).feedback).toMatch(/secrets/i);
  });

  it("fails when output contains a GitHub PAT (ghp_)", () => {
    const r = guard.validate("token=ghp_" + "a".repeat(36));
    expect(r.pass).toBe(false);
  });

  it("fails when output contains a PEM private key header", () => {
    const r = guard.validate("-----BEGIN RSA PRIVATE KEY-----\nblah");
    expect(r.pass).toBe(false);
  });

  it("fails when output contains an AWS access key id (AKIA…)", () => {
    const r = guard.validate("AKIAIOSFODNN7EXAMPLE rest of text");
    expect(r.pass).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// maxLength
// ---------------------------------------------------------------------------
describe("maxLength", () => {
  it("passes when output is exactly at the limit", () => {
    const guard = maxLength(10);
    expect(guard.validate("1234567890").pass).toBe(true);
  });

  it("passes when output is under the limit", () => {
    const guard = maxLength(10);
    expect(guard.validate("short").pass).toBe(true);
  });

  it("fails when output exceeds the limit and reports char counts", () => {
    const guard = maxLength(5);
    const r = guard.validate("toolongstring");
    expect(r.pass).toBe(false);
    expect((r as any).feedback).toMatch(/13 characters/);
    expect((r as any).feedback).toMatch(/maximum allowed is 5/);
  });

  it("passes on empty string", () => {
    const guard = maxLength(0);
    expect(guard.validate("").pass).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// fileExists
// ---------------------------------------------------------------------------
describe("fileExists", () => {
  let tmpDir: string;

  it("passes when the file is present relative to cwd ctx", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "zana-builtins-test-"));
    const file = "result.txt";
    writeFileSync(join(tmpDir, file), "ok");
    try {
      const guard = fileExists(file);
      const r = guard.validate("", { cwd: tmpDir });
      expect(r.pass).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("fails when the file is absent", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "zana-builtins-test-"));
    try {
      const guard = fileExists("missing.txt");
      const r = guard.validate("", { cwd: tmpDir });
      expect(r.pass).toBe(false);
      expect((r as any).feedback).toMatch(/missing\.txt/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("uses an absolute path verbatim and ignores ctx.cwd", () => {
    // Covers the path.isAbsolute() branch: an absolute filePath must be
    // checked as-is, NOT joined onto ctx.cwd. We point cwd at an empty,
    // unrelated dir to prove it is not consulted when the path is absolute.
    tmpDir = mkdtempSync(join(tmpdir(), "zana-builtins-test-"));
    const otherDir = mkdtempSync(join(tmpdir(), "zana-builtins-other-"));
    const absFile = join(tmpDir, "artifact.txt");
    writeFileSync(absFile, "ok");
    try {
      const guard = fileExists(absFile);
      // cwd is the unrelated empty dir; absolute path should still resolve.
      expect(guard.validate("", { cwd: otherDir }).pass).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      rmSync(otherDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// containsPattern
// ---------------------------------------------------------------------------
describe("containsPattern", () => {
  it("passes when output matches a RegExp", () => {
    const guard = containsPattern(/\bDONE\b/, "must say DONE");
    expect(guard.validate("Task DONE.").pass).toBe(true);
  });

  it("passes when output matches a string pattern", () => {
    const guard = containsPattern("DONE");
    expect(guard.validate("DONE").pass).toBe(true);
  });

  it("fails when output does not match and returns description in feedback", () => {
    const guard = containsPattern(/\bDONE\b/, "must say DONE");
    const r = guard.validate("Task complete.");
    expect(r.pass).toBe(false);
    expect((r as any).feedback).toContain("must say DONE");
  });
});

// ---------------------------------------------------------------------------
// custom
// ---------------------------------------------------------------------------
describe("custom", () => {
  it("wraps an arbitrary validate function with the supplied id/name", () => {
    const guard = custom("my-id", "My Guard", (out: string) =>
      out === "ok" ? { pass: true } : { pass: false, feedback: "not ok" },
    );
    expect(guard.id).toBe("my-id");
    expect(guard.name).toBe("My Guard");
    expect(guard.validate("ok").pass).toBe(true);
    expect(guard.validate("bad").pass).toBe(false);
  });
});

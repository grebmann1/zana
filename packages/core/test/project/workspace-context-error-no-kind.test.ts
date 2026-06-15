// Focused unit test for WorkspaceNotInitializedError's "minimal options" branch
// in packages/core/src/project/workspace-context.ts.
//
// The constructor builds its message from two OPTIONAL fragments:
//   - ` (kind=${kind})` only when requestedKind is a string (lines 32-33)
//   - ` at ${path}`     only when path is a non-empty string (line 36)
// and assigns `this.requestedKind` ONLY when a kind was supplied (line 42).
//
// The sibling workspace-context.test.ts always passes requestedKind (and
// asserts it appears) or checks `operation` alone — so the ABSENCE branch is
// unpinned: a regression that unconditionally appended "(kind=undefined)" or
// " at " (with an empty path) to the message, or that defaulted requestedKind
// to something non-undefined, would slip through. This test pins the omission.
//
// Deterministic: pure object construction, no fs / network / clock.

import { describe, it, expect } from "vitest";
import { WorkspaceNotInitializedError } from "../../src/project/workspace-context.ts";

describe("WorkspaceNotInitializedError — minimal options (no kind, no path)", () => {
  it("omits the kind and path fragments from the message when neither is supplied", () => {
    const err = new WorkspaceNotInitializedError({ operation: "read" });

    // Core identity still holds.
    expect(err.name).toBe("WorkspaceNotInitializedError");
    expect(err.code).toBe("WORKSPACE_NOT_INITIALIZED");
    expect(err.operation).toBe("read");

    // The optional fragments must NOT leak into the message.
    expect(err.message).not.toContain("(kind=");
    expect(err.message).not.toContain(" at ");
    // The operation is still described, and the remediation hint is present.
    expect(err.message).toContain("read");
    expect(err.message).toContain("workspaceContext.init");

    // requestedKind was never supplied → it must stay undefined (not coerced
    // to a default), and path defaults to the empty string.
    expect(err.requestedKind).toBeUndefined();
    expect(err.path).toBe("");
  });

  it("ignores a non-string path (defaults to empty, omits the ' at ' fragment)", () => {
    const err = new WorkspaceNotInitializedError({
      operation: "write",
      path: 123 as unknown as string,
    });
    expect(err.path).toBe("");
    expect(err.message).not.toContain(" at ");
  });
});

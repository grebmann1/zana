// Input-validation guards for assembleCouncil() and reassembleCouncil().
//
// Every guard throws synchronously (or via the async function's preamble)
// before any store access or probe I/O — no workspace context or fake probeAgent
// needed.  The five existing quorum test files never exercise these branches
// (they always start from well-formed inputs).
//
// Guards under test (quorum.ts):
//   assembleCouncil:
//     1. null / non-object input → "input is required"
//     2. deliberationId not a string or empty → "deliberationId is required"
//     3. candidates not an array → "candidates must be an array"
//     4. candidate entry missing profileId → "every candidate must carry a profileId"
//     5. duplicate candidate profileIds → "duplicate candidate profileId=<id>"
//
//   reassembleCouncil:
//     6.  null / non-object input → "input is required"
//     7.  deliberationId not a string or empty → "deliberationId is required"
//     8.  candidates not an array → "candidates must be an array"
//     9.  previousDissenterProfileIds not an array → "previousDissenterProfileIds must be an array"
//     10. expectedSourceState !== "CONVERGING" → "expectedSourceState must be \"CONVERGING\""
//     11. candidate entry missing profileId → "every candidate must carry a profileId"

import { describe, it, expect } from "vitest";
import {
  assembleCouncil,
  reassembleCouncil,
} from "@zana-ai/work/src/deliberation/quorum.ts";

// ──────────────────────────────────────────────────────────────────────────────
// assembleCouncil — input validation
// ──────────────────────────────────────────────────────────────────────────────

describe("assembleCouncil — input validation", () => {
  it("throws when input is null", async () => {
    await expect(assembleCouncil(null as any)).rejects.toThrow(
      "assembleCouncil: input is required",
    );
  });

  it("throws when input is a primitive (string)", async () => {
    await expect(assembleCouncil("bad" as any)).rejects.toThrow(
      "assembleCouncil: input is required",
    );
  });

  it("throws when deliberationId is an empty string", async () => {
    await expect(
      assembleCouncil({ deliberationId: "", candidates: [] } as any),
    ).rejects.toThrow("assembleCouncil: deliberationId is required");
  });

  it("throws when deliberationId is a number", async () => {
    await expect(
      assembleCouncil({ deliberationId: 42, candidates: [] } as any),
    ).rejects.toThrow("assembleCouncil: deliberationId is required");
  });

  it("throws when deliberationId is missing (undefined)", async () => {
    await expect(
      assembleCouncil({ candidates: [] } as any),
    ).rejects.toThrow("assembleCouncil: deliberationId is required");
  });

  it("throws when candidates is not an array", async () => {
    await expect(
      assembleCouncil({
        deliberationId: "d-1",
        candidates: "not-an-array",
      } as any),
    ).rejects.toThrow("assembleCouncil: candidates must be an array");
  });

  it("throws when a candidate entry is missing profileId", async () => {
    await expect(
      assembleCouncil({
        deliberationId: "d-1",
        candidates: [{ profile: { id: "x" } }],
      } as any),
    ).rejects.toThrow("assembleCouncil: every candidate must carry a profileId");
  });

  it("throws when a candidate's profileId is not a string", async () => {
    await expect(
      assembleCouncil({
        deliberationId: "d-1",
        candidates: [{ profileId: 99, profile: {} }],
      } as any),
    ).rejects.toThrow("assembleCouncil: every candidate must carry a profileId");
  });

  it("throws on duplicate candidate profileIds", async () => {
    await expect(
      assembleCouncil({
        deliberationId: "d-1",
        candidates: [
          { profileId: "alpha", profile: {} },
          { profileId: "alpha", profile: {} },
        ],
      } as any),
    ).rejects.toThrow("assembleCouncil: duplicate candidate profileId=alpha");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// reassembleCouncil — input validation
// ──────────────────────────────────────────────────────────────────────────────

describe("reassembleCouncil — input validation", () => {
  it("throws when input is null", async () => {
    await expect(reassembleCouncil(null as any)).rejects.toThrow(
      "reassembleCouncil: input is required",
    );
  });

  it("throws when input is undefined", async () => {
    await expect(reassembleCouncil(undefined as any)).rejects.toThrow(
      "reassembleCouncil: input is required",
    );
  });

  it("throws when deliberationId is an empty string", async () => {
    await expect(
      reassembleCouncil({
        deliberationId: "",
        candidates: [],
        previousDissenterProfileIds: [],
        expectedSourceState: "CONVERGING",
      }),
    ).rejects.toThrow("reassembleCouncil: deliberationId is required");
  });

  it("throws when deliberationId is absent", async () => {
    await expect(
      reassembleCouncil({
        candidates: [],
        previousDissenterProfileIds: [],
        expectedSourceState: "CONVERGING",
      } as any),
    ).rejects.toThrow("reassembleCouncil: deliberationId is required");
  });

  it("throws when candidates is not an array", async () => {
    await expect(
      reassembleCouncil({
        deliberationId: "d-1",
        candidates: null,
        previousDissenterProfileIds: [],
        expectedSourceState: "CONVERGING",
      } as any),
    ).rejects.toThrow("reassembleCouncil: candidates must be an array");
  });

  it("throws when previousDissenterProfileIds is not an array", async () => {
    await expect(
      reassembleCouncil({
        deliberationId: "d-1",
        candidates: [],
        previousDissenterProfileIds: "not-an-array",
        expectedSourceState: "CONVERGING",
      } as any),
    ).rejects.toThrow(
      "reassembleCouncil: previousDissenterProfileIds must be an array",
    );
  });

  it("throws when previousDissenterProfileIds is null", async () => {
    await expect(
      reassembleCouncil({
        deliberationId: "d-1",
        candidates: [],
        previousDissenterProfileIds: null,
        expectedSourceState: "CONVERGING",
      } as any),
    ).rejects.toThrow(
      "reassembleCouncil: previousDissenterProfileIds must be an array",
    );
  });

  it("throws when expectedSourceState is not 'CONVERGING'", async () => {
    await expect(
      reassembleCouncil({
        deliberationId: "d-1",
        candidates: [],
        previousDissenterProfileIds: [],
        expectedSourceState: "REVIEWING" as any,
      }),
    ).rejects.toThrow(/expectedSourceState must be "CONVERGING"/);
  });

  it("throws when a candidate entry lacks a profileId string", async () => {
    await expect(
      reassembleCouncil({
        deliberationId: "d-1",
        candidates: [{ profile: {} }],
        previousDissenterProfileIds: [],
        expectedSourceState: "CONVERGING",
      } as any),
    ).rejects.toThrow(
      "reassembleCouncil: every candidate must carry a profileId",
    );
  });

  it("throws on duplicate candidate profileIds in reassemble", async () => {
    await expect(
      reassembleCouncil({
        deliberationId: "d-1",
        candidates: [
          { profileId: "dup", profile: {} },
          { profileId: "dup", profile: {} },
        ],
        previousDissenterProfileIds: [],
        expectedSourceState: "CONVERGING",
      } as any),
    ).rejects.toThrow(
      "reassembleCouncil: duplicate candidate profileId=dup",
    );
  });
});

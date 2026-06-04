// Unit tests for registrations/profiles.ts
//
// Tests cover:
//   - Tool definitions: correct names, required fields, schema shapes
//   - Handler behavior: callCore is invoked with the correct op + args
//
// No daemon, no network, no file I/O.

import { describe, it, expect } from "vitest";
import { profiles } from "../../src/registrations/profiles.ts";

// ─── helpers ────────────────────────────────────────────────────────────────

type Handler = (args: Record<string, unknown>, ctx: Record<string, unknown>) => unknown;

function getHandler(name: string): Handler {
  return (profiles.handlers as Record<string, Handler>)[name];
}

interface Captured {
  op: string;
  args: Record<string, unknown>;
}

function makeCallCore(result: unknown = {}) {
  const calls: Captured[] = [];
  const callCore = (op: string, args: Record<string, unknown> = {}) => {
    calls.push({ op, args });
    return Promise.resolve(result);
  };
  return { callCore, calls };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool-definition shape
// ─────────────────────────────────────────────────────────────────────────────

describe("profiles tool definitions", () => {
  const toolNames = profiles.tools.map((t) => t.name);

  it("exposes exactly the four expected tool names", () => {
    expect(toolNames).toEqual(
      expect.arrayContaining([
        "zana_list_profiles",
        "zana_get_profile",
        "zana_save_profile",
        "zana_delete_profile",
      ]),
    );
    expect(toolNames).toHaveLength(4);
  });

  it("zana_get_profile requires profileId", () => {
    const tool = profiles.tools.find((t) => t.name === "zana_get_profile")!;
    expect(tool.inputSchema.required).toEqual(expect.arrayContaining(["profileId"]));
  });

  it("zana_save_profile requires profile", () => {
    const tool = profiles.tools.find((t) => t.name === "zana_save_profile")!;
    expect(tool.inputSchema.required).toEqual(expect.arrayContaining(["profile"]));
  });

  it("zana_delete_profile requires profileId", () => {
    const tool = profiles.tools.find((t) => t.name === "zana_delete_profile")!;
    expect(tool.inputSchema.required).toEqual(expect.arrayContaining(["profileId"]));
  });

  it("zana_list_profiles accepts no required inputs", () => {
    const tool = profiles.tools.find((t) => t.name === "zana_list_profiles")!;
    expect(tool.inputSchema.required ?? []).toHaveLength(0);
  });

  it("zana_save_profile profile schema includes key fields", () => {
    const tool = profiles.tools.find((t) => t.name === "zana_save_profile")!;
    const profileProps = (tool.inputSchema.properties as Record<string, unknown> & {
      profile: { properties: Record<string, unknown> };
    }).profile.properties;
    expect(Object.keys(profileProps)).toEqual(
      expect.arrayContaining(["id", "displayName", "model", "systemPrompt"]),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Handlers — callCore passthrough
// ─────────────────────────────────────────────────────────────────────────────

describe("zana_list_profiles handler", () => {
  it("calls list_profiles with no extra args", async () => {
    const { callCore, calls } = makeCallCore([]);
    await getHandler("zana_list_profiles")({}, { callCore });
    expect(calls).toHaveLength(1);
    expect(calls[0].op).toBe("list_profiles");
  });
});

describe("zana_get_profile handler", () => {
  it("calls get_profile forwarding profileId", async () => {
    const { callCore, calls } = makeCallCore({ id: "p1" });
    await getHandler("zana_get_profile")({ profileId: "p1" }, { callCore });
    expect(calls).toHaveLength(1);
    expect(calls[0].op).toBe("get_profile");
    expect(calls[0].args).toMatchObject({ profileId: "p1" });
  });
});

describe("zana_save_profile handler", () => {
  it("calls save_profile forwarding the profile object", async () => {
    const profile = { id: "p1", displayName: "My Profile", model: "claude-3" };
    const { callCore, calls } = makeCallCore({ ok: true });
    await getHandler("zana_save_profile")({ profile }, { callCore });
    expect(calls).toHaveLength(1);
    expect(calls[0].op).toBe("save_profile");
    expect(calls[0].args).toMatchObject({ profile });
  });

  it("calls save_profile for a new profile (no id)", async () => {
    const profile = { displayName: "New Profile" };
    const { callCore, calls } = makeCallCore({ ok: true, id: "generated" });
    await getHandler("zana_save_profile")({ profile }, { callCore });
    expect(calls[0].op).toBe("save_profile");
    expect((calls[0].args.profile as Record<string, unknown>).id).toBeUndefined();
  });
});

describe("zana_delete_profile handler", () => {
  it("calls delete_profile forwarding profileId", async () => {
    const { callCore, calls } = makeCallCore({ ok: true });
    await getHandler("zana_delete_profile")({ profileId: "p99" }, { callCore });
    expect(calls).toHaveLength(1);
    expect(calls[0].op).toBe("delete_profile");
    expect(calls[0].args).toMatchObject({ profileId: "p99" });
  });
});

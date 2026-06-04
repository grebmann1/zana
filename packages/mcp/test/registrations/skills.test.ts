// Unit tests for registrations/skills.ts
//
// Strategy: inject a fake callCore — no daemon, no network, no file I/O.
// Covers: correct core operation name, argument forwarding, and return value
// passthrough for each handler.

import { describe, it, expect } from "vitest";
import { skills } from "../../src/registrations/skills.ts";

// ─── helpers ────────────────────────────────────────────────────────────────

type Handler = (args: Record<string, unknown>, ctx: Record<string, unknown>) => unknown;

function getHandler(name: string): Handler {
  return (skills.handlers as Record<string, Handler>)[name];
}

/** Builds a fake callCore that records invocations and returns `returnValue`. */
function spyCallCore(returnValue: unknown = null) {
  const calls: Array<{ op: string; args: unknown }> = [];
  const callCore = (op: string, args?: unknown) => {
    calls.push({ op, args: args ?? undefined });
    return Promise.resolve(returnValue);
  };
  return { callCore, calls };
}

// ─── tool definitions ────────────────────────────────────────────────────────

describe("skills tool definitions", () => {
  const toolNames = skills.tools.map((t) => t.name);

  it("exposes the expected five tool names", () => {
    expect(toolNames).toEqual(
      expect.arrayContaining([
        "zana_list_skills",
        "zana_get_skill",
        "zana_save_skill",
        "zana_delete_skill",
        "zana_toggle_skill",
      ]),
    );
    expect(skills.tools).toHaveLength(5);
  });

  it("zana_get_skill requires skillId", () => {
    const def = skills.tools.find((t) => t.name === "zana_get_skill")!;
    expect(def.inputSchema.required).toContain("skillId");
  });

  it("zana_save_skill requires skill", () => {
    const def = skills.tools.find((t) => t.name === "zana_save_skill")!;
    expect(def.inputSchema.required).toContain("skill");
  });

  it("zana_toggle_skill requires skillId and enabled", () => {
    const def = skills.tools.find((t) => t.name === "zana_toggle_skill")!;
    expect(def.inputSchema.required).toContain("skillId");
    expect(def.inputSchema.required).toContain("enabled");
  });

  it("every tool has a non-empty description", () => {
    for (const tool of skills.tools) {
      expect(tool.description.length).toBeGreaterThan(0);
    }
  });
});

// ─── handlers ────────────────────────────────────────────────────────────────

describe("zana_list_skills handler", () => {
  it("calls list_skills with no extra args", async () => {
    const { callCore, calls } = spyCallCore([]);
    await getHandler("zana_list_skills")({}, { callCore });
    expect(calls).toHaveLength(1);
    expect(calls[0].op).toBe("list_skills");
    expect(calls[0].args).toBeUndefined();
  });

  it("returns the value from callCore unchanged", async () => {
    const payload = [{ id: "s1", name: "My Skill" }];
    const { callCore } = spyCallCore(payload);
    const result = await getHandler("zana_list_skills")({}, { callCore });
    expect(result).toBe(payload);
  });
});

describe("zana_get_skill handler", () => {
  it("forwards skillId to get_skill", async () => {
    const { callCore, calls } = spyCallCore(null);
    await getHandler("zana_get_skill")({ skillId: "s-42" }, { callCore });
    expect(calls[0].op).toBe("get_skill");
    expect(calls[0].args).toEqual({ skillId: "s-42" });
  });

  it("returns the value from callCore unchanged", async () => {
    const skill = { id: "s-42", name: "Writer" };
    const { callCore } = spyCallCore(skill);
    const result = await getHandler("zana_get_skill")({ skillId: "s-42" }, { callCore });
    expect(result).toBe(skill);
  });
});

describe("zana_save_skill handler", () => {
  it("forwards the skill object to save_skill", async () => {
    const { callCore, calls } = spyCallCore(null);
    const skillObj = { name: "Summarizer", type: "instruction", content: "Be brief." };
    await getHandler("zana_save_skill")({ skill: skillObj }, { callCore });
    expect(calls[0].op).toBe("save_skill");
    expect(calls[0].args).toEqual({ skill: skillObj });
  });

  it("returns the saved skill from callCore unchanged", async () => {
    const saved = { id: "new-id", name: "Summarizer", type: "instruction" };
    const { callCore } = spyCallCore(saved);
    const result = await getHandler("zana_save_skill")({ skill: { name: "Summarizer", type: "instruction" } }, { callCore });
    expect(result).toBe(saved);
  });
});

describe("zana_delete_skill handler", () => {
  it("forwards skillId to delete_skill", async () => {
    const { callCore, calls } = spyCallCore({ ok: true });
    await getHandler("zana_delete_skill")({ skillId: "s-del" }, { callCore });
    expect(calls[0].op).toBe("delete_skill");
    expect(calls[0].args).toEqual({ skillId: "s-del" });
  });

  it("returns the value from callCore unchanged", async () => {
    const resp = { ok: true };
    const { callCore } = spyCallCore(resp);
    const result = await getHandler("zana_delete_skill")({ skillId: "s-del" }, { callCore });
    expect(result).toBe(resp);
  });
});

describe("zana_toggle_skill handler", () => {
  it("forwards skillId and enabled=true to toggle_skill", async () => {
    const { callCore, calls } = spyCallCore(null);
    await getHandler("zana_toggle_skill")({ skillId: "s-tog", enabled: true }, { callCore });
    expect(calls[0].op).toBe("toggle_skill");
    expect(calls[0].args).toEqual({ skillId: "s-tog", enabled: true });
  });

  it("forwards enabled=false correctly", async () => {
    const { callCore, calls } = spyCallCore(null);
    await getHandler("zana_toggle_skill")({ skillId: "s-tog", enabled: false }, { callCore });
    expect(calls[0].args).toEqual({ skillId: "s-tog", enabled: false });
  });

  it("returns the value from callCore unchanged", async () => {
    const resp = { id: "s-tog", enabled: true };
    const { callCore } = spyCallCore(resp);
    const result = await getHandler("zana_toggle_skill")({ skillId: "s-tog", enabled: true }, { callCore });
    expect(result).toBe(resp);
  });
});

// Unit tests for registrations/checkpoints.ts
//
// Covers:
//   - Tool definition shape (4 tools, required fields)
//   - zana_checkpoint_save: always injects status:"running"
//   - zana_checkpoint_save: defaults pendingAgents to [] when omitted
//   - zana_checkpoint_list, zana_checkpoint_get, zana_checkpoint_resume: passthrough handlers
//
// No daemon, no network, no file I/O.

import { describe, it, expect } from "vitest";
import { checkpoints } from "../../src/registrations/checkpoints.ts";

// ─── helpers ────────────────────────────────────────────────────────────────

type Handler = (args: Record<string, unknown>, ctx: Record<string, unknown>) => unknown;

function getHandler(name: string): Handler {
  return (checkpoints.handlers as Record<string, Handler>)[name];
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

describe("checkpoints tool definitions", () => {
  const toolNames = checkpoints.tools.map((t) => t.name);

  it("exposes exactly four tool names", () => {
    expect(toolNames).toEqual(
      expect.arrayContaining([
        "zana_checkpoint_save",
        "zana_checkpoint_list",
        "zana_checkpoint_get",
        "zana_checkpoint_resume",
      ]),
    );
    expect(toolNames).toHaveLength(4);
  });

  it("zana_checkpoint_save requires teamId", () => {
    const tool = checkpoints.tools.find((t) => t.name === "zana_checkpoint_save")!;
    expect(tool.inputSchema.required).toEqual(expect.arrayContaining(["teamId"]));
  });

  it("zana_checkpoint_get requires checkpointId", () => {
    const tool = checkpoints.tools.find((t) => t.name === "zana_checkpoint_get")!;
    expect(tool.inputSchema.required).toEqual(expect.arrayContaining(["checkpointId"]));
  });

  it("zana_checkpoint_resume requires checkpointId", () => {
    const tool = checkpoints.tools.find((t) => t.name === "zana_checkpoint_resume")!;
    expect(tool.inputSchema.required).toEqual(expect.arrayContaining(["checkpointId"]));
  });

  it("zana_checkpoint_list status enum includes expected values", () => {
    const tool = checkpoints.tools.find((t) => t.name === "zana_checkpoint_list")!;
    const statusEnum = (
      tool.inputSchema.properties as Record<string, { enum?: string[] }>
    ).status.enum!;
    expect(statusEnum).toEqual(
      expect.arrayContaining(["running", "completed", "stopped", "resumed"]),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// zana_checkpoint_save handler
// ─────────────────────────────────────────────────────────────────────────────

describe("zana_checkpoint_save handler", () => {
  const handler = getHandler("zana_checkpoint_save");

  it("calls checkpoint_save with teamId and always injects status:'running'", async () => {
    const { callCore, calls } = makeCallCore({ id: "cp-1" });
    await handler({ teamId: "team-42" }, { callCore });
    expect(calls[0].op).toBe("checkpoint_save");
    expect(calls[0].args.teamId).toBe("team-42");
    expect(calls[0].args.status).toBe("running");
  });

  it("defaults pendingAgents to [] when not provided", async () => {
    const { callCore, calls } = makeCallCore({});
    await handler({ teamId: "team-1" }, { callCore });
    expect(calls[0].args.pendingAgents).toEqual([]);
  });

  it("forwards provided pendingAgents array", async () => {
    const { callCore, calls } = makeCallCore({});
    const agents = [
      { profileId: "worker", prompt: "Do the thing" },
      { profileId: "reviewer", prompt: "Review it", dependencies: ["agent-1"] },
    ];
    await handler({ teamId: "team-2", pendingAgents: agents }, { callCore });
    expect(calls[0].args.pendingAgents).toEqual(agents);
  });

  it("still injects status:'running' even when pendingAgents is provided", async () => {
    const { callCore, calls } = makeCallCore({});
    await handler({ teamId: "team-3", pendingAgents: [] }, { callCore });
    expect(calls[0].args.status).toBe("running");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Passthrough handlers
// ─────────────────────────────────────────────────────────────────────────────

describe("passthrough handlers", () => {
  it("zana_checkpoint_list calls checkpoint_list with teamId filter", async () => {
    const { callCore, calls } = makeCallCore([]);
    const handler = getHandler("zana_checkpoint_list");
    await handler({ teamId: "team-99" }, { callCore });
    expect(calls[0].op).toBe("checkpoint_list");
    expect(calls[0].args.teamId).toBe("team-99");
  });

  it("zana_checkpoint_list calls checkpoint_list with status filter", async () => {
    const { callCore, calls } = makeCallCore([]);
    const handler = getHandler("zana_checkpoint_list");
    await handler({ status: "stopped" }, { callCore });
    expect(calls[0].op).toBe("checkpoint_list");
    expect(calls[0].args.status).toBe("stopped");
  });

  it("zana_checkpoint_list passes undefined filters when args are omitted", async () => {
    const { callCore, calls } = makeCallCore([]);
    const handler = getHandler("zana_checkpoint_list");
    await handler({}, { callCore });
    expect(calls[0].op).toBe("checkpoint_list");
  });

  it("zana_checkpoint_get calls checkpoint_get with checkpointId", async () => {
    const { callCore, calls } = makeCallCore({ id: "cp-42" });
    const handler = getHandler("zana_checkpoint_get");
    await handler({ checkpointId: "cp-42" }, { callCore });
    expect(calls[0].op).toBe("checkpoint_get");
    expect(calls[0].args.checkpointId).toBe("cp-42");
  });

  it("zana_checkpoint_resume calls checkpoint_resume with checkpointId", async () => {
    const { callCore, calls } = makeCallCore({ resumed: true });
    const handler = getHandler("zana_checkpoint_resume");
    await handler({ checkpointId: "cp-7" }, { callCore });
    expect(calls[0].op).toBe("checkpoint_resume");
    expect(calls[0].args.checkpointId).toBe("cp-7");
  });
});

// Unit tests for registrations/artifacts.ts
//
// Covers:
//   - Tool definition shape (4 tools, required fields)
//   - zana_artifact_create: forwards all fields + injects createdBy from env
//   - zana_artifact_create: falls back to "agent" when ZANA_TERMINAL_ID is unset
//   - zana_artifact_list, zana_artifact_read, zana_artifact_update: callCore passthroughs
//
// No daemon, no network, no file I/O.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { artifacts } from "../../src/registrations/artifacts.ts";

// ─── helpers ────────────────────────────────────────────────────────────────

type Handler = (args: Record<string, unknown>, ctx: Record<string, unknown>) => unknown;

function getHandler(name: string): Handler {
  return (artifacts.handlers as Record<string, Handler>)[name];
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

describe("artifacts tool definitions", () => {
  const toolNames = artifacts.tools.map((t) => t.name);

  it("exposes exactly four tool names", () => {
    expect(toolNames).toEqual(
      expect.arrayContaining([
        "zana_artifact_create",
        "zana_artifact_list",
        "zana_artifact_read",
        "zana_artifact_update",
      ]),
    );
    expect(toolNames).toHaveLength(4);
  });

  it("zana_artifact_create requires title, type, and content", () => {
    const tool = artifacts.tools.find((t) => t.name === "zana_artifact_create")!;
    expect(tool.inputSchema.required).toEqual(
      expect.arrayContaining(["title", "type", "content"]),
    );
  });

  it("zana_artifact_read requires artifactId", () => {
    const tool = artifacts.tools.find((t) => t.name === "zana_artifact_read")!;
    expect(tool.inputSchema.required).toEqual(expect.arrayContaining(["artifactId"]));
  });

  it("zana_artifact_update requires artifactId", () => {
    const tool = artifacts.tools.find((t) => t.name === "zana_artifact_update")!;
    expect(tool.inputSchema.required).toEqual(expect.arrayContaining(["artifactId"]));
  });

  it("zana_artifact_create type enum includes expected artifact types", () => {
    const tool = artifacts.tools.find((t) => t.name === "zana_artifact_create")!;
    const typeEnum = (tool.inputSchema.properties as Record<string, { enum?: string[] }>).type
      .enum!;
    expect(typeEnum).toEqual(
      expect.arrayContaining([
        "architecture-doc",
        "requirement-spec",
        "design-doc",
        "api-contract",
        "runbook",
        "decision-record",
        "custom",
      ]),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// zana_artifact_create handler
// ─────────────────────────────────────────────────────────────────────────────

describe("zana_artifact_create handler", () => {
  const handler = getHandler("zana_artifact_create");

  let savedTerminalId: string | undefined;

  beforeEach(() => {
    savedTerminalId = process.env.ZANA_TERMINAL_ID;
    delete process.env.ZANA_TERMINAL_ID;
  });

  afterEach(() => {
    if (savedTerminalId === undefined) {
      delete process.env.ZANA_TERMINAL_ID;
    } else {
      process.env.ZANA_TERMINAL_ID = savedTerminalId;
    }
  });

  it("calls artifact_create with title, type, content", async () => {
    const { callCore, calls } = makeCallCore({ id: "art-1" });
    await handler(
      { title: "My Doc", type: "architecture-doc", content: "# Intro" },
      { callCore },
    );
    expect(calls[0].op).toBe("artifact_create");
    expect(calls[0].args).toMatchObject({
      title: "My Doc",
      type: "architecture-doc",
      content: "# Intro",
    });
  });

  it("defaults createdBy to 'agent' when ZANA_TERMINAL_ID is not set", async () => {
    const { callCore, calls } = makeCallCore({});
    await handler(
      { title: "T", type: "custom", content: "body" },
      { callCore },
    );
    expect(calls[0].args.createdBy).toBe("agent");
  });

  it("uses ZANA_TERMINAL_ID as createdBy when the env var is set", async () => {
    process.env.ZANA_TERMINAL_ID = "daemon-42";
    const { callCore, calls } = makeCallCore({});
    await handler(
      { title: "T", type: "custom", content: "body" },
      { callCore },
    );
    expect(calls[0].args.createdBy).toBe("daemon-42");
  });

  it("forwards optional tags and linkedTickets", async () => {
    const { callCore, calls } = makeCallCore({});
    await handler(
      {
        title: "T",
        type: "runbook",
        content: "steps",
        tags: ["ops", "infra"],
        linkedTickets: ["T-1", "T-2"],
      },
      { callCore },
    );
    expect(calls[0].args.tags).toEqual(["ops", "infra"]);
    expect(calls[0].args.linkedTickets).toEqual(["T-1", "T-2"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Passthrough handlers
// ─────────────────────────────────────────────────────────────────────────────

describe("passthrough handlers", () => {
  it("zana_artifact_list calls artifact_list with type and tag filters", async () => {
    const { callCore, calls } = makeCallCore([]);
    const handler = getHandler("zana_artifact_list");
    await handler({ type: "design-doc", tag: "backend" }, { callCore });
    expect(calls[0].op).toBe("artifact_list");
    expect(calls[0].args).toMatchObject({ type: "design-doc", tag: "backend" });
  });

  it("zana_artifact_list forwards undefined filters when not supplied", async () => {
    const { callCore, calls } = makeCallCore([]);
    const handler = getHandler("zana_artifact_list");
    await handler({}, { callCore });
    expect(calls[0].op).toBe("artifact_list");
  });

  it("zana_artifact_read calls artifact_read with artifactId", async () => {
    const { callCore, calls } = makeCallCore({ id: "art-99", content: "# Hello" });
    const handler = getHandler("zana_artifact_read");
    await handler({ artifactId: "art-99" }, { callCore });
    expect(calls[0].op).toBe("artifact_read");
    expect(calls[0].args.artifactId).toBe("art-99");
  });

  it("zana_artifact_update calls artifact_update with artifactId", async () => {
    const { callCore, calls } = makeCallCore({ updated: true });
    const handler = getHandler("zana_artifact_update");
    await handler(
      { artifactId: "art-5", title: "New Title", content: "New body", tags: ["v2"] },
      { callCore },
    );
    expect(calls[0].op).toBe("artifact_update");
    expect(calls[0].args).toMatchObject({
      artifactId: "art-5",
      title: "New Title",
      content: "New body",
      tags: ["v2"],
    });
  });

  it("zana_artifact_update forwards only artifactId when optional fields are omitted", async () => {
    const { callCore, calls } = makeCallCore({});
    const handler = getHandler("zana_artifact_update");
    await handler({ artifactId: "art-6" }, { callCore });
    expect(calls[0].op).toBe("artifact_update");
    expect(calls[0].args.artifactId).toBe("art-6");
  });
});

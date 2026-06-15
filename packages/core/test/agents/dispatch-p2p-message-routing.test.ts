/**
 * Unit tests for the P2P-message routing branches of agents/dispatch.ts
 * (`send_message` / `publish_channel`).
 *
 * dispatch reaches the swarm package via a top-level require("@zana-ai/swarm")
 * and captures `router` / `spawner` by reference at module load. As documented
 * in dispatch-swarm-routing.test.ts, @zana-ai/swarm is an externalized
 * workspace package, so a vi.mock factory would NOT intercept that native
 * require — we spy on the methods of the same singleton objects dispatch holds.
 * That keeps the test deterministic and side-effect free.
 *
 * These two branches are pinned because they carry real logic the rest of the
 * dispatch suite leaves untested:
 *   - send_message applies field defaults (fromAgentName, priority), only
 *     requests an ack when requiresAck is set, and tags the reply with messageId.
 *   - publish_channel forwards a normalized message envelope verbatim.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as swarm from "@zana-ai/swarm";
import { handleOrchestratorCommand } from "@zana-ai/core/src/agents/dispatch.ts";

const router: any = (swarm as any).router;
const spawner: any = (swarm as any).spawner;

let savedId: string | undefined;

beforeEach(() => {
  savedId = process.env.ZANA_ID;
  // No sub-daemons → send_message routes with an empty port list, no real I/O.
  vi.spyOn(spawner, "listSubDaemons").mockReturnValue([]);
  vi.spyOn(router, "generateMessageId").mockReturnValue("msg-fixed-1");
});

afterEach(() => {
  vi.restoreAllMocks();
  if (savedId === undefined) delete process.env.ZANA_ID;
  else process.env.ZANA_ID = savedId;
});

describe("dispatch — P2P message routing", () => {
  it("send_message applies defaults, skips ack when not required, and tags the result with messageId", async () => {
    const requestAck = vi.spyOn(router, "requestAck").mockReturnValue(undefined);
    const routeMessage = vi.spyOn(router, "routeMessage").mockResolvedValue({ delivered: true });

    const result = await handleOrchestratorCommand(
      { action: "send_message", fromAgentId: "a1", toAgentId: "a2", type: "ping", payload: { n: 1 } },
      null,
    );

    expect(result).toEqual({ delivered: true, messageId: "msg-fixed-1" });
    expect(requestAck).not.toHaveBeenCalled();

    expect(routeMessage).toHaveBeenCalledTimes(1);
    const [msg, agents, ports] = routeMessage.mock.calls[0];
    expect(agents).toEqual([]);
    expect(ports).toEqual([]);
    // Defaults applied for the omitted fields.
    expect(msg).toMatchObject({
      id: "msg-fixed-1",
      fromAgentId: "a1",
      fromAgentName: "Agent",
      toAgentId: "a2",
      type: "ping",
      priority: "normal",
      requiresAck: false,
      replyTo: undefined,
    });
  });

  it("send_message requests an ack only when requiresAck is true", async () => {
    const requestAck = vi.spyOn(router, "requestAck").mockReturnValue(undefined);
    vi.spyOn(router, "routeMessage").mockResolvedValue({ delivered: true });

    await handleOrchestratorCommand(
      { action: "send_message", fromAgentId: "a1", toAgentId: "a2", requiresAck: true },
      null,
    );

    expect(requestAck).toHaveBeenCalledTimes(1);
    expect(requestAck).toHaveBeenCalledWith("msg-fixed-1");
  });

  it("publish_channel forwards a normalized envelope verbatim", async () => {
    process.env.ZANA_ID = "daemon-9";
    const publish = vi
      .spyOn(router, "publishToChannel")
      .mockReturnValue({ published: true, subscribers: 3 });

    const result = await handleOrchestratorCommand(
      {
        action: "publish_channel",
        channel: "alerts",
        fromAgentId: "a1",
        fromAgentName: "Reporter",
        type: "notice",
        payload: { msg: "hi" },
      },
      null,
    );

    expect(result).toEqual({ published: true, subscribers: 3 });
    expect(publish).toHaveBeenCalledWith("alerts", {
      fromAgentId: "a1",
      fromDaemonId: "daemon-9",
      fromAgentName: "Reporter",
      type: "notice",
      payload: { msg: "hi" },
    });
  });
});

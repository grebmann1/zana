/**
 * Unit tests for the swarm (multi-daemon coordination) routing branches of
 * agents/dispatch.ts.
 *
 * dispatch reaches the swarm package via a top-level require("@zana-ai/swarm")
 * and captures the `spawner` / `events` objects by reference at module load.
 * Because @zana-ai/swarm is a workspace package (externalized by vitest), a
 * `vi.mock("@zana-ai/swarm")` factory does NOT intercept that native require —
 * it would let the REAL spawnSubDaemon fork a daemon process. Instead we spy on
 * the methods of the same singleton objects dispatch holds, which keeps the
 * test deterministic and side-effect free.
 *
 * Most swarm actions are thin pass-throughs, but two carry real logic worth
 * pinning:
 *   - swarm_spawn threads the master env (ZANA_HOOK_PORT / ZANA_ID) and falls
 *     back to the workspace resolver when params.workspace is absent.
 *   - swarm_broadcast filters to ONLY running daemons, fans the message out to
 *     each, and tags every result with its daemonId.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as swarm from "@zana-ai/swarm";
import { handleOrchestratorCommand } from "@zana-ai/core/src/agents/dispatch.ts";

const spawner: any = (swarm as any).spawner;
const events: any = (swarm as any).events;

let savedPort: string | undefined;
let savedId: string | undefined;

beforeEach(() => {
  savedPort = process.env.ZANA_HOOK_PORT;
  savedId = process.env.ZANA_ID;
});

afterEach(() => {
  vi.restoreAllMocks();
  if (savedPort === undefined) delete process.env.ZANA_HOOK_PORT;
  else process.env.ZANA_HOOK_PORT = savedPort;
  if (savedId === undefined) delete process.env.ZANA_ID;
  else process.env.ZANA_ID = savedId;
});

describe("dispatch — swarm routing", () => {
  it("swarm_spawn threads master env and an explicit workspace, returning the result verbatim", async () => {
    process.env.ZANA_HOOK_PORT = "51234";
    process.env.ZANA_ID = "master-7";
    const spy = vi
      .spyOn(spawner, "spawnSubDaemon")
      .mockReturnValue({ daemonId: "d1", status: "running" });

    const getWorkspaceFn = vi.fn(() => "/resolved/ws");
    const result = await handleOrchestratorCommand(
      { action: "swarm_spawn", teamId: "t1", prompt: "go", workspace: "/explicit/ws" },
      getWorkspaceFn,
    );

    expect(result).toEqual({ daemonId: "d1", status: "running" });
    expect(spy).toHaveBeenCalledWith({
      teamId: "t1",
      workspace: "/explicit/ws",
      prompt: "go",
      masterPort: "51234",
      masterDaemonId: "master-7",
    });
    // An explicit workspace short-circuits the resolver.
    expect(getWorkspaceFn).not.toHaveBeenCalled();
  });

  it("swarm_spawn falls back to the workspace resolver and default port/id when unset", async () => {
    delete process.env.ZANA_HOOK_PORT;
    delete process.env.ZANA_ID;
    const spy = vi.spyOn(spawner, "spawnSubDaemon").mockReturnValue({ daemonId: "d2" });

    await handleOrchestratorCommand(
      { action: "swarm_spawn", teamId: "t2", prompt: "hi" },
      () => "/fallback/ws",
    );

    expect(spy).toHaveBeenCalledWith({
      teamId: "t2",
      workspace: "/fallback/ws",
      prompt: "hi",
      masterPort: "47400",
      masterDaemonId: "master",
    });
  });

  it("swarm_broadcast messages ONLY running daemons and tags each result with its daemonId", async () => {
    vi.spyOn(spawner, "listSubDaemons").mockReturnValue([
      { daemonId: "d1", status: "running" },
      { daemonId: "d2", status: "stopped" },
      { daemonId: "d3", status: "running" },
    ]);
    const instruct = vi
      .spyOn(spawner, "instructSubDaemon")
      .mockImplementation(async (id: string) => ({ delivered: true, to: id }));

    const result = await handleOrchestratorCommand(
      { action: "swarm_broadcast", message: "sync" },
      null,
    );

    expect(result).toEqual({
      ok: true,
      results: [
        { daemonId: "d1", delivered: true, to: "d1" },
        { daemonId: "d3", delivered: true, to: "d3" },
      ],
    });
    // The stopped daemon must be skipped entirely.
    expect(instruct).toHaveBeenCalledTimes(2);
    expect(instruct).toHaveBeenCalledWith("d1", "sync");
    expect(instruct).toHaveBeenCalledWith("d3", "sync");
  });

  it("swarm_instruct awaits the spawner, threading daemonId + message, and returns the result verbatim", async () => {
    const spy = vi
      .spyOn(spawner, "instructSubDaemon")
      .mockResolvedValue({ delivered: true, to: "d9" });

    const result = await handleOrchestratorCommand(
      { action: "swarm_instruct", daemonId: "d9", message: "do the thing" },
      null,
    );

    expect(result).toEqual({ delivered: true, to: "d9" });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("d9", "do the thing");
  });

  it("swarm_poll_events defaults `since` to 0 when not provided", async () => {
    const spy = vi.spyOn(events, "pending").mockReturnValue([{ id: 1 }]);
    const result = await handleOrchestratorCommand({ action: "swarm_poll_events" }, null);
    expect(result).toEqual([{ id: 1 }]);
    expect(spy).toHaveBeenCalledWith(0);
  });
});

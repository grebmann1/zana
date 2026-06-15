/**
 * Unit tests for the swarm_list / swarm_stop routing branches of
 * agents/dispatch.ts.
 *
 * These two actions are thin pass-throughs to the @zana-ai/swarm spawner
 * singleton, but they are the only swarm routes NOT pinned by
 * dispatch-swarm-routing.test.ts. They still carry a real contract worth
 * locking: swarm_list returns listSubDaemons() verbatim (no filtering — unlike
 * swarm_broadcast), and swarm_stop forwards params.daemonId to stopSubDaemon
 * and returns its result unchanged.
 *
 * As documented in dispatch-swarm-routing.test.ts, dispatch captures the swarm
 * `spawner` singleton by reference at module load via a native require, so we
 * spy on that same object rather than vi.mock — keeping the test deterministic
 * and free of any real daemon fork.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import * as swarm from "@zana-ai/swarm";
import { handleOrchestratorCommand } from "@zana-ai/core/src/agents/dispatch.ts";

const spawner: any = (swarm as any).spawner;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("dispatch — swarm_list / swarm_stop routing", () => {
  it("swarm_list returns listSubDaemons() verbatim, including non-running daemons", async () => {
    const daemons = [
      { daemonId: "d1", status: "running" },
      { daemonId: "d2", status: "stopped" },
    ];
    const spy = vi.spyOn(spawner, "listSubDaemons").mockReturnValue(daemons);

    const result = await handleOrchestratorCommand({ action: "swarm_list" }, null);

    // Unlike swarm_broadcast, swarm_list does NOT filter to running daemons.
    expect(result).toEqual(daemons);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith();
  });

  it("swarm_stop forwards params.daemonId to stopSubDaemon and returns its result", async () => {
    const spy = vi
      .spyOn(spawner, "stopSubDaemon")
      .mockReturnValue({ stopped: true, daemonId: "d9" });

    const result = await handleOrchestratorCommand(
      { action: "swarm_stop", daemonId: "d9" },
      null,
    );

    expect(result).toEqual({ stopped: true, daemonId: "d9" });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("d9");
  });
});

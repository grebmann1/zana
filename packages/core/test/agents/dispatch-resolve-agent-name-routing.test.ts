/**
 * Unit tests for the dispatch.ts "resolve_agent_name" cross-daemon FALLBACK,
 * which the sibling dispatch.test.ts leaves uncovered (it only exercises the
 * no-name and local-exact-match short-circuits).
 *
 * When no local agent matches, the branch consults the swarm routing table and
 * returns the first remote agent whose name matches — or null when nothing
 * matches or the lookup throws.
 *
 * dispatch reaches @zana-ai/swarm via a top-level require() and captures the
 * `router` / `spawner` singletons by reference at module load. That native
 * require is NOT intercepted by vi.mock (the package is externalized), so —
 * exactly as dispatch-swarm-routing.test.ts does — we spy on the methods of the
 * same singleton objects dispatch holds. `listAgents` is spied to force the
 * no-local-match path, keeping the test deterministic and side-effect free.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as swarm from "@zana-ai/swarm";
import * as lifecycle from "@zana-ai/core/src/agents/lifecycle.ts";
import { handleOrchestratorCommand } from "@zana-ai/core/src/agents/dispatch.ts";

const router: any = (swarm as any).router;
const spawner: any = (swarm as any).spawner;

function call(name?: string) {
  return handleOrchestratorCommand({ action: "resolve_agent_name", name }, null);
}

beforeEach(() => {
  // No local match => always fall through to the swarm routing table.
  vi.spyOn(lifecycle, "listAgents").mockReturnValue([] as any);
  vi.spyOn(spawner, "getSubDaemonPorts").mockReturnValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("dispatch — resolve_agent_name (cross-daemon fallback)", () => {
  it("returns the remote agent id from the swarm routing table when no local match exists", async () => {
    const refresh = vi.spyOn(router, "refreshRoutingTable").mockResolvedValue([
      { id: "remote-x", name: "Carol" },
      { id: "remote-y", name: "Dave" },
    ]);

    const result = await call("Dave");

    expect(result).toBe("remote-y");
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("returns null when the name matches neither a local nor a remote agent", async () => {
    vi.spyOn(router, "refreshRoutingTable").mockResolvedValue([{ id: "remote-x", name: "Carol" }]);

    const result = await call("Nobody");

    expect(result).toBeNull();
  });

  it("swallows a routing-table lookup failure and returns null", async () => {
    vi.spyOn(router, "refreshRoutingTable").mockRejectedValue(new Error("swarm unreachable"));

    const result = await call("Dave");

    expect(result).toBeNull();
  });
});

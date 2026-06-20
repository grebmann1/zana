import { describe, it, expect } from "vitest";

// Guards the public barrel surface of @zana-ai/contracts (src/index.ts).
// Other packages — including core's historical facade — consume these exports
// by name, so accidentally dropping or renaming one is a cross-package break.
import * as contracts from "@zana-ai/contracts";

describe("@zana-ai/contracts — public barrel surface", () => {
  it("exposes the namespace + value exports", () => {
    expect(typeof contracts.workspaceContext).toBe("object");
    expect(typeof contracts.config).toBe("object");
    expect(typeof contracts.logger).toBe("object");
    expect(typeof contracts.lazyRequire).toBe("function");
    expect(contracts.bus).toBeDefined();
    expect(typeof contracts.bus.emit).toBe("function"); // EventEmitter instance
  });

  it("EVENTS is a frozen-ish string-valued map with stable keys", () => {
    expect(typeof contracts.EVENTS).toBe("object");
    expect(contracts.EVENTS.AGENT_SPAWNED).toBe("agent:spawned");
    expect(contracts.EVENTS.ZANA_READY).toBe("zana:ready");
    for (const v of Object.values(contracts.EVENTS)) {
      expect(typeof v).toBe("string");
    }
  });

  it("flattens config members to the top level (export * from ./config)", () => {
    // e.g. `import { ZANA_DIR } from "@zana-ai/contracts"` must resolve.
    expect((contracts as any).ZANA_DIR).toBe(contracts.config.ZANA_DIR);
    expect(typeof (contracts as any).ZANA_DIR).toBe("string");
  });

  it("flattens workspace-context members to the top level", () => {
    // Both the namespace and top-level styles must point at the same fns.
    expect(typeof (contracts as any).createForWorkspace).toBe("function");
    expect((contracts as any).createForWorkspace).toBe(
      contracts.workspaceContext.createForWorkspace,
    );
    expect((contracts as any).isInitialized).toBe(
      contracts.workspaceContext.isInitialized,
    );
    expect(typeof (contracts as any).WorkspaceNotInitializedError).toBe("function");
  });

  // Service contracts (Phase 1 of the decoupling plan). These are type-only
  // except for the one runtime narrowing helper — they must be reachable from
  // the package root so packages can depend on the contract, not an impl.
  it("re-exports the service-contracts narrowing helper", () => {
    expect(typeof (contracts as any).isServiceError).toBe("function");
    expect((contracts as any).isServiceError({ error: "boom" })).toBe(true);
    expect((contracts as any).isServiceError({ ok: true })).toBe(false);
    expect((contracts as any).isServiceError(null)).toBe(false);
  });
});

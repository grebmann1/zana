// Deliberation role packs — named voter-selection presets.
//
// Inspired by plugin-sfdc-council's arch-review skill: rather than callers
// having to remember profile ids, name the common patterns. Pack resolution
// is deterministic — given (packId, quantity) the same voter list comes back.
//
// Role-count scaling is preserved from sfdc-council where it makes sense
// (1→security; 2→+performance; 3→+researcher generalist; 4+→+api-designer;
// 5+→+architect). The Slice B generalist-seat invariant in quorum.ts is the
// authority on the generalist guarantee — packs cooperate by including
// `researcher` at quantity≥3 so the invariant is a no-op on packed councils.
//
// Pack-resolution does NOT touch the profile store; the caller (deliberate.ts)
// resolves each returned profileId via core.agents.profileStore.getProfile.
// Unknown ids surface there with a clear error.

export type RolePackId = "arch" | "code-review" | "plan" | "review";

export interface RolePackSpec {
  id: RolePackId;
  description: string;
}

const PACK_SPECS: Record<RolePackId, RolePackSpec> = {
  arch: {
    id: "arch",
    description:
      "Architecture / design review — security, performance, api-design, plus a researcher generalist seat.",
  },
  "code-review": {
    id: "code-review",
    description:
      "Code review — code-reviewer, security-reviewer, plus a researcher generalist seat.",
  },
  plan: {
    id: "plan",
    description:
      "Plan / RFC review — architect, researcher (generalist), plus a security-reviewer for risk surfaces.",
  },
  review: {
    id: "review",
    description:
      "General-purpose review — researcher (generalist), code-reviewer, security-reviewer.",
  },
};

const ARCH_LADDER: string[] = [
  "security-reviewer",
  "performance-engineer",
  "researcher",       // generalist seat lands at quantity=3
  "api-designer",
  "architect",
];

const CODE_REVIEW_LADDER: string[] = [
  "code-reviewer",
  "security-reviewer",
  "researcher",       // generalist seat at quantity=3
  "performance-engineer",
  "architect",
];

const PLAN_LADDER: string[] = [
  "architect",
  "researcher",       // generalist seat at quantity=2 (plan reviews are usually heavier on context)
  "security-reviewer",
  "api-designer",
  "performance-engineer",
];

const REVIEW_LADDER: string[] = [
  "researcher",       // generalist seat at quantity=1 — review pack is generalist-first
  "code-reviewer",
  "security-reviewer",
  "performance-engineer",
  "architect",
];

const LADDERS: Record<RolePackId, string[]> = {
  arch: ARCH_LADDER,
  "code-review": CODE_REVIEW_LADDER,
  plan: PLAN_LADDER,
  review: REVIEW_LADDER,
};

export function listRolePacks(): RolePackSpec[] {
  return Object.values(PACK_SPECS);
}

export function getRolePack(id: string): RolePackSpec | null {
  if (typeof id !== "string") return null;
  return (PACK_SPECS as Record<string, RolePackSpec>)[id] ?? null;
}

// Resolve a pack to N voter profile ids. Quantity is clamped to [1, ladder.length].
// Same input always yields the same output (deterministic for replay).
export function resolveVoters(packId: string, quantity: number): string[] {
  const ladder = LADDERS[packId as RolePackId];
  if (!ladder) {
    throw new Error(`unknown role pack: ${String(packId)} (known: ${Object.keys(LADDERS).join(", ")})`);
  }
  const q = typeof quantity === "number" && Number.isFinite(quantity) ? Math.floor(quantity) : 0;
  if (q < 1) {
    throw new Error(`resolveVoters: quantity must be >= 1, got ${quantity}`);
  }
  const clamped = Math.min(q, ladder.length);
  return ladder.slice(0, clamped);
}

export type VotersInput =
  | string[]
  | { pack: string; quantity?: number };

// Normalize the union accepted by zana_deliberate's voters arg into a flat
// profileId[]. Throws on malformed input. Defaults pack quantity to 3 when
// the caller omits it (matches sfdc-council's arch-review default).
export function normalizeVotersInput(
  input: VotersInput | undefined,
  defaults: string[],
): string[] {
  if (input === undefined) return [...defaults];
  if (Array.isArray(input)) return input;
  if (input && typeof input === "object" && typeof input.pack === "string") {
    const quantity = typeof input.quantity === "number" ? input.quantity : 3;
    return resolveVoters(input.pack, quantity);
  }
  throw new Error(
    `voters must be a string[] or { pack, quantity } — received: ${JSON.stringify(input)}`,
  );
}

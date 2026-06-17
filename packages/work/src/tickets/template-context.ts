// Shared template context + renderer for ticket-watcher rule actions.
// Both `spawnProfile` (string template) and `promptTemplate` are rendered
// through here so prompts can reference bus payload fields like
// `{{oldStatus}}` and `{{updatedBy}}`, not just ticket fields.

export type TicketEventType =
  | "ticket:created"
  | "ticket:claimed"
  | "ticket:statusChanged"
  | "ticket:reviewPhaseChanged"
  | "ticket:commented"
  | "ticket:completed"
  | "ticket:updated";

export type TemplateContext = Record<string, any>;

export function buildTemplateContext(
  eventType: string,
  payload: any,
  ticket: any,
): TemplateContext {
  const p = payload || {};
  // Human-readable work location for reviewer prompts. When a worker recorded
  // where it committed (branch/worktree), surface it so the reviewer inspects
  // the right tree instead of blindly grepping HEAD. Falls back to a sentinel
  // so the prompt reads cleanly when no hint was recorded.
  const wr = ticket?.workRef;
  const workRefSummary = wr && typeof wr === "object"
    ? [wr.branch && `branch ${wr.branch}`, wr.worktree && `worktree ${wr.worktree}`, wr.commitRange && `commits ${wr.commitRange}`]
        .filter(Boolean).join(", ") || "recorded but empty"
    : "not recorded — inspect the checked-out tree, and if you cannot find the work there, record INCONCLUSIVE rather than FAIL";
  return {
    ...(ticket || {}),
    workRefSummary,
    event: eventType,
    oldStatus: p.oldStatus ?? null,
    newStatus: p.newStatus ?? ticket?.status ?? null,
    oldPhase: p.oldPhase ?? null,
    newPhase: p.newPhase ?? ticket?.reviewPhase ?? null,
    updatedBy: p.updatedBy ?? p.completedBy ?? p.authorId ?? p.agentId ?? "system",
    timestamp: new Date().toISOString(),
  };
}

export function renderTemplate(str: string, ctx: TemplateContext): string {
  if (typeof str !== "string") return "";
  return str.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const v = ctx[key];
    if (v === null || v === undefined) return "";
    if (typeof v === "object") {
      try { return JSON.stringify(v); } catch { return ""; }
    }
    return String(v);
  });
}

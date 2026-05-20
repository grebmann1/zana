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
  return {
    ...(ticket || {}),
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

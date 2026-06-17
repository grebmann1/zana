import * as fs from "node:fs";
import * as path from "node:path";
import { buildTemplateContext, renderTemplate } from "./template-context";

// Ticket-watcher rule schema (config: <workspace>/.zana/automation.json).
//
// Each rule fires when a ticket-bus event matches its trigger and then
// spawns a Claude agent. Side-effects (Slack post, Linear update, etc.)
// happen inside the agent via its MCP tools.
//
// Trigger fields:
//   event       string (default "ticket:statusChanged")
//                 one of: "ticket:created" | "ticket:claimed" |
//                 "ticket:statusChanged" | "ticket:reviewPhaseChanged" |
//                 "ticket:commented" | "ticket:completed" | "ticket:updated"
//   to          string | string[] | "*"  match newStatus / current status
//   from        string | string[] | "*"  match oldStatus
//   reviewPhase string | null            exact reviewPhase match
//   labels      string[]                 ticket must include all these labels
//
//   Legacy shape `{ status, reviewPhase, label }` is auto-rewritten to
//   `{ event: "ticket:statusChanged", to: status, reviewPhase, labels: [label] }`
//   so existing automation.json files keep working.
//
// Action fields (existing schema, unchanged):
//   spawnProfile    string with {{var}} interpolation
//   promptTemplate  string with {{var}} interpolation
//
// Top-level rule fields:
//   name      string (optional) — used as dedup key and in `zana ticket rules list`
//   disabled  boolean — if true, the rule is loaded and visible but never fires.
//                       Useful for staging or temporarily silencing a hook.
//
// Template context exposes ticket fields plus event metadata: `event`,
// `oldStatus`, `newStatus`, `oldPhase`, `newPhase`, `updatedBy`, `timestamp`.
//
// Example: notify Slack on every status change.
//   {
//     "trigger": { "event": "ticket:statusChanged" },
//     "action": {
//       "spawnProfile": "slack-notifier",
//       "promptTemplate": "Ticket {{id}} \"{{title}}\" moved {{oldStatus}} → {{newStatus}} by {{updatedBy}}. Post to #team-feed via Slack MCP."
//     }
//   }
//
// Hot-reload: automation.json is watched; saves apply to events emitted
// after reload. In-flight spawns keep their original rule. Adding a brand
// new automation.json to a workspace that didn't have one still requires a
// daemon restart.

function log(msg) { process.stderr.write(`[ticket-watcher] ${msg}\n`); }

const DEBOUNCE_MS = 150;
const MAX_CONCURRENT = 3;
const MAX_REWORK_CYCLES = 3;
const DEDUP_TTL_MS = 2000;
// Backstop for the concurrency slot: a slot is normally freed on the agent's
// `agent:terminated` event. If that event is lost (crash, dropped emit), free
// the slot after this long so the automation queue can't wedge permanently.
// Generous because real review/implement agents run for minutes.
const SLOT_BACKSTOP_MS = 15 * 60 * 1000;

const TICKET_EVENTS = [
  "ticket:created",
  "ticket:claimed",
  "ticket:statusChanged",
  "ticket:reviewPhaseChanged",
  "ticket:commented",
  "ticket:completed",
  "ticket:updated",
  "ticket:escalated",
] as const;

// Events that drive the legacy status/phase dedup map. Other event types
// (commented, claimed, updated, …) skip processedStates because they don't
// represent state transitions.
const LEGACY_DEDUP_EVENTS = new Set([
  "ticket:created",
  "ticket:statusChanged",
  "ticket:reviewPhaseChanged",
  "ticket:completed",
]);

let ticketsDir = null;
let spawnFn = null;
let processedStates = new Map();
let stateFilePath = null;
let debounceTimers = new Map();
let activeAutomations = 0;
let queue = [];
let rules = [];
let busSubscriptions = [];
// Map agentId → { ticket, rule } for spawns we initiated. When an
// agent:terminated event fires for one of these, we parse its output for a
// VERDICT line and apply the corresponding ticket state transition.
let inFlightSpawns = new Map();
// Map agentId → release() for the concurrency slot the spawn is holding. The
// slot is freed when the agent terminates (real backpressure) or by the
// wall-clock backstop. Separate from inFlightSpawns because EVERY spawn holds a
// slot, but only expectVerdict rules are tracked for applyVerdict.
let slotByAgent = new Map<string, () => void>();
// Short-lived dedup keyed by `(ruleKey, eventType, ticketId, oldStatus, newStatus)`
// to swallow duplicate emits within DEDUP_TTL_MS.
let recentlyFired = new Map<string, number>();
// ticketId → timestamp of the last STRUCTURED verdict (via zana_ticket_verdict).
// When a reviewer used the tool, the agent:terminated text-fallback must NOT
// re-apply the verdict. Entries are swept on read past STRUCTURED_VERDICT_TTL_MS.
let structuredVerdictSeen = new Map<string, number>();
const STRUCTURED_VERDICT_TTL_MS = 60_000;

// Hot-reload: watch automation.json so rule edits take effect without a
// daemon restart. Edits apply to events emitted after reload; in-flight
// spawns keep their original rule (each queued item already captured `rule`
// by closure).
let configPathTracked: string | null = null;
let configWatcher: any = null;
let configReloadTimer: ReturnType<typeof setTimeout> | null = null;
const CONFIG_RELOAD_DEBOUNCE_MS = 100;

// Validation findings produced by validateRules(). Exposed via getRuleWarnings()
// so the CLI / HTTP API can surface schema mistakes (typos in event names,
// missing spawnProfile, etc.) without making the daemon refuse to start.
type RuleWarning = { ruleIndex: number; ruleName: string; level: "warn" | "error"; message: string };
let ruleWarnings: RuleWarning[] = [];

const KNOWN_TRIGGER_FIELDS = new Set(["event", "to", "from", "reviewPhase", "labels", "status", "label"]);
const KNOWN_ACTION_TYPES = new Set(["spawnAgent", "workflow"]); // spawnAgent is implicit when only spawnProfile is set

export function init({ ticketsDirectory, spawnAgent, configPath }) {
  ticketsDir = ticketsDirectory;
  spawnFn = spawnAgent;
  stateFilePath = path.join(path.dirname(ticketsDir), "automation-state.json");

  loadRules(configPath);
  loadProcessedStates();
  watchConfigFile();

  // Keep mkdir for compatibility — JSON-fallback ticket store still writes here.
  if (!fs.existsSync(ticketsDir)) {
    fs.mkdirSync(ticketsDir, { recursive: true });
  }

  // Subscribe to every ticket lifecycle event on the in-process bus.
  // This replaces the old fs.watch approach: the SQLite-backed ticket store
  // doesn't write JSON files, so fs.watch never fired. Bus events fire on
  // every state change regardless of the underlying store.
  const { bus } = require("@zana-ai/core").events;
  for (const eventType of TICKET_EVENTS) {
    const listener = (msg) => {
      if (msg && msg.ticketId) scheduleCheck(eventType, msg);
    };
    bus.on(eventType, listener);
    busSubscriptions.push(() => bus.off(eventType, listener));
  }

  // Listen for agent termination so we can parse VERDICT lines from review
  // agents we spawned and apply the resulting ticket state transitions.
  const onAgentTerminated = (msg: any) => {
    if (!msg || !msg.agentId) return;
    // Free the concurrency slot this agent was holding (real backpressure —
    // slots are held for the agent's whole lifetime, not a fixed timer).
    const releaseSlot = slotByAgent.get(msg.agentId);
    if (releaseSlot) {
      slotByAgent.delete(msg.agentId);
      releaseSlot();
    }
    const tracked = inFlightSpawns.get(msg.agentId);
    if (!tracked) return; // not one of ours (or fire-and-forget)
    inFlightSpawns.delete(msg.agentId);
    let result: string = msg.output || "";
    if (!result) {
      // Fallback: agent:terminated may not include output for some exit paths;
      // pull the result text directly from the agent record.
      try {
        const agentManager = require("@zana-ai/core").agents.manager;
        const agent = agentManager.getAgent(msg.agentId);
        result = agent?.result || "";
      } catch {}
    }
    try {
      applyVerdict(tracked.ticket, tracked.rule, result);
    } catch (err: any) {
      log(`applyVerdict failed for ticket ${tracked.ticket.id}: ${err.message || err}`);
    }
  };
  bus.on("agent:terminated", onAgentTerminated);
  busSubscriptions.push(() => bus.off("agent:terminated", onAgentTerminated));

  // Structured verdict path (preferred over parsing the VERDICT: text line).
  // A reviewer calls the zana_ticket_verdict MCP tool → service.recordVerdict
  // → emits "ticket:verdict" with { ticketId, kind, reason }. We apply the same
  // state transition applyVerdict would, and remember it so the text-fallback
  // on agent:terminated doesn't double-apply for the same ticket.
  const onVerdict = (msg: any) => {
    if (!msg || !msg.ticketId || !msg.kind) return;
    const ticket = readTicket(msg.ticketId);
    if (!ticket) return;
    structuredVerdictSeen.set(msg.ticketId, Date.now());
    try {
      applyParsedVerdict(ticket, { spawnProfile: msg.profileLabel || "reviewer" },
        { kind: String(msg.kind).toUpperCase(), reason: msg.reason || null },
        msg.detail || "");
    } catch (err: any) {
      log(`structured verdict apply failed for ticket ${msg.ticketId}: ${err.message || err}`);
    }
  };
  bus.on("ticket:verdict", onVerdict);
  busSubscriptions.push(() => bus.off("ticket:verdict", onVerdict));

  log(`Subscribed to ticket bus events (${rules.length} rules loaded)`);
}

// Rule shape note — `action.expectVerdict`:
//   true  → this spawn is a reviewer/worker whose terminal output decides a
//           ticket transition; track it in inFlightSpawns and run applyVerdict
//           on agent:terminated (PASS/FAIL/READY/BLOCKED).
//   false → fire-and-forget spawn (the worker drives its own ticket transition
//           via MCP tools, e.g. an implementer moving the ticket to review, or
//           a triage scout that just comments/labels). NOT tracked, so a
//           missing VERDICT never produces a "manual intervention needed" note.
// Omitted defaults to false. The three legacy review rules set it true.
const DEFAULT_RULES = [
  {
    // Triage gate: when a bug ticket is created, run a CHEAP read-only scout
    // that verifies the bug still reproduces against current code before any
    // expensive worker is dispatched. Fire-and-forget — the scout comments its
    // finding (and, if enabled, labels stale tickets) via MCP tools; there is
    // no VERDICT to parse. Label-gated to "bug" so feature/chore tickets skip
    // it (staleness is a bug-ticket problem). Costs pennies (haiku profile).
    name: "triage-on-create",
    trigger: { event: "ticket:created", labels: ["bug"] },
    action: { spawnProfile: "triage-scout", expectVerdict: false },
    promptTemplate: "Triage bug ticket \"{{title}}\" (ID: {{id}}).\n\nDescription: {{description}}\n\nVerify whether this bug STILL reproduces against the CURRENT code. Tickets often cite stale line numbers from before a refactor — locate the code by symbol/content, not the old line number. Use read-only tools only.\n\nRecord your finding with zana_ticket_comment: one of STILL-OPEN (cite current file:line), ALREADY-FIXED (cite the evidence), or CANNOT-REPRODUCE. Do NOT fix anything and do NOT close the ticket unless explicitly told auto-close is enabled — comment only by default.",
  },
  {
    // Design-only escalation: a ticket that changes a core invariant (or that
    // the router couldn't confidently place) is escalated rather than handed
    // straight to an implementer. We spawn an architect to produce a design +
    // ADR recommendation and PARK the ticket (it carries "awaiting-decision",
    // which the auto-implement rule skips) until a human releases it. Fire-and-
    // forget: the architect writes its design as a comment; there's no VERDICT.
    name: "design-only-on-escalation",
    trigger: { event: "ticket:escalated" },
    action: { spawnProfile: "architect", expectVerdict: false },
    promptTemplate: "DESIGN ONLY — ticket \"{{title}}\" (ID: {{id}}) was escalated because it changes a core invariant or the router was not confident. Do NOT write production code.\n\nDescription: {{description}}\n\nProduce: (1) a clear recommendation with rationale and rejected alternatives, (2) a minimal implementation outline (files, sequencing), (3) risks + test strategy, (4) a draft ADR in docs/decisions house style. Read the relevant code and any shared artifacts first.\n\nRecord your design by calling zana_ticket_comment with the full recommendation. The ticket is parked for a human decision — do not change its status. A human will remove the awaiting-decision label to release it for implementation.",
  },
  {
    // Auto-implement: when a ticket is claimed with a bound profile, spawn that
    // profile to actually DO the work. Closes the front of the pipeline — the
    // review rules below already handled everything AFTER implementation.
    // Fire-and-forget: the implementer drives its own status→review transition
    // (the QA rule then takes over), so there's no VERDICT to parse here.
    // `designOnly` tickets are parked for a human and must NOT auto-implement.
    name: "auto-implement",
    trigger: { event: "ticket:claimed" },
    action: { spawnProfile: "{{assigneeProfileId}}", expectVerdict: false, skipLabels: ["awaiting-decision"] },
    promptTemplate: "Implement ticket \"{{title}}\" (ID: {{id}}).\n\nDescription: {{description}}\n\nDo the work end to end: read the relevant files, make the change, build, and run the tests for the affected package(s). Keep the change minimal and idiomatic to the surrounding code.\n\nWhen the implementation is complete and tests pass, call the MCP tool zana_ticket_update with status \"review\", a progress note listing the files you changed, AND a workRef object recording where the work landed: { \"branch\": <git branch you committed on>, \"commitRange\": <commit sha or range>, \"worktree\": <worktree path if not the main checkout> }. This lets the reviewer inspect the correct tree instead of blindly grepping HEAD. If you cannot complete it, call zana_ticket_update with status \"blocked\" and explain why in the progress note.\n\nDo not over-build — nothing more than the ticket asks for.",
  },
  {
    trigger: { status: "review", reviewPhase: "qa" },
    action: { spawnProfile: "code-reviewer", expectVerdict: true },
    promptTemplate: "QA Review for ticket \"{{title}}\" (ID: {{id}}).\n\nDescription: {{description}}\n\nWork location: {{workRefSummary}}. If a branch/worktree is named, inspect THAT tree (e.g. `git log <branch>`, `git diff <commitRange>`), not just the checked-out HEAD.\n\nRead the relevant files. Evaluate correctness, security, and code quality.\n\nPREFERRED: record your verdict by calling the MCP tool zana_ticket_verdict with verdict PASS, FAIL, or INCONCLUSIVE (and a one-line reason on FAIL/INCONCLUSIVE).\nFALLBACK (deprecated): if that tool is unavailable, your output MUST end with EXACTLY ONE of these lines (no markdown around it):\nVERDICT: PASS\nVERDICT: FAIL — <one-line reason>\nVERDICT: INCONCLUSIVE — <one-line reason>\n\nPASS = code is good enough to advance to architecture review.\nFAIL = the implementation IS present and has real defects; ticket goes to rework with your findings as the reason.\nINCONCLUSIVE = you could NOT locate the implementation on the tree you inspected (likely on a different branch/worktree). Never report FAIL for work you simply could not find — that is a false negative. The ticket stays in review for a re-review against the correct tree.\n\nBe terse. Lead with the verdict reasoning.",
  },
  {
    // The qa→architecture advance happens via updateReviewPhase(), which emits
    // ticket:reviewPhaseChanged (status stays "review" throughout). Triggering
    // on ticket:statusChanged here would never match — the only statusChanged
    // into review auto-sets reviewPhase=qa, never architecture. Listen for the
    // phase-change event so the architect actually spawns.
    trigger: { event: "ticket:reviewPhaseChanged", reviewPhase: "architecture" },
    action: { spawnProfile: "architect", expectVerdict: true },
    promptTemplate: "Architecture Review for ticket \"{{title}}\" (ID: {{id}}).\n\nDescription: {{description}}\n\nWork location: {{workRefSummary}}. If a branch/worktree is named, inspect THAT tree, not just the checked-out HEAD.\n\nCheck that the implementation matches the architecture, design docs, and conventions. Read shared artifacts for context.\n\nPREFERRED: record your verdict by calling the MCP tool zana_ticket_verdict with verdict PASS, FAIL, or INCONCLUSIVE.\nFALLBACK (deprecated): if that tool is unavailable, your output MUST end with EXACTLY ONE of these lines:\nVERDICT: PASS\nVERDICT: FAIL — <one-line reason>\nVERDICT: INCONCLUSIVE — <one-line reason>\n\nPASS = ticket is done.\nFAIL = the implementation IS present and has architectural issues; ticket goes to rework.\nINCONCLUSIVE = you could NOT locate the implementation on the inspected tree; the ticket stays in review for re-review. Never FAIL work you could not find.\n\nBe terse.",
  },
  {
    trigger: { status: "rework" },
    action: { spawnProfile: "{{assigneeProfileId}}", expectVerdict: true },
    promptTemplate: "REWORK needed on ticket \"{{title}}\" (ID: {{id}}).\n\nYour previous work was reviewed and needs changes. Read the latest ticket comments for reviewer feedback and fix the identified issues.\n\nPREFERRED: when done, record your verdict by calling the MCP tool zana_ticket_verdict with verdict READY (fixes complete, ready for re-review) or BLOCKED (with a reason).\nFALLBACK (deprecated): if that tool is unavailable, your output MUST end with EXACTLY ONE of these lines:\nVERDICT: READY  — fixes complete, ready for re-review\nVERDICT: BLOCKED — <reason; ticket will be marked blocked>\n\nOriginal description: {{description}}",
  },
];

export function loadRules(configPath) {
  if (configPath) configPathTracked = configPath;
  const resolved = configPathTracked
    || (ticketsDir ? path.join(path.dirname(ticketsDir), "config.json") : null);
  try {
    const config = JSON.parse(fs.readFileSync(resolved!, "utf8"));
    // Use user-provided rules only if they're a non-empty array. Otherwise fall back to defaults.
    if (Array.isArray(config.automation) && config.automation.length > 0) {
      rules = config.automation;
    } else {
      rules = DEFAULT_RULES;
    }
  } catch {
    rules = DEFAULT_RULES;
  }
  validateRules();
}

export function validateRules(): RuleWarning[] {
  ruleWarnings = [];
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i];
    const name = rule?.name || `idx-${i}`;
    const push = (level: "warn" | "error", message: string) =>
      ruleWarnings.push({ ruleIndex: i, ruleName: name, level, message });

    if (!rule || typeof rule !== "object") {
      push("error", "rule is not an object");
      continue;
    }

    // Trigger validation
    const trig = rule.trigger;
    if (!trig || typeof trig !== "object") {
      push("error", "missing or invalid `trigger`");
    } else {
      // Legacy shape (`status` without `event`) is allowed; only flag
      // unknown keys that match neither legacy nor new schema.
      for (const key of Object.keys(trig)) {
        if (!KNOWN_TRIGGER_FIELDS.has(key)) {
          push("warn", `unknown trigger field "${key}" (allowed: ${[...KNOWN_TRIGGER_FIELDS].join(", ")})`);
        }
      }
      const normalized = normalizeTrigger(trig);
      if (!TICKET_EVENTS.includes(normalized.event as any)) {
        push("error", `unknown event "${normalized.event}" (allowed: ${TICKET_EVENTS.join(", ")})`);
      }
    }

    // Action validation
    const action = rule.action;
    if (!action || typeof action !== "object") {
      push("error", "missing or invalid `action`");
    } else if (action.type === "workflow") {
      if (!action.skillId) push("error", "action.type=workflow requires `skillId`");
    } else if (action.type && !KNOWN_ACTION_TYPES.has(action.type)) {
      push("warn", `unknown action.type "${action.type}" (allowed: spawnAgent, workflow, or omit type)`);
    } else if (!action.spawnProfile) {
      push("error", "missing `action.spawnProfile`");
    }
  }

  for (const w of ruleWarnings) {
    log(`${w.level.toUpperCase()}: rule "${w.ruleName}": ${w.message}`);
  }
  return ruleWarnings;
}

export function getRuleWarnings(): RuleWarning[] {
  return ruleWarnings.slice();
}

function watchConfigFile() {
  if (!configPathTracked) return;
  if (configWatcher) {
    try { fs.unwatchFile(configWatcher); } catch {}
    configWatcher = null;
  }
  if (!fs.existsSync(configPathTracked)) {
    // No file yet — daemon must restart to pick up a brand-new config.
    return;
  }
  // Use fs.watchFile (poll-based) rather than fs.watch (inotify/kqueue):
  // fs.watch is unreliable on individual files across macOS/Linux,
  // especially when editors rename-on-save. Polling at 200ms is slower
  // but rock solid and survives inode swaps without re-registration.
  const tracked = configPathTracked;
  configWatcher = tracked;
  fs.watchFile(tracked, { interval: 200, persistent: false }, (curr, prev) => {
    if (curr.mtimeMs === prev.mtimeMs && curr.size === prev.size) return;
    if (configReloadTimer) clearTimeout(configReloadTimer);
    configReloadTimer = setTimeout(() => {
      configReloadTimer = null;
      const before = rules.length;
      loadRules(tracked);
      log(`Reloaded automation rules (${before} → ${rules.length})`);
    }, CONFIG_RELOAD_DEBOUNCE_MS);
  });
}

function loadProcessedStates() {
  try {
    const data = JSON.parse(fs.readFileSync(stateFilePath, "utf8"));
    processedStates = new Map(Object.entries(data));
  } catch {
    try {
      const entries = fs.readdirSync(ticketsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith("_")) continue;
        let ticket = null;
        if (entry.isDirectory()) {
          try { ticket = JSON.parse(fs.readFileSync(path.join(ticketsDir, entry.name, "ticket.json"), "utf8")); } catch {}
        } else if (entry.name.endsWith(".json")) {
          try { ticket = JSON.parse(fs.readFileSync(path.join(ticketsDir, entry.name), "utf8")); } catch {}
        }
        if (ticket) {
          processedStates.set(ticket.id, JSON.stringify({ status: ticket.status, reviewPhase: ticket.reviewPhase || null }));
        }
      }
    } catch {}
  }
  saveProcessedStates();
}

function saveProcessedStates() {
  try {
    fs.writeFileSync(stateFilePath, JSON.stringify(Object.fromEntries(processedStates), null, 2), "utf8");
  } catch {}
}

function scheduleCheck(eventType, payload) {
  // Debounce by (eventType, ticketId) so two distinct events on the same
  // ticket don't collapse into one.
  const ticketId = payload.ticketId;
  const key = `${eventType}:${ticketId}`;
  if (debounceTimers.has(key)) clearTimeout(debounceTimers.get(key));
  debounceTimers.set(key, setTimeout(() => {
    debounceTimers.delete(key);
    checkTicket(eventType, payload);
  }, DEBOUNCE_MS));
}

let readTicketOverride: ((id: string) => any) | null = null;

function readTicket(ticketId) {
  if (readTicketOverride) return readTicketOverride(ticketId);
  // Goes through the ticket-service abstraction layer, which dispatches to
  // sqlite-backed or JSON-backed storage as appropriate.
  try {
    const ticketService = require("./service");
    return ticketService.getTicket(ticketId);
  } catch {
    return null;
  }
}

// Test-only: override the ticket reader. Production code never sets this.
export function _setReadTicketOverride(fn: ((id: string) => any) | null) {
  readTicketOverride = fn;
}

function checkTicket(eventType, payload) {
  const ticketId = payload.ticketId;
  const ticket = readTicket(ticketId);
  if (!ticket) return;

  // Legacy state-based dedup: only applies to events that represent a state
  // transition. Same `(status, reviewPhase)` as last time → skip. This
  // preserves existing watcher behavior for the review pipeline.
  if (LEGACY_DEDUP_EVENTS.has(eventType)) {
    const currentKey = JSON.stringify({ status: ticket.status, reviewPhase: ticket.reviewPhase || null });
    const previousKey = processedStates.get(ticket.id);
    if (previousKey === currentKey) return;
    processedStates.set(ticket.id, currentKey);
    saveProcessedStates();
  }

  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i];
    if (!matchesRule(rule, eventType, payload, ticket)) continue;
    if (isDuplicateFire(rule, i, eventType, payload)) continue;
    enqueueAutomation(rule, eventType, payload, ticket);
  }
}

export function normalizeTrigger(trigger: any): any {
  const t = trigger && typeof trigger === "object" ? trigger : {};
  // Legacy shape: bare `status` / `label` keys mean ticket:statusChanged.
  if (!t.event && (t.status !== undefined || t.label !== undefined)) {
    const labels: string[] = [];
    if (typeof t.label === "string") labels.push(t.label);
    if (Array.isArray(t.labels)) labels.push(...t.labels);
    return {
      event: "ticket:statusChanged",
      to: t.status,
      reviewPhase: t.reviewPhase,
      labels: labels.length ? labels : undefined,
    };
  }
  return {
    event: t.event || "ticket:statusChanged",
    to: t.to,
    from: t.from,
    reviewPhase: t.reviewPhase,
    labels: Array.isArray(t.labels) ? t.labels : (typeof t.label === "string" ? [t.label] : undefined),
  };
}

function matchValue(spec: any, actual: any): boolean {
  if (spec === undefined || spec === null) return true;
  if (spec === "*") return true;
  if (Array.isArray(spec)) return spec.some((s) => s === "*" || s === actual);
  return spec === actual;
}

export function matchesRule(rule, eventType, payload, ticket): boolean {
  if (rule?.disabled === true) return false;
  const t = normalizeTrigger(rule?.trigger);
  if (t.event !== eventType) return false;
  if (t.to !== undefined && !matchValue(t.to, payload?.newStatus ?? ticket?.status ?? null)) return false;
  if (t.from !== undefined && !matchValue(t.from, payload?.oldStatus ?? null)) return false;
  if (t.reviewPhase !== undefined && (ticket?.reviewPhase ?? null) !== t.reviewPhase) return false;
  if (Array.isArray(t.labels) && t.labels.length > 0) {
    const owned = Array.isArray(ticket?.labels) ? ticket.labels : [];
    if (!t.labels.every((l) => owned.includes(l))) return false;
  }
  return true;
}

function isDuplicateFire(rule, ruleIndex, eventType, payload): boolean {
  const ruleKey = rule?.name || `idx-${ruleIndex}`;
  const dedupKey = [
    ruleKey,
    eventType,
    payload?.ticketId ?? "",
    payload?.oldStatus ?? "",
    payload?.newStatus ?? "",
  ].join("|");
  const now = Date.now();
  // Sweep expired entries opportunistically (cheap; map stays small).
  for (const [k, ts] of recentlyFired) {
    if (now - ts > DEDUP_TTL_MS) recentlyFired.delete(k);
  }
  if (recentlyFired.has(dedupKey)) return true;
  recentlyFired.set(dedupKey, now);
  return false;
}

function enqueueAutomation(rule, eventType, payload, ticket) {
  queue.push({ rule, eventType, payload, ticket });
  processQueue();
}

function processQueue() {
  while (queue.length > 0 && activeAutomations < MAX_CONCURRENT) {
    const item = queue.shift();
    executeAutomation(item.rule, item.eventType, item.payload, item.ticket);
  }
}

function executeAutomation(rule, eventType, payload, ticket) {
  if (rule.action?.type === "workflow" && rule.action.skillId) {
    executeWorkflowAction(rule, ticket);
    return;
  }
  if (!spawnFn || !rule.action?.spawnProfile) return;

  // Block infinite rework loops
  if (ticket.status === "rework" && (ticket.reworkCount || 0) >= MAX_REWORK_CYCLES) {
    log(`Ticket ${ticket.id} exceeded ${MAX_REWORK_CYCLES} rework cycles — marking as blocked`);
    markBlocked(ticket);
    return;
  }

  // skipLabels: a guard so a rule can decline to fire for tickets carrying a
  // given label (e.g. auto-implement must NOT fire on a design-only ticket
  // parked for a human — it carries "awaiting-decision").
  const skipLabels = Array.isArray(rule.action?.skipLabels) ? rule.action.skipLabels : [];
  if (skipLabels.length > 0) {
    const owned = Array.isArray(ticket?.labels) ? ticket.labels : [];
    if (skipLabels.some((l) => owned.includes(l))) {
      log(`Skipping ${rule.name || "rule"} for ticket ${ticket.id} — carries skip label`);
      return;
    }
  }

  const ctx = buildTemplateContext(eventType, payload, ticket);
  const profileId = renderTemplate(rule.action.spawnProfile, ctx);

  if (!profileId || profileId.includes("{{")) {
    log(`Cannot resolve profile for ticket ${ticket.id}: ${rule.action.spawnProfile} (assigneeProfileId=${ticket.assigneeProfileId})`);
    return;
  }

  activeAutomations++;

  const prompt = renderTemplate(
    rule.promptTemplate || `Work on ticket "${ticket.title}"`,
    ctx,
  );

  log(`Auto-spawning ${profileId} for ticket ${ticket.id} on ${eventType} (status=${ticket.status}, phase=${ticket.reviewPhase})`);

  // Slot accounting: the slot is held until the spawned agent actually
  // TERMINATES (real backpressure), not a fixed timer. A prior version released
  // after 2000ms regardless of the agent's lifetime, so MAX_CONCURRENT was
  // fiction — a creation burst could fan out far past the cap into many live
  // claude children. We release on `agent:terminated` (see releaseSlot, wired in
  // the terminated handler) with a generous wall-clock backstop so a lost
  // terminated event can't leak a slot forever.
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    activeAutomations--;
    processQueue();
  };

  try {
    Promise.resolve(spawnFn(profileId, prompt, ticket.id))
      .then((result) => {
        if (result && result.error) {
          log(`Spawn for ticket ${ticket.id} returned error: ${result.error}`);
          release(); // nothing to wait for
        } else if (result && result.agentId) {
          log(`Spawn for ticket ${ticket.id} → agent ${result.agentId}`);
          // Hold the slot until this agent terminates.
          slotByAgent.set(result.agentId, release);
          // Track spawns whose terminal output decides a ticket transition so
          // applyVerdict runs on agent:terminated. Default is fire-and-forget;
          // only review/rework rules opt IN with `expectVerdict: true`.
          if (rule.action?.expectVerdict === true) {
            inFlightSpawns.set(result.agentId, { ticket, rule });
          }
        } else {
          release(); // unexpected shape — don't leak the slot
        }
      })
      .catch((err) => {
        log(`Spawn failed for ticket ${ticket.id}: ${err.message || err}`);
        release();
      });
  } catch (err) {
    log(`Spawn failed (sync): ${err.message}`);
    release();
  }

  // Wall-clock backstop: if the agent never emits agent:terminated (crash, lost
  // event), free the slot after SLOT_BACKSTOP_MS so the queue can't wedge.
  setTimeout(release, SLOT_BACKSTOP_MS);
}

function executeWorkflowAction(rule, ticket) {
  activeAutomations++;
  log(`Running workflow skill ${rule.action.skillId} for ticket ${ticket.id}`);
  const skillStore = require("@zana-ai/extras").settings.skillStore;
  const workflowEngine = require("../scheduling/workflow-engine");
  const skill = skillStore.getSkill(rule.action.skillId);
  if (!skill || skill.type !== "workflow") {
    log(`Workflow skill not found or wrong type: ${rule.action.skillId}`);
    activeAutomations--;
    processQueue();
    return;
  }
  workflowEngine.executeWorkflow(skill, { ticket }).then(() => {
    activeAutomations--;
    processQueue();
  }).catch((err) => {
    log(`Workflow failed: ${err.message}`);
    activeAutomations--;
    processQueue();
  });
}

// Parse a VERDICT line from agent output and apply the corresponding state
// transition. Verdicts:
//   "VERDICT: PASS"             → advance reviewPhase or complete ticket
//   "VERDICT: FAIL — reason"    → set status=rework with reason
//   "VERDICT: READY"            → set status=review (rework finished, re-review)
//   "VERDICT: BLOCKED — reason" → set status=blocked with reason
//   "VERDICT: INCONCLUSIVE — …" → no transition (work not found on inspected tree)
// Match the LAST occurrence on its own line (anchored end of text or line)
// to avoid being fooled by example/quoted verdicts earlier in the body.
const VERDICT_RE = /^VERDICT:\s*(PASS|FAIL|READY|BLOCKED|INCONCLUSIVE)\b\s*(?:[—–-]\s*(.+?))?\s*$/im;

export function parseVerdict(text: string): { kind: string; reason: string | null } | null {
  if (!text || typeof text !== "string") return null;
  // Search lines from bottom up to honor "must end with" contract.
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    const m = line.match(/^VERDICT:\s*(PASS|FAIL|READY|BLOCKED|INCONCLUSIVE)\b\s*(?:[—–-]\s*(.+))?$/i);
    if (m) return { kind: m[1].toUpperCase(), reason: (m[2] || "").trim() || null };
    // Stop scanning once we hit a non-blank, non-verdict line — the contract
    // says the verdict must be the last line.
    break;
  }
  // Fallback: a global search in case the agent appended trailing whitespace
  // or extra punctuation we didn't anticipate.
  const fallback = VERDICT_RE.exec(text);
  if (fallback) return { kind: fallback[1].toUpperCase(), reason: (fallback[2] || "").trim() || null };
  return null;
}

// Test-only: allow integration tests to swap in a stub ticket service so
// applyVerdict's state transitions can be observed without booting the real
// SQLite store.
let serviceOverride: any = null;
export function _setServiceOverride(svc: any) { serviceOverride = svc; }

// agent:terminated handler — the TEXT-fallback path. Parses the VERDICT: line
// from agent output. Skipped when a structured verdict (zana_ticket_verdict)
// already arrived for this ticket, so the two paths never double-apply.
function applyVerdict(ticket: any, rule: any, agentResult: string) {
  const seenAt = structuredVerdictSeen.get(ticket.id);
  if (seenAt && Date.now() - seenAt < STRUCTURED_VERDICT_TTL_MS) {
    structuredVerdictSeen.delete(ticket.id);
    log(`Ticket ${ticket.id} already had a structured verdict — skipping text-fallback parse`);
    return;
  }
  const verdict = parseVerdict(agentResult);
  const profileLabel = rule?.action?.spawnProfile || "Automation";

  if (!verdict) {
    const ticketService = serviceOverride || require("./service");
    log(`No VERDICT found in agent output for ticket ${ticket.id} — leaving state untouched, adding comment`);
    ticketService.addComment(
      ticket.id,
      "ticket-watcher",
      "Automation",
      `⚠️ Review agent (${profileLabel}) did not produce a parseable VERDICT line. Manual intervention needed.\n\nAgent output (first 500 chars):\n${(agentResult || "(empty)").slice(0, 500)}`
    );
    return;
  }

  applyParsedVerdict(ticket, rule?.action || {}, verdict, agentResult);
}

// Shared transition logic for BOTH the structured-verdict and text-fallback
// paths. Records an audit comment then applies the PASS/FAIL/READY/BLOCKED
// state transition. `detail` is the full agent output (text path) or empty.
function applyParsedVerdict(
  ticket: any,
  action: any,
  verdict: { kind: string; reason: string | null },
  detail: string,
) {
  const ticketService = serviceOverride || require("./service");
  const actor = "ticket-watcher";
  const profileLabel = action?.spawnProfile || "Automation";

  // Idempotency / race guard. The structured-verdict path (ticket:verdict) and
  // the text-fallback path (agent:terminated) are independent, unordered bus
  // events, and a reviewer may call zana_ticket_verdict more than once. Re-read
  // the CURRENT ticket and only transition if it's still in a state the verdict
  // applies to — a second verdict for an already-moved ticket becomes a logged
  // no-op instead of a double transition. (The `ticket` arg is the stale
  // snapshot captured at spawn time; trust the store, not it.)
  const current = ticketService.getTicket(ticket.id) || ticket;

  // INCONCLUSIVE: the reviewer could not locate the work on the tree it
  // inspected (commonly because it was committed on a different branch/worktree
  // than the one checked out). This is NOT a failure — record the finding and
  // leave the ticket in review for a re-review against the correct tree. Forcing
  // it to rework here is exactly the branch-blind false-negative we are fixing.
  if (verdict.kind === "INCONCLUSIVE") {
    log(`Inconclusive review for ticket ${ticket.id}${verdict.reason ? " — " + verdict.reason : ""} — leaving in review`);
    ticketService.addComment(
      ticket.id,
      actor,
      profileLabel,
      `**INCONCLUSIVE**${verdict.reason ? `: ${verdict.reason}` : ""}\n\nThe reviewer could not locate the implementation on the inspected tree. The work may be on a different branch or worktree. The ticket stays in review — re-run the reviewer against the correct tree (record a \`workRef\` via zana_ticket_update) or attest completion with evidence via zana_ticket_complete.\n\n---\n\n${(detail || verdict.reason || "").slice(0, 4000)}`
    );
    return;
  }

  const PASS_OR_FAIL = verdict.kind === "PASS" || verdict.kind === "FAIL";
  if (PASS_OR_FAIL && current.status !== "review") {
    log(`Ignoring ${verdict.kind} for ticket ${ticket.id}: no longer in review (status=${current.status}) — already resolved`);
    return;
  }
  if (verdict.kind === "READY" && current.status !== "rework") {
    log(`Ignoring READY for ticket ${ticket.id}: not in rework (status=${current.status})`);
    return;
  }

  log(`Verdict for ticket ${ticket.id}: ${verdict.kind}${verdict.reason ? " — " + verdict.reason : ""}`);

  // Add a comment with the agent's output / reason for the audit trail.
  ticketService.addComment(
    ticket.id,
    actor,
    profileLabel,
    `**${verdict.kind}**${verdict.reason ? `: ${verdict.reason}` : ""}\n\n---\n\n${(detail || verdict.reason || "").slice(0, 4000)}`
  );

  if (verdict.kind === "PASS") {
    if (current.reviewPhase === "qa") {
      ticketService.updateReviewPhase(ticket.id, "architecture", actor);
    } else if (current.reviewPhase === "architecture") {
      ticketService.completeTicket(ticket.id, "Approved by automated review pipeline.", actor);
    } else {
      log(`Unexpected reviewPhase ${current.reviewPhase} on PASS for ticket ${ticket.id}`);
    }
  } else if (verdict.kind === "FAIL") {
    // updateStatus("rework") increments reworkCount and emits the bus event.
    ticketService.updateStatus(ticket.id, "rework", actor);
  } else if (verdict.kind === "READY") {
    // Rework finished — kick back to review (qa phase). The status transition
    // map only allows rework→{in-progress,blocked,cancelled}, so we go through
    // in-progress first to legally reach review again.
    const toInProgress = ticketService.updateStatus(ticket.id, "in-progress", actor);
    if (toInProgress && toInProgress.ok) {
      const toReview = ticketService.updateStatus(ticket.id, "review", actor);
      if (toReview && toReview.ok) {
        ticketService.updateReviewPhase(ticket.id, "qa", actor);
      }
    }
  } else if (verdict.kind === "BLOCKED") {
    ticketService.updateStatus(ticket.id, "blocked", actor);
  }
}

function markBlocked(ticket) {
  try {
    // Honor the test service override (same as applyVerdict/applyParsedVerdict).
    // Using a hardcoded require here would bypass an injected stub and, worse,
    // write to the real SQLite store from a context that expected the override.
    const ticketService = serviceOverride || require("./service");
    ticketService.updateStatus(ticket.id, "blocked", "ticket-watcher");
    ticketService.addComment(
      ticket.id,
      "ticket-watcher",
      "Automation",
      `⚠️ BLOCKED: This ticket has failed review ${ticket.reworkCount} times. Automatic rework cycles exhausted. Human intervention required.\n\nPlease review the comment history, identify the root issue, and either:\n- Provide guidance and move back to "in-progress" manually\n- Reassign to a different agent profile\n- Break into smaller tickets`
    );
    const { bus } = require("@zana-ai/core").events;
    bus.emit("ticket:blocked", { ticketId: ticket.id, reason: "max_rework_cycles", reworkCount: ticket.reworkCount });
    log(`Ticket ${ticket.id} marked as blocked — human intervention required`);
  } catch (err) {
    log(`Failed to mark ticket ${ticket.id} as blocked: ${err.message}`);
  }
}

export function stop() {
  for (const unsub of busSubscriptions) {
    try { unsub(); } catch {}
  }
  busSubscriptions = [];
  for (const timer of debounceTimers.values()) clearTimeout(timer);
  debounceTimers.clear();
  if (configReloadTimer) { clearTimeout(configReloadTimer); configReloadTimer = null; }
  if (configWatcher) { try { fs.unwatchFile(configWatcher); } catch {} configWatcher = null; }
  configPathTracked = null;
  inFlightSpawns.clear();
  slotByAgent.clear();
  recentlyFired.clear();
  structuredVerdictSeen.clear();
  queue = [];
  activeAutomations = 0;
  saveProcessedStates();
  log("Stopped");
}

export function isRunning() { return busSubscriptions.length > 0; }

export function getRules() { return rules; }

// Test-only: expose the processedStates map so integration tests can verify
// in-process bus delivery without coupling to internal implementation.
export function _getProcessedStates() { return processedStates; }

// Test-only: reset the dedup LRU between scenarios. Vitest module isolation
// means tests share watcher state across `it` blocks within one file.
export function _resetDedup() {
  recentlyFired.clear();
  processedStates.clear();
  structuredVerdictSeen.clear();
}

// Test-only: seed inFlightSpawns so a test can drive the agent:terminated
// verdict path without exercising the real spawn flow.
export function _trackForTest(agentId: string, ticket: any, rule: any) {
  inFlightSpawns.set(agentId, { ticket, rule });
}

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

const TICKET_EVENTS = [
  "ticket:created",
  "ticket:claimed",
  "ticket:statusChanged",
  "ticket:reviewPhaseChanged",
  "ticket:commented",
  "ticket:completed",
  "ticket:updated",
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
// Short-lived dedup keyed by `(ruleKey, eventType, ticketId, oldStatus, newStatus)`
// to swallow duplicate emits within DEDUP_TTL_MS.
let recentlyFired = new Map<string, number>();

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
    const tracked = inFlightSpawns.get(msg.agentId);
    if (!tracked) return; // not one of ours
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

  log(`Subscribed to ticket bus events (${rules.length} rules loaded)`);
}

const DEFAULT_RULES = [
  {
    trigger: { status: "review", reviewPhase: "qa" },
    action: { spawnProfile: "code-reviewer" },
    promptTemplate: "QA Review for ticket \"{{title}}\" (ID: {{id}}).\n\nDescription: {{description}}\n\nRead the relevant files. Evaluate correctness, security, and code quality.\n\nREPLY FORMAT — your output MUST end with EXACTLY ONE of these lines (no markdown around it):\nVERDICT: PASS\nVERDICT: FAIL — <one-line reason>\n\nPASS = code is good enough to advance to architecture review.\nFAIL = issues remain; ticket should go to rework with your findings as the reason.\n\nBe terse. Lead with the verdict reasoning, end with the VERDICT line.",
  },
  {
    trigger: { status: "review", reviewPhase: "architecture" },
    action: { spawnProfile: "architect" },
    promptTemplate: "Architecture Review for ticket \"{{title}}\" (ID: {{id}}).\n\nDescription: {{description}}\n\nCheck that the implementation matches the architecture, design docs, and conventions. Read shared artifacts for context.\n\nREPLY FORMAT — your output MUST end with EXACTLY ONE of these lines:\nVERDICT: PASS\nVERDICT: FAIL — <one-line reason>\n\nPASS = ticket is done.\nFAIL = architectural issues; ticket should go to rework.\n\nBe terse.",
  },
  {
    trigger: { status: "rework" },
    action: { spawnProfile: "{{assigneeProfileId}}" },
    promptTemplate: "REWORK needed on ticket \"{{title}}\" (ID: {{id}}).\n\nYour previous work was reviewed and needs changes. Read the latest ticket comments for reviewer feedback and fix the identified issues.\n\nWhen fixes are complete, your output MUST end with EXACTLY ONE of these lines:\nVERDICT: READY  — fixes complete, ready for re-review\nVERDICT: BLOCKED — <reason; ticket will be marked blocked>\n\nOriginal description: {{description}}",
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

  try {
    Promise.resolve(spawnFn(profileId, prompt, ticket.id))
      .then((result) => {
        if (result && result.error) {
          log(`Spawn for ticket ${ticket.id} returned error: ${result.error}`);
          // Don't track — there's no agent to wait for.
        } else if (result && result.agentId) {
          log(`Spawn for ticket ${ticket.id} → agent ${result.agentId}`);
          inFlightSpawns.set(result.agentId, { ticket, rule });
        }
      })
      .catch((err) => {
        log(`Spawn failed for ticket ${ticket.id}: ${err.message || err}`);
      });
  } catch (err) {
    log(`Spawn failed (sync): ${err.message}`);
  }

  setTimeout(() => {
    activeAutomations--;
    processQueue();
  }, 2000);
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
// Match the LAST occurrence on its own line (anchored end of text or line)
// to avoid being fooled by example/quoted verdicts earlier in the body.
const VERDICT_RE = /^VERDICT:\s*(PASS|FAIL|READY|BLOCKED)\b\s*(?:[—–-]\s*(.+?))?\s*$/im;

export function parseVerdict(text: string): { kind: string; reason: string | null } | null {
  if (!text || typeof text !== "string") return null;
  // Search lines from bottom up to honor "must end with" contract.
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    const m = /^VERDICT:\s*(PASS|FAIL|READY|BLOCKED)\b\s*(?:[—–-]\s*(.+))?$/i.exec(line);
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

function applyVerdict(ticket: any, rule: any, agentResult: string) {
  const verdict = parseVerdict(agentResult);
  const ticketService = serviceOverride || require("./service");
  const actor = "ticket-watcher";
  const profileLabel = rule?.action?.spawnProfile || "Automation";

  if (!verdict) {
    log(`No VERDICT found in agent output for ticket ${ticket.id} — leaving state untouched, adding comment`);
    ticketService.addComment(
      ticket.id,
      actor,
      "Automation",
      `⚠️ Review agent (${profileLabel}) did not produce a parseable VERDICT line. Manual intervention needed.\n\nAgent output (first 500 chars):\n${(agentResult || "(empty)").slice(0, 500)}`
    );
    return;
  }

  log(`Verdict for ticket ${ticket.id}: ${verdict.kind}${verdict.reason ? " — " + verdict.reason : ""}`);

  // Add a comment with the agent's full output for the audit trail.
  ticketService.addComment(
    ticket.id,
    actor,
    profileLabel,
    `**${verdict.kind}**${verdict.reason ? `: ${verdict.reason}` : ""}\n\n---\n\n${(agentResult || "").slice(0, 4000)}`
  );

  if (verdict.kind === "PASS") {
    if (ticket.reviewPhase === "qa") {
      ticketService.updateReviewPhase(ticket.id, "architecture", actor);
    } else if (ticket.reviewPhase === "architecture") {
      ticketService.completeTicket(ticket.id, "Approved by automated review pipeline.", actor);
    } else {
      log(`Unexpected reviewPhase ${ticket.reviewPhase} on PASS for ticket ${ticket.id}`);
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
    const ticketService = require("./service");
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
  recentlyFired.clear();
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
export function _resetDedup() { recentlyFired.clear(); processedStates.clear(); }

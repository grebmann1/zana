import * as fs from "node:fs";
import * as path from "node:path";

function log(msg) { process.stderr.write(`[ticket-watcher] ${msg}\n`); }

const DEBOUNCE_MS = 150;
const MAX_CONCURRENT = 3;
const MAX_REWORK_CYCLES = 3;

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

export function init({ ticketsDirectory, spawnAgent, configPath }) {
  ticketsDir = ticketsDirectory;
  spawnFn = spawnAgent;
  stateFilePath = path.join(path.dirname(ticketsDir), "automation-state.json");

  loadRules(configPath);
  loadProcessedStates();

  // Keep mkdir for compatibility — JSON-fallback ticket store still writes here.
  if (!fs.existsSync(ticketsDir)) {
    fs.mkdirSync(ticketsDir, { recursive: true });
  }

  // Subscribe to ticket lifecycle events on the in-process bus.
  // This replaces the old fs.watch approach: the SQLite-backed ticket store
  // doesn't write JSON files, so fs.watch never fired. Bus events fire on
  // every state change regardless of the underlying store.
  const { bus } = require("@zana/core").events.bus;
  const listener = (msg) => {
    if (msg && msg.ticketId) scheduleCheck(msg.ticketId);
  };
  bus.on("ticket:statusChanged", listener);
  bus.on("ticket:reviewPhaseChanged", listener);
  bus.on("ticket:created", listener);
  busSubscriptions.push(
    () => bus.off("ticket:statusChanged", listener),
    () => bus.off("ticket:reviewPhaseChanged", listener),
    () => bus.off("ticket:created", listener),
  );

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
        const agentManager = require("@zana/core").agents.manager;
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
  try {
    const config = JSON.parse(fs.readFileSync(configPath || path.join(path.dirname(ticketsDir), "config.json"), "utf8"));
    // Use user-provided rules only if they're a non-empty array. Otherwise fall back to defaults.
    if (Array.isArray(config.automation) && config.automation.length > 0) {
      rules = config.automation;
    } else {
      rules = DEFAULT_RULES;
    }
  } catch {
    rules = DEFAULT_RULES;
  }
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

function scheduleCheck(ticketId) {
  if (debounceTimers.has(ticketId)) clearTimeout(debounceTimers.get(ticketId));
  debounceTimers.set(ticketId, setTimeout(() => {
    debounceTimers.delete(ticketId);
    checkTicket(ticketId);
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

function checkTicket(ticketId) {
  const ticket = readTicket(ticketId);
  if (!ticket) return;

  const currentKey = JSON.stringify({ status: ticket.status, reviewPhase: ticket.reviewPhase || null });
  const previousKey = processedStates.get(ticket.id);

  if (previousKey === currentKey) return;

  processedStates.set(ticket.id, currentKey);
  saveProcessedStates();

  for (const rule of rules) {
    if (matchesRule(rule, ticket)) {
      enqueueAutomation(rule, ticket);
    }
  }
}

function matchesRule(rule, ticket) {
  if (rule.trigger.status !== ticket.status) return false;
  if (rule.trigger.label && (!ticket.labels || !ticket.labels.includes(rule.trigger.label))) return false;
  if (rule.trigger.reviewPhase !== undefined && (ticket.reviewPhase || null) !== rule.trigger.reviewPhase) return false;
  return true;
}

function enqueueAutomation(rule, ticket) {
  queue.push({ rule, ticket });
  processQueue();
}

function processQueue() {
  while (queue.length > 0 && activeAutomations < MAX_CONCURRENT) {
    const { rule, ticket } = queue.shift();
    executeAutomation(rule, ticket);
  }
}

function executeAutomation(rule, ticket) {
  if (rule.action.type === "workflow" && rule.action.skillId) {
    executeWorkflowAction(rule, ticket);
    return;
  }
  if (!spawnFn || !rule.action.spawnProfile) return;

  // Block infinite rework loops
  if (ticket.status === "rework" && (ticket.reworkCount || 0) >= MAX_REWORK_CYCLES) {
    log(`Ticket ${ticket.id} exceeded ${MAX_REWORK_CYCLES} rework cycles — marking as blocked`);
    markBlocked(ticket);
    return;
  }

  let profileId = rule.action.spawnProfile;
  profileId = profileId.replace(/\{\{(\w+)\}\}/g, (_, key) => ticket[key] || "");

  if (!profileId || profileId.includes("{{")) {
    log(`Cannot resolve profile for ticket ${ticket.id}: ${rule.action.spawnProfile} (assigneeProfileId=${ticket.assigneeProfileId})`);
    return;
  }

  activeAutomations++;

  let prompt = rule.promptTemplate || `Work on ticket "${ticket.title}"`;
  prompt = prompt.replace(/\{\{(\w+)\}\}/g, (_, key) => ticket[key] || "");

  log(`Auto-spawning ${profileId} for ticket ${ticket.id} (status=${ticket.status}, phase=${ticket.reviewPhase})`);

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
  const skillStore = require("@zana/extras").settings.skillStore;
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

function applyVerdict(ticket: any, rule: any, agentResult: string) {
  const verdict = parseVerdict(agentResult);
  const ticketService = require("./service");
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
    const { bus } = require("@zana/core").events.bus;
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
  inFlightSpawns.clear();
  saveProcessedStates();
  log("Stopped");
}

export function isRunning() { return busSubscriptions.length > 0; }

export function getRules() { return rules; }

// Test-only: expose the processedStates map so integration tests can verify
// in-process bus delivery without coupling to internal implementation.
export function _getProcessedStates() { return processedStates; }

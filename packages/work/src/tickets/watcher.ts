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

  log(`Subscribed to ticket bus events (${rules.length} rules loaded)`);
}

const DEFAULT_RULES = [
  {
    trigger: { status: "review", reviewPhase: "qa" },
    action: { spawnProfile: "code-reviewer" },
    promptTemplate: "QA/Code Review for ticket \"{{title}}\" (ID: {{id}}).\n\nDescription: {{description}}\n\nYou are performing a QA CODE REVIEW. Check the implementation for correctness, security, and code quality. Read the plan.md and files-changed.json in the ticket directory.\n\nWhen done, call zana_ticket_update with:\n- If PASS: set reviewPhase to \"architecture\" (next: architecture review)\n- If FAIL: set status to \"rework\" with detailed issues in progress field",
  },
  {
    trigger: { status: "review", reviewPhase: "architecture" },
    action: { spawnProfile: "architect" },
    promptTemplate: "Architecture Review for ticket \"{{title}}\" (ID: {{id}}).\n\nDescription: {{description}}\n\nCheck that the implementation matches the overall architecture, design docs, and coding conventions. Read shared artifacts for architecture context. Review plan.md and files in files-changed.json.\n\nWhen done, call zana_ticket_update with:\n- If PASS: set status to \"done\" with resultSummary (architectural approval)\n- If FAIL: set status to \"rework\" with architectural issues in progress field",
  },
  {
    trigger: { status: "rework" },
    action: { spawnProfile: "{{assigneeProfileId}}" },
    promptTemplate: "REWORK needed on ticket \"{{title}}\" (ID: {{id}}).\n\nYour previous work was reviewed and needs changes. Read the latest ticket comments for reviewer feedback. Fix the identified issues and move the ticket back to \"review\" when done.\n\nOriginal description: {{description}}",
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

function readTicket(ticketId) {
  // Goes through the ticket-service abstraction layer, which dispatches to
  // sqlite-backed or JSON-backed storage as appropriate.
  try {
    const ticketService = require("./service");
    return ticketService.getTicket(ticketId);
  } catch {
    return null;
  }
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
    spawnFn(profileId, prompt, ticket.id);
  } catch (err) {
    log(`Spawn failed: ${err.message}`);
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
  saveProcessedStates();
  log("Stopped");
}

export function isRunning() { return busSubscriptions.length > 0; }

export function getRules() { return rules; }

// Test-only: expose the processedStates map so integration tests can verify
// in-process bus delivery without coupling to internal implementation.
export function _getProcessedStates() { return processedStates; }

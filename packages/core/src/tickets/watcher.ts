import * as fs from "node:fs";
import * as path from "node:path";

function log(msg) { process.stderr.write(`[ticket-watcher] ${msg}\n`); }

const DEBOUNCE_MS = 150;
const MAX_CONCURRENT = 3;
const MAX_REWORK_CYCLES = 3;

let watcher = null;
let ticketsDir = null;
let spawnFn = null;
let processedStates = new Map();
let stateFilePath = null;
let debounceTimers = new Map();
let activeAutomations = 0;
let queue = [];
let rules = [];

export function init({ ticketsDirectory, spawnAgent, configPath }) {
  ticketsDir = ticketsDirectory;
  spawnFn = spawnAgent;
  stateFilePath = path.join(path.dirname(ticketsDir), "automation-state.json");

  loadRules(configPath);
  loadProcessedStates();

  if (!fs.existsSync(ticketsDir)) {
    fs.mkdirSync(ticketsDir, { recursive: true });
  }

  watcher = fs.watch(ticketsDir, { recursive: true }, (eventType, filename) => {
    if (!filename) return;
    if (filename.endsWith("ticket.json") || (filename.endsWith(".json") && !filename.includes("/"))) {
      const ticketId = filename.includes("/") ? filename.split("/")[0] : filename.replace(".json", "");
      scheduleCheck(ticketId);
    }
  });

  watcher.on("error", (err) => {
    if (err.code !== "ENOENT") log(`Error: ${err.message}`);
  });

  log(`Monitoring ${ticketsDir} (${rules.length} rules loaded)`);
}

function loadRules(configPath) {
  try {
    const config = JSON.parse(fs.readFileSync(configPath || path.join(path.dirname(ticketsDir), "config.json"), "utf8"));
    rules = config.automation || [];
  } catch {
    rules = [
      {
        trigger: { status: "review", reviewPhase: "qa" },
        action: { spawnProfile: "built-in-code-reviewer" },
        promptTemplate: "QA/Code Review for ticket \"{{title}}\" (ID: {{id}}).\n\nDescription: {{description}}\n\nYou are performing a QA CODE REVIEW. Check the implementation for correctness, security, and code quality. Read the plan.md and files-changed.json in the ticket directory.\n\nWhen done, call hive_ticket_update with:\n- If PASS: set reviewPhase to \"architecture\" (next: architecture review)\n- If FAIL: set status to \"rework\" with detailed issues in progress field",
      },
      {
        trigger: { status: "review", reviewPhase: "architecture" },
        action: { spawnProfile: "built-in-arch-reviewer" },
        promptTemplate: "Architecture Review for ticket \"{{title}}\" (ID: {{id}}).\n\nDescription: {{description}}\n\nCheck that the implementation matches the overall architecture, design docs, and coding conventions. Read hive artifacts for architecture context. Review plan.md and files in files-changed.json.\n\nWhen done, call hive_ticket_update with:\n- If PASS: set status to \"done\" with resultSummary (architectural approval)\n- If FAIL: set status to \"rework\" with architectural issues in progress field",
      },
      {
        trigger: { status: "rework" },
        action: { spawnProfile: "{{assigneeProfileId}}" },
        promptTemplate: "REWORK needed on ticket \"{{title}}\" (ID: {{id}}).\n\nYour previous work was reviewed and needs changes. Read the latest ticket comments for reviewer feedback. Fix the identified issues and move the ticket back to \"review\" when done.\n\nOriginal description: {{description}}",
      },
    ];
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

function readTicketFromDisk(ticketId) {
  const dirPath = path.join(ticketsDir, ticketId, "ticket.json");
  try { return JSON.parse(fs.readFileSync(dirPath, "utf8")); } catch {}
  const flatPath = path.join(ticketsDir, `${ticketId}.json`);
  try { return JSON.parse(fs.readFileSync(flatPath, "utf8")); } catch {}
  return null;
}

function checkTicket(ticketId) {
  const ticket = readTicketFromDisk(ticketId);
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
  const hiveSkillStore = require("./hive-skill-store");
  const workflowEngine = require("./workflow-engine");
  const skill = hiveSkillStore.getHiveSkill(rule.action.skillId);
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
    const ticketService = require("./ticket-service");
    ticketService.updateStatus(ticket.id, "blocked", "ticket-watcher");
    ticketService.addComment(
      ticket.id,
      "ticket-watcher",
      "Automation",
      `⚠️ BLOCKED: This ticket has failed review ${ticket.reworkCount} times. Automatic rework cycles exhausted. Human intervention required.\n\nPlease review the comment history, identify the root issue, and either:\n- Provide guidance and move back to "in-progress" manually\n- Reassign to a different agent profile\n- Break into smaller tickets`
    );
    const { bus } = require("./event-bus");
    bus.emit("ticket:blocked", { ticketId: ticket.id, reason: "max_rework_cycles", reworkCount: ticket.reworkCount });
    log(`Ticket ${ticket.id} marked as blocked — human intervention required`);
  } catch (err) {
    log(`Failed to mark ticket ${ticket.id} as blocked: ${err.message}`);
  }
}

export function stop() {
  if (watcher) { watcher.close(); watcher = null; }
  for (const timer of debounceTimers.values()) clearTimeout(timer);
  debounceTimers.clear();
  saveProcessedStates();
  log("Stopped");
}

export function isRunning() { return watcher !== null; }


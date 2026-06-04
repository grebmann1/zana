#!/usr/bin/env node
//
// Generate docs/MCP-TOOL-REFERENCE.md from the source of truth in
// packages/mcp/src/mcp-server.ts (input schemas) and a curated map of
// hand-introspected handler return shapes for high-traffic tools.
//
// This file is the source of truth for slash-command authors. Run after MCP
// changes. Output is deterministic (no timestamps, sorted alphabetically) so
// re-running with no source changes produces a byte-identical file.
//
// Usage:
//   npm run docs:mcp-ref
//
// Exits non-zero on parse failure.

const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

// `__dirname` after compile is `<root>/dist/scripts`. From source it's `<root>/scripts`.
// Walk up until we find a package.json — that's the repo root.
function findRepoRoot(start) {
  let dir = start;
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, "package.json")) && fs.existsSync(path.join(dir, "packages"))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  throw new Error(`could not locate repo root from ${start}`);
}

const ROOT = findRepoRoot(__dirname);
const MCP_SERVER_PATH = path.join(ROOT, "packages/mcp/src/mcp-server.ts");
const DELIBERATE_PATH = path.join(ROOT, "packages/mcp/src/tools/deliberate.ts");
const REGISTRATIONS_DIR = path.join(ROOT, "packages/mcp/src/registrations");
const OUTPUT_PATH = path.join(ROOT, "docs/MCP-TOOL-REFERENCE.md");

// ─────────────────────────────────────────────────────────────────────────────
// JSON-like AST helpers — convert TS object/array literals to plain JS values.
// Only handles literal nodes (string/number/boolean/array/object). Anything
// non-literal becomes a placeholder string we can render verbatim.
// ─────────────────────────────────────────────────────────────────────────────

function literalToValue(node) {
  if (!node) return undefined;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  if (ts.isNumericLiteral(node)) {
    return Number(node.text);
  }
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.map(literalToValue);
  }
  if (ts.isObjectLiteralExpression(node)) {
    const out = {};
    for (const prop of node.properties) {
      if (!ts.isPropertyAssignment(prop)) continue;
      const key = prop.name && (prop.name.text || (ts.isStringLiteral(prop.name) ? prop.name.text : null));
      if (!key) continue;
      out[key] = literalToValue(prop.initializer);
    }
    return out;
  }
  // String concatenation — common for long descriptions split with `+`.
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const lhs = literalToValue(node.left);
    const rhs = literalToValue(node.right);
    if (typeof lhs === "string" && typeof rhs === "string") return lhs + rhs;
  }
  // Conditional like `ZANA_MASTER_MODE ? [ ... ] : []` — pull the truthy branch.
  if (ts.isConditionalExpression(node)) {
    return literalToValue(node.whenTrue);
  }
  return "<dynamic>";
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool extraction from a single source file.
// Walks variable declarations and pulls out arrays-of-objects whose objects
// have a string `name` starting with "zana_". Also captures standalone object
// literals like `deliberateTool`.
// ─────────────────────────────────────────────────────────────────────────────

function extractToolsFromSource(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  const sf = ts.createSourceFile(filePath, text, ts.ScriptTarget.ES2022, true);
  const found = []; // { name, description, inputSchema, sourceFile, sourceLine }

  function pushIfTool(node) {
    const value = literalToValue(node);
    if (
      value &&
      typeof value === "object" &&
      typeof value.name === "string" &&
      value.name.startsWith("zana_")
    ) {
      const { line } = ts.getLineAndCharacterOfPosition(sf, node.getStart(sf));
      found.push({
        name: value.name,
        description: typeof value.description === "string" ? value.description : "",
        inputSchema: value.inputSchema || { type: "object", properties: {} },
        sourceFile: path.relative(ROOT, filePath),
        sourceLine: line + 1,
      });
    }
  }

  function visit(node) {
    if (ts.isArrayLiteralExpression(node)) {
      for (const el of node.elements) {
        if (ts.isObjectLiteralExpression(el)) pushIfTool(el);
      }
    }
    if (ts.isObjectLiteralExpression(node)) {
      // Top-level standalone tool exports (deliberateTool etc.) — only push if
      // not already inside an array we already visited.
      pushIfTool(node);
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);

  // De-dupe by name (a tool can appear both standalone and inside DELIBERATION_TOOLS).
  const seen = new Set();
  return found.filter((t) => {
    if (seen.has(t.name)) return false;
    seen.add(t.name);
    return true;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Curated output shapes for high-traffic tools. These were extracted by
// reading handler implementations directly. If you change a handler's return
// shape, update the corresponding entry here.
//
// Each entry has:
//   - example: pretty-printed JSON example used as the "Output shape" block.
//   - handler: human-readable pointer like "package/path:functionName".
//   - pitfalls: optional bullets of landmines authors hit.
// ─────────────────────────────────────────────────────────────────────────────

type OutputDoc = {
  example: any;
  handler: string;
  pitfalls?: string[];
};

const TICKET_SHAPE = {
  id: "uuid",
  title: "...",
  description: "...",
  status: "backlog",
  priority: "medium",
  assigneeId: null,
  assigneeName: null,
  assigneeProfileId: null,
  reviewPhase: null,
  reworkCount: 0,
  sprintId: null,
  labels: [],
  blockedBy: [],
  comments: [],
  audit: [{ id: "uuid", action: "created", actor: "agent", details: { title: "...", priority: "medium" }, timestamp: "ISO8601" }],
  createdBy: "agent",
  createdAt: "ISO8601",
  updatedAt: "ISO8601",
  closedAt: null,
  resultSummary: null,
};

const SPRINT_SHAPE = {
  id: "uuid",
  name: "...",
  teamId: null,
  daemonId: null,
  status: "planning",
  ticketIds: [],
  startedAt: null,
  endedAt: null,
  createdAt: "ISO8601",
  updatedAt: "ISO8601",
};

const SCHEDULE_SHAPE = {
  id: "uuid",
  name: "...",
  description: "",
  enabled: true,
  schedule: { cron: "* * * * *", every: "5m", intervalMs: 300000 },
  action: { type: "prompt | spawn-agent | team | command | workflow | mcp_tool", "...": "..." },
  ownerId: null,
  ownerName: null,
  createdAt: "ISO8601",
  updatedAt: "ISO8601",
  status: { lastRunAt: null, lastRunResult: null, nextRunAt: "ISO8601", runCount: 0 },
};

const OUTPUT_SHAPES: Record<string, OutputDoc> = {
  // ── Ticketing ──
  zana_ticket_create: {
    example: TICKET_SHAPE,
    handler: "packages/work/src/tickets/service.ts:createTicket",
    pitfalls: [
      "Priority enum is `critical|high|medium|low`, NOT `P0|P1|P2|P3`.",
      "Initial status is always `backlog` — there is no `open` status.",
      "Returns the ticket directly (not `{ ok, ticket }`). Errors return `{ error: '...' }`.",
    ],
  },
  zana_ticket_list: {
    example: [TICKET_SHAPE],
    handler: "packages/work/src/tickets/db.ts:_listTickets",
    pitfalls: [
      "Status enum: `backlog | in-progress | review | rework | blocked | done | cancelled`. The MCP input schema lists a smaller subset for filtering, but tickets in the result set may carry any of these.",
      "Returns a flat array of ticket objects, sorted by `updatedAt DESC`. There is no wrapper object.",
    ],
  },
  zana_ticket_get: {
    example: TICKET_SHAPE,
    handler: "packages/work/src/tickets/db.ts:_getTicket",
    pitfalls: [
      "Returns the ticket object directly, or `undefined` when the row is missing — there is no `{ error }` envelope on miss.",
    ],
  },
  zana_ticket_claim: {
    example: { ok: true, ticket: TICKET_SHAPE },
    handler: "packages/work/src/tickets/service.ts:claimTicket",
    pitfalls: [
      "Only `backlog` and `rework` tickets are claimable. Anything else returns `{ error: 'cannot claim ticket in status: X' }`.",
      "After claim, ticket.status becomes `in-progress` and `assigneeId/assigneeName` are populated from the calling environment.",
    ],
  },
  zana_ticket_update_status: {
    example: { ok: true, ticket: TICKET_SHAPE },
    handler: "packages/work/src/tickets/service.ts:updateStatus",
    pitfalls: [
      "Transitions are validated against an explicit table — see STATUS_TRANSITIONS in service.ts. Invalid transitions return `{ error }`.",
      "Moving to `review` auto-sets `reviewPhase: 'qa'`. Moving to `rework` clears it and increments `reworkCount`.",
    ],
  },
  zana_ticket_comment: {
    example: { ok: true, comment: { id: "uuid", authorId: "...", authorName: "...", body: "...", createdAt: "ISO8601" } },
    handler: "packages/work/src/tickets/service.ts:addComment",
    pitfalls: [
      "Returns just the new comment under `{ ok, comment }` — NOT the full ticket. To re-render the ticket, follow up with `zana_ticket_get`.",
    ],
  },
  zana_ticket_complete: {
    example: { ok: true, ticket: TICKET_SHAPE },
    handler: "packages/work/src/tickets/service.ts:completeTicket",
    pitfalls: [
      "Bypasses the normal STATUS_TRANSITIONS check — a ticket can be force-completed from any status.",
      "Sets `status: 'done'`, `closedAt`, and stamps `resultSummary`.",
    ],
  },
  zana_ticket_edit: {
    example: { ok: true, ticket: TICKET_SHAPE },
    handler: "packages/work/src/tickets/service.ts:updateTicket",
    pitfalls: [
      "Only fields in UPDATABLE_FIELDS (`title|description|priority|labels|sprintId|blockedBy|type`) are applied. Unknown keys are silently ignored, but if NO valid fields are provided you get `{ error: 'no valid updatable fields provided' }`.",
      "`type` enum is `bug|feature|chore|spike`.",
    ],
  },
  zana_ticket_update: {
    example: { ok: true, ticket: TICKET_SHAPE },
    handler: "packages/core/src/agents/manager.ts case 'ticket_update'",
    pitfalls: [
      "This is a multiplexer over several service calls — `progress` adds a comment, `planification` writes plan.md, `filesChanged` merges into files-changed.json, `resultSummary` writes result.md, `reviewPhase` advances the review phase, `status` calls updateStatus or completeTicket. The return shape depends on which branch fired:",
      "  • If `status === 'done'` and `resultSummary` was provided → `completeTicket` shape: `{ ok, ticket }`.",
      "  • Else if `status` provided → `updateStatus` shape: `{ ok, ticket }`.",
      "  • Otherwise → `{ ok: true, ticketId }` (no ticket object).",
    ],
  },
  zana_ticket_add_to_sprint: {
    example: { ok: true, ticket: TICKET_SHAPE, sprint: SPRINT_SHAPE },
    handler: "packages/work/src/tickets/service.ts:addTicketToSprint",
  },
  zana_sprint_list: {
    example: [SPRINT_SHAPE],
    handler: "packages/work/src/tickets/db.ts:_listSprints",
  },
  zana_sprint_board: {
    example: {
      backlog: [TICKET_SHAPE],
      "in-progress": [],
      review: [],
      rework: [],
      blocked: [],
      done: [],
    },
    handler: "packages/work/src/tickets/service.ts:getSprintBoard",
    pitfalls: [
      "Board has SIX columns, not the four the schema description hints at: `backlog | in-progress | review | rework | blocked | done`. `cancelled` tickets are dropped.",
    ],
  },
  zana_sprint_create: {
    example: SPRINT_SHAPE,
    handler: "packages/work/src/tickets/service.ts:createSprint",
    pitfalls: [
      "Returns the sprint object directly (no `{ ok, sprint }` wrapper).",
      "Initial status is `planning` — call `zana_sprint_start` to move to `active`.",
    ],
  },
  zana_sprint_start: {
    example: { ok: true, sprint: SPRINT_SHAPE },
    handler: "packages/work/src/tickets/service.ts:startSprint",
  },
  zana_sprint_end: {
    example: { ok: true, sprint: SPRINT_SHAPE },
    handler: "packages/work/src/tickets/service.ts:endSprint",
  },

  // ── Teams ──
  zana_list_teams: {
    example: [{
      id: "team-engineering",
      name: "Engineering Squad",
      icon: "🏗️",
      description: "...",
      orchestratorProfileId: "orchestrator",
      workerProfileIds: ["coder", "tester"],
      slots: [{ profileId: "coder", quantity: 2 }],
      rules: { maxConcurrentWorkers: 4, autoRestart: false, requireApproval: false },
      autoStart: false,
      dynamicSpawning: false,
      maxTotalWorkers: 4,
      initialPrompt: "",
      createdAt: "ISO8601",
      updatedAt: "ISO8601",
    }],
    handler: "packages/work/src/teams/store.ts:listTeams",
  },
  zana_get_team: {
    example: {
      id: "team-engineering",
      name: "Engineering Squad",
      icon: "🏗️",
      description: "...",
      orchestratorProfileId: "orchestrator",
      workerProfileIds: ["coder", "tester"],
      slots: [{ profileId: "coder", quantity: 2 }],
      rules: { maxConcurrentWorkers: 4, autoRestart: false, requireApproval: false },
      autoStart: false,
      dynamicSpawning: false,
      maxTotalWorkers: 4,
      initialPrompt: "",
      createdAt: "ISO8601",
      updatedAt: "ISO8601",
    },
    handler: "packages/work/src/teams/store.ts:getTeam",
    pitfalls: [
      "Returns the team object directly, or `{ error: 'team not found: <id>' }` on miss.",
    ],
  },
  zana_start_team: {
    example: { ok: true, orchestratorAgentId: "agent-uuid", terminalId: "terminal-uuid" },
    handler: "packages/work/src/teams/manager.ts:startTeam",
    pitfalls: [
      "There is NO `runId` field. The shape is exactly `{ ok, orchestratorAgentId, terminalId }`. `terminalId` is `undefined` for headless spawns.",
      "Failure cases return `{ ok: false, error }` — `ok` is the discriminator, not presence of `error`.",
    ],
  },
  zana_stop_team: {
    example: { ok: true },
    handler: "packages/work/src/teams/manager.ts:stopTeam",
    pitfalls: [
      "On miss returns `{ ok: false, error: 'team not running' }`.",
    ],
  },
  zana_team_status: {
    example: {
      teamId: "team-engineering",
      teamName: "Engineering Squad",
      teamIcon: "🏗️",
      orchestratorAgentId: "agent-uuid",
      checkpointId: "ckpt-uuid",
      checkpointedAgents: "<Set>",
      status: "running",
      startedAt: 1234567890,
      orchestrator: { id: "agent-uuid", state: "active", "...": "..." },
      workers: [{ id: "agent-uuid", parentAgentId: "agent-uuid", state: "active", "...": "..." }],
    },
    handler: "packages/work/src/teams/manager.ts:getTeamStatus",
    pitfalls: [
      "When the team is not running the orchestrator wraps null into `{ error: 'team not running: <id>' }`. Otherwise the running record is spread alongside `orchestrator` and `workers`.",
    ],
  },
  zana_list_running_teams: {
    example: [{
      teamId: "team-engineering",
      teamName: "Engineering Squad",
      teamIcon: "🏗️",
      orchestratorAgentId: "agent-uuid",
      checkpointId: "ckpt-uuid",
      status: "running",
      startedAt: 1234567890,
      orchestrator: { id: "agent-uuid", state: "active", "...": "..." },
      workers: [],
    }],
    handler: "packages/work/src/teams/manager.ts:listRunningTeams",
  },

  // ── Scheduling ──
  zana_schedule_create: {
    example: SCHEDULE_SHAPE,
    handler: "packages/work/src/scheduling/service.ts:createSchedule",
    pitfalls: [
      "Returns the schedule object directly. On invalid input returns `{ error: 'invalid schedule: <reason>' }`.",
      "There is no `runId` field — schedules don't fire on creation.",
    ],
  },
  zana_schedule_list: {
    example: [SCHEDULE_SHAPE],
    handler: "packages/work/src/scheduling/store.ts:listSchedules",
  },
  zana_schedule_get: {
    example: {
      schedule: SCHEDULE_SHAPE,
      history: [{ status: "success", startedAt: "ISO8601", finishedAt: "ISO8601", actionType: "prompt", "...": "..." }],
    },
    handler: "packages/core/src/agents/manager.ts case 'schedule_get'",
    pitfalls: [
      "The MCP wrapper bundles the schedule and its run history into one envelope `{ schedule, history }` — the underlying `getSchedule` returns just the schedule.",
    ],
  },
  zana_schedule_update: {
    example: { ok: true, schedule: SCHEDULE_SHAPE },
    handler: "packages/work/src/scheduling/service.ts:updateSchedule",
  },
  zana_schedule_delete: {
    example: { ok: true },
    handler: "packages/core/src/agents/manager.ts case 'schedule_delete'",
  },
  zana_schedule_enable: {
    example: { ok: true, schedule: SCHEDULE_SHAPE },
    handler: "packages/work/src/scheduling/service.ts:enableSchedule",
  },
  zana_schedule_disable: {
    example: { ok: true, schedule: SCHEDULE_SHAPE },
    handler: "packages/work/src/scheduling/service.ts:disableSchedule",
  },
  zana_schedule_trigger: {
    example: {
      ok: true,
      schedule: SCHEDULE_SHAPE,
      result: {
        status: "success",
        startedAt: "ISO8601",
        finishedAt: "ISO8601",
        actionType: "prompt",
        agentId: "agent-uuid",
        finalStatus: "pending",
        summary: "",
      },
    },
    handler: "packages/work/src/scheduling/service.ts:triggerSchedule",
    pitfalls: [
      "There is NO top-level `runId` field. Output is `{ ok, schedule, result }`. The `result` object's keys depend on the action type — common keys are `status`, `startedAt`, `finishedAt`, `actionType`, plus action-specific fields like `agentId`, `runId` (workflows only), `stdout/stderr` (commands), `data` (mcp_tool).",
    ],
  },
  zana_schedule_reload: {
    example: { ok: true, started: 3, skipped: 0 },
    handler: "packages/work/src/scheduling/service.ts:loadFromDisk",
  },

  // ── Memory ──
  zana_memory_store: {
    example: { id: "uuid", tier: "episodic" },
    handler: "packages/intelligence/src/intelligence/vector-memory.ts:store",
    pitfalls: [
      "Returns `{ id, tier }` only — there is no namespace/key model. Embed identity in `metadata` (e.g. `metadata.tags`) when you need to search-by-key.",
    ],
  },
  zana_memory_search: {
    example: [{
      id: "uuid",
      content: "...",
      metadata: { tags: ["..."], timestamp: 1234567890 },
      score: 0.87,
      tier: "episodic",
    }],
    handler: "packages/intelligence/src/intelligence/vector-memory.ts:search",
    pitfalls: [
      "Returns a flat array of result objects. Each row has `{ id, content, metadata, score, tier }` — there is no `namespace` or `key` field.",
      "Score is cosine similarity (0..1). Default `minScore` is 0.1; results below that threshold are filtered out before slicing to `limit`.",
    ],
  },

  // ── Autopilot (goal-driven) ──
  zana_autopilot_goal_driven: {
    example: { goalId: "uuid", status: "running" },
    handler: "packages/core/modules/autopilot/index.js:setGoal",
    pitfalls: [
      "Returns immediately with `{ goalId, status: 'running' }` — the goal loop runs async. Poll with `zana_autopilot_goal_status`.",
    ],
  },
  zana_autopilot_goal_status: {
    example: {
      id: "uuid",
      title: "...",
      criteria: "...",
      steps: [{ profile: "coder", prompt: "..." }],
      iteration: 2,
      status: "running",
      results: [{ step: 0, agentId: "uuid", summary: "..." }],
      lastEvaluation: "VERDICT: FAIL\nReason: ...",
      createdAt: 1234567890,
    },
    handler: "packages/core/modules/autopilot/index.js:getGoal",
    pitfalls: [
      "On miss returns `{ error: 'unknown goalId' }` (the wrapper) — direct `getGoal` returns `null`.",
      "`status` is one of `running | completed | failed | exhausted | cancelled`.",
    ],
  },
  zana_autopilot_goal_list: {
    example: [{
      id: "uuid",
      title: "...",
      status: "running",
      iteration: 2,
      createdAt: 1234567890,
    }],
    handler: "packages/core/modules/autopilot/index.js:listGoals",
    pitfalls: [
      "List entries are summaries — `criteria`, `steps`, `results`, `lastEvaluation` are NOT included. Use `zana_autopilot_goal_status` for the full record.",
    ],
  },
  zana_autopilot_goal_cancel: {
    example: { ok: true },
    handler: "packages/core/modules/autopilot/index.js:cancelGoal",
    pitfalls: [
      "Already-terminal goals fail: `{ ok: false, error: 'goal already <status>' }`.",
    ],
  },

  // ── Deliberation (T9) ──
  zana_deliberate: {
    example: {
      id: "uuid",
      state: "SETTLED",
      question: "...",
      currentRound: 1,
      rounds: 2,
      voters: [{ agentId: "uuid", profileId: "architect", modelId: "opus", "...": "..." }],
      verdict: { decision: "approve", "...": "..." },
      escalationReason: null,
      createdAt: "ISO8601",
      updatedAt: "ISO8601",
      settledAt: "ISO8601",
      version: 7,
      _outcome: "settled",
      _assemblyEscalation: null,
      _reassemblyEscalation: null,
    },
    handler: "packages/mcp/src/tools/deliberate.ts:deliberateHandler",
    pitfalls: [
      "Always inspect `_outcome` first: `settled | escalated | escalated_at_assembly | escalated_during_reassembly`. The latter two carry diagnostic detail under `_assemblyEscalation` / `_reassemblyEscalation`.",
      "States: `PROPOSED | REVIEWING | SYNTHESIZING | CONVERGING | SETTLED | ESCALATED | EXHAUSTED`. SETTLED and ESCALATED are terminal.",
    ],
  },
  zana_deliberation_status: {
    example: {
      id: "uuid",
      state: "REVIEWING",
      question: "...",
      currentRound: 0,
      rounds: 2,
      voters: [{ agentId: "uuid", profileId: "architect", "...": "..." }],
      verdict: null,
      escalationReason: null,
      createdAt: "ISO8601",
      updatedAt: "ISO8601",
      settledAt: null,
      version: 3,
    },
    handler: "packages/mcp/src/tools/deliberate.ts:deliberationStatusHandler",
    pitfalls: [
      "Throws (not returns `{ error }`) when the deliberation is missing.",
    ],
  },
  zana_deliberation_list: {
    example: [{
      id: "uuid",
      state: "SETTLED",
      question: "...",
      currentRound: 1,
      rounds: 2,
      voters: 3,
      verdict: { decision: "approve", "...": "..." },
      escalationReason: null,
      createdAt: "ISO8601",
      updatedAt: "ISO8601",
      settledAt: "ISO8601",
    }],
    handler: "packages/mcp/src/tools/deliberate.ts:deliberationListHandler",
    pitfalls: [
      "`voters` here is a COUNT (number), not an array. Use `zana_deliberation_status` to get the full voter records.",
    ],
  },
  zana_deliberation_override: {
    example: {
      id: "uuid",
      state: "SETTLED",
      verdict: { decision: "approve", reasonHash: "sha256-hex", "...": "..." },
      override: { humanId: "human", decision: "approve", reasonHash: "sha256-hex", ts: "ISO8601" },
      version: 8,
      "...": "...",
    },
    handler: "packages/mcp/src/tools/deliberate.ts:deliberationOverrideHandler",
    pitfalls: [
      "Always lands the deliberation on `SETTLED`, regardless of prior state.",
      "`reason` is content-addressed — the deliberation stores `reasonHash`, not the raw text.",
    ],
  },

  // ── Agents / profiles (used by lots of commands; document the small ones) ──
  zana_list_agents: {
    example: [{
      id: "agent-uuid",
      profile: "coder",
      state: "active",
      lastAction: "...",
      mode: "headless",
    }],
    handler: "packages/core/src/agents/manager.ts case 'list_agents'",
    pitfalls: [
      "`state` is one of `active | terminated | errored`. The list is shaped down to five fields — use `zana_agent_status` for richer detail.",
    ],
  },
  zana_agent_status: {
    example: {
      id: "agent-uuid",
      state: "active",
      lastAction: "...",
      mode: "headless",
      uptime: 12345,
    },
    handler: "packages/core/src/agents/manager.ts case 'agent_status'",
  },
  zana_agent_result: {
    example: { id: "agent-uuid", completed: true, result: "...", state: "terminated" },
    handler: "packages/core/src/agents/manager.ts case 'agent_result'",
    pitfalls: [
      "`result` is `null` while the agent is still running. Check `completed` (boolean) before using `result`.",
    ],
  },
  zana_kill_agent: {
    example: { ok: true },
    handler: "packages/core/src/agents/manager.ts case 'kill_agent'",
  },
  zana_list_profiles: {
    example: [{
      id: "coder",
      name: "Coder",
      icon: "💻",
      category: "core",
      description: "...",
      model: "opus",
    }],
    handler: "packages/core/src/agents/manager.ts case 'list_profiles'",
  },
  zana_spawn_agent: {
    example: { agentId: "agent-uuid", status: "spawned" },
    handler: "packages/core/src/agents/manager.ts case 'spawn_agent'",
    pitfalls: [
      "Resource and circuit-breaker guards return `{ error: '...' }` instead of throwing — always check for an `error` key before using `agentId`.",
    ],
  },

  // ── Comms — typed messaging, channels, inbox ──
  zana_send_message: {
    example: {
      ok: true,
      delivered: "local | remote | failed",
      messageId: "msg-uuid",
      error: "<set when ok=false, e.g. 'invalid message type: X' or 'target agent not found in any daemon'>",
    },
    handler: "packages/swarm/src/swarm/router.ts:routeMessage (via packages/core/src/agents/manager.ts case 'send_message')",
    pitfalls: [
      "Three branches: local agent (`{ ok: true, delivered: 'local', messageId }`), remote sub-daemon (`{ ok: true|false, delivered: 'remote'|'failed', messageId }`), or unreachable (`{ ok: false, error: 'target agent not found in any daemon', messageId }`).",
      "Validation failure on `type` returns early without `messageId` and without routing — render `error` first.",
      "If `requiresAck` was set, the ack lands later via `zana_send_ack`; the send response itself does not wait.",
    ],
  },
  zana_check_inbox: {
    example: [
      {
        id: "msg-uuid",
        sentAt: 1234567890,
        fromAgentId: "agent-uuid",
        fromAgentName: "Agent",
        fromDaemonId: "local",
        toAgentId: "self-terminal-id",
        type: "...",
        payload: {},
        priority: "normal",
        replyTo: null,
        requiresAck: false,
      },
    ],
    handler: "packages/swarm/src/swarm/router.ts:drainInbox (via case 'check_inbox')",
    pitfalls: [
      "Returns a flat array. Empty inbox returns `[]`, not `{ messages: [] }`.",
      "Drains on read — calling twice yields the second result empty unless new messages arrived between calls.",
      "Uses `process.env.ZANA_TERMINAL_ID` as the inbox key; outside an agent context this is undefined and the call returns `[]`.",
    ],
  },
  zana_publish_channel: {
    example: { ok: true, delivered: 3, subscribers: 4 },
    handler: "packages/swarm/src/swarm/router.ts:publishToChannel (via case 'publish_channel')",
    pitfalls: [
      "`delivered` is the count of subscribers reached *excluding* the sender; `subscribers` is the total subscriber count. They differ when the publisher is also subscribed.",
      "Channel is created on first publish — there is no separate create call.",
      "History is capped at `MAX_CHANNEL_HISTORY` (in-memory ring buffer); old messages are evicted silently.",
    ],
  },
  zana_subscribe_channel: {
    example: { ok: true, channel: "my-channel", historyCount: 12 },
    handler: "packages/swarm/src/swarm/router.ts:subscribeChannel (via case 'subscribe_channel')",
    pitfalls: [
      "Idempotent — re-subscribing the same agentId is a no-op and still returns `ok: true`.",
      "`historyCount` is messages currently in the channel ring buffer, not unread count.",
      "Subscribes the caller's `callerAgentId` (resolved from env), not an arbitrary id.",
    ],
  },
  zana_list_channels: {
    example: [
      { name: "my-channel", subscribers: 4, messageCount: 12, lastActivity: 1234567890 },
    ],
    handler: "packages/swarm/src/swarm/router.ts:listChannels (via case 'list_channels')",
    pitfalls: [
      "Returns a flat array. `lastActivity` is `null` if the channel was created but never published to.",
      "Counts are for the local in-memory router; sub-daemons' channels are not included.",
    ],
  },
  zana_channel_history: {
    example: [
      {
        id: "msg-uuid",
        sentAt: 1234567890,
        channel: "my-channel",
        fromAgentId: "agent-uuid",
        fromAgentName: "Agent",
        fromDaemonId: "local",
        type: "...",
        payload: {},
      },
    ],
    handler: "packages/swarm/src/swarm/router.ts:getChannelHistory (via case 'channel_history')",
    pitfalls: [
      "Unknown channel returns `[]`, not an error.",
      "`limit` defaults to 50 in the MCP wrapper; the underlying router accepts no limit and returns the full ring buffer if not bounded.",
    ],
  },

  // ── Events — system event bus ──
  zana_event_emit: {
    example: { ok: true },
    handler: "packages/core/src/events/service.ts:emit (via case 'event_emit')",
    pitfalls: [
      "Fire-and-forget — the event is appended to the event log; subscribers fire synchronously but errors are swallowed.",
      "`source` is auto-stamped from `process.env.ZANA_TERMINAL_ID` (defaults to 'agent') — do not pass it from the caller.",
    ],
  },
  zana_event_query: {
    example: [
      {
        id: "evt-uuid",
        type: "...",
        payload: {},
        tags: [],
        source: "agent | terminal-id",
        workspace: "/path",
        timestamp: 1234567890,
      },
    ],
    handler: "packages/core/src/events/store.ts:queryEvents (via case 'event_query')",
    pitfalls: [
      "Returns the *last* `limit` matching events (default 50). Older events are silently dropped from the result, not paginated.",
      "Reads the events file fresh on every call — large logs = slow query. There is no index.",
      "Returns `[]` on missing file — does not surface ENOENT as an error.",
    ],
  },

  // ── Workflows ──
  zana_workflow_run: {
    example: {
      id: "run-uuid",
      skillId: "skill-id",
      skillName: "...",
      status: "running | completed | halted | failed",
      currentStep: 0,
      steps: [
        { index: 0, action: "spawn | gate | notify | wait", status: "pending | running | completed | halted", result: null, "...": "..." },
      ],
      triggerContext: {},
      startedAt: "ISO8601",
      completedAt: null,
      error: null,
    },
    handler: "packages/work/src/scheduling/workflow-engine.ts:executeWorkflow (via packages/mcp/src/mcp-server.ts case 'zana_workflow_run')",
    pitfalls: [
      "Returns the *full run record* once the workflow completes (or halts/fails). Not async — caller blocks until the workflow terminates.",
      "Failure paths return short error wrappers, not the run record: `{ error: 'max_concurrent_runs' }`, `{ error: 'no_steps' }`, `{ error: 'too_many_steps' }`. Check for an `error` key before reading `id`.",
      "If the underlying skill is missing or not type=workflow, the MCP wrapper returns `{ error: 'workflow skill not found' }`.",
      "Step results are nested in `steps[i].result`. The shape varies by `action.type` — `spawn` returns `{ agentId, profileId, prompt }`; `gate` returns `{ passed: true }`; `notify` returns `{ emitted: '<eventType>' }`; `wait` returns `{ waited: <ms> }`.",
    ],
  },
  zana_workflow_get_run: {
    example: {
      id: "run-uuid",
      skillId: "skill-id",
      skillName: "...",
      status: "running | completed | halted | failed",
      currentStep: 0,
      steps: [{ index: 0, action: "...", status: "completed", result: {} }],
      triggerContext: {},
      startedAt: "ISO8601",
      completedAt: "ISO8601 | null",
      error: null,
    },
    handler: "packages/work/src/scheduling/workflow-engine.ts:loadRun (via case 'zana_workflow_get_run')",
    pitfalls: [
      "Loads from disk (`<workflowsDir>/<runId>.json`) — works even after daemon restart.",
      "Unknown `runId` returns `{ error: 'run not found' }`, not `null`.",
      "Same shape as `executeWorkflow`'s return; safe to share render code with `zana_workflow_run`.",
    ],
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Markdown rendering
// ─────────────────────────────────────────────────────────────────────────────

function inputSchemaTable(schema) {
  if (!schema || !schema.properties || typeof schema.properties !== "object") {
    return "_No input parameters._\n";
  }
  const required = Array.isArray(schema.required) ? new Set(schema.required) : new Set();
  const rows = ["| Field | Type | Required | Enum / Notes |", "|---|---|---|---|"];
  const propNames = Object.keys(schema.properties).sort();
  if (propNames.length === 0) return "_No input parameters._\n";
  for (const name of propNames) {
    const prop = schema.properties[name] || {};
    const type = describeType(prop);
    const isRequired = required.has(name) ? "yes" : "no";
    const notes = describeNotes(prop);
    rows.push(`| ${escapeCell(name)} | ${escapeCell(type)} | ${isRequired} | ${escapeCell(notes)} |`);
  }
  return rows.join("\n") + "\n";
}

function describeType(prop) {
  if (!prop || typeof prop !== "object") return "?";
  if (Array.isArray(prop.anyOf)) {
    return prop.anyOf.map(describeType).join(" | ");
  }
  if (prop.type === "array") {
    if (prop.items && prop.items.type) return `array<${describeType(prop.items)}>`;
    return "array";
  }
  if (prop.type === "object") return "object";
  return prop.type || "?";
}

function describeNotes(prop) {
  if (!prop || typeof prop !== "object") return "";
  const parts = [];
  if (Array.isArray(prop.enum)) {
    parts.push(prop.enum.map((v) => `\`${v}\``).join(" | "));
  }
  if (prop.description) {
    parts.push(prop.description);
  }
  if (prop.type === "object" && prop.properties && typeof prop.properties === "object") {
    const inner = Object.keys(prop.properties).sort().join(", ");
    if (inner) parts.push(`fields: ${inner}`);
  }
  if (prop.type === "array" && prop.items && prop.items.enum) {
    parts.push(`items: ${prop.items.enum.map((v) => `\`${v}\``).join(" | ")}`);
  }
  return parts.join(" — ");
}

function escapeCell(s) {
  if (s == null) return "";
  return String(s).replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function renderOutput(tool) {
  const doc = OUTPUT_SHAPES[tool.name];
  if (!doc) {
    return [
      "**Output shape:** TODO — not yet documented. Read the handler before guessing field names.",
      "",
    ].join("\n");
  }
  const lines = ["**Output shape:**", "", "```json", stableStringify(doc.example, 2), "```", ""];
  return lines.join("\n");
}

function renderSource(tool) {
  const doc = OUTPUT_SHAPES[tool.name];
  const lines = ["**Source:**"];
  lines.push(`- MCP wrapper: \`${tool.sourceFile}:${tool.sourceLine}\``);
  if (doc) lines.push(`- Handler: \`${doc.handler}\``);
  return lines.join("\n") + "\n";
}

function renderPitfalls(tool) {
  const doc = OUTPUT_SHAPES[tool.name];
  if (!doc || !doc.pitfalls || doc.pitfalls.length === 0) return "";
  const lines = ["**Common pitfalls:**", ""];
  for (const p of doc.pitfalls) lines.push(`- ${p}`);
  return lines.join("\n") + "\n";
}

// Stable JSON stringify — sorts object keys so re-running produces identical
// output. Plays nice with our literal example shapes (which can include
// strings like "ISO8601" as placeholder values).
function stableStringify(value, indent) {
  return JSON.stringify(sortKeys(value), null, indent);
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortKeys(value[key]);
    }
    return out;
  }
  return value;
}

function renderTool(tool) {
  const lines = [];
  lines.push(`## ${tool.name}`);
  lines.push("");
  lines.push(`**Description:** ${tool.description || "_(no description)_"}`);
  lines.push("");
  lines.push("**Input:**");
  lines.push("");
  lines.push(inputSchemaTable(tool.inputSchema));
  lines.push(renderOutput(tool));
  lines.push(renderSource(tool));
  const pitfalls = renderPitfalls(tool);
  if (pitfalls) {
    lines.push(pitfalls);
  }
  lines.push("---");
  lines.push("");
  return lines.join("\n");
}

function renderIndex(tools) {
  const lines = ["## Index", ""];
  for (const t of tools) {
    lines.push(`- [\`${t.name}\`](#${t.name.replace(/_/g, "_").toLowerCase()})`);
  }
  lines.push("");
  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

function main() {
  let tools;
  try {
    // Per-domain registration files own the tool surface; mcp-server.ts is
    // bootstrap-only since the split.
    const sources = [MCP_SERVER_PATH, DELIBERATE_PATH];
    if (fs.existsSync(REGISTRATIONS_DIR)) {
      for (const f of fs.readdirSync(REGISTRATIONS_DIR)) {
        if (f.endsWith(".ts")) sources.push(path.join(REGISTRATIONS_DIR, f));
      }
    }
    const merged = [];
    const seen = new Set();
    for (const src of sources) {
      for (const t of extractToolsFromSource(src)) {
        if (!seen.has(t.name)) {
          merged.push(t);
          seen.add(t.name);
        }
      }
    }
    tools = merged;
  } catch (err) {
    process.stderr.write(`error parsing mcp-server.ts: ${err && err.message ? err.message : err}\n`);
    process.exit(1);
    return;
  }

  if (tools.length === 0) {
    process.stderr.write("no zana_* tools found in mcp registrations — aborting\n");
    process.exit(1);
    return;
  }

  tools.sort((a, b) => a.name.localeCompare(b.name));

  const header = [
    "# Zana MCP tool reference",
    "",
    "Generated by `scripts/generate-mcp-reference.ts` from `packages/mcp/src/mcp-server.ts` and handler sources. Re-run after MCP changes:",
    "",
    "    npm run docs:mcp-ref",
    "",
    "This file is the source of truth for slash-command authors. Use the documented field names and enum values verbatim — do not guess.",
    "",
    "Looking for end-to-end examples instead of per-tool signatures? See [`RECIPES.md`](RECIPES.md) — every recipe there is mirrored by a live Claude integration test under `scripts/qa/`.",
    "",
    "---",
    "",
  ].join("\n");

  const index = renderIndex(tools);
  const sections = tools.map(renderTool).join("\n");
  const out = header + index + "---\n\n" + sections;

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, out, "utf8");

  const documented = tools.filter((t) => OUTPUT_SHAPES[t.name]).length;
  const todo = tools.length - documented;
  process.stderr.write(
    `Generated reference for ${tools.length} tools (${documented} with documented output shapes, ${todo} with TODO output).\n`
  );
}

main();

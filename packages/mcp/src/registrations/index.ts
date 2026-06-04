// Aggregator for per-domain tool registrations. Each domain exports a
// `ToolDomain` (tools[] + handlers map). The bootstrap in mcp-server.ts
// concatenates the tools for `tools/list` and looks up handlers by name for
// `tools/call`.
//
// Adding a new domain: drop a `<name>.ts` file alongside this one and add it
// to ALL_DOMAINS below.

import type { ToolDefinition, ToolDomain, ToolHandler } from "../types";

import { agents } from "./agents";
import { profiles } from "./profiles";
import { skills } from "./skills";
import { tickets } from "./tickets";
import { sprints } from "./sprints";
import { teams } from "./teams";
import { schedules } from "./schedules";
import { events } from "./events";
import { channels } from "./channels";
import { intelligence } from "./intelligence";
import { checkpoints } from "./checkpoints";
import { workflows } from "./workflows";
import { artifacts } from "./artifacts";
import { swarm } from "./swarm";
import { autopilot } from "./autopilot";
import { deliberation } from "./deliberation";

// Order is preserved in `tools/list` output. Match the historical order in
// mcp-server.ts so any out-of-band consumer that depends on positional
// ordering keeps working: agents/profiles/skills, tickets+sprints, teams,
// intelligence, checkpoints, workflows, artifacts, schedules, events,
// channels, swarm, autopilot, deliberation.
const ALL_DOMAINS: ToolDomain[] = [
  agents,
  profiles,
  skills,
  tickets,
  sprints,
  teams,
  intelligence,
  checkpoints,
  workflows,
  artifacts,
  schedules,
  events,
  channels,
  swarm,
  autopilot,
  deliberation,
];

export function collectStaticTools(): ToolDefinition[] {
  return ALL_DOMAINS.flatMap((d) => d.tools);
}

export function collectHandlers(): Record<string, ToolHandler> {
  const out: Record<string, ToolHandler> = {};
  for (const domain of ALL_DOMAINS) {
    for (const [name, handler] of Object.entries(domain.handlers)) {
      out[name] = handler;
    }
  }
  return out;
}

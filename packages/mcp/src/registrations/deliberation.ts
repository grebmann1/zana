// T9 — Deliberation MCP tool family. The schemas + handlers live in
// ../tools/deliberate.ts (full council loop with collect-reviews, judge,
// override, nudge). This file just wires them into the registration plumbing.

import type { ToolDomain } from "../types";

const {
  DELIBERATION_TOOLS,
  deliberateHandler,
  deliberationStatusHandler,
  deliberationListHandler,
  deliberationOverrideHandler,
  deliberationCancelHandler,
  deliberationNudgeHandler,
} = require("../tools/deliberate");

export const deliberation: ToolDomain = {
  tools: DELIBERATION_TOOLS,

  handlers: {
    zana_deliberate: (args: any) => deliberateHandler(args),
    zana_deliberation_status: (args: any) => deliberationStatusHandler(args),
    zana_deliberation_list: (args: any) => deliberationListHandler(args || {}),
    zana_deliberation_override: (args: any) => deliberationOverrideHandler(args),
    zana_deliberate_cancel: (args: any) => deliberationCancelHandler(args),
    zana_deliberation_nudge: (args: any) => deliberationNudgeHandler(args),
  },
};

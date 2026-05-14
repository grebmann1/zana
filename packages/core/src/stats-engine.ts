function computeOverview(events) {
  const agents = new Set();
  let toolCalls = 0;
  let ticketsCreated = 0;
  let ticketsCompleted = 0;

  for (const ev of events) {
    switch (ev.type) {
      case "agent:spawned":
        agents.add(ev.payload?.agentId);
        break;
      case "agent:hook":
        if (ev.payload?.hook_event_name === "PostToolUse") toolCalls++;
        break;
      case "ticket:created":
        ticketsCreated++;
        break;
      case "ticket:completed":
        ticketsCompleted++;
        break;
    }
  }

  return {
    totalAgents: agents.size,
    totalToolCalls: toolCalls,
    ticketsCreated,
    ticketsCompleted,
    ticketCompletionRate: ticketsCreated > 0 ? ticketsCompleted / ticketsCreated : 0,
    eventCount: events.length,
  };
}

function computeToolBreakdown(events) {
  const breakdown = {};
  for (const ev of events) {
    if (ev.type === "agent:hook" && ev.payload?.hook_event_name === "PostToolUse") {
      const tool = ev.payload.tool_name || "unknown";
      breakdown[tool] = (breakdown[tool] || 0) + 1;
    }
  }
  return breakdown;
}

function computeProfileBreakdown(events) {
  const breakdown = {};
  for (const ev of events) {
    if (ev.type === "agent:spawned") {
      const profile = ev.payload?.profileId || "unknown";
      breakdown[profile] = (breakdown[profile] || 0) + 1;
    }
  }
  return breakdown;
}

function computeAgentTimeline(events, bucketMs = 30000) {
  if (events.length === 0) return [];

  const spawns = [];
  const terminations = [];

  for (const ev of events) {
    if (ev.type === "agent:spawned") spawns.push(ev.timestamp);
    if (ev.type === "agent:terminated") terminations.push(ev.timestamp);
  }

  if (spawns.length === 0) return [];

  const start = Math.min(...spawns);
  const end = Math.max(events[events.length - 1].timestamp, Date.now());
  const buckets = [];

  for (let ts = start; ts <= end; ts += bucketMs) {
    const activeAtTime = spawns.filter((s) => s <= ts).length -
      terminations.filter((t) => t <= ts).length;
    buckets.push({ ts, count: Math.max(0, activeAtTime) });
  }

  return buckets;
}

function computeTicketFlow(events) {
  const points = [];
  let created = 0;
  let completed = 0;

  for (const ev of events) {
    if (ev.type === "ticket:created") {
      created++;
      points.push({ ts: ev.timestamp, created, completed });
    } else if (ev.type === "ticket:completed") {
      completed++;
      points.push({ ts: ev.timestamp, created, completed });
    }
  }

  return points;
}

function computeThroughput(events, bucketMs = 30000) {
  if (events.length === 0) return [];

  const toolEvents = events.filter(
    (ev) => ev.type === "agent:hook" && ev.payload?.hook_event_name === "PostToolUse"
  );
  if (toolEvents.length === 0) return [];

  const start = toolEvents[0].timestamp;
  const end = toolEvents[toolEvents.length - 1].timestamp;
  const buckets = [];

  for (let ts = start; ts <= end; ts += bucketMs) {
    const count = toolEvents.filter((e) => e.timestamp >= ts && e.timestamp < ts + bucketMs).length;
    buckets.push({ ts, count });
  }

  return buckets;
}

function computePeakConcurrentAgents(events) {
  let current = 0;
  let peak = 0;

  for (const ev of events) {
    if (ev.type === "agent:spawned") {
      current++;
      if (current > peak) peak = current;
    } else if (ev.type === "agent:terminated") {
      current = Math.max(0, current - 1);
    }
  }

  return peak;
}

module.exports = {
  computeOverview,
  computeToolBreakdown,
  computeProfileBreakdown,
  computeAgentTimeline,
  computeTicketFlow,
  computeThroughput,
  computePeakConcurrentAgents,
};

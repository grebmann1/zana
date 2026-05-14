function _bus(): any { return require("@zana/core").events.bus.bus; }

const clients = new Set();
let eventCounter = 0;
let pingTimer = null;

const PING_INTERVAL_MS = 15000;

export const STREAM_EVENTS = [
  "agent:changed",
  "agent:spawned",
  "agent:terminated",
  "claude:hook",
  "eventbus:event",
  "ticket:changed",
  "ticket:blocked",
  "sprint:changed",
  "team:changed",
  "team:started",
  "team:stopped",
  "workflow:started",
  "workflow:step",
  "workflow:completed",
  "workflow:halted",
  "workflow:failed",
  "zana:ready",
  "zana:shutdown",
];

// Ring buffer for Last-Event-ID reconnection support
const HISTORY_SIZE = 256;
const history = [];

export function addClient(res, filterTypes, lastEventId) {
  const client = { res, filterTypes };
  clients.add(client);
  res.on("close", () => {
    clients.delete(client);
    _bus().emit("sse:connections", { count: clients.size });
  });

  // Replay missed events if Last-Event-ID provided
  if (lastEventId) {
    const startIdx = history.findIndex((e) => e.id === lastEventId);
    if (startIdx !== -1) {
      for (let i = startIdx + 1; i < history.length; i++) {
        const entry = history[i];
        if (filterTypes && !filterTypes.includes(entry.type)) continue;
        try { res.write(entry.raw); } catch { clients.delete(client); return client; }
      }
    }
  }

  _bus().emit("sse:connections", { count: clients.size });
  return client;
}

export function broadcast(eventType, data) {
  eventCounter++;
  const id = String(eventCounter);
  const raw = `id: ${id}\nevent: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;

  // Store in history ring buffer
  if (history.length >= HISTORY_SIZE) history.shift();
  history.push({ id, type: eventType, raw });

  for (const client of clients) {
    if (client.filterTypes && !client.filterTypes.includes(eventType)) continue;
    try {
      client.res.write(raw);
    } catch {
      clients.delete(client);
    }
  }
}

function sendPing() {
  const payload = `: ping ${Date.now()}\n\n`;
  for (const client of clients) {
    try {
      client.res.write(payload);
    } catch {
      clients.delete(client);
    }
  }
}

export function init() {
  for (const eventType of STREAM_EVENTS) {
    _bus().on(eventType, (data) => broadcast(eventType, data));
  }
  // Auto-ping every 15s to keep connections alive
  if (!pingTimer) {
    pingTimer = setInterval(sendPing, PING_INTERVAL_MS);
    if (pingTimer.unref) pingTimer.unref();
  }
}

export function stop() {
  if (pingTimer) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
}

export function getClientCount() {
  return clients.size;
}


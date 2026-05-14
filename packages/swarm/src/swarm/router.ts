// Swarm Router — P2P message routing + inbox management + channels.
// Hub topology: all inter-daemon messages route through the master daemon.

import * as http from "node:http";
import * as crypto from "node:crypto";
// Lazy access — @zana/core may still be loading when this module is first required.
function persistence() {
  return require("@zana/core").persistence;
}

// agentId → { daemonId, daemonPort, agentName, profileName, profileIcon }
const routingTable = new Map();
let routingTableLastRefresh = 0;
const ROUTING_TABLE_TTL = 30000; // 30 seconds

// agentId → P2PMessage[]
const inboxes = new Map();
const MAX_INBOX_SIZE = 1000;

// --- Channels (pub/sub) ---
// channelName → { subscribers: Set<agentId>, history: P2PMessage[] }
const channels = new Map();
const MAX_CHANNEL_HISTORY = 200;

// --- Acknowledgments ---
// messageId → { status, agentId, timestamp, response? }
const acks = new Map();
const ACK_TTL = 120000; // 2 minutes

const VALID_MESSAGE_TYPES = ["question", "finding", "handoff", "status", "request"];

export function generateMessageId() {
  return crypto.randomUUID();
}

export function deliverLocal(agentId, msg) {
  if (!msg.id) msg.id = generateMessageId();
  if (!msg.sentAt) msg.sentAt = Date.now();

  let inbox = inboxes.get(agentId);
  if (!inbox) {
    inbox = [];
    inboxes.set(agentId, inbox);
  }
  if (inbox.length >= MAX_INBOX_SIZE) {
    inbox.shift();
  }
  inbox.push(msg);
  persistence().persistInboxMessage(agentId, msg);
}

export function drainInbox(agentId) {
  const inbox = inboxes.get(agentId);
  if (!inbox || inbox.length === 0) return [];
  const messages = [...inbox];
  inboxes.set(agentId, []);
  persistence().persistInboxDrain(agentId);
  return messages;
}

export function recoverFromDisk() {
  const recovered = persistence().recoverInboxes();
  for (const [agentId, messages] of recovered) {
    if (messages.length > 0) {
      inboxes.set(agentId, messages);
    }
  }
  return recovered.size;
}

export function recoverChannelsFromDisk() {
  const recovered = persistence().recoverChannels();
  for (const [channelName, messages] of recovered) {
    const channel = createChannel(channelName);
    channel.history = messages.slice(-MAX_CHANNEL_HISTORY);
  }
  return recovered.size;
}

export function peekInbox(agentId) {
  return inboxes.get(agentId) || [];
}

export async function routeMessage(msg, localAgents, subDaemonPorts) {
  if (!VALID_MESSAGE_TYPES.includes(msg.type)) {
    return { ok: false, error: `invalid message type: ${msg.type}. Valid: ${VALID_MESSAGE_TYPES.join(", ")}` };
  }

  if (!msg.id) msg.id = generateMessageId();
  if (!msg.sentAt) msg.sentAt = Date.now();

  const toAgentId = msg.toAgentId;

  // Check if target is local
  const isLocal = localAgents.some((a) => a.id === toAgentId || a.terminalId === toAgentId);
  if (isLocal) {
    deliverLocal(toAgentId, msg);
    return { ok: true, delivered: "local" };
  }

  // Check routing table for sub-daemon target
  const route = routingTable.get(toAgentId);
  if (route) {
    const delivered = await postToDaemon(route.daemonPort, "/swarm/inbox", msg);
    return { ok: delivered, delivered: delivered ? "remote" : "failed" };
  }

  // Try each sub-daemon's inbox endpoint
  for (const port of subDaemonPorts) {
    const delivered = await postToDaemon(port, "/swarm/inbox", msg);
    if (delivered) return { ok: true, delivered: "remote" };
  }

  return { ok: false, error: "target agent not found in any daemon" };
}

export async function refreshRoutingTable(localAgents, subDaemonPorts, force = false) {
  if (!force && Date.now() - routingTableLastRefresh < ROUTING_TABLE_TTL && routingTable.size > 0) {
    return Array.from(routingTable.entries()).map(([id, info]) => ({ id, ...info }));
  }
  routingTable.clear();

  // Register local agents
  for (const agent of localAgents) {
    routingTable.set(agent.id, {
      daemonId: "local",
      daemonPort: null,
      agentName: agent.profileName || agent.id,
      profileName: agent.profileName,
      profileIcon: agent.profileIcon,
    });
    if (agent.terminalId) {
      routingTable.set(agent.terminalId, {
        daemonId: "local",
        daemonPort: null,
        agentName: agent.profileName || agent.id,
        profileName: agent.profileName,
        profileIcon: agent.profileIcon,
      });
    }
  }

  // Query each sub-daemon for their agents
  for (const port of subDaemonPorts) {
    try {
      const agents = await getFromDaemon(port, "/swarm/agents");
      if (Array.isArray(agents)) {
        for (const agent of agents) {
          routingTable.set(agent.id, {
            daemonId: agent.daemonId || "unknown",
            daemonPort: port,
            agentName: agent.profileName || agent.id,
            profileName: agent.profileName,
            profileIcon: agent.profileIcon,
          });
          if (agent.terminalId) {
            routingTable.set(agent.terminalId, {
              daemonId: agent.daemonId || "unknown",
              daemonPort: port,
              agentName: agent.profileName || agent.id,
              profileName: agent.profileName,
              profileIcon: agent.profileIcon,
            });
          }
        }
      }
    } catch (err) {
      console.warn(`[swarm-router] failed to query sub-daemon on port ${port}:`, err.message || err);
    }
  }

  routingTableLastRefresh = Date.now();
  return Array.from(routingTable.entries()).map(([id, info]) => ({ id, ...info }));
}

export function discoverAgents(query) {
  const results = [];
  for (const [id, info] of routingTable) {
    if (query) {
      const q = query.toLowerCase();
      const match =
        id.toLowerCase().includes(q) ||
        (info.agentName || "").toLowerCase().includes(q) ||
        (info.profileName || "").toLowerCase().includes(q);
      if (!match) continue;
    }
    results.push({ id, ...info });
  }
  // Deduplicate (terminalId and agentId point to same agent)
  const seen = new Set();
  return results.filter((r) => {
    if (seen.has(r.agentName + r.daemonPort)) return false;
    seen.add(r.agentName + r.daemonPort);
    return true;
  });
}

// HTTP helpers

function postToDaemon(port, path, body) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      path,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
      timeout: 5000,
    }, (res) => {
      let buf = "";
      res.on("data", (c) => { buf += c; });
      res.on("end", () => resolve(res.statusCode < 400));
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.write(data);
    req.end();
  });
}

function getFromDaemon(port, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      path: urlPath,
      method: "GET",
      timeout: 5000,
    }, (res) => {
      let buf = "";
      res.on("data", (c) => { buf += c; });
      res.on("end", () => {
        try { resolve(JSON.parse(buf)); }
        catch { reject(new Error("invalid JSON")); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.end();
  });
}

// --- Channel Functions ---

function createChannel(name) {
  if (channels.has(name)) return channels.get(name);
  const channel = { name, subscribers: new Set(), history: [] };
  channels.set(name, channel);
  return channel;
}

export function subscribeChannel(channelName, agentId) {
  const channel = createChannel(channelName);
  channel.subscribers.add(agentId);
  return { ok: true, channel: channelName, historyCount: channel.history.length };
}

export function unsubscribeChannel(channelName, agentId) {
  const channel = channels.get(channelName);
  if (!channel) return { ok: false, error: "channel not found" };
  channel.subscribers.delete(agentId);
  return { ok: true };
}

export function publishToChannel(channelName, msg) {
  const channel = createChannel(channelName);
  if (!msg.id) msg.id = generateMessageId();
  if (!msg.sentAt) msg.sentAt = Date.now();
  msg.channel = channelName;

  channel.history.push(msg);
  if (channel.history.length > MAX_CHANNEL_HISTORY) {
    channel.history = channel.history.slice(-MAX_CHANNEL_HISTORY);
  }
  persistence().persistChannelMessage(channelName, msg);

  let delivered = 0;
  for (const subscriberId of channel.subscribers) {
    if (subscriberId !== msg.fromAgentId) {
      deliverLocal(subscriberId, { ...msg, toAgentId: subscriberId });
      delivered++;
    }
  }

  return { ok: true, delivered, subscribers: channel.subscribers.size };
}

export function getChannelHistory(channelName, opts = {}) {
  const channel = channels.get(channelName);
  if (!channel) return [];
  const { since, limit } = opts;
  let history = channel.history;
  if (since) history = history.filter((m) => m.sentAt > since);
  if (limit) history = history.slice(-limit);
  return history;
}

export function listChannels() {
  const result = [];
  for (const [name, ch] of channels) {
    result.push({
      name,
      subscribers: ch.subscribers.size,
      messageCount: ch.history.length,
      lastActivity: ch.history.length > 0 ? ch.history[ch.history.length - 1].sentAt : null,
    });
  }
  return result;
}

// --- Acknowledgment Functions ---

export function requestAck(messageId) {
  acks.set(messageId, { status: "pending", timestamp: Date.now() });
}

export function sendAck(messageId, agentId, status, response) {
  const ack = acks.get(messageId);
  if (!ack) return { ok: false, error: "no ack requested for this message" };
  ack.status = status || "received";
  ack.agentId = agentId;
  ack.response = response || null;
  ack.timestamp = Date.now();
  return { ok: true };
}

export function checkAck(messageId) {
  const ack = acks.get(messageId);
  if (!ack) return null;
  if (Date.now() - ack.timestamp > ACK_TTL && ack.status === "pending") {
    ack.status = "timeout";
  }
  return ack;
}

export function cleanExpiredAcks() {
  const now = Date.now();
  for (const [id, ack] of acks) {
    if (now - ack.timestamp > ACK_TTL * 2) {
      acks.delete(id);
    }
  }
}


import * as crypto from "node:crypto";
import * as ptyHost from "./pty-host";

const activeConnections = new Map();

export function acceptWebSocket(req, socket, head) {
  const url = new URL(req.url, "http://localhost");
  const match = url.pathname.match(/^\/terminals\/([^/]+)\/ws$/);
  if (!match) {
    socket.destroy();
    return;
  }

  const terminalId = match[1];
  const terminal = ptyHost.getTerminal(terminalId);
  if (!terminal) {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }

  const key = req.headers["sec-websocket-key"];
  if (!key) {
    socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    socket.destroy();
    return;
  }

  const acceptKey = crypto
    .createHash("sha1")
    .update(key + "258EAFA5-E914-47DA-95CA-5495B35DC6BA")
    .digest("base64");

  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
    "Upgrade: websocket\r\n" +
    "Connection: Upgrade\r\n" +
    `Sec-WebSocket-Accept: ${acceptKey}\r\n` +
    "\r\n"
  );

  const connId = crypto.randomUUID();
  activeConnections.set(connId, { terminalId, socket });

  const unsubData = ptyHost.onTerminalData(({ terminalId: tid, data }) => {
    if (tid !== terminalId) return;
    try { sendFrame(socket, data); } catch {}
  });

  const unsubExit = ptyHost.onTerminalExit(({ terminalId: tid }) => {
    if (tid !== terminalId) return;
    try { sendCloseFrame(socket, 1000, "terminal exited"); } catch {}
    cleanup();
  });

  let buffer = Buffer.alloc(0);

  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 2) {
      const parsed = parseFrame(buffer);
      if (!parsed) break;
      buffer = buffer.subarray(parsed.totalLength);
      handleMessage(terminalId, parsed);
    }
  });

  socket.on("close", cleanup);
  socket.on("error", cleanup);

  function cleanup() {
    unsubData();
    unsubExit();
    activeConnections.delete(connId);
    if (!socket.destroyed) socket.destroy();
  }
}

function handleMessage(terminalId, frame) {
  if (frame.opcode === 0x08) return; // close
  if (frame.opcode === 0x09) return; // ping — could pong but not critical
  if (frame.opcode === 0x01 || frame.opcode === 0x02) {
    const text = frame.payload.toString("utf8");
    try {
      const msg = JSON.parse(text);
      if (msg.type === "resize" && msg.cols && msg.rows) {
        ptyHost.resizeTerminal(terminalId, msg.cols, msg.rows);
        return;
      }
      if (msg.type === "input" && msg.data) {
        ptyHost.writeTerminal(terminalId, msg.data);
        return;
      }
    } catch {}
    ptyHost.writeTerminal(terminalId, text);
  }
}

function sendFrame(socket, data) {
  const payload = Buffer.from(data, "utf8");
  let header;
  if (payload.length < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81; // fin + text
    header[1] = payload.length;
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  socket.write(Buffer.concat([header, payload]));
}

function sendCloseFrame(socket, code, reason) {
  const reasonBuf = Buffer.from(reason || "", "utf8");
  const payload = Buffer.alloc(2 + reasonBuf.length);
  payload.writeUInt16BE(code, 0);
  reasonBuf.copy(payload, 2);
  const header = Buffer.alloc(2);
  header[0] = 0x88; // fin + close
  header[1] = payload.length;
  socket.write(Buffer.concat([header, payload]));
}

function parseFrame(buf) {
  if (buf.length < 2) return null;
  const firstByte = buf[0];
  const secondByte = buf[1];
  const opcode = firstByte & 0x0f;
  const masked = !!(secondByte & 0x80);
  let payloadLength = secondByte & 0x7f;
  let offset = 2;

  if (payloadLength === 126) {
    if (buf.length < 4) return null;
    payloadLength = buf.readUInt16BE(2);
    offset = 4;
  } else if (payloadLength === 127) {
    if (buf.length < 10) return null;
    payloadLength = Number(buf.readBigUInt64BE(2));
    offset = 10;
  }

  const maskSize = masked ? 4 : 0;
  const totalLength = offset + maskSize + payloadLength;
  if (buf.length < totalLength) return null;

  let payload = buf.subarray(offset + maskSize, totalLength);
  if (masked) {
    const mask = buf.subarray(offset, offset + 4);
    payload = Buffer.from(payload);
    for (let i = 0; i < payload.length; i++) {
      payload[i] ^= mask[i & 3];
    }
  }

  return { opcode, payload, totalLength };
}

export function getConnectionCount() {
  return activeConnections.size;
}


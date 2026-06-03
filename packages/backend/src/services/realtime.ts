import { db, metaGet, metaSet } from "../db";
import { authenticateToken } from "../middleware/auth";
import { currentHourWindow, currentMessageSlot, noStore, withCdnHeaders } from "./cdn";
import { verifyViewerToken, viewerTokenFromRequest, viewerTokenRateLimit, edgeViewerIdentity } from "./viewer-auth";
import { processReportPayload } from "./device-status-handler";
import type { DeviceInfo } from "../types";
import type { ServerWebSocket } from "bun";

type Role = "viewer" | "device";

export interface WsData {
  role: Role;
  id: string;
  device?: DeviceInfo;
}

const MAX_TEXT_LENGTH = 500;
const MAX_MESSAGE_JSON_BYTES = 4096;
const MESSAGE_TTL_MINUTES = 30;
const VIEWER_RATE_LIMIT = 10;
const VIEWER_API_RATE_LIMIT = 60;
const VIEWER_WS_RATE_LIMIT = 30;
const RATE_WINDOW_MS = 60_000;
const PING_INTERVAL_MS = 25_000;
const PONG_TIMEOUT_MS = 35_000;
const MAX_VIEWER_SOCKETS_PER_VIEWER = 4;
const MAX_VIEWER_SOCKETS_TOTAL = 1000;
const GLOBAL_IP_RATE_LIMIT = 120; // 120 requests per minute per IP
const MAX_GLOBAL_IP_RATE_KEYS = 20_000;

const deviceSockets = new Map<string, ServerWebSocket<WsData>>();
const viewerSockets = new Map<string, Set<ServerWebSocket<WsData>>>();
const devicePongTimes = new Map<string, number>();
const viewerRate = new Map<string, { count: number; resetAt: number }>();
const viewerApiRate = new Map<string, { count: number; resetAt: number }>();
const viewerWsRate = new Map<string, { count: number; resetAt: number }>();
const globalIpRate = new Map<string, { count: number; resetAt: number }>();

export function globalIpRateLimit(ip: string): boolean {
  const now = Date.now();
  const current = globalIpRate.get(ip);
  if (!current || current.resetAt <= now) {
    if (!current && globalIpRate.size >= MAX_GLOBAL_IP_RATE_KEYS) {
      cleanupGlobalIpRate(now);
      if (globalIpRate.size >= MAX_GLOBAL_IP_RATE_KEYS) return false;
    }
    globalIpRate.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return true;
  }
  if (current.count >= GLOBAL_IP_RATE_LIMIT) return false;
  current.count++;
  return true;
}

function cleanupGlobalIpRate(now: number): void {
  for (const [key, val] of globalIpRate) {
    if (val.resetAt < now) globalIpRate.delete(key);
  }
}

// ── Prepared statement: mark a single device offline immediately ──
const markDeviceOffline = db.prepare(`
  UPDATE device_states SET is_online = 0
  WHERE device_id = ? AND is_online = 1
`);

// ── WS keepalive: periodic ping → pong timeout → close stale connections ──
const pingTimer = setInterval(() => {
  const now = Date.now();
  for (const [deviceId, ws] of deviceSockets) {
    const lastPong = devicePongTimes.get(deviceId) ?? 0;
    if (now - lastPong > PONG_TIMEOUT_MS) {
      ws.close(4001, "pong timeout");
      continue;
    }
    try { ws.ping(); } catch { /* socket may already be closing */ }
  }
}, PING_INTERVAL_MS);
pingTimer.unref();

// ── Rate limit cleanup: evict expired entries to prevent memory leaks ──
const rateCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, val] of viewerRate) {
    if (val.resetAt < now) viewerRate.delete(key);
  }
  for (const [key, val] of viewerApiRate) {
    if (val.resetAt < now) viewerApiRate.delete(key);
  }
  for (const [key, val] of viewerWsRate) {
    if (val.resetAt < now) viewerWsRate.delete(key);
  }
  cleanupGlobalIpRate(now);
}, 300_000); // every 5 minutes
rateCleanupTimer.unref();

const insertQueuedMessage = db.prepare(`
  INSERT INTO device_messages (id, device_id, viewer_id, text, expires_at)
  VALUES (?, ?, ?, ?, datetime('now', ?))
`);

const getPendingMessages = db.prepare(`
  SELECT dm.id, dm.viewer_id, dm.text, dm.created_at,
    COALESCE(vm.viewer_name, '') AS viewer_name,
    COALESCE(vm.kind, 'private') AS kind
  FROM device_messages dm
  LEFT JOIN visitor_messages vm ON vm.id = dm.id
  WHERE dm.device_id = ?
    AND dm.delivered_at = ''
    AND datetime(dm.expires_at) >= datetime('now')
  ORDER BY dm.created_at ASC
  LIMIT 20
`);

const markMessageDelivered = db.prepare(`
  UPDATE device_messages
  SET delivered_at = datetime('now')
  WHERE id = ? AND device_id = ?
`);

const markMessagesDelivered = db.transaction((deviceId: string, ids: string[]) => {
  for (const id of ids) markMessageDelivered.run(id, deviceId);
});

const markMessageReplied = db.prepare(`
  UPDATE device_messages
  SET replied_at = datetime('now')
  WHERE id = ?
`);

const isViewerBlockedStmt = db.prepare(`
  SELECT 1
  FROM blocked_viewers
  WHERE device_id = ? AND viewer_id = ?
  LIMIT 1
`);

const blockViewerStmt = db.prepare(`
  INSERT INTO blocked_viewers (device_id, viewer_id)
  VALUES (?, ?)
  ON CONFLICT(device_id, viewer_id) DO UPDATE SET blocked_at = datetime('now')
`);

const unblockViewerStmt = db.prepare(`
  DELETE FROM blocked_viewers
  WHERE device_id = ? AND viewer_id = ?
`);

const insertVisitorMessage = db.prepare(`
  INSERT INTO visitor_messages (id, device_id, viewer_id, viewer_name, kind, direction, text, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO NOTHING
`);

const deleteVisitorMessage = db.prepare(`
  DELETE FROM visitor_messages
  WHERE id = ? AND device_id = ?
`);

const deleteVisitorMessagesByViewer = db.prepare(`
  DELETE FROM visitor_messages
  WHERE device_id = ? AND viewer_id = ?
`);

const upsertViewerRemark = db.prepare(`
  INSERT INTO viewer_remarks (device_id, viewer_id, remark)
  VALUES (?, ?, ?)
  ON CONFLICT(device_id, viewer_id) DO UPDATE SET
    remark = excluded.remark,
    updated_at = datetime('now')
`);

const getDeviceMessageHistory = db.prepare(`
  SELECT m.id, m.device_id, m.viewer_id, m.viewer_name, m.kind, m.direction, m.text, m.created_at,
         COALESCE(r.remark, '') as viewer_remark
  FROM visitor_messages m
  LEFT JOIN viewer_remarks r ON m.device_id = r.device_id AND m.viewer_id = r.viewer_id
  WHERE (m.device_id = ? OR m.device_id = '__broadcast__' OR (m.device_id = '__public__' AND m.kind = 'public'))
    AND (? = '' OR datetime(m.created_at) > datetime(?))
  ORDER BY m.created_at ASC
  LIMIT 500
`);

const getViewerMessageHistory = db.prepare(`
  SELECT id, device_id, viewer_id, viewer_name, kind, direction, text, created_at
  FROM visitor_messages
  WHERE viewer_id = ? AND direction = 'device' AND kind = 'reply'
    AND (? = '' OR datetime(created_at) > datetime(?))
  ORDER BY created_at ASC
  LIMIT 100
`);

const getPublicMessagesByWindow = db.prepare(`
  SELECT id, device_id, viewer_id, viewer_name, text, created_at, kind
  FROM visitor_messages
  WHERE (kind = 'public' OR kind = 'public_reply')
    AND created_at >= ?
    AND created_at < ?
  ORDER BY created_at ASC
  LIMIT 200
`);

const getMessageTargetDevices = db.prepare(`
  SELECT device_id
  FROM device_states
  WHERE platform <> 'zepp'
  ORDER BY last_seen_at DESC
  LIMIT 20
`);

function send(ws: ServerWebSocket<WsData>, payload: unknown) {
  ws.send(JSON.stringify(payload));
}

function addViewerSocket(viewerId: string, ws: ServerWebSocket<WsData>) {
  const sockets = viewerSockets.get(viewerId) ?? new Set<ServerWebSocket<WsData>>();
  if (sockets.size >= MAX_VIEWER_SOCKETS_PER_VIEWER) {
    const oldest = sockets.values().next().value as ServerWebSocket<WsData> | undefined;
    if (oldest) {
      sockets.delete(oldest);
      try { oldest.close(1013, "viewer socket limit"); } catch { /* ignore */ }
    }
  }
  sockets.add(ws);
  viewerSockets.set(viewerId, sockets);
}

function removeViewerSocket(viewerId: string, ws: ServerWebSocket<WsData>) {
  const sockets = viewerSockets.get(viewerId);
  if (!sockets) return;
  sockets.delete(ws);
  if (sockets.size === 0) {
    viewerSockets.delete(viewerId);
  }
}

function forEachViewerSocket(callback: (ws: ServerWebSocket<WsData>) => void) {
  for (const sockets of viewerSockets.values()) {
    for (const viewerWs of sockets) callback(viewerWs);
  }
}

function sendToViewerSockets(viewerId: string, payload: unknown): number {
  const sockets = viewerSockets.get(viewerId);
  if (!sockets || sockets.size === 0) return 0;
  let delivered = 0;
  const encoded = JSON.stringify(payload);
  for (const viewerWs of sockets) {
    try {
      viewerWs.send(encoded);
      delivered += 1;
    } catch {
      // The close callback will remove dead sockets; ignore transient send errors here.
    }
  }
  return delivered;
}

function viewerSocketCount() {
  let count = 0;
  for (const sockets of viewerSockets.values()) count += sockets.size;
  return count;
}

function requestIp(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded ||
    req.headers.get("x-real-ip") ||
    req.headers.get("cf-connecting-ip") ||
    "unknown";
}

function parseJson(raw: string | Buffer): any | null {
  try {
    const text = typeof raw === "string" ? raw : raw.toString("utf8");
    if (text.length > MAX_MESSAGE_JSON_BYTES) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function cleanText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c]/g, "").trim().slice(0, MAX_TEXT_LENGTH);
}

function cleanMessageId(value: unknown): string {
  if (typeof value !== "string") return "";
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 80);
  return /^[a-zA-Z0-9_.:-]{1,80}$/.test(cleaned) ? cleaned : "";
}

async function readMessageJson(req: Request): Promise<{ ok: true; body: any } | { ok: false; response: Response }> {
  const length = Number(req.headers.get("content-length") || 0);
  if (Number.isFinite(length) && length > MAX_MESSAGE_JSON_BYTES) {
    return { ok: false, response: Response.json({ error: "Request too large" }, { status: 413 }) };
  }
  const contentType = req.headers.get("content-type") || "";
  if (contentType && !contentType.toLowerCase().includes("application/json")) {
    return { ok: false, response: Response.json({ error: "Content-Type must be application/json" }, { status: 415 }) };
  }
  let text = "";
  try {
    text = await readLimitedText(req, MAX_MESSAGE_JSON_BYTES);
  } catch {
    return { ok: false, response: Response.json({ error: "Request too large" }, { status: 413 }) };
  }
  if (text.length > MAX_MESSAGE_JSON_BYTES) {
    return { ok: false, response: Response.json({ error: "Request too large" }, { status: 413 }) };
  }
  try {
    return { ok: true, body: JSON.parse(text) };
  } catch {
    return { ok: false, response: Response.json({ error: "Invalid JSON" }, { status: 400 }) };
  }
}

async function readLimitedText(req: Request, maxBytes: number): Promise<string> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      try { await reader.cancel(); } catch { /* ignore */ }
      throw new Error("too_large");
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return text;
}

function rateLimit(viewerId: string): boolean {
  const now = Date.now();
  const current = viewerRate.get(viewerId);
  if (!current || current.resetAt <= now) {
    viewerRate.set(viewerId, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return true;
  }
  if (current.count >= VIEWER_RATE_LIMIT) return false;
  current.count += 1;
  return true;
}

function apiRateLimit(viewerId: string): boolean {
  const now = Date.now();
  const current = viewerApiRate.get(viewerId);
  if (!current || current.resetAt <= now) {
    viewerApiRate.set(viewerId, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return true;
  }
  if (current.count >= VIEWER_API_RATE_LIMIT) return false;
  current.count += 1;
  return true;
}

function cleanViewerId(value: unknown): string {
  if (typeof value !== "string") return "";
  return /^[a-zA-Z0-9_-]{3,120}$/.test(value) ? value : "";
}

function cleanDeviceId(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 120);
}

function isViewerBlocked(deviceId: string, viewerId: string): boolean {
  return Boolean(isViewerBlockedStmt.get(deviceId, viewerId));
}

function cleanViewerName(value: unknown): string {
  if (typeof value !== "string") return "";
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 32);
  // Prevent visitors from impersonating admin
  if (/^(up|admin|管理员|博主|owner|root|system)$/i.test(cleaned)) return "";
  return cleaned;
}

function cleanKind(value: unknown): "public" | "private" {
  return value === "public" ? "public" : "private";
}

function recordMessage(
  id: string,
  deviceId: string,
  viewerId: string,
  viewerName: string,
  kind: "public" | "private" | "reply" | "public_reply",
  direction: "viewer" | "device",
  text: string,
  createdAt = new Date().toISOString(),
) {
  insertVisitorMessage.run(id, deviceId, viewerId, viewerName, kind, direction, text, createdAt);
}

function queueMessage(deviceId: string, viewerId: string, text: string, messageId: string) {
  try {
    insertQueuedMessage.run(
      messageId,
      deviceId,
      viewerId,
      text,
      `+${MESSAGE_TTL_MINUTES} minutes`
    );
  } catch {
    // Duplicate client-supplied message ids are ignored; the sender still gets an ack.
  }
}

function wsRateLimit(viewerId: string): boolean {
  const now = Date.now();
  const current = viewerWsRate.get(viewerId);
  if (!current || current.resetAt <= now) {
    viewerWsRate.set(viewerId, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return true;
  }
  if (current.count >= VIEWER_WS_RATE_LIMIT) return false;
  current.count += 1;
  return true;
}

function messageTargets(preferredDeviceId = ""): string[] {
  const ids = new Set<string>();
  if (preferredDeviceId) ids.add(preferredDeviceId);
  for (const row of getMessageTargetDevices.all() as { device_id: string }[]) {
    if (row.device_id) ids.add(row.device_id);
  }
  for (const id of deviceSockets.keys()) ids.add(id);
  return Array.from(ids).slice(0, 20);
}

function deliverViewerMessage(
  targetDeviceId: string,
  viewerId: string,
  viewerName: string,
  kind: "public" | "private",
  text: string,
  messageId: string,
  createdAt: string,
) {
  const deviceWs = deviceSockets.get(targetDeviceId);
  if (deviceWs) {
    send(deviceWs, {
      type: "viewer_message",
      message_id: messageId,
      viewer_id: viewerId,
      viewer_name: viewerName,
      kind,
      text,
      created_at: createdAt,
    });
    return "sent";
  }
  queueMessage(targetDeviceId, viewerId, text, messageId);
  return "queued";
}

function deliverQueuedMessages(deviceId: string, ws: ServerWebSocket<WsData>) {
  const rows = getPendingMessages.all(deviceId) as {
    id: string;
    viewer_id: string;
    viewer_name: string;
    kind: string;
    text: string;
    created_at: string;
  }[];
  if (rows.length === 0) return;

  // Mark messages as delivered BEFORE sending to avoid race condition.
  // If send fails after marking, messages won't be resent on reconnect,
  // but this prevents the worse case of infinite redelivery loops.
  markMessagesDelivered(deviceId, rows.map((r) => r.id));

  for (const row of rows) {
    send(ws, {
      type: "viewer_message",
      message_id: row.id,
      viewer_id: row.viewer_id,
      viewer_name: row.viewer_name,
      kind: row.kind,
      text: row.text,
      created_at: row.created_at,
      queued: true,
    });
  }
}

export function getWsInfo(req: Request): WsData | Response {
  const url = new URL(req.url);
  const role = url.searchParams.get("role");
  if (role === "device") {
    const device = authenticateToken(req.headers.get("authorization"));
    if (!device) return Response.json({ error: "Unauthorized" }, { status: 401 });
    return { role: "device", id: device.device_id, device };
  }

  if (role === "viewer") {
    const viewer = edgeViewerIdentity(req) || verifyViewerToken(viewerTokenFromRequest(req));
    if (!viewer) return Response.json({ error: "Viewer token required" }, { status: 403 });
    if (!globalIpRateLimit(requestIp(req))) {
      return Response.json({ error: "Rate limit exceeded" }, { status: 429 });
    }
    if (!wsRateLimit(viewer.viewerId)) {
      return Response.json({ error: "Too many WebSocket reconnects" }, { status: 429 });
    }
    if (viewerSocketCount() >= MAX_VIEWER_SOCKETS_TOTAL) {
      return Response.json({ error: "Too many WebSocket connections" }, { status: 503 });
    }
    return { role: "viewer", id: viewer.viewerId };
  }

  return Response.json({ error: "role must be viewer or device" }, { status: 400 });
}

export const realtimeWebSocket = {
  open(ws: ServerWebSocket<WsData>) {
    if (ws.data.role === "device") {
      const previous = deviceSockets.get(ws.data.id);
      if (previous && previous !== ws) {
        try { previous.close(4000, "replaced by new device socket"); } catch { /* ignore */ }
      }
      deviceSockets.set(ws.data.id, ws);
      devicePongTimes.set(ws.data.id, Date.now());
      send(ws, { type: "ack", status: "connected", role: "device", device_id: ws.data.id });
      deliverQueuedMessages(ws.data.id, ws);
      return;
    }
    addViewerSocket(ws.data.id, ws);
    send(ws, { type: "ack", status: "connected", role: "viewer", viewer_id: ws.data.id });
  },

  pong(ws: ServerWebSocket<WsData>) {
    if (ws.data.role === "device") {
      devicePongTimes.set(ws.data.id, Date.now());
    }
  },

  message(ws: ServerWebSocket<WsData>, raw: string | Buffer) {
    const data = parseJson(raw);
    if (!data || typeof data.type !== "string") {
      send(ws, { type: "error", error: "Invalid JSON" });
      return;
    }

    if (ws.data.role === "viewer" && data.type === "viewer_ping") {
      send(ws, { type: "viewer_pong", at: new Date().toISOString() });
      return;
    }

    if (ws.data.role === "viewer" && data.type === "viewer_message") {
      if (!rateLimit(ws.data.id)) {
        send(ws, { type: "error", error: "Rate limit exceeded" });
        return;
      }

      const targetDeviceId = cleanDeviceId(data.target_device_id);
      const text = cleanText(data.text);
      const kind = cleanKind(data.kind);
      const viewerName = cleanViewerName(data.viewer_name);
      const messageId = cleanMessageId(data.message_id) || crypto.randomUUID();
      if (!targetDeviceId || !text) {
        if (kind === "private") {
          send(ws, { type: "error", message_id: messageId, error: "target_device_id and text required" });
          return;
        }
        if (!text) {
          send(ws, { type: "error", message_id: messageId, error: "text required" });
          return;
        }
      }

      if (kind === "public") {
        const createdAt = new Date().toISOString();
        const targets = messageTargets(targetDeviceId)
          .filter((deviceId) => !isViewerBlocked(deviceId, ws.data.id));
        recordMessage(messageId, "__public__", ws.data.id, viewerName, "public", "viewer", text, createdAt);
        let sent = 0;
        let queued = 0;
        for (const deviceId of targets) {
          const status = deliverViewerMessage(deviceId, ws.data.id, viewerName, "public", text, messageId, createdAt);
          if (status === "sent") sent += 1;
          else queued += 1;
        }
        send(ws, { type: "ack", message_id: messageId, status: sent > 0 ? "sent" : queued > 0 ? "queued" : "recorded", sent, queued });
        return;
      }

      const createdAt = new Date().toISOString();
      const targets = messageTargets(targetDeviceId)
        .filter((deviceId) => !isViewerBlocked(deviceId, ws.data.id));
      recordMessage(messageId, targetDeviceId || "__broadcast__", ws.data.id, viewerName, "private", "viewer", text, createdAt);
      let sent = 0;
      let queued = 0;
      for (const deviceId of targets) {
        const status = deliverViewerMessage(deviceId, ws.data.id, viewerName, "private", text, messageId, createdAt);
        if (status === "sent") sent += 1;
        else queued += 1;
      }
      send(ws, { type: "ack", message_id: messageId, status: sent > 0 ? "sent" : queued > 0 ? "queued" : "recorded", sent, queued });
      return;
    }

    if (ws.data.role === "device" && data.type === "device_reply") {
      const targetViewerId = typeof data.target_viewer_id === "string" ? data.target_viewer_id : "";
      const text = cleanText(data.text);
      const messageId = cleanMessageId(data.message_id);
      const replyId = cleanMessageId(data.reply_id) || crypto.randomUUID();
      if (!targetViewerId || !text) {
        send(ws, { type: "error", message_id: messageId, error: "target_viewer_id and text required" });
        return;
      }
      if (messageId) markMessageReplied.run(messageId);
      recordMessage(replyId, ws.data.id, targetViewerId, "", "reply", "device", text);
      sendToViewerSockets(targetViewerId, {
        type: "device_reply",
        message_id: replyId,
        in_reply_to: messageId,
        device_id: ws.data.id,
        text,
        created_at: new Date().toISOString(),
      });
      send(ws, { type: "ack", message_id: messageId, status: "reply_sent" });

      // Web Push for offline viewer
      import("./push").then(({ sendPush }) => {
        sendPush(targetViewerId, {
          title: "Monika 回复了",
          body: text.slice(0, 120),
          icon: "/icon-192.png",
          url: "/",
        }).catch(() => {});
      });
      return;
    }

    if (ws.data.role === "device" && data.type === "device_status") {
      // Any device_status message refreshes keepalive (proof of life)
      devicePongTimes.set(ws.data.id, Date.now());
      // If payload present, process as full report (WebSocket上报通道)
      if (data.payload && ws.data.device) {
        const receivedAt = new Date().toISOString();
        let publicPayload: ReturnType<typeof processReportPayload> = null;
        try {
          publicPayload = processReportPayload(data.payload, ws.data.device);
        } catch (e: any) {
          console.error("[ws] device_status processing error:", e.message);
          send(ws, { type: "error", error: "status_processing_failed" });
          return;
        }
        // Broadcast only the sanitized public fields. Raw window titles stay server-side.
        if (publicPayload) {
          const deviceUpdate = {
            type: "device_update",
            device_id: ws.data.device.device_id,
            payload: publicPayload,
            timestamp: receivedAt,
          };
          const updateMsg = JSON.stringify(deviceUpdate);
          forEachViewerSocket((viewerWs) => {
            try { viewerWs.send(updateMsg); } catch { /* ignore send errors */ }
          });
        }
      }
      send(ws, { type: "ack", status: "status_received" });
      return;
    }

    send(ws, { type: "error", error: "Unsupported message type" });
  },

  close(ws: ServerWebSocket<WsData>) {
    if (ws.data.role === "device") {
      if (deviceSockets.get(ws.data.id) === ws) deviceSockets.delete(ws.data.id);
      devicePongTimes.delete(ws.data.id);
      // Immediately mark device offline so dashboard reflects disconnection
      try { markDeviceOffline.run(ws.data.id); } catch { /* ignore */ }
    } else {
      removeViewerSocket(ws.data.id, ws);
    }
  },
};

export function handleDeviceMessages(req: Request): Response {
  const device = authenticateToken(req.headers.get("authorization"));
  if (!device) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const rows = getPendingMessages.all(device.device_id) as {
    id: string;
    viewer_id: string;
    viewer_name: string;
    kind: string;
    text: string;
    created_at: string;
  }[];
  if (rows.length > 0) {
    markMessagesDelivered(device.device_id, rows.map((r) => r.id));
  }
  return Response.json({ messages: rows });
}

export function handleDeviceMessageHistory(req: Request): Response {
  const device = authenticateToken(req.headers.get("authorization"));
  if (!device) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const since = url.searchParams.get("since") || "";
  const safeSince = since && !isNaN(new Date(since).getTime()) ? new Date(since).toISOString() : "";
  const rows = getDeviceMessageHistory.all(device.device_id, safeSince, safeSince);
  return Response.json({ messages: rows });
}

export function handleViewerMessageHistory(req: Request): Response {
  const viewer = edgeViewerIdentity(req) || verifyViewerToken(viewerTokenFromRequest(req));
  if (!viewer) return Response.json({ error: "Viewer token required" }, { status: 403 });
  if (!viewerTokenRateLimit(viewer.viewerId)) return Response.json({ error: "Rate limit exceeded" }, { status: 429 });

  // Server-side last_read tracking — do not trust client timestamps
  const lastReadKey = "last_read:" + viewer.viewerId;
  const lastRead = metaGet(lastReadKey) || new Date(Date.now() - 86400000).toISOString();
  const rows = getViewerMessageHistory.all(viewer.viewerId, lastRead, lastRead);
  // Update last_read to now after returning messages
  const now = new Date().toISOString();
  metaSet(lastReadKey, now);
  return noStore(Response.json({ messages: rows, last_read: now }), ["viewer-history", `viewer-${viewer.viewerId}`]);
}

export async function handleDeviceMessageReply(req: Request): Promise<Response> {
  const device = authenticateToken(req.headers.get("authorization"));
  if (!device) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = await readMessageJson(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  const viewerId = typeof body.target_viewer_id === "string" ? body.target_viewer_id : "";
  const messageId = cleanMessageId(body.message_id);
  const text = cleanText(body.text);
  if (!viewerId || !text) {
    return Response.json({ error: "target_viewer_id and text required" }, { status: 400 });
  }

  if (messageId) markMessageReplied.run(messageId);
  const replyId = cleanMessageId(body.reply_id) || crypto.randomUUID();

  // If replying to a public message, only create public_reply (not private)
  if (messageId) {
    const original = db.prepare("SELECT kind FROM visitor_messages WHERE id = ?").get(messageId) as { kind: string } | null;
    if (original?.kind === "public") {
      recordMessage("pub_" + replyId, device.device_id, viewerId, "up", "public_reply", "device", text);
    } else {
      recordMessage(replyId, device.device_id, viewerId, "", "reply", "device", text);
    }
  } else {
    recordMessage(replyId, device.device_id, viewerId, "", "reply", "device", text);
  }
  const delivered = sendToViewerSockets(viewerId, {
    type: "device_reply",
    message_id: replyId,
    in_reply_to: messageId,
    device_id: device.device_id,
    text,
    created_at: new Date().toISOString(),
  });

  // Web Push notification for offline viewers
  import("./push").then(({ sendPush }) => {
    sendPush(viewerId, {
      title: "Monika 回复了",
      body: text.slice(0, 120),
      icon: "/icon-192.png",
      url: "/",
    }).catch(() => {});
  });

  return Response.json({ ok: true, delivered: delivered > 0, delivered_sockets: delivered });
}

export async function handlePublicMessagePost(req: Request): Promise<Response> {
  const viewer = edgeViewerIdentity(req) || verifyViewerToken(viewerTokenFromRequest(req));
  if (!viewer) return Response.json({ error: "Viewer token required" }, { status: 403 });
  if (!viewerTokenRateLimit(viewer.viewerId) || !apiRateLimit(viewer.viewerId)) {
    return Response.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const parsed = await readMessageJson(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  const text = cleanText(body.text);
  if (!text) return Response.json({ error: "text required" }, { status: 400 });
  const preferredDeviceId = cleanDeviceId(body.target_device_id);
  const viewerName = cleanViewerName(body.viewer_name);
  const messageId = cleanMessageId(body.message_id) || crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const targets = messageTargets(preferredDeviceId)
    .filter((deviceId) => !isViewerBlocked(deviceId, viewer.viewerId));

  recordMessage(messageId, "__public__", viewer.viewerId, viewerName, "public", "viewer", text, createdAt);
  let sent = 0;
  let queued = 0;
  for (const deviceId of targets) {
    const status = deliverViewerMessage(deviceId, viewer.viewerId, viewerName, "public", text, messageId, createdAt);
    if (status === "sent") sent += 1;
    else queued += 1;
  }

  const payload = JSON.stringify({
    type: "public_message",
    message: {
      id: messageId,
      device_id: "__public__",
      viewer_id: viewer.viewerId,
      viewer_name: viewerName,
      text,
      created_at: createdAt,
    },
  });
  forEachViewerSocket((viewerWs) => {
    try { viewerWs.send(payload); } catch { /* ignore */ }
  });

  return Response.json({ ok: true, message_id: messageId, sent, queued });
}

export async function handlePrivateMessagePost(req: Request): Promise<Response> {
  const viewer = edgeViewerIdentity(req) || verifyViewerToken(viewerTokenFromRequest(req));
  if (!viewer) return Response.json({ error: "Viewer token required" }, { status: 403 });
  if (!viewerTokenRateLimit(viewer.viewerId) || !apiRateLimit(viewer.viewerId)) {
    return Response.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const parsed = await readMessageJson(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  const targetDeviceId = cleanDeviceId(body.target_device_id);
  const text = cleanText(body.text);
  const viewerName = cleanViewerName(body.viewer_name);
  const messageId = cleanMessageId(body.message_id) || crypto.randomUUID();
  if (!targetDeviceId || !text) {
    return Response.json({ error: "target_device_id and text required", message_id: messageId }, { status: 400 });
  }
  if (isViewerBlocked(targetDeviceId, viewer.viewerId)) {
    return Response.json({ error: "blocked_by_device", message_id: messageId }, { status: 403 });
  }

  const createdAt = new Date().toISOString();
  recordMessage(messageId, targetDeviceId, viewer.viewerId, viewerName, "private", "viewer", text, createdAt);
  const status = deliverViewerMessage(targetDeviceId, viewer.viewerId, viewerName, "private", text, messageId, createdAt);
  return Response.json({ ok: true, message_id: messageId, status });
}

export function handlePublicMessages(req: Request): Response {
  const viewer = edgeViewerIdentity(req) || verifyViewerToken(viewerTokenFromRequest(req));
  const device = authenticateToken(req.headers.get("authorization"));
  if (!viewer && !device) return Response.json({ error: "Viewer or device token required" }, { status: 403 });
  if (viewer) {
    if (!viewerTokenRateLimit(viewer.viewerId)) return Response.json({ error: "Rate limit exceeded" }, { status: 429 });
    if (!apiRateLimit(viewer.viewerId)) return Response.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const url = new URL(req.url);
  const slotParam = url.searchParams.get("slot");
  if (slotParam) {
    if (!/^\d{12}$/.test(slotParam)) {
      return Response.json({ error: "slot must be YYYYMMDDHHmm" }, { status: 400 });
    }
    const year = Number(slotParam.slice(0, 4));
    const month = Number(slotParam.slice(4, 6)) - 1;
    const day = Number(slotParam.slice(6, 8));
    const hour = Number(slotParam.slice(8, 10));
    const minute = Number(slotParam.slice(10, 12));
    const start = new Date(Date.UTC(year, month, day, hour, minute));
    if (isNaN(start.getTime())) return Response.json({ error: "invalid slot" }, { status: 400 });
    const end = new Date(start.getTime() + 10 * 60_000);
    const rows = getPublicMessagesByWindow.all(start.toISOString(), end.toISOString());
    const currentSlot = slotParam === currentMessageSlot();
    const response = Response.json({ slot: slotParam, messages: rows });
    if (currentSlot) return noStore(response, ["public-messages", `public-messages-slot-${slotParam}`]);
    return withCdnHeaders(
      response,
      ["public-messages", `public-messages-slot-${slotParam}`],
      60 * 60 * 24 * 30,
    );
  }

  const windowParam = url.searchParams.get("window") || currentHourWindow();
  if (!/^\d{10}$/.test(windowParam)) {
    return Response.json({ error: "window must be YYYYMMDDHH" }, { status: 400 });
  }

  const year = Number(windowParam.slice(0, 4));
  const month = Number(windowParam.slice(4, 6)) - 1;
  const day = Number(windowParam.slice(6, 8));
  const hour = Number(windowParam.slice(8, 10));
  const start = new Date(Date.UTC(year, month, day, hour));
  if (isNaN(start.getTime())) return Response.json({ error: "invalid window" }, { status: 400 });
  const end = new Date(start.getTime() + 60 * 60_000);
  const rows = getPublicMessagesByWindow.all(start.toISOString(), end.toISOString());
  const currentWindow = windowParam === currentHourWindow();
  const response = Response.json({ window: windowParam, messages: rows });
  if (currentWindow) return noStore(response, ["public-messages", `public-messages-${windowParam}`]);
  return withCdnHeaders(
    response,
    ["public-messages", `public-messages-${windowParam}`],
    60 * 60 * 24 * 30,
  );
}

export async function handleBlockViewer(req: Request): Promise<Response> {
  const device = authenticateToken(req.headers.get("authorization"));
  if (!device) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = await readMessageJson(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  const viewerId = cleanViewerId(body.viewer_id);
  if (!viewerId) {
    return Response.json({ error: "viewer_id required" }, { status: 400 });
  }

  blockViewerStmt.run(device.device_id, viewerId);
  return Response.json({ ok: true });
}

export async function handleUnblockViewer(req: Request): Promise<Response> {
  const device = authenticateToken(req.headers.get("authorization"));
  if (!device) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = await readMessageJson(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  const viewerId = cleanViewerId(body.viewer_id);
  if (!viewerId) {
    return Response.json({ error: "viewer_id required" }, { status: 400 });
  }

  unblockViewerStmt.run(device.device_id, viewerId);
  return Response.json({ ok: true });
}

export async function handleDeleteMessage(req: Request): Promise<Response> {
  const device = authenticateToken(req.headers.get("authorization"));
  if (!device) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = await readMessageJson(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  const messageId = cleanMessageId(body.message_id);
  if (!messageId) {
    return Response.json({ error: "message_id required" }, { status: 400 });
  }

  deleteVisitorMessage.run(messageId, device.device_id);
  return Response.json({ ok: true });
}

export async function handleDeleteViewerMessages(req: Request): Promise<Response> {
  const device = authenticateToken(req.headers.get("authorization"));
  if (!device) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = await readMessageJson(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  const viewerId = cleanViewerId(body.viewer_id);
  if (!viewerId) {
    return Response.json({ error: "viewer_id required" }, { status: 400 });
  }

  deleteVisitorMessagesByViewer.run(device.device_id, viewerId);
  return Response.json({ ok: true });
}

export async function handleSetRemark(req: Request): Promise<Response> {
  const device = authenticateToken(req.headers.get("authorization"));
  if (!device) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = await readMessageJson(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  const viewerId = cleanViewerId(body.viewer_id);
  const remark = cleanText(body.remark); // Use cleanText to prevent huge inputs

  if (!viewerId) {
    return Response.json({ error: "viewer_id required" }, { status: 400 });
  }

  upsertViewerRemark.run(device.device_id, viewerId, remark);
  return Response.json({ ok: true });
}

/**
 * DELETE /api/device — 删除当前设备的所有数据（状态 + activities）
 * 认证方式：Bearer token（与 /api/report 相同）
 */
export async function handleDeleteDevice(req: Request): Promise<Response> {
  const device = authenticateToken(req.headers.get("authorization"));
  if (!device) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { deleteDevice, deleteDeviceActivities } = await import("../db");

  // 1. 断开 WebSocket 连接
  const ws = deviceSockets.get(device.device_id);
  if (ws) {
    try { ws.close(4003, "device_deleted"); } catch { /* ignore */ }
    deviceSockets.delete(device.device_id);
  }
  devicePongTimes.delete(device.device_id);

  // 2. 删除数据库记录
  deleteDeviceActivities.run(device.device_id);
  deleteDevice.run(device.device_id);

  return Response.json({ ok: true, deleted: device.device_id });
}

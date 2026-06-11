import { db } from "../db";
import { authenticateToken, extractBearerToken } from "../middleware/auth";
import { currentHourWindow, currentMessageSlot, noStore, withCdnHeaders } from "./cdn";
import { verifyViewerToken, viewerTokenFromRequest, viewerTokenRateLimit, edgeViewerIdentity } from "./viewer-auth";
import { processReportPayload, ReportPayloadError } from "./device-status-handler";
import { requestSupervisionCheckFromReportPayload } from "./supervision-report-trigger";
import { deviceCommandReceiptWsResponse, deviceCommandResultWsResponse } from "./supervision-ack";
import type { DeviceCommandEnvelope, DeliveryStatus } from "./mcp-contracts";
import { aiJobInputErrorResponse, setAiJobNotifier, submitAiJobFromClient } from "./ai-jobs";
import { realtimeSocketHub, sendJson } from "./realtime-socket-hub";
import {
  globalIpRateLimit,
  realtimeApiRateLimit,
  requestIp,
  viewerMessageRateLimit,
  viewerWsRateLimit,
} from "./realtime-rate-limit";
import {
  blockViewer,
  deleteMessageForDevice,
  deleteViewerMessagesForDevice,
  deviceMessageHistory,
  hasMessageTargetDevice,
  isPublicMessageThread,
  isViewerBlocked,
  markMessageDelivered,
  markMessageReplied,
  markMessagesDelivered,
  messageTargetDevices,
  pendingMessages,
  publicMessagesByWindow,
  queueMessage,
  queuedMessageWasDelivered,
  recentPublicMessages,
  recordMessage,
  setViewerRemark,
  unblockViewer,
  viewerMessageHistory,
} from "./realtime-message-store";
import {
  cleanDeviceId,
  cleanKind,
  cleanMessageId,
  cleanText,
  cleanViewerId,
  cleanViewerName,
  parseJson,
  parseMessagePayload,
  publicRecentHours,
  readMessageJson,
  serializedMessagePayload,
} from "./message-protocol";
import type { WsData } from "./realtime-types";
import type { ServerWebSocket } from "bun";

export type { WsData } from "./realtime-types";

// ── Prepared statement: mark a single device offline immediately ──
const markDeviceOffline = db.prepare(`
  UPDATE device_states SET is_online = 0
  WHERE device_id = ? AND is_online = 1
`);

setAiJobNotifier((job) => {
  realtimeSocketHub.broadcastDevicePayload({ type: "ai_job_update", job }, { messageCapableOnly: true });
});

function broadcastPublicMessage(message: {
  id: string;
  device_id: string;
  viewer_id: string;
  viewer_name: string;
  kind: "public" | "public_reply";
  text: string;
  created_at: string;
}) {
  realtimeSocketHub.broadcastViewerPayload({ type: "public_message", message_id: message.id, message });
}

function broadcastPublicMessageDeleted(messageId: string) {
  realtimeSocketHub.broadcastViewerPayload({ type: "public_message_deleted", message_id: messageId });
}

function messageTargets(preferredDeviceId = ""): string[] {
  const ids = new Set<string>();
  if (preferredDeviceId && supportsDeviceMessages(preferredDeviceId)) ids.add(preferredDeviceId);
  for (const row of messageTargetDevices()) {
    if (row.device_id) ids.add(row.device_id);
  }
  for (const id of realtimeSocketHub.onlineMessageDeviceIds()) {
    ids.add(id);
  }
  return Array.from(ids).slice(0, 20);
}

function supportsDeviceMessages(deviceId: string): boolean {
  const online = realtimeSocketHub.onlineDeviceSupportsMessages(deviceId);
  if (online !== null) return online;
  return hasMessageTargetDevice(deviceId);
}

function deliverViewerMessage(
  targetDeviceId: string,
  viewerId: string,
  viewerName: string,
  kind: "public" | "private",
  text: string,
  messageId: string,
  createdAt: string,
  payload: Record<string, unknown> | null = null,
) {
  const payloadText = serializedMessagePayload(payload);
  const inserted = queueMessage(targetDeviceId, viewerId, text, messageId, payloadText);
  if (!inserted) {
    if (queuedMessageWasDelivered(messageId, targetDeviceId)) return "sent";
  }

  const deviceWs = realtimeSocketHub.getDeviceSocket(targetDeviceId);
  if (deviceWs) {
    const message: Record<string, unknown> = {
      type: "viewer_message",
      message_id: messageId,
      viewer_id: viewerId,
      viewer_name: viewerName,
      kind,
      text,
      created_at: createdAt,
    };
    const parsedPayload = parseMessagePayload(payloadText);
    if (parsedPayload) message.payload = parsedPayload;
    try {
      sendJson(deviceWs, message);
      markMessageDelivered(messageId, targetDeviceId);
      return "sent";
    } catch {
      realtimeSocketHub.removeDeviceById(targetDeviceId);
    }
  }
  return "queued";
}

export function deliverDeviceCommandMessage(input: {
  deviceId: string;
  commandId: string;
  requestId: string;
  text: string;
  envelope: DeviceCommandEnvelope;
}): { status: DeliveryStatus; reason: string } {
  const payloadText = serializedMessagePayload(input.envelope);
  if (!payloadText) return { status: "failed", reason: "payload_too_large" };

  const deviceWs = realtimeSocketHub.getDeviceSocket(input.deviceId);
  if (deviceWs) {
    try {
      sendJson(deviceWs, input.envelope);
      return { status: "sent", reason: "" };
    } catch {
      realtimeSocketHub.removeDeviceById(input.deviceId);
    }
  }

  queueMessage(
    input.deviceId,
    "__mcp__",
    cleanText(input.text) || "设备命令",
    input.commandId,
    payloadText,
  );
  return { status: "queued", reason: "device_socket_unavailable" };
}

function deliverQueuedMessages(deviceId: string, ws: ServerWebSocket<WsData>) {
  const rows = pendingMessages(deviceId);
  if (rows.length === 0) return;

  // Mark messages as delivered BEFORE sending to avoid race condition.
  // If send fails after marking, messages won't be resent on reconnect,
  // but this prevents the worse case of infinite redelivery loops.
  markMessagesDelivered(deviceId, rows.map((r) => r.id));

  for (const row of rows) {
    const message: Record<string, unknown> = {
      type: "viewer_message",
      message_id: row.id,
      viewer_id: row.viewer_id,
      viewer_name: row.viewer_name,
      kind: row.kind,
      text: row.text,
      created_at: row.created_at,
      queued: true,
    };
    const payload = parseMessagePayload(row.payload);
    if (payload) message.payload = payload;
    sendJson(ws, message);
  }
}

export function getWsInfo(req: Request): WsData | Response {
  const url = new URL(req.url);
  const role = url.searchParams.get("role");
  const ip = requestIp(req);
  if (!globalIpRateLimit(ip)) {
    return Response.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  if (role === "device") {
    const authorization = req.headers.get("authorization");
    const device = authenticateToken(authorization);
    if (!device) return Response.json({ error: "Unauthorized" }, { status: 401 });
    return { role: "device", id: device.device_id, device, deviceToken: extractBearerToken(authorization) };
  }

  if (role === "viewer") {
    const viewer = edgeViewerIdentity(req) || verifyViewerToken(viewerTokenFromRequest(req));
    if (!viewer) return Response.json({ error: "Viewer token required" }, { status: 403 });
    if (!viewerWsRateLimit(viewer.viewerId)) {
      return Response.json({ error: "Too many WebSocket reconnects" }, { status: 429 });
    }
    if (realtimeSocketHub.viewerSocketLimitReached()) {
      return Response.json({ error: "Too many WebSocket connections" }, { status: 503 });
    }
    return { role: "viewer", id: viewer.viewerId };
  }

  return Response.json({ error: "role must be viewer or device" }, { status: 400 });
}

export const realtimeWebSocket = {
  open(ws: ServerWebSocket<WsData>) {
    if (ws.data.role === "device") {
      realtimeSocketHub.registerDevice(ws);
      sendJson(ws, { type: "ack", status: "connected", role: "device", device_id: ws.data.id });
      deliverQueuedMessages(ws.data.id, ws);
      return;
    }
    realtimeSocketHub.registerViewer(ws.data.id, ws);
    sendJson(ws, { type: "ack", status: "connected", role: "viewer", viewer_id: ws.data.id });
  },

  pong(ws: ServerWebSocket<WsData>) {
    if (ws.data.role === "device") {
      realtimeSocketHub.markDevicePong(ws);
    }
  },

  message(ws: ServerWebSocket<WsData>, raw: string | Buffer) {
    const data = parseJson(raw);
    if (!data || typeof data.type !== "string") {
      sendJson(ws, { type: "error", error: "Invalid JSON" });
      return;
    }

    if (ws.data.role === "viewer" && data.type === "viewer_ping") {
      sendJson(ws, { type: "viewer_pong", at: new Date().toISOString() });
      return;
    }

    if (ws.data.role === "viewer" && data.type === "viewer_message") {
      const messageId = cleanMessageId(data.message_id) || crypto.randomUUID();
      if (!viewerMessageRateLimit(ws.data.id)) {
        sendJson(ws, { type: "error", message_id: messageId, error: "Rate limit exceeded" });
        return;
      }

      const targetDeviceId = cleanDeviceId(data.target_device_id);
      const text = cleanText(data.text);
      const kind = cleanKind(data.kind);
      const viewerName = cleanViewerName(data.viewer_name);
      if (!targetDeviceId || !text) {
        if (kind === "private") {
          sendJson(ws, { type: "error", message_id: messageId, error: "target_device_id and text required" });
          return;
        }
        if (!text) {
          sendJson(ws, { type: "error", message_id: messageId, error: "text required" });
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
        broadcastPublicMessage({
          id: messageId,
          device_id: "__public__",
          viewer_id: ws.data.id,
          viewer_name: viewerName,
          kind: "public",
          text,
          created_at: createdAt,
        });
        sendJson(ws, { type: "ack", message_id: messageId, status: sent > 0 ? "sent" : queued > 0 ? "queued" : "recorded", sent, queued });
        return;
      }

      if (!supportsDeviceMessages(targetDeviceId)) {
        sendJson(ws, { type: "error", message_id: messageId, error: "unsupported_target_device" });
        return;
      }
      if (isViewerBlocked(targetDeviceId, ws.data.id)) {
        sendJson(ws, { type: "error", message_id: messageId, error: "blocked_by_device" });
        return;
      }

      const createdAt = new Date().toISOString();
      recordMessage(messageId, targetDeviceId, ws.data.id, viewerName, "private", "viewer", text, createdAt);
      const status = deliverViewerMessage(targetDeviceId, ws.data.id, viewerName, "private", text, messageId, createdAt);
      const sent = status === "sent" ? 1 : 0;
      const queued = status === "queued" ? 1 : 0;
      realtimeSocketHub.sendToViewer(ws.data.id, {
        type: "viewer_message_sent",
        message_id: messageId,
        message: {
          id: messageId,
          device_id: targetDeviceId,
          viewer_id: ws.data.id,
          viewer_name: viewerName,
          kind: "private",
          text,
          created_at: createdAt,
        },
        status,
      });
      sendJson(ws, { type: "ack", message_id: messageId, status, sent, queued });
      return;
    }

    if (ws.data.role === "device" && data.type === "device_command_receipt") {
      sendJson(ws, deviceCommandReceiptWsResponse(data, ws.data.device));
      return;
    }

    if (ws.data.role === "device" && data.type === "device_command_result") {
      sendJson(ws, deviceCommandResultWsResponse(data, ws.data.device));
      return;
    }

    if (ws.data.role === "device" && data.type === "ai_request" && ws.data.device) {
      try {
        const submitted = submitAiJobFromClient(data, ws.data.device, ws.data.deviceToken || "");
        sendJson(ws, {
          type: "ai_request_ack",
          request_id: typeof data.request_id === "string" ? data.request_id : submitted.client_request_id,
          accepted: true,
          attached: submitted.attached,
          job_request_id: submitted.job.request_id,
          job: submitted.job,
        });
      } catch (e) {
        const error = aiJobInputErrorResponse(e);
        sendJson(ws, {
          type: "ai_request_ack",
          request_id: typeof data.request_id === "string" ? data.request_id : "",
          accepted: false,
          ...error.body,
        });
      }
      return;
    }

    if (ws.data.role === "device" && data.type === "device_reply") {
      const targetViewerId = typeof data.target_viewer_id === "string" ? data.target_viewer_id : "";
      const text = cleanText(data.text);
      const messageId = cleanMessageId(data.message_id);
      const replyId = cleanMessageId(data.reply_id) || crypto.randomUUID();
      const createdAt = new Date().toISOString();
      const isPublicThread = messageId ? isPublicMessageThread(messageId) : false;
      if (!text || (!isPublicThread && !targetViewerId)) {
        sendJson(ws, { type: "error", message_id: messageId, error: "target_viewer_id and text required" });
        return;
      }
      if (messageId) markMessageReplied(messageId);

      if (isPublicThread) {
        const publicReplyId = "pub_" + replyId;
        const inserted = recordMessage(publicReplyId, ws.data.id, "__public__", "up", "public_reply", "device", text, createdAt);
        if (inserted) {
          broadcastPublicMessage({
            id: publicReplyId,
            device_id: ws.data.id,
            viewer_id: "__public__",
            viewer_name: "up",
            kind: "public_reply",
            text,
            created_at: createdAt,
          });
        }
        sendJson(ws, {
          type: "ack",
          message_id: messageId,
          reply_id: publicReplyId,
          in_reply_to: messageId,
          status: "public_reply_sent",
        });
        return;
      }

      const inserted = recordMessage(replyId, ws.data.id, targetViewerId, "", "reply", "device", text, createdAt);
      if (inserted) {
        realtimeSocketHub.sendToViewer(targetViewerId, {
          type: "device_reply",
          message_id: replyId,
          in_reply_to: messageId,
          device_id: ws.data.id,
          text,
          created_at: createdAt,
        });
      }
      sendJson(ws, {
        type: "ack",
        message_id: messageId,
        reply_id: replyId,
        in_reply_to: messageId,
        status: "reply_sent",
      });

      // Web Push for offline viewer
      if (inserted) {
        import("./push").then(({ sendPush }) => {
          sendPush(targetViewerId, {
            title: "Monika 回复了",
            body: text.slice(0, 120),
            icon: "/icon-192.png",
            url: "/",
          }).catch(() => {});
        });
      }
      return;
    }

    if (ws.data.role === "device" && data.type === "device_status") {
      const statusId = cleanMessageId(data.status_id);
      // Any device_status message refreshes keepalive (proof of life)
      realtimeSocketHub.markDevicePong(ws);
      // If payload present, process as full report (WebSocket上报通道)
      if (data.payload && ws.data.device) {
        const receivedAt = new Date().toISOString();
        let publicPayload: ReturnType<typeof processReportPayload> = null;
        try {
          publicPayload = processReportPayload(data.payload, ws.data.device);
          requestSupervisionCheckFromReportPayload(data.payload, ws.data.device);
          syncSupervisionPolicyForReportedDevice(ws.data.id);
        } catch (e: any) {
          if (e instanceof ReportPayloadError) {
            sendJson(ws, { type: "error", error: e.code, message: e.message });
            return;
          }
          console.error("[ws] device_status processing error:", e.message);
          sendJson(ws, { type: "error", error: "status_processing_failed" });
          return;
        }
        // Broadcast only the sanitized public fields. Raw window titles stay server-side.
        if (publicPayload) {
          realtimeSocketHub.broadcastViewerPayload({
            type: "device_update",
            device_id: ws.data.device.device_id,
            payload: publicPayload,
            timestamp: receivedAt,
          });
        }
      }
      sendJson(ws, {
        type: "ack",
        status: "status_received",
        ...(statusId ? { status_id: statusId } : {}),
      });
      return;
    }

    sendJson(ws, { type: "error", error: "Unsupported message type" });
  },

  close(ws: ServerWebSocket<WsData>) {
    if (ws.data.role === "device") {
      realtimeSocketHub.removeDevice(ws);
      // Immediately mark device offline so dashboard reflects disconnection
      try { markDeviceOffline.run(ws.data.id); } catch { /* ignore */ }
    } else {
      realtimeSocketHub.removeViewer(ws.data.id, ws);
    }
  },
};

function syncSupervisionPolicyForReportedDevice(deviceId: string): void {
  void import("./supervision-policy-control")
    .then(({ syncCurrentSupervisionPolicyForDevice }) => {
      syncCurrentSupervisionPolicyForDevice(deviceId);
    })
    .catch((e) => {
      console.error("[ws] supervision policy sync failed:", e instanceof Error ? e.message : "sync failed");
    });
}

export function handleDeviceMessages(req: Request): Response {
  const device = authenticateToken(req.headers.get("authorization"));
  if (!device) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const rows = pendingMessages(device.device_id);
  if (rows.length > 0) {
    markMessagesDelivered(device.device_id, rows.map((r) => r.id));
  }
  return Response.json({
    messages: rows.map((row) => {
      const message: Record<string, unknown> = {
        id: row.id,
        viewer_id: row.viewer_id,
        viewer_name: row.viewer_name,
        kind: row.kind,
        text: row.text,
        created_at: row.created_at,
      };
      const payload = parseMessagePayload(row.payload);
      if (payload) message.payload = payload;
      return message;
    }),
  });
}

export function handleDeviceMessageHistory(req: Request): Response {
  const device = authenticateToken(req.headers.get("authorization"));
  if (!device) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const since = url.searchParams.get("since") || "";
  const safeSince = since && !isNaN(new Date(since).getTime()) ? new Date(since).toISOString() : "";
  const rows = deviceMessageHistory(device.device_id, safeSince);
  return Response.json({ messages: rows });
}

export function handleViewerMessageHistory(req: Request): Response {
  const viewer = edgeViewerIdentity(req) || verifyViewerToken(viewerTokenFromRequest(req));
  if (!viewer) return Response.json({ error: "Viewer token required" }, { status: 403 });
  if (!viewerTokenRateLimit(viewer.viewerId)) return Response.json({ error: "Rate limit exceeded" }, { status: 429 });

  const url = new URL(req.url);
  const sinceParam = url.searchParams.get("since") || "";
  const since = sinceParam && !isNaN(new Date(sinceParam).getTime())
    ? new Date(sinceParam).toISOString()
    : new Date(Date.now() - 86400000).toISOString();
  const rows = viewerMessageHistory(viewer.viewerId, since);
  return noStore(Response.json({ messages: rows, since }), ["viewer-history", `viewer-${viewer.viewerId}`]);
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
  const isPublicThread = messageId ? isPublicMessageThread(messageId) : false;
  if (!text || (!isPublicThread && !viewerId)) {
    return Response.json({ error: "target_viewer_id and text required" }, { status: 400 });
  }

  if (messageId) markMessageReplied(messageId);
  const replyId = cleanMessageId(body.reply_id) || crypto.randomUUID();
  const createdAt = new Date().toISOString();

  if (isPublicThread) {
    const publicReplyId = "pub_" + replyId;
    const inserted = recordMessage(publicReplyId, device.device_id, "__public__", "up", "public_reply", "device", text, createdAt);
    if (inserted) {
      broadcastPublicMessage({
        id: publicReplyId,
        device_id: device.device_id,
        viewer_id: "__public__",
        viewer_name: "up",
        kind: "public_reply",
        text,
        created_at: createdAt,
      });
    }
    return Response.json({
      ok: true,
      public: true,
      message_id: publicReplyId,
      reply_id: publicReplyId,
      in_reply_to: messageId,
      duplicate: !inserted,
    });
  }

  const inserted = recordMessage(replyId, device.device_id, viewerId, "", "reply", "device", text, createdAt);
  const delivered = inserted
    ? realtimeSocketHub.sendToViewer(viewerId, {
      type: "device_reply",
      message_id: replyId,
      in_reply_to: messageId,
      device_id: device.device_id,
      text,
      created_at: createdAt,
    })
    : 0;

  // Web Push notification for offline viewers
  if (inserted) {
    import("./push").then(({ sendPush }) => {
      sendPush(viewerId, {
        title: "Monika 回复了",
        body: text.slice(0, 120),
        icon: "/icon-192.png",
        url: "/",
      }).catch(() => {});
    });
  }

  return Response.json({
    ok: true,
    message_id: replyId,
    reply_id: replyId,
    in_reply_to: messageId,
    duplicate: !inserted,
    delivered: delivered > 0,
    delivered_sockets: delivered,
  });
}

export async function handlePublicMessagePost(req: Request): Promise<Response> {
  const viewer = edgeViewerIdentity(req) || verifyViewerToken(viewerTokenFromRequest(req));
  if (!viewer) return Response.json({ error: "Viewer token required" }, { status: 403 });
  if (!viewerTokenRateLimit(viewer.viewerId) || !realtimeApiRateLimit(viewer.viewerId)) {
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

  broadcastPublicMessage({
    id: messageId,
    device_id: "__public__",
    viewer_id: viewer.viewerId,
    viewer_name: viewerName,
    kind: "public",
    text,
    created_at: createdAt,
  });

  return Response.json({ ok: true, message_id: messageId, sent, queued });
}

export async function handlePrivateMessagePost(req: Request): Promise<Response> {
  const viewer = edgeViewerIdentity(req) || verifyViewerToken(viewerTokenFromRequest(req));
  if (!viewer) return Response.json({ error: "Viewer token required" }, { status: 403 });
  if (!viewerTokenRateLimit(viewer.viewerId) || !realtimeApiRateLimit(viewer.viewerId)) {
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
  if (!supportsDeviceMessages(targetDeviceId)) {
    return Response.json({ error: "unsupported_target_device", message_id: messageId }, { status: 404 });
  }
  if (isViewerBlocked(targetDeviceId, viewer.viewerId)) {
    return Response.json({ error: "blocked_by_device", message_id: messageId }, { status: 403 });
  }

  const createdAt = new Date().toISOString();
  recordMessage(messageId, targetDeviceId, viewer.viewerId, viewerName, "private", "viewer", text, createdAt);
  const status = deliverViewerMessage(targetDeviceId, viewer.viewerId, viewerName, "private", text, messageId, createdAt);
  realtimeSocketHub.sendToViewer(viewer.viewerId, {
    type: "viewer_message_sent",
    message_id: messageId,
    message: {
      id: messageId,
      device_id: targetDeviceId,
      viewer_id: viewer.viewerId,
      viewer_name: viewerName,
      kind: "private",
      text,
      created_at: createdAt,
    },
    status,
  });
  return Response.json({ ok: true, message_id: messageId, status });
}

export function handlePublicMessages(req: Request): Response {
  // 管理员设备 token 鉴权（抗 DoS/CC，边缘函数模式也生效）
  const device = authenticateToken(req.headers.get("authorization"));
  if (device) {
    if (!realtimeApiRateLimit(device.device_id)) return Response.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const viewer = edgeViewerIdentity(req) || verifyViewerToken(viewerTokenFromRequest(req));
  if (viewer) {
    if (!viewerTokenRateLimit(viewer.viewerId)) return Response.json({ error: "Rate limit exceeded" }, { status: 429 });
    if (!realtimeApiRateLimit(viewer.viewerId)) return Response.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const url = new URL(req.url);
  const recentParam = url.searchParams.get("recent");
  if (recentParam === "1" || recentParam === "true") {
    const hours = publicRecentHours(url.searchParams.get("hours"));
    const since = new Date(Date.now() - hours * 60 * 60_000).toISOString();
    const rows = recentPublicMessages(since);
    return noStore(Response.json({ recent: true, hours, messages: rows }), ["public-messages", "public-messages-recent"]);
  }

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
    const rows = publicMessagesByWindow(start.toISOString(), end.toISOString());
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
  const rows = publicMessagesByWindow(start.toISOString(), end.toISOString());
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

  blockViewer(device.device_id, viewerId);
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

  unblockViewer(device.device_id, viewerId);
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

  const { existing, deleted } = deleteMessageForDevice(messageId, device.device_id);
  if (!existing) return Response.json({ ok: true, deleted: false });

  if (deleted) {
    if (existing.kind === "public" || existing.kind === "public_reply") {
      broadcastPublicMessageDeleted(messageId);
    } else if (existing.viewer_id) {
      realtimeSocketHub.sendToViewer(existing.viewer_id, {
        type: "message_deleted",
        message_id: messageId,
        device_id: existing.device_id,
      });
    }
  }
  return Response.json({ ok: true, deleted });
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

  const deleted = deleteViewerMessagesForDevice(device.device_id, viewerId);
  if (deleted > 0) {
    realtimeSocketHub.sendToViewer(viewerId, {
      type: "viewer_messages_deleted",
      device_id: device.device_id,
    });
  }
  return Response.json({ ok: true, deleted });
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

  setViewerRemark(device.device_id, viewerId, remark);
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
  realtimeSocketHub.closeDevice(device.device_id, 4003, "device_deleted");

  // 2. 删除数据库记录
  deleteDeviceActivities.run(device.device_id);
  deleteDevice.run(device.device_id);

  return Response.json({ ok: true, deleted: device.device_id });
}

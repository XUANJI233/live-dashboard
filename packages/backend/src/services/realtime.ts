import { db } from "../db";
import { authenticateToken, extractBearerToken } from "../middleware/auth";
import { verifyViewerToken, viewerTokenFromRequest, edgeViewerIdentity } from "./viewer-auth";
import { processReportPayload, ReportPayloadError } from "./device-status-handler";
import { requestSupervisionCheckFromReportPayload } from "./supervision-report-trigger";
import { deviceCommandReceiptWsResponse, deviceCommandResultWsResponse } from "./supervision-ack";
import { aiJobInputErrorResponse, setAiJobNotifier, submitAiJobFromClient } from "./ai-jobs";
import { realtimeSocketHub, sendJson } from "./realtime-socket-hub";
import {
  broadcastPublicMessage,
  deliverQueuedMessages,
  deliverViewerMessage,
  messageTargets,
  supportsDeviceMessages,
} from "./realtime-message-delivery";
import {
  globalIpRateLimit,
  requestIp,
  viewerMessageRateLimit,
  viewerWsRateLimit,
} from "./realtime-rate-limit";
import {
  isPublicMessageThread,
  isViewerBlocked,
  markMessageReplied,
  recordMessage,
} from "./realtime-message-store";
import {
  cleanDeviceId,
  cleanKind,
  cleanMessageId,
  cleanText,
  cleanViewerName,
  parseJson,
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

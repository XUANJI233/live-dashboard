import type { ServerWebSocket } from "bun";
import { processReportPayload, ReportPayloadError } from "./device-status-handler";
import { requestSupervisionCheckFromReportPayload } from "./supervision-report-trigger";
import { deviceCommandReceiptWsResponse, deviceCommandResultWsResponse } from "./supervision-ack";
import { aiJobInputErrorResponse, submitAiJobFromClient } from "./ai-jobs";
import { realtimeSocketHub, sendJson } from "./realtime-socket-hub";
import {
  broadcastPublicMessage,
  deliverViewerMessage,
  messageTargets,
  supportsDeviceMessages,
} from "./realtime-message-delivery";
import { viewerMessageRateLimit } from "./realtime-rate-limit";
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

export function handleRealtimeWsMessage(ws: ServerWebSocket<WsData>, raw: string | Buffer): void {
  const data = parseJson(raw);
  if (!data || typeof data.type !== "string") {
    sendJson(ws, { type: "error", error: "Invalid JSON" });
    return;
  }

  if (ws.data.role === "viewer") {
    handleViewerWsMessage(ws, data);
    return;
  }

  handleDeviceWsMessage(ws, data);
}

function handleViewerWsMessage(ws: ServerWebSocket<WsData>, data: Record<string, unknown>): void {
  if (data.type === "viewer_ping") {
    sendJson(ws, { type: "viewer_pong", at: new Date().toISOString() });
    return;
  }

  if (data.type === "viewer_message") {
    handleViewerMessage(ws, data);
    return;
  }

  sendJson(ws, { type: "error", error: "Unsupported message type" });
}

function handleViewerMessage(ws: ServerWebSocket<WsData>, data: Record<string, unknown>): void {
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
    handlePublicViewerMessage(ws, { messageId, targetDeviceId, viewerName, text });
    return;
  }

  handlePrivateViewerMessage(ws, { messageId, targetDeviceId, viewerName, text });
}

function handlePublicViewerMessage(
  ws: ServerWebSocket<WsData>,
  input: { messageId: string; targetDeviceId: string; viewerName: string; text: string },
): void {
  const createdAt = new Date().toISOString();
  const targets = messageTargets(input.targetDeviceId)
    .filter((deviceId) => !isViewerBlocked(deviceId, ws.data.id));
  recordMessage(input.messageId, "__public__", ws.data.id, input.viewerName, "public", "viewer", input.text, createdAt);

  let sent = 0;
  let queued = 0;
  for (const deviceId of targets) {
    const status = deliverViewerMessage(
      deviceId,
      ws.data.id,
      input.viewerName,
      "public",
      input.text,
      input.messageId,
      createdAt,
    );
    if (status === "sent") sent += 1;
    else queued += 1;
  }

  broadcastPublicMessage({
    id: input.messageId,
    device_id: "__public__",
    viewer_id: ws.data.id,
    viewer_name: input.viewerName,
    kind: "public",
    text: input.text,
    created_at: createdAt,
  });
  sendJson(ws, {
    type: "ack",
    message_id: input.messageId,
    status: sent > 0 ? "sent" : queued > 0 ? "queued" : "recorded",
    sent,
    queued,
  });
}

function handlePrivateViewerMessage(
  ws: ServerWebSocket<WsData>,
  input: { messageId: string; targetDeviceId: string; viewerName: string; text: string },
): void {
  if (!supportsDeviceMessages(input.targetDeviceId)) {
    sendJson(ws, { type: "error", message_id: input.messageId, error: "unsupported_target_device" });
    return;
  }
  if (isViewerBlocked(input.targetDeviceId, ws.data.id)) {
    sendJson(ws, { type: "error", message_id: input.messageId, error: "blocked_by_device" });
    return;
  }

  const createdAt = new Date().toISOString();
  recordMessage(input.messageId, input.targetDeviceId, ws.data.id, input.viewerName, "private", "viewer", input.text, createdAt);
  const status = deliverViewerMessage(
    input.targetDeviceId,
    ws.data.id,
    input.viewerName,
    "private",
    input.text,
    input.messageId,
    createdAt,
  );
  const sent = status === "sent" ? 1 : 0;
  const queued = status === "queued" ? 1 : 0;
  realtimeSocketHub.sendToViewer(ws.data.id, {
    type: "viewer_message_sent",
    message_id: input.messageId,
    message: {
      id: input.messageId,
      device_id: input.targetDeviceId,
      viewer_id: ws.data.id,
      viewer_name: input.viewerName,
      kind: "private",
      text: input.text,
      created_at: createdAt,
    },
    status,
  });
  sendJson(ws, { type: "ack", message_id: input.messageId, status, sent, queued });
}

function handleDeviceWsMessage(ws: ServerWebSocket<WsData>, data: Record<string, unknown>): void {
  if (data.type === "device_command_receipt") {
    sendJson(ws, deviceCommandReceiptWsResponse(data, ws.data.device));
    return;
  }

  if (data.type === "device_command_result") {
    sendJson(ws, deviceCommandResultWsResponse(data, ws.data.device));
    return;
  }

  if (data.type === "ai_request" && ws.data.device) {
    handleDeviceAiRequest(ws, data, ws.data.device);
    return;
  }

  if (data.type === "device_reply") {
    handleDeviceReply(ws, data);
    return;
  }

  if (data.type === "device_status") {
    handleDeviceStatus(ws, data);
    return;
  }

  sendJson(ws, { type: "error", error: "Unsupported message type" });
}

function handleDeviceAiRequest(
  ws: ServerWebSocket<WsData>,
  data: Record<string, unknown>,
  device: NonNullable<WsData["device"]>,
): void {
  try {
    const submitted = submitAiJobFromClient(data, device, ws.data.deviceToken || "");
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
}

function handleDeviceReply(ws: ServerWebSocket<WsData>, data: Record<string, unknown>): void {
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
    handlePublicDeviceReply(ws, { messageId, replyId, text, createdAt });
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

  if (inserted) {
    sendReplyPush(targetViewerId, text);
  }
}

function handlePublicDeviceReply(
  ws: ServerWebSocket<WsData>,
  input: { messageId: string; replyId: string; text: string; createdAt: string },
): void {
  const publicReplyId = "pub_" + input.replyId;
  const inserted = recordMessage(publicReplyId, ws.data.id, "__public__", "up", "public_reply", "device", input.text, input.createdAt);
  if (inserted) {
    broadcastPublicMessage({
      id: publicReplyId,
      device_id: ws.data.id,
      viewer_id: "__public__",
      viewer_name: "up",
      kind: "public_reply",
      text: input.text,
      created_at: input.createdAt,
    });
  }
  sendJson(ws, {
    type: "ack",
    message_id: input.messageId,
    reply_id: publicReplyId,
    in_reply_to: input.messageId,
    status: "public_reply_sent",
  });
}

function handleDeviceStatus(ws: ServerWebSocket<WsData>, data: Record<string, unknown>): void {
  const statusId = cleanMessageId(data.status_id);
  realtimeSocketHub.markDevicePong(ws);

  const payload = objectRecordOrNull(data.payload);
  if (payload && ws.data.device) {
    const receivedAt = new Date().toISOString();
    let publicPayload: ReturnType<typeof processReportPayload> = null;
    try {
      publicPayload = processReportPayload(payload, ws.data.device);
      requestSupervisionCheckFromReportPayload(payload, ws.data.device);
      syncSupervisionPolicyForReportedDevice(ws.data.id);
    } catch (e) {
      if (e instanceof ReportPayloadError) {
        sendJson(ws, { type: "error", error: e.code, message: e.message });
        return;
      }
      console.error("[ws] device_status processing error:", e instanceof Error ? e.message : "status processing failed");
      sendJson(ws, { type: "error", error: "status_processing_failed" });
      return;
    }
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
}

function sendReplyPush(targetViewerId: string, text: string): void {
  import("./push").then(({ sendPush }) => {
    sendPush(targetViewerId, {
      title: "Monika 回复了",
      body: text.slice(0, 120),
      icon: "/icon-192.png",
      url: "/",
    }).catch(() => {});
  });
}

function syncSupervisionPolicyForReportedDevice(deviceId: string): void {
  void import("./supervision-policy-control")
    .then(({ syncCurrentSupervisionPolicyForDevice }) => {
      syncCurrentSupervisionPolicyForDevice(deviceId);
    })
    .catch((e) => {
      console.error("[ws] supervision policy sync failed:", e instanceof Error ? e.message : "sync failed");
    });
}

function objectRecordOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

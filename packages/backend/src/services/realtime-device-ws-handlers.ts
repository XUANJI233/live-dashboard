import type { ServerWebSocket } from "bun";
import { processReportPayload, ReportPayloadError } from "./device-status-handler";
import { requestSupervisionCheckFromReportPayload } from "./supervision-report-trigger";
import { deviceCommandReceiptWsResponse, deviceCommandResultWsResponse } from "./supervision-ack";
import { aiJobInputErrorResponse, submitAiJobFromClient } from "./ai-jobs";
import { postDeviceReply } from "./realtime-message-actions";
import { realtimeSocketHub, sendJson } from "./realtime-socket-hub";
import {
  cleanMessageId,
  cleanText,
} from "./message-protocol";
import type { WsData } from "./realtime-types";

export function handleDeviceWsMessage(ws: ServerWebSocket<WsData>, data: Record<string, unknown>): void {
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
  const result = postDeviceReply({
    deviceId: ws.data.id,
    targetViewerId,
    messageId,
    replyId,
    text,
  });
  if (!result.ok) {
    sendJson(ws, { type: "error", message_id: messageId, error: "target_viewer_id and text required" });
    return;
  }

  if (result.kind === "public") {
    sendJson(ws, {
      type: "ack",
      message_id: result.inReplyTo,
      reply_id: result.replyId,
      in_reply_to: result.inReplyTo,
      status: "public_reply_sent",
    });
    return;
  }

  sendJson(ws, {
    type: "ack",
    message_id: result.inReplyTo,
    reply_id: result.replyId,
    in_reply_to: result.inReplyTo,
    status: "reply_sent",
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

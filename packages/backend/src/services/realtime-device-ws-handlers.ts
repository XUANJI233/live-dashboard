import type { ServerWebSocket } from "bun";
import { deviceCommandReceiptWsResponse, deviceCommandResultWsResponse } from "./supervision-ack";
import { aiJobInputErrorResponse, submitAiJobFromClient } from "./ai-jobs";
import { postDeviceReply } from "./realtime-device-reply-actions";
import { handleDeviceStatusWsMessage } from "./realtime-device-status-ws-handler";
import { sendJson } from "./realtime-socket-hub";
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
    handleDeviceStatusWsMessage(ws, data);
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

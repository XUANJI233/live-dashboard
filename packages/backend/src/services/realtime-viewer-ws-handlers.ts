import type { ServerWebSocket } from "bun";
import {
  postPrivateViewerMessage,
  postPublicViewerMessage,
} from "./realtime-message-actions";
import { sendJson } from "./realtime-socket-hub";
import { viewerMessageRateLimit } from "./realtime-rate-limit";
import {
  cleanDeviceId,
  cleanKind,
  cleanMessageId,
  cleanText,
  cleanViewerName,
} from "./message-protocol";
import type { WsData } from "./realtime-types";

export function handleViewerWsMessage(ws: ServerWebSocket<WsData>, data: Record<string, unknown>): void {
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
  const result = postPublicViewerMessage({
    preferredDeviceId: input.targetDeviceId,
    viewerId: ws.data.id,
    viewerName: input.viewerName,
    messageId: input.messageId,
    text: input.text,
  });
  sendJson(ws, {
    type: "ack",
    message_id: result.message.id,
    status: result.status,
    sent: result.sent,
    queued: result.queued,
  });
}

function handlePrivateViewerMessage(
  ws: ServerWebSocket<WsData>,
  input: { messageId: string; targetDeviceId: string; viewerName: string; text: string },
): void {
  const result = postPrivateViewerMessage({
    targetDeviceId: input.targetDeviceId,
    viewerId: ws.data.id,
    viewerName: input.viewerName,
    messageId: input.messageId,
    text: input.text,
  });
  if (!result.ok) {
    sendJson(ws, { type: "error", message_id: input.messageId, error: result.error });
    return;
  }

  sendJson(ws, {
    type: "ack",
    message_id: result.message.id,
    status: result.status,
    sent: result.sent,
    queued: result.queued,
  });
}

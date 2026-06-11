import type { ServerWebSocket } from "bun";
import type { DeviceCommandEnvelope, DeliveryStatus } from "./mcp-contracts";
import {
  hasMessageTargetDevice,
  messageTargetDevices,
} from "./realtime-message-store";
import {
  markMessageDelivered,
  markMessagesDelivered,
  pendingMessages,
  queueMessage,
  queuedMessageWasDelivered,
} from "./realtime-message-queue-store";
import { cleanText, parseMessagePayload, serializedMessagePayload } from "./message-protocol";
import { realtimeSocketHub, sendJson } from "./realtime-socket-hub";
import type { WsData } from "./realtime-types";

export interface PublicRealtimeMessage {
  id: string;
  device_id: string;
  viewer_id: string;
  viewer_name: string;
  kind: "public" | "public_reply";
  text: string;
  created_at: string;
}

export type ViewerMessageDeliveryStatus = "sent" | "queued";

export function broadcastPublicMessage(message: PublicRealtimeMessage): void {
  realtimeSocketHub.broadcastViewerPayload({ type: "public_message", message_id: message.id, message });
}

export function broadcastPublicMessageDeleted(messageId: string): void {
  realtimeSocketHub.broadcastViewerPayload({ type: "public_message_deleted", message_id: messageId });
}

export function messageTargets(preferredDeviceId = ""): string[] {
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

export function supportsDeviceMessages(deviceId: string): boolean {
  const online = realtimeSocketHub.onlineDeviceSupportsMessages(deviceId);
  if (online !== null) return online;
  return hasMessageTargetDevice(deviceId);
}

export function deliverViewerMessage(
  targetDeviceId: string,
  viewerId: string,
  viewerName: string,
  kind: "public" | "private",
  text: string,
  messageId: string,
  createdAt: string,
  payload: Record<string, unknown> | null = null,
): ViewerMessageDeliveryStatus {
  const payloadText = serializedMessagePayload(payload);
  const inserted = queueMessage(targetDeviceId, viewerId, text, messageId, payloadText);
  if (!inserted && queuedMessageWasDelivered(messageId, targetDeviceId)) return "sent";

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

export function deliverQueuedMessages(deviceId: string, ws: ServerWebSocket<WsData>): void {
  const rows = pendingMessages(deviceId);
  if (rows.length === 0) return;

  // Mark before sending to avoid reconnect loops if a socket drops mid-flush.
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

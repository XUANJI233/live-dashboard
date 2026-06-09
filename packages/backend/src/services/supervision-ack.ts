import type { DeviceInfo } from "../types";

const MAX_ACK_ID_LENGTH = 120;
const MAX_ACK_FIELD_LENGTH = 240;

export interface SupervisionAckReceipt {
  ack_id: string;
  received: boolean;
  error?: string;
}

export function supervisionAckWsResponse(message: unknown, device?: DeviceInfo): Record<string, unknown> {
  const receipt = receiveSupervisionAck(message, device);
  return {
    type: "supervision_ack_received",
    ack_id: receipt.ack_id,
    received: receipt.received,
    ...(receipt.error ? { error: receipt.error } : {}),
  };
}

export function receiveSupervisionAck(message: unknown, device?: DeviceInfo): SupervisionAckReceipt {
  const ack = extractAckObject(message);
  if (!ack) return { ack_id: "", received: false, error: "invalid_ack" };

  const ackId = cleanAckId(ack.ack_id);
  if (!ackId) return { ack_id: "", received: false, error: "ack_id_required" };

  console.log("[supervision] ack received", {
    device_id: device?.device_id ?? "",
    ack_id: ackId,
    alert_id: cleanField(ack.alert_id),
    action: cleanField(ack.action),
    status: cleanField(ack.status),
    source: cleanField(ack.source),
  });
  return { ack_id: ackId, received: true };
}

function extractAckObject(message: unknown): Record<string, unknown> | null {
  if (!message || typeof message !== "object" || Array.isArray(message)) return null;
  const body = message as Record<string, unknown>;
  const payload = body.payload;
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    return payload as Record<string, unknown>;
  }
  return body;
}

function cleanAckId(value: unknown): string {
  if (typeof value !== "string") return "";
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, MAX_ACK_ID_LENGTH);
  return /^[a-zA-Z0-9_.:-]{1,120}$/.test(cleaned) ? cleaned : "";
}

function cleanField(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_ACK_FIELD_LENGTH);
}

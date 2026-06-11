import type { ServerWebSocket } from "bun";
import { processReportPayload, ReportPayloadError } from "./device-status-handler";
import { cleanMessageId } from "./message-protocol";
import { realtimeSocketHub, sendJson } from "./realtime-socket-hub";
import type { WsData } from "./realtime-types";
import { requestSupervisionCheckFromReportPayload } from "./supervision-report-trigger";

export function handleDeviceStatusWsMessage(
  ws: ServerWebSocket<WsData>,
  data: Record<string, unknown>,
): void {
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

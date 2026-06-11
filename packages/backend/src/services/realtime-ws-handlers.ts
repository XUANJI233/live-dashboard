import type { ServerWebSocket } from "bun";
import { sendJson } from "./realtime-socket-hub";
import { parseJson } from "./message-protocol";
import { handleDeviceWsMessage } from "./realtime-device-ws-handlers";
import { handleViewerWsMessage } from "./realtime-viewer-ws-handlers";
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

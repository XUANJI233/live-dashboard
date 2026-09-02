import { authenticateToken, extractBearerToken } from "../middleware/auth";
import { verifyViewerToken, viewerTokenFromRequest, edgeViewerIdentity } from "./viewer-auth";
import { setAiJobNotifier } from "./ai-jobs";
import { realtimeSocketHub, sendJson } from "./realtime-socket-hub";
import { deliverQueuedMessages } from "./realtime-message-delivery";
import {
  globalIpRateLimit,
  requestIp,
  viewerWsRateLimit,
} from "./realtime-rate-limit";
import { handleRealtimeWsMessage } from "./realtime-ws-handlers";
import type { WsData } from "./realtime-types";
import type { ServerWebSocket } from "bun";
import { markAndroidIntegrationOffline } from "./android-integration-control";

export type { WsData } from "./realtime-types";

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

  if (role === "integration") {
    const authorization = req.headers.get("authorization");
    const device = authenticateToken(authorization);
    if (!device || device.platform !== "android") {
      return Response.json({ error: "Android device token required" }, { status: 401 });
    }
    return { role: "integration", id: device.device_id, device, deviceToken: extractBearerToken(authorization) };
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

  return Response.json({ error: "role must be viewer, device, or integration" }, { status: 400 });
}

export const realtimeWebSocket = {
  open(ws: ServerWebSocket<WsData>) {
    if (ws.data.role === "device") {
      realtimeSocketHub.registerDevice(ws);
      sendJson(ws, { type: "ack", status: "connected", role: "device", device_id: ws.data.id });
      deliverQueuedMessages(ws.data.id, ws);
      return;
    }
    if (ws.data.role === "integration") {
      realtimeSocketHub.registerIntegration(ws);
      sendJson(ws, { type: "ack", v: 1, status: "connected", role: "integration", device_id: ws.data.id });
      sendJson(ws, { type: "integration_status_request", v: 1 });
      return;
    }
    realtimeSocketHub.registerViewer(ws.data.id, ws);
    sendJson(ws, { type: "ack", status: "connected", role: "viewer", viewer_id: ws.data.id });
  },

  pong(ws: ServerWebSocket<WsData>) {
    if (ws.data.role === "device") {
      realtimeSocketHub.markDevicePong(ws);
    }
    if (ws.data.role === "integration") realtimeSocketHub.markIntegrationPong(ws);
  },

  message(ws: ServerWebSocket<WsData>, raw: string | Buffer) {
    handleRealtimeWsMessage(ws, raw);
  },

  close(ws: ServerWebSocket<WsData>) {
    if (ws.data.role === "device") {
      if (realtimeSocketHub.getDeviceSocket(ws.data.id) !== ws) return;
      realtimeSocketHub.removeDevice(ws);
      // Keep the database state online during the heartbeat grace period. The
      // scheduled timeout owns the eventual offline transition and durable
      // controller event, so a quick reconnect cannot masquerade as a timeout.
    } else if (ws.data.role === "integration") {
      if (realtimeSocketHub.getIntegrationSocket(ws.data.id) !== ws) return;
      realtimeSocketHub.removeIntegration(ws);
      markAndroidIntegrationOffline(ws.data.id);
    } else {
      realtimeSocketHub.removeViewer(ws.data.id, ws);
    }
  },
};

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

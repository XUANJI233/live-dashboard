import { authenticateToken } from "../middleware/auth";
import { currentHourWindow, currentMessageSlot, noStore, withCdnHeaders } from "./cdn";
import {
  deviceMessageHistory,
  publicMessagesByWindow,
  recentPublicMessages,
  viewerMessageHistory,
} from "./realtime-message-store";
import {
  markMessagesDelivered,
  pendingMessages,
} from "./realtime-message-queue-store";
import { realtimeApiRateLimit } from "./realtime-rate-limit";
import { parseMessagePayload, publicRecentHours } from "./message-protocol";
import { edgeViewerIdentity, verifyViewerToken, viewerTokenFromRequest, viewerTokenRateLimit } from "./viewer-auth";

export function handleDeviceMessages(req: Request): Response {
  const device = authenticateToken(req.headers.get("authorization"));
  if (!device) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const rows = pendingMessages(device.device_id);
  if (rows.length > 0) {
    markMessagesDelivered(device.device_id, rows.map((r) => r.id));
  }
  return Response.json({
    messages: rows.map((row) => {
      const message: Record<string, unknown> = {
        id: row.id,
        viewer_id: row.viewer_id,
        viewer_name: row.viewer_name,
        kind: row.kind,
        text: row.text,
        created_at: row.created_at,
      };
      const payload = parseMessagePayload(row.payload);
      if (payload) message.payload = payload;
      return message;
    }),
  });
}

export function handleDeviceMessageHistory(req: Request): Response {
  const device = authenticateToken(req.headers.get("authorization"));
  if (!device) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const since = url.searchParams.get("since") || "";
  const safeSince = since && !isNaN(new Date(since).getTime()) ? new Date(since).toISOString() : "";
  const rows = deviceMessageHistory(device.device_id, safeSince);
  return Response.json({ messages: rows });
}

export function handleViewerMessageHistory(req: Request): Response {
  const viewer = edgeViewerIdentity(req) || verifyViewerToken(viewerTokenFromRequest(req));
  if (!viewer) return Response.json({ error: "Viewer token required" }, { status: 403 });
  if (!viewerTokenRateLimit(viewer.viewerId)) return Response.json({ error: "Rate limit exceeded" }, { status: 429 });

  const url = new URL(req.url);
  const sinceParam = url.searchParams.get("since") || "";
  const since = sinceParam && !isNaN(new Date(sinceParam).getTime())
    ? new Date(sinceParam).toISOString()
    : new Date(Date.now() - 86400000).toISOString();
  const rows = viewerMessageHistory(viewer.viewerId, since);
  return noStore(Response.json({ messages: rows, since }), ["viewer-history", `viewer-${viewer.viewerId}`]);
}

export function handlePublicMessages(req: Request): Response {
  const device = authenticateToken(req.headers.get("authorization"));
  if (device) {
    if (!realtimeApiRateLimit(device.device_id)) return Response.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const viewer = edgeViewerIdentity(req) || verifyViewerToken(viewerTokenFromRequest(req));
  if (viewer) {
    if (!viewerTokenRateLimit(viewer.viewerId)) return Response.json({ error: "Rate limit exceeded" }, { status: 429 });
    if (!realtimeApiRateLimit(viewer.viewerId)) return Response.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const url = new URL(req.url);
  const recentParam = url.searchParams.get("recent");
  if (recentParam === "1" || recentParam === "true") {
    const hours = publicRecentHours(url.searchParams.get("hours"));
    const since = new Date(Date.now() - hours * 60 * 60_000).toISOString();
    const rows = recentPublicMessages(since);
    return noStore(Response.json({ recent: true, hours, messages: rows }), ["public-messages", "public-messages-recent"]);
  }

  const slotParam = url.searchParams.get("slot");
  if (slotParam) {
    if (!/^\d{12}$/.test(slotParam)) {
      return Response.json({ error: "slot must be YYYYMMDDHHmm" }, { status: 400 });
    }
    const year = Number(slotParam.slice(0, 4));
    const month = Number(slotParam.slice(4, 6)) - 1;
    const day = Number(slotParam.slice(6, 8));
    const hour = Number(slotParam.slice(8, 10));
    const minute = Number(slotParam.slice(10, 12));
    const start = new Date(Date.UTC(year, month, day, hour, minute));
    if (isNaN(start.getTime())) return Response.json({ error: "invalid slot" }, { status: 400 });
    const end = new Date(start.getTime() + 10 * 60_000);
    const rows = publicMessagesByWindow(start.toISOString(), end.toISOString());
    const currentSlot = slotParam === currentMessageSlot();
    const response = Response.json({ slot: slotParam, messages: rows });
    if (currentSlot) return noStore(response, ["public-messages", `public-messages-slot-${slotParam}`]);
    return withCdnHeaders(
      response,
      ["public-messages", `public-messages-slot-${slotParam}`],
      60 * 60 * 24 * 30,
    );
  }

  const windowParam = url.searchParams.get("window") || currentHourWindow();
  if (!/^\d{10}$/.test(windowParam)) {
    return Response.json({ error: "window must be YYYYMMDDHH" }, { status: 400 });
  }

  const year = Number(windowParam.slice(0, 4));
  const month = Number(windowParam.slice(4, 6)) - 1;
  const day = Number(windowParam.slice(6, 8));
  const hour = Number(windowParam.slice(8, 10));
  const start = new Date(Date.UTC(year, month, day, hour));
  if (isNaN(start.getTime())) return Response.json({ error: "invalid window" }, { status: 400 });
  const end = new Date(start.getTime() + 60 * 60_000);
  const rows = publicMessagesByWindow(start.toISOString(), end.toISOString());
  const currentWindow = windowParam === currentHourWindow();
  const response = Response.json({ window: windowParam, messages: rows });
  if (currentWindow) return noStore(response, ["public-messages", `public-messages-${windowParam}`]);
  return withCdnHeaders(
    response,
    ["public-messages", `public-messages-${windowParam}`],
    60 * 60 * 24 * 30,
  );
}

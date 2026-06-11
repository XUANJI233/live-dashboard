import { authenticateToken } from "../middleware/auth";
import { currentHourWindow, currentMessageSlot, noStore, withCdnHeaders } from "./cdn";
import {
  broadcastPublicMessage,
  broadcastPublicMessageDeleted,
  deliverViewerMessage,
  messageTargets,
  supportsDeviceMessages,
} from "./realtime-message-delivery";
import {
  blockViewer,
  deleteMessageForDevice,
  deleteViewerMessagesForDevice,
  deviceMessageHistory,
  isPublicMessageThread,
  isViewerBlocked,
  markMessageReplied,
  markMessagesDelivered,
  pendingMessages,
  publicMessagesByWindow,
  recentPublicMessages,
  recordMessage,
  setViewerRemark,
  unblockViewer,
  viewerMessageHistory,
} from "./realtime-message-store";
import { realtimeApiRateLimit } from "./realtime-rate-limit";
import { realtimeSocketHub } from "./realtime-socket-hub";
import {
  cleanDeviceId,
  cleanMessageId,
  cleanText,
  cleanViewerId,
  cleanViewerName,
  parseMessagePayload,
  publicRecentHours,
  readMessageJson,
} from "./message-protocol";
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

export async function handleDeviceMessageReply(req: Request): Promise<Response> {
  const device = authenticateToken(req.headers.get("authorization"));
  if (!device) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = await readMessageJson(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  const viewerId = typeof body.target_viewer_id === "string" ? body.target_viewer_id : "";
  const messageId = cleanMessageId(body.message_id);
  const text = cleanText(body.text);
  const isPublicThread = messageId ? isPublicMessageThread(messageId) : false;
  if (!text || (!isPublicThread && !viewerId)) {
    return Response.json({ error: "target_viewer_id and text required" }, { status: 400 });
  }

  if (messageId) markMessageReplied(messageId);
  const replyId = cleanMessageId(body.reply_id) || crypto.randomUUID();
  const createdAt = new Date().toISOString();

  if (isPublicThread) {
    const publicReplyId = "pub_" + replyId;
    const inserted = recordMessage(publicReplyId, device.device_id, "__public__", "up", "public_reply", "device", text, createdAt);
    if (inserted) {
      broadcastPublicMessage({
        id: publicReplyId,
        device_id: device.device_id,
        viewer_id: "__public__",
        viewer_name: "up",
        kind: "public_reply",
        text,
        created_at: createdAt,
      });
    }
    return Response.json({
      ok: true,
      public: true,
      message_id: publicReplyId,
      reply_id: publicReplyId,
      in_reply_to: messageId,
      duplicate: !inserted,
    });
  }

  const inserted = recordMessage(replyId, device.device_id, viewerId, "", "reply", "device", text, createdAt);
  const delivered = inserted
    ? realtimeSocketHub.sendToViewer(viewerId, {
      type: "device_reply",
      message_id: replyId,
      in_reply_to: messageId,
      device_id: device.device_id,
      text,
      created_at: createdAt,
    })
    : 0;

  if (inserted) {
    import("./push").then(({ sendPush }) => {
      sendPush(viewerId, {
        title: "Monika 回复了",
        body: text.slice(0, 120),
        icon: "/icon-192.png",
        url: "/",
      }).catch(() => {});
    });
  }

  return Response.json({
    ok: true,
    message_id: replyId,
    reply_id: replyId,
    in_reply_to: messageId,
    duplicate: !inserted,
    delivered: delivered > 0,
    delivered_sockets: delivered,
  });
}

export async function handlePublicMessagePost(req: Request): Promise<Response> {
  const viewer = edgeViewerIdentity(req) || verifyViewerToken(viewerTokenFromRequest(req));
  if (!viewer) return Response.json({ error: "Viewer token required" }, { status: 403 });
  if (!viewerTokenRateLimit(viewer.viewerId) || !realtimeApiRateLimit(viewer.viewerId)) {
    return Response.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const parsed = await readMessageJson(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  const text = cleanText(body.text);
  if (!text) return Response.json({ error: "text required" }, { status: 400 });
  const preferredDeviceId = cleanDeviceId(body.target_device_id);
  const viewerName = cleanViewerName(body.viewer_name);
  const messageId = cleanMessageId(body.message_id) || crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const targets = messageTargets(preferredDeviceId)
    .filter((deviceId) => !isViewerBlocked(deviceId, viewer.viewerId));

  recordMessage(messageId, "__public__", viewer.viewerId, viewerName, "public", "viewer", text, createdAt);
  let sent = 0;
  let queued = 0;
  for (const deviceId of targets) {
    const status = deliverViewerMessage(deviceId, viewer.viewerId, viewerName, "public", text, messageId, createdAt);
    if (status === "sent") sent += 1;
    else queued += 1;
  }

  broadcastPublicMessage({
    id: messageId,
    device_id: "__public__",
    viewer_id: viewer.viewerId,
    viewer_name: viewerName,
    kind: "public",
    text,
    created_at: createdAt,
  });

  return Response.json({ ok: true, message_id: messageId, sent, queued });
}

export async function handlePrivateMessagePost(req: Request): Promise<Response> {
  const viewer = edgeViewerIdentity(req) || verifyViewerToken(viewerTokenFromRequest(req));
  if (!viewer) return Response.json({ error: "Viewer token required" }, { status: 403 });
  if (!viewerTokenRateLimit(viewer.viewerId) || !realtimeApiRateLimit(viewer.viewerId)) {
    return Response.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const parsed = await readMessageJson(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  const targetDeviceId = cleanDeviceId(body.target_device_id);
  const text = cleanText(body.text);
  const viewerName = cleanViewerName(body.viewer_name);
  const messageId = cleanMessageId(body.message_id) || crypto.randomUUID();
  if (!targetDeviceId || !text) {
    return Response.json({ error: "target_device_id and text required", message_id: messageId }, { status: 400 });
  }
  if (!supportsDeviceMessages(targetDeviceId)) {
    return Response.json({ error: "unsupported_target_device", message_id: messageId }, { status: 404 });
  }
  if (isViewerBlocked(targetDeviceId, viewer.viewerId)) {
    return Response.json({ error: "blocked_by_device", message_id: messageId }, { status: 403 });
  }

  const createdAt = new Date().toISOString();
  recordMessage(messageId, targetDeviceId, viewer.viewerId, viewerName, "private", "viewer", text, createdAt);
  const status = deliverViewerMessage(targetDeviceId, viewer.viewerId, viewerName, "private", text, messageId, createdAt);
  realtimeSocketHub.sendToViewer(viewer.viewerId, {
    type: "viewer_message_sent",
    message_id: messageId,
    message: {
      id: messageId,
      device_id: targetDeviceId,
      viewer_id: viewer.viewerId,
      viewer_name: viewerName,
      kind: "private",
      text,
      created_at: createdAt,
    },
    status,
  });
  return Response.json({ ok: true, message_id: messageId, status });
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

export async function handleBlockViewer(req: Request): Promise<Response> {
  const device = authenticateToken(req.headers.get("authorization"));
  if (!device) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = await readMessageJson(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  const viewerId = cleanViewerId(body.viewer_id);
  if (!viewerId) {
    return Response.json({ error: "viewer_id required" }, { status: 400 });
  }

  blockViewer(device.device_id, viewerId);
  return Response.json({ ok: true });
}

export async function handleUnblockViewer(req: Request): Promise<Response> {
  const device = authenticateToken(req.headers.get("authorization"));
  if (!device) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = await readMessageJson(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  const viewerId = cleanViewerId(body.viewer_id);
  if (!viewerId) {
    return Response.json({ error: "viewer_id required" }, { status: 400 });
  }

  unblockViewer(device.device_id, viewerId);
  return Response.json({ ok: true });
}

export async function handleDeleteMessage(req: Request): Promise<Response> {
  const device = authenticateToken(req.headers.get("authorization"));
  if (!device) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = await readMessageJson(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  const messageId = cleanMessageId(body.message_id);
  if (!messageId) {
    return Response.json({ error: "message_id required" }, { status: 400 });
  }

  const { existing, deleted } = deleteMessageForDevice(messageId, device.device_id);
  if (!existing) return Response.json({ ok: true, deleted: false });

  if (deleted) {
    if (existing.kind === "public" || existing.kind === "public_reply") {
      broadcastPublicMessageDeleted(messageId);
    } else if (existing.viewer_id) {
      realtimeSocketHub.sendToViewer(existing.viewer_id, {
        type: "message_deleted",
        message_id: messageId,
        device_id: existing.device_id,
      });
    }
  }
  return Response.json({ ok: true, deleted });
}

export async function handleDeleteViewerMessages(req: Request): Promise<Response> {
  const device = authenticateToken(req.headers.get("authorization"));
  if (!device) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = await readMessageJson(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  const viewerId = cleanViewerId(body.viewer_id);
  if (!viewerId) {
    return Response.json({ error: "viewer_id required" }, { status: 400 });
  }

  const deleted = deleteViewerMessagesForDevice(device.device_id, viewerId);
  if (deleted > 0) {
    realtimeSocketHub.sendToViewer(viewerId, {
      type: "viewer_messages_deleted",
      device_id: device.device_id,
    });
  }
  return Response.json({ ok: true, deleted });
}

export async function handleSetRemark(req: Request): Promise<Response> {
  const device = authenticateToken(req.headers.get("authorization"));
  if (!device) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = await readMessageJson(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  const viewerId = cleanViewerId(body.viewer_id);
  const remark = cleanText(body.remark);

  if (!viewerId) {
    return Response.json({ error: "viewer_id required" }, { status: 400 });
  }

  setViewerRemark(device.device_id, viewerId, remark);
  return Response.json({ ok: true });
}

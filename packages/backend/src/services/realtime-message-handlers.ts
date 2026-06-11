import { authenticateToken } from "../middleware/auth";
import {
  postDeviceReply,
  postPrivateViewerMessage,
  postPublicViewerMessage,
} from "./realtime-message-actions";
import {
  broadcastPublicMessageDeleted,
} from "./realtime-message-delivery";
import {
  blockViewer,
  deleteMessageForDevice,
  deleteViewerMessagesForDevice,
  setViewerRemark,
  unblockViewer,
} from "./realtime-message-store";
import { realtimeApiRateLimit } from "./realtime-rate-limit";
import { realtimeSocketHub } from "./realtime-socket-hub";
import {
  cleanDeviceId,
  cleanMessageId,
  cleanText,
  cleanViewerId,
  cleanViewerName,
  readMessageJson,
} from "./message-protocol";
import { edgeViewerIdentity, verifyViewerToken, viewerTokenFromRequest, viewerTokenRateLimit } from "./viewer-auth";

export async function handleDeviceMessageReply(req: Request): Promise<Response> {
  const device = authenticateToken(req.headers.get("authorization"));
  if (!device) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = await readMessageJson(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  const viewerId = typeof body.target_viewer_id === "string" ? body.target_viewer_id : "";
  const messageId = cleanMessageId(body.message_id);
  const text = cleanText(body.text);
  const replyId = cleanMessageId(body.reply_id) || crypto.randomUUID();
  const result = postDeviceReply({
    deviceId: device.device_id,
    targetViewerId: viewerId,
    messageId,
    replyId,
    text,
  });
  if (!result.ok) {
    return Response.json({ error: "target_viewer_id and text required" }, { status: 400 });
  }

  if (result.kind === "public") {
    return Response.json({
      ok: true,
      public: true,
      message_id: result.storedMessageId,
      reply_id: result.replyId,
      in_reply_to: result.inReplyTo,
      duplicate: result.duplicate,
    });
  }

  return Response.json({
    ok: true,
    message_id: result.storedMessageId,
    reply_id: result.replyId,
    in_reply_to: result.inReplyTo,
    duplicate: result.duplicate,
    delivered: result.deliveredSockets > 0,
    delivered_sockets: result.deliveredSockets,
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
  const result = postPublicViewerMessage({
    preferredDeviceId,
    viewerId: viewer.viewerId,
    viewerName,
    messageId,
    text,
  });

  return Response.json({ ok: true, message_id: result.message.id, sent: result.sent, queued: result.queued });
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
  const result = postPrivateViewerMessage({
    targetDeviceId,
    viewerId: viewer.viewerId,
    viewerName,
    messageId,
    text,
  });
  if (!result.ok) {
    const status = result.error === "unsupported_target_device" ? 404 : 403;
    return Response.json({ error: result.error, message_id: messageId }, { status });
  }

  return Response.json({ ok: true, message_id: result.message.id, status: result.status });
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

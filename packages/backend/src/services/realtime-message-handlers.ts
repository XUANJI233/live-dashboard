import { authenticateToken } from "../middleware/auth";
import { postDeviceReply } from "./realtime-device-reply-actions";
import {
  postPrivateViewerMessage,
  postPublicViewerMessage,
} from "./realtime-message-actions";
import { realtimeApiRateLimit } from "./realtime-rate-limit";
import {
  cleanDeviceId,
  cleanMessageId,
  cleanText,
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

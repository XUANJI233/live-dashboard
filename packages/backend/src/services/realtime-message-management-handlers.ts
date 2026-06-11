import { authenticateToken } from "../middleware/auth";
import { broadcastPublicMessageDeleted } from "./realtime-message-delivery";
import {
  blockViewer,
  deleteMessageForDevice,
  deleteViewerMessagesForDevice,
  setViewerRemark,
  unblockViewer,
} from "./realtime-message-store";
import { realtimeSocketHub } from "./realtime-socket-hub";
import {
  cleanMessageId,
  cleanText,
  cleanViewerId,
  readMessageJson,
} from "./message-protocol";

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

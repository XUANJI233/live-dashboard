import {
  broadcastPublicMessage,
  deliverViewerMessage,
  messageTargets,
  supportsDeviceMessages,
  type PublicRealtimeMessage,
  type ViewerMessageDeliveryStatus,
} from "./realtime-message-delivery";
import {
  isPublicMessageThread,
  isViewerBlocked,
  recordMessage,
} from "./realtime-message-store";
import { markMessageReplied } from "./realtime-message-queue-store";
import { realtimeSocketHub } from "./realtime-socket-hub";

export interface PostedViewerMessage {
  id: string;
  device_id: string;
  viewer_id: string;
  viewer_name: string;
  kind: "private";
  text: string;
  created_at: string;
}

export interface PublicViewerMessageResult {
  message: PublicRealtimeMessage;
  sent: number;
  queued: number;
  status: "sent" | "queued" | "recorded";
}

export type PrivateViewerMessageResult =
  | { ok: false; error: "unsupported_target_device" | "blocked_by_device" }
  | {
    ok: true;
    message: PostedViewerMessage;
    status: ViewerMessageDeliveryStatus;
    sent: number;
    queued: number;
  };

export type DeviceReplyResult =
  | { ok: false; error: "target_viewer_id and text required"; inReplyTo: string }
  | {
    ok: true;
    kind: "public";
    storedMessageId: string;
    replyId: string;
    inReplyTo: string;
    duplicate: boolean;
  }
  | {
    ok: true;
    kind: "private";
    storedMessageId: string;
    replyId: string;
    inReplyTo: string;
    duplicate: boolean;
    deliveredSockets: number;
  };

export function postPublicViewerMessage(input: {
  preferredDeviceId: string;
  viewerId: string;
  viewerName: string;
  messageId: string;
  text: string;
}): PublicViewerMessageResult {
  const createdAt = new Date().toISOString();
  const targets = messageTargets(input.preferredDeviceId)
    .filter((deviceId) => !isViewerBlocked(deviceId, input.viewerId));
  recordMessage(input.messageId, "__public__", input.viewerId, input.viewerName, "public", "viewer", input.text, createdAt);

  let sent = 0;
  let queued = 0;
  for (const deviceId of targets) {
    const status = deliverViewerMessage(
      deviceId,
      input.viewerId,
      input.viewerName,
      "public",
      input.text,
      input.messageId,
      createdAt,
    );
    if (status === "sent") sent += 1;
    else queued += 1;
  }

  const message: PublicRealtimeMessage = {
    id: input.messageId,
    device_id: "__public__",
    viewer_id: input.viewerId,
    viewer_name: input.viewerName,
    kind: "public",
    text: input.text,
    created_at: createdAt,
  };
  broadcastPublicMessage(message);

  return {
    message,
    sent,
    queued,
    status: sent > 0 ? "sent" : queued > 0 ? "queued" : "recorded",
  };
}

export function postPrivateViewerMessage(input: {
  targetDeviceId: string;
  viewerId: string;
  viewerName: string;
  messageId: string;
  text: string;
}): PrivateViewerMessageResult {
  if (!supportsDeviceMessages(input.targetDeviceId)) {
    return { ok: false, error: "unsupported_target_device" };
  }
  if (isViewerBlocked(input.targetDeviceId, input.viewerId)) {
    return { ok: false, error: "blocked_by_device" };
  }

  const createdAt = new Date().toISOString();
  const message: PostedViewerMessage = {
    id: input.messageId,
    device_id: input.targetDeviceId,
    viewer_id: input.viewerId,
    viewer_name: input.viewerName,
    kind: "private",
    text: input.text,
    created_at: createdAt,
  };
  recordMessage(input.messageId, input.targetDeviceId, input.viewerId, input.viewerName, "private", "viewer", input.text, createdAt);
  const status = deliverViewerMessage(
    input.targetDeviceId,
    input.viewerId,
    input.viewerName,
    "private",
    input.text,
    input.messageId,
    createdAt,
  );
  const sent = status === "sent" ? 1 : 0;
  const queued = status === "queued" ? 1 : 0;
  realtimeSocketHub.sendToViewer(input.viewerId, {
    type: "viewer_message_sent",
    message_id: input.messageId,
    message,
    status,
  });

  return { ok: true, message, status, sent, queued };
}

export function postDeviceReply(input: {
  deviceId: string;
  targetViewerId: string;
  messageId: string;
  replyId: string;
  text: string;
}): DeviceReplyResult {
  const isPublicThread = input.messageId ? isPublicMessageThread(input.messageId) : false;
  if (!input.text || (!isPublicThread && !input.targetViewerId)) {
    return { ok: false, error: "target_viewer_id and text required", inReplyTo: input.messageId };
  }
  if (input.messageId) markMessageReplied(input.messageId);

  const createdAt = new Date().toISOString();
  if (isPublicThread) {
    return postPublicDeviceReply(input, createdAt);
  }

  const inserted = recordMessage(input.replyId, input.deviceId, input.targetViewerId, "", "reply", "device", input.text, createdAt);
  const deliveredSockets = inserted
    ? realtimeSocketHub.sendToViewer(input.targetViewerId, {
      type: "device_reply",
      message_id: input.replyId,
      in_reply_to: input.messageId,
      device_id: input.deviceId,
      text: input.text,
      created_at: createdAt,
    })
    : 0;

  if (inserted) {
    sendReplyPush(input.targetViewerId, input.text);
  }

  return {
    ok: true,
    kind: "private",
    storedMessageId: input.replyId,
    replyId: input.replyId,
    inReplyTo: input.messageId,
    duplicate: !inserted,
    deliveredSockets,
  };
}

function postPublicDeviceReply(
  input: { deviceId: string; messageId: string; replyId: string; text: string },
  createdAt: string,
): DeviceReplyResult {
  const publicReplyId = "pub_" + input.replyId;
  const inserted = recordMessage(publicReplyId, input.deviceId, "__public__", "up", "public_reply", "device", input.text, createdAt);
  if (inserted) {
    broadcastPublicMessage({
      id: publicReplyId,
      device_id: input.deviceId,
      viewer_id: "__public__",
      viewer_name: "up",
      kind: "public_reply",
      text: input.text,
      created_at: createdAt,
    });
  }

  return {
    ok: true,
    kind: "public",
    storedMessageId: publicReplyId,
    replyId: publicReplyId,
    inReplyTo: input.messageId,
    duplicate: !inserted,
  };
}

function sendReplyPush(targetViewerId: string, text: string): void {
  import("./push").then(({ sendPush }) => {
    sendPush(targetViewerId, {
      title: "Monika 回复了",
      body: text.slice(0, 120),
      icon: "/icon-192.png",
      url: "/",
    }).catch(() => {});
  });
}

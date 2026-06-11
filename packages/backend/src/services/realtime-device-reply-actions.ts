import { broadcastPublicMessage } from "./realtime-message-delivery";
import {
  isPublicMessageThread,
  recordMessage,
} from "./realtime-message-store";
import { markMessageReplied } from "./realtime-message-queue-store";
import { realtimeSocketHub } from "./realtime-socket-hub";

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

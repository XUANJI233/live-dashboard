import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempDir = mkdtempSync(join(tmpdir(), "live-messages-"));
process.env.DB_PATH = join(tempDir, "test.db");
process.env.HASH_SECRET = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
process.env.DEVICE_TOKEN_1 = "message-device-token:android-message-target:Android Message Target:android";

describe("visitor messages", () => {
  afterAll(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // SQLite handles may still be open briefly.
    }
  });

  test("keeps private message HTTP fallback idempotent by message_id", async () => {
    const { db } = await import("../src/db");
    const { handlePrivateMessagePost } = await import("../src/services/realtime-message-handlers");
    const token = await viewerToken();
    insertDeviceState(db, {
      device_id: "android-message-target",
      device_name: "Android Message Target",
      platform: "android",
    });

    const payload = {
      message_id: "msg_fallback_once",
      target_device_id: "android-message-target",
      viewer_name: "tester",
      text: "hello",
    };
    const first = await handlePrivateMessagePost(privateMessageRequest(payload, token));
    const duplicate = await handlePrivateMessagePost(privateMessageRequest(payload, token));

    expect(first.status).toBe(200);
    expect(duplicate.status).toBe(200);
    expect((await first.json() as { status?: string }).status).toBe("queued");
    expect((await duplicate.json() as { status?: string }).status).toBe("queued");
    expect(rowCount(db, "device_messages", "id = 'msg_fallback_once'")).toBe(1);
    expect(rowCount(db, "visitor_messages", "id = 'msg_fallback_once'")).toBe(1);
  });

  test("rejects unsupported private message targets without leaving dead queued rows", async () => {
    const { db } = await import("../src/db");
    const { handlePrivateMessagePost } = await import("../src/services/realtime-message-handlers");
    const token = await viewerToken("fedcba9876543210fedcba9876543210");
    insertDeviceState(db, {
      device_id: "zepp-message-target",
      device_name: "Zepp Message Target",
      platform: "zepp",
    });

    const response = await handlePrivateMessagePost(privateMessageRequest({
      message_id: "msg_unsupported_target",
      target_device_id: "zepp-message-target",
      viewer_name: "tester",
      text: "hello",
    }, token));
    const body = await response.json() as { error?: string };

    expect(response.status).toBe(404);
    expect(body.error).toBe("unsupported_target_device");
    expect(rowCount(db, "device_messages", "id = 'msg_unsupported_target'")).toBe(0);
    expect(rowCount(db, "visitor_messages", "id = 'msg_unsupported_target'")).toBe(0);
  });

  test("flushes queued device commands through the message payload contract", async () => {
    const { db } = await import("../src/db");
    const { sendDeviceCommands } = await import("../src/services/device-control");
    const { deliverQueuedMessages } = await import("../src/services/realtime-message-delivery");
    const deviceId = "android-lsp-queued-command";
    insertDeviceState(db, {
      device_id: deviceId,
      device_name: "Queued Command Phone",
      platform: "android",
      extra: JSON.stringify({ device: { profile: "android_lsp" } }),
    });

    const sent = sendDeviceCommands({
      request_id: "req_queued_command_flush",
      commands: [{
        device_id: deviceId,
        freeze_commands: ["com.video"],
        say: "focus",
      }],
    });
    const command = sent.commands[0]!;
    const frames: Array<Record<string, any>> = [];

    deliverQueuedMessages(deviceId, {
      data: { role: "device", id: deviceId },
      send(payload: string) {
        frames.push(JSON.parse(payload));
      },
    } as any);

    expect(command.delivery.status).toBe("queued");
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      type: "viewer_message",
      message_id: command.command_id,
      viewer_id: "__mcp__",
      queued: true,
      payload: {
        type: "device_command",
        request_id: "req_queued_command_flush",
        command_id: command.command_id,
        payload: {
          kind: "supervision",
          freeze_commands: ["com.video"],
          say: "focus",
        },
      },
    });

    const queued = db.prepare("SELECT delivered_at FROM device_messages WHERE id = ? AND device_id = ?")
      .get(command.command_id, deviceId) as { delivered_at: string } | null;
    expect(queued?.delivered_at).not.toBe("");
  });

  test("delivers private viewer websocket messages through the shared action", async () => {
    const { db } = await import("../src/db");
    const { realtimeWebSocket } = await import("../src/services/realtime");
    const deviceId = "android-ws-private-target";
    const viewerId = "viewer-ws-private";
    const messageId = "msg_ws_private_shared";
    insertDeviceState(db, {
      device_id: deviceId,
      device_name: "WS Private Phone",
      platform: "android",
    });
    const deviceFrames: Array<Record<string, any>> = [];
    const viewerFrames: Array<Record<string, any>> = [];
    const deviceWs = {
      data: {
        role: "device",
        id: deviceId,
        device: { device_id: deviceId, device_name: "WS Private Phone", platform: "android" },
      },
      send(payload: string) {
        deviceFrames.push(JSON.parse(payload));
      },
    };
    const viewerWs = {
      data: { role: "viewer", id: viewerId },
      send(payload: string) {
        viewerFrames.push(JSON.parse(payload));
      },
    };

    realtimeWebSocket.open(deviceWs as any);
    realtimeWebSocket.open(viewerWs as any);
    realtimeWebSocket.message(viewerWs as any, JSON.stringify({
      type: "viewer_message",
      kind: "private",
      message_id: messageId,
      target_device_id: deviceId,
      viewer_name: "tester",
      text: "hello over ws",
    }));
    realtimeWebSocket.close(deviceWs as any);
    realtimeWebSocket.close(viewerWs as any);

    expect(deviceFrames.at(-1)).toMatchObject({
      type: "viewer_message",
      message_id: messageId,
      viewer_id: viewerId,
      viewer_name: "tester",
      kind: "private",
      text: "hello over ws",
    });
    expect(viewerFrames).toContainEqual(expect.objectContaining({
      type: "viewer_message_sent",
      message_id: messageId,
      status: "sent",
    }));
    expect(viewerFrames.at(-1)).toMatchObject({
      type: "ack",
      message_id: messageId,
      status: "sent",
      sent: 1,
      queued: 0,
    });
    const delivered = db.prepare("SELECT delivered_at FROM device_messages WHERE id = ? AND device_id = ?")
      .get(messageId, deviceId) as { delivered_at: string } | null;
    expect(delivered?.delivered_at).not.toBe("");
  });

  test("keeps viewer websocket rate-limit errors correlated by message_id", async () => {
    const { realtimeWebSocket } = await import("../src/services/realtime");
    const frames: Array<{ type?: string; message_id?: string; error?: string }> = [];
    const ws = {
      data: { role: "viewer", id: "viewer-rate-limit" },
      send(payload: string) {
        frames.push(JSON.parse(payload));
      },
    };

    for (let index = 0; index < 11; index += 1) {
      realtimeWebSocket.message(ws as any, JSON.stringify({
        type: "viewer_message",
        kind: "private",
        message_id: `msg_rate_${index}`,
      }));
    }

    expect(frames.at(-1)).toEqual({
      type: "error",
      message_id: "msg_rate_10",
      error: "Rate limit exceeded",
    });
  });

  test("deduplicates device replies by reply_id across HTTP retries", async () => {
    const { db } = await import("../src/db");
    const { handleDeviceMessageReply } = await import("../src/services/realtime-message-handlers");
    insertDeviceState(db, {
      device_id: "android-message-target",
      device_name: "Android Message Target",
      platform: "android",
    });

    const body = {
      message_id: "msg_original_private",
      reply_id: "reply_retry_once",
      target_viewer_id: "fp_0123456789abcdef0123456789abcdef",
      text: "reply",
    };
    const first = await handleDeviceMessageReply(deviceMessageReplyRequest(body));
    const duplicate = await handleDeviceMessageReply(deviceMessageReplyRequest(body));
    const firstBody = await first.json() as { duplicate?: boolean };
    const duplicateBody = await duplicate.json() as { duplicate?: boolean };

    expect(first.status).toBe(200);
    expect(duplicate.status).toBe(200);
    expect(firstBody.duplicate).toBe(false);
    expect(duplicateBody.duplicate).toBe(true);
    expect(rowCount(db, "visitor_messages", "id = 'reply_retry_once'")).toBe(1);
  });
});

async function viewerToken(fingerprint = "0123456789abcdef0123456789abcdef"): Promise<string> {
  const { issueViewerToken } = await import("../src/services/viewer-auth");
  const issued = issueViewerToken(fingerprint, "127.0.0.1");
  if (!issued.token) throw new Error(issued.error || "viewer token issue failed");
  return issued.token;
}

function privateMessageRequest(body: Record<string, unknown>, token: string): Request {
  return new Request("http://localhost/api/messages/private", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function deviceMessageReplyRequest(body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/messages/reply", {
    method: "POST",
    headers: {
      Authorization: "Bearer message-device-token",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function insertDeviceState(db: typeof import("../src/db").db, row: {
  device_id: string;
  device_name: string;
  platform: string;
  extra?: string;
}): void {
  db.prepare(`
    INSERT OR REPLACE INTO device_states (
      device_id,
      device_name,
      platform,
      app_id,
      app_name,
      window_title,
      display_title,
      last_seen_at,
      extra,
      is_online
    )
    VALUES (?, ?, ?, 'idle', 'Idle', '', '', ?, ?, 1)
  `).run(row.device_id, row.device_name, row.platform, new Date().toISOString(), row.extra ?? "{}");
}

function rowCount(db: typeof import("../src/db").db, table: "device_messages" | "visitor_messages", where: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`).get() as { count: number };
  return row.count;
}

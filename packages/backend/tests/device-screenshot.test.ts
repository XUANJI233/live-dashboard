import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempDir = mkdtempSync(join(tmpdir(), "live-device-screenshot-"));
process.env.DB_PATH = join(tempDir, "test.db");
process.env.HASH_SECRET = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
process.env.MCP_SERVER_TOKEN = "screenshot-mcp-token";
process.env.DEVICE_TOKEN_1 = "screenshot-device-token:screenshot-phone:Screenshot Phone:android";

describe("device screenshot control", () => {
  afterAll(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // SQLite may retain a test handle briefly.
    }
  });

  test("captures through an LSP command, accepts the bounded upload, and returns one MCP image", async () => {
    const { db } = await import("../src/db");
    const { handleMcpRequest } = await import("../src/routes/mcp");
    const { handleDeviceScreenshotUpload } = await import("../src/routes/device-screenshot");
    db.prepare(`
      INSERT OR REPLACE INTO device_states (
        device_id, device_name, platform, app_id, app_name, window_title,
        display_title, last_seen_at, extra, is_online
      ) VALUES (?, ?, 'android', 'com.example.current', 'Current', '', '', ?, ?, 1)
    `).run(
      "screenshot-phone",
      "Screenshot Phone",
      new Date().toISOString(),
      JSON.stringify({
        device: {
          profile: "android_lsp",
          capabilities: { screenshot: true },
        },
      }),
    );

    const capture = await handleMcpRequest(mcpRequest({
      method: "tools/call",
      params: {
        name: "live_dashboard.capture_device_screenshot",
        arguments: {
          device_id: "screenshot-phone",
          max_width: 720,
          jpeg_quality: 65,
          wait_seconds: 0,
        },
      },
    }), localMcpAccess());
    const captureBody = await capture.json() as {
      result?: { structuredContent?: { status?: string; screenshot_id?: string; command_id?: string } };
    };
    const screenshotId = captureBody.result?.structuredContent?.screenshot_id || "";
    const commandId = captureBody.result?.structuredContent?.command_id || "";
    expect(captureBody.result?.structuredContent?.status).toBe("pending");
    expect(screenshotId).toMatch(/^shot_[a-f0-9-]+$/);
    expect(commandId).toMatch(/^cmd_/);

    const command = db.prepare("SELECT payload FROM device_commands WHERE command_id = ?").get(commandId) as { payload: string };
    expect(JSON.parse(command.payload).payload).toMatchObject({
      kind: "screenshot",
      screenshot: {
        screenshot_id: screenshotId,
        max_width: 720,
        jpeg_quality: 65,
      },
    });

    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    const upload = await handleDeviceScreenshotUpload(new Request(
      `http://localhost/api/device-screenshots/${screenshotId}`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer screenshot-device-token",
          "Content-Type": "image/jpeg",
          "X-Command-Id": commandId,
          "X-Screenshot-Width": "720",
          "X-Screenshot-Height": "1600",
        },
        body: jpeg,
      },
    ), screenshotId);
    expect(upload.status).toBe(200);
    expect(await upload.json()).toMatchObject({ received: true, screenshot_id: screenshotId });

    const fetch = await handleMcpRequest(mcpRequest({
      method: "tools/call",
      params: {
        name: "live_dashboard.get_device_screenshot",
        arguments: { screenshot_id: screenshotId },
      },
    }), localMcpAccess());
    const fetchBody = await fetch.json() as {
      result?: {
        content?: Array<{ type?: string; data?: string; mimeType?: string }>;
        structuredContent?: { status?: string; width?: number; height?: number };
      };
    };
    expect(fetchBody.result?.structuredContent).toMatchObject({
      status: "ready",
      width: 720,
      height: 1600,
    });
    expect(fetchBody.result?.content?.[0]).toEqual({
      type: "image",
      data: Buffer.from(jpeg).toString("base64"),
      mimeType: "image/jpeg",
    });

    const consumed = await handleMcpRequest(mcpRequest({
      method: "tools/call",
      params: {
        name: "live_dashboard.get_device_screenshot",
        arguments: { screenshot_id: screenshotId },
      },
    }), localMcpAccess());
    const consumedBody = await consumed.json() as { result?: { structuredContent?: { status?: string } } };
    expect(consumedBody.result?.structuredContent?.status).toBe("missing");
  });
});

function localMcpAccess(): { remoteAddress: string; localListener: true } {
  return { remoteAddress: "127.0.0.1", localListener: true };
}

function mcpRequest(message: Record<string, unknown>): Request {
  return new Request("http://127.0.0.1/api/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      Authorization: "Bearer screenshot-mcp-token",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, params: {}, ...message }),
  });
}

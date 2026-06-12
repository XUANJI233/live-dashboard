import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempDir = mkdtempSync(join(tmpdir(), "live-device-status-"));
process.env.DB_PATH = join(tempDir, "test.db");
process.env.HASH_SECRET = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");

describe("device-status-handler", () => {
  afterAll(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // The shared Bun test process keeps src/db open for other test files.
    }
  });

  test("drops keyboard input extras and keeps audio/light device extras", async () => {
    const { processReportPayload } = await import("../src/services/device-status-handler");
    const result = processReportPayload({
      app_id: "com.android.browser",
      window_title: "Docs",
      extra: {
        input: { input_active: true, is_typing: true, source: "lsposed" },
        device: {
          profile: "android_lsp",
          audio_output_connected: true,
          audio_output_type: "bluetooth_headset",
          audio_output_name: "Buds",
          ambient_lux: 123.45,
        },
      },
    }, {
      device_id: "phone",
      device_name: "Phone",
      platform: "android",
    });

    expect(JSON.stringify(result?.extra)).not.toContain("input_active");
    expect(result?.extra.device).toMatchObject({
      profile: "android_lsp",
      audio_output_connected: true,
      audio_output_type: "bluetooth_headset",
      audio_output_name: "Buds",
      ambient_lux: 123.5,
    });
  });

  test("heartbeat-only reports update device state without inserting timeline activity", async () => {
    const { processReportPayload } = await import("../src/services/device-status-handler");
    const { db } = await import("../src/db");
    processReportPayload({
      app_id: "com.reader",
      window_title: "Reading",
      extra: {
        device: {
          heartbeat_only: true,
          network_type: "Wi-Fi",
        },
      },
    }, {
      device_id: "heartbeat-phone",
      device_name: "Phone",
      platform: "android",
    });

    const activityCount = (db.prepare("SELECT COUNT(*) AS count FROM activities WHERE device_id = ?").get("heartbeat-phone") as { count: number }).count;
    const state = db.prepare("SELECT extra FROM device_states WHERE device_id = ?").get("heartbeat-phone") as { extra: string } | undefined;

    expect(activityCount).toBe(0);
    expect(state?.extra).toContain("heartbeat_only");
    expect(state?.extra).toContain("Wi-Fi");
  });

  test("heartbeat-only flag is not inherited by the next full report", async () => {
    const { processReportPayload } = await import("../src/services/device-status-handler");
    const { db } = await import("../src/db");
    const device = {
      device_id: "heartbeat-merge-phone",
      device_name: "Phone",
      platform: "android" as const,
    };

    processReportPayload({
      app_id: "com.reader",
      window_title: "Reading",
      extra: { device: { heartbeat_only: true, network_type: "Wi-Fi" } },
    }, device);
    processReportPayload({
      app_id: "com.reader",
      window_title: "Reading chapter 2",
      extra: { device: { network_type: "Wi-Fi" } },
    }, device);

    const activityCount = (db.prepare("SELECT COUNT(*) AS count FROM activities WHERE device_id = ?").get(device.device_id) as { count: number }).count;
    const state = db.prepare("SELECT extra FROM device_states WHERE device_id = ?").get(device.device_id) as { extra: string } | undefined;

    expect(activityCount).toBe(1);
    expect(state?.extra).not.toContain("heartbeat_only");
  });

  test("stores installed app snapshots but strips them from public current output", async () => {
    const { processReportPayload } = await import("../src/services/device-status-handler");
    const { db } = await import("../src/db");
    const { getDeviceInstalledApps, listDeviceContexts } = await import("../src/services/device-context");
    const { handleCurrent } = await import("../src/routes/current");
    const device = {
      device_id: "apps-phone",
      device_name: "Apps Phone",
      platform: "android" as const,
    };

    processReportPayload({
      app_id: "com.reader",
      window_title: "Reading",
      extra: {
        device: {
          profile: "android_lsp",
          installed_apps_updated_at: "2026-06-12T00:00:00.000Z",
          installed_apps: [
            { package_name: "com.example.reader", app_name: "Reader" },
            { package_name: "com.example.reader", app_name: "Duplicate" },
            { package_name: "com.example.video", app_name: "Video" },
            { package_name: "", app_name: "Ignored" },
          ],
        },
      },
    }, device);

    const state = db.prepare("SELECT extra FROM device_states WHERE device_id = ?").get(device.device_id) as { extra: string } | undefined;
    expect(state?.extra).toContain("installed_apps");
    expect(listDeviceContexts().find((item) => item.device_id === device.device_id)).toMatchObject({
      installed_apps_count: 2,
      installed_apps_updated_at: "2026-06-12T00:00:00.000Z",
    });
    expect(getDeviceInstalledApps(device.device_id)).toMatchObject({
      found: true,
      app_count: 2,
      installed_apps: [
        { package_name: "com.example.reader", app_name: "Reader" },
        { package_name: "com.example.video", app_name: "Video" },
      ],
    });

    const current = await handleCurrent(new Request("http://localhost/api/current"), "127.0.0.1").json() as {
      devices: Array<{ device_id: string; extra?: { device?: Record<string, unknown> } }>;
    };
    const publicDevice = current.devices.find((item) => item.device_id === device.device_id);
    expect(publicDevice?.extra?.device?.installed_apps).toBeUndefined();
    expect(publicDevice?.extra?.device?.installed_apps_count).toBe(2);
  });

  test("websocket device_status returns ack and broadcasts public device update", async () => {
    const { db } = await import("../src/db");
    const { realtimeWebSocket } = await import("../src/services/realtime");
    const deviceId = "ws-status-phone";
    const deviceFrames: Array<Record<string, any>> = [];
    const viewerFrames: Array<Record<string, any>> = [];
    const deviceWs = {
      data: {
        role: "device",
        id: deviceId,
        device: { device_id: deviceId, device_name: "WS Status Phone", platform: "android" },
      },
      send(payload: string) {
        deviceFrames.push(JSON.parse(payload));
      },
    };
    const viewerWs = {
      data: { role: "viewer", id: "viewer-ws-status" },
      send(payload: string) {
        viewerFrames.push(JSON.parse(payload));
      },
    };

    realtimeWebSocket.open(viewerWs as any);
    realtimeWebSocket.open(deviceWs as any);
    realtimeWebSocket.message(deviceWs as any, JSON.stringify({
      type: "device_status",
      status_id: "status_ws_1",
      payload: {
        app_id: "com.reader",
        app_name: "Reader",
        window_title: "Reading",
        extra: { device: { network_type: "Wi-Fi" } },
      },
    }));
    realtimeWebSocket.close(deviceWs as any);
    realtimeWebSocket.close(viewerWs as any);

    expect(deviceFrames.at(-1)).toMatchObject({
      type: "ack",
      status: "status_received",
      status_id: "status_ws_1",
    });
    expect(viewerFrames).toContainEqual(expect.objectContaining({
      type: "device_update",
      device_id: deviceId,
      payload: expect.objectContaining({
        app_id: "com.reader",
      }),
    }));
    const state = db.prepare("SELECT app_id FROM device_states WHERE device_id = ?")
      .get(deviceId) as { app_id: string } | undefined;
    expect(state?.app_id).toBe("com.reader");
  });

  test("sleeping Android devices use the extended offline threshold", async () => {
    const { processReportPayload } = await import("../src/services/device-status-handler");
    const { db, markOfflineDevices } = await import("../src/db");
    const device = {
      device_id: "sleeping-phone",
      device_name: "Phone",
      platform: "android" as const,
    };

    processReportPayload({
      app_id: "sleeping",
      window_title: "(-.-)zzZ",
      extra: { sleeping: true },
    }, device);

    db.prepare("UPDATE device_states SET last_seen_at = datetime('now', '-5 minutes'), is_online = 1 WHERE device_id = ?").run(device.device_id);
    markOfflineDevices.run();
    let state = db.prepare("SELECT is_online FROM device_states WHERE device_id = ?").get(device.device_id) as { is_online: number };
    expect(state.is_online).toBe(1);

    db.prepare("UPDATE device_states SET last_seen_at = datetime('now', '-21 minutes'), is_online = 1 WHERE device_id = ?").run(device.device_id);
    markOfflineDevices.run();
    state = db.prepare("SELECT is_online FROM device_states WHERE device_id = ?").get(device.device_id) as { is_online: number };
    expect(state.is_online).toBe(0);
  });

  test("reported offline timeout controls device online threshold", async () => {
    const { processReportPayload } = await import("../src/services/device-status-handler");
    const { db, markOfflineDevices } = await import("../src/db");
    const device = {
      device_id: "sleeping-watch",
      device_name: "Watch",
      platform: "zepp" as const,
    };

    processReportPayload({
      app_id: "zepp_watch",
      window_title: "手表在线",
      extra: {
        sleeping: true,
        device: {
          profile: "android_normal",
          energy_policy: "zepp_sleep_30m_alarm",
          offline_timeout_minutes: 35,
        },
      },
    }, device);

    db.prepare("UPDATE device_states SET last_seen_at = datetime('now', '-34 minutes'), is_online = 1 WHERE device_id = ?").run(device.device_id);
    markOfflineDevices.run();
    let state = db.prepare("SELECT is_online FROM device_states WHERE device_id = ?").get(device.device_id) as { is_online: number };
    expect(state.is_online).toBe(1);

    db.prepare("UPDATE device_states SET last_seen_at = datetime('now', '-36 minutes'), is_online = 1 WHERE device_id = ?").run(device.device_id);
    markOfflineDevices.run();
    state = db.prepare("SELECT is_online FROM device_states WHERE device_id = ?").get(device.device_id) as { is_online: number };
    expect(state.is_online).toBe(0);
  });

  test("reported offline timeout over max is ignored and returned as an error", async () => {
    const { processReportPayload, ReportPayloadError } = await import("../src/services/device-status-handler");
    const { db } = await import("../src/db");
    const device = {
      device_id: "bad-timeout-watch",
      device_name: "Watch",
      platform: "zepp" as const,
    };

    expect(() => processReportPayload({
      app_id: "zepp_watch",
      window_title: "手表在线",
      extra: {
        device: {
          network_type: "Zepp Bridge",
          offline_timeout_minutes: 61,
        },
      },
    }, device)).toThrow(ReportPayloadError);

    const state = db.prepare("SELECT extra FROM device_states WHERE device_id = ?").get(device.device_id) as { extra: string } | undefined;
    expect(state?.extra).toContain("Zepp Bridge");
    expect(state?.extra).not.toContain("offline_timeout_minutes");
  });

  test("reported offline timeout rejects fractional values outside the contract", async () => {
    const { processReportPayload, ReportPayloadError } = await import("../src/services/device-status-handler");
    const device = {
      device_id: "fractional-timeout-watch",
      device_name: "Watch",
      platform: "zepp" as const,
    };

    expect(() => processReportPayload({
      app_id: "zepp_watch",
      window_title: "手表在线",
      extra: { device: { offline_timeout_minutes: 60.4 } },
    }, device)).toThrow(ReportPayloadError);

    expect(() => processReportPayload({
      app_id: "zepp_watch",
      window_title: "手表在线",
      extra: { device: { offline_timeout_minutes: 0.5 } },
    }, device)).toThrow(ReportPayloadError);
  });
});

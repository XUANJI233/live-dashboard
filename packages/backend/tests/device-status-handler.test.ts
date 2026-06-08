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
          capability_mode: "lsposed",
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
      capability_mode: "lsposed",
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
});

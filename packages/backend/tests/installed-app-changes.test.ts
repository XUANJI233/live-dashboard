import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempDir = mkdtempSync(join(tmpdir(), "live-installed-changes-"));
process.env.DB_PATH = join(tempDir, "test.db");
process.env.HASH_SECRET = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");

const device = { device_id: "apps-phone", device_name: "Apps Phone", platform: "android" as const };

function snapshot(packages: string[], updatedAt: string) {
  return {
    app_id: "com.reader",
    window_title: "Reading",
    extra: {
      device: {
        profile: "android_lsp",
        installed_apps_updated_at: updatedAt,
        installed_apps: packages.map((name) => ({ package_name: name, app_name: name.split(".").at(-1) })),
      },
    },
  };
}

describe("installed app changes", () => {
  afterAll(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // The shared Bun test process may keep SQLite handles open briefly.
    }
  });

  test("records adds and removals between snapshots, ignoring the first snapshot and reports without a list", async () => {
    const { processReportPayload } = await import("../src/services/device-status-handler");
    const { getDeviceInstalledApps, listDeviceContexts } = await import("../src/services/device-context");
    const firstAt = new Date(Date.now() - 60 * 60_000).toISOString();

    processReportPayload(snapshot(["com.example.reader", "com.taobao.taobao"], firstAt), device);
    expect(getDeviceInstalledApps(device.device_id).changes).toMatchObject({ total_count: 0, changes: [] });
    const firstSeen = listDeviceContexts().find((item) => item.device_id === device.device_id)?.first_seen_at;
    expect(Number.isNaN(Date.parse(String(firstSeen)))).toBe(false);

    // Heartbeats and an empty list carry no inventory and must not look like mass removals.
    processReportPayload({ app_id: "com.reader", extra: { device: { heartbeat_only: true } } }, device);
    processReportPayload(snapshot([], new Date().toISOString()), device);
    expect(getDeviceInstalledApps(device.device_id).changes.total_count).toBe(0);

    processReportPayload(snapshot(["com.example.reader", "com.zhiliaoapp.musically"], new Date().toISOString()), device);
    const changes = getDeviceInstalledApps(device.device_id).changes;
    expect(changes.total_count).toBe(2);
    expect(changes.changes.map((change) => [change.change, change.package_name, change.previous_snapshot_at]).sort()).toEqual([
      ["installed", "com.zhiliaoapp.musically", firstAt],
      ["removed", "com.taobao.taobao", firstAt],
    ]);
    // A later report keeps the device's first-seen time.
    expect(listDeviceContexts().find((item) => item.device_id === device.device_id)?.first_seen_at).toBe(firstSeen);
  });

  test("reinstalling shows as a removal followed by an install in the controller context", async () => {
    const { processReportPayload } = await import("../src/services/device-status-handler");
    const { getControllerContext } = await import("../src/services/controller-context");
    const phone = { ...device, device_id: "reinstall-phone" };
    processReportPayload(snapshot(["com.example.reader", "com.taobao.taobao"], new Date().toISOString()), phone);
    processReportPayload(snapshot(["com.example.reader"], new Date().toISOString()), phone);
    processReportPayload(snapshot(["com.example.reader", "com.taobao.taobao"], new Date().toISOString()), phone);

    const context = getControllerContext({ mode: "policy" }) as {
      installed_changes: { window_days: number; changes: Array<{ device_id: string; package_name: string; change: string }> };
    };
    expect(context.installed_changes.window_days).toBe(7);
    expect(context.installed_changes.changes
      .filter((change) => change.device_id === phone.device_id)
      .map((change) => `${change.change} ${change.package_name}`))
      .toEqual(["installed com.taobao.taobao", "removed com.taobao.taobao"]);
  });

  test("keeps changes for 30 days and leaves older ones to cleanup", async () => {
    const { db } = await import("../src/db");
    const { cleanupOldInstalledAppChanges } = await import("../src/services/installed-app-changes");
    db.prepare(`
      INSERT INTO installed_app_changes (device_id, package_name, change, detected_at, created_at)
      VALUES ('old-phone', 'com.old', 'removed', '2026-01-01T00:00:00.000Z', datetime('now', '-31 days'))
    `).run();
    db.prepare(`
      INSERT INTO installed_app_changes (device_id, package_name, change, detected_at, created_at)
      VALUES ('old-phone', 'com.recent', 'removed', '2026-01-01T00:00:00.000Z', datetime('now', '-29 days'))
    `).run();
    cleanupOldInstalledAppChanges.run();
    const left = db.prepare("SELECT package_name FROM installed_app_changes WHERE device_id = 'old-phone'").all() as Array<{ package_name: string }>;
    expect(left.map((row) => row.package_name)).toEqual(["com.recent"]);
  });
});

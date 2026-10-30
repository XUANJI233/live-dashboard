import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempDir = mkdtempSync(join(tmpdir(), "live-usage-today-"));
process.env.DB_PATH = join(tempDir, "test.db");
process.env.HASH_SECRET = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");

describe("usage_today in frequent controller contexts", () => {
  afterAll(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // The shared Bun test process may keep SQLite handles open briefly.
    }
  });

  test("carries the local day so far beside the one-hour digest", async () => {
    const { db } = await import("../src/db");
    const { getControllerContext } = await import("../src/services/controller-context");
    const nowMs = Date.now();
    // Pick an offset that makes local time noon, so 09:00 is today but outside the 60-minute window.
    const utcMinutes = Math.floor((nowMs % 86_400_000) / 60_000);
    const timezoneOffset = utcMinutes - 720;
    db.prepare(`
      INSERT INTO device_states (device_id, device_name, platform, app_id, app_name, window_title, display_title, last_seen_at, extra, is_online)
      VALUES ('today-phone', 'Phone', 'android', 'idle', 'idle', '', '', ?, '{}', 1)
    `).run(new Date(nowMs).toISOString());
    const insert = db.prepare(`
      INSERT INTO activities (device_id, device_name, platform, app_id, app_name, window_title, display_title, extra, title_hash, time_bucket, started_at)
      VALUES ('today-phone', 'Phone', 'android', ?, ?, '', '', '{}', ?, ?, ?)
    `);
    let bucket = 0;
    const add = (minutesAgo: number, appId: string, appName: string) =>
      insert.run(appId, appName, crypto.randomUUID(), bucket++, new Date(nowMs - minutesAgo * 60_000).toISOString());
    for (const minutesAgo of [180, 175, 170, 165, 160, 155]) add(minutesAgo, "com.qidian.QDReader", "起点读书");
    add(150, "idle", "idle");
    for (const minutesAgo of [30, 25, 20]) add(minutesAgo, "com.example.study", "Study");
    add(15, "sleeping", "sleeping");

    const context = getControllerContext({ mode: "supervision", window_minutes: 60, timezone_offset_minutes: timezoneOffset }) as Record<string, any>;
    const today = context.usage_today;
    expect(today.schema).toBe("live_dashboard.usage_today.v1");
    expect(today.range.end.slice(0, 16)).toBe(new Date(nowMs).toISOString().slice(0, 16));
    const phone = today.devices.find((device: { device_id: string }) => device.device_id === "today-phone");
    expect(phone).toMatchObject({ active_minutes: 45, idle_minutes: 2 });
    expect(phone.top_apps.map((app: { app_name: string; minutes: number }) => [app.app_name, app.minutes]))
      .toEqual([["起点读书", 30], ["Study", 15]]);
    expect(Object.keys(phone.class_minutes)).toEqual(["blacklist", "risk", "target", "whitelist", "unclassified"]);

    const digestPhone = context.usage_digest.devices.find((device: { device_id: string }) => device.device_id === "today-phone");
    expect(digestPhone.top_apps.map((app: { app_name: string }) => app.app_name)).toEqual(["Study"]);

    const daily = getControllerContext({ mode: "daily", timezone_offset_minutes: timezoneOffset }) as Record<string, unknown>;
    expect(daily.usage_today).toBeUndefined();
  });
});

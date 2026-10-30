import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempDir = mkdtempSync(join(tmpdir(), "live-activity-history-"));
process.env.DB_PATH = join(tempDir, "test.db");
process.env.HASH_SECRET = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");

// Local UTC+08:00 Monday 2026-10-26 00:00 is 2026-10-25T16:00:00Z.
const localMidnight = Date.parse("2026-10-25T16:00:00.000Z");
const now = new Date(localMidnight + 3 * 24 * 60 * 60_000);
const SECRET = "SECRET-WINDOW-TITLE";

function at(localTime: string): string {
  const [day, clock] = localTime.split(" ") as [string, string];
  const [hour, minute] = clock.split(":").map(Number) as [number, number];
  const dayOffset = Number(day.slice(-2)) - 26;
  return new Date(localMidnight + ((dayOffset * 24 + hour) * 60 + minute) * 60_000).toISOString();
}

async function seed() {
  const { db } = await import("../src/db");
  const insertDevice = db.prepare(`
    INSERT INTO device_states (device_id, device_name, platform, app_id, app_name, window_title, display_title, last_seen_at, extra, is_online)
    VALUES (?, ?, ?, 'idle', 'idle', '', '', ?, '{}', 1)
  `);
  const insertActivity = db.prepare(`
    INSERT INTO activities (device_id, device_name, platform, app_id, app_name, window_title, display_title, extra, title_hash, time_bucket, started_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let bucket = 0;
  const add = (deviceId: string, platform: string, local: string, appId: string, appName: string, title = "", extra = "{}") => {
    insertActivity.run(deviceId, deviceId, platform, appId, appName, `${SECRET} ${title}`, title, extra, crypto.randomUUID(), bucket++, at(local));
  };
  insertDevice.run("phone", "Phone", "android", now.toISOString());
  insertDevice.run("pc", "PC", "windows", now.toISOString());
  for (const minute of [0, 5, 10, 15, 20, 25]) {
    add("phone", "android", `2026-10-26 09:${String(minute).padStart(2, "0")}`, "com.qidian.QDReader", "起点读书", "第一章");
  }
  add("phone", "android", "2026-10-26 09:30", "com.taobao.taobao", "淘宝");
  add("phone", "android", "2026-10-26 09:32", "idle", "idle");
  add("phone", "android", "2026-10-26 10:30", "com.qidian.QDReader", "起点读书", "第二章");
  add("phone", "android", "2026-10-26 10:33", "sleeping", "sleeping");
  add("phone", "android", "2026-10-26 23:58", "tv.danmaku.bili", "哔哩哔哩", "线性代数 第三章", JSON.stringify({
    media: { playing: true, app: "网易云音乐", package_name: "com.netease.cloudmusic", title: "Song A" },
  }));
  add("phone", "android", "2026-10-27 00:03", "tv.danmaku.bili", "哔哩哔哩", "猫咪视频");
  add("phone", "android", "2026-10-27 00:06", "idle", "idle");
  for (let minute = 0; minute <= 20; minute += 1) {
    add("pc", "windows", `2026-10-26 09:${String(minute).padStart(2, "0")}`, "Code.exe", "VS Code", "live-dashboard");
  }
}

async function history(args: Record<string, unknown>) {
  const { getActivityHistory } = await import("../src/services/activity-history");
  return getActivityHistory({ view: "usage", start: "2026-10-26", end: "2026-11-02", ...args } as never, now) as Record<string, any>;
}

describe("get_activity_history", () => {
  beforeAll(seed);

  afterAll(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // The shared Bun test process may keep SQLite handles open briefly.
    }
  });

  test("sums an app's week in local time, excludes idle and sleeping, and reports coverage", async () => {
    const result = await history({ app: "起点" });

    expect(result.timezone).toEqual({ offset_minutes: -480, label: "UTC+08:00", source: "default" });
    expect(result.range).toMatchObject({
      start: "2026-10-25T16:00:00.000Z",
      end: now.toISOString(),
      start_local: "2026-10-26 00:00",
      end_clamped_to_now: true,
    });
    expect(result.totals).toEqual({ matched_minutes: 33, matched_sessions: 2 });
    expect(result.groups).toEqual([{
      device_id: "phone",
      app_name: "起点读书",
      app_id: "com.qidian.QDReader",
      minutes: 33,
      sessions: 2,
      first_start_local: "2026-10-26 09:00",
      last_start_local: "2026-10-26 10:30",
      last_end_local: "2026-10-26 10:33",
      open: false,
      started_before_range: false,
    }]);
    const phone = result.devices.find((device: { device_id: string }) => device.device_id === "phone");
    // 起点 33 + 淘宝 2 + 哔哩哔哩 8 active; idle, sleeping, and the last idle row each one lone minute.
    expect(phone).toMatchObject({ active_minutes: 43, idle_minutes: 3, matched_minutes: 33, matched_sessions: 2 });
    expect(phone.unobserved_minutes).toBe(3 * 24 * 60 - 46);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  test("reads offset-less times as local and explicit offsets as absolute", async () => {
    const local = await history({ start: "2026-10-26T09:00", end: "2026-10-26T09:30", app: "起点" });
    const absolute = await history({ start: "2026-10-26T01:00:00Z", end: "2026-10-26T09:30:00+08:00", app: "起点" });
    expect(local.totals).toEqual({ matched_minutes: 30, matched_sessions: 1 });
    expect(absolute.totals).toEqual(local.totals);
    expect(absolute.range.start).toBe(local.range.start);
  });

  test("filters by exact package and by display-title substring", async () => {
    expect((await history({ package: "COM.TAOBAO.TAOBAO" })).totals).toEqual({ matched_minutes: 2, matched_sessions: 1 });
    const titled = await history({ title_contains: "线性代数", group_by: "title" });
    expect(titled.groups).toHaveLength(1);
    expect(titled.groups[0]).toMatchObject({ app_name: "哔哩哔哩", title: "线性代数 第三章", minutes: 5 });
    // The raw window title is never searched.
    expect((await history({ title_contains: SECRET })).totals.matched_minutes).toBe(0);
  });

  test("splits local day buckets at local midnight", async () => {
    const result = await history({ app: "哔哩", group_by: "day" });
    expect(result.groups.map((group: Record<string, unknown>) => [group.bucket, group.minutes, (group.top_app as { app_name: string }).app_name]))
      .toEqual([["2026-10-26", 2, "哔哩哔哩"], ["2026-10-27", 6, "哔哩哔哩"]]);
    const hours = await history({ start: "2026-10-26T09:00", end: "2026-10-26T11:00", device_id: "phone", group_by: "hour" });
    expect(hours.groups.map((group: Record<string, unknown>) => [group.bucket, group.minutes, group.idle_minutes])).toEqual([
      ["2026-10-26 09:00", 32, 1],
      ["2026-10-26 10:00", 3, 1],
    ]);
  });

  test("pages usage groups with a cursor bound to the same arguments", async () => {
    const full = await history({});
    const first = await history({ limit: 2 });
    expect(first).toMatchObject({ group_count: full.group_count, returned_group_count: 2, truncated: true });
    const second = await history({ limit: 10, cursor: first.next_cursor });
    expect([...first.groups, ...second.groups]).toEqual(full.groups);
    expect(second.next_cursor).toBeNull();
    await expect(history({ app: "起点", cursor: first.next_cursor })).rejects.toThrow("invalid_cursor");
    await expect(history({ cursor: "not-a-cursor" })).rejects.toThrow("invalid_cursor");
  });

  test("pages timeline sessions in both orders and keeps background media", async () => {
    const newest = await history({ view: "timeline", device_id: "phone", limit: 1 });
    expect(newest).toMatchObject({ order: "newest_first", session_count: 1, has_more: true });
    expect(newest.timeline.timezone_label).toBe("UTC+08:00");
    expect(newest.timeline.devices[0].sessions[0]).toMatchObject({ app: "idle", activity_kind: "idle", start: "2026-10-27 00:06" });

    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await history({ view: "timeline", device_id: "phone", order: "oldest_first", limit: 3, ...(cursor ? { cursor } : {}) });
      for (const device of page.timeline.devices) {
        for (const session of device.sessions) seen.push(`${session.start} ${session.app}`);
      }
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
    expect(seen).toEqual([
      "2026-10-26 09:00 起点读书",
      "2026-10-26 09:30 淘宝",
      "2026-10-26 09:32 idle",
      "2026-10-26 10:30 起点读书",
      "2026-10-26 10:33 sleeping",
      "2026-10-26 23:58 哔哩哔哩",
      "2026-10-27 00:06 idle",
    ]);

    const filtered = await history({ view: "timeline", title_contains: "线性代数" });
    const session = filtered.timeline.devices[0].sessions[0];
    expect(session.items).toEqual([{
      time: "2026-10-26 23:58 - 2026-10-27 00:03",
      duration_minutes: 5,
      title: "线性代数 第三章",
      background_media: { app: "网易云音乐", package_name: "com.netease.cloudmusic", title: "Song A" },
    }]);
  });

  test("returns stable error codes and flags ranges older than retention", async () => {
    await expect(history({ device_id: "missing" })).rejects.toThrow("device_not_found");
    await expect(history({ start: "2026-10-01", end: "2026-10-20" })).rejects.toThrow("time_range_too_large");
    await expect(history({ start: "yesterday" })).rejects.toThrow("invalid_time");
    await expect(history({ start: "2026-02-30" })).rejects.toThrow("invalid_time");
    await expect(history({ start: "2026-10-27", end: "2026-10-26" })).rejects.toThrow("invalid_time_range");
    expect((await history({ start: "2026-10-19", end: "2026-10-27" })).retention.before_retention).toBe(true);
    expect((await history({})).retention.before_retention).toBe(false);
  });

  test("scans one device through the covering history index, which has no window_title", async () => {
    const { db } = await import("../src/db");
    const plan = db.prepare(`
      EXPLAIN QUERY PLAN
      SELECT id, started_at, app_id, app_name, display_title FROM activities
      WHERE device_id = ? AND started_at >= ? AND started_at < ? ORDER BY started_at ASC, id ASC
    `).all("phone", "2026-10-25", "2026-11-02") as Array<{ detail: string }>;
    expect(plan.map((step) => step.detail).join(" ")).toContain("COVERING INDEX idx_activities_device_history");
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'activities'").all() as Array<{ name: string }>;
    expect(indexes.map((index) => index.name)).not.toContain("idx_activities_device_started");
  });

  test("controller timelines default to UTC+08:00 instead of UTC", async () => {
    const { getTimelineContext } = await import("../src/services/device-context");
    const timeline = getTimelineContext({ start: at("2026-10-26 09:00"), end: at("2026-10-26 10:00"), deviceId: "phone" });
    expect(timeline.timeline.timezone_offset_minutes).toBe(-480);
    expect(timeline.timeline.devices[0]?.sessions[0]?.start).toBe("2026-10-26 09:00");
  });

  test("uses the saved summary timezone when the caller passes none", async () => {
    const { rememberSummaryTimezoneOffset } = await import("../src/services/daily-summary-gen");
    rememberSummaryTimezoneOffset(0);
    const result = await history({ start: "2026-10-26T01:00", end: "2026-10-26T01:30", app: "起点" });
    expect(result.timezone).toEqual({ offset_minutes: 0, label: "UTC+00:00", source: "saved_settings" });
    expect(result.totals.matched_minutes).toBe(30);
    const explicit = await history({ start: "2026-10-26T09:00", end: "2026-10-26T09:30", app: "起点", timezone_offset_minutes: -480 });
    expect(explicit.timezone.source).toBe("argument");
  });
});

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { TimelineSegment } from "../src/types";

const tempDir = mkdtempSync(join(tmpdir(), "live-usage-digest-"));
process.env.DB_PATH = join(tempDir, "test.db");
process.env.HASH_SECRET = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");

const start = Date.parse("2026-09-07T14:00:00.000Z");
const range = { start: "2026-09-07T14:00:00.000Z", end: "2026-09-07T15:00:00.000Z" };

function segment(deviceId: string, appId: string, appName: string, startMinute: number, minutes: number, title = ""): TimelineSegment {
  const startedAt = new Date(start + startMinute * 60_000);
  return {
    app_id: appId,
    app_name: appName,
    display_title: title,
    started_at: startedAt.toISOString(),
    ended_at: new Date(startedAt.getTime() + minutes * 60_000).toISOString(),
    duration_seconds: minutes * 60,
    duration_minutes: minutes,
    device_id: deviceId,
    device_name: deviceId,
  };
}

async function rules(overrides: Partial<Record<"whitelist_app_regex" | "blacklist_app_regex" | "risk_app_regex" | "target_app_regex", string[]>> = {}) {
  const { compileSupervisionRules } = await import("../src/services/supervision-patterns");
  return compileSupervisionRules({
    whitelist_app_regex: ["com\\.example\\.music"],
    blacklist_app_regex: ["com\\.example\\.video"],
    risk_app_regex: ["com\\.example\\.game"],
    target_app_regex: ["com\\.example\\.study", "线性代数"],
    ...overrides,
  });
}

describe("usage digest", () => {
  afterAll(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // The shared Bun test process may keep SQLite handles open briefly.
    }
  });

  test("counts each segment once in the first matching policy class and ranks apps by minutes", async () => {
    const { buildUsageDigest } = await import("../src/services/usage-digest");
    const digest = buildUsageDigest([
      segment("phone", "com.example.study", "Study", 0, 20),
      segment("phone", "com.example.video", "Video", 20, 6),
      // Blacklist outranks the target title match.
      segment("phone", "com.example.video", "Video", 26, 4, "线性代数 第三章"),
      segment("phone", "com.example.game", "Game", 30, 5),
      segment("phone", "com.example.music", "Music", 35, 3),
      segment("phone", "com.example.reader", "Reader", 38, 12),
    ], await rules(), range);

    expect(digest).toMatchObject({ schema: "live_dashboard.usage_digest.v1", range, truncated: false, available_device_count: 1 });
    const phone = digest.devices[0]!;
    expect(phone.active_minutes).toBe(50);
    expect(phone.class_minutes).toEqual({ blacklist: 10, risk: 5, target: 20, whitelist: 3, unclassified: 12 });
    expect(phone.top_apps.map((app) => [app.app_name, app.minutes, app.class])).toEqual([
      ["Study", 20, "target"],
      ["Reader", 12, "unclassified"],
      ["Video", 10, "blacklist"],
      ["Game", 5, "risk"],
      ["Music", 3, "whitelist"],
    ]);
    expect(phone.app_count).toBe(5);
    expect(phone.switches).toBe(4);
    expect(phone.current).toEqual({
      app_id: "com.example.reader",
      app_name: "Reader",
      minutes: 12,
      class: "unclassified",
      since: "2026-09-07T14:38:00.000Z",
    });
  });

  test("lists the requested device first, then the most active devices", async () => {
    const { buildUsageDigest } = await import("../src/services/usage-digest");
    const segments = [
      segment("phone", "com.example.study", "Study", 0, 30),
      segment("pc", "Code.exe", "VS Code", 0, 10),
      segment("tablet", "com.example.reader", "Reader", 0, 20),
    ];
    const ranked = buildUsageDigest(segments, await rules(), range);
    expect(ranked.devices.map((device) => device.device_id)).toEqual(["phone", "tablet", "pc"]);
    const preferred = buildUsageDigest(segments, await rules(), { ...range, preferDeviceId: "pc" });
    expect(preferred.devices.map((device) => device.device_id)).toEqual(["pc", "phone", "tablet"]);
  });

  test("material signature tolerates small minute changes but changes for new apps, class changes and quarter-hour shifts", async () => {
    const { materialUsageSignature } = await import("../src/services/usage-digest");
    const base = materialUsageSignature([segment("phone", "com.example.study", "Study", 0, 30)], await rules());

    // Same 15-minute bucket: a few more minutes of the same app is not new information.
    expect(materialUsageSignature([segment("phone", "com.example.study", "Study", 0, 40)], await rules())).toBe(base);
    // A quarter hour more of the same app is.
    expect(materialUsageSignature([segment("phone", "com.example.study", "Study", 0, 45)], await rules())).not.toBe(base);
    // A short visit stays below the five-minute materiality floor.
    expect(materialUsageSignature([
      segment("phone", "com.example.study", "Study", 0, 30),
      segment("phone", "com.example.reader", "Reader", 30, 3),
    ], await rules())).toBe(base);
    expect(materialUsageSignature([
      segment("phone", "com.example.study", "Study", 0, 30),
      segment("phone", "com.example.reader", "Reader", 30, 6),
    ], await rules())).not.toBe(base);
    expect(materialUsageSignature(
      [segment("phone", "com.example.study", "Study", 0, 30)],
      await rules({ blacklist_app_regex: ["com\\.example\\.study"] }),
    )).not.toBe(base);
  });
});

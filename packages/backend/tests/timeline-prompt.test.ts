import { describe, expect, test } from "bun:test";
import type { TimelineSegment } from "../src/types";
import { buildTimelinePromptDocument, timelineJsonBlockForPrompt } from "../src/services/timeline-prompt";

describe("timeline-prompt", () => {
  test("groups timeline by device and consecutive foreground app sessions", () => {
    const doc = buildTimelinePromptDocument([
      segment({
        device_id: "phone",
        device_name: "Phone",
        app_id: "com.bilibili.app",
        app_name: "哔哩哔哩",
        display_title: "视频 A",
        started_at: "2026-06-08T02:00:00.000Z",
        ended_at: "2026-06-08T02:20:00.000Z",
        duration_seconds: 1200,
      }),
      segment({
        device_id: "phone",
        device_name: "Phone",
        app_id: "com.bilibili.app",
        app_name: "哔哩哔哩",
        display_title: "视频 B",
        started_at: "2026-06-08T02:20:00.000Z",
        ended_at: "2026-06-08T02:30:00.000Z",
        duration_seconds: 600,
      }),
      segment({
        device_id: "pc",
        device_name: "PC",
        app_id: "Code.exe",
        app_name: "VS Code",
        display_title: "live-dashboard",
        started_at: "2026-06-08T02:05:00.000Z",
        ended_at: "2026-06-08T02:35:00.000Z",
        duration_seconds: 1800,
      }),
    ], { tzOffsetMinutes: -480, label: "test_timeline" });

    expect(doc.schema).toBe("timeline.v2.device_app_sessions");
    expect(doc.timezone_offset_minutes).toBe(-480);
    expect(doc.devices.map((device) => device.device_id)).toEqual(["pc", "phone"]);

    const phone = doc.devices.find((device) => device.device_id === "phone");
    expect(phone?.sessions).toHaveLength(1);
    expect(phone?.sessions[0]?.app).toBe("哔哩哔哩");
    expect(phone?.sessions[0]?.duration_minutes).toBe(30);
    expect(phone?.sessions[0]?.items).toEqual([
      { time: "2026-06-08 10:00 - 2026-06-08 10:20", duration_minutes: 20, title: "视频 A" },
      { time: "2026-06-08 10:20 - 2026-06-08 10:30", duration_minutes: 10, title: "视频 B" },
    ]);
  });

  test("keeps background media inside the foreground session item", () => {
    const doc = buildTimelinePromptDocument([
      segment({
        app_id: "com.reader",
        app_name: "阅读",
        display_title: "论文",
        extra: {
          media: {
            playing: true,
            app: "网易云音乐",
            package_name: "com.netease.cloudmusic",
            title: "Song A",
            artist: "Artist A",
            state: "playing",
          },
        },
      }),
    ], { tzOffsetMinutes: 0 });

    expect(doc.devices[0]?.sessions[0]?.items[0]?.background_media).toEqual({
      app: "网易云音乐",
      package_name: "com.netease.cloudmusic",
      title: "Song A",
      artist: "Artist A",
      state: "playing",
    });
  });

  test("wraps JSON with a stable XML-like delimiter for prompt isolation", () => {
    const block = timelineJsonBlockForPrompt([segment({})], { label: "today" });
    expect(block.startsWith('<timeline_json schema="timeline.v2.device_app_sessions" label="today">')).toBe(true);
    expect(block.endsWith("</timeline_json>")).toBe(true);
    expect(block).toContain('"devices"');
  });
});

function segment(overrides: Partial<TimelineSegment>): TimelineSegment {
  return {
    app_id: "app",
    app_name: "App",
    display_title: "",
    started_at: "2026-06-08T00:00:00.000Z",
    ended_at: "2026-06-08T00:01:00.000Z",
    duration_seconds: 60,
    duration_minutes: 1,
    device_id: "device",
    device_name: "Device",
    ...overrides,
  };
}

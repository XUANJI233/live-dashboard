import { describe, expect, test } from "bun:test";
import { fitControllerContextToMcpBudget } from "../src/services/controller-context-budget";

describe("controller context transport budget", () => {
  test("keeps the newest decision events while removing older oversized history", () => {
    const events = Array.from({ length: 24 }, (_, index) => ({
      event_id: `event-${index}`,
      event_type: "visitor_message",
      occurred_at: new Date(index * 1_000).toISOString(),
      payload: { text: `记录 ${index} ${"具体上下文".repeat(220)}` },
    }));
    const context = fitControllerContextToMcpBudget({
      schema: "live_dashboard.controller_context.v1",
      generated_at: "2026-09-03T00:00:00.000Z",
      mode: "supervision",
      controller_active: true,
      settings: { supervision_enabled: true },
      persona: { enabled: true },
      rest_state: "active",
      available_device_count: 1,
      returned_device_count: 1,
      devices: [{ device_id: "android-main", frozen_packages: [] }],
      timeline: {
        segment_count: 0,
        prebudget_segment_count: 0,
        returned_segment_count: 0,
        timeline: { devices: [] },
      },
      recent_events: {
        has_more: false,
        prebudget_event_count: events.length,
        returned_event_count: events.length,
        events,
      },
    }, []);
    const recentEvents = context.recent_events as {
      events: Array<{ event_id: string }>;
      returned_event_count: number;
    };

    expect(new TextEncoder().encode(JSON.stringify(context)).byteLength).toBeLessThanOrEqual(24_000);
    expect(recentEvents.events.at(-1)?.event_id).toBe("event-23");
    expect(recentEvents.returned_event_count).toBe(recentEvents.events.length);
  });

  test("falls back to a fixed valid envelope for pathological caller text", () => {
    const context = fitControllerContextToMcpBudget({
      schema: "live_dashboard.controller_context.v1",
      generated_at: "时间".repeat(100_000),
      mode: "supervision",
      controller_active: true,
      settings: {
        supervision_enabled: true,
        target: "目标".repeat(100_000),
      },
      persona: {
        enabled: true,
        persona: "人设".repeat(100_000),
      },
      rest_state: "active",
      available_device_count: 0,
      returned_device_count: 0,
      devices: [],
      timeline: { segment_count: 0, timeline: { devices: [] } },
      recent_events: { events: [] },
    }, []);

    expect(new TextEncoder().encode(JSON.stringify(context)).byteLength).toBeLessThanOrEqual(24_000);
    expect(context.generated_at.length).toBeLessThanOrEqual(40);
    expect(context.bounds).toMatchObject({
      truncated: true,
      decision_complete: false,
      followup_required: false,
    });
  });

  test("keeps what is due in the ledger even in the fixed fallback envelope", () => {
    const due = Array.from({ length: 3 }, (_, index) => ({
      record_id: `led_00000000-0000-4000-8000-00000000000${index}`,
      kind: "promise",
      title: `第${index}件到点的事${"很长".repeat(40)}`,
      detail: "细节".repeat(100),
      due_at: "2026-10-30T12:00:00.000Z",
      due_local: "2026-10-30 20:00",
      overdue_minutes: 5,
    }));
    const context = fitControllerContextToMcpBudget({
      schema: "live_dashboard.controller_context.v1",
      generated_at: "时间".repeat(100_000),
      mode: "supervision",
      controller_active: true,
      settings: { supervision_enabled: true },
      persona: { enabled: true },
      rest_state: "active",
      ledger: { due_now: due, open: [], track: { kept_streak: 2 } },
      available_device_count: 0,
      returned_device_count: 0,
      devices: [],
      timeline: { segment_count: 0, timeline: { devices: [] } },
      recent_events: { events: [] },
    }, []);
    const ledger = context.ledger as { due_now: Array<Record<string, unknown>> };

    expect(new TextEncoder().encode(JSON.stringify(context)).byteLength).toBeLessThanOrEqual(24_000);
    expect(context.bounds.truncated_sections).toContain("ledger");
    expect(ledger.due_now.map((item) => item.record_id)).toEqual(due.map((item) => item.record_id));
    expect(ledger.due_now[0]).toEqual({
      record_id: due[0]!.record_id,
      kind: "promise",
      title: expect.stringMatching(/^第0件到点的事.{0,32}…$/),
      due_at: "2026-10-30T12:00:00.000Z",
    });
  });

  test("retains one oversized latest session and clips text on code-point boundaries", () => {
    const items = Array.from({ length: 80 }, (_, index) => ({
      time: `2026-09-03 00:${String(index % 60).padStart(2, "0")}`,
      duration_minutes: 1,
      title: `${"内容".repeat(180)}😀${index}`,
    }));
    const context = fitControllerContextToMcpBudget({
      schema: "live_dashboard.controller_context.v1",
      generated_at: "2026-09-03T00:00:00.000Z",
      mode: "daily",
      controller_active: true,
      settings: {
        supervision_enabled: true,
        target: `${"a".repeat(498)}😀xx`,
      },
      persona: { enabled: true, persona: "人设".repeat(20_000) },
      rest_state: "active",
      available_device_count: 1,
      returned_device_count: 1,
      devices: [{ device_id: "android-main", frozen_packages: [] }],
      timeline: {
        segment_count: 80,
        prebudget_segment_count: 80,
        returned_segment_count: 80,
        timeline: {
          devices: [{
            device_id: "android-main",
            sessions: [{
              app: "Reader",
              start: "2026-09-03 00:00",
              segment_count: 80,
              items,
            }],
          }],
        },
      },
      recent_events: { events: [], returned_event_count: 0 },
    }, []);
    const timeline = context.timeline as {
      segment_count: number;
      timeline: { devices: Array<{ sessions: Array<{ items: unknown[]; items_truncated?: boolean }> }> };
    };
    const target = (context.settings as { target: string }).target;

    expect(new TextEncoder().encode(JSON.stringify(context)).byteLength).toBeLessThanOrEqual(24_000);
    expect(timeline.timeline.devices).toHaveLength(1);
    expect(timeline.timeline.devices[0]?.sessions).toHaveLength(1);
    expect(timeline.timeline.devices[0]?.sessions[0]?.items).toHaveLength(3);
    expect(timeline.timeline.devices[0]?.sessions[0]?.items_truncated).toBe(true);
    expect(timeline.segment_count).toBe(80);
    expect(target.endsWith("…")).toBe(true);
    expect(target).not.toMatch(/[\uD800-\uDBFF]…$/);
  });

  test("trims today's running usage and old installed-app changes before dropping devices", () => {
    const app = (index: number) => ({
      app_id: `com.example.${"long.package.name.".repeat(6)}${index}`,
      app_name: `应用 ${"很长的应用名称".repeat(6)} ${index}`,
      minutes: 10 + index,
      class: "unclassified",
    });
    const usageDevice = (index: number) => ({
      device_id: `device-${index}`,
      active_minutes: 120,
      idle_minutes: 30,
      class_minutes: { blacklist: 0, risk: 0, target: 60, whitelist: 0, unclassified: 60 },
      top_apps: Array.from({ length: 6 }, (_, appIndex) => app(appIndex)),
    });
    const devices = Array.from({ length: 6 }, (_, index) => ({ device_id: `device-${index}`, frozen_packages: [] }));
    const context = fitControllerContextToMcpBudget({
      schema: "live_dashboard.controller_context.v1",
      generated_at: "2026-09-03T00:00:00.000Z",
      mode: "supervision",
      controller_active: true,
      settings: { supervision_enabled: true },
      persona: { enabled: true },
      rest_state: "active",
      available_device_count: devices.length,
      returned_device_count: devices.length,
      devices,
      usage_digest: { devices: Array.from({ length: 6 }, (_, index) => usageDevice(index)) },
      usage_today: { date: "2026-09-03", devices: Array.from({ length: 6 }, (_, index) => usageDevice(index)) },
      installed_changes: {
        window_days: 7,
        total_count: 20,
        returned_count: 20,
        has_more: false,
        changes: Array.from({ length: 20 }, (_, index) => ({
          device_id: "device-0",
          package_name: `com.example.${"installed.package.".repeat(60)}${index}`,
          app_name: `App ${index}`,
          change: index % 2 === 0 ? "installed" : "removed",
          detected_at: new Date(Date.UTC(2026, 8, 3, 0, 20 - index)).toISOString(),
          previous_snapshot_at: "",
        })),
      },
      timeline: { segment_count: 0, timeline: { devices: [] } },
      recent_events: { events: [], returned_event_count: 0 },
    }, []);
    const usageToday = context.usage_today as { truncated?: boolean; devices: Array<{ top_apps: unknown[] }> };
    const installed = context.installed_changes as { has_more: boolean; returned_count: number; changes: Array<{ package_name: string }> };

    expect(new TextEncoder().encode(JSON.stringify(context)).byteLength).toBeLessThanOrEqual(24_000);
    expect(context.bounds.truncated_sections).toEqual(expect.arrayContaining(["usage_today", "installed_changes"]));
    expect(context.bounds.truncated_sections).not.toContain("devices");
    expect(usageToday.truncated).toBe(true);
    expect(usageToday.devices.length).toBeGreaterThanOrEqual(2);
    expect(installed.has_more).toBe(true);
    expect(installed.returned_count).toBe(installed.changes.length);
    // Newest changes survive the trim.
    expect(installed.changes[0]?.package_name.endsWith(".0")).toBe(true);
    expect((context.devices as unknown[]).length).toBe(6);
  });
});

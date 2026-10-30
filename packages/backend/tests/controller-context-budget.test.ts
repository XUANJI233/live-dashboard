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

  test("trims listed enforcement before the review timeline, rule enforcement first, keeping totals", () => {
    const enforcementCommands = Array.from({ length: 36 }, (_, index) => ({
      at: new Date(Date.UTC(2026, 8, 2, 0, index)).toISOString(),
      device_id: "android-main",
      source: index % 3 === 0 ? "rule_enforcement" : "controller",
      say: `提醒 ${index} ${"回到论文第三节".repeat(10)}`,
      result: "applied",
    }));
    const totals = { controller: { commands: 24, say: 24 }, rule_enforcement: { commands: 12, freeze: 12 } };
    const sessions = Array.from({ length: 60 }, (_, index) => ({
      app: `Reader ${index}`,
      start: `2026-09-02 ${String(Math.floor(index / 4)).padStart(2, "0")}:${String((index % 4) * 15).padStart(2, "0")}`,
      segment_count: 1,
      items: [{ title: `${"阅读材料".repeat(40)} ${index}` }],
    }));
    const context = fitControllerContextToMcpBudget({
      schema: "live_dashboard.controller_context.v1",
      generated_at: "2026-09-03T00:00:00.000Z",
      mode: "daily",
      controller_active: true,
      settings: { supervision_enabled: true },
      persona: { enabled: true },
      rest_state: "active",
      available_device_count: 1,
      returned_device_count: 1,
      devices: [{ device_id: "android-main", frozen_packages: [] }],
      timeline: {
        segment_count: 60,
        prebudget_segment_count: 60,
        returned_segment_count: 60,
        timeline: { devices: [{ device_id: "android-main", sessions }] },
      },
      enforcement: {
        totals,
        command_count: 36,
        returned_count: 36,
        truncated: false,
        commands: enforcementCommands,
      },
      recent_events: { events: [], returned_event_count: 0 },
    }, []);
    const enforcement = context.enforcement as {
      totals: unknown;
      returned_count: number;
      truncated: boolean;
      commands: Array<{ at: string; source: string }>;
    };
    const timeline = context.timeline as { timeline: { devices: Array<{ sessions: unknown[] }> } };

    expect(new TextEncoder().encode(JSON.stringify(context)).byteLength).toBeLessThanOrEqual(24_000);
    expect(context.bounds.decision_complete).toBe(true);
    expect(context.bounds.truncated_sections).toContain("enforcement");
    expect(enforcement.totals).toEqual(totals);
    expect(enforcement.truncated).toBe(true);
    expect(enforcement.commands.length).toBeGreaterThanOrEqual(8);
    expect(enforcement.returned_count).toBe(enforcement.commands.length);
    expect(enforcement.commands.every((item) => item.source === "controller")).toBe(true);
    expect(enforcement.commands.at(-1)?.at).toBe(enforcementCommands.at(-1)?.at);
    expect(timeline.timeline.devices[0]?.sessions.length).toBeGreaterThanOrEqual(12);
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
});

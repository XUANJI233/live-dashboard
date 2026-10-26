import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempDir = mkdtempSync(join(tmpdir(), "live-controller-takeover-"));
process.env.DB_PATH = join(tempDir, "test.db");
process.env.HASH_SECRET = "a".repeat(64);
process.env.DEVICE_TOKEN_1 = "takeover-token:takeover-device:Takeover Android:android";

describe("Hermes controller takeover", () => {
  afterAll(() => {
    delete process.env.HERMES_CONTROLLER_ENABLED;
    delete process.env.CONTROLLER_WEBHOOK_ENABLED;
    delete process.env.CONTROLLER_WEBHOOK_URL;
    delete process.env.CONTROLLER_WEBHOOK_SECRET;
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // SQLite handles may still be open at process shutdown.
    }
  });

  test("sends an explicit device review request to Hermes without pre-judging it", async () => {
    const { getSummarySettings, saveSummarySettings } = await import("../src/services/daily-summary-gen");
    const { requestSupervisionCheckFromReportPayload } = await import("../src/services/supervision-report-trigger");
    saveSummarySettings({
      ...getSummarySettings(),
      supervision_enabled: true,
      supervision_heuristic_triggers: false,
      supervision_skip_watch_sleep: false,
      supervision_rules: {
        whitelist_app_regex: [],
        blacklist_app_regex: [],
        risk_app_regex: [],
        target_app_regex: [],
        reason: "Hermes owns the decision",
      },
    });

    process.env.HERMES_CONTROLLER_ENABLED = "true";
    process.env.CONTROLLER_WEBHOOK_ENABLED = "true";
    process.env.CONTROLLER_WEBHOOK_URL = "https://controller.example/webhooks/live-supervision";
    process.env.CONTROLLER_WEBHOOK_SECRET = "independent-controller-secret";
    const originalFetch = globalThis.fetch;
    const events: Record<string, unknown>[] = [];
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const event = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
      events.push(event);
      return Response.json({
        status: "accepted",
        ack: {
          schema: "live_dashboard.controller_ack.v1",
          v: 1,
          event_id: event.event_id,
          accepted: true,
        },
      }, { status: 202 });
    }) as typeof fetch;
    try {
      const accepted = requestSupervisionCheckFromReportPayload({
        app_id: "com.example.video",
        window_title: "private title must not leave Live",
        extra: {
          device: {
            profile: "android_lsp",
            supervision_check_requested: true,
          },
          foreground: {
            app_name: "Video",
            source: "lsposed",
          },
        },
      }, {
        device_id: "android-main",
        device_name: "Android",
        platform: "android",
      });
      expect(accepted).toBe(true);
      await Bun.sleep(0);
    } finally {
      globalThis.fetch = originalFetch;
    }

    const reviewEvents = events.filter((event) => event.event_type === "supervision.review_requested");
    expect(reviewEvents).toHaveLength(1);
    expect(reviewEvents[0]).toMatchObject({
      schema: "live_dashboard.controller_event.v1",
      v: 1,
      event_type: "supervision.review_requested",
      source: "report",
      device_ids: ["android-main"],
      reason_codes: ["device_requested"],
    });
    expect(JSON.stringify(reviewEvents[0])).not.toContain("private title");
    expect(JSON.stringify(reviewEvents[0])).not.toContain("com.example.video");
  });

  test("turns a scheduled threshold match into a Hermes review candidate without Live AI", async () => {
    const { db } = await import("../src/db");
    const { getSummarySettings, saveSummarySettings } = await import("../src/services/daily-summary-gen");
    const { runSupervisionTick } = await import("../src/services/supervision");
    const now = new Date("2026-07-03T13:31:00.000Z");
    const deviceId = "android-scheduled";
    process.env.HERMES_CONTROLLER_ENABLED = "true";
    process.env.CONTROLLER_WEBHOOK_ENABLED = "true";
    process.env.CONTROLLER_WEBHOOK_URL = "https://controller.example/webhooks/live-supervision";
    process.env.CONTROLLER_WEBHOOK_SECRET = "independent-controller-secret";
    db.prepare("DELETE FROM meta WHERE key LIKE 'supervision_last_%'").run();
    saveSummarySettings({
      ...getSummarySettings(),
      supervision_enabled: true,
      supervision_skip_watch_sleep: false,
      supervision_check_interval_minutes: 60,
      supervision_blacklist_minutes: 1,
      supervision_rules: {
        whitelist_app_regex: ["Code"],
        blacklist_app_regex: ["Video"],
        risk_app_regex: [],
        target_app_regex: ["Code"],
        reason: "deterministic candidate",
      },
    });
    db.prepare(`
      INSERT OR REPLACE INTO device_states (
        device_id, device_name, platform, app_id, app_name, window_title, display_title, last_seen_at, extra, is_online
      ) VALUES (?, 'Android', 'android', 'com.example.video', 'Video', '', 'Video', ?, ?, 1)
    `).run(deviceId, now.toISOString(), JSON.stringify({ device: { profile: "android_lsp" } }));
    const insertActivity = db.prepare(`
      INSERT INTO activities (
        device_id, device_name, platform, app_id, app_name, window_title, display_title, extra, title_hash, time_bucket, started_at
      ) VALUES (?, 'Android', 'android', ?, ?, '', ?, '{}', ?, ?, ?)
    `);
    insertActivity.run(deviceId, "com.example.video", "Video", "Video", "takeover-video", 1, new Date(now.getTime() - 20 * 60_000).toISOString());
    insertActivity.run(deviceId, "com.microsoft.vscode", "Code", "Code", "takeover-code", 2, new Date(now.getTime() - 5 * 60_000).toISOString());

    const originalFetch = globalThis.fetch;
    const events: Record<string, unknown>[] = [];
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = typeof input === "string" || input instanceof URL ? input.toString() : input.url;
      expect(url).toBe(process.env.CONTROLLER_WEBHOOK_URL!);
      const event = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
      events.push(event);
      return Response.json({
        status: "accepted",
        ack: {
          schema: "live_dashboard.controller_ack.v1",
          v: 1,
          event_id: event.event_id,
          accepted: true,
        },
      }, { status: 202 });
    }) as typeof fetch;
    try {
      const result = await runSupervisionTick(now, { source: "scheduled" });
      expect(result).toMatchObject({
        ok: true,
        ran: true,
        reason: "hermes_review_requested",
        source: "scheduled",
        ai_checked: false,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event_type: "supervision.review_requested",
      reason_codes: ["scheduled_check", "blacklist_threshold"],
    });
    expect(events[0]?.device_ids).toEqual(expect.arrayContaining([deviceId]));
  });

  test("does not send a quiet condition check to Hermes", async () => {
    const { db } = await import("../src/db");
    const { getSummarySettings, saveSummarySettings } = await import("../src/services/daily-summary-gen");
    const { runSupervisionTick } = await import("../src/services/supervision");
    const now = new Date("2026-07-04T13:31:00.000Z");
    const deviceId = "android-quiet-scheduled";
    process.env.HERMES_CONTROLLER_ENABLED = "true";
    process.env.CONTROLLER_WEBHOOK_ENABLED = "true";
    process.env.CONTROLLER_WEBHOOK_URL = "https://controller.example/webhooks/live-supervision";
    process.env.CONTROLLER_WEBHOOK_SECRET = "independent-controller-secret";
    db.prepare("DELETE FROM meta WHERE key LIKE 'supervision_last_%'").run();
    saveSummarySettings({
      ...getSummarySettings(),
      supervision_enabled: true,
      supervision_skip_watch_sleep: false,
      supervision_heuristic_triggers: false,
      supervision_check_interval_minutes: 30,
      supervision_blacklist_minutes: 5,
      supervision_risk_trigger_minutes: 5,
      supervision_rules: {
        whitelist_app_regex: ["Reader"],
        blacklist_app_regex: [],
        risk_app_regex: [],
        target_app_regex: [],
        reason: "quiet scheduled check",
      },
    });
    db.prepare(`
      INSERT OR REPLACE INTO device_states (
        device_id, device_name, platform, app_id, app_name, window_title, display_title, last_seen_at, extra, is_online
      ) VALUES (?, 'Android', 'android', 'com.example.reader', 'Reader', '', 'Reader', ?, ?, 1)
    `).run(deviceId, now.toISOString(), JSON.stringify({ device: { profile: "android_lsp" } }));
    const insertActivity = db.prepare(`
      INSERT INTO activities (
        device_id, device_name, platform, app_id, app_name, window_title, display_title, extra, title_hash, time_bucket, started_at
      ) VALUES (?, 'Android', 'android', 'com.example.reader', 'Reader', '', 'Reader', '{}', ?, ?, ?)
    `);
    insertActivity.run(deviceId, "quiet-reader-1", 1, new Date(now.getTime() - 20 * 60_000).toISOString());
    insertActivity.run(deviceId, "quiet-reader-2", 2, new Date(now.getTime() - 5 * 60_000).toISOString());

    const originalFetch = globalThis.fetch;
    let webhookCalls = 0;
    globalThis.fetch = (async (
      _input: Parameters<typeof fetch>[0],
      _init?: Parameters<typeof fetch>[1],
    ) => {
      webhookCalls += 1;
      return Response.json({ status: "unexpected" });
    }) as typeof fetch;
    try {
      const result = await runSupervisionTick(now, { source: "report" });
      expect(result).toMatchObject({
        ok: true,
        ran: false,
        reason: "trigger_not_met",
        source: "report",
      });
      expect(webhookCalls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("saves supervision settings and queues Hermes policy reconciliation", async () => {
    const { handleSummarySettingsUpdate } = await import("../src/routes/daily-summary");
    process.env.HERMES_CONTROLLER_ENABLED = "true";
    const response = await handleSummarySettingsUpdate(new Request("http://localhost/api/summary-settings", {
      method: "POST",
      headers: {
        Authorization: "Bearer takeover-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        supervision_enabled: true,
        supervision_check_interval_minutes: 60,
        client_updated_at: "2100-01-01T00:00:00.000Z",
      }),
    }));
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body.supervision_enabled).toBe(true);
    expect(body.rules_refresh_job).toMatchObject({
      kind: "supervision_rules_refresh",
      status: "queued",
    });
  });

  test("reports the active controller and fallback state to Hermes", async () => {
    const { getServiceSettings } = await import("../src/services/mcp-admin");
    process.env.HERMES_CONTROLLER_ENABLED = "true";
    process.env.CONTROLLER_WEBHOOK_ENABLED = "true";

    expect(getServiceSettings()).toMatchObject({
      controller_mode: {
        hermes_enabled: true,
        internal_ai_enabled: false,
        webhook_enabled: true,
      },
    });

    const { startServiceAiJob } = await import("../src/services/mcp-admin");
    expect(() => startServiceAiJob({ kind: "daily_summary", date: "2026-07-03" }))
      .toThrow("hermes_controller_active");
  });
});

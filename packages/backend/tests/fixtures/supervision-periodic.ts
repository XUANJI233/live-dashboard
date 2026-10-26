process.env.DB_PATH = ":memory:";
process.env.HASH_SECRET = "a".repeat(64);
process.env.HERMES_CONTROLLER_ENABLED = "true";
process.env.CONTROLLER_WEBHOOK_ENABLED = "true";
process.env.CONTROLLER_WEBHOOK_URL = "https://controller.example/webhooks/live-supervision";
process.env.CONTROLLER_WEBHOOK_SECRET = "periodic-test-controller-secret";

const scenario = process.argv[2];
const now = new Date("2026-09-07T14:00:00.000Z");
const deviceId = "periodic-test-phone";
const unmatchedAppId = "com.example.unclassified";
const riskAppId = "com.example.game";
let webhookCalls = 0;
let modelCalls = 0;

globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url = typeof input === "string" || input instanceof URL ? input.toString() : input.url;
  if (url !== process.env.CONTROLLER_WEBHOOK_URL) {
    modelCalls += 1;
    throw new Error(`Unexpected outbound request: ${url}`);
  }
  webhookCalls += 1;
  const event = JSON.parse(String(init?.body || "{}")) as { event_id: string };
  return Response.json({
    status: "accepted",
    ack: { schema: "live_dashboard.controller_ack.v1", v: 1, event_id: event.event_id, accepted: true },
  }, { status: 202 });
}) as typeof fetch;

const { db, metaSet } = await import("../../src/db");
const { getSummarySettings, saveSummarySettings } = await import("../../src/services/daily-summary-gen");
const { runSupervisionTick, requestSupervisionCheckForReport } = await import("../../src/services/supervision");
const { flushControllerEvents } = await import("../../src/services/controller-event-outbox");

function minutesAgo(minutes: number): string {
  return new Date(now.getTime() - minutes * 60_000).toISOString();
}

try {
  saveSummarySettings({
    ...getSummarySettings(),
    planned_rest: false,
    supervision_enabled: scenario !== "disabled",
    supervision_policy_owner: "hermes",
    supervision_heuristic_triggers: true,
    supervision_check_mode: "hourly",
    supervision_check_interval_minutes: 30,
    supervision_skip_watch_sleep: true,
    supervision_blacklist_minutes: 20,
    supervision_risk_trigger_minutes: 3,
    supervision_target_min_minutes: 25,
    supervision_rules: {
      whitelist_app_regex: [],
      blacklist_app_regex: [],
      risk_app_regex: ["com\\.example\\.game"],
      target_app_regex: [],
      reason: "Hermes-authored rule fixture does not classify the active app",
    },
  });
  metaSet("supervision_last_scheduled_ai_check_at", minutesAgo(
    scenario === "not_due" ? 29 : scenario === "screen_off_due" ? 120 : scenario?.startsWith("report_") ? 1 : 30,
  ));
  const screenOff = scenario === "screen_off" || scenario === "screen_off_due";
  const insertDevice = db.prepare(`
    INSERT INTO device_states (
      device_id, device_name, platform, app_id, app_name, window_title, display_title, last_seen_at, extra, is_online
    ) VALUES (?, ?, ?, ?, ?, '', ?, ?, ?, 1)
  `);
  if (scenario !== "no_devices") {
    insertDevice.run(deviceId, "Test phone", "android", screenOff ? "sleeping" : unmatchedAppId,
      "Unclassified", "Unclassified", now.toISOString(),
      JSON.stringify({ sleeping: screenOff, device: { profile: "android_lsp" } }));
  }
  if (scenario === "watch_sleeping") {
    insertDevice.run("periodic-test-watch", "Test watch", "zepp", "sleeping", "Sleeping", "Sleeping",
      now.toISOString(), "{}");
    db.prepare(`
      INSERT INTO health_records (device_id, type, value, unit, recorded_at, end_time)
      VALUES ('periodic-test-watch', 'sleep_status', 1, '', ?, '')
    `).run(now.toISOString());
  }
  if (scenario !== "no_timeline") {
    const insertActivity = db.prepare(`
      INSERT INTO activities (
        device_id, device_name, platform, app_id, app_name, window_title, display_title,
        extra, title_hash, time_bucket, started_at
      ) VALUES (?, 'Test phone', 'android', ?, 'Unclassified', '', 'Unclassified', '{}', 'periodic-test', ?, ?)
    `);
    for (let minute = 30; minute >= 1; minute -= 1) {
      insertActivity.run(deviceId, unmatchedAppId, minute, minutesAgo(minute));
    }
  }

  const results: Awaited<ReturnType<typeof runSupervisionTick>>[] = [];
  if (scenario?.startsWith("report_")) {
    requestSupervisionCheckForReport({
      requested: scenario === "report_explicit",
      deviceId,
      deviceName: "Test phone",
      platform: "android",
      appId: scenario === "report_matched" ? riskAppId : unmatchedAppId,
      appName: "Test app",
      title: "",
      source: "lsposed",
    }, now);
    await flushControllerEvents(now);
  } else {
    results.push(await runSupervisionTick(now));
    if (scenario === "due") results.push(await runSupervisionTick(now));
  }
  const rows = db.query("SELECT event_json FROM controller_event_outbox ORDER BY event_id").all() as Array<{ event_json: string }>;
  console.log(JSON.stringify({
    reasons: results.map((result) => result.reason),
    event_count: rows.length,
    webhook_calls: webhookCalls,
    model_calls: modelCalls,
    internal_ai_checks: results.filter((result) => result.ai_checked === true).length,
    events: rows.map((row) => JSON.parse(row.event_json)),
  }));
} finally {
  db.close();
}

export {};

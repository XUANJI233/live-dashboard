process.env.DB_PATH = ":memory:";
process.env.HASH_SECRET = "c".repeat(64);
process.env.HERMES_CONTROLLER_ENABLED = "true";
process.env.CONTROLLER_WEBHOOK_ENABLED = "true";
process.env.CONTROLLER_WEBHOOK_URL = "https://controller.example/webhooks/live-supervision";
process.env.CONTROLLER_WEBHOOK_SECRET = "hermes-gating-controller-secret";

const scenario = process.argv[2];
const deviceId = "gating-test-phone";
const start = new Date("2026-09-07T14:00:00.000Z");
let webhookCalls = 0;
let otherCalls = 0;

globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url = typeof input === "string" || input instanceof URL ? input.toString() : input.url;
  if (url !== process.env.CONTROLLER_WEBHOOK_URL) {
    otherCalls += 1;
    throw new Error(`Unexpected outbound request: ${url}`);
  }
  webhookCalls += 1;
  const event = JSON.parse(String(init?.body || "{}")) as { event_id: string };
  return Response.json({
    status: "accepted",
    ack: { schema: "live_dashboard.controller_ack.v1", v: 1, event_id: event.event_id, accepted: true },
  }, { status: 202 });
}) as typeof fetch;

const { db } = await import("../../src/db");
const { getSummarySettings, saveSummarySettings } = await import("../../src/services/daily-summary-gen");
const { requestSupervisionCheckForReport, runSupervisionTick } = await import("../../src/services/supervision");
const { flushControllerEvents } = await import("../../src/services/controller-event-outbox");

const at = (minutes: number) => new Date(start.getTime() + minutes * 60_000);

// Reports stay inside a risk app; each one is past the one-minute report throttle.
async function reportCooldown(): Promise<boolean[]> {
  const accepted: boolean[] = [];
  for (const report of [
    { minute: 0.5, requested: false },
    { minute: 2.5, requested: false },
    { minute: 4, requested: true },
    { minute: 11.5, requested: false },
  ]) {
    const now = at(report.minute);
    accepted.push(requestSupervisionCheckForReport({
      requested: report.requested,
      deviceId,
      deviceName: "Gating phone",
      platform: "android",
      appId: "com.example.game",
      appName: "Game",
      title: "",
      source: "lsposed",
    }, now));
    await flushControllerEvents(now);
  }
  return accepted;
}

// A blacklisted app fills every 30-minute window (so the round is due under any
// trigger polarity); a reader app appears for six minutes only before the last round.
async function unchangedReview(): Promise<string[]> {
  db.prepare(`
    INSERT INTO device_states (
      device_id, device_name, platform, app_id, app_name, window_title, display_title, last_seen_at, extra, is_online
    ) VALUES (?, 'Gating phone', 'android', 'com.example.video', 'Video', '', 'Video', ?, ?, 1)
  `).run(deviceId, at(120).toISOString(), JSON.stringify({ device: { profile: "android_lsp" } }));
  const insertActivity = db.prepare(`
    INSERT INTO activities (
      device_id, device_name, platform, app_id, app_name, window_title, display_title,
      extra, title_hash, time_bucket, started_at
    ) VALUES (?, 'Gating phone', 'android', ?, ?, '', ?, '{}', ?, ?, ?)
  `);
  for (let minute = -30; minute < 120; minute += 1) {
    const reader = minute >= 100 && minute < 106;
    const appId = reader ? "com.example.reader" : "com.example.video";
    const appName = reader ? "Reader" : "Video";
    insertActivity.run(deviceId, appId, appName, appName, `gating-${minute}`, minute, at(minute).toISOString());
  }
  const reasons: string[] = [];
  for (const minute of [0, 30, 60, 90, 120]) {
    reasons.push((await runSupervisionTick(at(minute))).reason);
  }
  return reasons;
}

try {
  saveSummarySettings({
    ...getSummarySettings(),
    supervision_enabled: true,
    supervision_policy_owner: "hermes",
    supervision_heuristic_triggers: true,
    supervision_skip_watch_sleep: false,
    supervision_check_interval_minutes: 30,
    supervision_blacklist_minutes: 20,
    supervision_rules: {
      whitelist_app_regex: [],
      blacklist_app_regex: ["com\\.example\\.video"],
      risk_app_regex: ["com\\.example\\.game"],
      target_app_regex: [],
      reason: "Hermes-authored rule fixture for controller wake gating",
    },
  });
  const results = scenario === "report_cooldown" ? await reportCooldown() : await unchangedReview();
  const rows = db.query("SELECT event_json FROM controller_event_outbox ORDER BY created_at").all() as Array<{ event_json: string }>;
  console.log(JSON.stringify({
    results,
    webhook_calls: webhookCalls,
    other_calls: otherCalls,
    events: rows.map((row) => JSON.parse(row.event_json)),
  }));
} finally {
  db.close();
}

export {};

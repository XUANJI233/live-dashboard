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
function seedVideoTimeline(): void {
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
}

async function unchangedReview(): Promise<string[]> {
  seedVideoTimeline();
  const reasons: string[] = [];
  for (const minute of [0, 30, 60, 90, 120]) {
    reasons.push((await runSupervisionTick(at(minute))).reason);
  }
  return reasons;
}

// A saved persona switched off is a user pause: nothing wakes Hermes, not even a device request.
async function pausedController(): Promise<Array<boolean | string>> {
  const { updateControllerPersona } = await import("../../src/services/controller-persona");
  updateControllerPersona({ enabled: false, controller: "hermes" });
  seedVideoTimeline();
  const tick = (await runSupervisionTick(at(120))).reason;
  const requested = requestSupervisionCheckForReport(candidate(true), at(120.5));
  await flushControllerEvents(at(121));
  return [tick, requested];
}

// An explicit request right after a rule match is not swallowed by the shared report throttle,
// and a request without a foreground app still reaches Hermes.
async function requestInsideThrottle(): Promise<boolean[]> {
  const { requestSupervisionCheckFromReportPayload } = await import("../../src/services/supervision-report-trigger");
  const accepted = [
    requestSupervisionCheckForReport(candidate(false), at(0.5)),
    requestSupervisionCheckForReport(candidate(true), at(0.8)),
    requestSupervisionCheckFromReportPayload(
      { extra: { device: { supervision_check_requested: true } } },
      { device_id: deviceId, device_name: "Gating phone", platform: "android" } as never,
    ),
  ];
  // Report-path flushes are fire-and-forget; drain whatever they left queued.
  await flushControllerEvents(at(1));
  await flushControllerEvents(at(1.1));
  return accepted;
}

function candidate(requested: boolean) {
  return {
    requested,
    deviceId,
    deviceName: "Gating phone",
    platform: "android",
    appId: "com.example.game",
    appName: "Game",
    title: "",
    source: "lsposed",
  };
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
  const results = scenario === "report_cooldown"
    ? await reportCooldown()
    : scenario === "paused_controller"
      ? await pausedController()
      : scenario === "request_inside_throttle"
        ? await requestInsideThrottle()
        : await unchangedReview();
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

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempDir = mkdtempSync(join(tmpdir(), "live-controller-health-"));
process.env.DB_PATH = join(tempDir, "test.db");
process.env.HASH_SECRET = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
process.env.MCP_SERVER_TOKEN = "health-mcp-token";
process.env.HERMES_CONTROLLER_ENABLED = "true";
process.env.CONTROLLER_WEBHOOK_ENABLED = "true";
process.env.CONTROLLER_WEBHOOK_URL = "https://controller.example/webhooks/live-supervision";
process.env.CONTROLLER_WEBHOOK_SECRET = "controller-health-secret";

const { db } = await import("../src/db");
const { controllerHealth, maybeNudgeUnreachableController } = await import("../src/services/controller-health");
const { enqueueControllerEvent, flushControllerEvents } = await import("../src/services/controller-event-outbox");
const { getSummarySettings, saveSummarySettings } = await import("../src/services/daily-summary-gen");
const { updateControllerPersona } = await import("../src/services/controller-persona");
const { getServiceSettings } = await import("../src/services/mcp-admin");
const { handleMcpRequest } = await import("../src/routes/mcp");

const originalFetch = globalThis.fetch;
const at = (minutes: number) => new Date(Date.parse("2026-09-01T10:00:00.000Z") + minutes * 60_000);

function controller(status: "ack" | number) {
  globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const event = JSON.parse(String(init?.body || "{}")) as { event_id: string };
    if (status !== "ack") return new Response(null, { status });
    return Response.json({
      status: "accepted",
      ack: { schema: "live_dashboard.controller_ack.v1", v: 1, event_id: event.event_id, accepted: true },
    }, { status: 202 });
  }) as typeof fetch;
}

function offline(eventId: string, minutes: number) {
  return {
    schema: "live_dashboard.controller_event.v1" as const,
    v: 1 as const,
    event_id: eventId,
    event_type: "device.offline" as const,
    occurred_at: at(minutes).toISOString(),
    source: "scheduled" as const,
    device_ids: ["phone"],
    reason_codes: ["heartbeat_timeout"],
  };
}

function resetHealth() {
  db.run("DELETE FROM controller_event_outbox");
  db.run("DELETE FROM meta WHERE key LIKE 'controller_last_%'");
}

db.prepare(`
  INSERT INTO device_states (device_id, device_name, platform, app_id, app_name, window_title, display_title,
    last_seen_at, extra, is_online)
  VALUES ('health-phone', 'Phone', 'android', 'com.example.study', 'Study', '', 'Study', datetime('now'), ?, 1)
`).run(JSON.stringify({ device: { profile: "android_lsp" } }));

describe("controller health", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });
  afterAll(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Windows keeps the SQLite file locked until the process exits.
    }
  });

  test("records acknowledged and failed deliveries and the pending backlog", async () => {
    resetHealth();
    controller("ack");
    enqueueControllerEvent(offline("offline:health-ok", 0));
    await flushControllerEvents(at(0));
    expect(controllerHealth(at(1))).toMatchObject({ last_ack_at: at(0).toISOString(), pending_count: 0, unreachable: false });

    controller(503);
    enqueueControllerEvent(offline("offline:health-down", 1));
    await flushControllerEvents(at(2));
    const health = controllerHealth(at(3));
    expect(health).toMatchObject({
      last_failure_at: at(2).toISOString(),
      last_error: "http_503",
      pending_count: 1,
      oldest_pending_at: at(1).toISOString(),
    });
    // The last ACK is only two minutes old: a blip, not an unreachable controller.
    expect(health.unreachable).toBe(false);
    expect(controllerHealth(at(40)).unreachable).toBe(false);
  });

  test("an authenticated MCP call counts as controller activity", async () => {
    resetHealth();
    await handleMcpRequest(new Request("http://127.0.0.1/api/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: "Bearer health-mcp-token",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }), { remoteAddress: "127.0.0.1", localListener: true });

    expect(controllerHealth().last_mcp_at).not.toBeNull();
    expect(getServiceSettings().controller_health).toMatchObject({ hermes_enabled: true });
  });

  test("tells the phone once when the controller stops answering", async () => {
    resetHealth();
    saveSummarySettings({ ...getSummarySettings(), supervision_enabled: true });
    controller("ack");
    enqueueControllerEvent(offline("offline:health-before", 0));
    await flushControllerEvents(at(0));
    controller(503);
    enqueueControllerEvent(offline("offline:health-outage", 35));
    await flushControllerEvents(at(35));

    expect(controllerHealth(at(36)).unreachable).toBe(true);
    expect(maybeNudgeUnreachableController(at(36))).toBe(true);
    expect(maybeNudgeUnreachableController(at(37))).toBe(false);
    const said = db.prepare(`
      SELECT COUNT(*) AS count FROM device_commands
      WHERE target_device_id = 'health-phone' AND payload LIKE '%监督助手暂时联系不上%'
    `).get() as { count: number };
    expect(said.count).toBe(1);

    // A user pause is not an outage worth reporting.
    db.run("DELETE FROM meta WHERE key = 'controller_last_unreachable_nudge_at'");
    updateControllerPersona({ enabled: false, controller: "hermes" });
    expect(maybeNudgeUnreachableController(at(38))).toBe(false);
    updateControllerPersona({ enabled: true });
  });
});

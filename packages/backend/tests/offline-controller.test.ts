import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempDir = mkdtempSync(join(tmpdir(), "live-offline-controller-"));
process.env.DB_PATH = join(tempDir, "test.db");
process.env.HASH_SECRET = "b".repeat(64);

describe("offline controller events", () => {
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

  test("retries one private, deduplicated offline transition until Hermes accepts it", async () => {
    process.env.HERMES_CONTROLLER_ENABLED = "true";
    process.env.CONTROLLER_WEBHOOK_ENABLED = "true";
    process.env.CONTROLLER_WEBHOOK_URL = "https://controller.example/webhooks/live-supervision";
    process.env.CONTROLLER_WEBHOOK_SECRET = "independent-offline-controller-secret";

    const { db } = await import("../src/db");
    const { checkOfflineDevices } = await import("../src/services/offline-controller");
    const deviceId = "android-offline";
    db.prepare(`
      INSERT INTO device_states (
        device_id, device_name, platform, app_id, app_name, window_title,
        display_title, last_seen_at, extra, is_online
      ) VALUES (?, 'Private Phone Name', 'android', 'com.private.app', 'Private App',
        'private window title', 'private display title', datetime('now', '-10 minutes'),
        '{"private":"must not leave Live"}', 1)
    `).run(deviceId);

    const originalFetch = globalThis.fetch;
    const requests: Array<{ headers: Headers; event: Record<string, unknown> }> = [];
    let accept = false;
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const event = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
      requests.push({
        headers: new Headers(init?.headers),
        event,
      });
      return accept
        ? Response.json({
            status: "accepted",
            ack: {
              schema: "live_dashboard.controller_ack.v1",
              v: 1,
              event_id: event.event_id,
              accepted: true,
            },
          }, { status: 202 })
        : new Response(null, { status: 503 });
    }) as typeof fetch;

    try {
      const first = await checkOfflineDevices(new Date("2026-09-01T03:00:00.000Z"));
      expect(first.transitioned).toContain(deviceId);
      expect(first.delivered).toBe(0);
      expect(first.pending).toBeGreaterThanOrEqual(1);
      expect(requests.length).toBe(first.pending * 3);

      accept = true;
      const second = await checkOfflineDevices(new Date("2026-09-01T03:01:00.000Z"));
      expect(second.transitioned).toEqual([]);
      expect(second.delivered).toBe(first.pending);
      expect(second.pending).toBe(0);
      expect(requests.length).toBe(first.pending * 4);

      const third = await checkOfflineDevices(new Date("2026-09-01T03:02:00.000Z"));
      expect(third).toMatchObject({ transitioned: [], delivered: 0, pending: 0 });
      expect(requests.length).toBe(first.pending * 4);
    } finally {
      globalThis.fetch = originalFetch;
    }

    const deviceRequests = requests.filter(({ event }) => (
      Array.isArray(event.device_ids) && event.device_ids.includes(deviceId)
    ));
    const eventIds = new Set(deviceRequests.map(({ headers }) => headers.get("x-request-id")));
    expect(eventIds.size).toBe(1);
    expect(deviceRequests[0]?.event).toMatchObject({
      schema: "live_dashboard.controller_event.v1",
      v: 1,
      event_id: deviceRequests[0]?.headers.get("x-request-id"),
      event_type: "device.offline",
      occurred_at: "2026-09-01T03:00:00.000Z",
      source: "scheduled",
      reason_codes: ["heartbeat_timeout"],
    });
    expect(deviceRequests[0]?.event.device_ids).toEqual(expect.arrayContaining([deviceId]));
    expect(JSON.stringify(deviceRequests[0]?.event)).not.toContain("Private");
    expect(JSON.stringify(deviceRequests[0]?.event)).not.toContain("private");

    const state = db.prepare("SELECT is_online FROM device_states WHERE device_id = ?")
      .get(deviceId) as { is_online: number };
    expect(state.is_online).toBe(0);
  });

  test("durably retries a supervision review until Hermes returns the matching ack", async () => {
    process.env.HERMES_CONTROLLER_ENABLED = "true";
    process.env.CONTROLLER_WEBHOOK_ENABLED = "true";
    process.env.CONTROLLER_WEBHOOK_URL = "https://controller.example/webhooks/live-supervision";
    process.env.CONTROLLER_WEBHOOK_SECRET = "independent-supervision-controller-secret";
    const { db } = await import("../src/db");
    const {
      controllerEventDelivered,
      enqueueControllerEvent,
      flushControllerEvents,
    } = await import("../src/services/controller-event-outbox");
    const event = {
      schema: "live_dashboard.controller_event.v1" as const,
      v: 1 as const,
      event_id: "supervision:durable-review:test",
      event_type: "supervision.review_requested" as const,
      occurred_at: "2026-09-01T04:00:00.000Z",
      source: "report" as const,
      device_ids: ["android-main"],
      reason_codes: ["rule_match"],
    };
    const originalFetch = globalThis.fetch;
    let validAck = false;
    let requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      return validAck
        ? Response.json({
            status: "accepted",
            ack: {
              schema: "live_dashboard.controller_ack.v1",
              v: 1,
              event_id: event.event_id,
              accepted: true,
            },
          }, { status: 202 })
        : Response.json({ status: "ignored", reason: "script" }, { status: 200 });
    }) as unknown as typeof fetch;

    try {
      expect(enqueueControllerEvent(event)).toBe(true);
      const first = await flushControllerEvents(new Date("2026-09-01T04:00:00.000Z"));
      expect(first.delivered_ids).toEqual([]);
      expect(first.pending).toBeGreaterThanOrEqual(1);
      expect(controllerEventDelivered(event.event_id)).toBe(false);
      expect(requests).toBe(3);

      validAck = true;
      const second = await flushControllerEvents(new Date("2026-09-01T04:01:00.000Z"));
      expect(second.delivered_ids).toContain(event.event_id);
      expect(controllerEventDelivered(event.event_id)).toBe(true);
      expect(requests).toBe(4);
    } finally {
      globalThis.fetch = originalFetch;
      db.prepare("DELETE FROM controller_event_outbox WHERE event_id = ?").run(event.event_id);
    }
  });

  test("serializes concurrent outbox flushes so Hermes sees one event once", async () => {
    process.env.HERMES_CONTROLLER_ENABLED = "true";
    process.env.CONTROLLER_WEBHOOK_ENABLED = "true";
    process.env.CONTROLLER_WEBHOOK_URL = "https://controller.example/webhooks/live-supervision";
    process.env.CONTROLLER_WEBHOOK_SECRET = "independent-concurrent-controller-secret";
    const { db } = await import("../src/db");
    const { enqueueControllerEvent, flushControllerEvents } = await import("../src/services/controller-event-outbox");
    const event = {
      schema: "live_dashboard.controller_event.v1" as const,
      v: 1 as const,
      event_id: "supervision:concurrent-flush:test",
      event_type: "supervision.review_requested" as const,
      occurred_at: "2026-09-01T04:30:00.000Z",
      source: "scheduled" as const,
      device_ids: ["android-main"],
      reason_codes: ["scheduled_check"],
    };
    const originalFetch = globalThis.fetch;
    let requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      await Bun.sleep(20);
      return Response.json({
        status: "accepted",
        ack: {
          schema: "live_dashboard.controller_ack.v1",
          v: 1,
          event_id: event.event_id,
          accepted: true,
        },
      }, { status: 202 });
    }) as unknown as typeof fetch;

    try {
      enqueueControllerEvent(event);
      await Promise.all([
        flushControllerEvents(new Date("2026-09-01T04:30:00.000Z")),
        flushControllerEvents(new Date("2026-09-01T04:30:01.000Z")),
      ]);
      expect(requests).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
      db.prepare("DELETE FROM controller_event_outbox WHERE event_id = ?").run(event.event_id);
    }
  });

  test("lets a websocket close become a durable offline event only after its heartbeat grace", async () => {
    process.env.HERMES_CONTROLLER_ENABLED = "true";
    process.env.CONTROLLER_WEBHOOK_ENABLED = "true";
    process.env.CONTROLLER_WEBHOOK_URL = "https://controller.example/webhooks/live-supervision";
    process.env.CONTROLLER_WEBHOOK_SECRET = "independent-offline-controller-secret";

    const { db } = await import("../src/db");
    const { checkOfflineDevices } = await import("../src/services/offline-controller");
    const { realtimeWebSocket } = await import("../src/services/realtime");
    const deviceId = "ws-offline-outbox";
    db.prepare(`
      INSERT INTO device_states (
        device_id, device_name, platform, app_id, app_name, window_title,
        display_title, last_seen_at, extra, is_online
      ) VALUES (?, 'Phone', 'android', 'com.reader', 'Reader',
        'Reading', 'Reading', datetime('now'), '{}', 1)
    `).run(deviceId);

    const deviceWs = {
      data: {
        role: "device",
        id: deviceId,
        device: { device_id: deviceId, device_name: "Phone", platform: "android" },
      },
      send() {},
    };

    const originalFetch = globalThis.fetch;
    const requests: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const event = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
      requests.push(event);
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
      realtimeWebSocket.open(deviceWs as any);
      realtimeWebSocket.close(deviceWs as any);

      const afterClose = db.prepare("SELECT is_online FROM device_states WHERE device_id = ?")
        .get(deviceId) as { is_online: number } | undefined;
      expect(afterClose?.is_online).toBe(1);

      db.prepare("UPDATE device_states SET last_seen_at = datetime('now', '-10 minutes') WHERE device_id = ?")
        .run(deviceId);
      const result = await checkOfflineDevices(new Date("2026-09-01T03:10:00.000Z"));

      const state = db.prepare("SELECT is_online FROM device_states WHERE device_id = ?")
        .get(deviceId) as { is_online: number } | undefined;

      expect(state?.is_online).toBe(0);
      expect(result).toMatchObject({ transitioned: [deviceId], delivered: 1, pending: 0 });
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        schema: "live_dashboard.controller_event.v1",
        v: 1,
        event_type: "device.offline",
        source: "scheduled",
        device_ids: [deviceId],
        reason_codes: ["heartbeat_timeout"],
      });
      expect(typeof requests[0]?.event_id).toBe("string");
      expect(Number.isNaN(Date.parse(String(requests[0]?.occurred_at)))).toBeFalse();
    } finally {
      globalThis.fetch = originalFetch;
      db.prepare("DELETE FROM controller_event_outbox WHERE event_json LIKE ?")
        .run(`%${deviceId}%`);
    }
  });

  test("bounds delivered outbox history without deleting pending events", async () => {
    const { cleanupOldControllerEvents, db } = await import("../src/db");
    const insert = db.prepare(`
      INSERT INTO controller_event_outbox (
        event_id, event_json, created_at, delivered_at
      ) VALUES (?, '{}', datetime('now'), datetime('now'))
    `);
    db.transaction(() => {
      for (let index = 0; index < 1001; index += 1) {
        insert.run(`delivered:${index.toString().padStart(4, "0")}`);
      }
    })();
    db.prepare(`
      INSERT INTO controller_event_outbox (event_id, event_json, created_at)
      VALUES ('pending:keep', '{}', datetime('now'))
    `).run();

    cleanupOldControllerEvents.run();

    const delivered = db.prepare(`
      SELECT COUNT(*) AS count FROM controller_event_outbox WHERE delivered_at IS NOT NULL
    `).get() as { count: number };
    const pending = db.prepare(`
      SELECT COUNT(*) AS count FROM controller_event_outbox WHERE delivered_at IS NULL
    `).get() as { count: number };
    expect(delivered.count).toBe(1000);
    expect(pending.count).toBe(1);
  });
});

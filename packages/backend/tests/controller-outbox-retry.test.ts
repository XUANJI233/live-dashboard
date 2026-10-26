import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempDir = mkdtempSync(join(tmpdir(), "live-controller-outbox-retry-"));
process.env.DB_PATH = join(tempDir, "test.db");
process.env.HASH_SECRET = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
process.env.HERMES_CONTROLLER_ENABLED = "true";
process.env.CONTROLLER_WEBHOOK_ENABLED = "true";
process.env.CONTROLLER_WEBHOOK_URL = "https://controller.example/webhooks/live-supervision";
process.env.CONTROLLER_WEBHOOK_SECRET = "outbox-retry-controller-secret";

const { db } = await import("../src/db");
const {
  controllerEventState,
  enqueueControllerEvent,
  flushControllerEvents,
} = await import("../src/services/controller-event-outbox");
type ControllerEvent = import("../src/services/controller-webhook").ControllerEvent;

const T0 = Date.parse("2026-09-01T08:00:00.000Z");
const at = (seconds: number) => new Date(T0 + seconds * 1000);
const originalFetch = globalThis.fetch;
let requests: string[] = [];

/** Each event id maps to a response: "ack", an HTTP status, or "throw" for a network error. */
function controller(responses: Record<string, "ack" | number | "throw">, fallback: "ack" | number | "throw" = "ack") {
  requests = [];
  globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const event = JSON.parse(String(init?.body || "{}")) as { event_id: string };
    requests.push(event.event_id);
    const response = responses[event.event_id] ?? fallback;
    if (response === "throw") throw new Error("connection refused");
    if (response !== "ack") return new Response(null, { status: response });
    return Response.json({
      status: "accepted",
      ack: { schema: "live_dashboard.controller_ack.v1", v: 1, event_id: event.event_id, accepted: true },
    }, { status: 202 });
  }) as typeof fetch;
}

function review(eventId: string, deviceIds: string[], reason: string, seconds = 0): ControllerEvent {
  return {
    schema: "live_dashboard.controller_event.v1",
    v: 1,
    event_id: eventId,
    event_type: "supervision.review_requested",
    occurred_at: at(seconds).toISOString(),
    source: "report",
    device_ids: deviceIds,
    reason_codes: [reason],
  };
}

function offline(eventId: string, seconds = 0): ControllerEvent {
  return {
    schema: "live_dashboard.controller_event.v1",
    v: 1,
    event_id: eventId,
    event_type: "device.offline",
    occurred_at: at(seconds).toISOString(),
    source: "scheduled",
    device_ids: ["phone"],
    reason_codes: ["heartbeat_timeout"],
  };
}

function outboxRow(eventId: string) {
  return db.prepare("SELECT * FROM controller_event_outbox WHERE event_id = ?").get(eventId) as Record<string, unknown>;
}

describe("controller outbox retry policy", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    db.run("DELETE FROM controller_event_outbox");
  });
  afterAll(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Windows keeps the SQLite file locked until the process exits.
    }
  });

  test("a failing event backs off without blocking newer ones", async () => {
    controller({ "offline:stuck": 503 });
    enqueueControllerEvent(offline("offline:stuck"));
    enqueueControllerEvent(offline("offline:fresh", 1));

    const first = await flushControllerEvents(at(1));
    expect(first.delivered_ids).toEqual(["offline:fresh"]);
    expect(requests).toEqual(["offline:stuck", "offline:stuck", "offline:fresh"]);

    requests = [];
    await flushControllerEvents(at(30));
    expect(requests).toEqual([]);

    await flushControllerEvents(at(62));
    expect(requests).toEqual(["offline:stuck", "offline:stuck"]);
    expect(outboxRow("offline:stuck").next_attempt_at).toBe(at(62 + 120).toISOString());
  });

  test("a rejected event goes straight to the dead letter", async () => {
    controller({ "offline:rejected": 400 });
    enqueueControllerEvent(offline("offline:rejected"));

    const result = await flushControllerEvents(at(1));

    expect(requests).toHaveLength(1);
    expect(result.pending).toBe(0);
    expect(controllerEventState("offline:rejected")).toBe("dead");
    expect(outboxRow("offline:rejected").last_error).toBe("http_400");
  });

  test("an event that keeps failing is dead after the last attempt", async () => {
    controller({}, 503);
    enqueueControllerEvent(offline("offline:tired"));
    db.prepare("UPDATE controller_event_outbox SET attempt_count = 7 WHERE event_id = ?").run("offline:tired");

    await flushControllerEvents(at(1));

    expect(controllerEventState("offline:tired")).toBe("dead");
    expect(outboxRow("offline:tired").attempt_count).toBe(8);
  });

  test("stale events expire instead of replaying after an outage", async () => {
    controller({});
    enqueueControllerEvent(review("review:old", ["phone"], "rule_match"));
    db.prepare(`
      INSERT INTO controller_event_outbox (event_id, event_json, created_at)
      VALUES ('legacy:old', '{}', ?)
    `).run(at(-25 * 3600).toISOString());

    const result = await flushControllerEvents(at(31 * 60));

    expect(requests).toEqual([]);
    expect(result.pending).toBe(0);
    expect(outboxRow("review:old").last_error).toBe("expired");
    expect(outboxRow("legacy:old").last_error).toBe("expired");
  });

  test("a newer review supersedes older pending reviews it covers and keeps their reasons", async () => {
    controller({});
    expect(enqueueControllerEvent(review("review:a", ["phone"], "device_requested"))).toBe("queued");
    expect(enqueueControllerEvent(review("review:other", ["tablet"], "rule_match", 1))).toBe("queued");
    expect(enqueueControllerEvent(review("review:a", ["phone"], "device_requested"))).toBe("duplicate");
    expect(enqueueControllerEvent(review("review:ab", ["phone", "laptop"], "scheduled_check", 2))).toBe("queued");

    expect(outboxRow("review:a").last_error).toBe("superseded");
    expect(controllerEventState("review:other")).toBe("pending");
    const merged = JSON.parse(String(outboxRow("review:ab").event_json)) as ControllerEvent;
    expect(merged.reason_codes).toEqual(["scheduled_check", "device_requested"]);

    const result = await flushControllerEvents(at(3));
    expect(result.delivered_ids.sort()).toEqual(["review:ab", "review:other"]);
  });

  test("cleanup drops old dead letters but keeps pending events", async () => {
    const { cleanupOldControllerEvents } = await import("../src/db");
    db.prepare(`
      INSERT INTO controller_event_outbox (event_id, event_json, created_at, dead_at, last_error)
      VALUES ('dead:old', '{}', datetime('now', '-20 days'), datetime('now', '-15 days'), 'http_400'),
             ('dead:recent', '{}', datetime('now', '-2 days'), datetime('now', '-1 days'), 'expired')
    `).run();
    enqueueControllerEvent(offline("offline:pending"));

    cleanupOldControllerEvents.run();

    expect(outboxRow("dead:old")).toBeNull();
    expect(outboxRow("dead:recent")).not.toBeNull();
    expect(controllerEventState("offline:pending")).toBe("pending");
  });

  test("an unreachable controller stops the flush early", async () => {
    controller({}, "throw");
    for (let index = 0; index < 5; index += 1) enqueueControllerEvent(offline(`offline:down:${index}`, index));

    await flushControllerEvents(at(10));

    // Three events × two attempts, then the flush gives up until the next tick.
    expect(requests).toHaveLength(6);
    expect(controllerEventState("offline:down:4")).toBe("pending");
    expect(outboxRow("offline:down:4").attempt_count).toBe(0);
  });
});

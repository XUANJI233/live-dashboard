import { afterEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";

const originalFetch = globalThis.fetch;
const originalAbortSignalTimeout = AbortSignal.timeout;
const configKeys = [
  "CONTROLLER_WEBHOOK_ENABLED",
  "CONTROLLER_WEBHOOK_URL",
  "CONTROLLER_WEBHOOK_SECRET",
] as const;

const event = {
  schema: "live_dashboard.controller_event.v1" as const,
  event_id: "supervision:2026-08-31T12:00:00.000Z",
  event_type: "supervision.deviation_detected" as const,
  occurred_at: "2026-08-31T12:00:00.000Z",
  source: "report" as const,
  device_ids: ["android-main"],
  reason_codes: ["deviation_confirmed"],
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  AbortSignal.timeout = originalAbortSignalTimeout;
  for (const key of configKeys) delete process.env[key];
});

describe("controller webhook", () => {
  test("stays offline unless explicitly enabled", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response(null, { status: 202 });
    }) as unknown as typeof fetch;

    const { notifyControllerEvent } = await import("../src/services/controller-webhook");
    const result = await notifyControllerEvent(event);

    expect(result).toEqual({ enabled: false, sent: false, reason: "disabled" });
    expect(called).toBe(false);
  });

  test("sends the minimal event with Hermes generic HMAC V2", async () => {
    process.env.CONTROLLER_WEBHOOK_ENABLED = "true";
    process.env.CONTROLLER_WEBHOOK_URL = "http://host.docker.internal:8644/webhooks/live-supervision";
    process.env.CONTROLLER_WEBHOOK_SECRET = "controller-webhook-test-secret";

    let requestUrl = "";
    let requestBody = "";
    let requestHeaders = new Headers();
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      requestUrl = typeof input === "string" || input instanceof URL ? input.toString() : input.url;
      requestBody = String(init?.body || "");
      requestHeaders = new Headers(init?.headers);
      return Response.json({ status: "accepted" }, { status: 202 });
    }) as typeof fetch;

    const { notifyControllerEvent } = await import("../src/services/controller-webhook");
    const result = await notifyControllerEvent(event);

    expect(result).toEqual({ enabled: true, sent: true, status: 202 });
    expect(requestUrl).toBe(process.env.CONTROLLER_WEBHOOK_URL!);
    expect(JSON.parse(requestBody)).toEqual(event);
    expect(requestHeaders.get("content-type")).toBe("application/json");
    expect(requestHeaders.get("x-request-id")).toBe(event.event_id);
    const timestamp = requestHeaders.get("x-webhook-timestamp") || "";
    expect(Number.isInteger(Number(timestamp))).toBe(true);
    expect(Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp))).toBeLessThanOrEqual(2);
    const expectedSignature = createHmac("sha256", process.env.CONTROLLER_WEBHOOK_SECRET!)
      .update(`${timestamp}.${requestBody}`)
      .digest("hex");
    expect(requestHeaders.get("x-webhook-signature-v2")).toBe(expectedSignature);
  });

  test("bounds delivery time and contains HTTP failures", async () => {
    process.env.CONTROLLER_WEBHOOK_ENABLED = "true";
    process.env.CONTROLLER_WEBHOOK_URL = "http://host.docker.internal:8644/webhooks/live-supervision";
    process.env.CONTROLLER_WEBHOOK_SECRET = "do-not-leak-this-secret";

    let timeoutMs = 0;
    const signal = new AbortController().signal;
    AbortSignal.timeout = ((value: number) => {
      timeoutMs = value;
      return signal;
    }) as typeof AbortSignal.timeout;
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      expect(init?.signal).toBe(signal);
      return new Response("upstream detail", { status: 503 });
    }) as typeof fetch;

    const { notifyControllerEvent } = await import("../src/services/controller-webhook");
    const result = await notifyControllerEvent(event);

    expect(timeoutMs).toBe(3_000);
    expect(result).toEqual({ enabled: true, sent: false, status: 503, reason: "http_503" });
    expect(JSON.stringify(result)).not.toContain(process.env.CONTROLLER_WEBHOOK_SECRET!);
    expect(JSON.stringify(result)).not.toContain("upstream detail");
  });
});

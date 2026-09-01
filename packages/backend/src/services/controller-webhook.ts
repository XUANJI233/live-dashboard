import { createHash, createHmac } from "node:crypto";
import { hermesControllerEnabled } from "./controller-mode";

export const CONTROLLER_EVENT_SCHEMA = "live_dashboard.controller_event.v1" as const;

export interface ControllerEvent {
  schema: typeof CONTROLLER_EVENT_SCHEMA;
  v: 1;
  event_id: string;
  event_type: "device.offline" | "supervision.deviation_detected" | "supervision.review_requested";
  occurred_at: string;
  source: "scheduled" | "report";
  device_ids: string[];
  reason_codes: string[];
}

export interface ControllerWebhookDelivery {
  enabled: boolean;
  sent: boolean;
  status?: number;
  reason?: string;
}

export function controllerWebhookEnabled(): boolean {
  return /^true$/i.test(process.env.CONTROLLER_WEBHOOK_ENABLED || "");
}

export function controllerWebhookEventId(deviceIds: string[], now: Date, cooldownMinutes: number): string {
  const bucketMs = Math.max(1, cooldownMinutes) * 60_000;
  const bucket = Math.floor(now.getTime() / bucketMs);
  const devices = Array.from(new Set(deviceIds.filter(Boolean))).sort().join("\n");
  const digest = createHash("sha256").update(devices).digest("hex").slice(0, 20);
  return `supervision:${bucket}:${digest}`;
}

export async function notifyControllerEvent(event: ControllerEvent): Promise<ControllerWebhookDelivery> {
  if (!hermesControllerEnabled()) {
    return { enabled: false, sent: false, reason: "controller_inactive" };
  }
  if (!controllerWebhookEnabled()) {
    return { enabled: false, sent: false, reason: "disabled" };
  }

  const url = (process.env.CONTROLLER_WEBHOOK_URL || "").trim();
  const secret = process.env.CONTROLLER_WEBHOOK_SECRET || "";
  if (!url || !secret) {
    return { enabled: true, sent: false, reason: "not_configured" };
  }
  if (reusedControllerSecret(secret)) {
    return { enabled: true, sent: false, reason: "secret_reused" };
  }

  const body = JSON.stringify(event);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex");

  let failure: ControllerWebhookDelivery = { enabled: true, sent: false, reason: "request_failed" };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Request-ID": event.event_id,
          "X-Webhook-Timestamp": timestamp,
          "X-Webhook-Signature-V2": signature,
        },
        body,
        signal: AbortSignal.timeout(3_000),
      });
      if (response.ok) return { enabled: true, sent: true, status: response.status };
      failure = { enabled: true, sent: false, status: response.status, reason: `http_${response.status}` };
      if (response.status < 500) break;
    } catch {
      failure = { enabled: true, sent: false, reason: "request_failed" };
    }
  }
  return failure;
}

function reusedControllerSecret(secret: string): boolean {
  const forbidden = new Set<string>();
  for (const key of ["HASH_SECRET", "MCP_SERVER_TOKEN", "MCP_ADMIN_TOKEN"]) {
    const value = process.env[key] || "";
    if (value) forbidden.add(value);
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("DEVICE_TOKEN_") || !value) continue;
    forbidden.add(value);
    const token = value.split(":", 1)[0];
    if (token) forbidden.add(token);
  }
  return forbidden.has(secret);
}

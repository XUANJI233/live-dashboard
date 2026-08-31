import { createHmac } from "node:crypto";

export const CONTROLLER_EVENT_SCHEMA = "live_dashboard.controller_event.v1" as const;

export interface ControllerEvent {
  schema: typeof CONTROLLER_EVENT_SCHEMA;
  event_id: string;
  event_type: "supervision.deviation_detected";
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

export async function notifyControllerEvent(event: ControllerEvent): Promise<ControllerWebhookDelivery> {
  if (!controllerWebhookEnabled()) {
    return { enabled: false, sent: false, reason: "disabled" };
  }

  const url = (process.env.CONTROLLER_WEBHOOK_URL || "").trim();
  const secret = process.env.CONTROLLER_WEBHOOK_SECRET || "";
  if (!url || !secret) {
    return { enabled: true, sent: false, reason: "not_configured" };
  }

  const body = JSON.stringify(event);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex");

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
    return response.ok
      ? { enabled: true, sent: true, status: response.status }
      : { enabled: true, sent: false, status: response.status, reason: `http_${response.status}` };
  } catch {
    return { enabled: true, sent: false, reason: "request_failed" };
  }
}

import type { ControllerEvent, ControllerWebhookDelivery } from "./controller-webhook";

/**
 * Delivery policy for the controller outbox: how long an event stays worth delivering,
 * when a failed one is retried, and which failures are permanent (dead letter).
 */
const MINUTE_MS = 60_000;
const MAX_BACKOFF_MS = 30 * MINUTE_MS;
export const MAX_DELIVERY_ATTEMPTS = 8;
// Rows written before expiry existed: anything older than this is stale.
export const LEGACY_EXPIRY_MS = 24 * 60 * MINUTE_MS;

const EVENT_TTL_MS: Record<ControllerEvent["event_type"], number> = {
  // A review is about current usage; the next one carries fresher state.
  "supervision.review_requested": 30 * MINUTE_MS,
  "supervision.deviation_detected": 30 * MINUTE_MS,
  "device.offline": 2 * 60 * MINUTE_MS,
  // The user is waiting for the result; the AI job ledger has its own retry path.
  "ai.work_requested": 24 * 60 * MINUTE_MS,
};

export function controllerEventExpiresAt(eventType: ControllerEvent["event_type"], createdAt: string): string {
  return new Date(Date.parse(createdAt) + EVENT_TTL_MS[eventType]).toISOString();
}

/** Exponential backoff: 1, 2, 4, 8, 16, then every 30 minutes. */
export function nextAttemptAt(attemptCount: number, now: Date): string {
  const delay = Math.min(MAX_BACKOFF_MS, MINUTE_MS * 2 ** Math.max(0, attemptCount - 1));
  return new Date(now.getTime() + delay).toISOString();
}

/** Failures no retry can fix: the receiver rejected the event or the row itself is broken. */
export function permanentDeliveryFailure(delivery: ControllerWebhookDelivery | null): boolean {
  if (!delivery) return true;
  if (delivery.reason === "secret_reused") return true;
  const status = delivery.status ?? 0;
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

/** Network-level failures that suggest the controller is unreachable right now. */
export function unreachableDelivery(delivery: ControllerWebhookDelivery): boolean {
  return delivery.reason === "request_failed" || (delivery.status ?? 0) >= 500;
}

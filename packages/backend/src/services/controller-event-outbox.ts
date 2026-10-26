import { db } from "../db";
import {
  CONTROLLER_EVENT_SCHEMA,
  notifyControllerEvent,
  type ControllerEvent,
  type ControllerWebhookDelivery,
} from "./controller-webhook";
import { cleanIdentifier } from "./mcp-contracts";
import { recordControllerDeliveryResult } from "./controller-health-record";
import {
  LEGACY_EXPIRY_MS,
  MAX_DELIVERY_ATTEMPTS,
  controllerEventExpiresAt,
  nextAttemptAt,
  permanentDeliveryFailure,
  unreachableDelivery,
} from "./controller-event-retry";

interface OutboxRow {
  event_id: string;
  event_json: string;
  attempt_count: number;
}

export interface ControllerEventFlushResult {
  delivered_ids: string[];
  pending: number;
}

export type ControllerEnqueueResult = "queued" | "duplicate" | "invalid";
export type ControllerEventState = "delivered" | "dead" | "pending" | "missing";

const MAX_DEVICE_IDS_PER_EVENT = 20;
const MAX_EVENTS_PER_FLUSH = 20;
const MAX_REASON_CODES = 20;
// Stop a flush after this many consecutive unreachable attempts instead of timing out on every row.
const MAX_UNREACHABLE_STREAK = 3;
const SAFE_ID = /^[A-Za-z0-9_.:-]{1,160}$/;
const SAFE_REASON = /^[a-z][a-z0-9_.:-]{0,79}$/;
const SUPPORTED_EVENT_TYPES = new Set<ControllerEvent["event_type"]>([
  "device.offline",
  "supervision.deviation_detected",
  "supervision.review_requested",
  "ai.work_requested",
]);

const insertControllerEvent = db.prepare(`
  INSERT OR IGNORE INTO controller_event_outbox (event_id, event_json, created_at, expires_at)
  VALUES (?, ?, ?, ?)
`);

const pendingReviewEvents = db.prepare(`
  SELECT event_id, event_json, attempt_count
  FROM controller_event_outbox
  WHERE delivered_at IS NULL AND dead_at IS NULL
    AND json_extract(event_json, '$.event_type') = 'supervision.review_requested'
`);

const expireStaleEvents = db.prepare(`
  UPDATE controller_event_outbox
  SET dead_at = ?, last_error = 'expired'
  WHERE delivered_at IS NULL AND dead_at IS NULL
    AND (
      (expires_at IS NOT NULL AND julianday(expires_at) <= julianday(?))
      OR (expires_at IS NULL AND julianday(created_at) <= julianday(?))
    )
`);

const dueControllerEvents = db.prepare(`
  SELECT event_id, event_json, attempt_count
  FROM controller_event_outbox
  WHERE delivered_at IS NULL AND dead_at IS NULL
    AND (next_attempt_at IS NULL OR julianday(next_attempt_at) <= julianday(?))
  ORDER BY created_at, event_id
  LIMIT ?
`);

// An event superseded while its request was already in flight still reached the controller.
const recordControllerDelivery = db.prepare(`
  UPDATE controller_event_outbox
  SET delivered_at = ?, attempt_count = attempt_count + 1,
      last_attempt_at = ?, last_error = '', next_attempt_at = NULL, dead_at = NULL
  WHERE event_id = ? AND delivered_at IS NULL
`);

const recordControllerFailure = db.prepare(`
  UPDATE controller_event_outbox
  SET attempt_count = attempt_count + 1, last_attempt_at = ?, last_error = ?, next_attempt_at = ?
  WHERE event_id = ? AND delivered_at IS NULL
`);

const recordControllerDeadLetter = db.prepare(`
  UPDATE controller_event_outbox
  SET attempt_count = attempt_count + ?, last_attempt_at = ?, last_error = ?, dead_at = ?
  WHERE event_id = ? AND delivered_at IS NULL AND dead_at IS NULL
`);

const pendingControllerEventCount = db.prepare(`
  SELECT COUNT(*) AS count
  FROM controller_event_outbox
  WHERE delivered_at IS NULL AND dead_at IS NULL
`);

const controllerEventRow = db.prepare(`
  SELECT delivered_at, dead_at FROM controller_event_outbox WHERE event_id = ?
`);
let flushInFlight: Promise<ControllerEventFlushResult> | null = null;

const enqueueTransaction = db.transaction((event: ControllerEvent, createdAt: string): ControllerEnqueueResult => {
  if (controllerEventRow.get(event.event_id)) return "duplicate";
  const stored = event.event_type === "supervision.review_requested"
    ? absorbPendingReviews(event, createdAt)
    : event;
  insertControllerEvent.run(
    stored.event_id,
    JSON.stringify(stored),
    createdAt,
    controllerEventExpiresAt(stored.event_type, createdAt),
  );
  return "queued";
});

export function enqueueControllerEvent(event: ControllerEvent, createdAt = event.occurred_at): ControllerEnqueueResult {
  if (!validatedControllerEvent(event) || Number.isNaN(Date.parse(createdAt))) return "invalid";
  return enqueueTransaction(event, createdAt) as ControllerEnqueueResult;
}

/**
 * A new review carries the current state, so older undelivered reviews for the same devices
 * are superseded. Their reason codes move into the new event (a device request is not lost).
 */
function absorbPendingReviews(event: ControllerEvent, createdAt: string): ControllerEvent {
  const covered = new Set(event.device_ids);
  const reasonCodes = [...event.reason_codes];
  for (const row of pendingReviewEvents.all() as OutboxRow[]) {
    const older = storedControllerEvent(row);
    if (!older || !older.device_ids.every((deviceId) => covered.has(deviceId))) continue;
    for (const code of older.reason_codes) {
      if (!reasonCodes.includes(code) && reasonCodes.length < MAX_REASON_CODES) reasonCodes.push(code);
    }
    recordControllerDeadLetter.run(0, createdAt, "superseded", createdAt, row.event_id);
  }
  return { ...event, reason_codes: reasonCodes };
}

export function flushControllerEvents(now = new Date()): Promise<ControllerEventFlushResult> {
  // A caller arriving mid-flush gets another pass: rows it just queued were not in the running batch.
  if (flushInFlight) return flushInFlight.then(() => flushControllerEvents(now));
  const run = flushControllerEventsOnce(now);
  flushInFlight = run;
  const clear = () => {
    if (flushInFlight === run) flushInFlight = null;
  };
  void run.then(clear, clear);
  return run;
}

async function flushControllerEventsOnce(now: Date): Promise<ControllerEventFlushResult> {
  const attemptedAt = validIsoTimestamp(now);
  const legacyCutoff = new Date(now.getTime() - LEGACY_EXPIRY_MS).toISOString();
  expireStaleEvents.run(attemptedAt, attemptedAt, legacyCutoff);
  const deliveredIds: string[] = [];
  const due = dueControllerEvents.all(attemptedAt, MAX_EVENTS_PER_FLUSH) as OutboxRow[];
  let unreachableStreak = 0;
  for (const row of due) {
    const event = storedControllerEvent(row);
    if (!event) {
      recordControllerDeadLetter.run(1, attemptedAt, "invalid_outbox_event", attemptedAt, row.event_id);
      continue;
    }
    const delivery = await notifyControllerEvent(event);
    recordControllerDeliveryResult(attemptedAt, delivery.sent, deliveryFailureReason(delivery));
    if (delivery.sent) {
      recordControllerDelivery.run(attemptedAt, attemptedAt, row.event_id);
      deliveredIds.push(row.event_id);
      unreachableStreak = 0;
      continue;
    }
    const reason = deliveryFailureReason(delivery);
    const attempts = row.attempt_count + 1;
    if (permanentDeliveryFailure(delivery) || attempts >= MAX_DELIVERY_ATTEMPTS) {
      recordControllerDeadLetter.run(1, attemptedAt, reason, attemptedAt, row.event_id);
    } else {
      recordControllerFailure.run(attemptedAt, reason, nextAttemptAt(attempts, now), row.event_id);
    }
    unreachableStreak = unreachableDelivery(delivery) ? unreachableStreak + 1 : 0;
    if (unreachableStreak >= MAX_UNREACHABLE_STREAK) break;
  }
  const countRow = pendingControllerEventCount.get() as { count: number };
  return { delivered_ids: deliveredIds, pending: countRow.count };
}

export function controllerEventState(eventId: string): ControllerEventState {
  const row = controllerEventRow.get(eventId) as { delivered_at: string | null; dead_at: string | null } | null;
  if (!row) return "missing";
  if (row.delivered_at) return "delivered";
  return row.dead_at ? "dead" : "pending";
}

export function controllerEventDelivered(eventId: string): boolean {
  return controllerEventState(eventId) === "delivered";
}

export function controllerEventPendingCount(): number {
  const row = pendingControllerEventCount.get() as { count: number };
  return row.count;
}

function storedControllerEvent(row: OutboxRow): ControllerEvent | null {
  try {
    const parsed = JSON.parse(row.event_json) as Partial<ControllerEvent>;
    if (parsed.event_id !== row.event_id || !validatedControllerEvent(parsed)) return null;
    return parsed as ControllerEvent;
  } catch {
    return null;
  }
}

function validatedControllerEvent(event: Partial<ControllerEvent>): boolean {
  if (
    event.schema !== CONTROLLER_EVENT_SCHEMA
    || event.v !== 1
    || typeof event.event_id !== "string"
    || !SAFE_ID.test(event.event_id)
    || !SUPPORTED_EVENT_TYPES.has(event.event_type as ControllerEvent["event_type"])
    || !isoWithZone(event.occurred_at)
    || (event.source !== "scheduled" && event.source !== "report" && event.source !== "client")
    || !Array.isArray(event.device_ids)
    || event.device_ids.length < 1
    || event.device_ids.length > MAX_DEVICE_IDS_PER_EVENT
    || event.device_ids.some((value) => typeof value !== "string" || cleanIdentifier(value) !== value)
    || !Array.isArray(event.reason_codes)
    || event.reason_codes.length < 1
    || event.reason_codes.length > 20
    || event.reason_codes.some((value) => typeof value !== "string" || !SAFE_REASON.test(value))
  ) {
    return false;
  }
  if (
    event.event_type === "device.offline"
    && (event.source !== "scheduled"
      || event.reason_codes.length !== 1
      || event.reason_codes[0] !== "heartbeat_timeout")
  ) {
    return false;
  }
  if (event.event_type === "ai.work_requested" && !validAiRequest(event)) return false;
  if (event.event_type !== "ai.work_requested" && (event.source === "client" || event.ai_request !== undefined)) return false;
  return true;
}

function validAiRequest(event: Partial<ControllerEvent>): boolean {
  const request = event.ai_request;
  if (!request || event.source !== "client") return false;
  if (!onlyKeys(request as unknown as Record<string, unknown>, ["request_id", "kind", "payload"])) return false;
  if (cleanIdentifier(request.request_id) !== request.request_id) return false;
  if (event.reason_codes?.length !== 1 || event.reason_codes[0] !== request.kind) return false;
  const payload = request.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  if (request.kind === "daily_summary") {
    return validDate(payload.date) && validTimezone(payload.tz_offset_minutes)
      && onlyKeys(payload, ["date", "tz_offset_minutes"]);
  }
  if (request.kind === "weekly_summary") {
    return validDate(payload.week_start) && validTimezone(payload.tz_offset_minutes)
      && onlyKeys(payload, ["week_start", "tz_offset_minutes"]);
  }
  if (request.kind === "supervision_rules_refresh") {
    return typeof payload.settings_updated_at === "string"
      && cleanIdentifier(payload.settings_updated_at, 80) === payload.settings_updated_at
      && onlyKeys(payload, ["settings_updated_at"]);
  }
  if (request.kind === "supervision_check") {
    return isoWithZone(payload.at)
      && (payload.source === "scheduled" || payload.source === "report")
      && typeof payload.force === "boolean"
      && onlyKeys(payload, ["at", "source", "force"]);
  }
  return false;
}

function onlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key)) && Object.keys(value).length === keys.length;
}

// Rules shared with deploy/hermes/trigger_live_supervision.py; both sides run
// deploy/hermes/tests/fixtures/controller_events.json.
function validDate(value: unknown): boolean {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function isoWithZone(value: unknown): boolean {
  return typeof value === "string"
    && /(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && !Number.isNaN(Date.parse(value));
}

function validTimezone(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= -840 && value <= 840;
}

function deliveryFailureReason(delivery: ControllerWebhookDelivery): string {
  return (delivery.reason || (delivery.status ? `http_${delivery.status}` : "unknown"))
    .replace(/[^a-zA-Z0-9_.:-]/g, "_")
    .slice(0, 80);
}

function validIsoTimestamp(value: Date): string {
  return Number.isFinite(value.getTime()) ? value.toISOString() : new Date().toISOString();
}

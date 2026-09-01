import { db } from "../db";
import {
  CONTROLLER_EVENT_SCHEMA,
  notifyControllerEvent,
  type ControllerEvent,
  type ControllerWebhookDelivery,
} from "./controller-webhook";
import { cleanIdentifier } from "./mcp-contracts";

interface OutboxRow {
  event_id: string;
  event_json: string;
}

export interface ControllerEventFlushResult {
  delivered_ids: string[];
  pending: number;
}

const MAX_DEVICE_IDS_PER_EVENT = 20;
const MAX_EVENTS_PER_FLUSH = 20;
const SAFE_ID = /^[A-Za-z0-9_.:-]{1,160}$/;
const SAFE_REASON = /^[a-z][a-z0-9_.:-]{0,79}$/;
const SUPPORTED_EVENT_TYPES = new Set<ControllerEvent["event_type"]>([
  "device.offline",
  "supervision.deviation_detected",
  "supervision.review_requested",
]);

const insertControllerEvent = db.prepare(`
  INSERT OR IGNORE INTO controller_event_outbox (event_id, event_json, created_at)
  VALUES (?, ?, ?)
`);

const pendingControllerEvents = db.prepare(`
  SELECT event_id, event_json
  FROM controller_event_outbox
  WHERE delivered_at IS NULL
  ORDER BY created_at, event_id
  LIMIT ?
`);

const recordControllerDelivery = db.prepare(`
  UPDATE controller_event_outbox
  SET delivered_at = ?, attempt_count = attempt_count + 1,
      last_attempt_at = ?, last_error = ''
  WHERE event_id = ? AND delivered_at IS NULL
`);

const recordControllerFailure = db.prepare(`
  UPDATE controller_event_outbox
  SET attempt_count = attempt_count + 1, last_attempt_at = ?, last_error = ?
  WHERE event_id = ? AND delivered_at IS NULL
`);

const pendingControllerEventCount = db.prepare(`
  SELECT COUNT(*) AS count
  FROM controller_event_outbox
  WHERE delivered_at IS NULL
`);

const controllerEventState = db.prepare(`
  SELECT delivered_at FROM controller_event_outbox WHERE event_id = ?
`);
let flushInFlight: Promise<ControllerEventFlushResult> | null = null;

export function enqueueControllerEvent(event: ControllerEvent, createdAt = event.occurred_at): boolean {
  if (!validatedControllerEvent(event) || Number.isNaN(Date.parse(createdAt))) return false;
  insertControllerEvent.run(event.event_id, JSON.stringify(event), createdAt);
  return true;
}

export function flushControllerEvents(now = new Date()): Promise<ControllerEventFlushResult> {
  if (flushInFlight) return flushInFlight;
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
  const deliveredIds: string[] = [];
  const pending = pendingControllerEvents.all(MAX_EVENTS_PER_FLUSH) as OutboxRow[];
  for (const row of pending) {
    const event = storedControllerEvent(row);
    if (!event) {
      recordControllerFailure.run(attemptedAt, "invalid_outbox_event", row.event_id);
      continue;
    }
    const delivery = await notifyControllerEvent(event);
    if (delivery.sent) {
      recordControllerDelivery.run(attemptedAt, attemptedAt, row.event_id);
      deliveredIds.push(row.event_id);
    } else {
      recordControllerFailure.run(attemptedAt, deliveryFailureReason(delivery), row.event_id);
    }
  }
  const countRow = pendingControllerEventCount.get() as { count: number };
  return { delivered_ids: deliveredIds, pending: countRow.count };
}

export function controllerEventDelivered(eventId: string): boolean {
  const row = controllerEventState.get(eventId) as { delivered_at: string | null } | undefined;
  return Boolean(row?.delivered_at);
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
    || typeof event.occurred_at !== "string"
    || Number.isNaN(Date.parse(event.occurred_at))
    || (event.source !== "scheduled" && event.source !== "report")
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
  return true;
}

function deliveryFailureReason(delivery: ControllerWebhookDelivery): string {
  return (delivery.reason || (delivery.status ? `http_${delivery.status}` : "unknown"))
    .replace(/[^a-zA-Z0-9_.:-]/g, "_")
    .slice(0, 80);
}

function validIsoTimestamp(value: Date): string {
  return Number.isFinite(value.getTime()) ? value.toISOString() : new Date().toISOString();
}

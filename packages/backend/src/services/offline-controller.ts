import { createHash } from "node:crypto";
import { db, markOfflineDevices } from "../db";
import {
  CONTROLLER_EVENT_SCHEMA,
  controllerWebhookEnabled,
  notifyControllerEvent,
  type ControllerEvent,
  type ControllerWebhookDelivery,
} from "./controller-webhook";
import { hermesControllerEnabled } from "./controller-mode";
import { cleanIdentifier } from "./mcp-contracts";

interface OfflineTransitionRow {
  device_id: string;
  last_seen_at: string;
}

interface OutboxRow {
  event_id: string;
  event_json: string;
}

export interface OfflineControllerCheckResult {
  transitioned: string[];
  delivered: number;
  pending: number;
}

const MAX_DEVICE_IDS_PER_EVENT = 20;
const MAX_EVENTS_PER_FLUSH = 20;

const enqueueControllerEvent = db.prepare(`
  INSERT OR IGNORE INTO controller_event_outbox (event_id, event_json, created_at)
  VALUES (?, ?, ?)
`);

const markDeviceOffline = db.prepare(`
  UPDATE device_states SET is_online = 0
  WHERE device_id = ? AND is_online = 1
  RETURNING device_id, last_seen_at
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

const transitionAndQueueOfflineEvents = db.transaction((occurredAt: string, shouldQueue: boolean) => {
  const rows = markOfflineDevices.all() as OfflineTransitionRow[];
  queueOfflineEvents(rows, occurredAt, shouldQueue);
  return rows;
});

const transitionAndQueueDeviceOffline = db.transaction((
  deviceId: string,
  occurredAt: string,
  shouldQueue: boolean,
) => {
  const row = markDeviceOffline.get(deviceId) as OfflineTransitionRow | null;
  if (!row) return null;
  queueOfflineEvents([row], occurredAt, shouldQueue);
  return row;
});

function queueOfflineEvents(
  rows: OfflineTransitionRow[],
  occurredAt: string,
  shouldQueue: boolean,
): void {
  if (!shouldQueue || rows.length === 0) return;

  const safeRows = rows
    .map((row) => ({
      device_id: cleanIdentifier(row.device_id),
      last_seen_at: typeof row.last_seen_at === "string" ? row.last_seen_at : "",
    }))
    .filter((row) => row.device_id)
    .sort((left, right) => left.device_id.localeCompare(right.device_id));

  for (let offset = 0; offset < safeRows.length; offset += MAX_DEVICE_IDS_PER_EVENT) {
    const group = safeRows.slice(offset, offset + MAX_DEVICE_IDS_PER_EVENT);
    const event: ControllerEvent = {
      schema: CONTROLLER_EVENT_SCHEMA,
      v: 1,
      event_id: offlineTransitionEventId(group),
      event_type: "device.offline",
      occurred_at: occurredAt,
      source: "scheduled",
      device_ids: group.map((row) => row.device_id),
      reason_codes: ["heartbeat_timeout"],
    };
    enqueueControllerEvent.run(event.event_id, JSON.stringify(event), occurredAt);
  }
}

/**
 * Mark one currently connected device offline and atomically enqueue the same
 * durable controller event used by the scheduled timeout transition.
 */
export function transitionDeviceOffline(deviceId: string, now = new Date()): boolean {
  const occurredAt = validIsoTimestamp(now);
  const controllerActive = hermesControllerEnabled() && controllerWebhookEnabled();
  return Boolean(transitionAndQueueDeviceOffline(deviceId, occurredAt, controllerActive));
}

/**
 * Mark newly stale devices offline, durably enqueue one minimal controller
 * event per transition batch, and retry every pending event.
 */
export async function checkOfflineDevices(now = new Date()): Promise<OfflineControllerCheckResult> {
  const occurredAt = validIsoTimestamp(now);
  const controllerActive = hermesControllerEnabled() && controllerWebhookEnabled();
  const transitionedRows = transitionAndQueueOfflineEvents(occurredAt, controllerActive) as OfflineTransitionRow[];

  let delivered = 0;
  if (controllerActive) {
    const pending = pendingControllerEvents.all(MAX_EVENTS_PER_FLUSH) as OutboxRow[];
    for (const row of pending) {
      const event = storedControllerEvent(row);
      if (!event) {
        recordControllerFailure.run(occurredAt, "invalid_outbox_event", row.event_id);
        continue;
      }
      const delivery = await notifyControllerEvent(event);
      if (delivery.sent) {
        recordControllerDelivery.run(occurredAt, occurredAt, row.event_id);
        delivered += 1;
      } else {
        recordControllerFailure.run(occurredAt, deliveryFailureReason(delivery), row.event_id);
      }
    }
  }

  const countRow = pendingControllerEventCount.get() as { count: number };
  return {
    transitioned: transitionedRows.map((row) => row.device_id),
    delivered,
    pending: countRow.count,
  };
}

function offlineTransitionEventId(rows: OfflineTransitionRow[]): string {
  const canonical = rows
    .map((row) => `${row.device_id}\u0000${row.last_seen_at}`)
    .join("\n");
  const digest = createHash("sha256").update(canonical).digest("hex").slice(0, 32);
  return `device-offline:${digest}`;
}

function storedControllerEvent(row: OutboxRow): ControllerEvent | null {
  try {
    const parsed = JSON.parse(row.event_json) as Partial<ControllerEvent>;
    if (
      parsed.schema !== CONTROLLER_EVENT_SCHEMA
      || parsed.v !== 1
      || parsed.event_id !== row.event_id
      || parsed.event_type !== "device.offline"
      || parsed.source !== "scheduled"
      || !Array.isArray(parsed.device_ids)
      || parsed.device_ids.length < 1
      || parsed.device_ids.length > MAX_DEVICE_IDS_PER_EVENT
      || parsed.device_ids.some((value) => !cleanIdentifier(value))
      || !Array.isArray(parsed.reason_codes)
      || parsed.reason_codes.length !== 1
      || parsed.reason_codes[0] !== "heartbeat_timeout"
      || typeof parsed.occurred_at !== "string"
      || Number.isNaN(Date.parse(parsed.occurred_at))
    ) {
      return null;
    }
    return parsed as ControllerEvent;
  } catch {
    return null;
  }
}

function deliveryFailureReason(delivery: ControllerWebhookDelivery): string {
  return (delivery.reason || (delivery.status ? `http_${delivery.status}` : "unknown"))
    .replace(/[^a-zA-Z0-9_.:-]/g, "_")
    .slice(0, 80);
}

function validIsoTimestamp(value: Date): string {
  return Number.isFinite(value.getTime()) ? value.toISOString() : new Date().toISOString();
}

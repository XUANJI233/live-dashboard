import { createHash } from "node:crypto";
import { db, markOfflineDevices } from "../db";
import {
  CONTROLLER_EVENT_SCHEMA,
  controllerWebhookEnabled,
  type ControllerEvent,
} from "./controller-webhook";
import {
  controllerEventPendingCount,
  enqueueControllerEvent,
  flushControllerEvents,
} from "./controller-event-outbox";
import { hermesControllerEnabled } from "./controller-mode";
import { controllerExplicitlyPaused } from "./controller-persona";
import { cleanIdentifier } from "./mcp-contracts";

interface OfflineTransitionRow {
  device_id: string;
  last_seen_at: string;
}

export interface OfflineControllerCheckResult {
  transitioned: string[];
  delivered: number;
  pending: number;
}

const MAX_DEVICE_IDS_PER_EVENT = 20;

const transitionAndQueueOfflineEvents = db.transaction((occurredAt: string, shouldQueue: boolean) => {
  const rows = markOfflineDevices.all() as OfflineTransitionRow[];
  queueOfflineEvents(rows, occurredAt, shouldQueue);
  return rows;
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
    enqueueControllerEvent(event, occurredAt);
  }
}

/**
 * Mark newly stale devices offline, durably enqueue one minimal controller
 * event per transition batch, and retry every pending event.
 */
export async function checkOfflineDevices(now = new Date()): Promise<OfflineControllerCheckResult> {
  const occurredAt = validIsoTimestamp(now);
  const controllerActive = hermesControllerEnabled() && controllerWebhookEnabled();
  // Devices still go offline while the controller is paused; it just isn't woken for them.
  const shouldQueue = controllerActive && !controllerExplicitlyPaused();
  const transitionedRows = transitionAndQueueOfflineEvents(occurredAt, shouldQueue) as OfflineTransitionRow[];

  const flush = controllerActive
    ? await flushControllerEvents(now)
    : { delivered_ids: [], pending: controllerEventPendingCount() };
  return {
    transitioned: transitionedRows.map((row) => row.device_id),
    delivered: flush.delivered_ids.length,
    pending: flush.pending,
  };
}

function offlineTransitionEventId(rows: OfflineTransitionRow[]): string {
  const canonical = rows
    .map((row) => `${row.device_id}\u0000${row.last_seen_at}`)
    .join("\n");
  const digest = createHash("sha256").update(canonical).digest("hex").slice(0, 32);
  return `device-offline:${digest}`;
}

function validIsoTimestamp(value: Date): string {
  return Number.isFinite(value.getTime()) ? value.toISOString() : new Date().toISOString();
}

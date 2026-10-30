import { createHash } from "node:crypto";
import { CONTROLLER_EVENT_SCHEMA, type ControllerEvent } from "./controller-webhook";

// The `ledger.due` controller event: Live's scheduler wakes Hermes when agreed times arrive. It
// names no records; the consumer reads `ledger.due_now` from its one controller context. Rules
// shared with deploy/hermes/trigger_live_supervision.py; both sides run
// deploy/hermes/tests/fixtures/controller_events.json.

export const LEDGER_DUE_DEVICE = "__server_scheduler__";
export const LEDGER_DUE_REASONS = ["promise_due", "debt_due", "state_end"] as const;

const KIND_REASONS: Record<string, typeof LEDGER_DUE_REASONS[number]> = {
  promise: "promise_due",
  debt: "debt_due",
  state: "state_end",
};

export function ledgerDueEvent(rows: Array<{ record_id: string; kind: string; due_at: string }>, occurredAt: string): ControllerEvent {
  const reasons = new Set(rows.map((row) => KIND_REASONS[row.kind]));
  return {
    schema: CONTROLLER_EVENT_SCHEMA,
    v: 1,
    event_id: ledgerDueEventId(rows),
    event_type: "ledger.due",
    occurred_at: occurredAt,
    source: "scheduled",
    device_ids: [LEDGER_DUE_DEVICE],
    reason_codes: LEDGER_DUE_REASONS.filter((reason) => reasons.has(reason)),
  };
}

/** One id per due set: Live's retries reuse it, and a moved due time gets a new one. */
export function ledgerDueEventId(rows: Array<{ record_id: string; due_at: string }>): string {
  const canonical = rows
    .map((row) => `${row.record_id}\u0000${row.due_at}`)
    .sort()
    .join("\n");
  return `ledger-due:${createHash("sha256").update(canonical).digest("hex").slice(0, 32)}`;
}

export function validLedgerDue(event: Partial<ControllerEvent>): boolean {
  const reasons = event.reason_codes;
  return event.source === "scheduled"
    && Array.isArray(event.device_ids)
    && event.device_ids.length === 1
    && event.device_ids[0] === LEDGER_DUE_DEVICE
    && Array.isArray(reasons)
    && new Set(reasons).size === reasons.length
    && reasons.every((reason) => (LEDGER_DUE_REASONS as readonly string[]).includes(reason));
}

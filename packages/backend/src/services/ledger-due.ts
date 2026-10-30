import { db } from "../db";
import { enqueueControllerEvent } from "./controller-event-outbox";
import { hermesControllerEnabled } from "./controller-mode";
import { controllerExplicitlyPaused } from "./controller-persona";
import { controllerWebhookEnabled } from "./controller-webhook";
import { getSummarySettings } from "./daily-summary-gen";
import { trustedWatchSleepingAt } from "./health-context";
import { ledgerDueEvent } from "./ledger-due-event";
import { WAKE_STALE_MS } from "./ledger-rules";
import { markLedgerDueNotified, pendingDueLedgerRecords } from "./ledger-store";

export type LedgerWakeResult = "queued" | "idle" | "gated";

// When a promise, debt or state falls due, Live queues one signed `ledger.due` event through the
// controller outbox. A closed gate leaves the records un-notified: they stay in ledger.due_now for
// any run, and wake the controller once the gate opens, unless they are hours late by then.

const queueDueTransaction = db.transaction((nowIso: string, staleBefore: string): boolean => {
  const rows = pendingDueLedgerRecords(nowIso);
  const stale = rows.filter((row) => row.due_at < staleBefore);
  const fresh = rows.filter((row) => row.due_at >= staleBefore);
  markLedgerDueNotified(stale.map((row) => row.record_id), nowIso);
  if (fresh.length === 0) return false;
  if (enqueueControllerEvent(ledgerDueEvent(fresh, nowIso), nowIso) === "invalid") {
    throw new Error("invalid_ledger_due_event");
  }
  markLedgerDueNotified(fresh.map((row) => row.record_id), nowIso);
  return true;
});

export function queueDueLedgerWake(now = new Date()): LedgerWakeResult {
  if (!ledgerWakeAllowed(now)) return "gated";
  const nowIso = now.toISOString();
  const staleBefore = new Date(now.getTime() - WAKE_STALE_MS).toISOString();
  return queueDueTransaction(nowIso, staleBefore) ? "queued" : "idle";
}

function ledgerWakeAllowed(now: Date): boolean {
  return hermesControllerEnabled()
    && controllerWebhookEnabled()
    && !controllerExplicitlyPaused()
    && getSummarySettings().supervision_enabled === true
    && !trustedWatchSleepingAt(now);
}

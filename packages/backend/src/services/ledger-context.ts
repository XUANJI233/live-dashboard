import { formatPromptMinute } from "./prompt-time";
import { ledgerTrack } from "./ledger";
import { LEDGER_DUE_NOW_LIMIT, clipLedgerText as clip, fitLedgerSection } from "./ledger-context-trim";
import { closedLedgerRecordsBetween, openLedgerRecords, type LedgerRow } from "./ledger-store";

// The ledger section of get_controller_context: what is due now (never dropped), what is open,
// recent breaches, the strongest hypotheses, and the kept/broken track. Older and closed records
// stay reachable through ledger_search. The section caps itself (ledger-context-trim.ts) before
// the envelope budget runs.

interface ModeLimits {
  open: number;
  breaches: number;
  hypotheses: number;
  closed: number;
}

const ACTION_LIMITS: ModeLimits = { open: 4, breaches: 2, hypotheses: 2, closed: 0 };
const CONVERSATION_LIMITS: ModeLimits = { open: 6, breaches: 3, hypotheses: 3, closed: 0 };
const SUMMARY_LIMITS: ModeLimits = { open: 6, breaches: 3, hypotheses: 3, closed: 8 };
// The memory job never writes the ledger, so it gets no section.
const MODE_LIMITS: Record<string, ModeLimits | null> = {
  supervision: ACTION_LIMITS,
  policy: ACTION_LIMITS,
  companion: CONVERSATION_LIMITS,
  followup: CONVERSATION_LIMITS,
  daily: SUMMARY_LIMITS,
  weekly: SUMMARY_LIMITS,
  memory: null,
};
const CONFIDENCE_RANK: Record<string, number> = { low: 1, medium: 2, high: 3 };

export function ledgerContext(input: {
  mode: string;
  range: { start: string; end: string };
  timezoneOffset: number;
  now: Date;
}): { section: Record<string, unknown> | null; truncated: boolean } {
  const limits = MODE_LIMITS[input.mode];
  if (!limits) return { section: null, truncated: false };
  const local = (value: string) => formatPromptMinute(value, input.timezoneOffset);
  const nowMs = input.now.getTime();
  const open = openLedgerRecords();
  const dated = open.filter((row) => row.kind === "promise" || row.kind === "debt" || row.kind === "state");
  const due = dated.filter((row) => row.due_at && Date.parse(row.due_at) <= nowMs);
  const pending = dated.filter((row) => !due.includes(row));
  const breaches = open.filter((row) => row.kind === "breach")
    .sort((left, right) => right.created_at.localeCompare(left.created_at));
  const hypotheses = open.filter((row) => row.kind === "hypothesis")
    .sort((left, right) => (CONFIDENCE_RANK[right.confidence] ?? 0) - (CONFIDENCE_RANK[left.confidence] ?? 0)
      || right.updated_at.localeCompare(left.updated_at));

  const section: Record<string, unknown> = {
    due_now: due.slice(0, LEDGER_DUE_NOW_LIMIT).map((row) => ({
      record_id: row.record_id,
      kind: row.kind,
      title: row.title,
      ...(row.detail ? { detail: clip(row.detail, 120) } : {}),
      ...(row.stake ? { stake: clip(row.stake, 80) } : {}),
      due_at: row.due_at,
      due_local: local(row.due_at),
      overdue_minutes: Math.max(0, Math.floor((nowMs - Date.parse(row.due_at)) / 60_000)),
    })),
    open: pending.slice(0, limits.open).map((row) => ({
      record_id: row.record_id,
      kind: row.kind,
      ...(row.subtype ? { subtype: row.subtype } : {}),
      title: row.title,
      ...(row.due_at ? { due_local: local(row.due_at) } : {}),
      ...(row.stake ? { stake: clip(row.stake, 60) } : {}),
    })),
    breaches: breaches.slice(0, limits.breaches).map((row) => ({
      record_id: row.record_id,
      subtype: row.subtype,
      title: row.title,
      at_local: local(row.created_at),
    })),
    hypotheses: hypotheses.slice(0, limits.hypotheses).map((row) => ({
      record_id: row.record_id,
      subtype: row.subtype,
      title: row.title,
      confidence: row.confidence,
    })),
    ...(limits.closed > 0 ? {
      closed_in_range: closedLedgerRecordsBetween(input.range.start, input.range.end, limits.closed)
        .map((row: LedgerRow) => ({ record_id: row.record_id, kind: row.kind, title: row.title, outcome: row.outcome })),
    } : {}),
    track: ledgerTrack(input.now, input.timezoneOffset),
    counts: { due: due.length, open: pending.length, breaches: breaches.length, hypotheses: hypotheses.length },
  };
  return { section, truncated: fitLedgerSection(section) };
}

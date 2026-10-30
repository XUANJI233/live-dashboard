// Fixed rules of the supervision ledger: which kinds exist, what each may carry, how a record
// closes, and the clocks Live applies on its own. Pure data; ledger.ts enforces it.

export const LEDGER_KINDS = ["promise", "debt", "breach", "hypothesis", "state"] as const;
export type LedgerKind = typeof LEDGER_KINDS[number];

export const LEDGER_SUBTYPES: Record<LedgerKind, readonly string[]> = {
  promise: [],
  debt: ["task", "consequence"],
  breach: ["false_claim", "bypass"],
  hypothesis: ["helps", "blocks"],
  state: ["observation", "streak", "other"],
};
export const LEDGER_SUBTYPE_VALUES = [
  "task", "consequence", "false_claim", "bypass", "helps", "blocks", "observation", "streak", "other",
] as const;

export const EVIDENCE_SOURCES = ["his_words", "his_submission", "live_data"] as const;
export type EvidenceSource = typeof EVIDENCE_SOURCES[number];

export const CONFIDENCE_LEVELS = ["low", "medium", "high"] as const;
export type Confidence = typeof CONFIDENCE_LEVELS[number];

// Outcomes the controller sets, and the ones only Live's own clocks set.
export const LEDGER_OUTCOMES = [
  "kept", "broken", "paid", "cancelled", "waived", "forgiven", "resolved", "refuted", "retired", "ended",
] as const;
export type LedgerOutcome = typeof LEDGER_OUTCOMES[number];
export const SYSTEM_OUTCOMES = ["lapsed", "faded", "stale"] as const;

export const KIND_OUTCOMES: Record<LedgerKind, readonly LedgerOutcome[]> = {
  promise: ["kept", "broken", "cancelled", "waived"],
  debt: ["paid", "broken", "cancelled", "waived"],
  breach: ["resolved", "forgiven", "refuted"],
  hypothesis: ["refuted", "retired"],
  state: ["ended", "cancelled"],
};
// Delivery is checked, not claimed: his submission or a Live record.
export const DELIVERY_OUTCOMES = new Set<LedgerOutcome>(["kept", "paid"]);
// Leniency and cancellation say where they came from.
export const NOTE_OUTCOMES = new Set<LedgerOutcome>(["cancelled", "waived", "forgiven"]);

export const MAX_OPEN_RECORDS: Record<LedgerKind, number> = {
  promise: 12,
  debt: 12,
  breach: 12,
  hypothesis: 12,
  state: 4,
};

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export const DUE_RULES: Record<LedgerKind, { use: "required" | "optional" | "none"; maxMs: number }> = {
  promise: { use: "required", maxMs: 7 * DAY_MS },
  debt: { use: "optional", maxMs: 7 * DAY_MS },
  state: { use: "required", maxMs: 30 * DAY_MS },
  breach: { use: "none", maxMs: 0 },
  hypothesis: { use: "none", maxMs: 0 },
};
export const MIN_DUE_LEAD_MS = MINUTE_MS;

export const TEXT_LIMITS = {
  title: 60,
  detail: 300,
  stake: 120,
  note: 160,
  evidence: 200,
  ref: 160,
} as const;
export const MAX_EVIDENCE_PER_RECORD = 8;

export const EVIDENCE_MAX_AGE_MS = 30 * DAY_MS;
export const EVIDENCE_FUTURE_SKEW_MS = 5 * MINUTE_MS;
// A visitor message this recent that contains a "his words" quote means the quote is not his.
export const VISITOR_QUOTE_WINDOW_MS = 30 * DAY_MS;
export const MIN_CHECKED_QUOTE_LENGTH = 6;

// A due time first seen this late (gate closed, sleep, outage) no longer wakes the controller.
export const WAKE_STALE_MS = 3 * HOUR_MS;
export const LAPSE_AFTER_DUE_MS = 48 * HOUR_MS;
export const UNDATED_DEBT_LAPSE_MS = 30 * DAY_MS;
export const STATE_GRACE_MS = 24 * HOUR_MS;
export const BREACH_FADE_MS = 30 * DAY_MS;
export const HYPOTHESIS_STALE_MS = 30 * DAY_MS;
export const CLOSED_RETENTION_MS = 180 * DAY_MS;
export const TRACK_WINDOW_MS = 7 * DAY_MS;

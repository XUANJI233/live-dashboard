import { db } from "../db";
import type { EvidenceSource, LedgerKind } from "./ledger-rules";

// Persistence for the supervision ledger. No rules live here: ledger.ts decides what is valid and
// ledger-rules.ts holds the limits and clocks. Nothing outside the ledger reads this table, so it
// is created here instead of in db.ts. Every timestamp is a UTC toISOString() value, so plain
// string comparison orders them.

db.run(`
  CREATE TABLE IF NOT EXISTS ledger_records (
    record_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('promise', 'debt', 'breach', 'hypothesis', 'state')),
    subtype TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    stake TEXT NOT NULL DEFAULT '',
    confidence TEXT NOT NULL DEFAULT '' CHECK (confidence IN ('', 'low', 'medium', 'high')),
    evidence TEXT NOT NULL DEFAULT '[]',
    parent_id TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
    outcome TEXT NOT NULL DEFAULT '',
    outcome_note TEXT NOT NULL DEFAULT '',
    due_at TEXT NOT NULL DEFAULT '',
    due_notified_at TEXT NOT NULL DEFAULT '',
    fingerprint TEXT NOT NULL,
    search_text TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    closed_at TEXT NOT NULL DEFAULT ''
  )
`);
db.run("CREATE INDEX IF NOT EXISTS idx_ledger_open ON ledger_records(kind, due_at) WHERE status = 'open'");
db.run(`
  CREATE INDEX IF NOT EXISTS idx_ledger_due_pending ON ledger_records(due_at)
  WHERE status = 'open' AND due_at <> '' AND due_notified_at = ''
`);
db.run("CREATE INDEX IF NOT EXISTS idx_ledger_created ON ledger_records(created_at DESC, record_id DESC)");
db.run("CREATE INDEX IF NOT EXISTS idx_ledger_closed ON ledger_records(closed_at) WHERE status = 'closed'");
db.run("CREATE INDEX IF NOT EXISTS idx_ledger_fingerprint ON ledger_records(fingerprint) WHERE status = 'open'");

export type EvidenceRole = "basis" | "support" | "counter" | "settlement";

export interface EvidenceItem {
  role: EvidenceRole;
  source: EvidenceSource;
  text: string;
  at: string;
  ref?: string;
}

export interface LedgerRow {
  record_id: string;
  kind: LedgerKind;
  subtype: string;
  title: string;
  detail: string;
  stake: string;
  confidence: string;
  evidence: string;
  parent_id: string;
  status: "open" | "closed";
  outcome: string;
  outcome_note: string;
  due_at: string;
  due_notified_at: string;
  fingerprint: string;
  search_text: string;
  created_at: string;
  updated_at: string;
  closed_at: string;
}

export interface LedgerSearchFilter {
  pattern?: string;
  kinds?: string[];
  status?: "open" | "closed";
  outcome?: string;
  timeField: "created_at" | "due_at" | "closed_at";
  from?: string;
  to?: string;
  cursor?: { created_at: string; record_id: string };
  limit: number;
}

const insertRecordStmt = db.prepare(`
  INSERT INTO ledger_records (
    record_id, kind, subtype, title, detail, stake, confidence, evidence, parent_id, status,
    outcome, outcome_note, due_at, due_notified_at, fingerprint, search_text, created_at, updated_at, closed_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const getRecordStmt = db.prepare("SELECT * FROM ledger_records WHERE record_id = ?");
const openByFingerprintStmt = db.prepare(`
  SELECT * FROM ledger_records WHERE status = 'open' AND fingerprint = ? ORDER BY created_at ASC LIMIT 1
`);
const countOpenStmt = db.prepare("SELECT COUNT(*) AS count FROM ledger_records WHERE status = 'open' AND kind = ?");
const saveRecordStmt = db.prepare(`
  UPDATE ledger_records
  SET title = ?, detail = ?, stake = ?, confidence = ?, evidence = ?, status = ?, outcome = ?,
      outcome_note = ?, due_at = ?, due_notified_at = ?, search_text = ?, updated_at = ?, closed_at = ?
  WHERE record_id = ?
`);
const openRecordsStmt = db.prepare(`
  SELECT * FROM ledger_records WHERE status = 'open'
  ORDER BY CASE WHEN due_at = '' THEN 1 ELSE 0 END, due_at ASC, created_at DESC
`);
const closedBetweenStmt = db.prepare(`
  SELECT * FROM ledger_records
  WHERE status = 'closed' AND closed_at >= ? AND closed_at < ?
  ORDER BY closed_at DESC
  LIMIT ?
`);
const pendingDueStmt = db.prepare(`
  SELECT * FROM ledger_records
  WHERE status = 'open' AND due_at <> '' AND due_notified_at = '' AND due_at <= ?
  ORDER BY due_at ASC, record_id ASC
`);
const markDueNotifiedStmt = db.prepare(`
  UPDATE ledger_records SET due_notified_at = ? WHERE record_id = ? AND due_notified_at = ''
`);
const promiseOutcomesStmt = db.prepare(`
  SELECT outcome, closed_at FROM ledger_records
  WHERE kind = 'promise' AND outcome IN ('kept', 'broken')
  ORDER BY closed_at DESC
  LIMIT ?
`);
const promiseOutcomesSinceStmt = db.prepare(`
  SELECT outcome, COUNT(*) AS count FROM ledger_records
  WHERE kind = 'promise' AND outcome IN ('kept', 'broken') AND closed_at >= ?
  GROUP BY outcome
`);
const lastBrokenStmt = db.prepare(`
  SELECT * FROM ledger_records WHERE kind = 'promise' AND outcome = 'broken' ORDER BY closed_at DESC LIMIT 1
`);
const closeDatedLapsedStmt = db.prepare(`
  UPDATE ledger_records SET status = 'closed', outcome = 'lapsed', closed_at = ?, updated_at = ?
  WHERE status = 'open' AND kind IN ('promise', 'debt') AND due_at <> '' AND due_at <= ?
`);
const closeUndatedDebtStmt = db.prepare(`
  UPDATE ledger_records SET status = 'closed', outcome = 'lapsed', closed_at = ?, updated_at = ?
  WHERE status = 'open' AND kind = 'debt' AND due_at = '' AND updated_at <= ?
`);
const closeEndedStateStmt = db.prepare(`
  UPDATE ledger_records SET status = 'closed', outcome = 'ended', closed_at = ?, updated_at = ?
  WHERE status = 'open' AND kind = 'state' AND due_at <> '' AND due_at <= ?
`);
const closeFadedBreachStmt = db.prepare(`
  UPDATE ledger_records SET status = 'closed', outcome = 'faded', closed_at = ?, updated_at = ?
  WHERE status = 'open' AND kind = 'breach' AND created_at <= ?
`);
const closeStaleHypothesisStmt = db.prepare(`
  UPDATE ledger_records SET status = 'closed', outcome = 'stale', closed_at = ?, updated_at = ?
  WHERE status = 'open' AND kind = 'hypothesis' AND updated_at <= ?
`);
const pruneClosedStmt = db.prepare("DELETE FROM ledger_records WHERE status = 'closed' AND closed_at <= ?");

export function insertLedgerRecord(row: LedgerRow): LedgerRow {
  insertRecordStmt.run(
    row.record_id, row.kind, row.subtype, row.title, row.detail, row.stake, row.confidence, row.evidence,
    row.parent_id, row.status, row.outcome, row.outcome_note, row.due_at, row.due_notified_at,
    row.fingerprint, row.search_text, row.created_at, row.updated_at, row.closed_at,
  );
  return getLedgerRecord(row.record_id)!;
}

export function getLedgerRecord(recordId: string): LedgerRow | null {
  return getRecordStmt.get(recordId) as LedgerRow | null;
}

export function openLedgerRecordByFingerprint(fingerprint: string): LedgerRow | null {
  return openByFingerprintStmt.get(fingerprint) as LedgerRow | null;
}

export function countOpenLedgerRecords(kind: LedgerKind): number {
  return (countOpenStmt.get(kind) as { count: number }).count;
}

export function saveLedgerRecord(row: LedgerRow): LedgerRow {
  saveRecordStmt.run(
    row.title, row.detail, row.stake, row.confidence, row.evidence, row.status, row.outcome,
    row.outcome_note, row.due_at, row.due_notified_at, row.search_text, row.updated_at, row.closed_at,
    row.record_id,
  );
  return getLedgerRecord(row.record_id)!;
}

/** Every open record, dated ones soonest first. Open records are capped per kind, so this stays small. */
export function openLedgerRecords(): LedgerRow[] {
  return openRecordsStmt.all() as LedgerRow[];
}

export function closedLedgerRecordsBetween(start: string, end: string, limit: number): LedgerRow[] {
  return closedBetweenStmt.all(start, end, limit) as LedgerRow[];
}

export function pendingDueLedgerRecords(nowIso: string): LedgerRow[] {
  return pendingDueStmt.all(nowIso) as LedgerRow[];
}

export function markLedgerDueNotified(recordIds: string[], at: string): void {
  for (const recordId of recordIds) markDueNotifiedStmt.run(at, recordId);
}

export function recentPromiseOutcomes(limit: number): Array<{ outcome: string; closed_at: string }> {
  return promiseOutcomesStmt.all(limit) as Array<{ outcome: string; closed_at: string }>;
}

export function promiseOutcomeCountsSince(sinceIso: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of promiseOutcomesSinceStmt.all(sinceIso) as Array<{ outcome: string; count: number }>) {
    counts[row.outcome] = row.count;
  }
  return counts;
}

export function lastBrokenPromise(): LedgerRow | null {
  return lastBrokenStmt.get() as LedgerRow | null;
}

export function searchLedgerRows(filter: LedgerSearchFilter): LedgerRow[] {
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (filter.pattern) {
    clauses.push("search_text LIKE ? ESCAPE '\\'");
    params.push(filter.pattern);
  }
  if (filter.kinds?.length) {
    clauses.push(`kind IN (${filter.kinds.map(() => "?").join(", ")})`);
    params.push(...filter.kinds);
  }
  if (filter.status) {
    clauses.push("status = ?");
    params.push(filter.status);
  }
  if (filter.outcome) {
    clauses.push("outcome = ?");
    params.push(filter.outcome);
  }
  if (filter.from || filter.to) clauses.push(`${filter.timeField} <> ''`);
  if (filter.from) {
    clauses.push(`${filter.timeField} >= ?`);
    params.push(filter.from);
  }
  if (filter.to) {
    clauses.push(`${filter.timeField} < ?`);
    params.push(filter.to);
  }
  if (filter.cursor) {
    clauses.push("(created_at < ? OR (created_at = ? AND record_id < ?))");
    params.push(filter.cursor.created_at, filter.cursor.created_at, filter.cursor.record_id);
  }
  params.push(filter.limit);
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return db.query(`
    SELECT * FROM ledger_records ${where}
    ORDER BY created_at DESC, record_id DESC
    LIMIT ?
  `).all(...params) as LedgerRow[];
}

export interface LedgerSweepCutoffs {
  lapseDueBefore: string;
  lapseUndatedBefore: string;
  endStateBefore: string;
  fadeBreachBefore: string;
  staleHypothesisBefore: string;
  pruneClosedBefore: string;
}

/** Close what Live's own clocks close, then delete closed records past retention. */
export const sweepLedgerRecords = db.transaction((at: string, cutoffs: LedgerSweepCutoffs) => {
  let closed = 0;
  closed += closeDatedLapsedStmt.run(at, at, cutoffs.lapseDueBefore).changes;
  closed += closeUndatedDebtStmt.run(at, at, cutoffs.lapseUndatedBefore).changes;
  closed += closeEndedStateStmt.run(at, at, cutoffs.endStateBefore).changes;
  closed += closeFadedBreachStmt.run(at, at, cutoffs.fadeBreachBefore).changes;
  closed += closeStaleHypothesisStmt.run(at, at, cutoffs.staleHypothesisBefore).changes;
  const pruned = pruneClosedStmt.run(cutoffs.pruneClosedBefore).changes;
  return { closed, pruned };
});

export function ledgerEvidence(row: LedgerRow): EvidenceItem[] {
  try {
    const value = JSON.parse(row.evidence);
    return Array.isArray(value) ? value.filter((item): item is EvidenceItem => !!item && typeof item === "object") : [];
  } catch {
    return [];
  }
}

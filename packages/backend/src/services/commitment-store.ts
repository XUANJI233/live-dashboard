import { db } from "../db";

// Persistence for commitments and their exceptions. No rules live here: callers in
// commitments.ts decide what is valid, and commitment-schedule.ts decides what is in effect.

export type CommitmentKind = "block" | "task";

export interface CommitmentRow {
  commitment_id: string;
  kind: CommitmentKind;
  title: string;
  user_quote: string;
  device_id: string;
  packages: string;
  window_start: string;
  window_end: string;
  timezone_offset_minutes: number;
  starts_at: string;
  ends_at: string;
  daily_exception_limit: number;
  max_exception_minutes: number;
  status: "active" | "ended";
  in_window: number;
  created_at: string;
  updated_at: string;
  ended_at: string;
  end_reason: string;
}

export interface ExceptionRow {
  exception_id: string;
  commitment_id: string;
  package_name: string;
  purpose: string;
  minutes: number;
  granted_at: string;
  relock_at: string;
  relocked_at: string;
  unfreeze_request_id: string;
}

export type NewCommitment = Omit<CommitmentRow, "packages" | "status" | "in_window" | "updated_at" | "ended_at" | "end_reason"> & {
  packages: string[];
};

const insertCommitmentStmt = db.prepare(`
  INSERT INTO controller_commitments (
    commitment_id, kind, title, user_quote, device_id, packages, window_start, window_end,
    timezone_offset_minutes, starts_at, ends_at, daily_exception_limit, max_exception_minutes,
    status, in_window, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 0, ?, ?)
`);
const getCommitmentStmt = db.prepare("SELECT * FROM controller_commitments WHERE commitment_id = ?");
const activeCommitmentsStmt = db.prepare(`
  SELECT * FROM controller_commitments WHERE status = 'active' ORDER BY created_at ASC
`);
const endedInWindowStmt = db.prepare(`
  SELECT * FROM controller_commitments WHERE status = 'ended' AND in_window = 1
`);
const endCommitmentStmt = db.prepare(`
  UPDATE controller_commitments
  SET status = 'ended', ended_at = ?, end_reason = ?, updated_at = ?
  WHERE commitment_id = ? AND status = 'active'
`);
const setInWindowStmt = db.prepare(`
  UPDATE controller_commitments SET in_window = ?, updated_at = ? WHERE commitment_id = ?
`);
const insertExceptionStmt = db.prepare(`
  INSERT INTO commitment_exceptions (
    exception_id, commitment_id, package_name, purpose, minutes, granted_at, relock_at, unfreeze_request_id
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
const exceptionsSinceStmt = db.prepare(`
  SELECT * FROM commitment_exceptions WHERE commitment_id = ? AND granted_at >= ? ORDER BY granted_at ASC
`);
const dueExceptionsStmt = db.prepare(`
  SELECT * FROM commitment_exceptions WHERE relocked_at = '' AND relock_at <= ?
`);
const markRelockedStmt = db.prepare("UPDATE commitment_exceptions SET relocked_at = ? WHERE exception_id = ?");

export function insertCommitment(row: NewCommitment): CommitmentRow {
  insertCommitmentStmt.run(
    row.commitment_id, row.kind, row.title, row.user_quote, row.device_id, JSON.stringify(row.packages),
    row.window_start, row.window_end, row.timezone_offset_minutes, row.starts_at, row.ends_at,
    row.daily_exception_limit, row.max_exception_minutes, row.created_at, row.created_at,
  );
  return getCommitment(row.commitment_id)!;
}

export function getCommitment(commitmentId: string): CommitmentRow | null {
  return getCommitmentStmt.get(commitmentId) as CommitmentRow | null;
}

export function activeCommitmentRows(): CommitmentRow[] {
  return activeCommitmentsStmt.all() as CommitmentRow[];
}

/** Rules that ended while their window was open; their packages still need releasing. */
export function endedCommitmentsStillInWindow(): CommitmentRow[] {
  return endedInWindowStmt.all() as CommitmentRow[];
}

export function markCommitmentEnded(commitmentId: string, endedAt: string, reason: string, at: string): boolean {
  return endCommitmentStmt.run(endedAt, reason, at, commitmentId).changes > 0;
}

export function setCommitmentInWindow(commitmentId: string, inWindow: boolean, at: string): void {
  setInWindowStmt.run(inWindow ? 1 : 0, at, commitmentId);
}

export function commitmentPackages(row: CommitmentRow): string[] {
  try {
    const value = JSON.parse(row.packages);
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export function insertException(row: Omit<ExceptionRow, "relocked_at">): void {
  insertExceptionStmt.run(
    row.exception_id, row.commitment_id, row.package_name, row.purpose, row.minutes,
    row.granted_at, row.relock_at, row.unfreeze_request_id,
  );
}

export function exceptionsSince(commitmentId: string, sinceIso: string): ExceptionRow[] {
  return exceptionsSinceStmt.all(commitmentId, sinceIso) as ExceptionRow[];
}

export function dueExceptions(nowIso: string): ExceptionRow[] {
  return dueExceptionsStmt.all(nowIso) as ExceptionRow[];
}

export function markExceptionRelocked(exceptionId: string, at: string): void {
  markRelockedStmt.run(at, exceptionId);
}

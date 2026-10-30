import { db } from "../db";

// Persistence for commitments and their exceptions. No rules live here: commitments.ts decides
// what is valid, commitment-schedule.ts decides what is in effect.

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
  created_at: string;
  updated_at: string;
  ended_at: string;
  end_reason: string;
}

export interface ExceptionRow {
  exception_id: string;
  group_id: string;
  commitment_id: string;
  device_id: string;
  package_name: string;
  purpose: string;
  minutes: number;
  granted_at: string;
  relock_at: string;
  status: "open" | "refunded";
}

export type NewCommitment = Omit<CommitmentRow, "packages" | "status" | "updated_at" | "ended_at" | "end_reason"> & {
  packages: string[];
};

const insertCommitmentStmt = db.prepare(`
  INSERT INTO controller_commitments (
    commitment_id, kind, title, user_quote, device_id, packages, window_start, window_end,
    timezone_offset_minutes, starts_at, ends_at, daily_exception_limit, max_exception_minutes,
    status, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
`);
const getCommitmentStmt = db.prepare("SELECT * FROM controller_commitments WHERE commitment_id = ?");
const activeCommitmentsStmt = db.prepare(`
  SELECT * FROM controller_commitments WHERE status = 'active' ORDER BY created_at ASC
`);
const endCommitmentStmt = db.prepare(`
  UPDATE controller_commitments
  SET status = 'ended', ended_at = ?, end_reason = ?, updated_at = ?
  WHERE commitment_id = ? AND status = 'active'
`);
const insertExceptionStmt = db.prepare(`
  INSERT INTO commitment_exceptions (
    exception_id, group_id, commitment_id, device_id, package_name, purpose, minutes, granted_at, relock_at, status
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')
`);
const chargesSinceStmt = db.prepare(`
  SELECT * FROM commitment_exceptions
  WHERE commitment_id = ? AND granted_at >= ? AND status = 'open'
  ORDER BY granted_at ASC
`);
const openForPackageStmt = db.prepare(`
  SELECT * FROM commitment_exceptions
  WHERE device_id = ? AND package_name = ? AND status = 'open' AND relock_at > ?
  ORDER BY relock_at DESC
`);
const openForDeviceStmt = db.prepare(`
  SELECT * FROM commitment_exceptions WHERE device_id = ? AND status = 'open' AND relock_at > ?
`);
const refundGroupStmt = db.prepare("UPDATE commitment_exceptions SET status = 'refunded' WHERE group_id = ?");

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

export function markCommitmentEnded(commitmentId: string, endedAt: string, reason: string, at: string): boolean {
  return endCommitmentStmt.run(endedAt, reason, at, commitmentId).changes > 0;
}

export function commitmentPackages(row: CommitmentRow): string[] {
  try {
    const value = JSON.parse(row.packages);
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

/** One charge row per covering rule, all sharing `group_id`. */
export function insertExceptionGroup(rows: Omit<ExceptionRow, "status">[]): void {
  db.transaction(() => {
    for (const row of rows) {
      insertExceptionStmt.run(
        row.exception_id, row.group_id, row.commitment_id, row.device_id, row.package_name,
        row.purpose, row.minutes, row.granted_at, row.relock_at,
      );
    }
  })();
}

export function refundExceptionGroup(groupId: string): void {
  refundGroupStmt.run(groupId);
}

export function exceptionChargesSince(commitmentId: string, sinceIso: string): ExceptionRow[] {
  return chargesSinceStmt.all(commitmentId, sinceIso) as ExceptionRow[];
}

export function openExceptionsForPackage(deviceId: string, packageName: string, nowIso: string): ExceptionRow[] {
  return openForPackageStmt.all(deviceId, packageName, nowIso) as ExceptionRow[];
}

export function openExceptionsForDevice(deviceId: string, nowIso: string): ExceptionRow[] {
  return openForDeviceStmt.all(deviceId, nowIso) as ExceptionRow[];
}

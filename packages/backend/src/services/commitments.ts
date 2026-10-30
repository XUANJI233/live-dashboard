import { db } from "../db";
import { safeTimezoneOffset } from "./cdn";

// A commitment is a rule he set while calm. `block` rules name exact packages that stay frozen
// inside their window until he explicitly ends the rule; `task` rules are only recorded so every
// controller run sees the same promise. Exceptions are time-boxed and counted per local day.

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

export interface RecordCommitmentInput {
  kind: CommitmentKind;
  title: string;
  user_quote: string;
  device_id?: string;
  packages?: string[];
  window_start?: string;
  window_end?: string;
  ends_at?: string;
  daily_exception_limit?: number;
  max_exception_minutes?: number;
  timezone_offset_minutes?: number;
}

const MAX_ACTIVE_COMMITMENTS = 20;
const MAX_PACKAGES = 20;
const PACKAGE_PATTERN = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/;
const CLOCK_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DEFAULT_DAILY_EXCEPTIONS = 2;
const DEFAULT_MAX_EXCEPTION_MINUTES = 30;
const MIN_PURPOSE_LENGTH = 2;

const insertCommitmentStmt = db.prepare(`
  INSERT INTO controller_commitments (
    commitment_id, kind, title, user_quote, device_id, packages, window_start, window_end,
    timezone_offset_minutes, starts_at, ends_at, daily_exception_limit, max_exception_minutes,
    status, in_window, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 0, ?, ?)
`);
const activeRowsStmt = db.prepare(`
  SELECT * FROM controller_commitments WHERE status = 'active' ORDER BY created_at ASC
`);
const commitmentStmt = db.prepare("SELECT * FROM controller_commitments WHERE commitment_id = ?");
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
const markRelockedStmt = db.prepare(`
  UPDATE commitment_exceptions SET relocked_at = ? WHERE exception_id = ?
`);

export function recordCommitment(input: RecordCommitmentInput, now = new Date()): Record<string, unknown> {
  const kind = input.kind === "block" ? "block" : input.kind === "task" ? "task" : null;
  const title = cleanLine(input.title, 80);
  const quote = cleanLine(input.user_quote, 300);
  if (!kind || !title || !quote) throw new Error("invalid_commitment");
  const packages = kind === "block" ? cleanPackages(input.packages) : [];
  const deviceId = kind === "block" ? cleanLine(input.device_id, 160) : "";
  if (kind === "block" && (!deviceId || packages.length === 0)) throw new Error("invalid_commitment");
  const windowStart = cleanLine(input.window_start, 5);
  const windowEnd = cleanLine(input.window_end, 5);
  const hasWindow = windowStart !== "" || windowEnd !== "";
  if (hasWindow && (!CLOCK_PATTERN.test(windowStart) || !CLOCK_PATTERN.test(windowEnd) || windowStart === windowEnd)) {
    throw new Error("invalid_commitment_window");
  }
  const endsAt = input.ends_at ? new Date(input.ends_at) : null;
  if (endsAt && (!Number.isFinite(endsAt.getTime()) || endsAt.getTime() <= now.getTime())) {
    throw new Error("invalid_commitment_end");
  }
  if (activeRowsStmt.all().length >= MAX_ACTIVE_COMMITMENTS) throw new Error("too_many_commitments");

  const id = `cmt_${crypto.randomUUID()}`;
  const at = now.toISOString();
  insertCommitmentStmt.run(
    id, kind, title, quote, deviceId, JSON.stringify(packages), windowStart, windowEnd,
    safeTimezoneOffset(input.timezone_offset_minutes ?? -480), at, endsAt ? endsAt.toISOString() : "",
    boundedCount(input.daily_exception_limit, 0, 5, DEFAULT_DAILY_EXCEPTIONS),
    boundedCount(input.max_exception_minutes, 5, 60, DEFAULT_MAX_EXCEPTION_MINUTES),
    at, at,
  );
  return commitmentView(commitmentStmt.get(id) as CommitmentRow, now);
}

export function endCommitment(commitmentId: string, reason: string, now = new Date()): Record<string, unknown> {
  const at = now.toISOString();
  const result = endCommitmentStmt.run(at, cleanLine(reason, 200) || "ended_by_user", at, commitmentId);
  if (result.changes === 0) throw new Error("commitment_not_found");
  return commitmentView(commitmentStmt.get(commitmentId) as CommitmentRow, now);
}

/** Active rules whose date range covers `now`; rules past `ends_at` are ended here. */
export function activeCommitments(now = new Date()): CommitmentRow[] {
  const rows = activeRowsStmt.all() as CommitmentRow[];
  return rows.filter((row) => {
    if (row.ends_at && Date.parse(row.ends_at) <= now.getTime()) {
      endCommitmentStmt.run(row.ends_at, "expired", now.toISOString(), row.commitment_id);
      return false;
    }
    return Date.parse(row.starts_at) <= now.getTime();
  });
}

export function commitmentInWindow(row: CommitmentRow, now = new Date()): boolean {
  if (!row.window_start || !row.window_end) return true;
  const minute = localMinute(now, row.timezone_offset_minutes);
  const start = clockMinute(row.window_start);
  const end = clockMinute(row.window_end);
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

export function commitmentPackages(row: CommitmentRow): string[] {
  try {
    const value = JSON.parse(row.packages);
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export function openExceptionPackages(commitmentId: string, now = new Date()): Set<string> {
  const since = new Date(now.getTime() - 24 * 60 * 60_000).toISOString();
  return new Set((exceptionsSinceStmt.all(commitmentId, since) as ExceptionRow[])
    .filter((row) => !row.relocked_at && Date.parse(row.relock_at) > now.getTime())
    .map((row) => row.package_name));
}

/** Packages a controller may not unfreeze on this device right now. */
export function lockedPackages(deviceId: string, now = new Date()): Set<string> {
  const locked = new Set<string>();
  for (const row of activeCommitments(now)) {
    if (row.kind !== "block" || row.device_id !== deviceId || !commitmentInWindow(row, now)) continue;
    const open = openExceptionPackages(row.commitment_id, now);
    for (const name of commitmentPackages(row)) if (!open.has(name)) locked.add(name);
  }
  return locked;
}

export interface GrantedException {
  commitment: CommitmentRow;
  exception_id: string;
  relock_at: string;
  exceptions_left_today: number;
}

/** Validate and record one time-boxed exception; the caller sends the unfreeze. */
export function grantException(input: {
  device_id: string;
  package_name: string;
  purpose: string;
  minutes: number;
  unfreeze_request_id: string;
}, now = new Date()): GrantedException {
  const purpose = cleanLine(input.purpose, 200);
  if (purpose.length < MIN_PURPOSE_LENGTH) throw new Error("exception_purpose_required");
  const commitment = activeCommitments(now).find((row) => (
    row.kind === "block"
    && row.device_id === input.device_id
    && commitmentInWindow(row, now)
    && commitmentPackages(row).includes(input.package_name)
  ));
  if (!commitment) throw new Error("not_committed");
  const minutes = Math.trunc(Number(input.minutes));
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > commitment.max_exception_minutes) {
    throw new Error("exception_minutes_out_of_range");
  }
  const usedToday = exceptionsToday(commitment, now).length;
  if (usedToday >= commitment.daily_exception_limit) throw new Error("commitment_exception_denied");
  const id = `exc_${crypto.randomUUID()}`;
  const relockAt = new Date(now.getTime() + minutes * 60_000).toISOString();
  insertExceptionStmt.run(id, commitment.commitment_id, input.package_name, purpose, minutes, now.toISOString(), relockAt, input.unfreeze_request_id);
  return {
    commitment,
    exception_id: id,
    relock_at: relockAt,
    exceptions_left_today: commitment.daily_exception_limit - usedToday - 1,
  };
}

/** Exceptions whose time is up; the enforcement loop re-freezes and marks them. */
export function dueExceptions(now = new Date()): ExceptionRow[] {
  return dueExceptionsStmt.all(now.toISOString()) as ExceptionRow[];
}

export function markExceptionRelocked(exceptionId: string, now = new Date()): void {
  markRelockedStmt.run(now.toISOString(), exceptionId);
}

export function setCommitmentInWindow(commitmentId: string, inWindow: boolean, now = new Date()): void {
  setInWindowStmt.run(inWindow ? 1 : 0, now.toISOString(), commitmentId);
}

export function endedCommitmentsStillMarkedInWindow(): CommitmentRow[] {
  return db.prepare(`
    SELECT * FROM controller_commitments WHERE status = 'ended' AND in_window = 1
  `).all() as CommitmentRow[];
}

export function commitmentsContext(now = new Date()): Record<string, unknown>[] {
  return activeCommitments(now).map((row) => commitmentView(row, now));
}

function commitmentView(row: CommitmentRow, now: Date): Record<string, unknown> {
  const today = exceptionsToday(row, now);
  return {
    commitment_id: row.commitment_id,
    kind: row.kind,
    title: row.title,
    user_quote: row.user_quote,
    status: row.status,
    ...(row.kind === "block" ? {
      device_id: row.device_id,
      packages: commitmentPackages(row),
      window: row.window_start ? { start: row.window_start, end: row.window_end } : null,
      in_window_now: row.status === "active" && commitmentInWindow(row, now),
      daily_exception_limit: row.daily_exception_limit,
      max_exception_minutes: row.max_exception_minutes,
      exceptions_today: today.length,
      exceptions_left_today: Math.max(0, row.daily_exception_limit - today.length),
      open_exceptions: today
        .filter((item) => !item.relocked_at && Date.parse(item.relock_at) > now.getTime())
        .map((item) => ({ package_name: item.package_name, purpose: item.purpose, relock_at: item.relock_at })),
    } : {}),
    starts_at: row.starts_at,
    ends_at: row.ends_at || null,
    ...(row.status === "ended" ? { ended_at: row.ended_at, end_reason: row.end_reason } : {}),
  };
}

function exceptionsToday(row: CommitmentRow, now: Date): ExceptionRow[] {
  return exceptionsSinceStmt.all(row.commitment_id, localMidnightIso(now, row.timezone_offset_minutes)) as ExceptionRow[];
}

function localMinute(now: Date, offsetMinutes: number): number {
  const local = new Date(now.getTime() - offsetMinutes * 60_000);
  return local.getUTCHours() * 60 + local.getUTCMinutes();
}

function localMidnightIso(now: Date, offsetMinutes: number): string {
  const local = new Date(now.getTime() - offsetMinutes * 60_000);
  local.setUTCHours(0, 0, 0, 0);
  return new Date(local.getTime() + offsetMinutes * 60_000).toISOString();
}

function clockMinute(value: string): number {
  const [hours, minutes] = value.split(":").map((part) => Number.parseInt(part, 10));
  return hours! * 60 + minutes!;
}

function cleanPackages(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const name = cleanLine(item, 160);
    if (!PACKAGE_PATTERN.test(name)) throw new Error("invalid_commitment_package");
    if (!out.includes(name)) out.push(name);
  }
  if (out.length > MAX_PACKAGES) throw new Error("invalid_commitment_package");
  return out;
}

function cleanLine(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, maxLength) : "";
}

function boundedCount(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Math.trunc(Number(value));
  if (value === undefined || value === null || !Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

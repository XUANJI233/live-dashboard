import { safeTimezoneOffset } from "./cdn";
import { isClock, localMidnightIso, windowContains } from "./commitment-schedule";
import {
  activeCommitmentRows,
  commitmentPackages,
  exceptionsSince,
  getCommitment,
  insertCommitment,
  insertException,
  markCommitmentEnded,
  type CommitmentKind,
  type CommitmentRow,
  type ExceptionRow,
} from "./commitment-store";

// A commitment is a rule he set while calm. `block` rules name exact packages that stay frozen
// inside their window until he explicitly ends the rule; `task` rules are only recorded so every
// controller run sees the same promise. Exceptions are time-boxed and counted per local day.
// Persistence is commitment-store.ts, time rules commitment-schedule.ts, enforcement
// commitment-enforcement.ts.

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

export interface GrantedException {
  commitment: CommitmentRow;
  exception_id: string;
  relock_at: string;
  exceptions_left_today: number;
}

const MAX_ACTIVE_COMMITMENTS = 20;
const MAX_PACKAGES = 20;
const PACKAGE_PATTERN = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/;
const DEFAULT_DAILY_EXCEPTIONS = 2;
const DEFAULT_MAX_EXCEPTION_MINUTES = 30;
const MIN_PURPOSE_LENGTH = 2;

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
  if ((windowStart || windowEnd) && (!isClock(windowStart) || !isClock(windowEnd) || windowStart === windowEnd)) {
    throw new Error("invalid_commitment_window");
  }
  const endsAt = input.ends_at ? new Date(input.ends_at) : null;
  if (endsAt && (!Number.isFinite(endsAt.getTime()) || endsAt.getTime() <= now.getTime())) {
    throw new Error("invalid_commitment_end");
  }
  if (activeCommitmentRows().length >= MAX_ACTIVE_COMMITMENTS) throw new Error("too_many_commitments");

  const at = now.toISOString();
  const row = insertCommitment({
    commitment_id: `cmt_${crypto.randomUUID()}`,
    kind,
    title,
    user_quote: quote,
    device_id: deviceId,
    packages,
    window_start: windowStart,
    window_end: windowEnd,
    timezone_offset_minutes: safeTimezoneOffset(input.timezone_offset_minutes ?? -480),
    starts_at: at,
    ends_at: endsAt ? endsAt.toISOString() : "",
    daily_exception_limit: boundedCount(input.daily_exception_limit, 0, 5, DEFAULT_DAILY_EXCEPTIONS),
    max_exception_minutes: boundedCount(input.max_exception_minutes, 5, 60, DEFAULT_MAX_EXCEPTION_MINUTES),
    created_at: at,
  });
  return commitmentView(row, now);
}

export function endCommitment(commitmentId: string, reason: string, now = new Date()): Record<string, unknown> {
  const at = now.toISOString();
  if (!markCommitmentEnded(commitmentId, at, cleanLine(reason, 200) || "ended_by_user", at)) {
    throw new Error("commitment_not_found");
  }
  return commitmentView(getCommitment(commitmentId)!, now);
}

/** Active rules whose date range covers `now`; rules past `ends_at` are ended here. */
export function activeCommitments(now = new Date()): CommitmentRow[] {
  return activeCommitmentRows().filter((row) => {
    if (row.ends_at && Date.parse(row.ends_at) <= now.getTime()) {
      markCommitmentEnded(row.commitment_id, row.ends_at, "expired", now.toISOString());
      return false;
    }
    return Date.parse(row.starts_at) <= now.getTime();
  });
}

export function commitmentInWindow(row: CommitmentRow, now = new Date()): boolean {
  return windowContains(row, now);
}

export function openExceptionPackages(commitmentId: string, now = new Date()): Set<string> {
  const since = new Date(now.getTime() - 24 * 60 * 60_000).toISOString();
  return new Set(exceptionsSince(commitmentId, since)
    .filter((row) => isOpen(row, now))
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
  const exceptionId = `exc_${crypto.randomUUID()}`;
  const relockAt = new Date(now.getTime() + minutes * 60_000).toISOString();
  insertException({
    exception_id: exceptionId,
    commitment_id: commitment.commitment_id,
    package_name: input.package_name,
    purpose,
    minutes,
    granted_at: now.toISOString(),
    relock_at: relockAt,
    unfreeze_request_id: input.unfreeze_request_id,
  });
  return {
    commitment,
    exception_id: exceptionId,
    relock_at: relockAt,
    exceptions_left_today: commitment.daily_exception_limit - usedToday - 1,
  };
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
        .filter((item) => isOpen(item, now))
        .map((item) => ({ package_name: item.package_name, purpose: item.purpose, relock_at: item.relock_at })),
    } : {}),
    starts_at: row.starts_at,
    ends_at: row.ends_at || null,
    ...(row.status === "ended" ? { ended_at: row.ended_at, end_reason: row.end_reason } : {}),
  };
}

function exceptionsToday(row: CommitmentRow, now: Date): ExceptionRow[] {
  return exceptionsSince(row.commitment_id, localMidnightIso(now, row.timezone_offset_minutes));
}

function isOpen(exception: ExceptionRow, now: Date): boolean {
  return !exception.relocked_at && Date.parse(exception.relock_at) > now.getTime();
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

import { safeTimezoneOffset } from "./cdn";
import { isClock, localMidnightIso, windowContains } from "./commitment-schedule";
import {
  activeCommitmentRows,
  commitmentPackages,
  exceptionChargesSince,
  getCommitment,
  insertCommitment,
  insertExceptionGroup,
  markCommitmentEnded,
  openExceptionsForDevice,
  openExceptionsForPackage,
  refundExceptionGroup,
  type CommitmentKind,
  type CommitmentRow,
  type ExceptionRow,
} from "./commitment-store";
import { deviceSupportsCommand, getDeviceContext, getDeviceInstalledApps } from "./device-context";

// A commitment is a rule he set while calm. `block` rules name exact packages that stay frozen
// inside their window until he explicitly ends the rule; `task` rules are only recorded so every
// controller run sees the same promise. An exception opens one package on one device for every
// rule holding it, charged to each rule's own daily quota.
// Persistence: commitment-store.ts. Time rules: commitment-schedule.ts. Phone sync:
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
  group_id: string;
  reused: boolean;
  commitment_ids: string[];
  relock_at: string;
  exceptions_left_today: number;
}

const MAX_ACTIVE_COMMITMENTS = 20;
const MAX_PACKAGES = 20;
const PACKAGE_PATTERN = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/;
// ends_at must say which clock it means; a bare local time would be read as server UTC.
const EXPLICIT_OFFSET = /(?:Z|[+-]\d{2}:\d{2})$/i;
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
  if (kind === "block") {
    const device = getDeviceContext(deviceId);
    if (!device) throw new Error("device_not_found");
    if (!deviceSupportsCommand(device, "freeze")) throw new Error("device_cannot_freeze");
  }
  const windowStart = cleanLine(input.window_start, 5);
  const windowEnd = cleanLine(input.window_end, 5);
  if ((windowStart || windowEnd) && (!isClock(windowStart) || !isClock(windowEnd) || windowStart === windowEnd)) {
    throw new Error("invalid_commitment_window");
  }
  const endsText = cleanLine(input.ends_at, 40);
  const endsAt = endsText ? new Date(endsText) : null;
  if (endsAt && (!EXPLICIT_OFFSET.test(endsText) || !Number.isFinite(endsAt.getTime()) || endsAt.getTime() <= now.getTime())) {
    throw new Error("invalid_commitment_end");
  }
  const terms = {
    timezone_offset_minutes: safeTimezoneOffset(input.timezone_offset_minutes ?? -480),
    ends_at: endsAt ? endsAt.toISOString() : "",
    daily_exception_limit: boundedCount(input.daily_exception_limit, 0, 5, DEFAULT_DAILY_EXCEPTIONS),
    max_exception_minutes: boundedCount(input.max_exception_minutes, 5, 60, DEFAULT_MAX_EXCEPTION_MINUTES),
  };
  // The very same rule recorded twice (two runs reading the same words) returns the first one.
  // A rule that differs in any term is recorded alongside; the strictest of them then applies.
  const same = activeCommitmentRows().find((row) => row.kind === kind && row.ends_at === terms.ends_at
    && row.daily_exception_limit === terms.daily_exception_limit && row.max_exception_minutes === terms.max_exception_minutes
    && row.timezone_offset_minutes === terms.timezone_offset_minutes && (kind === "block"
      ? row.device_id === deviceId && sameSet(commitmentPackages(row), packages)
        && row.window_start === windowStart && row.window_end === windowEnd
      : row.title === title && row.user_quote === quote));
  if (same) return { ...commitmentView(same, now), duplicate: true };
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
    starts_at: at,
    ...terms,
    created_at: at,
  });
  const installed = new Set(getDeviceInstalledApps(deviceId).installed_apps.map((app) => app.package_name));
  // Kept in the rule: a reinstalled app is frozen as soon as the phone can find it.
  const notInstalled = installed.size > 0 ? packages.filter((name) => !installed.has(name)) : [];
  return { ...commitmentView(row, now), ...(notInstalled.length ? { not_installed: notInstalled } : {}) };
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

/** Devices any active block rule targets. */
export function committedDevices(now = new Date()): string[] {
  return [...new Set(activeCommitments(now).filter((row) => row.kind === "block").map((row) => row.device_id))];
}

/** Packages that must be frozen on this device now: in-window rules minus open exceptions. */
export function lockedPackages(deviceId: string, now = new Date()): Set<string> {
  const open = new Set(openExceptionsForDevice(deviceId, now.toISOString()).map((row) => row.package_name));
  const locked = new Set<string>();
  for (const row of coveringRules(deviceId, now)) {
    for (const name of commitmentPackages(row)) if (!open.has(name)) locked.add(name);
  }
  return locked;
}

/**
 * Validate and record one time-boxed exception for every in-window rule holding the package;
 * an exception already open for the package is returned instead of spending more quota.
 */
export function grantException(input: {
  device_id: string;
  package_name: string;
  purpose: string;
  minutes: number;
}, now = new Date()): GrantedException {
  const purpose = cleanLine(input.purpose, 200);
  if (purpose.length < MIN_PURPOSE_LENGTH) throw new Error("exception_purpose_required");
  const rules = coveringRules(input.device_id, now).filter((row) => commitmentPackages(row).includes(input.package_name));
  if (rules.length === 0) throw new Error("not_committed");
  const open = openExceptionsForPackage(input.device_id, input.package_name, now.toISOString());
  if (open.length > 0) {
    return {
      group_id: open[0]!.group_id,
      reused: true,
      commitment_ids: [...new Set(open.map((row) => row.commitment_id))],
      relock_at: open[0]!.relock_at,
      exceptions_left_today: Math.min(...rules.map((row) => exceptionsLeft(row, now))),
    };
  }
  const minutes = Math.trunc(Number(input.minutes));
  const maxMinutes = Math.min(...rules.map((row) => row.max_exception_minutes));
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > maxMinutes) throw new Error("exception_minutes_out_of_range");
  if (rules.some((row) => exceptionsLeft(row, now) <= 0)) throw new Error("commitment_exception_denied");

  const groupId = `exg_${crypto.randomUUID()}`;
  const relockAt = new Date(now.getTime() + minutes * 60_000).toISOString();
  insertExceptionGroup(rules.map((row) => ({
    exception_id: `exc_${crypto.randomUUID()}`,
    group_id: groupId,
    commitment_id: row.commitment_id,
    device_id: input.device_id,
    package_name: input.package_name,
    purpose,
    minutes,
    granted_at: now.toISOString(),
    relock_at: relockAt,
  })));
  return {
    group_id: groupId,
    reused: false,
    commitment_ids: rules.map((row) => row.commitment_id),
    relock_at: relockAt,
    exceptions_left_today: Math.min(...rules.map((row) => exceptionsLeft(row, now))),
  };
}

/** Give the quota back when the exception never reached the phone. */
export function refundException(groupId: string): void {
  refundExceptionGroup(groupId);
}

export function commitmentsContext(now = new Date()): Record<string, unknown>[] {
  return activeCommitments(now).map((row) => commitmentView(row, now));
}

function coveringRules(deviceId: string, now: Date): CommitmentRow[] {
  return activeCommitments(now).filter((row) => row.kind === "block" && row.device_id === deviceId && commitmentInWindow(row, now));
}

function commitmentView(row: CommitmentRow, now: Date): Record<string, unknown> {
  const today = chargesToday(row, now);
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
        .filter((item) => Date.parse(item.relock_at) > now.getTime())
        .map((item) => ({ package_name: item.package_name, purpose: item.purpose, relock_at: item.relock_at })),
    } : {}),
    starts_at: row.starts_at,
    ends_at: row.ends_at || null,
    ...(row.status === "ended" ? { ended_at: row.ended_at, end_reason: row.end_reason } : {}),
  };
}

function chargesToday(row: CommitmentRow, now: Date): ExceptionRow[] {
  return exceptionChargesSince(row.commitment_id, localMidnightIso(now, row.timezone_offset_minutes));
}

function exceptionsLeft(row: CommitmentRow, now: Date): number {
  return row.daily_exception_limit - chargesToday(row, now).length;
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

function sameSet(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((item) => right.includes(item));
}

function cleanLine(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, maxLength) : "";
}

function boundedCount(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Math.trunc(Number(value));
  if (value === undefined || value === null || !Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

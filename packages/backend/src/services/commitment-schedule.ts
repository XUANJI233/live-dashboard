// Pure time rules for commitments, in the rule's own local time.
// Offsets use JavaScript getTimezoneOffset semantics: UTC+08:00 is -480.

export interface CommitmentWindow {
  window_start: string;
  window_end: string;
  timezone_offset_minutes: number;
}

const CLOCK_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isClock(value: string): boolean {
  return CLOCK_PATTERN.test(value);
}

/** An empty window is all day; a start after the end wraps past midnight. */
export function windowContains(window: CommitmentWindow, now: Date): boolean {
  if (!window.window_start || !window.window_end) return true;
  const minute = localMinute(now, window.timezone_offset_minutes);
  const start = clockMinute(window.window_start);
  const end = clockMinute(window.window_end);
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

export function localMidnightIso(now: Date, offsetMinutes: number): string {
  const local = new Date(now.getTime() - offsetMinutes * 60_000);
  local.setUTCHours(0, 0, 0, 0);
  return new Date(local.getTime() + offsetMinutes * 60_000).toISOString();
}

function localMinute(now: Date, offsetMinutes: number): number {
  const local = new Date(now.getTime() - offsetMinutes * 60_000);
  return local.getUTCHours() * 60 + local.getUTCMinutes();
}

function clockMinute(value: string): number {
  const [hours, minutes] = value.split(":").map((part) => Number.parseInt(part, 10));
  return hours! * 60 + minutes!;
}

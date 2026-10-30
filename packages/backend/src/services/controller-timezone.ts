import { safeTimezoneOffset } from "./cdn";
import { getSummarySettings } from "./daily-summary-gen";
import { formatPromptMinute, timezoneOffsetLabel } from "./prompt-time";

// The user lives in UTC+08:00; JavaScript getTimezoneOffset semantics make that -480.
export const DEFAULT_CONTROLLER_TIMEZONE_OFFSET_MINUTES = -480;

export type ControllerTimezoneSource = "argument" | "saved_settings" | "default";

export interface ControllerTimezone {
  offset_minutes: number;
  label: string;
  source: ControllerTimezoneSource;
}

const LOCAL_TIME_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?$/;
const ABSOLUTE_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/i;

/** Controller reads use the caller's offset, else the saved summary timezone, else UTC+08:00 — never the server's zone. */
export function resolveControllerTimezone(
  override?: number | null,
  saved: number | null | undefined = getSummarySettings().timezone_offset_minutes,
): ControllerTimezone {
  const source: ControllerTimezoneSource = validOffset(override)
    ? "argument"
    : validOffset(saved) ? "saved_settings" : "default";
  const offset = source === "argument"
    ? override!
    : source === "saved_settings" ? saved! : DEFAULT_CONTROLLER_TIMEZONE_OFFSET_MINUTES;
  const safeOffset = safeTimezoneOffset(offset);
  return { offset_minutes: safeOffset, label: timezoneOffsetLabel(safeOffset), source };
}

/**
 * ISO with an explicit offset is absolute; a date or date-time without one is local to the
 * given offset. Offset-less strings never go through Date.parse, whose zone is the server's.
 */
export function parseControllerTime(value: string, tzOffsetMinutes: number): number {
  const text = value.trim();
  if (ABSOLUTE_TIME_RE.test(text)) {
    const ms = Date.parse(text);
    if (Number.isFinite(ms)) return ms;
    throw new Error("invalid_time");
  }
  const match = LOCAL_TIME_RE.exec(text);
  if (!match) throw new Error("invalid_time");
  const [year, month, day, hour, minute, second, fraction] = match.slice(1).map((part) => part ?? "");
  const parts = [year, month, day, hour || "0", minute || "0", second || "0"].map((part) => Number.parseInt(part!, 10));
  const millis = fraction ? Number.parseInt(fraction.padEnd(3, "0"), 10) : 0;
  const [y, mo, d, h, mi, s] = parts as [number, number, number, number, number, number];
  const localMs = Date.UTC(y, mo - 1, d, h, mi, s, millis);
  const check = new Date(localMs);
  if (
    check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d ||
    check.getUTCHours() !== h || check.getUTCMinutes() !== mi || check.getUTCSeconds() !== s
  ) {
    throw new Error("invalid_time");
  }
  return localMs + safeTimezoneOffset(tzOffsetMinutes) * 60_000;
}

export function formatControllerMinute(ms: number, tzOffsetMinutes: number): string {
  return formatPromptMinute(new Date(ms), tzOffsetMinutes);
}

/** Start of the local calendar day containing ms, as a UTC epoch millisecond. */
export function localDayStartMs(ms: number, tzOffsetMinutes: number): number {
  const offsetMs = safeTimezoneOffset(tzOffsetMinutes) * 60_000;
  const local = ms - offsetMs;
  return local - (((local % 86_400_000) + 86_400_000) % 86_400_000) + offsetMs;
}

/** Start of the local clock hour containing ms; offsets are whole quarter hours, so hours stay aligned per zone. */
export function localHourStartMs(ms: number, tzOffsetMinutes: number): number {
  const offsetMs = safeTimezoneOffset(tzOffsetMinutes) * 60_000;
  const local = ms - offsetMs;
  return local - (((local % 3_600_000) + 3_600_000) % 3_600_000) + offsetMs;
}

function validOffset(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isInteger(value) && Math.abs(value) <= 840;
}

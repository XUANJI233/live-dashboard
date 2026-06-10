import { safeTimezoneOffset } from "./cdn";

export function formatPromptDateTime(value: Date | string, tzOffsetMinutes: number): string {
  const date = dateFromValue(value) ?? new Date();
  const offset = timezoneOffsetLabel(tzOffsetMinutes);
  return `${date.toISOString()}（本地 ${localDateTimeStringForOffset(date, tzOffsetMinutes)}，${offset}）`;
}

export function formatPromptMinute(value: Date | string, tzOffsetMinutes: number): string {
  const date = dateFromValue(value);
  if (!date) return String(value || "").slice(0, 16);
  return localDateTimeStringForOffset(date, tzOffsetMinutes, false);
}

export function localDateStringForOffset(date: Date, tzOffsetMinutes: number): string {
  const local = localDateForOffset(date, tzOffsetMinutes);
  return `${local.getUTCFullYear()}-${String(local.getUTCMonth() + 1).padStart(2, "0")}-${String(local.getUTCDate()).padStart(2, "0")}`;
}

function localDateTimeStringForOffset(date: Date, tzOffsetMinutes: number, includeSeconds = true): string {
  const local = localDateForOffset(date, tzOffsetMinutes);
  const time = [
    String(local.getUTCHours()).padStart(2, "0"),
    String(local.getUTCMinutes()).padStart(2, "0"),
    ...(includeSeconds ? [String(local.getUTCSeconds()).padStart(2, "0")] : []),
  ].join(":");
  return `${localDateStringForOffset(date, tzOffsetMinutes)} ${time}`;
}

function localDateForOffset(date: Date, tzOffsetMinutes: number): Date {
  return new Date(date.getTime() - safeTimezoneOffset(tzOffsetMinutes) * 60_000);
}

function timezoneOffsetLabel(tzOffsetMinutes: number): string {
  const offsetMinutes = -safeTimezoneOffset(tzOffsetMinutes);
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  return `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

function dateFromValue(value: Date | string): Date | null {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

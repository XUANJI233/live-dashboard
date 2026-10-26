import {
  db,
  getDailySummary,
  getWeeklySummary,
  upsertDailySummary,
  upsertWeeklySummary,
} from "../db";
import {
  addDays,
  getSummarySettings,
  normalizeSummaryMode,
  sanitizeAiSummary,
  startOfWeek,
  validDateString,
  type SummaryKind,
} from "./daily-summary-gen";

type ControllerMemoryEventType =
  | "visitor_message"
  | "device_command"
  | "daily_summary"
  | "weekly_summary";

interface ControllerMemoryEvent {
  event_id: string;
  event_type: ControllerMemoryEventType;
  occurred_at: string;
  payload: Record<string, unknown>;
}

interface MemoryCursor {
  occurredAt: string;
  eventId: string;
}

const DEFAULT_MEMORY_LIMIT = 120;
const MAX_MEMORY_LIMIT = 300;
const MAX_MEMORY_SCAN_LIMIT = MAX_MEMORY_LIMIT + 1;

const recentVisitorMessages = db.prepare(`
  SELECT id, device_id, viewer_id, viewer_name, kind, direction, text, created_at
  FROM (
    SELECT id, device_id, viewer_id, viewer_name, kind, direction, text, created_at
    FROM visitor_messages
    WHERE (? = 1 OR kind NOT IN ('public', 'public_reply'))
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  )
  ORDER BY created_at ASC, id ASC
`);

const visitorMessagesAfter = db.prepare(`
  SELECT id, device_id, viewer_id, viewer_name, kind, direction, text, created_at
  FROM visitor_messages
  WHERE (? = 1 OR kind NOT IN ('public', 'public_reply'))
    AND julianday(created_at) >= julianday(?)
  ORDER BY julianday(created_at) ASC, id ASC
  LIMIT ?
`);

const visitorMessagesAfterCursor = db.prepare(`
  SELECT id, device_id, viewer_id, viewer_name, kind, direction, text, created_at
  FROM visitor_messages
  WHERE (? = 1 OR kind NOT IN ('public', 'public_reply'))
    AND (julianday(created_at) > julianday(?)
      OR (julianday(created_at) = julianday(?) AND ('visitor_message:' || id) > ?))
  ORDER BY julianday(created_at) ASC, id ASC
  LIMIT ?
`);

const recentDeviceCommands = db.prepare(`
  SELECT command_id, request_id, target_device_id, kind, payload, issued_at, expires_at,
         delivery_status, receipt_status, result_status, created_by
  FROM (
    SELECT command_id, request_id, target_device_id, kind, payload, issued_at, expires_at,
           delivery_status, receipt_status, result_status, created_by
    FROM device_commands
    ORDER BY issued_at DESC, command_id DESC
    LIMIT ?
  )
  ORDER BY issued_at ASC, command_id ASC
`);

const deviceCommandsAfter = db.prepare(`
  SELECT command_id, request_id, target_device_id, kind, payload, issued_at, expires_at,
         delivery_status, receipt_status, result_status, created_by
  FROM device_commands
  WHERE julianday(issued_at) >= julianday(?)
  ORDER BY julianday(issued_at) ASC, command_id ASC
  LIMIT ?
`);

const deviceCommandsAfterCursor = db.prepare(`
  SELECT command_id, request_id, target_device_id, kind, payload, issued_at, expires_at,
         delivery_status, receipt_status, result_status, created_by
  FROM device_commands
  WHERE julianday(issued_at) > julianday(?)
     OR (julianday(issued_at) = julianday(?) AND ('device_command:' || command_id) > ?)
  ORDER BY julianday(issued_at) ASC, command_id ASC
  LIMIT ?
`);

const recentDailySummaries = db.prepare(`
  SELECT date, summary, mode, target, generated_at
  FROM (
    SELECT date, summary, mode, target, generated_at
    FROM daily_summaries
    ORDER BY generated_at DESC, date DESC
    LIMIT ?
  )
  ORDER BY generated_at ASC, date ASC
`);

const dailySummariesAfter = db.prepare(`
  SELECT date, summary, mode, target, generated_at
  FROM daily_summaries
  WHERE julianday(generated_at) >= julianday(?)
  ORDER BY julianday(generated_at) ASC, date ASC
  LIMIT ?
`);

const dailySummariesAfterCursor = db.prepare(`
  SELECT date, summary, mode, target, generated_at
  FROM daily_summaries
  WHERE julianday(generated_at) > julianday(?)
     OR (julianday(generated_at) = julianday(?) AND ('daily_summary:' || date || ':' || generated_at) > ?)
  ORDER BY julianday(generated_at) ASC, date ASC
  LIMIT ?
`);

const recentWeeklySummaries = db.prepare(`
  SELECT week_start, week_end, summary, mode, target, generated_at
  FROM (
    SELECT week_start, week_end, summary, mode, target, generated_at
    FROM weekly_summaries
    ORDER BY generated_at DESC, week_start DESC
    LIMIT ?
  )
  ORDER BY generated_at ASC, week_start ASC
`);

const weeklySummariesAfter = db.prepare(`
  SELECT week_start, week_end, summary, mode, target, generated_at
  FROM weekly_summaries
  WHERE julianday(generated_at) >= julianday(?)
  ORDER BY julianday(generated_at) ASC, week_start ASC
  LIMIT ?
`);

const weeklySummariesAfterCursor = db.prepare(`
  SELECT week_start, week_end, summary, mode, target, generated_at
  FROM weekly_summaries
  WHERE julianday(generated_at) > julianday(?)
     OR (julianday(generated_at) = julianday(?) AND ('weekly_summary:' || week_start || ':' || generated_at) > ?)
  ORDER BY julianday(generated_at) ASC, week_start ASC
  LIMIT ?
`);

export function getControllerMemoryFeed(input: Record<string, unknown>): Record<string, unknown> {
  const cursor = parseMemoryCursor(input.cursor);
  const since = cursor?.occurredAt ?? validIsoTime(input.since);
  const limit = integerInRange(input.limit, DEFAULT_MEMORY_LIMIT, 1, MAX_MEMORY_LIMIT);
  const scanLimit = Math.min(MAX_MEMORY_SCAN_LIMIT, limit + 1);
  const includeMessages = input.include_messages !== false;
  // Anonymous public messages stay out of contexts that may take device actions.
  const includePublicMessages = input.include_public_messages !== false;
  const includeSummaries = input.include_summaries !== false;
  const includeDeviceCommands = input.include_device_commands !== false;
  const events: ControllerMemoryEvent[] = [];

  if (includeMessages) events.push(...messageEvents(since, cursor, scanLimit, includePublicMessages));
  if (includeSummaries) events.push(...summaryEvents(since, cursor, scanLimit));
  if (includeDeviceCommands) events.push(...deviceCommandEvents(since, cursor, scanLimit));

  events.sort(compareEvents);
  const filtered = cursor
    ? events.filter((event) => compareEventsToCursor(event, cursor) > 0)
    : events;
  const limited = since ? filtered.slice(0, limit) : filtered.slice(-limit);
  const last = limited.at(-1) ?? null;
  return {
    generated_at: new Date().toISOString(),
    since: since || null,
    cursor: cursor ? encodeMemoryCursor(cursor) : null,
    next_since: (last?.occurred_at ?? since) || null,
    next_cursor: last ? encodeMemoryCursor({ occurredAt: last.occurred_at, eventId: last.event_id }) : null,
    has_more: filtered.length > limited.length,
    recommended_next_action: "OpenClaw/Hermes should ingest these events into its own memory, then call save_controller_summary when it has produced an authoritative daily or weekly summary.",
    events: limited,
  };
}

export function saveControllerSummary(input: Record<string, unknown>): Record<string, unknown> {
  const kind = input.kind;
  if (kind !== "daily_summary" && kind !== "weekly_summary") throw new Error("invalid_summary_kind");

  const summaryKind: SummaryKind = kind === "weekly_summary" ? "weekly" : "daily";
  const summary = sanitizeAiSummary(typeof input.summary === "string" ? input.summary : "", summaryKind);
  if (!summary) throw new Error("empty_summary");

  const settings = getSummarySettings();
  const mode = normalizeSummaryMode(input.mode ?? settings.mode);
  const target = sanitizeTarget(input.target, settings.target);

  if (kind === "daily_summary") {
    const date = typeof input.date === "string" && validDateString(input.date) ? input.date : null;
    if (!date) throw new Error("invalid_date");
    upsertDailySummary.run(date, summary, mode, target);
    const row = getDailySummary.get(date) as Record<string, unknown> | null;
    return {
      ok: true,
      source: "controller",
      summary_kind: "daily_summary",
      daily_summary: row,
    };
  }

  const rawWeek = typeof input.week_start === "string" && validDateString(input.week_start)
    ? input.week_start
    : typeof input.date === "string" && validDateString(input.date)
      ? input.date
      : null;
  if (!rawWeek) throw new Error("invalid_week_start");
  const weekStart = startOfWeek(rawWeek);
  const weekEnd = addDays(weekStart, 6);
  upsertWeeklySummary.run(weekStart, weekEnd, summary, mode, target);
  const row = getWeeklySummary.get(weekStart) as Record<string, unknown> | null;
  return {
    ok: true,
    source: "controller",
    summary_kind: "weekly_summary",
    weekly_summary: row,
  };
}

function messageEvents(
  since: string,
  cursor: MemoryCursor | null,
  limit: number,
  includePublic: boolean,
): ControllerMemoryEvent[] {
  const publicFlag = includePublic ? 1 : 0;
  const rows = (cursor
    ? visitorMessagesAfterCursor.all(publicFlag, cursor.occurredAt, cursor.occurredAt, cursor.eventId, limit)
    : since
      ? visitorMessagesAfter.all(publicFlag, since, limit)
    : recentVisitorMessages.all(publicFlag, limit)) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    event_id: `visitor_message:${row.id}`,
    event_type: "visitor_message",
    occurred_at: normalizeSqliteTime(row.created_at),
    payload: row,
  }));
}

function deviceCommandEvents(since: string, cursor: MemoryCursor | null, limit: number): ControllerMemoryEvent[] {
  const rows = (cursor
    ? deviceCommandsAfterCursor.all(cursor.occurredAt, cursor.occurredAt, cursor.eventId, limit)
    : since
      ? deviceCommandsAfter.all(since, limit)
    : recentDeviceCommands.all(limit)) as Array<Record<string, unknown>>;
  return rows.map((row) => {
    const payload = safeJsonObject(row.payload);
    return {
      event_id: `device_command:${row.command_id}`,
      event_type: "device_command",
      occurred_at: normalizeSqliteTime(row.issued_at),
      payload: {
        ...row,
        payload,
      },
    };
  });
}

function summaryEvents(since: string, cursor: MemoryCursor | null, limit: number): ControllerMemoryEvent[] {
  const dailyRows = (cursor
    ? dailySummariesAfterCursor.all(cursor.occurredAt, cursor.occurredAt, cursor.eventId, limit)
    : since
      ? dailySummariesAfter.all(since, limit)
    : recentDailySummaries.all(limit)) as Array<Record<string, unknown>>;
  const weeklyRows = (cursor
    ? weeklySummariesAfterCursor.all(cursor.occurredAt, cursor.occurredAt, cursor.eventId, limit)
    : since
      ? weeklySummariesAfter.all(since, limit)
    : recentWeeklySummaries.all(limit)) as Array<Record<string, unknown>>;
  return [
    ...dailyRows.map((row) => ({
      event_id: `daily_summary:${row.date}:${row.generated_at}`,
      event_type: "daily_summary" as const,
      occurred_at: normalizeSqliteTime(row.generated_at),
      payload: row,
    })),
    ...weeklyRows.map((row) => ({
      event_id: `weekly_summary:${row.week_start}:${row.generated_at}`,
      event_type: "weekly_summary" as const,
      occurred_at: normalizeSqliteTime(row.generated_at),
      payload: row,
    })),
  ];
}

function compareEvents(a: ControllerMemoryEvent, b: ControllerMemoryEvent): number {
  const delta = Date.parse(a.occurred_at) - Date.parse(b.occurred_at);
  return delta || a.event_id.localeCompare(b.event_id);
}

function compareEventsToCursor(event: ControllerMemoryEvent, cursor: MemoryCursor): number {
  const delta = Date.parse(event.occurred_at) - Date.parse(cursor.occurredAt);
  return delta || event.event_id.localeCompare(cursor.eventId);
}

function encodeMemoryCursor(cursor: MemoryCursor): string {
  return `${encodeURIComponent(cursor.occurredAt)}|${encodeURIComponent(cursor.eventId)}`;
}

function parseMemoryCursor(value: unknown): MemoryCursor | null {
  if (typeof value !== "string" || !value.includes("|")) return null;
  const [rawAt, rawEventId] = value.split("|", 2);
  try {
    const occurredAt = validIsoTime(decodeURIComponent(rawAt || ""));
    const eventId = decodeURIComponent(rawEventId || "").trim();
    return occurredAt && eventId ? { occurredAt, eventId } : null;
  } catch {
    return null;
  }
}

function integerInRange(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function validIsoTime(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "";
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : "";
}

function normalizeSqliteTime(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return new Date(0).toISOString();
  const raw = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : value;
}

function safeJsonObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function sanitizeTarget(value: unknown, fallback: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== "string") return "";
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 12)
    .join("\n")
    .slice(0, 1000);
}

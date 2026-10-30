import { db } from "../db";
import type { TimelineSegment, TimelineSegmentExtra } from "../types";

// One duration rule for every controller-side read of activity history:
// a report lasts until the device's next report, at most REPORT_GAP_CAP_SECONDS (the Android
// LSP module only heartbeats every five minutes while nothing changes); after a longer silence
// it is credited LONE_REPORT_SECONDS and the rest is unobserved.
export const REPORT_GAP_CAP_SECONDS = 360;
export const LONE_REPORT_SECONDS = 60;
// Consecutive reports of the same app at most this far apart form one session.
export const SESSION_JOIN_SECONDS = 1_800;
export const MAX_HISTORY_SCAN_ROWS = 200_000;
export const HISTORY_DURATION_RULE = "Each report lasts until the device's next report, at most 6 minutes; after a longer silence it counts 1 minute and the rest is unobserved. idle and sleeping are away time, never usage.";

const AWAY_APP_IDS = new Set(["idle", "sleeping"]);
const EXTRA_LOOKUP_CHUNK = 200;
const LOOKBACK_MS = SESSION_JOIN_SECONDS * 1_000;
const LOOKAHEAD_MS = REPORT_GAP_CAP_SECONDS * 1_000;

export type ActivityKind = "active" | "away";

export interface HistoryFilters {
  app?: string;
  package?: string;
  titleContains?: string;
}

export interface HistoryRow {
  id: number;
  started_at: string;
  app_id: string;
  app_name: string;
  display_title: string;
  matched: number;
}

export interface HistoryWindow {
  startMs: number;
  /** Already clamped to now. */
  endMs: number;
  nowMs: number;
}

export interface HistorySegment {
  id: number;
  device_id: string;
  app_id: string;
  app_name: string;
  display_title: string;
  kind: ActivityKind;
  /** Active and passing every filter. */
  matched: boolean;
  start_ms: number;
  clip_start_ms: number;
  clip_end_ms: number;
  seconds: number;
  open: boolean;
  session_id: string;
  session_start_ms: number;
}

export interface HistoryDevice {
  device_id: string;
  device_name: string;
  platform: string;
}

export interface DeviceHistory {
  device: HistoryDevice;
  segments: HistorySegment[];
}

const listHistoryDevicesStmt = db.prepare(`
  SELECT device_id, device_name, platform
  FROM device_states
  ORDER BY device_id ASC
  LIMIT 100
`);

const getHistoryDeviceStmt = db.prepare(`
  SELECT device_id, device_name, platform
  FROM device_states
  WHERE device_id = ?
`);

// Reads only idx_activities_device_history; empty filters are passed as NULL.
const scanActivitiesStmt = db.prepare(`
  SELECT id, started_at, app_id, app_name, display_title,
    ((?4 IS NULL OR app_name LIKE ?4 ESCAPE '\\' OR app_id LIKE ?4 ESCAPE '\\')
      AND (?5 IS NULL OR app_id = ?5 COLLATE NOCASE)
      AND (?6 IS NULL OR display_title LIKE ?6 ESCAPE '\\')) AS matched
  FROM activities
  WHERE device_id = ?1 AND started_at >= ?2 AND started_at < ?3
  ORDER BY started_at ASC, id ASC
  LIMIT ?7
`);

export function listHistoryDevices(): HistoryDevice[] {
  return listHistoryDevicesStmt.all() as HistoryDevice[];
}

export function getHistoryDevice(deviceId: string): HistoryDevice | null {
  return getHistoryDeviceStmt.get(deviceId) as HistoryDevice | null;
}

/** Folded history of every known device (or one) inside the window; segments keep zero-length rows out. */
export function loadHistory(options: {
  window: HistoryWindow;
  deviceId?: string;
  filters?: HistoryFilters;
}): DeviceHistory[] {
  const devices = options.deviceId
    ? [getHistoryDevice(options.deviceId) ?? { device_id: options.deviceId, device_name: options.deviceId, platform: "" }]
    : listHistoryDevices();
  return devices.map((device) => ({
    device,
    segments: scanDeviceHistory(device.device_id, options.window, options.filters ?? {}),
  }));
}

export function scanDeviceHistory(deviceId: string, window: HistoryWindow, filters: HistoryFilters): HistorySegment[] {
  const scanStart = new Date(window.startMs - LOOKBACK_MS).toISOString();
  const scanEndMs = window.endMs + LOOKAHEAD_MS;
  const scanEnd = new Date(scanEndMs).toISOString();
  const activities = scanActivitiesStmt.all(
    deviceId,
    scanStart,
    scanEnd,
    likePattern(filters.app),
    cleanFilter(filters.package) || null,
    likePattern(filters.titleContains),
    MAX_HISTORY_SCAN_ROWS + 1,
  ) as HistoryRow[];
  if (activities.length > MAX_HISTORY_SCAN_ROWS) throw new Error("history_scan_too_large");
  return foldDeviceHistory(deviceId, activities, window, scanEndMs >= window.nowMs)
    .filter((segment) => segment.seconds > 0);
}

/**
 * Applies the duration and session rules to one device's rows, sorted by (started_at, id).
 * The rows may start up to 30 minutes before the window and end up to 6 minutes after it;
 * those only bound their neighbours and contribute no seconds of their own.
 */
export function foldDeviceHistory(
  deviceId: string,
  rows: HistoryRow[],
  window: HistoryWindow,
  scanReachesNow: boolean,
): HistorySegment[] {
  const out: HistorySegment[] = [];
  let previousKey = "";
  let previousStartMs = Number.NEGATIVE_INFINITY;
  let sessionId = "";
  let sessionStartMs = 0;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    const startMs = Date.parse(row.started_at);
    if (!Number.isFinite(startMs)) continue;
    const next = rows[index + 1];
    const nextMs = next
      ? Date.parse(next.started_at)
      : scanReachesNow ? window.nowMs : Number.POSITIVE_INFINITY;
    const gapSeconds = (nextMs - startMs) / 1_000;
    const credited = !(gapSeconds > 0)
      ? 0
      : gapSeconds <= REPORT_GAP_CAP_SECONDS ? gapSeconds : LONE_REPORT_SECONDS;
    const kind = rowKind(row);
    const key = `${kind}\u0000${row.app_id}\u0000${row.app_name}`;
    if (key !== previousKey || startMs - previousStartMs > SESSION_JOIN_SECONDS * 1_000) {
      sessionId = `${deviceId}#${row.id}`;
      sessionStartMs = startMs;
    }
    previousKey = key;
    previousStartMs = startMs;
    const clipStartMs = Math.max(startMs, window.startMs);
    const clipEndMs = Math.min(startMs + credited * 1_000, window.endMs);
    out.push({
      id: row.id,
      device_id: deviceId,
      app_id: row.app_id,
      app_name: row.app_name,
      display_title: row.display_title || "",
      kind,
      matched: kind === "active" && Number(row.matched) === 1,
      start_ms: startMs,
      clip_start_ms: clipStartMs,
      clip_end_ms: Math.max(clipStartMs, clipEndMs),
      seconds: Math.max(0, (clipEndMs - clipStartMs) / 1_000),
      open: !next && scanReachesNow && gapSeconds <= REPORT_GAP_CAP_SECONDS,
      session_id: sessionId,
      session_start_ms: sessionStartMs,
    });
  }
  return out;
}

export function isAwayApp(appId: string, appName: string): boolean {
  return AWAY_APP_IDS.has(appId) || AWAY_APP_IDS.has(appName);
}

/** Background-media snapshots for the few rows a timeline returns; the history scan itself never reads extra. */
export function loadActivityExtras(ids: number[]): Map<number, TimelineSegmentExtra> {
  const out = new Map<number, TimelineSegmentExtra>();
  const activityIds = Array.from(new Set(ids.filter((id) => Number.isSafeInteger(id) && id > 0)));
  for (let index = 0; index < activityIds.length; index += EXTRA_LOOKUP_CHUNK) {
    const chunk = activityIds.slice(index, index + EXTRA_LOOKUP_CHUNK);
    const rows = db.prepare(`SELECT id, extra FROM activities WHERE id IN (${chunk.map(() => "?").join(", ")})`)
      .all(...chunk) as Array<{ id: number; extra: string | null }>;
    for (const row of rows) {
      const extra = parseExtra(row.extra);
      if (extra) out.set(row.id, extra);
    }
  }
  return out;
}

/** The shape timeline-prompt and the usage digest consume, with the engine's session and kind attached. */
export function historyTimelineSegment(
  segment: HistorySegment,
  deviceName: string,
  extra?: TimelineSegmentExtra,
): TimelineSegment {
  const durationSeconds = Math.round(segment.seconds);
  return {
    app_name: segment.app_name,
    app_id: segment.app_id,
    display_title: segment.display_title,
    started_at: new Date(segment.clip_start_ms).toISOString(),
    ended_at: new Date(segment.clip_end_ms).toISOString(),
    duration_seconds: durationSeconds,
    duration_minutes: Math.round(durationSeconds / 60),
    device_id: segment.device_id,
    device_name: deviceName || segment.device_id,
    ...(extra ? { extra } : {}),
    session_id: segment.session_id,
    kind: segment.kind,
  };
}

function parseExtra(raw: string | null): TimelineSegmentExtra | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) && Object.keys(parsed).length > 0
      ? parsed as TimelineSegmentExtra
      : null;
  } catch {
    return null;
  }
}

function rowKind(row: HistoryRow): ActivityKind {
  return isAwayApp(row.app_id, row.app_name) ? "away" : "active";
}

function cleanFilter(value: string | undefined): string {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, "").trim() : "";
}

function likePattern(value: string | undefined): string | null {
  const cleaned = cleanFilter(value);
  return cleaned ? `%${cleaned.replace(/[\\%_]/g, (match) => `\\${match}`)}%` : null;
}

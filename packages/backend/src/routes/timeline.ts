import {
  getTimelineByDate,
  getTimelineByDateAndDevice,
} from "../db";
import type { ActivityRecord, TimelineSegment } from "../types";
import { db } from "../db";
import { hourWindowForOffset, isLiveHourWindow, normalizeHourWindow, noStore, windowMatchesDate, withCdnHeaders } from "../services/cdn";

const GAP_THRESHOLD_MS = 2 * 60 * 1000;

export function handleTimeline(url: URL): Response {
  const date = url.searchParams.get("date");
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return Response.json(
      { error: "date parameter required (YYYY-MM-DD)" },
      { status: 400 }
    );
  }

  const tzParam = url.searchParams.get("tz");
  const tzOffsetMinutes = tzParam ? parseInt(tzParam, 10) : 0;
  const deviceId = url.searchParams.get("device_id");
  const window = normalizeHourWindow(url.searchParams.get("window"));
  if (url.searchParams.has("window") && !window) {
    return Response.json({ error: "window must be YYYYMMDDHH" }, { status: 400 });
  }
  if (window && !windowMatchesDate(window, date)) {
    return Response.json({ error: "window does not match date" }, { status: 400 });
  }

  let activities: ActivityRecord[];

  if (tzOffsetMinutes && !isNaN(tzOffsetMinutes) && Math.abs(tzOffsetMinutes) <= 840) {
    const offsetHours = -tzOffsetMinutes / 60;
    const sign = offsetHours >= 0 ? "+" : "-";
    const absH = Math.floor(Math.abs(offsetHours));
    const absM = Math.round((Math.abs(offsetHours) - absH) * 60);
    const modifier = `${sign}${String(absH).padStart(2, "0")}:${String(absM).padStart(2, "0")}`;

    const whereWindow = window ? ` AND strftime('%Y%m%d%H', started_at, '${modifier}') = ?` : "";
    const query = deviceId
      ? db.prepare(`SELECT * FROM activities WHERE date(started_at, '${modifier}') = ?${whereWindow} AND device_id = ? ORDER BY started_at ASC LIMIT 10000`)
      : db.prepare(`SELECT * FROM activities WHERE date(started_at, '${modifier}') = ?${whereWindow} ORDER BY started_at ASC LIMIT 10000`);

    activities = deviceId
      ? (window ? query.all(date, window, deviceId) : query.all(date, deviceId)) as ActivityRecord[]
      : (window ? query.all(date, window) : query.all(date)) as ActivityRecord[];
    if (window) activities = appendLookaheadActivities(activities, date, modifier);
  } else {
    if (window) {
      const query = deviceId
        ? db.prepare(`SELECT * FROM activities WHERE date(started_at) = ? AND strftime('%Y%m%d%H', started_at) = ? AND device_id = ? ORDER BY started_at ASC LIMIT 10000`)
        : db.prepare(`SELECT * FROM activities WHERE date(started_at) = ? AND strftime('%Y%m%d%H', started_at) = ? ORDER BY started_at ASC LIMIT 10000`);
      activities = deviceId
        ? query.all(date, window, deviceId) as ActivityRecord[]
        : query.all(date, window) as ActivityRecord[];
      activities = appendLookaheadActivities(activities, date, null);
    } else {
      activities = deviceId
        ? (getTimelineByDateAndDevice.all(date, deviceId) as ActivityRecord[])
        : (getTimelineByDate.all(date) as ActivityRecord[]);
    }
  }

  const tzOffset = safeTimezoneOffset(tzOffsetMinutes);
  const segments = buildTimelineSegments(activities, { openLast: !window || isLiveHourWindow(window, tzOffset) })
    .filter((segment) => !window || segmentHourWindow(segment, tzOffset) === window);

  const summaryNested = new Map<string, Map<string, number>>();
  for (const segment of segments) {
    let appMap = summaryNested.get(segment.device_id);
    if (!appMap) {
      appMap = new Map();
      summaryNested.set(segment.device_id, appMap);
    }
    appMap.set(segment.app_name, (appMap.get(segment.app_name) || 0) + segment.duration_minutes);
  }

  const summary: Record<string, Record<string, number>> = {};
  for (const [devId, appMap] of summaryNested) {
    summary[devId] = Object.fromEntries(appMap);
  }

  const response = Response.json({ date, window, segments, summary });
  const tags = ["timeline", `timeline-${date}`, ...(window ? [`timeline-window-${window}`] : []), ...(deviceId ? [`timeline-device-${deviceId}`] : [])];
  if ((window && isLiveHourWindow(window, tzOffset)) || (!window && isTodayForOffset(date, tzOffsetMinutes))) {
    return noStore(response, tags);
  }
  return withCdnHeaders(
    response,
    tags,
    60 * 60 * 24 * 30,
  );
}

function appendLookaheadActivities(activities: ActivityRecord[], date: string, modifier: string | null): ActivityRecord[] {
  if (activities.length === 0) return activities;
  const lastByDevice = new Map<string, ActivityRecord>();
  for (const activity of activities) {
    const previous = lastByDevice.get(activity.device_id);
    if (!previous || new Date(activity.started_at).getTime() > new Date(previous.started_at).getTime()) {
      lastByDevice.set(activity.device_id, activity);
    }
  }

  const out = activities.slice();
  const seen = new Set(out.map((activity) => `${activity.device_id}|${activity.started_at}`));
  for (const last of lastByDevice.values()) {
    const next = queryNextActivity(last.device_id, last.started_at, date, modifier);
    if (!next) continue;
    const key = `${next.device_id}|${next.started_at}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(next);
  }
  return out;
}

function queryNextActivity(deviceId: string, startedAt: string, date: string, modifier: string | null): ActivityRecord | null {
  const sql = modifier
    ? `SELECT * FROM activities WHERE device_id = ? AND date(started_at, '${modifier}') = ? AND started_at > ? ORDER BY started_at ASC LIMIT 1`
    : "SELECT * FROM activities WHERE device_id = ? AND date(started_at) = ? AND started_at > ? ORDER BY started_at ASC LIMIT 1";
  return db.prepare(sql).get(deviceId, date, startedAt) as ActivityRecord | null;
}

function segmentHourWindow(segment: TimelineSegment, tzOffsetMinutes: number): string | null {
  const start = new Date(segment.started_at);
  if (Number.isNaN(start.getTime())) return null;
  return hourWindowForOffset(start, tzOffsetMinutes);
}

function buildTimelineSegments(activities: ActivityRecord[], options: { openLast: boolean } = { openLast: true }): TimelineSegment[] {
  const byDevice = new Map<string, ActivityRecord[]>();
  for (const activity of activities) {
    const rows = byDevice.get(activity.device_id) || [];
    rows.push(activity);
    byDevice.set(activity.device_id, rows);
  }

  const segments: TimelineSegment[] = [];
  for (const rows of byDevice.values()) {
    rows.sort((a, b) => new Date(a.started_at).getTime() - new Date(b.started_at).getTime());
    for (let i = 0; i < rows.length; i += 1) {
      const activity = rows[i]!;
      const next = rows[i + 1];
      const startMs = new Date(activity.started_at).getTime();
      if (Number.isNaN(startMs)) continue;

      let endedAt: string | null = next?.started_at ?? null;
      let endMs = endedAt ? new Date(endedAt).getTime() : startMs;
      if (Number.isNaN(endMs)) endMs = startMs;

      if (endedAt && endMs - startMs > GAP_THRESHOLD_MS) {
        endMs = startMs + 60_000;
        endedAt = new Date(endMs).toISOString();
      } else if (!endedAt && !options.openLast) {
        endMs = startMs + 60_000;
        endedAt = new Date(endMs).toISOString();
      }

      const durationSeconds = Math.max(0, Math.round((endMs - startMs) / 1000));
      segments.push({
        app_name: activity.app_name,
        app_id: activity.app_id,
        display_title: activity.display_title || "",
        started_at: activity.started_at,
        ended_at: next || !options.openLast ? endedAt : null,
        duration_seconds: durationSeconds,
        duration_minutes: Math.max(0, Math.round(durationSeconds / 60)),
        device_id: activity.device_id,
        device_name: activity.device_name,
      });
    }
  }

  return segments.sort((a, b) => new Date(a.started_at).getTime() - new Date(b.started_at).getTime());
}

function isTodayForOffset(date: string, tzOffsetMinutes: number): boolean {
  const now = new Date(Date.now() - safeTimezoneOffset(tzOffsetMinutes) * 60_000);
  const today = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(now.getUTCDate()).padStart(2, "0")}`;
  return date === today;
}

function safeTimezoneOffset(value: number): number {
  return Number.isFinite(value) && Math.abs(value) <= 840 ? value : 0;
}

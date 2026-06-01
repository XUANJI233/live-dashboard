import {
  getTimelineByDate,
  getTimelineByDateAndDevice,
} from "../db";
import type { ActivityRecord, TimelineSegment } from "../types";
import { db } from "../db";
import { noStore, withCdnHeaders } from "../services/cdn";

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

  let activities: ActivityRecord[];

  if (tzOffsetMinutes && !isNaN(tzOffsetMinutes) && Math.abs(tzOffsetMinutes) <= 840) {
    const offsetHours = -tzOffsetMinutes / 60;
    const sign = offsetHours >= 0 ? "+" : "-";
    const absH = Math.floor(Math.abs(offsetHours));
    const absM = Math.round((Math.abs(offsetHours) - absH) * 60);
    const modifier = `${sign}${String(absH).padStart(2, "0")}:${String(absM).padStart(2, "0")}`;

    const query = deviceId
      ? db.prepare(`SELECT * FROM activities WHERE date(started_at, '${modifier}') = ? AND device_id = ? ORDER BY started_at ASC LIMIT 10000`)
      : db.prepare(`SELECT * FROM activities WHERE date(started_at, '${modifier}') = ? ORDER BY started_at ASC LIMIT 10000`);

    activities = deviceId
      ? (query.all(date, deviceId) as ActivityRecord[])
      : (query.all(date) as ActivityRecord[]);
  } else {
    activities = deviceId
      ? (getTimelineByDateAndDevice.all(date, deviceId) as ActivityRecord[])
      : (getTimelineByDate.all(date) as ActivityRecord[]);
  }

  const segments = buildTimelineSegments(activities);

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

  const response = Response.json({ date, segments, summary });
  if (isTodayForOffset(date, tzOffsetMinutes)) {
    return noStore(response);
  }
  return withCdnHeaders(
    response,
    ["timeline", `timeline-${date}`, ...(deviceId ? [`timeline-device-${deviceId}`] : [])],
    60 * 60 * 24 * 30,
  );
}

function buildTimelineSegments(activities: ActivityRecord[]): TimelineSegment[] {
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
      }

      const durationSeconds = Math.max(0, Math.round((endMs - startMs) / 1000));
      segments.push({
        app_name: activity.app_name,
        app_id: activity.app_id,
        display_title: activity.display_title || "",
        started_at: activity.started_at,
        ended_at: next ? endedAt : null,
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
  const now = new Date(Date.now() - tzOffsetMinutes * 60_000);
  const today = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(now.getUTCDate()).padStart(2, "0")}`;
  return date === today;
}

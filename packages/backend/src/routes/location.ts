import { db } from "../db";
import { verifyViewerToken, viewerTokenFromRequest, edgeViewerIdentity, viewerTokenRateLimit } from "../services/viewer-auth";
import type { LocationRecord } from "../types";
import { isLiveHourWindow, normalizeHourWindow, noStore, windowMatchesDate, withCdnHeaders } from "../services/cdn";

function timezoneModifier(url: URL): string | null {
  const tzParam = url.searchParams.get("tz");
  const tzOffsetMinutes = tzParam ? parseInt(tzParam, 10) : 0;
  if (!tzOffsetMinutes || isNaN(tzOffsetMinutes) || Math.abs(tzOffsetMinutes) > 840) {
    return null;
  }

  const offsetHours = -tzOffsetMinutes / 60;
  const sign = offsetHours >= 0 ? "+" : "-";
  const absH = Math.floor(Math.abs(offsetHours));
  const absM = Math.round((Math.abs(offsetHours) - absH) * 60);
  return `${sign}${String(absH).padStart(2, "0")}:${String(absM).padStart(2, "0")}`;
}

export function handleLocationQuery(url: URL, req: Request): Response {
  const viewer = edgeViewerIdentity(req) || verifyViewerToken(viewerTokenFromRequest(req));
  if (!viewer) return Response.json({ error: "Viewer token required" }, { status: 403 });
  if (!viewerTokenRateLimit(viewer.viewerId)) {
    return Response.json({ error: "Rate limit exceeded" }, { status: 429 });
  }
  const date = url.searchParams.get("date");
  const deviceId = url.searchParams.get("device_id");
  const window = normalizeHourWindow(url.searchParams.get("window"));
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return Response.json({ error: "date parameter required (YYYY-MM-DD)" }, { status: 400 });
  }
  if (url.searchParams.has("window") && !window) {
    return Response.json({ error: "window must be YYYYMMDDHH" }, { status: 400 });
  }
  if (window && !windowMatchesDate(window, date)) {
    return Response.json({ error: "window does not match date" }, { status: 400 });
  }

  try {
    const modifier = timezoneModifier(url);
    let records: LocationRecord[];

    if (modifier) {
      const whereWindow = window ? ` AND strftime('%Y%m%d%H', recorded_at, '${modifier}') = ?` : "";
      if (deviceId) {
        records = db.prepare(`
          SELECT device_id, latitude, longitude, accuracy_m, provider, recorded_at
          FROM location_records
          WHERE date(recorded_at, '${modifier}') = ?${whereWindow} AND device_id = ?
          ORDER BY recorded_at ASC
          LIMIT 10000
        `).all(...(window ? [date, window, deviceId] : [date, deviceId])) as LocationRecord[];
      } else {
        records = db.prepare(`
          SELECT device_id, latitude, longitude, accuracy_m, provider, recorded_at
          FROM location_records
          WHERE date(recorded_at, '${modifier}') = ?${whereWindow}
          ORDER BY recorded_at ASC
          LIMIT 10000
        `).all(...(window ? [date, window] : [date])) as LocationRecord[];
      }
    } else {
      const startOfDay = `${date}T00:00:00.000Z`;
      const d = new Date(startOfDay);
      if (isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== date) {
        return Response.json({ error: "Invalid date" }, { status: 400 });
      }
      d.setUTCDate(d.getUTCDate() + 1);
      const startOfNextDay = d.toISOString();

      if (deviceId) {
        records = db.prepare(`
          SELECT device_id, latitude, longitude, accuracy_m, provider, recorded_at
          FROM location_records
          WHERE recorded_at >= ? AND recorded_at < ?${window ? " AND strftime('%Y%m%d%H', recorded_at) = ?" : ""} AND device_id = ?
          ORDER BY recorded_at ASC
          LIMIT 10000
        `).all(...(window ? [startOfDay, startOfNextDay, window, deviceId] : [startOfDay, startOfNextDay, deviceId])) as LocationRecord[];
      } else {
        records = db.prepare(`
          SELECT device_id, latitude, longitude, accuracy_m, provider, recorded_at
          FROM location_records
          WHERE recorded_at >= ? AND recorded_at < ?${window ? " AND strftime('%Y%m%d%H', recorded_at) = ?" : ""}
          ORDER BY recorded_at ASC
          LIMIT 10000
        `).all(...(window ? [startOfDay, startOfNextDay, window] : [startOfDay, startOfNextDay])) as LocationRecord[];
      }
    }

    return locationQueryResponse(date, window, deviceId, records, url);
  } catch (e: any) {
    console.error("[location] Query error:", e.message);
    return Response.json({ error: "Internal error" }, { status: 500 });
  }
}

function locationQueryResponse(date: string, window: string | null, deviceId: string | null, records: LocationRecord[], url: URL): Response {
  const tzOffsetMinutes = timezoneOffsetMinutes(url);
  const response = Response.json({ date, window, records });
  const tags = ["location", `location-${date}`, ...(window ? [`location-window-${window}`] : []), ...(deviceId ? [`location-device-${deviceId}`] : [])];
  if ((window && isLiveHourWindow(window, tzOffsetMinutes)) || (!window && isTodayForOffset(date, tzOffsetMinutes))) {
    return noStore(response, tags);
  }
  return withCdnHeaders(
    response,
    tags,
    60 * 60 * 24 * 30,
  );
}

function timezoneOffsetMinutes(url: URL): number {
  const tzParam = url.searchParams.get("tz");
  const value = tzParam ? parseInt(tzParam, 10) : 0;
  return Number.isFinite(value) && Math.abs(value) <= 840 ? value : 0;
}

function isTodayForOffset(date: string, tzOffsetMinutes: number): boolean {
  const now = new Date(Date.now() - tzOffsetMinutes * 60_000);
  const today = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(now.getUTCDate()).padStart(2, "0")}`;
  return date === today;
}

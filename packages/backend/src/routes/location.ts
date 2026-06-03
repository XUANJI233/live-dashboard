import { db } from "../db";
import { verifyViewerToken, viewerTokenFromRequest, edgeViewerIdentity, viewerTokenRateLimit } from "../services/viewer-auth";
import type { LocationRecord } from "../types";
import { isLiveHourWindow, normalizeHourWindow, noStore, safeTimezoneOffset, utcRangeForLocalDate, utcRangeForLocalHourWindow, windowMatchesDate, withCdnHeaders } from "../services/cdn";

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
    const tzOffsetMinutes = timezoneOffsetMinutes(url);
    const range = window
      ? utcRangeForLocalHourWindow(window, tzOffsetMinutes)
      : utcRangeForLocalDate(date, tzOffsetMinutes);
    if (!range) return Response.json({ error: "Invalid date" }, { status: 400 });

    const whereDevice = deviceId ? " AND device_id = ?" : "";
    const query = db.prepare(`
      SELECT device_id, latitude, longitude, accuracy_m, provider, recorded_at
      FROM location_records
      WHERE recorded_at >= ? AND recorded_at < ?${whereDevice}
      ORDER BY recorded_at ASC
    `);
    const records = (deviceId
      ? query.all(range.start, range.end, deviceId)
      : query.all(range.start, range.end)) as LocationRecord[];

    return locationQueryResponse(date, window, deviceId, records, tzOffsetMinutes);
  } catch (e: any) {
    console.error("[location] Query error:", e.message);
    return Response.json({ error: "Internal error" }, { status: 500 });
  }
}

function locationQueryResponse(date: string, window: string | null, deviceId: string | null, records: LocationRecord[], tzOffsetMinutes: number): Response {
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
  return safeTimezoneOffset(value);
}

function isTodayForOffset(date: string, tzOffsetMinutes: number): boolean {
  const now = new Date(Date.now() - tzOffsetMinutes * 60_000);
  const today = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(now.getUTCDate()).padStart(2, "0")}`;
  return date === today;
}

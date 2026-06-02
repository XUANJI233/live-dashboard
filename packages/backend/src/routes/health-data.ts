import { authenticateToken } from "../middleware/auth";
import { db } from "../db";
import { verifyViewerToken, viewerTokenFromRequest, edgeViewerIdentity, viewerTokenRateLimit } from "../services/viewer-auth";
import type { HealthRecord } from "../types";
import { isLiveHourWindow, normalizeHourWindow, noStore, windowMatchesDate, withCdnHeaders } from "../services/cdn";

const MAX_RECORDS_PER_REQUEST = 1500; // supports full day of minute-level heart rate data (1440 max)
const VALID_TYPES = new Set([
  "heart_rate", "resting_heart_rate", "heart_rate_variability",
  "steps", "distance", "exercise", "sleep",
  "oxygen_saturation", "body_temperature", "respiratory_rate",
  "blood_pressure", "blood_glucose",
  "weight", "height",
  "active_calories", "total_calories",
  "battery_percent", "wear_status", "sleep_status", "sleep_start", "sleep_end",
  "sleep_duration", "deep_sleep_duration", "sleep_score", "sleep_stage_count",
  "nap_start", "nap_end", "nap_duration",
  "stand_hours", "stand_count", "stand_target",
  "stress", "air_pressure", "altitude",
  "hydration", "nutrition",
]);

const insertHealthRecord = db.prepare(`
  INSERT INTO health_records (device_id, type, value, unit, recorded_at, end_time)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(device_id, type, recorded_at, end_time) DO NOTHING
`);

const insertMany = db.transaction((records: { deviceId: string; type: string; value: number; unit: string; recordedAt: string; endTime: string }[]) => {
  let inserted = 0;
  for (const r of records) {
    const result = insertHealthRecord.run(r.deviceId, r.type, r.value, r.unit, r.recordedAt, r.endTime);
    if (result.changes > 0) inserted++;
  }
  return inserted;
});

export async function handleHealthData(req: Request): Promise<Response> {
  const device = authenticateToken(req.headers.get("authorization"));
  if (!device) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!Array.isArray(body.records) || body.records.length === 0) {
    return Response.json({ error: "records array required" }, { status: 400 });
  }

  if (body.records.length > MAX_RECORDS_PER_REQUEST) {
    return Response.json({ error: `Too many records (max ${MAX_RECORDS_PER_REQUEST})` }, { status: 400 });
  }

  const toInsert: { deviceId: string; type: string; value: number; unit: string; recordedAt: string; endTime: string }[] = [];

  for (const record of body.records) {
    if (typeof record.type !== "string" || !VALID_TYPES.has(record.type)) continue;
    if (typeof record.value !== "number" || !Number.isFinite(record.value)) continue;
    if (typeof record.unit !== "string" || record.unit.length > 20) continue;
    if (typeof record.timestamp !== "string" || !record.timestamp) continue;

    // Validate timestamp format
    const ts = new Date(record.timestamp);
    if (isNaN(ts.getTime())) continue;

    let endTime = "";
    if (typeof record.end_time === "string" && record.end_time) {
      const et = new Date(record.end_time);
      if (!isNaN(et.getTime())) {
        endTime = et.toISOString();
      }
    }

    toInsert.push({
      deviceId: device.device_id,
      type: record.type,
      value: record.value,
      unit: record.unit.slice(0, 20),
      recordedAt: ts.toISOString(),
      endTime,
    });
  }

  if (toInsert.length === 0) {
    return Response.json({ ok: true, inserted: 0 });
  }

  try {
    const inserted = insertMany(toInsert);
    return Response.json({ ok: true, inserted });
  } catch (e: any) {
    console.error("[health-data] DB error:", e.message);
    return Response.json({ error: "Internal error" }, { status: 500 });
  }
}

// Query endpoint for frontend (public, like /api/current and /api/timeline)
export function handleHealthDataQuery(url: URL, req: Request): Response {
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

  // Accept timezone offset in minutes (e.g. -480 for UTC+8), same as /api/timeline
  const tzParam = url.searchParams.get("tz");
  const tzOffsetMinutes = tzParam ? parseInt(tzParam, 10) : 0;

  try {
    if (tzOffsetMinutes && !isNaN(tzOffsetMinutes) && Math.abs(tzOffsetMinutes) <= 840) {
      // Convert offset to SQLite modifier (e.g. tz=-480 → "+08:00")
      const offsetHours = -tzOffsetMinutes / 60;
      const sign = offsetHours >= 0 ? "+" : "-";
      const absH = Math.floor(Math.abs(offsetHours));
      const absM = Math.round((Math.abs(offsetHours) - absH) * 60);
      const modifier = `${sign}${String(absH).padStart(2, "0")}:${String(absM).padStart(2, "0")}`;

      const whereWindow = window ? ` AND strftime('%Y%m%d%H', recorded_at, '${modifier}') = ?` : "";
      let records: HealthRecord[];
      if (deviceId) {
        records = db.prepare(`
          SELECT device_id, type, value, unit, recorded_at, end_time
          FROM health_records
          WHERE date(recorded_at, '${modifier}') = ?${whereWindow} AND device_id = ?
          ORDER BY recorded_at ASC
          LIMIT 10000
        `).all(...(window ? [date, window, deviceId] : [date, deviceId])) as HealthRecord[];
      } else {
        records = db.prepare(`
          SELECT device_id, type, value, unit, recorded_at, end_time
          FROM health_records
          WHERE date(recorded_at, '${modifier}') = ?${whereWindow}
          ORDER BY recorded_at ASC
          LIMIT 10000
        `).all(...(window ? [date, window] : [date])) as HealthRecord[];
      }

      return healthQueryResponse(date, window, deviceId, records, tzOffsetMinutes);
    }

    // No timezone offset — use UTC (backwards compatible)
    const startOfDay = `${date}T00:00:00.000Z`;
    const d = new Date(startOfDay);
    if (isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== date) {
      return Response.json({ error: "Invalid date" }, { status: 400 });
    }
    d.setUTCDate(d.getUTCDate() + 1);
    const startOfNextDay = d.toISOString();

    let records: HealthRecord[];
    if (deviceId) {
      records = db.prepare(`
        SELECT device_id, type, value, unit, recorded_at, end_time
        FROM health_records
        WHERE recorded_at >= ? AND recorded_at < ?${window ? " AND strftime('%Y%m%d%H', recorded_at) = ?" : ""} AND device_id = ?
        ORDER BY recorded_at ASC
        LIMIT 10000
      `).all(...(window ? [startOfDay, startOfNextDay, window, deviceId] : [startOfDay, startOfNextDay, deviceId])) as HealthRecord[];
    } else {
      records = db.prepare(`
        SELECT device_id, type, value, unit, recorded_at, end_time
        FROM health_records
        WHERE recorded_at >= ? AND recorded_at < ?${window ? " AND strftime('%Y%m%d%H', recorded_at) = ?" : ""}
        ORDER BY recorded_at ASC
        LIMIT 10000
      `).all(...(window ? [startOfDay, startOfNextDay, window] : [startOfDay, startOfNextDay])) as HealthRecord[];
    }

    return healthQueryResponse(date, window, deviceId, records, tzOffsetMinutes);
  } catch (e: any) {
    console.error("[health-data] Query error:", e.message);
    return Response.json({ error: "Internal error" }, { status: 500 });
  }
}

function healthQueryResponse(date: string, window: string | null, deviceId: string | null, records: HealthRecord[], tzOffsetMinutes: number): Response {
  const response = Response.json({ date, window, records });
  const tags = ["health-data", `health-data-${date}`, ...(window ? [`health-data-window-${window}`] : []), ...(deviceId ? [`health-device-${deviceId}`] : [])];
  if (isTodayForOffset(date, tzOffsetMinutes) || (window && isLiveHourWindow(window, safeTimezoneOffset(tzOffsetMinutes)))) {
    return noStore(response, tags);
  }
  return withCdnHeaders(
    response,
    tags,
    60 * 60 * 24 * 30,
  );
}

function isTodayForOffset(date: string, tzOffsetMinutes: number): boolean {
  const now = new Date(Date.now() - safeTimezoneOffset(tzOffsetMinutes) * 60_000);
  const today = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(now.getUTCDate()).padStart(2, "0")}`;
  return date === today;
}

function safeTimezoneOffset(value: number): number {
  return Number.isFinite(value) && Math.abs(value) <= 840 ? value : 0;
}

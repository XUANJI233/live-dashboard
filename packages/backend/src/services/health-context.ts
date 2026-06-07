import { db } from "../db";

const SLEEP_TYPES = [
  "sleep",
  "sleep_status",
  "sleep_start",
  "sleep_end",
  "sleep_duration",
  "deep_sleep_duration",
  "sleep_score",
  "nap_duration",
];

const getSleepRows = db.prepare(`
  SELECT h.device_id, h.type, h.value, h.unit, h.recorded_at, h.end_time,
         COALESCE(d.device_name, h.device_id) AS device_name,
         COALESCE(d.platform, '') AS platform
  FROM health_records h
  LEFT JOIN device_states d ON d.device_id = h.device_id
  WHERE h.type IN (${SLEEP_TYPES.map(() => "?").join(",")})
    AND (
      (h.end_time <> '' AND h.recorded_at < ? AND h.end_time >= ?)
      OR (h.end_time = '' AND h.recorded_at >= ? AND h.recorded_at < ?)
    )
  ORDER BY h.recorded_at ASC
  LIMIT 40
`);

const getWatchSleepSessionAt = db.prepare(`
  SELECT 1
  FROM health_records h
  JOIN device_states d ON d.device_id = h.device_id
  WHERE d.platform = 'zepp'
    AND h.type IN ('sleep', 'nap_duration')
    AND h.recorded_at <= ?
    AND h.end_time >= ?
  LIMIT 1
`);

const getWatchSleepStatus = db.prepare(`
  SELECT h.value, h.recorded_at
  FROM health_records h
  JOIN device_states d ON d.device_id = h.device_id
  WHERE d.platform = 'zepp'
    AND h.type = 'sleep_status'
    AND h.recorded_at >= ?
    AND h.recorded_at <= ?
  ORDER BY h.recorded_at DESC
  LIMIT 1
`);

interface SleepRow {
  device_id: string;
  device_name: string;
  platform: string;
  type: string;
  value: number;
  unit: string;
  recorded_at: string;
  end_time: string;
}

export function sleepContextLinesForRange(start: string, end: string, maxLines = 12): string[] {
  const rows = getSleepRows.all(...SLEEP_TYPES, end, start, start, end) as SleepRow[];
  return rows.slice(0, maxLines).map(formatSleepRow);
}

export function trustedWatchSleepingAt(at: Date, freshnessMinutes = 20): boolean {
  const iso = at.toISOString();
  if (getWatchSleepSessionAt.get(iso, iso)) return true;

  const since = new Date(at.getTime() - freshnessMinutes * 60_000).toISOString();
  const row = getWatchSleepStatus.get(since, iso) as { value: number; recorded_at: string } | null;
  return Boolean(row && row.value > 0);
}

function formatSleepRow(row: SleepRow): string {
  const source = row.platform === "zepp" ? "手表" : "设备";
  const range = row.end_time
    ? `${clock(row.recorded_at)}-${clock(row.end_time)}`
    : clock(row.recorded_at);
  const value = row.type.includes("duration") || row.type === "sleep" || row.type === "nap_duration"
    ? `${Math.round(row.value)}分钟`
    : `${Number(row.value.toFixed(1))}${row.unit}`;
  return `- ${source}/${clean(row.device_name)} ${range} ${sleepLabel(row.type)} ${value}`;
}

function sleepLabel(type: string): string {
  switch (type) {
    case "sleep": return "睡眠";
    case "sleep_status": return "睡眠状态";
    case "sleep_start": return "入睡";
    case "sleep_end": return "醒来";
    case "sleep_duration": return "睡眠时长";
    case "deep_sleep_duration": return "深睡";
    case "sleep_score": return "睡眠评分";
    case "nap_duration": return "小睡";
    default: return type;
  }
}

function clock(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 16);
  return date.toISOString().replace("T", " ").slice(0, 16);
}

function clean(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 40) || "未知";
}

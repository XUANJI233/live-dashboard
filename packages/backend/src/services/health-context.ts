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

const HEALTH_CONTEXT_TYPES = [
  ...SLEEP_TYPES,
  "heart_rate",
  "resting_heart_rate",
  "heart_rate_variability",
  "oxygen_saturation",
  "body_temperature",
  "respiratory_rate",
  "blood_pressure",
  "blood_glucose",
  "steps",
  "distance",
  "exercise",
  "active_calories",
  "total_calories",
  "hydration",
  "weight",
];

const SLEEP_TYPE_SET = new Set(SLEEP_TYPES);
const TOTAL_HEALTH_TYPES = new Set(["steps", "distance", "exercise", "active_calories", "total_calories", "hydration"]);
const LATEST_HEALTH_TYPES = new Set(["resting_heart_rate", "weight"]);

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

const getHealthRows = db.prepare(`
  SELECT h.device_id, h.type, h.value, h.unit, h.recorded_at, h.end_time,
         COALESCE(d.device_name, h.device_id) AS device_name,
         COALESCE(d.platform, '') AS platform
  FROM health_records h
  LEFT JOIN device_states d ON d.device_id = h.device_id
  WHERE h.type IN (${HEALTH_CONTEXT_TYPES.map(() => "?").join(",")})
    AND (
      (h.end_time <> '' AND h.recorded_at < ? AND h.end_time >= ?)
      OR (h.end_time = '' AND h.recorded_at >= ? AND h.recorded_at < ?)
    )
  ORDER BY h.recorded_at ASC
  LIMIT 500
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

type HealthRow = SleepRow;

export function sleepContextLinesForRange(start: string, end: string, maxLines = 12): string[] {
  const rows = getSleepRows.all(...SLEEP_TYPES, end, start, start, end) as SleepRow[];
  return rows.slice(0, maxLines).map(formatSleepRow);
}

export function healthContextLinesForRange(start: string, end: string, maxLines = 16): string[] {
  const rows = getHealthRows.all(...HEALTH_CONTEXT_TYPES, end, start, start, end) as HealthRow[];
  if (rows.length === 0) return [];

  const out: string[] = [];
  const sleepBudget = Math.min(8, Math.max(0, Math.floor(maxLines / 2)));
  const sleepRows = rows.filter((row) => SLEEP_TYPE_SET.has(row.type)).slice(0, sleepBudget);
  out.push(...sleepRows.map(formatSleepRow));

  const metricLines = summarizeMetricRows(
    rows.filter((row) => !SLEEP_TYPE_SET.has(row.type)),
    Math.max(0, maxLines - out.length),
  );
  out.push(...metricLines);
  return out.slice(0, maxLines);
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

function summarizeMetricRows(rows: HealthRow[], maxLines: number): string[] {
  if (maxLines <= 0) return [];
  const groups = new Map<string, HealthRow[]>();
  for (const row of rows) {
    if (!Number.isFinite(row.value)) continue;
    const key = `${sourceLabel(row)}/${clean(row.device_name)}/${row.type}`;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }

  return Array.from(groups.values())
    .sort((a, b) => healthTypePriority(a[0]?.type || "") - healthTypePriority(b[0]?.type || ""))
    .slice(0, maxLines)
    .map(formatMetricGroup);
}

function formatMetricGroup(rows: HealthRow[]): string {
  const first = rows[0]!;
  const latest = rows[rows.length - 1]!;
  const values = rows.map((row) => row.value).filter(Number.isFinite);
  const label = healthLabel(first.type);
  const source = sourceLabel(first);
  const device = clean(first.device_name);
  if (TOTAL_HEALTH_TYPES.has(first.type)) {
    const total = values.reduce((sum, value) => sum + value, 0);
    return `- ${source}/${device} ${label} 合计${formatHealthValue(total, first.unit)}，末次${clock(latest.recorded_at)}`;
  }
  if (LATEST_HEALTH_TYPES.has(first.type) || values.length === 1) {
    return `- ${source}/${device} ${label} 最新${formatHealthValue(latest.value, latest.unit)}，${clock(latest.recorded_at)}`;
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const avg = values.reduce((sum, value) => sum + value, 0) / values.length;
  return `- ${source}/${device} ${label} ${formatHealthValue(min, first.unit)}-${formatHealthValue(max, first.unit)}，均${formatHealthValue(avg, first.unit)}，${values.length}条`;
}

function sourceLabel(row: Pick<HealthRow, "platform">): string {
  return row.platform === "zepp" ? "手表" : "设备";
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

function healthLabel(type: string): string {
  switch (type) {
    case "heart_rate": return "心率";
    case "resting_heart_rate": return "静息心率";
    case "heart_rate_variability": return "心率变异性";
    case "oxygen_saturation": return "血氧";
    case "body_temperature": return "体表温度";
    case "respiratory_rate": return "呼吸率";
    case "blood_pressure": return "收缩压";
    case "blood_glucose": return "血糖";
    case "steps": return "步数";
    case "distance": return "距离";
    case "exercise": return "运动";
    case "active_calories": return "活动热量";
    case "total_calories": return "总热量";
    case "hydration": return "饮水";
    case "weight": return "体重";
    default: return type;
  }
}

function healthTypePriority(type: string): number {
  const order = HEALTH_CONTEXT_TYPES.indexOf(type);
  return order === -1 ? HEALTH_CONTEXT_TYPES.length : order;
}

function formatHealthValue(value: number, unit: string): string {
  const rounded = Math.abs(value) >= 100 ? Math.round(value) : Number(value.toFixed(1));
  return `${rounded}${unit}`;
}

function clock(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 16);
  return date.toISOString().replace("T", " ").slice(0, 16);
}

function clean(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 40) || "未知";
}

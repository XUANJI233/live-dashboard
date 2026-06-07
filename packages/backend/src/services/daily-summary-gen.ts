import type { ActivityRecord, TimelineSegment } from "../types";
import {
  db,
  getDailySummary,
  getWeeklySummary,
  metaGet,
  metaSet,
  upsertDailySummary,
  upsertWeeklySummary,
} from "../db";
import { buildTimelineSegments } from "../routes/timeline";
import { getAiRuntimeConfig } from "./ai-config";
import { safeTimezoneOffset, utcRangeForLocalDate } from "./cdn";

/**
 * AI Summary Generator
 *
 * Env vars (all optional — if not set, generation is skipped):
 *   AI_API_URL   — OpenAI-compatible chat endpoint (e.g. https://api.openai.com/v1/chat/completions)
 *   AI_API_KEY   — Bearer token for the API
 *   AI_MODEL     — Model name (default: gpt-4o-mini)
 */

const SUMMARY_SETTINGS_KEY = "ai_summary_settings";

export type SummaryMode = "gentle" | "normal" | "sharp";
export type SummaryKind = "daily" | "weekly";

export interface SummarySettings {
  mode: SummaryMode;
  target: string;
  updated_at: string | null;
}

export interface SummaryGenerationResult {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  kind: SummaryKind;
  date?: string;
  week_start?: string;
  week_end?: string;
  summary?: string;
  generated_at?: string | null;
  mode?: SummaryMode;
}

interface SummaryRow {
  summary: string;
  generated_at: string | null;
  mode?: string;
}

const MODE_LABELS: Record<SummaryMode, string> = {
  gentle: "温和",
  normal: "一般",
  sharp: "锐评",
};

const MODE_INSTRUCTIONS: Record<SummaryMode, string> = {
  gentle: "语气要温柔、体谅，指出节奏时使用轻量提醒，不要责备，可以进行安慰和鼓励。",
  normal: "语气要清醒、自然，既总结亮点，也指出明显的分心或拖延，提供中肯的反馈和建议，不要过于严厉或过于宽容。",
  sharp: "锐利一点，允许短促吐槽低效和跑偏，可以羞辱或人身攻击，但必须言之有物，不能无脑批评或编造事实，指出节奏时可以直接了当，不需要过多修饰和缓和。评判节奏时以目标为核心，完全不达标的节奏需要严厉批评和讽刺，偶尔可以进行人身攻击和羞辱，但必须基于事实.最后给出明日目标,并且用命令式语气要求执行，不能委婉或者建议式表达。",
};

const getActivityRows = db.prepare(`
  SELECT *
  FROM activities
  WHERE started_at >= ? AND started_at < ?
  ORDER BY started_at ASC
`);

export function getSummarySettings(): SummarySettings {
  const raw = metaGet(SUMMARY_SETTINGS_KEY);
  if (!raw) return defaultSummarySettings();
  try {
    const parsed = JSON.parse(raw) as Partial<SummarySettings>;
    return {
      mode: normalizeSummaryMode(parsed.mode),
      target: sanitizeTarget(parsed.target),
      updated_at: typeof parsed.updated_at === "string" ? parsed.updated_at : null,
    };
  } catch {
    return defaultSummarySettings();
  }
}

export function updateSummarySettings(input: unknown): SummarySettings {
  const source = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const current = getSummarySettings();
  const next: SummarySettings = {
    mode: source.mode === undefined ? current.mode : normalizeSummaryMode(source.mode),
    target: source.target === undefined ? current.target : sanitizeTarget(source.target),
    updated_at: new Date().toISOString(),
  };
  metaSet(SUMMARY_SETTINGS_KEY, JSON.stringify(next));
  return next;
}

export function normalizeSummaryMode(value: unknown): SummaryMode {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "gentle" || raw === "mild" || raw === "soft" || raw === "温和") return "gentle";
  if (raw === "sharp" || raw === "roast" || raw === "critical" || raw === "锐评") return "sharp";
  return "normal";
}

export async function generateDailySummary(options: {
  date?: string;
  tzOffsetMinutes?: number;
} = {}): Promise<SummaryGenerationResult> {
  const date = validDateString(options.date) ? options.date! : todayStr();
  const tzOffsetMinutes = safeTimezoneOffset(options.tzOffsetMinutes ?? new Date().getTimezoneOffset());
  const range = utcRangeForLocalDate(date, tzOffsetMinutes);
  if (!range) {
    return { ok: false, kind: "daily", date, reason: "Invalid date" };
  }

  const rows = getActivityRows.all(range.start, range.end) as ActivityRecord[];
  const segments = buildTimelineSegments(rows, { openLast: false });
  const settings = getSummarySettings();
  const generated = await generateSummaryText({
    kind: "daily",
    periodLabel: date,
    segments,
    settings,
  });

  if (!generated.ok || !generated.summary) {
    return { ...generated, kind: "daily", date, mode: settings.mode };
  }

  upsertDailySummary.run(date, generated.summary, settings.mode, settings.target);
  const row = getDailySummary.get(date) as SummaryRow | null;
  console.log(`[ai-summary] Generated daily summary for ${date}: ${generated.summary.slice(0, 60)}...`);
  return {
    ok: true,
    kind: "daily",
    date,
    summary: row?.summary ?? generated.summary,
    generated_at: row?.generated_at ?? null,
    mode: normalizeSummaryMode(row?.mode ?? settings.mode),
  };
}

export async function generateWeeklySummary(options: {
  date?: string;
  weekStart?: string;
  tzOffsetMinutes?: number;
} = {}): Promise<SummaryGenerationResult> {
  const weekStart = validDateString(options.weekStart)
    ? startOfWeek(options.weekStart!)
    : startOfWeek(validDateString(options.date) ? options.date! : todayStr());
  const weekEnd = addDays(weekStart, 6);
  const weekEndExclusive = addDays(weekStart, 7);
  const tzOffsetMinutes = safeTimezoneOffset(options.tzOffsetMinutes ?? new Date().getTimezoneOffset());
  const startRange = utcRangeForLocalDate(weekStart, tzOffsetMinutes);
  const endRange = utcRangeForLocalDate(weekEndExclusive, tzOffsetMinutes);
  if (!startRange || !endRange) {
    return { ok: false, kind: "weekly", week_start: weekStart, week_end: weekEnd, reason: "Invalid week" };
  }

  const rows = getActivityRows.all(startRange.start, endRange.start) as ActivityRecord[];
  const segments = buildTimelineSegments(rows, { openLast: false });
  const settings = getSummarySettings();
  const generated = await generateSummaryText({
    kind: "weekly",
    periodLabel: `${weekStart} 至 ${weekEnd}`,
    segments,
    settings,
  });

  if (!generated.ok || !generated.summary) {
    return { ...generated, kind: "weekly", week_start: weekStart, week_end: weekEnd, mode: settings.mode };
  }

  upsertWeeklySummary.run(weekStart, weekEnd, generated.summary, settings.mode, settings.target);
  const row = getWeeklySummary.get(weekStart) as SummaryRow | null;
  console.log(`[ai-summary] Generated weekly summary for ${weekStart}: ${generated.summary.slice(0, 60)}...`);
  return {
    ok: true,
    kind: "weekly",
    week_start: weekStart,
    week_end: weekEnd,
    summary: row?.summary ?? generated.summary,
    generated_at: row?.generated_at ?? null,
    mode: normalizeSummaryMode(row?.mode ?? settings.mode),
  };
}

export function startOfWeek(date: string): string {
  const d = dateFromString(date);
  if (!d) return todayStr();
  const day = d.getUTCDay();
  const offset = (day + 6) % 7;
  return dateStringFromMs(d.getTime() - offset * 86_400_000);
}

export function addDays(date: string, days: number): string {
  const d = dateFromString(date);
  if (!d) return date;
  return dateStringFromMs(d.getTime() + days * 86_400_000);
}

export function validDateString(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  return dateFromString(value) !== null;
}

function defaultSummarySettings(): SummarySettings {
  return { mode: "normal", target: "", updated_at: null };
}

function sanitizeTarget(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function generateSummaryText(input: {
  kind: SummaryKind;
  periodLabel: string;
  segments: TimelineSegment[];
  settings: SummarySettings;
}): Promise<Pick<SummaryGenerationResult, "ok" | "skipped" | "reason" | "summary">> {
  const aiConfig = await getAiRuntimeConfig();
  if (!aiConfig) {
    return { ok: false, skipped: true, reason: "AI not configured" };
  }
  const usefulSegments = input.segments.filter((segment) => segment.duration_seconds > 0);
  if (usefulSegments.length === 0) {
    return { ok: false, skipped: true, reason: "No activity data" };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch(aiConfig.apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${aiConfig.apiKey}`,
      },
      body: JSON.stringify({
        model: aiConfig.model,
        messages: [
          { role: "system", content: buildSystemPrompt(input.kind, input.settings) },
          { role: "user", content: buildUserPrompt(input.kind, input.periodLabel, usefulSegments) },
        ],
        max_tokens: input.kind === "weekly" ? 420 : 240,
        temperature: input.settings.mode === "sharp" ? 0.85 : 0.72,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[ai-summary] API returned ${res.status}: ${body.slice(0, 500)}`);
      return { ok: false, reason: `AI API returned ${res.status}` };
    }

    const data = await res.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const summary = data?.choices?.[0]?.message?.content?.trim();
    if (!summary) {
      console.error("[ai-summary] Empty response from AI");
      return { ok: false, reason: "Empty AI response" };
    }
    return { ok: true, summary };
  } catch (e) {
    console.error("[ai-summary] Failed to generate:", e);
    return { ok: false, reason: "AI generation failed" };
  } finally {
    clearTimeout(timeoutId);
  }
}

function buildSystemPrompt(kind: SummaryKind, settings: SummarySettings): string {
  const isWeekly = kind === "weekly";
  const lengthRule = isWeekly ? "写一段120-200字的中文周总结" : "写一段60-100字的中文日总结";
  const targetRule = settings.target
    ? `用户当前目标：${settings.target}。请判断这段时间的活动节奏和目标是否一致，并给出自然提醒。`
    : "用户没有设置额外目标，不要虚构目标。";

  return `你是一个简洁、准确、有审美的日记助手。根据设备活动时间线，${lengthRule}。
当前模式：${MODE_LABELS[settings.mode]}。
模式要求：${MODE_INSTRUCTIONS[settings.mode]}
目标要求：${targetRule}
通用要求：
- 基于时间线时长和顺序总结，不要按原始上报条数判断
- 提炼节奏、主题、偏离和收获，不要逐条罗列应用
- 可以提到主要应用或任务，但不要泄露过细窗口标题
- 不要使用 emoji
- 不要编造没有出现在时间线里的事件`;
}

function buildUserPrompt(kind: SummaryKind, periodLabel: string, segments: TimelineSegment[]): string {
  const topApps = aggregateByApp(segments).slice(0, kind === "weekly" ? 12 : 8);
  const byDay = aggregateByDay(segments);
  const timelineLimit = kind === "weekly" ? 80 : 48;
  const totalMinutes = segments.reduce((sum, segment) => sum + segmentMinutes(segment), 0);

  const lines: string[] = [
    `范围: ${periodLabel}`,
    `类型: ${kind === "weekly" ? "周总结" : "日总结"}`,
    `总记录时长: ${formatMinutes(totalMinutes)}`,
    "",
    "主要应用:",
    ...topApps.map((item) => `- ${item.appName}: ${formatMinutes(item.minutes)}，${item.count}段，设备 ${item.devices.join("/")}`),
  ];

  if (kind === "weekly") {
    lines.push("", "每日节奏:");
    for (const item of byDay) {
      lines.push(`- ${item.date}: ${formatMinutes(item.minutes)}，主要 ${item.topApps.join("、") || "无"}`);
    }
  }

  lines.push("", "时间线片段:");
  for (const segment of segments.slice(0, timelineLimit)) {
    const title = segment.display_title ? `，标题: ${segment.display_title.slice(0, 80)}` : "";
    lines.push(
      `- ${formatSegmentTime(segment)} ${segment.device_name}: ${segment.app_name} ${formatMinutes(segmentMinutes(segment))}${title}`,
    );
  }
  if (segments.length > timelineLimit) {
    lines.push(`- 其余 ${segments.length - timelineLimit} 段已省略，请以主要应用和每日节奏为准。`);
  }

  return lines.join("\n");
}

function aggregateByApp(segments: TimelineSegment[]): Array<{ appName: string; minutes: number; count: number; devices: string[] }> {
  const map = new Map<string, { appName: string; minutes: number; count: number; devices: Set<string> }>();
  for (const segment of segments) {
    const appName = segment.app_name || segment.app_id || "未知应用";
    const item = map.get(appName) ?? { appName, minutes: 0, count: 0, devices: new Set<string>() };
    item.minutes += segmentMinutes(segment);
    item.count += 1;
    item.devices.add(segment.device_name || segment.device_id || "未知设备");
    map.set(appName, item);
  }
  return Array.from(map.values())
    .map((item) => ({ ...item, devices: Array.from(item.devices).slice(0, 3) }))
    .sort((a, b) => b.minutes - a.minutes || b.count - a.count);
}

function aggregateByDay(segments: TimelineSegment[]): Array<{ date: string; minutes: number; topApps: string[] }> {
  const map = new Map<string, TimelineSegment[]>();
  for (const segment of segments) {
    const date = segment.started_at.slice(0, 10);
    const rows = map.get(date) ?? [];
    rows.push(segment);
    map.set(date, rows);
  }
  return Array.from(map.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, rows]) => ({
      date,
      minutes: rows.reduce((sum, segment) => sum + segmentMinutes(segment), 0),
      topApps: aggregateByApp(rows).slice(0, 3).map((item) => item.appName),
    }));
}

function segmentMinutes(segment: TimelineSegment): number {
  return Math.max(0, Math.round(segment.duration_seconds / 60));
}

function formatMinutes(minutes: number): string {
  const safe = Math.max(0, Math.round(minutes));
  if (safe < 60) return `${safe}分钟`;
  const hours = Math.floor(safe / 60);
  const rest = safe % 60;
  return rest ? `${hours}小时${rest}分钟` : `${hours}小时`;
}

function formatSegmentTime(segment: TimelineSegment): string {
  const start = segment.started_at.replace("T", " ").slice(0, 16);
  const end = segment.ended_at ? segment.ended_at.replace("T", " ").slice(11, 16) : "结束未知";
  return `${start}-${end}`;
}

function dateFromString(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map((part) => Number.parseInt(part, 10));
  if (!year || !month || !day) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date;
}

function dateStringFromMs(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

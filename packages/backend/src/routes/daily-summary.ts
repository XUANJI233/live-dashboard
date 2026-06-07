import { authenticateToken } from "../middleware/auth";
import { getDailySummary, getWeeklySummary } from "../db";
import { noStore, safeTimezoneOffset, withCdnHeaders } from "../services/cdn";
import {
  addDays,
  generateDailySummary,
  generateWeeklySummary,
  getSummarySettings,
  startOfWeek,
  updateSummarySettings,
  validDateString,
  type SummaryMode,
} from "../services/daily-summary-gen";

interface DailySummaryRow {
  date: string;
  summary: string;
  generated_at: string | null;
  mode?: SummaryMode;
}

interface WeeklySummaryRow {
  week_start: string;
  week_end: string;
  summary: string;
  generated_at: string | null;
  mode?: SummaryMode;
}

export function handleDailySummary(url: URL): Response {
  const date = url.searchParams.get("date");
  if (!validDateString(date)) {
    return Response.json({ error: "Missing or invalid date param (YYYY-MM-DD)" }, { status: 400 });
  }

  const row = getDailySummary.get(date) as DailySummaryRow | null;
  const body = row
    ? publicDailySummary(row)
    : { date, summary: null, generated_at: null, mode: null };

  return withCdnHeaders(
    Response.json(body),
    ["daily-summary", `daily-summary-${date}`],
    60,
  );
}

export async function handleDailySummaryRefresh(req: Request, url: URL): Promise<Response> {
  const unauthorized = requireAdmin(req);
  if (unauthorized) return unauthorized;

  const body = await readJsonObject(req);
  const date = pickDate(url, body, "date");
  if (!validDateString(date)) {
    return noStore(Response.json({ error: "Missing or invalid date (YYYY-MM-DD)" }, { status: 400 }), ["daily-summary-refresh"]);
  }

  const result = await generateDailySummary({
    date,
    tzOffsetMinutes: pickTimezoneOffset(url, body),
  });
  if (!result.ok) {
    return noStore(
      Response.json({ error: result.reason || "AI summary failed", skipped: result.skipped === true }, { status: result.skipped ? 409 : 502 }),
      ["daily-summary", `daily-summary-${date}`],
    );
  }
  return noStore(Response.json(result), ["daily-summary", `daily-summary-${date}`]);
}

export function handleWeeklySummary(url: URL): Response {
  const weekStart = normalizeWeekParam(url);
  if (!weekStart) {
    return Response.json({ error: "Missing or invalid date/week_start param (YYYY-MM-DD)" }, { status: 400 });
  }

  const row = getWeeklySummary.get(weekStart) as WeeklySummaryRow | null;
  const body = row
    ? publicWeeklySummary(row)
    : { week_start: weekStart, week_end: addDays(weekStart, 6), summary: null, generated_at: null, mode: null };

  return withCdnHeaders(
    Response.json(body),
    ["weekly-summary", `weekly-summary-${weekStart}`],
    60,
  );
}

export async function handleWeeklySummaryRefresh(req: Request, url: URL): Promise<Response> {
  const unauthorized = requireAdmin(req);
  if (unauthorized) return unauthorized;

  const body = await readJsonObject(req);
  const weekStart = normalizeWeekParam(url, body);
  if (!weekStart) {
    return noStore(Response.json({ error: "Missing or invalid date/week_start (YYYY-MM-DD)" }, { status: 400 }), ["weekly-summary-refresh"]);
  }

  const result = await generateWeeklySummary({
    weekStart,
    tzOffsetMinutes: pickTimezoneOffset(url, body),
  });
  if (!result.ok) {
    return noStore(
      Response.json({ error: result.reason || "AI weekly summary failed", skipped: result.skipped === true }, { status: result.skipped ? 409 : 502 }),
      ["weekly-summary", `weekly-summary-${weekStart}`],
    );
  }
  return noStore(Response.json(result), ["weekly-summary", `weekly-summary-${weekStart}`]);
}

export function handleSummarySettings(req: Request): Response {
  const unauthorized = requireAdmin(req);
  if (unauthorized) return unauthorized;
  return noStore(Response.json(getSummarySettings()), ["summary-settings"]);
}

export async function handleSummarySettingsUpdate(req: Request): Promise<Response> {
  const unauthorized = requireAdmin(req);
  if (unauthorized) return unauthorized;
  const body = await readJsonObject(req);
  const settings = updateSummarySettings(body);
  return noStore(Response.json(settings), ["summary-settings"]);
}

function requireAdmin(req: Request): Response | null {
  const device = authenticateToken(req.headers.get("authorization"));
  if (!device) return Response.json({ error: "Unauthorized" }, { status: 401 });
  return null;
}

async function readJsonObject(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = await req.json();
    return body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function publicDailySummary(row: DailySummaryRow) {
  return {
    date: row.date,
    summary: row.summary,
    generated_at: row.generated_at,
    mode: row.mode || "normal",
  };
}

function publicWeeklySummary(row: WeeklySummaryRow) {
  return {
    week_start: row.week_start,
    week_end: row.week_end,
    summary: row.summary,
    generated_at: row.generated_at,
    mode: row.mode || "normal",
  };
}

function pickDate(url: URL, body: Record<string, unknown>, key: string): string | null {
  const bodyValue = body[key];
  return typeof bodyValue === "string" && bodyValue ? bodyValue : url.searchParams.get(key);
}

function normalizeWeekParam(url: URL, body: Record<string, unknown> = {}): string | null {
  const weekStart = pickDate(url, body, "week_start");
  if (validDateString(weekStart)) return startOfWeek(weekStart);
  const date = pickDate(url, body, "date");
  if (validDateString(date)) return startOfWeek(date);
  return null;
}

function pickTimezoneOffset(url: URL, body: Record<string, unknown>): number {
  const bodyTz = body.tz ?? body.tz_offset_minutes;
  const raw = typeof bodyTz === "number" || typeof bodyTz === "string"
    ? bodyTz
    : url.searchParams.get("tz");
  const value = typeof raw === "number" ? raw : Number.parseInt(String(raw || "0"), 10);
  return safeTimezoneOffset(value);
}

import { authenticateToken, extractBearerToken } from "../middleware/auth";
import { getDailySummary, getWeeklySummary } from "../db";
import { noStore, safeTimezoneOffset, withCdnHeaders } from "../services/cdn";
import { describeAiConfig, saveEncryptedAiConfigFromDevice } from "../services/ai-config";
import {
  addDays,
  getSummarySettings,
  startOfWeek,
  updateSummarySettings,
  validDateString,
  type SummaryMode,
} from "../services/daily-summary-gen";
import { syncCurrentSupervisionPolicyToCapableDevices } from "../services/supervision-policy-control";
import { aiJobInputErrorResponse, submitAiJobFromClient } from "../services/ai-jobs";

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
  const device = authenticateToken(req.headers.get("authorization"));
  if (!device) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const body = await readJsonObject(req);
  const date = pickDate(url, body, "date");
  if (!validDateString(date)) {
    return noStore(Response.json({ error: "Missing or invalid date (YYYY-MM-DD)" }, { status: 400 }), ["daily-summary-refresh"]);
  }

  try {
    const submitted = submitAiJobFromClient({
      request_id: body.request_id,
      kind: "daily_summary",
      payload: { date, tz: pickTimezoneOffset(url, body) },
    }, device, extractBearerToken(req.headers.get("authorization")));
    return noStore(Response.json(submitted, { status: 202 }), ["daily-summary", `daily-summary-${date}`, "ai-jobs"]);
  } catch (e) {
    const error = aiJobInputErrorResponse(e);
    return noStore(Response.json(error.body, { status: error.status }), ["daily-summary", `daily-summary-${date}`]);
  }
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
  const device = authenticateToken(req.headers.get("authorization"));
  if (!device) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const body = await readJsonObject(req);
  const weekStart = normalizeWeekParam(url, body);
  if (!weekStart) {
    return noStore(Response.json({ error: "Missing or invalid date/week_start (YYYY-MM-DD)" }, { status: 400 }), ["weekly-summary-refresh"]);
  }

  try {
    const submitted = submitAiJobFromClient({
      request_id: body.request_id,
      kind: "weekly_summary",
      payload: { week_start: weekStart, tz: pickTimezoneOffset(url, body) },
    }, device, extractBearerToken(req.headers.get("authorization")));
    return noStore(Response.json(submitted, { status: 202 }), ["weekly-summary", `weekly-summary-${weekStart}`, "ai-jobs"]);
  } catch (e) {
    const error = aiJobInputErrorResponse(e);
    return noStore(Response.json(error.body, { status: error.status }), ["weekly-summary", `weekly-summary-${weekStart}`]);
  }
}

export function handleSummarySettings(req: Request): Response {
  const unauthorized = requireAdmin(req);
  if (unauthorized) return unauthorized;
  return noStore(Response.json(getSummarySettings()), ["summary-settings"]);
}

export async function handleSummarySettingsUpdate(req: Request): Promise<Response> {
  const device = authenticateToken(req.headers.get("authorization"));
  if (!device) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const body = await readJsonObject(req);
  const settings = updateSummarySettings(body);
  let rulesRefreshJob: unknown = null;
  if (settings.sync_status === "applied" && settings.supervision_enabled) {
    try {
      rulesRefreshJob = submitAiJobFromClient({
        request_id: body.request_id,
        kind: "supervision_rules_refresh",
        payload: { settings_updated_at: settings.updated_at },
      }, device, extractBearerToken(req.headers.get("authorization"))).job;
    } catch {
      rulesRefreshJob = { status: "failed_to_queue" };
    }
  }
  if (settings.sync_status === "applied") {
    syncCurrentSupervisionPolicyToCapableDevices(settings);
  }
  return noStore(Response.json({ ...settings, rules_refresh_job: rulesRefreshJob }), ["summary-settings", "ai-jobs"]);
}

export async function handleAiConfig(req: Request): Promise<Response> {
  const unauthorized = requireAdmin(req);
  if (unauthorized) return unauthorized;
  return noStore(Response.json(await describeAiConfig()), ["ai-config"]);
}

export async function handleAiConfigUpdate(req: Request): Promise<Response> {
  const unauthorized = requireAdmin(req);
  if (unauthorized) return unauthorized;
  const token = extractBearerToken(req.headers.get("authorization"));
  const body = await readJsonObject(req);
  try {
    const config = await saveEncryptedAiConfigFromDevice(body, token);
    return noStore(Response.json(config), ["ai-config"]);
  } catch (e) {
    const err = e as Error & { status?: number; code?: string };
    return noStore(
      Response.json({
        error: err.message || "AI config update failed",
        code: err.code || "AI_CONFIG_UPDATE_FAILED",
      }, { status: err.status || 400 }),
      ["ai-config"],
    );
  }
}

export async function handleAiConfigTest(req: Request): Promise<Response> {
  const device = authenticateToken(req.headers.get("authorization"));
  if (!device) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const token = extractBearerToken(req.headers.get("authorization"));
  const body = await readJsonObject(req);
  try {
    const submitted = submitAiJobFromClient({
      request_id: body.request_id,
      kind: "ai_config_test",
      payload: body,
    }, device, token);
    return noStore(Response.json(submitted, { status: 202 }), ["ai-config", "ai-jobs"]);
  } catch (e) {
    const err = aiJobInputErrorResponse(e);
    return noStore(
      Response.json(err.body, { status: err.status }),
      ["ai-config"],
    );
  }
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

function pickTimezoneOffset(url: URL, body: Record<string, unknown>): number | undefined {
  const bodyTz = body.tz ?? body.tz_offset_minutes;
  const urlTz = url.searchParams.get("tz");
  const raw = typeof bodyTz === "number" || typeof bodyTz === "string" ? bodyTz : urlTz;
  if (raw === null || raw === undefined || raw === "") return undefined;
  const value = typeof raw === "number" ? raw : Number.parseInt(String(raw || "0"), 10);
  return safeTimezoneOffset(value);
}

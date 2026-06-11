import { db, markInterruptedAiJobsFailed } from "../db";
import type { DeviceInfo } from "../types";
import { safeTimezoneOffset } from "./cdn";
import {
  generateDailySummary,
  generateWeeklySummary,
  getSummarySettings,
  startOfWeek,
  validDateString,
} from "./daily-summary-gen";
import { testEncryptedAiConfigFromDevice } from "./ai-config";
import { refreshSupervisionRules } from "./supervision";
import {
  cleanIdentifier,
  generatedRequestId,
  safeJsonParseObject,
} from "./mcp-contracts";

const JOB_PAYLOAD_MAX_BYTES = 96 * 1024;
const JOB_RESULT_MAX_BYTES = 96 * 1024;
const JOB_ERROR_MAX_BYTES = 4096;
const ACTIVE_STATUSES = new Set<AiJobStatus>(["queued", "running"]);
const FINISHED_STATUSES = new Set<AiJobStatus>(["succeeded", "failed"]);

export const AI_JOB_KINDS = ["daily_summary", "weekly_summary", "ai_config_test", "supervision_rules_refresh"] as const;

export type AiJobKind = typeof AI_JOB_KINDS[number];
export type AiJobStatus = "queued" | "running" | "succeeded" | "failed";
export type AiJobRunner = () => Promise<Record<string, unknown>>;
export type AiJobNotifier = (job: PublicAiJob) => void;

export interface PublicAiJob {
  request_id: string;
  kind: AiJobKind;
  job_key: string;
  device_id: string;
  status: AiJobStatus;
  result: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
}

export interface AiJobSubmitResult {
  accepted: true;
  attached: boolean;
  client_request_id: string;
  job: PublicAiJob;
}

interface AiJobRow {
  request_id: string;
  job_kind: string;
  job_key: string;
  device_id: string;
  status: AiJobStatus;
  payload: string;
  result: string;
  error: string;
  created_at: string;
  started_at: string;
  finished_at: string;
  updated_at: string;
}

class AiJobInputError extends Error {
  constructor(
    message: string,
    readonly code = "AI_JOB_INVALID_REQUEST",
    readonly status = 400,
  ) {
    super(message);
  }
}

class AiJobRunError extends Error {
  constructor(
    message: string,
    readonly code = "AI_JOB_FAILED",
    readonly retryable = true,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

const insertJobStmt = db.prepare(`
  INSERT OR IGNORE INTO ai_jobs (
    request_id,
    job_kind,
    job_key,
    device_id,
    status,
    payload,
    created_at,
    updated_at
  )
  VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)
`);

const getJobByRequestStmt = db.prepare(`
  SELECT *
  FROM ai_jobs
  WHERE request_id = ?
  LIMIT 1
`);

const getJobByKindKeyStmt = db.prepare(`
  SELECT *
  FROM ai_jobs
  WHERE job_kind = ? AND job_key = ?
  LIMIT 1
`);

const updateRunningStmt = db.prepare(`
  UPDATE ai_jobs
  SET status = 'running',
      started_at = ?,
      updated_at = ?
  WHERE request_id = ? AND status = 'queued'
`);

const updateSucceededStmt = db.prepare(`
  UPDATE ai_jobs
  SET status = 'succeeded',
      result = ?,
      error = '',
      finished_at = ?,
      updated_at = ?
  WHERE request_id = ?
`);

const updateFailedStmt = db.prepare(`
  UPDATE ai_jobs
  SET status = 'failed',
      error = ?,
      finished_at = ?,
      updated_at = ?
  WHERE request_id = ?
`);

const resetFailedStmt = db.prepare(`
  UPDATE ai_jobs
  SET status = 'queued',
      payload = ?,
      result = '',
      error = '',
      started_at = '',
      finished_at = '',
      updated_at = ?
  WHERE request_id = ? AND status = 'failed'
`);

const activeRunners = new Map<string, AiJobRunner>();
let notifier: AiJobNotifier | null = null;

export function setAiJobNotifier(next: AiJobNotifier): void {
  notifier = next;
}

export function recoverInterruptedAiJobs(): void {
  const now = new Date().toISOString();
  markInterruptedAiJobsFailed.run(jsonStringifyBounded({
    code: "AI_JOB_INTERRUPTED",
    message: "AI job was interrupted by server restart",
    retryable: true,
  }, JOB_ERROR_MAX_BYTES), now, now);
}

export function submitAiJobFromClient(
  input: unknown,
  device: DeviceInfo,
  deviceToken: string,
  runner?: AiJobRunner,
): AiJobSubmitResult {
  const body = objectRecord(input);
  const kind = normalizeAiJobKind(body.kind ?? body.job_kind);
  if (!kind) {
    throw new AiJobInputError("kind must be daily_summary, weekly_summary, ai_config_test, or supervision_rules_refresh", "AI_JOB_KIND_INVALID", 400);
  }
  const payload = objectRecord(body.payload);
  return submitAiJob({
    requestId: body.request_id,
    kind,
    payload,
    device,
    deviceToken,
    runner,
  });
}

export function submitAiJob(input: {
  requestId?: unknown;
  kind: AiJobKind;
  payload: Record<string, unknown>;
  device: DeviceInfo;
  deviceToken: string;
  runner?: AiJobRunner;
}): AiJobSubmitResult {
  const normalized = normalizeJobPayload(input.kind, input.payload, input.device);
  const payloadText = jsonStringifyBounded(normalized.payload, JOB_PAYLOAD_MAX_BYTES);
  if (!payloadText) {
    throw new AiJobInputError("AI job payload is too large", "AI_JOB_PAYLOAD_TOO_LARGE", 413);
  }

  const clientRequestId = cleanIdentifier(input.requestId) || generatedRequestId();
  let requestId = clientRequestId;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const now = new Date().toISOString();
    const insert = insertJobStmt.run(
      requestId,
      input.kind,
      normalized.jobKey,
      input.device.device_id,
      payloadText,
      now,
      now,
    );
    if (insert.changes > 0) {
      const runner = input.runner ?? defaultRunner(input.kind, normalized.payload, input.deviceToken);
      activeRunners.set(requestId, runner);
      const job = publicJob(getJobRow(requestId)!);
      notify(job);
      scheduleJobRun(requestId);
      return { accepted: true, attached: false, client_request_id: clientRequestId, job };
    }

    const byKindKey = getJobByKindKey(input.kind, normalized.jobKey);
    if (byKindKey) {
      const runner = input.runner ?? defaultRunner(input.kind, normalized.payload, input.deviceToken);
      const job = byKindKey.status === "failed"
        ? restartFailedJob(byKindKey, payloadText, runner)
        : byKindKey;
      maybeAttachRunner(job, runner);
      return {
        accepted: true,
        attached: true,
        client_request_id: clientRequestId,
        job: publicJob(job),
      };
    }

    const byRequestId = getJobRow(requestId);
    if (byRequestId) {
      requestId = generatedRequestId();
      continue;
    }
  }

  throw new AiJobInputError("Could not allocate AI job id", "AI_JOB_ID_CONFLICT", 409);
}

function restartFailedJob(row: AiJobRow, payloadText: string, runner: AiJobRunner): AiJobRow {
  const now = new Date().toISOString();
  const reset = resetFailedStmt.run(payloadText, now, row.request_id);
  const next = getJobRow(row.request_id) ?? row;
  if (reset.changes > 0) {
    activeRunners.set(row.request_id, runner);
    notify(publicJob(next));
    scheduleJobRun(row.request_id);
  }
  return next;
}

export function getAiJob(requestId: unknown): PublicAiJob | null {
  const clean = cleanIdentifier(requestId);
  if (!clean) return null;
  const row = getJobRow(clean);
  return row ? publicJob(row) : null;
}

export function isTerminalAiJobStatus(status: string): boolean {
  return FINISHED_STATUSES.has(status as AiJobStatus);
}

export function aiJobInputErrorResponse(error: unknown): { status: number; body: Record<string, unknown> } {
  if (error instanceof AiJobInputError) {
    return {
      status: error.status,
      body: { error: error.message, code: error.code },
    };
  }
  return {
    status: 500,
    body: { error: "AI job submit failed", code: "AI_JOB_SUBMIT_FAILED" },
  };
}

function maybeAttachRunner(row: AiJobRow, runner: AiJobRunner): void {
  if (!ACTIVE_STATUSES.has(row.status)) return;
  if (activeRunners.has(row.request_id)) return;
  activeRunners.set(row.request_id, runner);
  if (row.status === "queued") scheduleJobRun(row.request_id);
}

function scheduleJobRun(requestId: string): void {
  const timer = setTimeout(() => {
    void runAiJob(requestId);
  }, 0);
  timer.unref?.();
}

async function runAiJob(requestId: string): Promise<void> {
  const runner = activeRunners.get(requestId);
  if (!runner) return;
  const startedAt = new Date().toISOString();
  const running = updateRunningStmt.run(startedAt, startedAt, requestId);
  if (running.changes === 0) {
    activeRunners.delete(requestId);
    return;
  }
  notifyRow(requestId);

  try {
    const result = await runner();
    const now = new Date().toISOString();
    updateSucceededStmt.run(jsonStringifyBounded(result, JOB_RESULT_MAX_BYTES), now, now, requestId);
  } catch (error) {
    const now = new Date().toISOString();
    updateFailedStmt.run(jsonStringifyBounded(aiJobError(error), JOB_ERROR_MAX_BYTES), now, now, requestId);
  } finally {
    activeRunners.delete(requestId);
    notifyRow(requestId);
  }
}

function defaultRunner(kind: AiJobKind, payload: Record<string, unknown>, deviceToken: string): AiJobRunner {
  return async () => {
    if (kind === "daily_summary") {
      const result = await generateDailySummary({
        date: String(payload.date || ""),
        tzOffsetMinutes: numberValue(payload.tz_offset_minutes),
      });
      if (!result.ok) {
        throw new AiJobRunError(result.reason || "AI daily summary failed", result.skipped ? "AI_SUMMARY_SKIPPED" : "AI_SUMMARY_FAILED", !result.skipped, {
          skipped: result.skipped === true,
          kind: result.kind,
          date: result.date,
        });
      }
      return result as unknown as Record<string, unknown>;
    }

    if (kind === "weekly_summary") {
      const result = await generateWeeklySummary({
        weekStart: String(payload.week_start || ""),
        tzOffsetMinutes: numberValue(payload.tz_offset_minutes),
      });
      if (!result.ok) {
        throw new AiJobRunError(result.reason || "AI weekly summary failed", result.skipped ? "AI_SUMMARY_SKIPPED" : "AI_SUMMARY_FAILED", !result.skipped, {
          skipped: result.skipped === true,
          kind: result.kind,
          week_start: result.week_start,
        });
      }
      return result as unknown as Record<string, unknown>;
    }

    if (kind === "ai_config_test") {
      return await testEncryptedAiConfigFromDevice(payload, deviceToken) as unknown as Record<string, unknown>;
    }

    const settings = await refreshSupervisionRules(getSummarySettings());
    const { syncCurrentSupervisionPolicyToCapableDevices } = await import("./supervision-policy-control");
    syncCurrentSupervisionPolicyToCapableDevices(settings);
    return settings as unknown as Record<string, unknown>;
  };
}

function normalizeJobPayload(kind: AiJobKind, payload: Record<string, unknown>, device: DeviceInfo): {
  payload: Record<string, unknown>;
  jobKey: string;
} {
  if (kind === "daily_summary") {
    const date = typeof payload.date === "string" ? payload.date : "";
    if (!validDateString(date)) {
      throw new AiJobInputError("date must be YYYY-MM-DD", "AI_JOB_DATE_INVALID", 400);
    }
    const tzOffsetMinutes = timezoneOffset(payload);
    return {
      payload: { date, tz_offset_minutes: tzOffsetMinutes },
      jobKey: `daily_summary:${date}:tz=${tzOffsetMinutes}`,
    };
  }

  if (kind === "weekly_summary") {
    const rawWeekStart = typeof payload.week_start === "string" ? payload.week_start : "";
    const rawDate = typeof payload.date === "string" ? payload.date : "";
    const weekStart = validDateString(rawWeekStart)
      ? startOfWeek(rawWeekStart)
      : validDateString(rawDate)
        ? startOfWeek(rawDate)
        : "";
    if (!weekStart) {
      throw new AiJobInputError("date or week_start must be YYYY-MM-DD", "AI_JOB_WEEK_INVALID", 400);
    }
    const tzOffsetMinutes = timezoneOffset(payload);
    return {
      payload: { week_start: weekStart, tz_offset_minutes: tzOffsetMinutes },
      jobKey: `weekly_summary:${weekStart}:tz=${tzOffsetMinutes}`,
    };
  }

  if (kind === "ai_config_test") {
    const stablePayload = stableJsonStringify(payload);
    return {
      payload,
      jobKey: `ai_config_test:${device.device_id}:${sha256Hex(stablePayload)}`,
    };
  }

  const settingsUpdatedAt = cleanIdentifier(payload.settings_updated_at, 80) || cleanIdentifier(payload.updated_at, 80) || "current";
  return {
    payload: { settings_updated_at: settingsUpdatedAt },
    jobKey: `supervision_rules_refresh:${settingsUpdatedAt}`,
  };
}

function timezoneOffset(payload: Record<string, unknown>): number {
  const raw = payload.tz_offset_minutes ?? payload.tz;
  const value = typeof raw === "number" ? raw : Number.parseInt(String(raw ?? "0"), 10);
  return safeTimezoneOffset(value);
}

function normalizeAiJobKind(value: unknown): AiJobKind | null {
  if (typeof value !== "string") return null;
  return (AI_JOB_KINDS as readonly string[]).includes(value) ? value as AiJobKind : null;
}

function getJobRow(requestId: string): AiJobRow | null {
  return getJobByRequestStmt.get(requestId) as AiJobRow | null;
}

function getJobByKindKey(kind: AiJobKind, jobKey: string): AiJobRow | null {
  return getJobByKindKeyStmt.get(kind, jobKey) as AiJobRow | null;
}

function publicJob(row: AiJobRow): PublicAiJob {
  return {
    request_id: row.request_id,
    kind: normalizeAiJobKind(row.job_kind) ?? "daily_summary",
    job_key: row.job_key,
    device_id: row.device_id,
    status: row.status,
    result: row.result ? safeJsonParseObject(row.result) : null,
    error: row.error ? safeJsonParseObject(row.error) : null,
    created_at: row.created_at,
    started_at: row.started_at || null,
    finished_at: row.finished_at || null,
    updated_at: row.updated_at,
  };
}

function notifyRow(requestId: string): void {
  const row = getJobRow(requestId);
  if (row) notify(publicJob(row));
}

function notify(job: PublicAiJob): void {
  try {
    notifier?.(job);
  } catch {
    // Device sockets are best-effort; clients can still poll /api/ai-jobs.
  }
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function aiJobError(value: unknown): Record<string, unknown> {
  if (value instanceof AiJobRunError) {
    return {
      code: value.code,
      message: cleanErrorMessage(value.message),
      retryable: value.retryable,
      ...value.details,
    };
  }
  const maybe = value as { code?: unknown; status?: unknown } | null;
  const code = cleanIdentifier(typeof maybe?.code === "string" ? maybe.code : "") || "AI_JOB_FAILED";
  return {
    code,
    message: cleanErrorMessage(value instanceof Error ? value.message : String(value || "AI job failed")),
    retryable: maybe?.status !== 400 && maybe?.status !== 401 && maybe?.status !== 403 && maybe?.status !== 409,
  };
}

function cleanErrorMessage(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 300) || "AI job failed";
}

function jsonStringifyBounded(value: unknown, maxBytes: number): string {
  try {
    const text = JSON.stringify(value);
    return new TextEncoder().encode(text).byteLength <= maxBytes ? text : "";
  } catch {
    return "";
  }
}

function stableJsonStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJsonStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJsonStringify(record[key])}`).join(",")}}`;
}

function sha256Hex(value: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(value);
  return hasher.digest("hex");
}

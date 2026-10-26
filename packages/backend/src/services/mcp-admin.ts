import type { DeviceInfo } from "../types";
import {
  completeDelegatedAiJob,
  claimDelegatedAiJobs,
  getAiJob,
  submitAiJob,
  type AiJobKind,
} from "./ai-jobs";
import {
  getSummarySettings,
  setServerSummaryMode,
  updateSummarySettings,
} from "./daily-summary-gen";
import { syncCurrentSupervisionPolicyToCapableDevices } from "./supervision-policy-control";
import type { SupervisionRunSource } from "./supervision-trigger-plan";
import { hermesControllerEnabled, liveInternalAiEnabled } from "./controller-mode";
import { controllerWebhookEnabled } from "./controller-webhook";
import { controllerHealth } from "./controller-health";

const MCP_CONTROLLER_DEVICE: DeviceInfo = {
  device_id: "__mcp__",
  device_name: "MCP controller",
  platform: "windows",
};

export function getServiceSettings(): Record<string, unknown> {
  const settings = getSummarySettings();
  return {
    generated_at: new Date().toISOString(),
    controller_mode: {
      hermes_enabled: hermesControllerEnabled(),
      internal_ai_enabled: liveInternalAiEnabled(),
      webhook_enabled: controllerWebhookEnabled(),
    },
    controller_health: controllerHealth(),
    settings,
    summary_mode_control: {
      locked: true,
      source: configuredSummaryMode() ? "environment" : "server",
    },
  };
}

export function updateServiceSettings(input: Record<string, unknown>): Record<string, unknown> {
  const settings = updateSummarySettings({
    ...input,
    client_updated_at: input.client_updated_at ?? new Date().toISOString(),
  });
  const policySync = settings.sync_status === "applied"
    ? syncCurrentSupervisionPolicyToCapableDevices(settings)
    : { commands: [] };
  return {
    ok: true,
    settings,
    policy_sync: policySync,
  };
}

export function setServiceSummaryMode(input: { mode: unknown }): Record<string, unknown> {
  const envMode = configuredSummaryMode();
  const settings = setServerSummaryMode(input.mode);
  return {
    ok: true,
    applied: !envMode,
    mode_source: envMode ? "environment" : "server",
    settings,
  };
}

export function startServiceAiJob(input: {
  request_id?: unknown;
  kind: unknown;
  date?: unknown;
  week_start?: unknown;
  timezone_offset_minutes?: unknown;
  settings_updated_at?: unknown;
  force?: unknown;
  source?: unknown;
  at?: unknown;
}): Record<string, unknown> {
  if (hermesControllerEnabled()) throw new Error("hermes_controller_active");
  const kind = normalizeAiJobKind(input.kind);
  if (!kind) throw new Error("invalid_ai_job_kind");
  const payload = jobPayload(kind, input);
  return submitAiJob({
    requestId: input.request_id,
    kind,
    payload,
    device: MCP_CONTROLLER_DEVICE,
    deviceToken: "",
  }) as unknown as Record<string, unknown>;
}

export function getServiceAiJob(input: { request_id?: unknown }): Record<string, unknown> {
  const job = getAiJob(input.request_id);
  return {
    found: !!job,
    job,
  };
}

export function completeServiceAiJob(input: {
  request_id: unknown;
  claim_token: unknown;
  outcome: "succeeded" | "failed" | "skipped";
  detail?: unknown;
}): Record<string, unknown> {
  if (!hermesControllerEnabled()) throw new Error("hermes_controller_inactive");
  return {
    ok: true,
    job: completeDelegatedAiJob(input),
  };
}

export function claimServiceAiJobs(input: { owner_id: unknown; limit?: unknown }): Record<string, unknown> {
  if (!hermesControllerEnabled()) throw new Error("hermes_controller_inactive");
  return {
    ok: true,
    ...claimDelegatedAiJobs(input),
  };
}

export function runServiceSupervisionCheck(input: {
  request_id?: unknown;
  force?: boolean;
  source?: SupervisionRunSource;
  at?: unknown;
}): Record<string, unknown> {
  const at = input.at === undefined ? new Date().toISOString() : validIsoTime(input.at);
  if (!at) throw new Error("invalid_time");
  const submitted = startServiceAiJob({
    request_id: input.request_id,
    kind: "supervision_check",
    at,
    force: input.force !== false,
    source: input.source ?? "report",
  });
  return {
    ok: true,
    queued: true,
    ...submitted,
  };
}

function normalizeAiJobKind(value: unknown): AiJobKind | null {
  if (value === "daily_summary" || value === "weekly_summary" || value === "supervision_rules_refresh" || value === "supervision_check") {
    return value;
  }
  return null;
}

function jobPayload(kind: AiJobKind, input: {
  date?: unknown;
  week_start?: unknown;
  timezone_offset_minutes?: unknown;
  settings_updated_at?: unknown;
  force?: unknown;
  source?: unknown;
  at?: unknown;
}): Record<string, unknown> {
  if (kind === "daily_summary") {
    return {
      date: input.date,
      tz_offset_minutes: input.timezone_offset_minutes,
    };
  }
  if (kind === "weekly_summary") {
    return {
      week_start: input.week_start ?? input.date,
      tz_offset_minutes: input.timezone_offset_minutes,
    };
  }
  if (kind === "supervision_check") {
    const at = input.at === undefined ? new Date().toISOString() : validIsoTime(input.at);
    if (!at) throw new Error("invalid_time");
    return {
      at,
      source: input.source === "scheduled" ? "scheduled" : "report",
      force: input.force !== false,
    };
  }

  return {
    settings_updated_at: input.settings_updated_at ?? getSummarySettings().updated_at ?? "current",
  };
}

function validIsoTime(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function configuredSummaryMode(): string {
  return process.env.AI_SUMMARY_MODE?.trim() || "";
}

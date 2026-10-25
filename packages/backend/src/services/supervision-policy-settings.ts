import type { ControllerPersonaKind } from "./controller-persona";
import { normalizeWebAllowlistPolicy, type WebAllowlistPolicy } from "./web-allowlist";

export type SupervisionPolicyOwner = ControllerPersonaKind | "live_ai";

export interface SupervisionAppTimeLimit {
  app_regex: string;
  limit_minutes: number;
  reason: string;
}

export interface SupervisionPolicySettings {
  policy_owner: SupervisionPolicyOwner | null;
  strategy_reason: string;
  policy_updated_at: string | null;
  review_interval_minutes: number;
  risk_app_regex: string[];
  risk_trigger_minutes: number;
  app_time_limits: SupervisionAppTimeLimit[];
  web_allowlist: WebAllowlistPolicy;
}

export function readSupervisionPolicySettings(source: Record<string, unknown>): SupervisionPolicySettings {
  const rules = plainObject(source.supervision_rules);
  return {
    policy_owner: normalizePolicyOwner(source.supervision_policy_owner),
    strategy_reason: cleanText(source.supervision_policy_reason, 500),
    policy_updated_at: cleanTimestamp(source.supervision_policy_updated_at),
    review_interval_minutes: normalizeReviewInterval(source.supervision_check_interval_minutes, 60),
    risk_app_regex: normalizeRegexList(rules?.risk_app_regex),
    risk_trigger_minutes: normalizeMinuteThreshold(source.supervision_risk_trigger_minutes, 3),
    app_time_limits: normalizeSupervisionAppTimeLimits(source.supervision_app_time_limits),
    web_allowlist: normalizeWebAllowlistPolicy(source.supervision_web_allowlist),
  };
}

export function replaceSupervisionPolicySettings(
  input: Record<string, unknown>,
  updatedAt: string,
): SupervisionPolicySettings {
  return {
    policy_owner: normalizePolicyOwner(input.policy_owner),
    strategy_reason: cleanText(input.strategy_reason, 500),
    policy_updated_at: updatedAt,
    review_interval_minutes: normalizeReviewInterval(input.review_interval_minutes, 60),
    risk_app_regex: normalizeRegexList(input.risk_app_regex),
    risk_trigger_minutes: normalizeMinuteThreshold(input.risk_trigger_minutes, 3),
    app_time_limits: normalizeSupervisionAppTimeLimits(input.app_time_limits),
    // A complete snapshot: omitting the web allowlist clears it rather than keeping the old one.
    web_allowlist: normalizeWebAllowlistPolicy(input.web_allowlist),
  };
}

export function normalizeSupervisionAppTimeLimits(value: unknown): SupervisionAppTimeLimit[] {
  if (!Array.isArray(value)) return [];
  const out: SupervisionAppTimeLimit[] = [];
  for (const item of value) {
    const source = plainObject(item);
    if (!source) continue;
    const appRegex = normalizeRegexList([source.app_regex])[0] || "";
    if (!appRegex) continue;
    out.push({
      app_regex: appRegex,
      limit_minutes: normalizeMinuteThreshold(source.limit_minutes, 3),
      reason: cleanText(source.reason, 120),
    });
    if (out.length >= 12) break;
  }
  return out;
}

export function normalizeRegexList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const cleaned = cleanText(item, 120);
    if (cleaned && !out.includes(cleaned)) out.push(cleaned);
    if (out.length >= 12) break;
  }
  return out;
}

function normalizePolicyOwner(value: unknown): SupervisionPolicyOwner | null {
  return value === "openclaw" || value === "hermes" || value === "custom" || value === "live_ai"
    ? value
    : null;
}

function normalizeMinuteThreshold(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(55, Math.max(1, parsed));
}

function normalizeReviewInterval(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(240, Math.max(5, parsed));
}

function cleanText(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function cleanTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function plainObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

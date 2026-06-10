export const DEVICE_CAPABILITY_SCHEMA = "live_dashboard.device_capabilities.v1";
export const TIMELINE_SCHEMA = "live_dashboard.timeline.v1";
export const COMMAND_SCHEMA = "live_dashboard.device_commands.v1";

export const DELIVERY_STATUSES = ["sent", "queued", "failed", "skipped"] as const;
export const RECEIPT_STATUSES = ["received", "rejected", "missing"] as const;
export const RESULT_STATUSES = [
  "applied",
  "partial",
  "failed",
  "unsupported",
  "ignored",
  "duplicate",
  "expired",
  "timeout",
  "unknown",
] as const;

export type DeliveryStatus = typeof DELIVERY_STATUSES[number];
export type ReceiptStatus = typeof RECEIPT_STATUSES[number];
export type ResultStatus = typeof RESULT_STATUSES[number];

export type DeviceCapabilityProfile = "android_lsp" | "android_normal" | "desktop_message" | "unsupported";
export type DeviceCommandKind = "supervision" | "supervision_policy";
export type DeviceCommandCreatedBy = "mcp" | "supervision";

export interface SupervisionAppTimeLimitPayload {
  app_regex: string;
  limit_minutes: number;
  reason: string;
}

export interface DeviceCommandPayload {
  kind: DeviceCommandKind;
  freeze_commands: string[];
  unfreeze_commands: string[];
  vibrate: boolean;
  screen_off: boolean;
  say: string;
  notes: string[];
  risk_app_regex?: string[];
  risk_trigger_minutes?: number;
  app_time_limits?: SupervisionAppTimeLimitPayload[];
}

export interface DeviceCommandEnvelope {
  type: "device_command";
  v: 1;
  request_id: string;
  command_id: string;
  created_by: DeviceCommandCreatedBy;
  target_device_id: string;
  issued_at: string;
  expires_at: string;
  payload: DeviceCommandPayload;
}

const SAFE_ID_RE = /^[a-zA-Z0-9_.:-]{1,160}$/;
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/g;

export function cleanIdentifier(value: unknown, maxLength = 160): string {
  if (typeof value !== "string") return "";
  const cleaned = value.replace(CONTROL_CHARS_RE, "").trim().slice(0, maxLength);
  return SAFE_ID_RE.test(cleaned) ? cleaned : "";
}

export function cleanLooseIdentifier(value: unknown, maxLength = 160): string {
  if (typeof value !== "string") return "";
  return value.replace(CONTROL_CHARS_RE, "").trim().slice(0, maxLength);
}

export function cleanText(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "";
  return value
    .replace(CONTROL_CHARS_RE, " ")
    .replace(/[\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

export function safeJsonParseObject(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

export function safeJsonStringify(value: unknown, maxBytes = 4096): string {
  try {
    const text = JSON.stringify(value);
    return new TextEncoder().encode(text).byteLength <= maxBytes ? text : "";
  } catch {
    return "";
  }
}

export function generatedRequestId(): string {
  return `req_${crypto.randomUUID()}`;
}

export function generatedCommandId(): string {
  return `cmd_${crypto.randomUUID()}`;
}

export function generatedResultId(): string {
  return `res_${crypto.randomUUID()}`;
}

export function normalizeIsoTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

export function normalizeResultStatus(value: unknown): ResultStatus {
  if (typeof value !== "string") return "unknown";
  const normalized = value.trim().toLowerCase();
  return (RESULT_STATUSES as readonly string[]).includes(normalized)
    ? normalized as ResultStatus
    : "unknown";
}

export function normalizeReceiptStatus(value: unknown): Exclude<ReceiptStatus, "missing"> {
  return value === "rejected" ? "rejected" : "received";
}

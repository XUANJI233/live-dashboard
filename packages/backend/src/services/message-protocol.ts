export const MAX_TEXT_LENGTH = 500;
export const MAX_MESSAGE_JSON_BYTES = 32 * 1024;
export const MAX_MESSAGE_PAYLOAD_BYTES = 4096;
export const PUBLIC_MESSAGE_RECENT_HOURS = 24 * 365;
export const PUBLIC_MESSAGE_RECENT_MAX_HOURS = 24 * 365;

export type MessageKind = "public" | "private";
export type StoredMessageKind = "public" | "private" | "reply" | "public_reply";
export type MessageDirection = "viewer" | "device";

export type MessageJsonRead =
  | { ok: true; body: any }
  | { ok: false; response: Response };

export function parseJson(raw: string | Buffer): any | null {
  try {
    const text = typeof raw === "string" ? raw : raw.toString("utf8");
    if (text.length > MAX_MESSAGE_JSON_BYTES) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function cleanText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c]/g, "").trim().slice(0, MAX_TEXT_LENGTH);
}

export function cleanMessageId(value: unknown): string {
  if (typeof value !== "string") return "";
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 80);
  return /^[a-zA-Z0-9_.:-]{1,80}$/.test(cleaned) ? cleaned : "";
}

export function serializedMessagePayload(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  try {
    const text = JSON.stringify(value);
    if (new TextEncoder().encode(text).byteLength > MAX_MESSAGE_PAYLOAD_BYTES) return "";
    return text;
  } catch {
    return "";
  }
}

export function parseMessagePayload(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string" || !value.trim()) return null;
  if (new TextEncoder().encode(value).byteLength > MAX_MESSAGE_PAYLOAD_BYTES) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export async function readMessageJson(req: Request): Promise<MessageJsonRead> {
  const length = Number(req.headers.get("content-length") || 0);
  if (Number.isFinite(length) && length > MAX_MESSAGE_JSON_BYTES) {
    return { ok: false, response: Response.json({ error: "Request too large" }, { status: 413 }) };
  }
  const contentType = req.headers.get("content-type") || "";
  if (contentType && !contentType.toLowerCase().includes("application/json")) {
    return { ok: false, response: Response.json({ error: "Content-Type must be application/json" }, { status: 415 }) };
  }
  let text = "";
  try {
    text = await readLimitedText(req, MAX_MESSAGE_JSON_BYTES);
  } catch {
    return { ok: false, response: Response.json({ error: "Request too large" }, { status: 413 }) };
  }
  if (text.length > MAX_MESSAGE_JSON_BYTES) {
    return { ok: false, response: Response.json({ error: "Request too large" }, { status: 413 }) };
  }
  try {
    return { ok: true, body: JSON.parse(text) };
  } catch {
    return { ok: false, response: Response.json({ error: "Invalid JSON" }, { status: 400 }) };
  }
}

async function readLimitedText(req: Request, maxBytes: number): Promise<string> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      try { await reader.cancel(); } catch { /* ignore */ }
      throw new Error("too_large");
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return text;
}

export function cleanViewerId(value: unknown): string {
  if (typeof value !== "string") return "";
  return /^[a-zA-Z0-9_-]{3,120}$/.test(value) ? value : "";
}

export function cleanDeviceId(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 120);
}

export function cleanViewerName(value: unknown): string {
  if (typeof value !== "string") return "";
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 32);
  // Prevent visitors from impersonating admin
  if (/^(up|admin|管理员|博主|owner|root|system)$/i.test(cleaned)) return "";
  return cleaned;
}

export function cleanKind(value: unknown): MessageKind {
  return value === "public" ? "public" : "private";
}

export function publicRecentHours(value: string | null): number {
  const parsed = value ? Number.parseInt(value, 10) : PUBLIC_MESSAGE_RECENT_HOURS;
  if (!Number.isFinite(parsed)) return PUBLIC_MESSAGE_RECENT_HOURS;
  return Math.min(PUBLIC_MESSAGE_RECENT_MAX_HOURS, Math.max(1, parsed));
}

function applyCacheTags(headers: Headers, tags: string[]) {
  if (tags.length > 0) {
    const joined = tags.join(",");
    headers.set("Cache-Tag", joined);
    headers.set("ESA-Cache-Tag", joined);
  }
}

export function withCdnHeaders(response: Response, tags: string[], maxAgeSeconds: number): Response {
  const headers = new Headers(response.headers);
  applyCacheTags(headers, tags);
  // Browser and shared-cache directives are safe for direct origin traffic; browsers ignore s-maxage.
  headers.set("Cache-Control", `public, max-age=${maxAgeSeconds}, s-maxage=${maxAgeSeconds}, stale-while-revalidate=30`);
  headers.set("Expires", new Date(Date.now() + maxAgeSeconds * 1000).toUTCString());
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function noStore(response: Response, tags: string[] = []): Response {
  const headers = new Headers(response.headers);
  applyCacheTags(headers, tags);
  // Aggressive anti-cache headers — Alibaba Cloud ESA ignores bare "no-store"
  headers.set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0, s-maxage=0");
  headers.set("Pragma", "no-cache");
  headers.set("Expires", "0");
  headers.set("CDN-Cache-Control", "no-store");
  headers.set("Surrogate-Control", "no-store");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function currentHourWindow(date = new Date()): string {
  return date.toISOString().slice(0, 13).replace(/[-T:]/g, "");
}

export function normalizeHourWindow(value: string | null): string | null {
  if (!value || !/^\d{10}$/.test(value)) return null;
  return value;
}

export function windowMatchesDate(window: string, date: string): boolean {
  return window.slice(0, 8) === date.replaceAll("-", "");
}

export function hourWindowForOffset(date: Date, tzOffsetMinutes: number): string {
  const local = new Date(date.getTime() - tzOffsetMinutes * 60_000);
  return `${local.getUTCFullYear()}${String(local.getUTCMonth() + 1).padStart(2, "0")}${String(local.getUTCDate()).padStart(2, "0")}${String(local.getUTCHours()).padStart(2, "0")}`;
}

export function isLiveHourWindow(window: string, tzOffsetMinutes: number, now = new Date()): boolean {
  const current = hourWindowForOffset(now, tzOffsetMinutes);
  const previous = hourWindowForOffset(new Date(now.getTime() - 60 * 60_000), tzOffsetMinutes);
  return window === current || window === previous;
}

export function safeTimezoneOffset(value: number): number {
  return Number.isFinite(value) && Math.abs(value) <= 840 ? value : 0;
}

export function utcRangeForLocalDate(date: string, tzOffsetMinutes: number): { start: string; end: string } | null {
  const parts = date.split("-").map((part) => parseInt(part, 10));
  const [year, month, day] = parts;
  if (!year || !month || !day) return null;
  if (!validUtcParts(year, month, day)) return null;
  const startMs = Date.UTC(year, month - 1, day) + safeTimezoneOffset(tzOffsetMinutes) * 60_000;
  const endMs = startMs + 24 * 60 * 60_000;
  const start = new Date(startMs);
  const end = new Date(endMs);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  return { start: start.toISOString(), end: end.toISOString() };
}

export function utcRangeForLocalHourWindow(window: string, tzOffsetMinutes: number): { start: string; end: string } | null {
  const year = parseInt(window.slice(0, 4), 10);
  const month = parseInt(window.slice(4, 6), 10);
  const day = parseInt(window.slice(6, 8), 10);
  const hour = parseInt(window.slice(8, 10), 10);
  if (!year || !month || !day || !Number.isInteger(hour) || hour < 0 || hour > 23) return null;
  if (!validUtcParts(year, month, day, hour)) return null;
  const startMs = Date.UTC(year, month - 1, day, hour) + safeTimezoneOffset(tzOffsetMinutes) * 60_000;
  const endMs = startMs + 60 * 60_000;
  const start = new Date(startMs);
  const end = new Date(endMs);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  return { start: start.toISOString(), end: end.toISOString() };
}

function validUtcParts(year: number, month: number, day: number, hour = 0): boolean {
  const probe = new Date(Date.UTC(year, month - 1, day, hour));
  return probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day &&
    probe.getUTCHours() === hour;
}

export function currentMessageSlot(date = new Date(), slotMinutes = 10): string {
  const safeSlot = Math.max(1, Math.min(60, Math.floor(slotMinutes)));
  const roundedMinute = Math.floor(date.getUTCMinutes() / safeSlot) * safeSlot;
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hour = String(date.getUTCHours()).padStart(2, "0");
  const minute = String(roundedMinute).padStart(2, "0");
  return `${year}${month}${day}${hour}${minute}`;
}

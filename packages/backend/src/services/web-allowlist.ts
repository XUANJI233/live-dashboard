// Strict web allowlist for the Android LSP system browser: the controller-authored
// policy that Live stores and syncs, and the enforcement status the phone reports.

const MAX_DOMAINS = 64;
const MAX_WINDOWS = 14;
const MAX_PAUSED_BROWSERS = 12;
const DOMAIN_LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;
const PACKAGE_NAME = /^[A-Za-z0-9_.]{1,160}$/;

export interface WebAllowlistWindow {
  /** ISO weekdays, 1 = Monday … 7 = Sunday; empty means every day. */
  days: number[];
  start: string;
  end: string;
}

export interface WebAllowlistPolicy {
  /** A domain also allows its subdomains; an empty list disables web filtering. */
  allowed_domains: string[];
  /** Device-local windows; empty means whenever supervision is enabled. */
  active_windows: WebAllowlistWindow[];
}

export interface WebAllowlistStatus {
  active: boolean;
  paused_until: string;
  browser_package: string;
  allowed_domain_count: number;
  paused_browsers: string[];
  last_blocked_host: string;
  last_blocked_at: string;
}

export function emptyWebAllowlistPolicy(): WebAllowlistPolicy {
  return { allowed_domains: [], active_windows: [] };
}

export function normalizeWebAllowlistPolicy(value: unknown): WebAllowlistPolicy {
  const source = plainObject(value);
  if (!source) return emptyWebAllowlistPolicy();
  return {
    allowed_domains: normalizeDomains(source.allowed_domains),
    active_windows: normalizeWindows(source.active_windows),
  };
}

/** Reduce a domain, host, or URL to a lowercase host with at least two labels, or "". */
export function normalizeWebDomain(value: unknown): string {
  if (typeof value !== "string") return "";
  const host = value
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .split(/[/?#]/, 1)[0]!
    .replace(/^.*@/, "")
    .replace(/:\d+$/, "")
    .replace(/^\*\./, "")
    .replace(/^\.+|\.+$/g, "");
  if (host.length === 0 || host.length > 253) return "";
  const labels = host.split(".");
  if (labels.length < 2 || !labels.every((label) => DOMAIN_LABEL.test(label))) return "";
  return host;
}

export function cleanWebAllowlistStatus(value: unknown): WebAllowlistStatus | null {
  const source = plainObject(value);
  if (!source) return null;
  return {
    active: source.active === true,
    paused_until: cleanTimestamp(source.paused_until),
    browser_package: cleanPackageName(source.browser_package),
    allowed_domain_count: boundedInteger(source.allowed_domain_count, 0, MAX_DOMAINS),
    paused_browsers: Array.isArray(source.paused_browsers)
      ? source.paused_browsers.map(cleanPackageName).filter(Boolean).slice(0, MAX_PAUSED_BROWSERS)
      : [],
    last_blocked_host: normalizeWebDomain(source.last_blocked_host),
    last_blocked_at: cleanTimestamp(source.last_blocked_at),
  };
}

function normalizeDomains(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const domain = normalizeWebDomain(item);
    if (domain && !out.includes(domain)) out.push(domain);
    if (out.length >= MAX_DOMAINS) break;
  }
  return out;
}

function normalizeWindows(value: unknown): WebAllowlistWindow[] {
  if (!Array.isArray(value)) return [];
  const out: WebAllowlistWindow[] = [];
  for (const item of value) {
    const source = plainObject(item);
    if (!source) continue;
    const start = typeof source.start === "string" && CLOCK.test(source.start) ? source.start : "";
    const end = typeof source.end === "string" && CLOCK.test(source.end) ? source.end : "";
    // Same-day windows only; an overnight span is written as two windows.
    if (!start || !end || start >= end) continue;
    const days = Array.isArray(source.days)
      ? Array.from(new Set(source.days.filter((day): day is number => Number.isInteger(day) && day >= 1 && day <= 7)))
        .sort((left, right) => left - right)
      : [];
    out.push({ days, start, end });
    if (out.length >= MAX_WINDOWS) break;
  }
  return out;
}

function cleanPackageName(value: unknown): string {
  return typeof value === "string" && PACKAGE_NAME.test(value.trim()) ? value.trim() : "";
}

function cleanTimestamp(value: unknown): string {
  if (typeof value !== "string") return "";
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : "";
}

function boundedInteger(value: unknown, min: number, max: number): number {
  return typeof value === "number" && Number.isInteger(value) ? Math.min(max, Math.max(min, value)) : 0;
}

function plainObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * Visitor counting service.
 * A verified viewer token is preferred; IP is only the fallback identity.
 * Stale entries are cleaned up every 30 seconds.
 * Known bots/crawlers are excluded.
 *
 * Identity merge rules:
 * - A viewer token and its current IP collapse into one visitor.
 * - A later token-issued request reuses the previous IP-only entry instead of creating a second visitor.
 * - Same IP and same fingerprint naturally share one live slot.
 */

const TIMEOUT_MS = 30_000;
const MAX_ENTRIES = 10_000;
const CLEANUP_INTERVAL_MS = 30_000;

type VisitorEntry = {
  lastSeen: number;
  viewerId: string;
  ip: string;
};

const BOT_PATTERNS = [
  "bot", "crawl", "spider", "slurp", "mediapartners",
  "facebookexternalhit", "linkedinbot", "twitterbot",
  "whatsapp", "telegrambot", "discordbot", "bingpreview",
  "yandex", "baidu", "sogou", "bytespider", "applebot",
  "amazonbot", "gptbot", "claudebot", "anthropic",
  "semrush", "ahref", "mj12bot", "dotbot", "petalbot",
  "dataforseo", "headlesschrome", "phantomjs", "puppeteer",
  "lighthouse", "pagespeed", "pingdom", "uptimerobot",
];

function isBot(ua: string): boolean {
  if (!ua) return false;
  const lower = ua.toLowerCase();
  return BOT_PATTERNS.some((p) => lower.includes(p));
}

class VisitorTracker {
  private seen = new Map<string, VisitorEntry>();
  private ipIndex = new Map<string, string>();
  private viewerIndex = new Map<string, string>();
  private lastCleanup = 0;

  constructor() {
    const timer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
    timer.unref();
  }

  heartbeat(ip: string, userAgent?: string, viewerId?: string): void {
    const cleanIp = normalizeClientIp(ip);
    if (userAgent && isBot(userAgent)) return;

    const key = this.resolveIdentity(cleanIp, viewerId || "");
    if (!key) return;

    if (!this.seen.has(key) && this.seen.size >= MAX_ENTRIES) {
      this.cleanup();
      if (!this.seen.has(key) && this.seen.size >= MAX_ENTRIES) return;
    }

    const now = Date.now();
    const current = this.seen.get(key);
    const next: VisitorEntry = {
      lastSeen: now,
      viewerId: viewerId || current?.viewerId || "",
      ip: cleanIp || current?.ip || "",
    };
    this.seen.set(key, next);

    if (next.viewerId) this.viewerIndex.set(next.viewerId, key);
    if (next.ip) this.ipIndex.set(next.ip, key);
  }

  getCount(): number {
    this.cleanupThrottled();
    return this.seen.size;
  }

  private cleanupThrottled(): void {
    const now = Date.now();
    if (now - this.lastCleanup >= 5_000) {
      this.cleanup();
    }
  }

  private resolveIdentity(ip: string, viewerId: string): string {
    const viewerKey = viewerId ? this.viewerIndex.get(viewerId) || "" : "";
    const ipKey = ip ? this.ipIndex.get(ip) || "" : "";

    if (viewerKey && this.seen.has(viewerKey)) {
      if (ipKey && ipKey !== viewerKey) this.deleteKey(ipKey);
      return viewerKey;
    }

    if (ipKey && this.seen.has(ipKey)) {
      if (viewerId) {
        const entry = this.seen.get(ipKey);
        if (entry) entry.viewerId = viewerId;
        this.viewerIndex.set(viewerId, ipKey);
      }
      return ipKey;
    }

    if (viewerId) {
      const key = `viewer:${viewerId}`;
      this.viewerIndex.set(viewerId, key);
      if (ip) this.ipIndex.set(ip, key);
      return key;
    }

    if (ip) {
      const key = `ip:${ip}`;
      this.ipIndex.set(ip, key);
      return key;
    }

    return "";
  }

  private deleteKey(key: string): void {
    const entry = this.seen.get(key);
    if (!entry) return;
    this.seen.delete(key);
    if (entry.viewerId && this.viewerIndex.get(entry.viewerId) === key) {
      this.viewerIndex.delete(entry.viewerId);
    }
    if (entry.ip && this.ipIndex.get(entry.ip) === key) {
      this.ipIndex.delete(entry.ip);
    }
  }

  private cleanup(): void {
    this.lastCleanup = Date.now();
    const cutoff = this.lastCleanup - TIMEOUT_MS;
    for (const [key, entry] of this.seen) {
      if (entry.lastSeen < cutoff) {
        this.deleteKey(key);
      }
    }
  }
}

export const visitors = new VisitorTracker();

export function normalizeClientIp(value: string | null | undefined): string {
  const first = (value || "").split(",")[0]?.trim() || "";
  if (!first) return "";
  if (first.startsWith("[") && first.includes("]")) {
    return first.slice(1, first.indexOf("]"));
  }
  if (/^::ffff:\d+\.\d+\.\d+\.\d+$/.test(first)) return first.slice(7);
  const portMatch = /^(\d+\.\d+\.\d+\.\d+):\d+$/.exec(first);
  if (portMatch) return portMatch[1]!;
  return first;
}

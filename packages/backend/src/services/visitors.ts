/**
 * Visitor counting service.
 * A verified viewer token is preferred; IP is only the fallback identity.
 * Stale entries are cleaned up every 30 seconds.
 * Known bots/crawlers are excluded.
 */

const TIMEOUT_MS = 30_000; // 30s — if no heartbeat, visitor is gone
const MAX_ENTRIES = 10_000; // hard cap to prevent memory DoS
const CLEANUP_INTERVAL_MS = 30_000;

// Common bot User-Agent substrings (case-insensitive match)
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
  private seen = new Map<string, number>(); // identity → last heartbeat timestamp
  private lastCleanup = 0;

  constructor() {
    const timer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
    timer.unref(); // don't block graceful shutdown
  }

  heartbeat(ip: string, userAgent?: string, viewerId?: string): void {
    const cleanIp = normalizeClientIp(ip);
    const identity = viewerId ? `viewer:${viewerId}` : cleanIp ? `ip:${cleanIp}` : "";
    if (!identity) return;
    if (userAgent && isBot(userAgent)) return;
    // If at capacity and this is a new IP, cleanup first to evict stale entries
    if (!this.seen.has(identity) && this.seen.size >= MAX_ENTRIES) {
      this.cleanup();
      if (this.seen.size >= MAX_ENTRIES) return; // still full after cleanup
    }
    this.seen.set(identity, Date.now());
  }

  getCount(): number {
    this.cleanupThrottled();
    return this.seen.size;
  }

  /** Only run cleanup if at least 5s since last run */
  private cleanupThrottled(): void {
    const now = Date.now();
    if (now - this.lastCleanup >= 5_000) {
      this.cleanup();
    }
  }

  private cleanup(): void {
    this.lastCleanup = Date.now();
    const cutoff = this.lastCleanup - TIMEOUT_MS;
    for (const [ip, ts] of this.seen) {
      if (ts < cutoff) {
        this.seen.delete(ip);
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

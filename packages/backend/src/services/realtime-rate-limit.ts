const VIEWER_MESSAGE_RATE_LIMIT = 10;
const REALTIME_API_RATE_LIMIT = 60;
const VIEWER_WS_RATE_LIMIT = 30;
const GLOBAL_IP_RATE_LIMIT = 120; // 120 requests per minute per IP
const MAX_GLOBAL_IP_RATE_KEYS = 20_000;
const RATE_WINDOW_MS = 60_000;

interface RateEntry {
  count: number;
  resetAt: number;
}

class WindowRateLimiter {
  private readonly entries = new Map<string, RateEntry>();

  constructor(
    private readonly limit: number,
    private readonly maxKeys = Number.POSITIVE_INFINITY,
  ) {}

  allow(key: string): boolean {
    const now = Date.now();
    const current = this.entries.get(key);
    if (!current || current.resetAt <= now) {
      if (!current && this.entries.size >= this.maxKeys) {
        this.cleanup(now);
        if (this.entries.size >= this.maxKeys) return false;
      }
      this.entries.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS });
      return true;
    }
    if (current.count >= this.limit) return false;
    current.count += 1;
    return true;
  }

  cleanup(now = Date.now()): void {
    for (const [key, value] of this.entries) {
      if (value.resetAt < now) this.entries.delete(key);
    }
  }
}

const viewerMessageRate = new WindowRateLimiter(VIEWER_MESSAGE_RATE_LIMIT);
const realtimeApiRate = new WindowRateLimiter(REALTIME_API_RATE_LIMIT);
const viewerWsRate = new WindowRateLimiter(VIEWER_WS_RATE_LIMIT);
const globalIpRate = new WindowRateLimiter(GLOBAL_IP_RATE_LIMIT, MAX_GLOBAL_IP_RATE_KEYS);

// Evict expired keys so long-running servers do not retain idle visitor/IP entries.
const rateCleanupTimer = setInterval(() => {
  const now = Date.now();
  viewerMessageRate.cleanup(now);
  realtimeApiRate.cleanup(now);
  viewerWsRate.cleanup(now);
  globalIpRate.cleanup(now);
}, 300_000);
rateCleanupTimer.unref();

export function requestIp(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return req.headers.get("ali-real-client-ip") ||
    req.headers.get("x-real-ip") ||
    req.headers.get("cf-connecting-ip") ||
    forwarded ||
    "unknown";
}

export function globalIpRateLimit(ip: string): boolean {
  return globalIpRate.allow(ip);
}

export function viewerMessageRateLimit(viewerId: string): boolean {
  return viewerMessageRate.allow(viewerId);
}

export function realtimeApiRateLimit(clientId: string): boolean {
  return realtimeApiRate.allow(clientId);
}

export function viewerWsRateLimit(viewerId: string): boolean {
  return viewerWsRate.allow(viewerId);
}

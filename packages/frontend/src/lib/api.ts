import { ensureViewerToken, getCachedViewerToken } from "@/lib/viewer-token";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || "";

export interface DeviceState {
  device_id: string;
  device_name: string;
  platform: string;
  app_id: string;
  app_name: string;
  window_title?: string;
  display_title?: string;
  last_seen_at: string;
  is_online: number;
  extra?: {
    battery_percent?: number;
    battery_charging?: boolean;
    sleeping?: boolean;
    device?: {
      network_connected?: boolean;
      network_type?: string;
      cellular_generation?: string;
      vpn_active?: boolean;
      vpn_name?: string;
      capability_mode?: "normal" | "root" | "lsposed";
      uploader?: "normal" | "root" | "lsposed";
      device_kind?: string;
      window_mode?: string;
      last_sample_at?: string;
      relay_mode?: string;
      energy_policy?: string;
      min_interval_ms?: number;
    };
    foreground?: {
      package_name?: string;
      app_name?: string;
      activity?: string;
      title?: string;
      source?: string;
      confidence?: number;
    };
    media?: {
      playing?: boolean;
      title?: string;
      artist?: string;
      app?: string;
      package_name?: string;
      state?: string;
      source?: string;
    };
    music?: {
      title?: string;
      artist?: string;
      app?: string;
    };
    location?: {
      latitude?: number;
      longitude?: number;
      accuracy_m?: number;
      provider?: string;
      recorded_at?: string;
    };
    input?: {
      input_active?: boolean;
      is_typing?: boolean;
      source?: string;
    };
  };
}

export interface ActivityRecord {
  id: number;
  device_id: string;
  device_name: string;
  platform: string;
  app_id: string;
  app_name: string;
  window_title?: string;
  display_title?: string;
  started_at: string;
}

export interface TimelineSegment {
  app_name: string;
  app_id: string;
  display_title?: string;
  started_at: string;
  ended_at: string | null;
  duration_seconds: number;
  duration_minutes: number;
  device_id: string;
  device_name: string;
}

export interface CurrentResponse {
  devices: DeviceState[];
  recent_activities: ActivityRecord[];
  server_time: string;
  viewer_count: number;
}

export interface TimelineResponse {
  date: string;
  window?: string | null;
  segments: TimelineSegment[];
  summary: Record<string, Record<string, number>>;
}

export async function fetchCurrent(signal?: AbortSignal): Promise<CurrentResponse> {
  let token = getCachedViewerToken();
  if (!token && typeof window !== "undefined") {
    try {
      token = (await ensureViewerToken()).token;
    } catch {
      token = null;
    }
  }
  const suffix = token ? `?viewer_token=${encodeURIComponent(token)}` : "";
  const res = await fetch(`${API_BASE}/api/current${suffix}`, { signal, cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function fetchTimeline(date: string, signal?: AbortSignal): Promise<TimelineResponse> {
  if (isTodayForClientTimezone(date)) {
    try {
      const windows = clientHourWindowsForDate(date);
      const parts = await mapWithConcurrency(windows, 4, (window) => fetchTimelineWindow(date, window, signal));
      return mergeTimelineResponses(date, parts);
    } catch {
      // If an edge/runtime does not understand windowed reads yet, fall back to
      // the legacy full-day endpoint so the page still renders.
    }
  }

  const tz = new Date().getTimezoneOffset(); // e.g. -480 for UTC+8
  const url = `${API_BASE}/api/timeline?date=${encodeURIComponent(date)}&tz=${tz}`;
  const res = await fetch(url, { signal, cache: isTodayForClientTimezone(date) ? "no-store" : "default" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchTimelineWindow(date: string, window: string, signal?: AbortSignal): Promise<TimelineResponse> {
  const tz = new Date().getTimezoneOffset();
  const url = `${API_BASE}/api/timeline?date=${encodeURIComponent(date)}&tz=${tz}&window=${window}`;
  const res = await fetch(url, { signal, cache: isLiveClientWindow(window) ? "no-store" : "default" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function mergeTimelineResponses(date: string, parts: TimelineResponse[]): TimelineResponse {
  const seen = new Set<string>();
  const segments: TimelineSegment[] = [];
  const summary: Record<string, Record<string, number>> = {};

  for (const part of parts) {
    for (const seg of part.segments || []) {
      const key = `${seg.device_id}|${seg.app_id}|${seg.app_name}|${seg.display_title || ""}|${seg.started_at}`;
      if (seen.has(key)) continue;
      seen.add(key);
      segments.push(seg);
      const deviceSummary = summary[seg.device_id] || {};
      deviceSummary[seg.app_name] = (deviceSummary[seg.app_name] || 0) + (seg.duration_minutes || 0);
      summary[seg.device_id] = deviceSummary;
    }
  }

  segments.sort((a, b) => new Date(a.started_at).getTime() - new Date(b.started_at).getTime());
  return { date, window: null, segments, summary };
}

function isTodayForClientTimezone(date: string): boolean {
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  return date === today;
}

function clientHourWindowsForDate(date: string): string[] {
  const now = new Date();
  const [year, month, day] = date.split("-").map((v) => Number(v));
  if (!year || !month || !day) return [];
  const lastHour = isTodayForClientTimezone(date) ? now.getHours() : 23;
  const windows: string[] = [];
  for (let hour = 0; hour <= lastHour; hour += 1) {
    windows.push(`${year}${String(month).padStart(2, "0")}${String(day).padStart(2, "0")}${String(hour).padStart(2, "0")}`);
  }
  return windows;
}

function isLiveClientWindow(window: string): boolean {
  const now = new Date();
  const current = clientHourWindow(now);
  const previous = clientHourWindow(new Date(now.getTime() - 60 * 60_000));
  return window === current || window === previous;
}

function clientHourWindow(date: Date): string {
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}${String(date.getHours()).padStart(2, "0")}`;
}

// Health data types
export interface HealthRecord {
  device_id: string;
  type: string;
  value: number;
  unit: string;
  recorded_at: string;
  end_time: string;
}

export interface HealthDataResponse {
  date: string;
  window?: string | null;
  summary?: boolean;
  records: HealthRecord[];
}

// Site config
export interface SiteConfig {
  displayName: string;
  siteTitle: string;
  siteDescription: string;
  siteFavicon: string;
  nsfwFilterEnabled: boolean;
}

const defaultConfig: SiteConfig = {
  displayName: "Monika",
  siteTitle: "Monika 现在在做什么",
  siteDescription: "轻轻看一眼 Monika 此刻的动态",
  siteFavicon: "/icon.svg",
  nsfwFilterEnabled: true,
};

export { defaultConfig };

function isValidFaviconUrl(url: string): boolean {
  if (url.startsWith("/") && !url.startsWith("//")) return true;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function normalizeFaviconUrl(url: unknown): string {
  if (typeof url !== "string" || !isValidFaviconUrl(url)) return defaultConfig.siteFavicon;
  const trimmed = url.trim();
  return trimmed === "/favicon.ico" ? defaultConfig.siteFavicon : trimmed;
}

export async function fetchConfig(signal?: AbortSignal): Promise<SiteConfig> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  if (signal?.aborted) { clearTimeout(timeout); return defaultConfig; }
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const res = await fetch(`${API_BASE}/api/config`, { signal: controller.signal });
    if (!res.ok) return defaultConfig;
    const data = await res.json();
    const favicon = normalizeFaviconUrl(data.siteFavicon);
    return {
      displayName: typeof data.displayName === "string" ? data.displayName : defaultConfig.displayName,
      siteTitle: typeof data.siteTitle === "string" ? data.siteTitle : defaultConfig.siteTitle,
      siteDescription: typeof data.siteDescription === "string" ? data.siteDescription : defaultConfig.siteDescription,
      siteFavicon: favicon,
      nsfwFilterEnabled: typeof data.nsfwFilterEnabled === "boolean" ? data.nsfwFilterEnabled : defaultConfig.nsfwFilterEnabled,
    };
  } catch {
    return defaultConfig;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
  }
}

export async function fetchHealthData(
  date: string,
  signal?: AbortSignal,
  deviceId?: string,
  options?: { summary?: boolean },
): Promise<HealthDataResponse> {
  const viewerToken = getCachedViewerToken() || (typeof window !== "undefined" ? (await ensureViewerToken()).token : null);
  if (!options?.summary && isTodayForClientTimezone(date)) {
    try {
      const windows = clientHourWindowsForDate(date);
      const parts = await mapWithConcurrency(windows, 4, (window) => fetchHealthDataWindow(date, window, viewerToken, signal, deviceId));
      return mergeHealthDataResponses(date, parts);
    } catch (error) {
      if (signal?.aborted) throw error;
      // Fall back to the full-day endpoint if a deployment has not picked up
      // windowed health reads yet.
    }
  }
  return fetchHealthDataRequest(date, viewerToken, signal, deviceId, options);
}

async function fetchHealthDataWindow(
  date: string,
  window: string,
  viewerToken: string | null,
  signal?: AbortSignal,
  deviceId?: string,
): Promise<HealthDataResponse> {
  return fetchHealthDataRequest(date, viewerToken, signal, deviceId, undefined, window);
}

async function fetchHealthDataRequest(
  date: string,
  viewerToken: string | null,
  signal?: AbortSignal,
  deviceId?: string,
  options?: { summary?: boolean },
  window?: string,
): Promise<HealthDataResponse> {
  const tz = new Date().getTimezoneOffset();
  let url = `${API_BASE}/api/health-data?date=${encodeURIComponent(date)}&tz=${tz}`;
  if (deviceId) url += `&device_id=${encodeURIComponent(deviceId)}`;
  if (options?.summary) url += "&summary=1";
  if (window) url += `&window=${encodeURIComponent(window)}`;
  if (viewerToken) url += `&viewer_token=${encodeURIComponent(viewerToken)}`;
  const res = await fetch(url, { signal, cache: window && !isLiveClientWindow(window) ? "default" : isTodayForClientTimezone(date) ? "no-store" : "default" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function mergeHealthDataResponses(date: string, parts: HealthDataResponse[]): HealthDataResponse {
  const seen = new Set<string>();
  const records: HealthRecord[] = [];
  for (const part of parts) {
    for (const record of part.records || []) {
      const key = `${record.device_id}|${record.type}|${record.recorded_at}|${record.end_time}|${record.value}|${record.unit}`;
      if (seen.has(key)) continue;
      seen.add(key);
      records.push(record);
    }
  }
  records.sort((a, b) => Date.parse(a.recorded_at) - Date.parse(b.recorded_at));
  return { date, window: null, summary: false, records };
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const limit = Math.max(1, Math.min(Math.floor(concurrency), items.length || 1));
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index]!, index);
    }
  }

  await Promise.all(Array.from({ length: limit }, () => worker()));
  return results;
}

export function getRealtimeUrl(viewerToken?: string): string {
  const base = API_BASE || (typeof window !== "undefined" ? window.location.origin : "");
  const url = new URL("/api/ws?role=viewer", base || "http://localhost");
  if (viewerToken) url.searchParams.set("viewer_token", viewerToken);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

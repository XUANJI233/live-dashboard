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
    device?: {
      network_connected?: boolean;
      network_type?: string;
      cellular_generation?: string;
      vpn_active?: boolean;
      vpn_name?: string;
      capability_mode?: "normal" | "root" | "lsposed";
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
  segments: TimelineSegment[];
  summary: Record<string, Record<string, number>>;
}

export async function fetchCurrent(signal?: AbortSignal): Promise<CurrentResponse> {
  const res = await fetch(`${API_BASE}/api/current`, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function fetchTimeline(date: string, signal?: AbortSignal): Promise<TimelineResponse> {
  const tz = new Date().getTimezoneOffset(); // e.g. -480 for UTC+8
  const url = `${API_BASE}/api/timeline?date=${encodeURIComponent(date)}&tz=${tz}`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
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
  records: HealthRecord[];
}

// Site config
export interface SiteConfig {
  displayName: string;
  siteTitle: string;
  siteDescription: string;
  siteFavicon: string;
}

const defaultConfig: SiteConfig = {
  displayName: "Monika",
  siteTitle: "Monika 现在在做什么",
  siteDescription: "轻轻看一眼 Monika 此刻的动态",
  siteFavicon: "/favicon.ico",
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
    const favicon = typeof data.siteFavicon === "string" && isValidFaviconUrl(data.siteFavicon)
      ? data.siteFavicon : defaultConfig.siteFavicon;
    return {
      displayName: typeof data.displayName === "string" ? data.displayName : defaultConfig.displayName,
      siteTitle: typeof data.siteTitle === "string" ? data.siteTitle : defaultConfig.siteTitle,
      siteDescription: typeof data.siteDescription === "string" ? data.siteDescription : defaultConfig.siteDescription,
      siteFavicon: favicon,
    };
  } catch {
    return defaultConfig;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
  }
}

export async function fetchHealthData(date: string, signal?: AbortSignal, deviceId?: string): Promise<HealthDataResponse> {
  const tz = new Date().getTimezoneOffset();
  let url = `${API_BASE}/api/health-data?date=${encodeURIComponent(date)}&tz=${tz}`;
  if (deviceId) url += `&device_id=${encodeURIComponent(deviceId)}`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export function getRealtimeUrl(viewerToken?: string): string {
  const base = API_BASE || (typeof window !== "undefined" ? window.location.origin : "");
  const url = new URL("/api/ws?role=viewer", base || "http://localhost");
  if (viewerToken) url.searchParams.set("viewer_token", viewerToken);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

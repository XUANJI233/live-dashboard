import { getAllDeviceStates, getRecentActivities } from "../db";
import type { DeviceState, ActivityRecord } from "../types";
import { visitors } from "../services/visitors";
import { edgeViewerIdentity, verifyViewerToken, viewerTokenFromRequest } from "../services/viewer-auth";

const CURRENT_SNAPSHOT_TTL_MS = 2_000;
const ANON_CURRENT_WINDOW_MS = 60_000;
const ANON_CURRENT_LIMIT = 240;
const MAX_ANON_CURRENT_KEYS = 20_000;

let currentSnapshotCache:
  | {
      expiresAt: number;
      devices: ReturnType<typeof preparePublicDevices>;
      recentActivities: ReturnType<typeof stripWindowTitle<ActivityRecord>>;
    }
  | null = null;

const anonymousCurrentRate = new Map<string, { count: number; resetAt: number }>();

setInterval(() => {
  cleanupAnonymousCurrentRate(Date.now());
}, 300_000).unref();

function preparePublicDevices(devices: DeviceState[]) {
  return devices.map(({ window_title, extra, ...rest }) => {
    let parsedExtra: Record<string, unknown> = {};
    try {
      parsedExtra = extra ? JSON.parse(extra) : {};
    } catch {
      // Malformed JSON is ignored for the public snapshot.
    }
    if (parsedExtra.foreground && typeof parsedExtra.foreground === "object" && !Array.isArray(parsedExtra.foreground)) {
      const foreground = { ...(parsedExtra.foreground as Record<string, unknown>) };
      delete foreground.title;
      parsedExtra = { ...parsedExtra, foreground };
    }
    return { ...rest, extra: parsedExtra };
  });
}

function stripWindowTitle<T extends { window_title?: string }>(
  records: T[]
): Omit<T, "window_title">[] {
  return records.map(({ window_title, ...rest }) => rest);
}

function getSnapshot() {
  const now = Date.now();
  if (currentSnapshotCache && currentSnapshotCache.expiresAt > now) {
    return currentSnapshotCache;
  }

  currentSnapshotCache = {
    expiresAt: now + CURRENT_SNAPSHOT_TTL_MS,
    devices: preparePublicDevices(getAllDeviceStates.all() as DeviceState[]),
    recentActivities: stripWindowTitle(getRecentActivities.all() as ActivityRecord[]),
  };
  return currentSnapshotCache;
}

function allowAnonymousCurrent(ip: string): boolean {
  if (!ip) return true;
  const now = Date.now();
  const current = anonymousCurrentRate.get(ip);
  if (!current || current.resetAt <= now) {
    if (!current && anonymousCurrentRate.size >= MAX_ANON_CURRENT_KEYS) {
      cleanupAnonymousCurrentRate(now);
      if (anonymousCurrentRate.size >= MAX_ANON_CURRENT_KEYS) return false;
    }
    anonymousCurrentRate.set(ip, { count: 1, resetAt: now + ANON_CURRENT_WINDOW_MS });
    return true;
  }
  if (current.count >= ANON_CURRENT_LIMIT) return false;
  current.count += 1;
  return true;
}

function cleanupAnonymousCurrentRate(now: number): void {
  for (const [ip, entry] of anonymousCurrentRate) {
    if (entry.resetAt < now) anonymousCurrentRate.delete(ip);
  }
}

export function handleCurrent(req: Request, clientIp: string, userAgent?: string): Response {
  const viewer = edgeViewerIdentity(req) || verifyViewerToken(viewerTokenFromRequest(req));
  if (!viewer && !allowAnonymousCurrent(clientIp)) {
    return Response.json({ error: "Rate limit exceeded" }, { status: 429 });
  }
  visitors.heartbeat(clientIp, userAgent, viewer?.viewerId);

  const snapshot = getSnapshot();

  return Response.json({
    devices: snapshot.devices,
    recent_activities: snapshot.recentActivities,
    server_time: new Date().toISOString(),
    viewer_count: visitors.getCount(),
  });
}

import { getAllDeviceStates, getRecentActivities } from "../db";
import type { DeviceState, ActivityRecord } from "../types";
import { visitors } from "../services/visitors";
import { edgeViewerIdentity, verifyViewerToken, viewerTokenFromRequest } from "../services/viewer-auth";

const CURRENT_SNAPSHOT_TTL_MS = 2_000;

let currentSnapshotCache:
  | {
      expiresAt: number;
      devices: ReturnType<typeof preparePublicDevices>;
      recentActivities: ReturnType<typeof stripWindowTitle<ActivityRecord>>;
    }
  | null = null;

// Prepare records for public API: strip window_title, parse extra JSON
function preparePublicDevices(devices: DeviceState[]) {
  return devices.map(({ window_title, extra, ...rest }) => {
    let parsedExtra: Record<string, unknown> = {};
    try {
      parsedExtra = extra ? JSON.parse(extra) : {};
    } catch {
      // Malformed JSON — ignore
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

  const devices = preparePublicDevices(getAllDeviceStates.all() as DeviceState[]);
  const recentActivities = stripWindowTitle(getRecentActivities.all() as ActivityRecord[]);
  currentSnapshotCache = {
    expiresAt: now + CURRENT_SNAPSHOT_TTL_MS,
    devices,
    recentActivities,
  };
  return currentSnapshotCache;
}

export function handleCurrent(req: Request, clientIp: string, userAgent?: string): Response {
  const viewer = edgeViewerIdentity(req) || verifyViewerToken(viewerTokenFromRequest(req), clientIp);
  visitors.heartbeat(clientIp, userAgent, viewer?.viewerId);

  const snapshot = getSnapshot();

  return Response.json({
    devices: snapshot.devices,
    recent_activities: snapshot.recentActivities,
    server_time: new Date().toISOString(),
    viewer_count: visitors.getCount(),
  });
}

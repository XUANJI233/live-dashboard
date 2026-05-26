import { getAllDeviceStates, getRecentActivities } from "../db";
import type { DeviceState, ActivityRecord } from "../types";
import { visitors } from "../services/visitors";

// Prepare records for public API: expose live state, parse extra JSON
function preparePublicDevices(devices: DeviceState[]) {
  return devices.map(({ extra, ...rest }) => {
    let parsedExtra: Record<string, unknown> = {};
    try {
      parsedExtra = extra ? JSON.parse(extra) : {};
    } catch {
      // Malformed JSON — ignore
    }
    return { ...rest, extra: parsedExtra };
  });
}

export function handleCurrent(clientIp: string, userAgent?: string): Response {
  visitors.heartbeat(clientIp, userAgent);

  const devices = getAllDeviceStates.all() as DeviceState[];
  const recentActivities = getRecentActivities.all() as ActivityRecord[];

  return Response.json({
    devices: preparePublicDevices(devices),
    recent_activities: recentActivities,
    server_time: new Date().toISOString(),
    viewer_count: visitors.getCount(),
  });
}

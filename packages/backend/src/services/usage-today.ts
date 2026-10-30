import { localDayStartMs } from "./controller-timezone";
import { localDateStringForOffset } from "./prompt-time";
import type { CompiledSupervisionRules } from "./supervision-patterns";
import { buildUsageDigest, loadUsageSegments, type UsageClass, type UsageDigestApp } from "./usage-digest";

export const USAGE_TODAY_SCHEMA = "live_dashboard.usage_today.v1";

export interface UsageTodayDevice {
  device_id: string;
  active_minutes: number;
  idle_minutes: number;
  class_minutes: Record<UsageClass, number>;
  top_apps: UsageDigestApp[];
}

export interface UsageToday {
  schema: typeof USAGE_TODAY_SCHEMA;
  date: string;
  range: { start: string; end: string };
  available_device_count: number;
  devices: UsageTodayDevice[];
}

/**
 * Running totals for the local calendar day so far, so frequent wakes that only see the last
 * hour still know how the day has gone. Same engine and classes as the usage digest.
 */
export function loadUsageToday(options: {
  tzOffsetMinutes: number;
  rules: CompiledSupervisionRules;
  preferDeviceId?: string;
  now?: Date;
}): UsageToday {
  const now = options.now ?? new Date();
  const range = {
    start: new Date(localDayStartMs(now.getTime(), options.tzOffsetMinutes)).toISOString(),
    end: now.toISOString(),
  };
  const digest = buildUsageDigest(loadUsageSegments(range.start, range.end, now), options.rules, {
    ...range,
    preferDeviceId: options.preferDeviceId,
  });
  return {
    schema: USAGE_TODAY_SCHEMA,
    date: localDateStringForOffset(now, options.tzOffsetMinutes),
    range,
    available_device_count: digest.available_device_count,
    devices: digest.devices.map((device) => ({
      device_id: device.device_id,
      active_minutes: device.active_minutes,
      idle_minutes: device.idle_minutes,
      class_minutes: device.class_minutes,
      top_apps: device.top_apps,
    })),
  };
}

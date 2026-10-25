import { safeTimezoneOffset, utcRangeForLocalDate } from "./cdn";
import { getControllerMemoryFeed } from "./controller-memory";
import { getControllerPersona } from "./controller-persona";
import { controllerRestState, listDeviceContexts, getTimelineContext, type DeviceContext } from "./device-context";
import {
  addDays,
  getSummarySettings,
  startOfWeek,
  validDateString,
} from "./daily-summary-gen";
import { hermesControllerEnabled } from "./controller-mode";
import { fitControllerContextToMcpBudget } from "./controller-context-budget";
import { compileSupervisionRules } from "./supervision-patterns";
import { loadUsageDigest } from "./usage-digest";

export type ControllerContextMode = "supervision" | "companion" | "followup" | "memory" | "policy" | "daily" | "weekly";

const MAX_CONTEXT_DEVICES = 12;
const MAX_CONTEXT_FROZEN_PACKAGES = 6;
// Frequent wakes read the whole-window usage digest first and keep only the newest
// timeline segments; Hermes fetches older detail with get_device_timeline when needed.
const RECENT_ONLY_MODES = new Set<ControllerContextMode>(["supervision", "companion", "followup"]);
const RECENT_TIMELINE_SEGMENTS = 8;

export function getControllerContext(input: {
  mode: ControllerContextMode;
  date?: string;
  week_start?: string;
  timezone_offset_minutes?: number;
  device_id?: string;
  window_minutes?: number;
}): Record<string, unknown> {
  const settings = getSummarySettings();
  const timezoneOffset = safeTimezoneOffset(
    input.timezone_offset_minutes ?? settings.timezone_offset_minutes ?? -480,
  );
  const range = contextRange(input, timezoneOffset, settings.supervision_check_interval_minutes);
  const allDevices = listDeviceContexts();
  const truncatedSections = new Set<string>();
  const devices = selectContextDevices(allDevices, input.device_id).map((device) => {
    const frozenPackages = device.frozen_packages.slice(0, MAX_CONTEXT_FROZEN_PACKAGES);
    if (frozenPackages.length < device.frozen_packages.length) {
      truncatedSections.add("devices.frozen_packages");
    }
    return {
      ...device,
      frozen_packages: frozenPackages,
      frozen_packages_count: device.frozen_packages.length,
      frozen_packages_returned_count: frozenPackages.length,
      frozen_packages_truncated: frozenPackages.length < device.frozen_packages.length,
    };
  });
  if (devices.length < allDevices.length) truncatedSections.add("devices");

  const usageDigest = loadUsageDigest({
    start: range.start,
    end: range.end,
    rules: compileSupervisionRules(settings.supervision_rules),
    preferDeviceId: input.device_id,
  });
  if (usageDigest.truncated) truncatedSections.add("usage_digest");

  const recentOnly = RECENT_ONLY_MODES.has(input.mode);
  const timeline = getTimelineContext({
    start: range.start,
    end: range.end,
    deviceId: input.device_id,
    limit: recentOnly ? RECENT_TIMELINE_SEGMENTS : input.mode === "daily" || input.mode === "weekly" ? 96 : 40,
    timezoneOffsetMinutes: timezoneOffset,
  });
  Object.assign(timeline, {
    prebudget_segment_count: timeline.segment_count,
    returned_segment_count: timeline.segment_count,
    recent_only: recentOnly,
  });
  // A recent-only timeline is complete by design: the digest covers the whole window.
  if (timeline.truncated && !recentOnly) truncatedSections.add("timeline");

  const recentEvents = getControllerMemoryFeed({
    limit: input.mode === "memory" ? 40 : 24,
    include_messages: true,
    include_summaries: true,
    include_device_commands: input.mode === "supervision" || input.mode === "policy",
  });
  const recentEventCount = Array.isArray(recentEvents.events) ? recentEvents.events.length : 0;
  Object.assign(recentEvents, {
    prebudget_event_count: recentEventCount,
    returned_event_count: recentEventCount,
  });
  if (recentEvents.has_more === true) truncatedSections.add("recent_events");

  return fitControllerContextToMcpBudget({
    schema: "live_dashboard.controller_context.v1",
    generated_at: new Date().toISOString(),
    mode: input.mode,
    controller_active: hermesControllerEnabled(),
    settings,
    persona: { ...getControllerPersona() },
    rest_state: controllerRestState(allDevices),
    available_device_count: allDevices.length,
    returned_device_count: devices.length,
    devices,
    usage_digest: usageDigest,
    timeline,
    recent_events: recentEvents,
  }, truncatedSections);
}

function selectContextDevices(devices: DeviceContext[], requestedDeviceId?: string): DeviceContext[] {
  if (!requestedDeviceId) return devices.slice(0, MAX_CONTEXT_DEVICES);
  const requested = devices.find((device) => device.device_id === requestedDeviceId);
  if (!requested) return devices.slice(0, MAX_CONTEXT_DEVICES);
  return [requested, ...devices.filter((device) => device !== requested)].slice(0, MAX_CONTEXT_DEVICES);
}

function contextRange(
  input: {
    mode: ControllerContextMode;
    date?: string;
    week_start?: string;
    window_minutes?: number;
  },
  timezoneOffset: number,
  reviewIntervalMinutes: number,
): { start: string; end: string } {
  if (input.mode === "daily") {
    const date = validDateString(input.date) ? input.date! : localDate(new Date(), timezoneOffset);
    const range = utcRangeForLocalDate(date, timezoneOffset);
    if (range) return range;
  }
  if (input.mode === "weekly") {
    const date = validDateString(input.week_start)
      ? startOfWeek(input.week_start!)
      : startOfWeek(localDate(new Date(), timezoneOffset));
    const start = utcRangeForLocalDate(date, timezoneOffset);
    const end = utcRangeForLocalDate(addDays(date, 7), timezoneOffset);
    if (start && end) return { start: start.start, end: end.start };
  }
  const end = new Date();
  const requested = Number.isInteger(input.window_minutes) ? input.window_minutes! : Math.max(60, reviewIntervalMinutes);
  const minutes = Math.min(24 * 60, Math.max(15, requested));
  return {
    start: new Date(end.getTime() - minutes * 60_000).toISOString(),
    end: end.toISOString(),
  };
}

function localDate(now: Date, timezoneOffset: number): string {
  return new Date(now.getTime() - timezoneOffset * 60_000).toISOString().slice(0, 10);
}

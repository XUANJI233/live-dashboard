import type { ActivityRecord, DeviceState, TimelineSegment } from "../types";
import { db } from "../db";
import { buildTimelineSegments } from "../routes/timeline";
import { safeTimezoneOffset } from "./cdn";
import { buildTimelinePromptDocument } from "./timeline-prompt";
import {
  DEVICE_CAPABILITY_SCHEMA,
  INSTALLED_APPS_SCHEMA,
  TIMELINE_SCHEMA,
  cleanLooseIdentifier,
  cleanText,
  safeJsonParseObject,
  type DeviceCapabilityProfile,
} from "./mcp-contracts";

const MAX_TIMELINE_RANGE_DAYS = 14;
const MAX_TIMELINE_SEGMENTS = 240;
const MAX_FROZEN_ITEMS = 80;
const MAX_INSTALLED_APPS = 512;

const getDeviceStatesStmt = db.prepare(`
  SELECT *
  FROM device_states
  ORDER BY last_seen_at DESC
  LIMIT 100
`);

const getDeviceStateStmt = db.prepare(`
  SELECT *
  FROM device_states
  WHERE device_id = ?
  LIMIT 1
`);

const getActivitiesForRangeStmt = db.prepare(`
  SELECT *
  FROM activities
  WHERE started_at >= ? AND started_at < ?
  ORDER BY started_at ASC
`);

const getDeviceActivitiesForRangeStmt = db.prepare(`
  SELECT *
  FROM activities
  WHERE device_id = ? AND started_at >= ? AND started_at < ?
  ORDER BY started_at ASC
`);

export interface DeviceCapability {
  schema: typeof DEVICE_CAPABILITY_SCHEMA;
  profile: DeviceCapabilityProfile;
  capabilities: DeviceCapabilityFlags;
  source: string;
}

export interface DeviceCapabilityFlags {
  freeze: boolean;
  unfreeze: boolean;
  vibrate: boolean;
  screen_off: boolean;
  say: boolean;
  risk_app_monitor: boolean;
  app_time_limit: boolean;
}

export interface FrozenPackageItem {
  package_name: string;
  app_name: string;
  mode: string;
  reason: string;
  since: string;
  until: string;
}

export interface InstalledAppItem {
  package_name: string;
  app_name: string;
}

export interface DeviceContext {
  device_id: string;
  device_name: string;
  platform: string;
  is_online: boolean;
  last_seen_at: string;
  current_app: {
    app_id: string;
    app_name: string;
    display_title: string;
  };
  capability: DeviceCapability;
  frozen_packages: FrozenPackageItem[];
  installed_apps_count: number;
  installed_apps_updated_at: string;
}

export function listDeviceContexts(): DeviceContext[] {
  return (getDeviceStatesStmt.all() as DeviceState[]).map(deviceContextFromRow);
}

export function getDeviceContext(deviceId: string): DeviceContext | null {
  const row = getDeviceStateStmt.get(deviceId) as DeviceState | null;
  return row ? deviceContextFromRow(row) : null;
}

export function getDeviceFrozenList(deviceId: string): {
  schema: string;
  device_id: string;
  found: boolean;
  frozen_packages: FrozenPackageItem[];
} {
  const device = getDeviceContext(deviceId);
  return {
    schema: `${DEVICE_CAPABILITY_SCHEMA}.frozen_packages`,
    device_id: deviceId,
    found: !!device,
    frozen_packages: device?.frozen_packages ?? [],
  };
}

export function getDeviceInstalledApps(deviceId: string): {
  schema: typeof INSTALLED_APPS_SCHEMA;
  device_id: string;
  found: boolean;
  app_count: number;
  updated_at: string;
  installed_apps: InstalledAppItem[];
} {
  const device = getDeviceContext(deviceId);
  const row = device ? getDeviceStateStmt.get(device.device_id) as DeviceState | null : null;
  const extra = safeJsonParseObject(row?.extra);
  const deviceExtra = objectField(extra, "device");
  const installedApps = installedAppItems(deviceExtra.installed_apps);
  return {
    schema: INSTALLED_APPS_SCHEMA,
    device_id: deviceId,
    found: !!device,
    app_count: installedApps.length,
    updated_at: cleanText(deviceExtra.installed_apps_updated_at, 40),
    installed_apps: installedApps,
  };
}

export function getTimelineContext(options: {
  start: string;
  end: string;
  deviceId?: string;
  limit?: number;
  timezoneOffsetMinutes?: number;
}): {
  schema: typeof TIMELINE_SCHEMA;
  range: { start: string; end: string };
  device_id: string | null;
  truncated: boolean;
  segment_count: number;
  timeline: ReturnType<typeof buildTimelinePromptDocument>;
} {
  const startMs = Date.parse(options.start);
  const endMs = Date.parse(options.end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    throw new Error("invalid_time_range");
  }
  if (endMs - startMs > MAX_TIMELINE_RANGE_DAYS * 24 * 60 * 60_000) {
    throw new Error("time_range_too_large");
  }

  const deviceId = options.deviceId ? cleanLooseIdentifier(options.deviceId, 160) : "";
  const rows = deviceId
    ? getDeviceActivitiesForRangeStmt.all(deviceId, new Date(startMs).toISOString(), new Date(endMs).toISOString()) as ActivityRecord[]
    : getActivitiesForRangeStmt.all(new Date(startMs).toISOString(), new Date(endMs).toISOString()) as ActivityRecord[];

  const segments = buildTimelineSegments(rows, { openLast: false })
    .filter((segment) => segment.duration_seconds > 0);
  const limit = clampInteger(options.limit, 1, MAX_TIMELINE_SEGMENTS, MAX_TIMELINE_SEGMENTS);
  const visibleSegments = segments.length > limit ? segments.slice(-limit) : segments;

  return {
    schema: TIMELINE_SCHEMA,
    range: {
      start: new Date(startMs).toISOString(),
      end: new Date(endMs).toISOString(),
    },
    device_id: deviceId || null,
    truncated: segments.length > visibleSegments.length,
    segment_count: visibleSegments.length,
    timeline: buildTimelinePromptDocument(visibleSegments, {
      label: deviceId ? "device_timeline" : "all_device_timeline",
      tzOffsetMinutes: safeTimezoneOffset(options.timezoneOffsetMinutes ?? 0),
    }),
  };
}

export function deviceSupportsCommand(device: DeviceContext, command: "freeze" | "unfreeze" | "vibrate" | "say" | "screen_off"): boolean {
  return device.capability.capabilities[command] === true;
}

function deviceContextFromRow(row: DeviceState): DeviceContext {
  const extra = safeJsonParseObject(row.extra);
  const deviceExtra = objectField(extra, "device");
  return {
    device_id: cleanLooseIdentifier(row.device_id, 160),
    device_name: cleanText(row.device_name || row.device_id, 100),
    platform: cleanText(row.platform, 40),
    is_online: row.is_online === 1,
    last_seen_at: cleanText(row.last_seen_at, 40),
    current_app: {
      app_id: cleanText(row.app_id, 160),
      app_name: cleanText(row.app_name, 100),
      display_title: cleanText(row.display_title, 160),
    },
    capability: capabilityForDevice(row.platform, deviceExtra),
    frozen_packages: frozenPackageItems(deviceExtra.frozen_packages),
    installed_apps_count: installedAppItems(deviceExtra.installed_apps).length,
    installed_apps_updated_at: cleanText(deviceExtra.installed_apps_updated_at, 40),
  };
}

function capabilityForDevice(platform: string, deviceExtra: Record<string, unknown>): DeviceCapability {
  const profile = capabilityProfile(platform, deviceExtra);
  const maxCapabilities = defaultCapabilities(profile);
  const reportedCapabilities = objectField(deviceExtra, "capabilities");
  return {
    schema: DEVICE_CAPABILITY_SCHEMA,
    profile,
    capabilities: boundedCapabilities(maxCapabilities, reportedCapabilities),
    source: cleanText(String(deviceExtra.profile || platform || "unknown"), 40),
  };
}

function capabilityProfile(platform: string, deviceExtra: Record<string, unknown>): DeviceCapabilityProfile {
  const reportedProfile = cleanText(deviceExtra.profile, 40);
  if (reportedProfile === "android_lsp") return "android_lsp";
  if (reportedProfile === "android_normal") return "android_normal";
  if (reportedProfile === "desktop_message") return "desktop_message";
  if (platform === "android") {
    return "android_normal";
  }
  if (platform === "windows" || platform === "macos") return "desktop_message";
  return "unsupported";
}

function defaultCapabilities(profile: DeviceCapabilityProfile): DeviceCapabilityFlags {
  if (profile === "android_lsp") {
    return { freeze: true, unfreeze: true, vibrate: true, screen_off: false, say: true, risk_app_monitor: true, app_time_limit: true };
  }
  if (profile === "android_normal") {
    return { freeze: false, unfreeze: false, vibrate: true, screen_off: false, say: true, risk_app_monitor: false, app_time_limit: false };
  }
  if (profile === "desktop_message") {
    return { freeze: false, unfreeze: false, vibrate: false, screen_off: false, say: true, risk_app_monitor: false, app_time_limit: false };
  }
  return { freeze: false, unfreeze: false, vibrate: false, screen_off: false, say: false, risk_app_monitor: false, app_time_limit: false };
}

function boundedCapabilities(maxCapabilities: DeviceCapabilityFlags, reported: Record<string, unknown>): DeviceCapabilityFlags {
  const hasReportedCapabilities = Object.keys(reported).length > 0;
  return {
    freeze: capabilityFlag(maxCapabilities.freeze, reported.freeze, hasReportedCapabilities),
    unfreeze: capabilityFlag(maxCapabilities.unfreeze, reported.unfreeze, hasReportedCapabilities),
    vibrate: capabilityFlag(maxCapabilities.vibrate, reported.vibrate, hasReportedCapabilities),
    screen_off: false,
    say: capabilityFlag(maxCapabilities.say, reported.say, hasReportedCapabilities),
    risk_app_monitor: capabilityFlag(maxCapabilities.risk_app_monitor, reported.risk_app_monitor, hasReportedCapabilities),
    app_time_limit: capabilityFlag(maxCapabilities.app_time_limit, reported.app_time_limit, hasReportedCapabilities),
  };
}

function capabilityFlag(maxSupported: boolean, reported: unknown, hasReportedCapabilities: boolean): boolean {
  if (!maxSupported) return false;
  return hasReportedCapabilities ? reported === true : true;
}

function frozenPackageItems(value: unknown): FrozenPackageItem[] {
  if (!Array.isArray(value)) return [];
  const out: FrozenPackageItem[] = [];
  for (const item of value) {
    const body = item && typeof item === "object" && !Array.isArray(item)
      ? item as Record<string, unknown>
      : null;
    if (!body) continue;
    const packageName = cleanText(body.package_name, 120);
    const appName = cleanText(body.app_name, 100);
    if (!packageName && !appName) continue;
    out.push({
      package_name: packageName,
      app_name: appName,
      mode: cleanText(body.mode, 40),
      reason: cleanText(body.reason, 180),
      since: cleanText(body.since, 40),
      until: cleanText(body.until, 40),
    });
    if (out.length >= MAX_FROZEN_ITEMS) break;
  }
  return out;
}

function installedAppItems(value: unknown): InstalledAppItem[] {
  if (!Array.isArray(value)) return [];
  const out: InstalledAppItem[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const body = item && typeof item === "object" && !Array.isArray(item)
      ? item as Record<string, unknown>
      : null;
    if (!body) continue;
    const packageName = cleanText(body.package_name, 120);
    if (!packageName || seen.has(packageName)) continue;
    seen.add(packageName);
    out.push({
      package_name: packageName,
      app_name: cleanText(body.app_name, 100),
    });
    if (out.length >= MAX_INSTALLED_APPS) break;
  }
  return out;
}

function objectField(source: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = source[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

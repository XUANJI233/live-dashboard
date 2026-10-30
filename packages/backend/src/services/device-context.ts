import type { DeviceState } from "../types";
import { db } from "../db";
import { historyTimelineSegment, loadActivityExtras, loadHistory } from "./activity-history-engine";
import { resolveControllerTimezone } from "./controller-timezone";
import { deviceInstalledAppChanges, type InstalledAppChange } from "./installed-app-changes";
import { buildTimelinePromptDocument } from "./timeline-prompt";
import { trustedWatchSleepingAt } from "./health-context";
import { cleanWebAllowlistStatus, type WebAllowlistStatus } from "./web-allowlist";
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
  screenshot: boolean;
  say: boolean;
  risk_app_monitor: boolean;
  app_time_limit: boolean;
  web_allowlist: boolean;
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
  /** First report Live stored for this device; '' for devices that predate the field. */
  first_seen_at: string;
  current_app: {
    app_id: string;
    app_name: string;
    display_title: string;
  };
  capability: DeviceCapability;
  frozen_packages: FrozenPackageItem[];
  /** Every active freeze the phone counted; null from builds that list at most eight. */
  frozen_packages_total: number | null;
  installed_apps_count: number;
  installed_apps_updated_at: string;
  sleeping: boolean;
  device_kind: string;
  /** Strict web allowlist enforcement as the Android LSP phone last reported it. */
  web_allowlist: WebAllowlistStatus | null;
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
  /** Packages added or removed between reported snapshots, newest first. */
  changes: ReturnType<typeof deviceInstalledAppChanges>;
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
    changes: device
      ? deviceInstalledAppChanges(device.device_id)
      : { retention_days: 30, total_count: 0, has_more: false, changes: [] as InstalledAppChange[] },
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
  const limit = clampInteger(options.limit, 1, MAX_TIMELINE_SEGMENTS, MAX_TIMELINE_SEGMENTS);
  const nowMs = Date.now();
  // Same duration rule and sessions as get_activity_history; newest segments win.
  const segments = loadHistory({
    window: { startMs, endMs: Math.max(startMs, Math.min(endMs, nowMs)), nowMs },
    deviceId: deviceId || undefined,
  })
    .flatMap(({ device, segments: deviceSegments }) => deviceSegments.map((segment) => ({ segment, deviceName: device.device_name })))
    .sort((left, right) => left.segment.clip_start_ms - right.segment.clip_start_ms
      || left.segment.device_id.localeCompare(right.segment.device_id)
      || left.segment.id - right.segment.id);
  const visible = segments.length > limit ? segments.slice(-limit) : segments;
  const extras = loadActivityExtras(visible.map(({ segment }) => segment.id));
  const visibleSegments = visible
    .map(({ segment, deviceName }) => historyTimelineSegment(segment, deviceName, extras.get(segment.id)));

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
      tzOffsetMinutes: resolveControllerTimezone(options.timezoneOffsetMinutes).offset_minutes,
    }),
  };
}

export function deviceSupportsCommand(device: DeviceContext, command: "freeze" | "unfreeze" | "vibrate" | "say" | "screen_off" | "screenshot"): boolean {
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
    first_seen_at: cleanText(row.first_seen_at, 40),
    current_app: {
      app_id: cleanText(row.app_id, 160),
      app_name: cleanText(row.app_name, 100),
      display_title: cleanText(row.display_title, 160),
    },
    capability: capabilityForDevice(row.platform, deviceExtra),
    frozen_packages: frozenPackageItems(deviceExtra.frozen_packages),
    frozen_packages_total: Number.isInteger(deviceExtra.frozen_packages_total) ? deviceExtra.frozen_packages_total as number : null,
    installed_apps_count: installedAppItems(deviceExtra.installed_apps).length,
    installed_apps_updated_at: cleanText(deviceExtra.installed_apps_updated_at, 40),
    sleeping: extra.sleeping === true,
    device_kind: cleanText(deviceExtra.device_kind, 40),
    web_allowlist: cleanWebAllowlistStatus(deviceExtra.web_allowlist),
  };
}

export type ControllerRestState = "asleep" | "screen_off" | "active" | "unknown";

export function controllerRestState(
  devices = listDeviceContexts(),
  trustedWatchSleeping = trustedWatchSleepingAt(new Date()),
): ControllerRestState {
  const online = devices.filter((device) => device.is_online);
  if (online.length === 0) return "unknown";
  if (trustedWatchSleeping) return "asleep";
  const phones = online.filter((device) => (
    device.device_kind === "phone" || device.platform === "android"
  ));
  if (phones.length === 0) return "unknown";
  return phones.every((device) => (
    device.sleeping
    || !device.current_app.app_id
    || device.current_app.app_id === "idle"
    || device.current_app.app_id === "sleeping"
  )) ? "screen_off" : "active";
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
    return { freeze: true, unfreeze: true, vibrate: true, screen_off: true, screenshot: true, say: true, risk_app_monitor: true, app_time_limit: true, web_allowlist: true };
  }
  if (profile === "android_normal") {
    return { freeze: false, unfreeze: false, vibrate: true, screen_off: false, screenshot: false, say: true, risk_app_monitor: false, app_time_limit: false, web_allowlist: false };
  }
  if (profile === "desktop_message") {
    return { freeze: false, unfreeze: false, vibrate: false, screen_off: false, screenshot: false, say: true, risk_app_monitor: false, app_time_limit: false, web_allowlist: false };
  }
  return { freeze: false, unfreeze: false, vibrate: false, screen_off: false, screenshot: false, say: false, risk_app_monitor: false, app_time_limit: false, web_allowlist: false };
}

function boundedCapabilities(maxCapabilities: DeviceCapabilityFlags, reported: Record<string, unknown>): DeviceCapabilityFlags {
  const hasReportedCapabilities = Object.keys(reported).length > 0;
  return {
    freeze: capabilityFlag(maxCapabilities.freeze, reported.freeze, hasReportedCapabilities),
    unfreeze: capabilityFlag(maxCapabilities.unfreeze, reported.unfreeze, hasReportedCapabilities),
    vibrate: capabilityFlag(maxCapabilities.vibrate, reported.vibrate, hasReportedCapabilities),
    screen_off: reportedCapabilityFlag(maxCapabilities.screen_off, reported.screen_off),
    screenshot: reportedCapabilityFlag(maxCapabilities.screenshot, reported.screenshot),
    say: capabilityFlag(maxCapabilities.say, reported.say, hasReportedCapabilities),
    risk_app_monitor: capabilityFlag(maxCapabilities.risk_app_monitor, reported.risk_app_monitor, hasReportedCapabilities),
    app_time_limit: capabilityFlag(maxCapabilities.app_time_limit, reported.app_time_limit, hasReportedCapabilities),
    web_allowlist: reportedCapabilityFlag(maxCapabilities.web_allowlist, reported.web_allowlist),
  };
}

function capabilityFlag(maxSupported: boolean, reported: unknown, hasReportedCapabilities: boolean): boolean {
  if (!maxSupported) return false;
  return hasReportedCapabilities ? reported === true : true;
}

function reportedCapabilityFlag(maxSupported: boolean, reported: unknown): boolean {
  return maxSupported && reported === true;
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
      since: cleanText(body.frozen_at ?? body.since, 40),
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

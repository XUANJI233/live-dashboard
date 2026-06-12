import { resolveAppName } from "./app-mapper";
import { isNSFW } from "./nsfw-filter";
// NSFW filter can be disabled via environment variable (default: enabled)
const NSFW_FILTER_ENABLED = process.env.NSFW_FILTER_DISABLED !== "true";
import { processDisplayTitle } from "./privacy-tiers";
import { db, insertActivity, insertLocationRecord, upsertDeviceState, hmacTitle } from "../db";
import { OFFLINE_TIMEOUT_FIELD, validateReportedOfflineTimeoutMinutes } from "../offline-policy";
import type { DeviceInfo, TimelineSegmentExtra } from "../types";

const MAX_TITLE_LENGTH = 256;
const MAX_SHORT_LENGTH = 64;
const MAX_MEDIUM_LENGTH = 256;
const MAX_INSTALLED_APPS = 512;
const VALID_SOURCES = new Set(["normal", "root", "lsposed", "accessibility", "notification"]);
const VALID_DEVICE_PROFILES = new Set(["android_lsp", "android_normal", "desktop_message"]);
const DEVICE_CAPABILITY_KEYS = ["freeze", "unfreeze", "vibrate", "screen_off", "say", "risk_app_monitor", "app_time_limit"] as const;
const getPreviousDeviceExtra = db.prepare("SELECT extra FROM device_states WHERE device_id = ?");

export interface PublicDeviceUpdate {
  app_id: string;
  app_name: string;
  display_title: string;
  extra: Record<string, unknown>;
}

export class ReportPayloadError extends Error {
  readonly status = 400;
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ReportPayloadError";
    this.code = code;
  }
}

function cleanString(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return cleaned ? cleaned.slice(0, max) : undefined;
}

function cleanSource(value: unknown): string | undefined {
  return typeof value === "string" && VALID_SOURCES.has(value)
    ? value
    : undefined;
}

function cleanDeviceProfile(value: unknown): string | undefined {
  return typeof value === "string" && VALID_DEVICE_PROFILES.has(value)
    ? value
    : undefined;
}

function cleanDeviceCapabilities(value: unknown): Record<string, boolean> | undefined {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const body = value as Record<string, unknown>;
  const out: Record<string, boolean> = {};
  for (const key of DEVICE_CAPABILITY_KEYS) {
    if (typeof body[key] === "boolean") out[key] = body[key];
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function cleanTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const parsed = new Date(value);
  return isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function cleanFiniteNumber(value: unknown, min: number, max: number): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(min, Math.min(max, value))
    : undefined;
}

/**
 * Core report processing shared by HTTP /api/report and WebSocket device_status.
 * Does NOT perform auth — caller must already have a verified DeviceInfo.
 */
export function processReportPayload(body: Record<string, unknown>, device: DeviceInfo): PublicDeviceUpdate | null {
  let payloadError: ReportPayloadError | null = null;
  const rawExtra = body.extra && typeof body.extra === "object" && !Array.isArray(body.extra)
    ? (body.extra as Record<string, unknown>)
    : null;
  const rawForeground = rawExtra?.foreground && typeof rawExtra.foreground === "object" && !Array.isArray(rawExtra.foreground)
    ? (rawExtra.foreground as Record<string, unknown>)
    : null;
  const sleepingFallback = rawExtra?.sleeping === true;
  const foregroundPackageFallback = cleanString(rawForeground?.package_name, MAX_SHORT_LENGTH) || "";
  const appId = typeof body.app_id === "string"
    ? body.app_id.trim()
    : foregroundPackageFallback || (sleepingFallback ? "sleeping" : "");
  if (!appId) return null;

  let windowTitle =
    typeof body.window_title === "string" ? body.window_title : "";
  if (windowTitle.length > MAX_TITLE_LENGTH) {
    windowTitle = windowTitle.slice(0, MAX_TITLE_LENGTH);
  }

  let startedAt: string;
  if (typeof body.timestamp === "string" && body.timestamp) {
    const ts = new Date(body.timestamp);
    const now = Date.now();
    if (!isNaN(ts.getTime()) && Math.abs(ts.getTime() - now) < 5 * 60 * 1000) {
      startedAt = ts.toISOString();
    } else {
      startedAt = new Date().toISOString();
    }
  } else {
    startedAt = new Date().toISOString();
  }

  if (NSFW_FILTER_ENABLED && isNSFW(appId, windowTitle)) return null;

  const rawForegroundForName = rawExtra?.foreground ?? null;
  const reportedAppName = rawForegroundForName && typeof rawForegroundForName === "object" && !Array.isArray(rawForegroundForName)
    ? cleanString((rawForegroundForName as Record<string, unknown>).app_name, MAX_SHORT_LENGTH)
    : undefined;

  const appName = appId === "sleeping"
    ? "sleeping"
    : device.platform === "android" && reportedAppName
    ? reportedAppName
    : resolveAppName(appId, device.platform);

  const displayTitle = processDisplayTitle(appName, windowTitle);

  const timeBucket = Math.floor(Date.now() / 10000);
  const titleHash = hmacTitle(windowTitle.toLowerCase().trim());

  const extra: Record<string, unknown> = {};
  if (rawExtra) {
    if (typeof rawExtra.battery_percent === "number" && Number.isFinite(rawExtra.battery_percent)) {
      extra.battery_percent = Math.max(0, Math.min(100, Math.round(rawExtra.battery_percent)));
    }
    if (typeof rawExtra.battery_charging === "boolean") {
      extra.battery_charging = rawExtra.battery_charging;
    }
    if (typeof rawExtra.sleeping === "boolean") {
      extra.sleeping = rawExtra.sleeping;
    }

    const rawDevice = rawExtra.device;
    if (rawDevice != null && typeof rawDevice === "object" && !Array.isArray(rawDevice)) {
      const deviceBody = rawDevice as Record<string, unknown>;
      const deviceExtra: Record<string, unknown> = {};
      if (typeof deviceBody.network_connected === "boolean") deviceExtra.network_connected = deviceBody.network_connected;
      const networkType = cleanString(deviceBody.network_type, MAX_SHORT_LENGTH);
      if (networkType) deviceExtra.network_type = networkType;
      const cellularGeneration = cleanString(deviceBody.cellular_generation, MAX_SHORT_LENGTH);
      if (cellularGeneration) deviceExtra.cellular_generation = cellularGeneration;
      if (typeof deviceBody.vpn_active === "boolean") deviceExtra.vpn_active = deviceBody.vpn_active;
      const vpnName = cleanString(deviceBody.vpn_name, MAX_SHORT_LENGTH);
      if (vpnName) deviceExtra.vpn_name = vpnName;
      const profile = cleanDeviceProfile(deviceBody.profile);
      if (profile) deviceExtra.profile = profile;
      const capabilities = cleanDeviceCapabilities(deviceBody.capabilities);
      if (capabilities) deviceExtra.capabilities = capabilities;
      const lastSampleAt = cleanTimestamp(deviceBody.last_sample_at);
      if (lastSampleAt) deviceExtra.last_sample_at = lastSampleAt;
      const relayMode = cleanString(deviceBody.relay_mode, MAX_SHORT_LENGTH);
      if (relayMode) deviceExtra.relay_mode = relayMode;
      const energyPolicy = cleanString(deviceBody.energy_policy, MAX_SHORT_LENGTH);
      if (energyPolicy) deviceExtra.energy_policy = energyPolicy;
      const minIntervalMs = cleanFiniteNumber(deviceBody.min_interval_ms, 0, 24 * 60 * 60 * 1000);
      if (minIntervalMs != null) deviceExtra.min_interval_ms = Math.round(minIntervalMs);
      const offlineTimeout = validateReportedOfflineTimeoutMinutes(deviceBody[OFFLINE_TIMEOUT_FIELD]);
      if (offlineTimeout.error) {
        payloadError = new ReportPayloadError("invalid_offline_timeout", offlineTimeout.error);
      }
      if (offlineTimeout.value != null) {
        deviceExtra[OFFLINE_TIMEOUT_FIELD] = offlineTimeout.value;
      }
      const deviceKind = cleanString(deviceBody.device_kind, MAX_SHORT_LENGTH);
      if (deviceKind) deviceExtra.device_kind = deviceKind;
      const windowMode = cleanString(deviceBody.window_mode, MAX_SHORT_LENGTH);
      if (windowMode) deviceExtra.window_mode = windowMode;
      if (typeof deviceBody.heartbeat_only === "boolean") deviceExtra.heartbeat_only = deviceBody.heartbeat_only;
      if (typeof deviceBody.audio_output_connected === "boolean") deviceExtra.audio_output_connected = deviceBody.audio_output_connected;
      const audioOutputType = cleanString(deviceBody.audio_output_type, MAX_SHORT_LENGTH);
      if (audioOutputType) deviceExtra.audio_output_type = audioOutputType;
      const audioOutputName = cleanString(deviceBody.audio_output_name, MAX_SHORT_LENGTH);
      if (audioOutputName) deviceExtra.audio_output_name = audioOutputName;
      const ambientLux = cleanFiniteNumber(deviceBody.ambient_lux, 0, 200_000);
      if (ambientLux != null) deviceExtra.ambient_lux = Math.round(ambientLux * 10) / 10;
      const frozenPackages = cleanFrozenPackages(deviceBody.frozen_packages);
      if (frozenPackages.length > 0) deviceExtra.frozen_packages = frozenPackages;
      const installedApps = cleanInstalledApps(deviceBody.installed_apps);
      if (installedApps.length > 0) {
        deviceExtra.installed_apps = installedApps;
        deviceExtra.installed_apps_updated_at = cleanTimestamp(deviceBody.installed_apps_updated_at) || startedAt;
      }
      if (Object.keys(deviceExtra).length > 0) extra.device = deviceExtra;
    }

    const rawLocation = rawExtra.location;
    if (rawLocation != null && typeof rawLocation === "object" && !Array.isArray(rawLocation)) {
      const locationBody = rawLocation as Record<string, unknown>;
      const latitude = cleanFiniteNumber(locationBody.latitude, -90, 90);
      const longitude = cleanFiniteNumber(locationBody.longitude, -180, 180);
      if (latitude != null && longitude != null) {
        const recordedAt = cleanTimestamp(locationBody.recorded_at) || startedAt;
        const accuracy = cleanFiniteNumber(locationBody.accuracy_m, 0, 100_000);
        const provider = cleanString(locationBody.provider, MAX_SHORT_LENGTH) || "";
        extra.location = {
          latitude,
          longitude,
          ...(accuracy != null ? { accuracy_m: accuracy } : {}),
          ...(provider ? { provider } : {}),
          recorded_at: recordedAt,
        };
        try {
          insertLocationRecord.run(
            device.device_id,
            latitude,
            longitude,
            accuracy ?? null,
            provider,
            recordedAt
          );
        } catch (e: any) {
          if (!e.message?.includes("UNIQUE constraint")) {
            console.error("[report] Location insert error:", e.message);
          }
        }
      }
    }

    const rawForeground = rawExtra.foreground;
    if (rawForeground != null && typeof rawForeground === "object" && !Array.isArray(rawForeground)) {
      const foregroundBody = rawForeground as Record<string, unknown>;
      const foreground: Record<string, unknown> = {};
      const packageName = cleanString(foregroundBody.package_name, MAX_SHORT_LENGTH);
      const appNameExtra = cleanString(foregroundBody.app_name, MAX_SHORT_LENGTH);
      const activity = cleanString(foregroundBody.activity, MAX_MEDIUM_LENGTH);
      const title = cleanString(foregroundBody.title, MAX_MEDIUM_LENGTH);
      const source = cleanSource(foregroundBody.source);
      if (packageName) foreground.package_name = packageName;
      if (appNameExtra) foreground.app_name = appNameExtra;
      if (activity) foreground.activity = activity;
      if (title && displayTitle) foreground.title = displayTitle;
      if (source) foreground.source = source;
      if (typeof foregroundBody.confidence === "number" && Number.isFinite(foregroundBody.confidence)) {
        foreground.confidence = Math.max(0, Math.min(1, foregroundBody.confidence));
      }
      if (Object.keys(foreground).length > 0) extra.foreground = foreground;
    }

    const rawMusic = rawExtra.music;
    if (rawMusic != null && typeof rawMusic === "object" && !Array.isArray(rawMusic)) {
      const music: Record<string, string> = {};
      if (typeof (rawMusic as Record<string, unknown>).title === "string") music.title = ((rawMusic as Record<string, unknown>).title as string).slice(0, 256);
      if (typeof (rawMusic as Record<string, unknown>).artist === "string") music.artist = ((rawMusic as Record<string, unknown>).artist as string).slice(0, 256);
      if (typeof (rawMusic as Record<string, unknown>).app === "string") music.app = ((rawMusic as Record<string, unknown>).app as string).slice(0, 64);
      if (Object.keys(music).length > 0) {
        extra.music = music;
      }
    }

    const rawMedia = rawExtra.media;
    if (rawMedia != null && typeof rawMedia === "object" && !Array.isArray(rawMedia)) {
      const mediaBody = rawMedia as Record<string, unknown>;
      const media: Record<string, unknown> = {};
      if (typeof mediaBody.playing === "boolean") media.playing = mediaBody.playing;
      const title = cleanString(mediaBody.title, MAX_MEDIUM_LENGTH);
      const artist = cleanString(mediaBody.artist, MAX_MEDIUM_LENGTH);
      const mediaApp = cleanString(mediaBody.app, MAX_SHORT_LENGTH);
      const mediaPackage = cleanString(mediaBody.package_name, MAX_SHORT_LENGTH);
      const state = cleanString(mediaBody.state, MAX_SHORT_LENGTH);
      const source = cleanSource(mediaBody.source);
      if (title) media.title = title;
      if (artist) media.artist = artist;
      if (mediaApp) media.app = mediaApp;
      if (mediaPackage) media.package_name = mediaPackage;
      if (state) media.state = state;
      if (source) media.source = source;
      if (Object.keys(media).length > 0) extra.media = media;
    }
  }
  mergeStableDeviceExtra(device.device_id, extra);
  const extraJson = JSON.stringify(extra);
  const activityExtraJson = JSON.stringify(activityExtraSnapshot(extra));
  const heartbeatOnly = plainObject(extra.device)?.heartbeat_only === true;

  try {
    // Watch / IoT devices should not create activity timeline entries.
    // They only update device state (battery, online status).
    if (device.platform !== "zepp" && !heartbeatOnly) {
      insertActivity.run(
        device.device_id,
        device.device_name,
        device.platform,
        appId,
        appName,
        windowTitle,
        displayTitle,
        activityExtraJson,
        titleHash,
        timeBucket,
        startedAt
      );
    }
  } catch (e: any) {
    if (!e.message?.includes("UNIQUE constraint")) {
      console.error("[report] DB insert error:", e.message);
    }
  }

  try {
    upsertDeviceState.run(
      device.device_id,
      device.device_name,
      device.platform,
      appId,
      appName,
      windowTitle,
      displayTitle,
      new Date().toISOString(),
      extraJson
    );
  } catch (e: any) {
    console.error("[report] Device state update error:", e.message);
  }

  const update = {
    app_id: appId,
    app_name: appName,
    display_title: displayTitle,
    extra,
  };
  if (payloadError) throw payloadError;
  return update;
}

function activityExtraSnapshot(extra: Record<string, unknown>): TimelineSegmentExtra {
  const snapshot: TimelineSegmentExtra = {};

  const foreground = plainObject(extra.foreground);
  if (foreground) {
    const out: NonNullable<TimelineSegmentExtra["foreground"]> = {};
    copyString(foreground, out, "package_name");
    copyString(foreground, out, "app_name");
    copyString(foreground, out, "activity");
    copyString(foreground, out, "source");
    if (typeof foreground.confidence === "number" && Number.isFinite(foreground.confidence)) {
      out.confidence = foreground.confidence;
    }
    if (Object.keys(out).length > 0) snapshot.foreground = out;
  }

  const media = plainObject(extra.media);
  if (media) {
    const out: NonNullable<TimelineSegmentExtra["media"]> = {};
    if (typeof media.playing === "boolean") out.playing = media.playing;
    copyString(media, out, "title");
    copyString(media, out, "artist");
    copyString(media, out, "app");
    copyString(media, out, "package_name");
    copyString(media, out, "state");
    copyString(media, out, "source");
    if (Object.keys(out).length > 0) snapshot.media = out;
  }

  const music = plainObject(extra.music);
  if (music) {
    const out: NonNullable<TimelineSegmentExtra["music"]> = {};
    copyString(music, out, "title");
    copyString(music, out, "artist");
    copyString(music, out, "app");
    if (Object.keys(out).length > 0) snapshot.music = out;
  }

  const device = plainObject(extra.device);
  if (device) {
    const out: NonNullable<TimelineSegmentExtra["device"]> = {};
    copyString(device, out, "profile");
    copyString(device, out, "window_mode");
    if (typeof device.heartbeat_only === "boolean") out.heartbeat_only = device.heartbeat_only;
    if (typeof device.audio_output_connected === "boolean") out.audio_output_connected = device.audio_output_connected;
    copyString(device, out, "audio_output_type");
    copyString(device, out, "audio_output_name");
    if (typeof device.ambient_lux === "number" && Number.isFinite(device.ambient_lux)) out.ambient_lux = device.ambient_lux;
    if (Object.keys(out).length > 0) snapshot.device = out;
  }

  return snapshot;
}

function plainObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function copyString<T extends Record<string, unknown>>(source: Record<string, unknown>, target: T, key: keyof T & string): void {
  if (typeof source[key] === "string" && source[key]) {
    target[key] = source[key].slice(0, MAX_MEDIUM_LENGTH) as T[keyof T & string];
  }
}

function mergeStableDeviceExtra(deviceId: string, extra: Record<string, unknown>) {
  const row = getPreviousDeviceExtra.get(deviceId) as { extra?: string } | undefined;
  if (!row?.extra) return;

  let previous: Record<string, unknown>;
  try {
    previous = JSON.parse(row.extra);
  } catch {
    return;
  }

  if (typeof extra.battery_percent !== "number" && typeof previous.battery_percent === "number") {
    extra.battery_percent = previous.battery_percent;
  }
  if (typeof extra.battery_charging !== "boolean" && typeof previous.battery_charging === "boolean") {
    extra.battery_charging = previous.battery_charging;
  }

  const previousDevice = previous.device && typeof previous.device === "object" && !Array.isArray(previous.device)
    ? previous.device as Record<string, unknown>
    : null;
  if (!previousDevice) return;

  const currentDevice = extra.device && typeof extra.device === "object" && !Array.isArray(extra.device)
    ? extra.device as Record<string, unknown>
    : {};
  extra.device = { ...previousDevice, ...currentDevice };
  if (typeof currentDevice.heartbeat_only !== "boolean") {
    delete (extra.device as Record<string, unknown>).heartbeat_only;
  }
}

function cleanFrozenPackages(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  const out: Record<string, unknown>[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const body = item as Record<string, unknown>;
    const packageName = cleanString(body.package_name ?? body.packageName, MAX_SHORT_LENGTH);
    if (!packageName) continue;
    const row: Record<string, unknown> = { package_name: packageName };
    const appName = cleanString(body.app_name ?? body.appName, MAX_SHORT_LENGTH);
    if (appName) row.app_name = appName;
    const frozenAt = cleanTimestamp(body.frozen_at ?? body.frozenAt);
    if (frozenAt) row.frozen_at = frozenAt;
    const until = cleanTimestamp(body.until);
    if (until) row.until = until;
    const mode = cleanString(body.mode, MAX_SHORT_LENGTH);
    if (mode) row.mode = mode;
    const reason = cleanString(body.reason, MAX_MEDIUM_LENGTH);
    if (reason) row.reason = reason;
    out.push(row);
    if (out.length >= 8) break;
  }
  return out;
}

function cleanInstalledApps(value: unknown): Record<string, string>[] {
  if (!Array.isArray(value)) return [];
  const out: Record<string, string>[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const body = item as Record<string, unknown>;
    const packageName = cleanString(body.package_name, MAX_SHORT_LENGTH);
    if (!packageName || seen.has(packageName)) continue;
    seen.add(packageName);
    const appName = cleanString(body.app_name, MAX_SHORT_LENGTH);
    out.push({
      package_name: packageName,
      ...(appName ? { app_name: appName } : {}),
    });
    if (out.length >= MAX_INSTALLED_APPS) break;
  }
  return out;
}

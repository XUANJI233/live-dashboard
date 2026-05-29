import { resolveAppName } from "./app-mapper";
import { isNSFW } from "./nsfw-filter";
// NSFW filter can be disabled via environment variable (default: enabled)
const NSFW_FILTER_ENABLED = process.env.NSFW_FILTER_DISABLED !== "true";
import { processDisplayTitle } from "./privacy-tiers";
import { insertActivity, insertLocationRecord, upsertDeviceState, hmacTitle } from "../db";
import type { DeviceInfo } from "../types";

const MAX_TITLE_LENGTH = 256;
const MAX_SHORT_LENGTH = 64;
const MAX_MEDIUM_LENGTH = 256;
const VALID_SOURCES = new Set(["normal", "root", "lsposed", "accessibility", "notification"]);

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
export function processReportPayload(body: Record<string, unknown>, device: DeviceInfo): void {
  const appId = typeof body.app_id === "string" ? body.app_id.trim() : "";
  if (!appId) return;

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

  if (NSFW_FILTER_ENABLED && isNSFW(appId, windowTitle)) return;

  const rawForegroundForName = body.extra && typeof body.extra === "object" && !Array.isArray(body.extra)
    ? (body.extra as Record<string, unknown>).foreground
    : null;
  const reportedAppName = rawForegroundForName && typeof rawForegroundForName === "object" && !Array.isArray(rawForegroundForName)
    ? cleanString((rawForegroundForName as Record<string, unknown>).app_name, MAX_SHORT_LENGTH)
    : undefined;

  const appName = device.platform === "android" && reportedAppName
    ? reportedAppName
    : resolveAppName(appId, device.platform);

  const displayTitle = processDisplayTitle(appName, windowTitle);

  const timeBucket = Math.floor(Date.now() / 10000);
  const titleHash = hmacTitle(windowTitle.toLowerCase().trim());

  let extraJson = "{}";
  if (body.extra && typeof body.extra === "object" && !Array.isArray(body.extra)) {
    const rawExtra = body.extra as Record<string, unknown>;
    const extra: Record<string, unknown> = {};

    if (typeof rawExtra.battery_percent === "number" && Number.isFinite(rawExtra.battery_percent)) {
      extra.battery_percent = Math.max(0, Math.min(100, Math.round(rawExtra.battery_percent)));
    }
    if (typeof rawExtra.battery_charging === "boolean") {
      extra.battery_charging = rawExtra.battery_charging;
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
      const capabilityMode = cleanSource(deviceBody.capability_mode);
      if (capabilityMode) deviceExtra.capability_mode = capabilityMode;
      const lastSampleAt = cleanTimestamp(deviceBody.last_sample_at);
      if (lastSampleAt) deviceExtra.last_sample_at = lastSampleAt;
      const relayMode = cleanString(deviceBody.relay_mode, MAX_SHORT_LENGTH);
      if (relayMode) deviceExtra.relay_mode = relayMode;
      const energyPolicy = cleanString(deviceBody.energy_policy, MAX_SHORT_LENGTH);
      if (energyPolicy) deviceExtra.energy_policy = energyPolicy;
      const minIntervalMs = cleanFiniteNumber(deviceBody.min_interval_ms, 0, 24 * 60 * 60 * 1000);
      if (minIntervalMs != null) deviceExtra.min_interval_ms = Math.round(minIntervalMs);
      const deviceKind = cleanString(deviceBody.device_kind, MAX_SHORT_LENGTH);
      if (deviceKind) deviceExtra.device_kind = deviceKind;
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
      if (title) foreground.title = title;
      if (source) foreground.source = source;
      if (typeof foregroundBody.confidence === "number" && Number.isFinite(foregroundBody.confidence)) {
        foreground.confidence = Math.max(0, Math.min(1, foregroundBody.confidence));
      }
      if (Object.keys(foreground).length > 0) extra.foreground = foreground;
    }

    const rawInput = rawExtra.input;
    if (rawInput != null && typeof rawInput === "object" && !Array.isArray(rawInput)) {
      const inputBody = rawInput as Record<string, unknown>;
      const input: Record<string, unknown> = {};
      if (typeof inputBody.input_active === "boolean") input.input_active = inputBody.input_active;
      if (typeof inputBody.is_typing === "boolean") input.is_typing = inputBody.is_typing;
      const source = cleanSource(inputBody.source);
      if (source) input.source = source;
      if (Object.keys(input).length > 0) extra.input = input;
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
    extraJson = JSON.stringify(extra);
  }

  try {
    // Watch / IoT devices should not create activity timeline entries.
    // They only update device state (battery, online status).
    if (device.platform !== "zepp") {
      insertActivity.run(
        device.device_id,
        device.device_name,
        device.platform,
        appId,
        appName,
        windowTitle,
        displayTitle,
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
}

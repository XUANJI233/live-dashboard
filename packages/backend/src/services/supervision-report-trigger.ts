import type { DeviceInfo } from "../types";
import { requestSupervisionCheckForReport, type SupervisionReportCandidate } from "./supervision";

export function requestSupervisionCheckFromReportPayload(
  body: Record<string, unknown>,
  device: DeviceInfo,
): boolean {
  const candidate = supervisionCandidateFromReport(body, device);
  if (!candidate) return false;
  return requestSupervisionCheckForReport(candidate);
}

function supervisionCandidateFromReport(
  body: Record<string, unknown>,
  device: DeviceInfo,
): SupervisionReportCandidate | null {
  const extra = plainObject(body.extra);
  const deviceExtra = plainObject(extra?.device);
  if (deviceExtra?.supervision_check_requested !== true) return null;

  const foreground = plainObject(extra?.foreground);
  const appId = cleanText(body.app_id) || cleanText(foreground?.package_name);
  if (!appId) return null;

  return {
    requested: true,
    deviceId: device.device_id,
    deviceName: device.device_name,
    platform: device.platform,
    appId,
    appName: cleanText(foreground?.app_name),
    title: cleanText(body.window_title) || cleanText(foreground?.title),
    source: sourceFromProfile(deviceExtra?.profile) || cleanText(foreground?.source),
  };
}

function sourceFromProfile(value: unknown): string {
  if (value === "android_lsp") return "lsposed";
  if (value === "android_normal") return "normal";
  if (value === "desktop_message") return "desktop";
  return "";
}

function plainObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function cleanText(value: unknown): string {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 256)
    : "";
}

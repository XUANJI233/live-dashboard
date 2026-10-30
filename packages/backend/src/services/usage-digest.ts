import { createHash } from "node:crypto";
import type { TimelineSegment } from "../types";
import { historyTimelineSegment, isAwayApp, loadHistory } from "./activity-history-engine";
import { promptText } from "./prompt-text";
import { matchSegmentSupervisionRules, type CompiledSupervisionRules } from "./supervision-patterns";

export const USAGE_DIGEST_SCHEMA = "live_dashboard.usage_digest.v1";
const MAX_DIGEST_DEVICES = 6;
const MAX_DIGEST_APPS = 6;
// An app needs this much of a window before its presence or class can count as a
// material change between periodic reviews; shorter visits stay noise.
const MATERIAL_APP_SECONDS = 5 * 60;
const CLASS_RULE = "Each segment counts once, in the first matching saved-policy class: blacklist, risk, target, whitelist; a whitelist match masks blacklist and risk; otherwise unclassified.";
// Duration buckets for the review gate: a shift of this much time share counts as a change.
const SIGNATURE_BUCKET_SECONDS = 15 * 60;

export type UsageClass = "blacklist" | "risk" | "target" | "whitelist" | "unclassified";
const USAGE_CLASSES: readonly UsageClass[] = ["blacklist", "risk", "target", "whitelist", "unclassified"];

export interface UsageDigestApp {
  app_id: string;
  app_name: string;
  minutes: number;
  class: UsageClass;
}

export interface UsageDigestDevice {
  device_id: string;
  /** App usage only: idle/sleeping time is reported beside it. */
  active_minutes: number;
  idle_minutes: number;
  class_minutes: Record<UsageClass, number>;
  current: UsageDigestApp & { since: string };
  top_apps: UsageDigestApp[];
  app_count: number;
  switches: number;
}

export interface UsageDigest {
  schema: typeof USAGE_DIGEST_SCHEMA;
  range: { start: string; end: string };
  class_rule: string;
  truncated: boolean;
  available_device_count: number;
  devices: UsageDigestDevice[];
}

interface AppUsage {
  app_id: string;
  app_name: string;
  seconds: number;
  classSeconds: Record<UsageClass, number>;
}

interface DeviceUsage {
  deviceId: string;
  seconds: number;
  idleSeconds: number;
  classSeconds: Record<UsageClass, number>;
  apps: Map<string, AppUsage>;
  current: { key: string; app_id: string; app_name: string; class: UsageClass; since: string; seconds: number };
  switches: number;
}

/** Whole-window usage digest for the controller, folded by the shared history engine. */
export function loadUsageDigest(options: {
  start: string;
  end: string;
  rules: CompiledSupervisionRules;
  preferDeviceId?: string;
  now?: Date;
}): UsageDigest {
  return buildUsageDigest(loadUsageSegments(options.start, options.end, options.now), options.rules, {
    start: options.start,
    end: options.end,
    preferDeviceId: options.preferDeviceId,
  });
}

/** Every device's folded segments for a window, in the shape buildUsageDigest consumes. */
export function loadUsageSegments(start: string, end: string, now = new Date()): TimelineSegment[] {
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  const nowMs = now.getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return [];
  return loadHistory({ window: { startMs, endMs: Math.max(startMs, Math.min(endMs, nowMs)), nowMs } })
    .flatMap(({ device, segments }) => segments.map((segment) => historyTimelineSegment(segment, device.device_name)));
}

export function buildUsageDigest(
  segments: TimelineSegment[],
  rules: CompiledSupervisionRules,
  options: { start: string; end: string; preferDeviceId?: string; truncated?: boolean },
): UsageDigest {
  const usage = summarizeDeviceUsage(segments, rules);
  const devices = usage
    .sort((left, right) => compareDevices(left, right, options.preferDeviceId))
    .slice(0, MAX_DIGEST_DEVICES)
    .map(publicDeviceDigest);
  return {
    schema: USAGE_DIGEST_SCHEMA,
    range: { start: options.start, end: options.end },
    class_rule: CLASS_RULE,
    truncated: options.truncated === true,
    available_device_count: usage.length,
    devices,
  };
}

/**
 * Stable fingerprint of what a review would see: which apps held at least five
 * minutes on each device, in which policy class, and roughly for how long (15-minute
 * buckets). A new app, a vanished app, a class change, or a shift of a quarter hour
 * in an app's share of the window changes it.
 */
export function materialUsageSignature(segments: TimelineSegment[], rules: CompiledSupervisionRules): string {
  const material = summarizeDeviceUsage(segments, rules)
    .map((device) => [
      device.deviceId,
      Array.from(device.apps, ([key, app]) => ({ key, app }))
        .filter(({ app }) => app.seconds >= MATERIAL_APP_SECONDS)
        .map(({ key, app }) => [
          key,
          dominantClass(app.classSeconds),
          Math.floor(app.seconds / SIGNATURE_BUCKET_SECONDS),
        ].join("\u0000"))
        .sort(),
    ] as const)
    .filter(([, apps]) => apps.length > 0)
    .sort(([left], [right]) => left.localeCompare(right));
  return createHash("sha256").update(JSON.stringify(material)).digest("hex").slice(0, 32);
}

function summarizeDeviceUsage(segments: TimelineSegment[], rules: CompiledSupervisionRules): DeviceUsage[] {
  const byDevice = new Map<string, TimelineSegment[]>();
  for (const segment of segments) {
    if (!(segment.duration_seconds > 0)) continue;
    const list = byDevice.get(segment.device_id);
    if (list) list.push(segment);
    else byDevice.set(segment.device_id, [segment]);
  }
  return Array.from(byDevice, ([deviceId, list]) => deviceUsage(deviceId, list, rules));
}

function deviceUsage(deviceId: string, segments: TimelineSegment[], rules: CompiledSupervisionRules): DeviceUsage {
  const ordered = [...segments].sort((left, right) => left.started_at.localeCompare(right.started_at));
  const usage: DeviceUsage = {
    deviceId,
    seconds: 0,
    idleSeconds: 0,
    classSeconds: emptyClassSeconds(),
    apps: new Map(),
    current: { key: "", app_id: "", app_name: "", class: "unclassified", since: "", seconds: 0 },
    switches: 0,
  };
  for (const segment of ordered) {
    const seconds = segment.duration_seconds;
    const kind = segmentKind(segment);
    const key = segment.app_id || segment.app_name;
    // Idle and sleeping keep the current-app trail honest but are never app usage.
    const usageClass = kind === "active" ? segmentUsageClass(segment, rules) : "unclassified";
    if (kind === "away") {
      usage.idleSeconds += seconds;
    } else {
      usage.seconds += seconds;
      usage.classSeconds[usageClass] += seconds;
      const app = usage.apps.get(key) ?? {
        app_id: promptText(segment.app_id, 160),
        app_name: promptText(segment.app_name, 60) || promptText(segment.app_id, 60),
        seconds: 0,
        classSeconds: emptyClassSeconds(),
      };
      app.seconds += seconds;
      app.classSeconds[usageClass] += seconds;
      usage.apps.set(key, app);
    }
    if (usage.current.key === key) {
      usage.current.seconds += seconds;
      usage.current.class = usageClass;
    } else {
      if (usage.current.key) usage.switches += 1;
      usage.current = {
        key,
        app_id: promptText(segment.app_id, 160),
        app_name: promptText(segment.app_name, 60) || promptText(segment.app_id, 60),
        class: usageClass,
        since: segment.started_at,
        seconds,
      };
    }
  }
  return usage;
}

function segmentKind(segment: TimelineSegment): "active" | "away" {
  if (segment.kind) return segment.kind;
  return isAwayApp(segment.app_id, segment.app_name) ? "away" : "active";
}

function publicDeviceDigest(usage: DeviceUsage): UsageDigestDevice {
  const apps = Array.from(usage.apps.values()).sort((left, right) =>
    right.seconds - left.seconds || left.app_name.localeCompare(right.app_name)
  );
  return {
    device_id: promptText(usage.deviceId, 160),
    active_minutes: minutes(usage.seconds),
    idle_minutes: minutes(usage.idleSeconds),
    class_minutes: Object.fromEntries(
      USAGE_CLASSES.map((usageClass) => [usageClass, minutes(usage.classSeconds[usageClass])]),
    ) as Record<UsageClass, number>,
    current: {
      app_id: usage.current.app_id,
      app_name: usage.current.app_name,
      minutes: minutes(usage.current.seconds),
      class: usage.current.class,
      since: usage.current.since,
    },
    top_apps: apps
      .filter((app) => minutes(app.seconds) > 0)
      .slice(0, MAX_DIGEST_APPS)
      .map((app) => ({
        app_id: app.app_id,
        app_name: app.app_name,
        minutes: minutes(app.seconds),
        class: dominantClass(app.classSeconds),
      })),
    app_count: apps.length,
    switches: usage.switches,
  };
}

function segmentUsageClass(segment: TimelineSegment, rules: CompiledSupervisionRules): UsageClass {
  const match = matchSegmentSupervisionRules(segment, rules);
  if (match.blacklisted) return "blacklist";
  if (match.risked) return "risk";
  if (match.targeted) return "target";
  if (match.whitelisted) return "whitelist";
  return "unclassified";
}

// The class holding most of an app's time; ties keep the higher-precedence class.
function dominantClass(classSeconds: Record<UsageClass, number>): UsageClass {
  let best: UsageClass = "unclassified";
  let bestSeconds = 0;
  for (const usageClass of USAGE_CLASSES) {
    if (classSeconds[usageClass] > bestSeconds) {
      best = usageClass;
      bestSeconds = classSeconds[usageClass];
    }
  }
  return best;
}

function compareDevices(left: DeviceUsage, right: DeviceUsage, preferDeviceId?: string): number {
  if (preferDeviceId) {
    if (left.deviceId === preferDeviceId && right.deviceId !== preferDeviceId) return -1;
    if (right.deviceId === preferDeviceId && left.deviceId !== preferDeviceId) return 1;
  }
  return right.seconds - left.seconds || left.deviceId.localeCompare(right.deviceId);
}

function emptyClassSeconds(): Record<UsageClass, number> {
  return { blacklist: 0, risk: 0, target: 0, whitelist: 0, unclassified: 0 };
}

function minutes(seconds: number): number {
  return Math.round(seconds / 60);
}

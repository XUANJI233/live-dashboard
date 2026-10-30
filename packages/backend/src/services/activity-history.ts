import { createHash } from "node:crypto";
import {
  HISTORY_DURATION_RULE,
  getHistoryDevice,
  historyTimelineSegment,
  loadActivityExtras,
  loadHistory,
  type DeviceHistory,
  type HistoryFilters,
  type HistorySegment,
  type HistoryWindow,
} from "./activity-history-engine";
import {
  formatControllerMinute,
  localDayStartMs,
  localHourStartMs,
  parseControllerTime,
  resolveControllerTimezone,
  type ControllerTimezone,
} from "./controller-timezone";
import { cleanLooseIdentifier } from "./mcp-contracts";
import { promptText } from "./prompt-text";
import { buildTimelinePromptDocument } from "./timeline-prompt";

export const ACTIVITY_HISTORY_SCHEMA = "live_dashboard.activity_history.v1";
const MAX_RANGE_DAYS = 14;
const RETENTION_DAYS = 7;
const MAX_DEVICES = 12;
const USAGE_DEFAULT_LIMIT = 30;
const USAGE_MAX_LIMIT = 100;
const TIMELINE_DEFAULT_LIMIT = 20;
const TIMELINE_MAX_LIMIT = 60;
const MAX_ITEMS_PER_SESSION = 8;
const DAY_MS = 24 * 60 * 60_000;

export type ActivityHistoryView = "usage" | "timeline";
export type ActivityHistoryGroupBy = "app" | "title" | "day" | "hour";
export type ActivityHistoryOrder = "newest_first" | "oldest_first";

export interface ActivityHistoryArgs {
  view: ActivityHistoryView;
  start: string;
  end?: string;
  device_id?: string;
  app?: string;
  package?: string;
  title_contains?: string;
  group_by?: ActivityHistoryGroupBy;
  order?: ActivityHistoryOrder;
  limit?: number;
  cursor?: string;
  timezone_offset_minutes?: number;
}

interface HistoryCursor {
  fingerprint: string;
  endMs: number;
  nowMs: number;
  offset: number;
  after: [number, string, number] | null;
}

interface HistoryQuery {
  view: ActivityHistoryView;
  timezone: ControllerTimezone;
  window: HistoryWindow;
  requestedEndMs: number;
  deviceId: string;
  filters: HistoryFilters;
  hasFilters: boolean;
  groupBy: ActivityHistoryGroupBy;
  order: ActivityHistoryOrder;
  limit: number;
  fingerprint: string;
  cursor: HistoryCursor | null;
}

/** Answers history questions from stored activity: totals are complete, lists are paged. */
export function getActivityHistory(args: ActivityHistoryArgs, now = new Date()): Record<string, unknown> {
  const query = historyQuery(args, now);
  const histories = loadHistory({ window: query.window, deviceId: query.deviceId || undefined, filters: query.filters })
    .filter((history) => history.segments.length > 0 || history.device.device_id === query.deviceId);
  const coverage = histories.map((history) => deviceCoverage(history, query));
  const matchedSeconds = histories.reduce((total, history) => total + sumSeconds(history.segments.filter((segment) => segment.matched)), 0);
  const matchedSessions = histories.reduce((total, history) => total + sessionCount(history.segments.filter((segment) => segment.matched)), 0);
  const envelope = {
    schema: ACTIVITY_HISTORY_SCHEMA,
    view: query.view,
    timezone: query.timezone,
    range: {
      start: new Date(query.window.startMs).toISOString(),
      end: new Date(query.window.endMs).toISOString(),
      start_local: formatControllerMinute(query.window.startMs, query.timezone.offset_minutes),
      end_local: formatControllerMinute(query.window.endMs, query.timezone.offset_minutes),
      end_clamped_to_now: query.requestedEndMs > query.window.nowMs,
    },
    retention: {
      oldest_local: formatControllerMinute(query.window.nowMs - RETENTION_DAYS * DAY_MS, query.timezone.offset_minutes),
      before_retention: query.window.startMs < query.window.nowMs - RETENTION_DAYS * DAY_MS,
    },
    filters: {
      device_id: query.deviceId || null,
      app: query.filters.app ?? null,
      package: query.filters.package ?? null,
      title_contains: query.filters.titleContains ?? null,
    },
    rule: HISTORY_DURATION_RULE,
    devices: coverage.slice(0, MAX_DEVICES),
    devices_truncated: coverage.length > MAX_DEVICES,
    totals: { matched_minutes: minutes(matchedSeconds), matched_sessions: matchedSessions },
  };
  return query.view === "usage"
    ? { ...envelope, ...usageView(histories, query) }
    : { ...envelope, ...timelineView(histories, query) };
}

function historyQuery(args: ActivityHistoryArgs, now: Date): HistoryQuery {
  const timezone = resolveControllerTimezone(args.timezone_offset_minutes);
  const offset = timezone.offset_minutes;
  const view = args.view === "timeline" ? "timeline" : "usage";
  const filters: HistoryFilters = {
    ...(filterText(args.app, 64) ? { app: filterText(args.app, 64) } : {}),
    ...(filterText(args.package, 160) ? { package: filterText(args.package, 160) } : {}),
    ...(filterText(args.title_contains, 80) ? { titleContains: filterText(args.title_contains, 80) } : {}),
  };
  const deviceId = cleanLooseIdentifier(args.device_id ?? "", 160);
  const groupBy = view === "usage" ? args.group_by ?? "app" : "app";
  const order = view === "timeline" ? args.order ?? "newest_first" : "newest_first";
  const startMs = parseControllerTime(String(args.start ?? ""), offset);
  const fingerprint = createHash("sha256").update(JSON.stringify([
    view, startMs, args.end ?? null, deviceId, filters, groupBy, order, offset,
  ])).digest("hex").slice(0, 16);
  const cursor = args.cursor ? decodeCursor(args.cursor, fingerprint) : null;
  const nowMs = cursor?.nowMs ?? now.getTime();
  const requestedEndMs = cursor?.endMs ?? (args.end ? parseControllerTime(args.end, offset) : nowMs);
  if (requestedEndMs <= startMs) throw new Error("invalid_time_range");
  if (requestedEndMs - startMs > MAX_RANGE_DAYS * DAY_MS) throw new Error("time_range_too_large");
  if (deviceId && !getHistoryDevice(deviceId)) throw new Error("device_not_found");
  const maxLimit = view === "usage" ? USAGE_MAX_LIMIT : TIMELINE_MAX_LIMIT;
  const defaultLimit = view === "usage" ? USAGE_DEFAULT_LIMIT : TIMELINE_DEFAULT_LIMIT;
  return {
    view,
    timezone,
    window: { startMs, endMs: Math.max(startMs, Math.min(requestedEndMs, nowMs)), nowMs },
    requestedEndMs,
    deviceId,
    filters,
    hasFilters: Object.keys(filters).length > 0,
    groupBy,
    order,
    limit: Number.isInteger(args.limit) ? Math.min(maxLimit, Math.max(1, args.limit!)) : defaultLimit,
    fingerprint,
    cursor,
  };
}

function deviceCoverage(history: DeviceHistory, query: HistoryQuery): Record<string, unknown> {
  const seconds = { active: 0, away: 0 };
  for (const segment of history.segments) seconds[segment.kind] += segment.seconds;
  const matched = history.segments.filter((segment) => segment.matched);
  const windowSeconds = (query.window.endMs - query.window.startMs) / 1_000;
  const last = history.segments.at(-1);
  return {
    device_id: promptText(history.device.device_id, 160),
    device_name: promptText(history.device.device_name, 80) || promptText(history.device.device_id, 80),
    platform: promptText(history.device.platform, 40),
    active_minutes: minutes(seconds.active),
    idle_minutes: minutes(seconds.away),
    unobserved_minutes: minutes(Math.max(0, windowSeconds - seconds.active - seconds.away)),
    matched_minutes: minutes(sumSeconds(matched)),
    matched_sessions: sessionCount(matched),
    open: last?.open
      ? {
        app_name: promptText(last.app_name, 60),
        kind: last.kind,
        since_local: formatControllerMinute(last.session_start_ms, query.timezone.offset_minutes),
      }
      : null,
  };
}

interface AppGroup {
  device_id: string;
  app_id: string;
  app_name: string;
  title: string;
  seconds: number;
  sessions: Set<string>;
  first_start_ms: number;
  last_start_ms: number;
  last_end_ms: number;
  open: boolean;
}

interface BucketGroup {
  device_id: string;
  bucket_ms: number;
  seconds: number;
  idle: number;
  observed: number;
  apps: Map<string, { app_name: string; seconds: number }>;
}

function usageView(histories: DeviceHistory[], query: HistoryQuery): Record<string, unknown> {
  const groups = query.groupBy === "app" || query.groupBy === "title"
    ? appGroups(histories, query)
    : bucketGroups(histories, query);
  const offset = query.cursor?.offset ?? 0;
  const page = groups.slice(offset, offset + query.limit);
  const nextOffset = offset + page.length;
  return {
    group_by: query.groupBy,
    group_count: groups.length,
    returned_group_count: page.length,
    truncated: groups.length > nextOffset,
    next_cursor: groups.length > nextOffset ? encodeCursor(query, { offset: nextOffset, after: null }) : null,
    groups: page,
  };
}

function appGroups(histories: DeviceHistory[], query: HistoryQuery): Record<string, unknown>[] {
  const byTitle = query.groupBy === "title";
  const groups = new Map<string, AppGroup>();
  for (const history of histories) {
    for (const segment of history.segments) {
      if (!segment.matched) continue;
      const title = byTitle ? segment.display_title : "";
      const key = [segment.device_id, segment.app_id, segment.app_name, title].join("\u0000");
      const group = groups.get(key) ?? {
        device_id: segment.device_id,
        app_id: segment.app_id,
        app_name: segment.app_name,
        title,
        seconds: 0,
        sessions: new Set<string>(),
        first_start_ms: segment.session_start_ms,
        last_start_ms: segment.session_start_ms,
        last_end_ms: segment.clip_end_ms,
        open: false,
      };
      group.seconds += segment.seconds;
      group.sessions.add(segment.session_id);
      group.first_start_ms = Math.min(group.first_start_ms, segment.session_start_ms);
      group.last_start_ms = Math.max(group.last_start_ms, segment.session_start_ms);
      group.last_end_ms = Math.max(group.last_end_ms, segment.clip_end_ms);
      group.open ||= segment.open;
      groups.set(key, group);
    }
  }
  const offset = query.timezone.offset_minutes;
  return Array.from(groups.values())
    .sort((left, right) => right.seconds - left.seconds
      || left.device_id.localeCompare(right.device_id)
      || left.app_name.localeCompare(right.app_name)
      || left.title.localeCompare(right.title))
    .map((group) => ({
      device_id: promptText(group.device_id, 160),
      app_name: promptText(group.app_name, 60) || promptText(group.app_id, 60),
      app_id: promptText(group.app_id, 160),
      ...(byTitle ? { title: promptText(group.title, 120) } : {}),
      minutes: minutes(group.seconds),
      sessions: group.sessions.size,
      first_start_local: formatControllerMinute(group.first_start_ms, offset),
      last_start_local: formatControllerMinute(group.last_start_ms, offset),
      last_end_local: formatControllerMinute(group.last_end_ms, offset),
      open: group.open,
      started_before_range: group.first_start_ms < query.window.startMs,
    }));
}

function bucketGroups(histories: DeviceHistory[], query: HistoryQuery): Record<string, unknown>[] {
  const offset = query.timezone.offset_minutes;
  const daily = query.groupBy === "day";
  const bucketStart = (ms: number) => daily ? localDayStartMs(ms, offset) : localHourStartMs(ms, offset);
  const bucketLength = daily ? DAY_MS : 60 * 60_000;
  const groups = new Map<string, BucketGroup>();
  for (const history of histories) {
    for (const segment of history.segments) {
      let pieceStart = segment.clip_start_ms;
      while (pieceStart < segment.clip_end_ms) {
        const bucketMs = bucketStart(pieceStart);
        const pieceEnd = Math.min(segment.clip_end_ms, bucketMs + bucketLength);
        const seconds = (pieceEnd - pieceStart) / 1_000;
        const key = `${segment.device_id}\u0000${bucketMs}`;
        const group = groups.get(key) ?? {
          device_id: segment.device_id,
          bucket_ms: bucketMs,
          seconds: 0,
          idle: 0,
          observed: 0,
          apps: new Map(),
        };
        group.observed += seconds;
        if (segment.kind === "away") group.idle += seconds;
        if (segment.matched) {
          group.seconds += seconds;
          const appKey = `${segment.app_id}\u0000${segment.app_name}`;
          const app = group.apps.get(appKey) ?? { app_name: segment.app_name || segment.app_id, seconds: 0 };
          app.seconds += seconds;
          group.apps.set(appKey, app);
        }
        groups.set(key, group);
        pieceStart = pieceEnd;
      }
    }
  }
  // With filters a bucket is listed only when something matched; without them any report lists it.
  return Array.from(groups.values())
    .filter((group) => !query.hasFilters || group.seconds > 0)
    .sort((left, right) => left.bucket_ms - right.bucket_ms || left.device_id.localeCompare(right.device_id))
    .map((group) => {
      const span = (Math.min(group.bucket_ms + bucketLength, query.window.endMs) - Math.max(group.bucket_ms, query.window.startMs)) / 1_000;
      const topApp = Array.from(group.apps.values()).sort((left, right) => right.seconds - left.seconds)[0];
      const label = formatControllerMinute(group.bucket_ms, offset);
      return {
        device_id: promptText(group.device_id, 160),
        bucket: daily ? label.slice(0, 10) : `${label.slice(0, 13)}:00`,
        minutes: minutes(group.seconds),
        top_app: topApp ? { app_name: promptText(topApp.app_name, 60), minutes: minutes(topApp.seconds) } : null,
        idle_minutes: minutes(group.idle),
        unobserved_minutes: minutes(Math.max(0, span - group.observed)),
      };
    });
}

interface SessionRef {
  key: [number, string, number];
  segments: HistorySegment[];
  deviceName: string;
}

function timelineView(histories: DeviceHistory[], query: HistoryQuery): Record<string, unknown> {
  const sessions = new Map<string, SessionRef>();
  for (const history of histories) {
    for (const segment of history.segments) {
      // Unfiltered timelines keep idle spans so the day reads in order; filters keep only matches.
      if (query.hasFilters && !segment.matched) continue;
      const ref = sessions.get(segment.session_id) ?? {
        key: [segment.session_start_ms, segment.device_id, sessionRowId(segment.session_id)] as [number, string, number],
        segments: [],
        deviceName: history.device.device_name,
      };
      ref.segments.push(segment);
      sessions.set(segment.session_id, ref);
    }
  }
  const direction = query.order === "oldest_first" ? 1 : -1;
  const ordered = Array.from(sessions.values()).sort((left, right) => direction * compareSessionKeys(left.key, right.key));
  const after = query.cursor?.after;
  const remaining = after ? ordered.filter((session) => direction * compareSessionKeys(session.key, after) > 0) : ordered;
  const page = remaining.slice(0, query.limit);
  const hasMore = remaining.length > page.length;
  const segments = page.flatMap((session) => session.segments.map((segment) => ({ segment, deviceName: session.deviceName })));
  const extras = loadActivityExtras(segments.map(({ segment }) => segment.id));
  const document = buildTimelinePromptDocument(
    segments.map(({ segment, deviceName }) => historyTimelineSegment(segment, deviceName, extras.get(segment.id))),
    { label: "activity_history", tzOffsetMinutes: query.timezone.offset_minutes, maxItemsPerSession: MAX_ITEMS_PER_SESSION },
  );
  const last = page.at(-1);
  return {
    order: query.order,
    session_count: page.length,
    has_more: hasMore,
    next_cursor: hasMore && last ? encodeCursor(query, { offset: 0, after: last.key }) : null,
    timeline: document,
  };
}

function compareSessionKeys(left: [number, string, number], right: [number, string, number]): number {
  return left[0] - right[0] || left[1].localeCompare(right[1]) || left[2] - right[2];
}

function sessionRowId(sessionId: string): number {
  return Number.parseInt(sessionId.slice(sessionId.lastIndexOf("#") + 1), 10) || 0;
}

function encodeCursor(query: HistoryQuery, position: { offset: number; after: [number, string, number] | null }): string {
  return Buffer.from(JSON.stringify({
    v: 1,
    f: query.fingerprint,
    e: query.requestedEndMs,
    n: query.window.nowMs,
    ...(position.after ? { a: position.after } : { o: position.offset }),
  }), "utf8").toString("base64url");
}

function decodeCursor(value: string, fingerprint: string): HistoryCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    const after = parsed.a;
    const validAfter = Array.isArray(after) && after.length === 3
      && Number.isFinite(after[0]) && typeof after[1] === "string" && Number.isInteger(after[2]);
    const validOffset = Number.isInteger(parsed.o) && Number(parsed.o) >= 0;
    if (
      parsed.v !== 1 || parsed.f !== fingerprint
      || !Number.isFinite(parsed.e) || !Number.isFinite(parsed.n)
      || (!validAfter && !validOffset)
    ) {
      throw new Error("invalid_cursor");
    }
    return {
      fingerprint,
      endMs: Number(parsed.e),
      nowMs: Number(parsed.n),
      offset: validOffset ? Number(parsed.o) : 0,
      after: validAfter ? after as [number, string, number] : null,
    };
  } catch {
    throw new Error("invalid_cursor");
  }
}

function sumSeconds(segments: HistorySegment[]): number {
  return segments.reduce((total, segment) => total + segment.seconds, 0);
}

function sessionCount(segments: HistorySegment[]): number {
  return new Set(segments.map((segment) => segment.session_id)).size;
}

function filterText(value: string | undefined, maxLength: number): string {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, maxLength) : "";
}

/** One decimal, rounded once from the summed seconds. */
function minutes(seconds: number): number {
  return Math.round(seconds / 6) / 10;
}

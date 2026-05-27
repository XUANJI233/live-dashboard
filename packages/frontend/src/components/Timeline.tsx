"use client";

import { useMemo, useState } from "react";
import type { TimelineSegment } from "@/lib/api";
import { getAppDescription } from "@/lib/app-descriptions";

const APP_COLORS = [
  "#E8A0BF", "#88C9C9", "#E8B86D", "#C4A882", "#D4917B",
  "#A8C686", "#D4A0A0", "#8CB8B0", "#C9B97A", "#B89EC4",
];

const MIN_VISIBLE_SECONDS = 10;
const IDLE_VISIBLE_SECONDS = 10 * 60;
const SWITCH_WINDOW_SECONDS = 5 * 60;

interface Props {
  segments: TimelineSegment[];
  summary: Record<string, Record<string, number>>;
  currentAppByDevice: Record<string, string>;
}

type TimelineEvent = {
  key: string;
  kind: "single" | "switching";
  appName: string;
  appId: string;
  title: string;
  startedAt: string;
  endedAt: string | null;
  durationSeconds: number;
  isCurrent: boolean;
  children: TimelineSegment[];
};

export default function Timeline({ segments, currentAppByDevice }: Props) {
  const [openKeys, setOpenKeys] = useState<Record<string, boolean>>({});
  const colorMap = useMemo(() => new Map<string, string>(), []);
  const byDevice = useMemo(() => buildDeviceEvents(segments, currentAppByDevice), [segments, currentAppByDevice]);

  if (byDevice.length === 0) return null;

  return (
    <div className="space-y-6">
      {byDevice.map(({ deviceId, deviceName, events }) => (
        <section key={deviceId}>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
            {deviceName} 的小时间线
          </h3>
          <div className="max-h-[560px] overflow-y-auto pr-1 timeline-scroll">
            <div className="space-y-1">
              {events.map((event) => {
                const color = getAppColor(event.kind === "switching" ? "switching" : event.appName, colorMap);
                const isOpen = !!openKeys[event.key];
                const canOpen = event.children.length > 1 || hasUsefulChildDetail(event.children);
                return (
                  <div key={event.key} className={event.isCurrent ? "timeline-active rounded" : ""}>
                    <button
                      type="button"
                      className="timeline-bar flex w-full items-center text-left"
                      onClick={() => {
                        if (canOpen) setOpenKeys((prev) => ({ ...prev, [event.key]: !prev[event.key] }));
                      }}
                    >
                      <div className="flex w-16 flex-shrink-0 items-center justify-center gap-1 px-2 py-2">
                        {event.isCurrent ? (
                          <span className="current-badge text-[10px] font-bold text-[var(--color-primary)]">当前</span>
                        ) : (
                          <span className="h-2.5 w-2.5 flex-shrink-0 rounded-full" style={{ backgroundColor: color }} />
                        )}
                      </div>

                      <div
                        className="min-w-0 flex-1 px-3 py-2"
                        style={{ backgroundColor: event.isCurrent ? `${color}30` : `${color}15` }}
                      >
                        <span className="block truncate text-xs font-medium">{event.title}</span>
                        {event.kind === "switching" && (
                          <span className="block truncate text-[10px] text-[var(--color-text-muted)]">
                            {event.children.length} 次小切换收在这里了
                          </span>
                        )}
                      </div>

                      <div className="w-24 flex-shrink-0 px-2 py-2 text-right">
                        <span className="font-mono text-[10px] font-medium text-[var(--color-accent)]">
                          {formatDurationSeconds(event.durationSeconds)}
                        </span>
                        {canOpen && (
                          <span className="ml-1 text-[10px] text-[var(--color-text-muted)]">
                            {isOpen ? "收起" : "详情"}
                          </span>
                        )}
                      </div>
                    </button>

                    {canOpen && isOpen && (
                      <div className="ml-16 space-y-2 border-l border-[var(--color-border)] py-2 pl-3">
                        {compactChildren(event.children).map((child, index) => (
                          <div key={`${child.started_at}-${index}`} className="text-xs">
                            <div className="flex items-center justify-between gap-3">
                              <span className="font-mono text-[10px] text-[var(--color-text-muted)]">
                                {formatClock(child.started_at)}
                                {child.ended_at ? ` - ${formatClock(child.ended_at)}` : ""}
                              </span>
                              <span className="font-mono text-[10px] text-[var(--color-accent)]">
                                {formatDurationSeconds(durationSeconds(child))}
                              </span>
                            </div>
                            <div className="mt-0.5 truncate text-[var(--color-text)]" title={describeChild(child)}>
                              {describeChild(child)}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </section>
      ))}
    </div>
  );
}

function buildDeviceEvents(segments: TimelineSegment[], currentAppByDevice: Record<string, string>) {
  const byDevice = new Map<string, { deviceName: string; segments: TimelineSegment[] }>();
  for (const seg of segments) {
    if (!isUsefulSegment(seg)) continue;
    const entry = byDevice.get(seg.device_id) || { deviceName: seg.device_name, segments: [] };
    entry.segments.push(seg);
    byDevice.set(seg.device_id, entry);
  }

  return Array.from(byDevice.entries()).map(([deviceId, entry]) => {
    const sorted = entry.segments.sort((a, b) => new Date(a.started_at).getTime() - new Date(b.started_at).getTime());
    const events: TimelineEvent[] = [];
    let i = 0;
    while (i < sorted.length) {
      const cluster = collectSwitchCluster(sorted, i);
      if (cluster.length >= 3) {
        const first = cluster[0]!;
        const last = cluster[cluster.length - 1]!;
        events.push({
          key: `${deviceId}:switch:${first.started_at}`,
          kind: "switching",
          appName: "滑来滑去",
          appId: "switching",
          title: "正在滑来滑去喵~",
          startedAt: first.started_at,
          endedAt: last.ended_at,
          durationSeconds: spanSeconds(cluster),
          isCurrent: cluster.some((seg) => currentAppByDevice[deviceId] === seg.app_name),
          children: cluster,
        });
        i += cluster.length;
        continue;
      }

      const seg = sorted[i]!;
      const title = describeSegment(seg);
      events.push({
        key: `${deviceId}:${seg.started_at}:${seg.app_id}`,
        kind: "single",
        appName: seg.app_name,
        appId: seg.app_id,
        title,
        startedAt: seg.started_at,
        endedAt: seg.ended_at,
        durationSeconds: durationSeconds(seg),
        isCurrent: currentAppByDevice[deviceId] === seg.app_name,
        children: meaningfulDetailTitle(seg) ? [seg] : [],
      });
      i += 1;
    }

    events.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
    events.sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent));
    return { deviceId, deviceName: entry.deviceName, events };
  }).filter((entry) => entry.events.length > 0);
}

function collectSwitchCluster(segments: TimelineSegment[], startIndex: number) {
  const first = segments[startIndex]!;
  const cluster = [first];
  const startMs = new Date(first.started_at).getTime();
  let previousApp = first.app_name;
  let changed = false;

  for (let i = startIndex + 1; i < segments.length; i += 1) {
    const next = segments[i]!;
    const nextStart = new Date(next.started_at).getTime();
    if (Number.isNaN(nextStart) || nextStart - startMs > SWITCH_WINDOW_SECONDS * 1000) break;
    if (durationSeconds(next) >= SWITCH_WINDOW_SECONDS) break;
    if (next.app_name !== previousApp) changed = true;
    previousApp = next.app_name;
    cluster.push(next);
  }

  return changed ? cluster : [first];
}

function isUsefulSegment(seg: TimelineSegment) {
  if (isLauncherSegment(seg)) return false;
  const seconds = durationSeconds(seg);
  if (isIdleSegment(seg)) return seconds >= IDLE_VISIBLE_SECONDS;
  return seconds >= MIN_VISIBLE_SECONDS || seconds === 0;
}

function durationSeconds(seg: TimelineSegment) {
  if (typeof seg.duration_seconds === "number") return Math.max(0, seg.duration_seconds);
  return Math.max(0, Math.round((seg.duration_minutes || 0) * 60));
}

function spanSeconds(segments: TimelineSegment[]) {
  const first = segments[0];
  const last = segments[segments.length - 1];
  if (!first || !last) return 0;
  const start = new Date(first.started_at).getTime();
  const end = new Date(last.ended_at || last.started_at).getTime();
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) {
    return segments.reduce((sum, seg) => sum + durationSeconds(seg), 0);
  }
  return Math.max(0, Math.round((end - start) / 1000));
}

function describeSegment(seg: TimelineSegment) {
  if (isIdleSegment(seg)) return "暂时离开了一会儿喵~";
  return getAppDescription(seg.app_name, seg.display_title);
}

function describeChild(seg: TimelineSegment) {
  return meaningfulDetailTitle(seg) || describeSegment(seg);
}

function meaningfulDetailTitle(seg: TimelineSegment) {
  const title = (seg.display_title || "").trim();
  if (!title) return "";
  const normalized = title.toLowerCase();
  const app = seg.app_name.toLowerCase();
  if (normalized === app || normalized === "android" || normalized.endsWith("activity")) return "";
  if (title === `正在用${seg.app_name}` || title.startsWith("正在用系统桌面")) return "";
  return title;
}

function compactChildren(children: TimelineSegment[]) {
  const compacted: TimelineSegment[] = [];
  for (const child of children) {
    const previous = compacted[compacted.length - 1];
    if (previous && previous.app_name === child.app_name && (previous.display_title || "") === (child.display_title || "")) {
      previous.ended_at = child.ended_at || previous.ended_at;
      previous.duration_seconds = durationSeconds(previous) + durationSeconds(child);
      previous.duration_minutes = Math.round(previous.duration_seconds / 60);
    } else {
      compacted.push({ ...child });
    }
  }
  return compacted;
}

function hasUsefulChildDetail(children: TimelineSegment[]) {
  return children.some((child) => !!meaningfulDetailTitle(child));
}

function isIdleSegment(seg: TimelineSegment) {
  return `${seg.app_name} ${seg.app_id}`.toLowerCase().includes("idle");
}

function isLauncherSegment(seg: TimelineSegment) {
  const app = `${seg.app_name} ${seg.app_id} ${seg.display_title || ""}`.toLowerCase();
  return app.includes("launcher") ||
    app.includes("systemui") ||
    app.includes("桌面") ||
    app.includes("主屏幕") ||
    app.includes("home screen");
}

function getAppColor(appName: string, colorMap: Map<string, string>): string {
  const existing = colorMap.get(appName);
  if (existing) return existing;
  const color = APP_COLORS[colorMap.size % APP_COLORS.length]!;
  colorMap.set(appName, color);
  return color;
}

function formatDurationSeconds(seconds: number): string {
  if (seconds < 60) return "不到 1 分钟";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h} 小时 ${m} 分钟` : `${h} 小时`;
}

function formatClock(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--:--";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

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
const SWITCH_GAP_SECONDS = 90;
const SWITCH_MAX_SEGMENT_SECONDS = 90;
const MIN_CLUSTER_SIZE = 3;

interface Props {
  segments: TimelineSegment[];
  summary: Record<string, Record<string, number>>;
  currentAppByDevice: Record<string, string>;
  onlineDevices?: Set<string>;
  loading?: boolean;
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

export default function Timeline({ segments, currentAppByDevice, onlineDevices, loading }: Props) {
  const [openKeys, setOpenKeys] = useState<Record<string, boolean>>({});
  const colorMap = useMemo(() => new Map<string, string>(), []);
  const byDevice = useMemo(
    () => buildDeviceEvents(segments, currentAppByDevice, onlineDevices),
    [segments, currentAppByDevice, onlineDevices],
  );

  if (byDevice.length === 0) {
    if (loading) {
      return (
        <div className="text-center py-16">
          <div className="loading-dots"><span></span><span></span><span></span></div>
          <p className="text-sm text-[var(--color-text-muted)] mt-3">加载中...</p>
        </div>
      );
    }
    return (
      <div className="text-center py-16">
        <p className="text-2xl opacity-40 mb-3">( ^-ω-^ )</p>
        <p className="text-sm text-[var(--color-text-muted)]">今天还没有活动记录呢~</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {byDevice.map(({ deviceId, deviceName, events }) => (
        <section key={deviceId}>
          <h3 className="mb-2 text-[11px] font-semibold text-[var(--color-text-muted)] uppercase tracking-[0.15em]">
            {deviceName}
          </h3>
          <div className="max-h-[560px] overflow-y-auto pr-1 timeline-scroll">
            <div className="space-y-1.5">
              {events.map((event) => {
                const color = getAppColor(
                  event.kind === "switching" ? "switching" : event.appName,
                  colorMap,
                );
                const isOpen = !!openKeys[event.key];
                const canOpen = event.children.length > 1 || hasUsefulChildDetail(event.children);
                return (
                  <div key={event.key} className={`timeline-entry glass-sm rounded ${event.isCurrent ? "timeline-active-glow" : ""}`}>
                    <button type="button" className="flex w-full items-center text-left group" onClick={() => { if (canOpen) setOpenKeys((prev) => ({ ...prev, [event.key]: !prev[event.key] })); }}>
                      <div className="flex w-12 flex-shrink-0 items-center justify-center px-2 py-2.5">
                        {event.isCurrent ? (
                          <span className="text-[10px] font-bold text-[var(--color-accent)] tracking-wider">当前</span>
                        ) : (
                          <span className="h-2.5 w-2.5 flex-shrink-0 rounded-full" style={{ backgroundColor: color }} />
                        )}
                      </div>
                      <div className="min-w-0 flex-1 px-3 py-2.5">
                        <span className="block truncate text-sm text-[var(--color-text)]">{event.title}</span>
                        {event.kind === "switching" && (
                          <span className="block truncate text-[10px] text-[var(--color-text-muted)]">{event.children.length} 次小切换收在这里了</span>
                        )}
                      </div>
                      <div className="w-28 flex-shrink-0 px-2 py-2.5 text-right flex items-center justify-end gap-1">
                        <span className="font-mono text-[11px] text-[var(--color-text-muted)] tabular-nums">{formatTimeRange(event.startedAt, event.endedAt, isDeviceOffline(deviceId, onlineDevices))}</span>
                        {canOpen && (
                          <span className="text-[10px] text-[var(--color-text-muted)] opacity-0 group-hover:opacity-100 transition-opacity">{isOpen ? "▲" : "▼"}</span>
                        )}
                      </div>
                    </button>
                    {canOpen && isOpen && (
                      <div className="ml-12 space-y-1 border-l-2 border-[var(--color-border)] py-2 pl-3 mr-3 mb-2">
                        {compactChildren(event.children).map((child, index) => (
                          <div key={`${child.started_at}-${index}`} className="text-xs">
                            <div className="flex items-center justify-between gap-3">
                              <span className="font-mono text-[10px] text-[var(--color-text-muted)]">{formatTimeRange(child.started_at, child.ended_at, isDeviceOffline(deviceId, onlineDevices))}</span>
                            </div>
                            <div className="mt-0.5 truncate text-[var(--color-text)] text-xs" title={describeChild(child)}>{describeChild(child)}</div>
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

function buildDeviceEvents(segments: TimelineSegment[], currentAppByDevice: Record<string, string>, onlineDevices?: Set<string>) {
  const byDevice = new Map<string, { deviceName: string; segments: TimelineSegment[] }>();
  for (const seg of segments) {
    if (!isUsefulSegment(seg)) continue;
    const entry = byDevice.get(seg.device_id) || { deviceName: seg.device_name, segments: [] };
    entry.segments.push(seg);
    byDevice.set(seg.device_id, entry);
  }
  return Array.from(byDevice.entries()).map(([deviceId, entry]) => {
    const sorted = compactChildren([...entry.segments].sort((a, b) => new Date(a.started_at).getTime() - new Date(b.started_at).getTime()));
    const events: TimelineEvent[] = [];
    let i = 0;
    while (i < sorted.length) {
      const current = sorted[i]!;
      const cluster = collectSwitchCluster(sorted, i);
      if (cluster.length >= MIN_CLUSTER_SIZE) {
        const first = cluster[0]!;
        const last = cluster[cluster.length - 1]!;
        events.push({ key: `${deviceId}:switch:${first.started_at}`, kind: "switching", appName: "切来切去", appId: "switching", title: "正在切来切去喵~", startedAt: first.started_at, endedAt: last.ended_at, durationSeconds: spanSeconds(cluster), isCurrent: isCurrentEvent(deviceId, last.ended_at, onlineDevices) && cluster.some((seg) => currentAppByDevice[deviceId] === seg.app_name), children: compactChildren(cluster) });
        i += cluster.length;
        continue;
      }
      const merged = collectSameState(sorted, i);
      const first = merged[0]!;
      const last = merged[merged.length - 1]!;
      events.push({
        key: `${deviceId}:${first.started_at}:${first.app_id}`,
        kind: "single",
        appName: first.app_name,
        appId: first.app_id,
        title: describeSegment(first),
        startedAt: first.started_at,
        endedAt: last.ended_at,
        durationSeconds: spanSeconds(merged),
        isCurrent: isCurrentEvent(deviceId, last.ended_at, onlineDevices) && currentAppByDevice[deviceId] === first.app_name,
        children: merged.length > 1 ? compactChildren(merged) : (meaningfulDetailTitle(first) ? [first] : []),
      });
      i += merged.length;
    }
    events.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
    events.sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent));
    return { deviceId, deviceName: entry.deviceName, events };
  }).filter((entry) => entry.events.length > 0);
}

function collectSwitchCluster(segments: TimelineSegment[], startIndex: number) {
  const first = segments[startIndex]!;
  if (!isSwitchNoiseSegment(first)) return [first];
  const cluster = [first];
  let previousApp = first.app_name;
  let previousEndMs = new Date(first.ended_at || first.started_at).getTime();
  let changed = false;
  for (let i = startIndex + 1; i < segments.length; i += 1) {
    const next = segments[i]!;
    if (!isSwitchNoiseSegment(next)) break;
    const nextStart = new Date(next.started_at).getTime();
    const gap = nextStart - previousEndMs;
    if (Number.isNaN(nextStart) || gap < 0 || gap > SWITCH_GAP_SECONDS * 1000) break;
    if (next.app_name !== previousApp) changed = true;
    previousApp = next.app_name;
    previousEndMs = new Date(next.ended_at || next.started_at).getTime();
    cluster.push(next);
  }
  return changed && cluster.length >= MIN_CLUSTER_SIZE ? cluster : [first];
}

function collectSameState(segments: TimelineSegment[], startIndex: number) {
  const first = segments[startIndex]!;
  const signature = segmentSignature(first);
  const merged = [first];
  for (let j = startIndex + 1; j < segments.length; j += 1) {
    const next = segments[j]!;
    if (segmentSignature(next) !== signature) break;
    merged.push(next);
  }
  return merged;
}

function segmentSignature(seg: TimelineSegment) {
  if (isIdleSegment(seg)) return "idle";
  return `${seg.app_id || seg.app_name}|${seg.app_name}|${meaningfulDetailTitle(seg) || ""}`;
}

function isSwitchNoiseSegment(seg: TimelineSegment) {
  if (isIdleSegment(seg) || isLauncherSegment(seg)) return false;
  if (meaningfulDetailTitle(seg)) return false;
  const seconds = durationSeconds(seg);
  return seconds > 0 && seconds <= SWITCH_MAX_SEGMENT_SECONDS;
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
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return segments.reduce((sum, seg) => sum + durationSeconds(seg), 0);
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
  const value = `${seg.app_name} ${seg.app_id}`.toLowerCase();
  return value.includes("idle") || value.includes("sleeping");
}

function isLauncherSegment(seg: TimelineSegment) {
  const app = `${seg.app_name} ${seg.app_id} ${seg.display_title || ""}`.toLowerCase();
  return app.includes("launcher") || app.includes("systemui") || app.includes("桌面") || app.includes("主屏幕") || app.includes("home screen");
}

function getAppColor(appName: string, colorMap: Map<string, string>): string {
  const existing = colorMap.get(appName);
  if (existing) return existing;
  const color = APP_COLORS[colorMap.size % APP_COLORS.length]!;
  colorMap.set(appName, color);
  return color;
}

function isDeviceOffline(deviceId: string, onlineDevices?: Set<string>) {
  return onlineDevices ? !onlineDevices.has(deviceId) : false;
}

function isCurrentEvent(deviceId: string, endedAt: string | null, onlineDevices?: Set<string>) {
  return !endedAt && !isDeviceOffline(deviceId, onlineDevices);
}

function formatTimeRange(startedAt: string, endedAt: string | null, isOffline?: boolean) {
  return `${formatClock(startedAt)} – ${endedAt ? formatClock(endedAt) : (isOffline ? "已离线" : "现在")}`;
}

function formatClock(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--:--";
  return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

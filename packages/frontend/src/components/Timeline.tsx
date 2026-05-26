"use client";

import { useState } from "react";
import type { TimelineSegment } from "@/lib/api";
import { getAppDescription } from "@/lib/app-descriptions";

// Warm color palette
const APP_COLORS = [
  "#E8A0BF", "#88C9C9", "#E8B86D", "#C4A882", "#D4917B",
  "#A8C686", "#D4A0A0", "#8CB8B0", "#C9B97A", "#B89EC4",
];

function getAppColor(appName: string, colorMap: Map<string, string>): string {
  const existing = colorMap.get(appName);
  if (existing) return existing;
  const color = APP_COLORS[colorMap.size % APP_COLORS.length]!;
  colorMap.set(appName, color);
  return color;
}

function formatDuration(minutes: number): string {
  if (minutes < 1) return "不到 1 分钟";
  if (minutes < 60) return `${minutes} 分钟`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h} 小时 ${m} 分钟` : `${h} 小时`;
}

interface AggregatedApp {
  appName: string;
  appId: string;
  displayTitle: string;
  totalMinutes: number;
  lastSeenAt: number; // timestamp ms
  isCurrent: boolean;
  sessions: TimelineSegment[];
}

interface Props {
  segments: TimelineSegment[];
  summary: Record<string, Record<string, number>>;
  currentAppByDevice: Record<string, string>; // device_id -> current app_name
}

export default function Timeline({ segments, summary, currentAppByDevice }: Props) {
  const [openKeys, setOpenKeys] = useState<Record<string, boolean>>({});
  const colorMap = new Map<string, string>();
  const visibleSegments = segments.filter((seg) => !isLauncherSegment(seg));

  if (visibleSegments.length === 0) return null;

  // Group by device
  const byDevice = new Map<string, { name: string; segs: TimelineSegment[] }>();
  for (const seg of visibleSegments) {
    let entry = byDevice.get(seg.device_id);
    if (!entry) {
      entry = { name: seg.device_name, segs: [] };
      byDevice.set(seg.device_id, entry);
    }
    entry.segs.push(seg);
  }

  return (
    <div className="space-y-6">
      {Array.from(byDevice.entries()).map(([deviceId, { name, segs }]) => {
        // Single-pass aggregation: collect last-seen time + display_title per app
        const appMap = new Map<string, AggregatedApp>();
        for (const seg of segs) {
          const existing = appMap.get(seg.app_name);
          const segTime = new Date(seg.started_at).getTime() || 0;
          if (existing) {
            existing.totalMinutes += seg.duration_minutes;
            existing.sessions.push(seg);
            if (segTime > existing.lastSeenAt) {
              existing.lastSeenAt = segTime;
              // Keep the most recent display_title
              if (seg.display_title) existing.displayTitle = seg.display_title;
            }
          } else {
            appMap.set(seg.app_name, {
              appName: seg.app_name,
              appId: seg.app_id,
              displayTitle: seg.display_title || "",
              totalMinutes: seg.duration_minutes,
              lastSeenAt: segTime,
              isCurrent: false,
              sessions: [seg],
            });
          }
        }

        // Prefer backend totals when they are available, but keep the local
        // filtered total so short app switches do not dominate the UI.
        const deviceSummary = summary[deviceId];
        if (deviceSummary) {
          for (const [app, mins] of Object.entries(deviceSummary)) {
            const entry = appMap.get(app);
            if (entry && mins >= 5) {
              entry.totalMinutes = mins;
            }
          }
        }

        // Mark current app
        const currentApp = currentAppByDevice[deviceId];
        if (currentApp) {
          const entry = appMap.get(currentApp);
          if (entry) entry.isCurrent = true;
        }

        // Sort: current first, then by lastSeenAt desc
        const sorted = Array.from(appMap.values()).sort((a, b) => {
          if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
          return b.lastSeenAt - a.lastSeenAt;
        });

        return (
          <div key={deviceId}>
            <h3 className="text-xs font-semibold mb-2 text-[var(--color-text-muted)] uppercase tracking-wider">
              {name} 的小时间线
            </h3>

            <div className="max-h-[400px] overflow-y-auto pr-1 timeline-scroll">
              <div className="space-y-1">
                {sorted.map((app) => {
                  const color = getAppColor(app.appName, colorMap);
                  const openKey = `${deviceId}:${app.appName}`;
                  const isOpen = !!openKeys[openKey];
                  return (
                    <div key={app.appName} className={app.isCurrent ? "timeline-active rounded" : ""}>
                      <button
                        type="button"
                        onClick={() => setOpenKeys((prev) => ({ ...prev, [openKey]: !prev[openKey] }))}
                        className="timeline-bar flex w-full items-center text-left"
                      >
                        {/* Current indicator or color dot */}
                        <div className="flex-shrink-0 w-16 px-2 py-2 flex items-center justify-center gap-1">
                          {app.isCurrent ? (
                            <span className="text-[10px] font-bold text-[var(--color-primary)] current-badge">
                              当前
                            </span>
                          ) : (
                            <span
                              className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                              style={{ backgroundColor: color }}
                            />
                          )}
                        </div>

                        <div
                          className="flex-1 px-3 py-2 min-w-0"
                          style={{ backgroundColor: app.isCurrent ? `${color}30` : `${color}15` }}
                        >
                          <span className="text-xs font-medium truncate block">
                            {getAppDescription(app.appName, app.displayTitle)}
                          </span>
                          {app.displayTitle && (
                            <span className="text-[10px] text-[var(--color-text-muted)] truncate block">
                              {app.displayTitle}
                            </span>
                          )}
                        </div>

                        <div className="flex-shrink-0 w-20 px-2 py-2 text-right">
                          <span className="text-[10px] font-mono text-[var(--color-accent)] font-medium">
                            {formatDuration(app.totalMinutes)}
                          </span>
                          <span className="ml-1 text-[10px] text-[var(--color-text-muted)]">
                            {isOpen ? "藏起来" : "看看"}
                          </span>
                        </div>
                      </button>

                      {isOpen && (
                        <div className="ml-16 border-l border-[var(--color-border)] pl-3 py-2 space-y-2">
                          {app.sessions
                            .slice()
                            .sort((a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime())
                            .map((session, index) => (
                              <div key={`${session.started_at}-${index}`} className="text-xs">
                                <div className="flex items-center justify-between gap-3">
                                  <span className="font-mono text-[10px] text-[var(--color-text-muted)]">
                                    {formatClock(session.started_at)}
                                    {session.ended_at ? ` - ${formatClock(session.ended_at)}` : ""}
                                  </span>
                                  <span className="font-mono text-[10px] text-[var(--color-accent)]">
                                    {formatDuration(session.duration_minutes)}
                                  </span>
                                </div>
                                <div className="mt-0.5 truncate text-[var(--color-text)]" title={session.display_title || session.app_id}>
                                  {session.display_title || session.app_id || "悄悄路过的一小段"}
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
          </div>
        );
      })}
    </div>
  );
}

function isLauncherSegment(seg: TimelineSegment) {
  const app = `${seg.app_name} ${seg.app_id}`.toLowerCase();
  return app.includes("launcher") ||
    app.includes("systemui") ||
    app.includes("桌面") ||
    app.includes("主屏幕") ||
    app.includes("home screen");
}

function formatClock(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--:--";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

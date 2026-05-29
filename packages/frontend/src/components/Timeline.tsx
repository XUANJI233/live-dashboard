import type { TimelineSegment } from "@/lib/api";
import { getAppDescription } from "@/lib/app-descriptions";

const PALETTE = [
  "#ff6b9d", "#c084fc", "#67e8f9", "#fbbf24", "#6ee7b7",
  "#f97316", "#a78bfa", "#38bdf8", "#e879f9", "#4ade80",
];

function getColor(appName: string, colorMap: Map<string, string>): string {
  const existing = colorMap.get(appName);
  if (existing) return existing;
  const color = PALETTE[colorMap.size % PALETTE.length]!;
  colorMap.set(appName, color);
  return color;
}

function formatTime(isoStr: string): string {
  const d = new Date(isoStr);
  if (isNaN(d.getTime())) return "--:--";
  return d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

interface Props {
  segments: TimelineSegment[];
  summary: Record<string, Record<string, number>>;
  currentAppByDevice: Record<string, string>;
}

export default function Timeline({ segments, summary, currentAppByDevice }: Props) {
  const colorMap = new Map<string, string>();

  if (segments.length === 0) {
    return (
      <div className="text-center py-16">
        <p className="text-2xl opacity-40 mb-3">( ^-ω-^ )</p>
        <p className="text-sm text-[var(--color-text-muted)]">No activity recorded yet</p>
      </div>
    );
  }

  // Group by device
  const byDevice = new Map<string, { name: string; segs: TimelineSegment[] }>();
  for (const seg of segments) {
    let entry = byDevice.get(seg.device_id);
    if (!entry) {
      entry = { name: seg.device_name, segs: [] };
      byDevice.set(seg.device_id, entry);
    }
    entry.segs.push(seg);
  }

  return (
    <div className="space-y-8">
      {Array.from(byDevice.entries()).map(([deviceId, { name, segs }]) => {
          const currentApp = currentAppByDevice[deviceId];
          // Sort segments by start time, newest first
          const sorted = [...segs].sort((a, b) => {
            return new Date(b.started_at).getTime() - new Date(a.started_at).getTime();
          });

        return (
          <div key={deviceId}>
            <h3 className="text-[11px] font-semibold text-[var(--color-text-muted)] uppercase tracking-[0.15em] mb-3">
              {name}
            </h3>

            <div className="space-y-1.5 max-h-[420px] overflow-y-auto pr-1">
                {sorted.map((seg) => {
                  const color = getColor(seg.app_name, colorMap);
                  const isCurrent = seg.app_name === currentApp && !seg.ended_at;
                  const timeRange = `${formatTime(seg.started_at)} – ${seg.ended_at ? formatTime(seg.ended_at) : "Now"}`;

                return (
                  <div
                      key={`${seg.app_name}-${seg.started_at}`}
                    className={`timeline-entry glass-sm flex items-center gap-3 px-4 py-2.5 group ${
                        isCurrent ? "timeline-active-glow" : ""
                    }`}
                  >
                    {/* Color accent bar */}
                    <div
                      className="w-1 self-stretch rounded-full flex-shrink-0 transition-opacity group-hover:opacity-100"
                        style={{ backgroundColor: color, opacity: isCurrent ? 1 : 0.5 }}
                    />

                    {/* Current badge or spacer */}
                    <div className="w-10 flex-shrink-0">
                        {isCurrent && (
                        <span className="text-[10px] font-semibold text-[var(--color-accent)] uppercase tracking-wider">
                          Now
                        </span>
                      )}
                    </div>

                    {/* Description */}
                    <div className="flex-1 min-w-0">
                      <span className="text-sm truncate block text-[var(--color-text)]">
                        {getAppDescription(seg.app_name, seg.display_title || "")}
                      </span>
                    </div>

                    {/* Time range */}
                    <span className="text-[11px] font-mono text-[var(--color-text-muted)] tabular-nums flex-shrink-0">
                      {timeRange}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

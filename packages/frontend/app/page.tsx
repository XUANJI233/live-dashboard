"use client";

import { useEffect, useMemo, useState } from "react";
import { useDashboard } from "@/hooks/useDashboard";
import { useConfig, useConfigLoader, ConfigContext } from "@/hooks/useConfig";
import type { DeviceState, HealthRecord } from "@/lib/api";
import { fetchHealthData } from "@/lib/api";
import Header from "@/components/Header";
import CurrentStatus from "@/components/CurrentStatus";
import DeviceCard from "@/components/DeviceCard";
import DatePicker from "@/components/DatePicker";
import Timeline from "@/components/Timeline";
import HealthData from "@/components/HealthData";
import SiteMetadataSync from "@/components/SiteMetadataSync";
import VisitorMessages from "@/components/VisitorMessages";

export default function Home() {
  const config = useConfigLoader();

  return (
    <ConfigContext.Provider value={config}>
      <SiteMetadataSync />
      <HomeInner />
    </ConfigContext.Provider>
  );
}

function HomeInner() {
  const { displayName } = useConfig();
  const { current, timeline, selectedDate, changeDate, loading, timelineLoading, error, viewerCount, wsConnected } = useDashboard();

  // Selected device for CurrentStatus bubble
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);

  // Sidebar state for the visitor message panel
  const [messagesCollapsed, setMessagesCollapsed] = useState(false);

  // Tab state (lifted from RightPanelTabs for conditional rendering)
  const [tab, setTab] = useState<"activity" | "health">("activity");

  // Check if health data exists for the selected date
  const [hasHealthData, setHasHealthData] = useState(false);
  const [healthRecords, setHealthRecords] = useState<HealthRecord[]>([]);
  const [watchHealthRecords, setWatchHealthRecords] = useState<HealthRecord[]>([]);

  // Reset tab to activity if health data disappears
  useEffect(() => {
    if (!hasHealthData && tab === "health") setTab("activity");
  }, [hasHealthData, tab]);

  // Build currentAppByDevice map for Timeline
  const currentAppByDevice = useMemo(() => {
    const map: Record<string, string> = {};
    if (current?.devices) {
      for (const d of current.devices) {
        if (d.is_online === 1 && d.app_name) {
          map[d.device_id] = d.app_name;
        }
      }
    }
    return map;
  }, [current?.devices]);

  // Night mode: activate when all devices are offline (Monika sleeping)
  const allOffline = useMemo(() => {
    if (!current?.devices || current.devices.length === 0) return false;
    return current.devices.every((d) => d.is_online !== 1);
  }, [current?.devices]);

  // Stable device order: sort by device_id so they never jump around
  const devices = useMemo(() => {
    const arr = current?.devices ?? [];
    return [...arr].sort((a, b) => a.device_id.localeCompare(b.device_id));
  }, [current?.devices]);

  const watchDevice = useMemo(() => devices.find(isWatchDevice), [devices]);

  // Auto-select: default to first online device, fallback to first device
  const selectedDevice = useMemo(() => {
    if (devices.length === 0) return undefined;
    if (selectedDeviceId) {
      const found = devices.find((d) => d.device_id === selectedDeviceId);
      if (found) return found;
    }
    return devices.find((d) => d.is_online === 1) || devices[0];
  }, [devices, selectedDeviceId]);

  const activeHealthRecords = useMemo(() => {
    if (!selectedDevice) return healthRecords;
    if (watchDevice && selectedDevice.device_id === watchDevice.device_id) {
      return watchHealthRecords;
    }
    return healthRecords;
  }, [healthRecords, selectedDevice, watchDevice, watchHealthRecords]);

  const hasSeparateWatchHealth = Boolean(
    watchDevice && selectedDevice?.device_id !== watchDevice.device_id && watchHealthRecords.length > 0,
  );

  // Check if health data exists for the selected date + device
  const selectedDeviceIdResolved = selectedDevice?.device_id;
  useEffect(() => {
    // Don't fetch until we have both a date and a resolved device
    if (!selectedDate || !selectedDeviceIdResolved) {
      setHasHealthData(false);
      setHealthRecords([]);
      return;
    }
    setHasHealthData(false); // reset immediately on device/date change
    setHealthRecords([]);
    const controller = new AbortController();
    fetchHealthData(selectedDate, controller.signal, selectedDeviceIdResolved)
      .then((d) => {
        if (!controller.signal.aborted) {
          setHasHealthData(d.records.length > 0);
          setHealthRecords(d.records);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setHasHealthData(false);
      });
    return () => controller.abort();
  }, [selectedDate, selectedDeviceIdResolved]);

  useEffect(() => {
    if (!selectedDate || !watchDevice?.device_id) {
      setWatchHealthRecords([]);
      return;
    }
    const controller = new AbortController();
    fetchHealthData(selectedDate, controller.signal, watchDevice.device_id)
      .then((d) => {
        if (!controller.signal.aborted) setWatchHealthRecords(d.records);
      })
      .catch(() => {
        if (!controller.signal.aborted) setWatchHealthRecords([]);
      });
    return () => controller.abort();
  }, [selectedDate, watchDevice?.device_id]);

  // Filter timeline data by selected device
  const filteredTimeline = useMemo(() => {
    if (!timeline || !selectedDevice) return timeline;
    const did = selectedDevice.device_id;
    const segs = timeline.segments ?? [];
    const sum = timeline.summary ?? {};
    return {
      ...timeline,
      segments: segs.filter((s) => s.device_id === did),
      summary: did in sum ? { [did]: sum[did] } : {},
    };
  }, [timeline, selectedDevice]);

  const hasTimelineData = useMemo(() => {
    const segs = filteredTimeline?.segments ?? [];
    return segs.length > 0;
  }, [filteredTimeline?.segments]);

  useEffect(() => {
    document.body.classList.toggle("night-mode", allOffline);
    return () => { document.body.classList.remove("night-mode"); };
  }, [allOffline]);

  return (
    <>
      <main className="relative z-10 max-w-6xl mx-auto px-4 py-8">
        <div className="flex gap-4">
        <div className="flex-1 min-w-0">
      <Header serverTime={current?.server_time} viewerCount={viewerCount} />

      {/* Error banner */}
      {error && (
        <div className="vn-bubble mb-4 border-[var(--color-primary)]">
          <p className="text-sm text-[var(--color-primary)]">
            {"(>-<) 连接暂时中断了…"}
          </p>
          <p className="text-xs text-[var(--color-text-muted)] mt-1">
            系统会自动重试，请稍候。
          </p>
        </div>
      )}

      {/* Loading state */}
      {loading && !current && (
        <div className="flex flex-col items-center justify-center py-16 gap-3">
          <p className="text-2xl">(·˘ω˘·)</p>
          <div className="loading-dots">
            <span />
            <span />
            <span />
          </div>
          <p className="text-xs text-[var(--color-text-muted)]">正在加载喵!</p>
        </div>
      )}

      {current && (
        <>
          <BodySnapshot
            device={selectedDevice}
            records={activeHealthRecords}
            title="身体信息"
          />

          {hasSeparateWatchHealth && watchDevice && (
            <div className="mb-4">
              <BodySnapshot device={watchDevice} records={watchHealthRecords} title="手表健康" />
            </div>
          )}

          {devices.length > 0 && <CurrentStatus devices={devices} />}

          <div className="grid gap-6 lg:grid-cols-[14rem_minmax(0,1fr)]">
            {/* Left: device cards (narrow) */}
            {devices.length > 0 && (
              <div className="space-y-2">
                <h2 className="text-xs font-bold text-[var(--color-text-muted)] uppercase tracking-wider mb-2">
                  设备列表
                </h2>
                {devices.map((d) => (
                  <DeviceCard
                    key={d.device_id}
                    device={d}
                    selected={selectedDevice?.device_id === d.device_id}
                    onSelect={() => setSelectedDeviceId(d.device_id)}
                  />
                ))}
              </div>
            )}

            {/* Right: timeline + health (wide) */}
            <div className="flex-1 min-w-0">
              {/* Date picker + tab buttons on same line */}
              <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
                <DatePicker selectedDate={selectedDate} onChange={changeDate} />
                {hasHealthData && (
                  <div className="flex gap-1">
                    <button
                      onClick={() => setTab("activity")}
                      className={`pill-btn text-xs px-3 py-1 ${
                        tab === "activity"
                          ? "bg-[var(--color-primary)] text-white border-[var(--color-primary)]"
                          : ""
                      }`}
                    >
                      活动
                    </button>
                    <button
                      onClick={() => setTab("health")}
                      className={`pill-btn text-xs px-3 py-1 ${
                        tab === "health"
                          ? "bg-[var(--color-primary)] text-white border-[var(--color-primary)]"
                          : ""
                      }`}
                    >
                      健康
                    </button>
                  </div>
                )}
              </div>

              <div className="separator-dashed mb-3" />

              {/* Device overview - compact, below dashed line */}
              {devices.length > 1 && (
                <DeviceOverview devices={devices} />
              )}

              {/* Tab content */}
              {tab === "activity" ? (
                <>
                  {loading && filteredTimeline ? (
                    <div className="opacity-60">
                      <Timeline
                        segments={filteredTimeline.segments}
                        summary={filteredTimeline.summary}
                        currentAppByDevice={currentAppByDevice}
                      />
                    </div>
                  ) : filteredTimeline && hasTimelineData ? (
                    <Timeline
                      segments={filteredTimeline.segments}
                      summary={filteredTimeline.summary}
                      currentAppByDevice={currentAppByDevice}
                    />
                  ) : null}
                </>
              ) : (
                <HealthData selectedDate={selectedDate} deviceId={selectedDevice?.device_id} />
              )}
            </div>
          </div>
        </>
      )}

      </div>

      {/* Right sidebar: visitor messages (collapsible) */}
      {current && selectedDevice && (
        <div className={`hidden lg:block flex-shrink-0 transition-all duration-300 ${messagesCollapsed ? "w-10" : "w-72"}`}>
          {messagesCollapsed ? (
            <button
              onClick={() => setMessagesCollapsed(false)}
              className="pill-btn text-xs w-10 h-10 flex items-center justify-center"
              title="展开留言"
            >
              💬
            </button>
          ) : (
            <div className="glass-sm rounded-lg p-3">
              <div className="flex items-center justify-between mb-2">
                <h2 className="text-xs font-bold text-[var(--color-text-muted)] uppercase tracking-wider">留言小窗</h2>
                <button
                  onClick={() => setMessagesCollapsed(true)}
                  className="text-[var(--color-text-muted)] hover:text-[var(--color-text)] text-xs"
                >
                  ✕
                </button>
              </div>
              <VisitorMessages device={selectedDevice} />
            </div>
          )}
        </div>
      )}

      </div>

      {/* Mobile: visitor messages at bottom */}
      {current && selectedDevice && (
        <div className="lg:hidden mt-5">
          <VisitorMessages device={selectedDevice} />
        </div>
      )}

      {/* Footer */}
      <footer className="mt-12 pt-4 separator-dashed text-center">
            <p className="text-[10px] text-[var(--color-text-muted)]">
          {displayName} 现在在做什么 · 每 10 秒自动刷新一次 · 喵~
        </p>
      </footer>
      </main>
    </>
  );
}

const platformIcons: Record<string, string> = {
  windows: "\u{1F5A5}",
  android: "\u{1F4F1}",
  zepp: "\u231A",
};

function isWatchDevice(device: DeviceState) {
  return device.platform === "zepp" || device.extra?.device?.device_kind === "watch";
}

function DeviceOverview({ devices }: { devices: DeviceState[] }) {
  return (
    <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-0.5 text-[11px] text-[var(--color-text-muted)]">
      {devices.map((d) => {
        const isOnline = d.is_online === 1;
        const icon = platformIcons[d.platform] || "\u{1F4BB}";
        return (
          <span key={d.device_id} className={isOnline ? "" : "opacity-40"}>
            {icon} {d.device_name} · {isOnline ? (d.app_name === "idle" ? "暂时离开" : d.app_name || "不知道在忙什么") : "离线"}
          </span>
        );
      })}
    </div>
  );
}

function BodySnapshot({ device, records, title = "身体状态" }: { device: DeviceState | undefined; records: HealthRecord[]; title?: string }) {
  const [expanded, setExpanded] = useState(false);
  type BodyMetric = { label: string; value: string; unit: string; at?: string };
  const latest = new Map<string, HealthRecord>();
  for (const record of records) {
    const prev = latest.get(record.type);
    if (!prev || record.recorded_at > prev.recorded_at) latest.set(record.type, record);
  }
  const extra = device?.extra || {};
  const standCount = latest.get("stand_count");
  const standTarget = latest.get("stand_target");
  const standMetric = standCount
    ? {
        label: "站立提醒",
        value: standTarget ? `${Math.round(standCount.value)}/${Math.round(standTarget.value)}` : String(Math.round(standCount.value)),
        unit: "次",
        at: standCount.recorded_at,
      }
    : metric("站立", latest.get("stand_hours"), "小时");

  const sleepStatus = latest.get("sleep_status");
  const sleepDuration = latest.get("sleep_duration");
  const wearStatus = latest.get("wear_status");
  const napDuration = latest.get("nap_duration");

  const heartRateHistory = records
    .filter((record) => record.type === "heart_rate" && Number.isFinite(record.value))
    .sort((a, b) => new Date(a.recorded_at).getTime() - new Date(b.recorded_at).getTime());
  const items = ([
    metric("心率", latest.get("heart_rate"), "bpm"),
    metric("血氧", latest.get("oxygen_saturation"), "%"),
    metric("体表温度", latest.get("body_temperature"), "℃"),
    sleepStatus ? { label: "睡眠", value: sleepStatus.value > 0 ? "睡着了" : "醒着", unit: "", at: sleepStatus.recorded_at } : null,
    metric("睡眠时长", sleepDuration, "分钟"),
    metric("小睡时长", napDuration, "分钟"),
    wearStatus ? { label: "佩戴", value: wearStatus.value > 0 ? "佩戴中" : "未佩戴", unit: "", at: wearStatus.recorded_at } : null,
    metric("压力", latest.get("stress"), ""),
    metric("步数", latest.get("steps"), "步"),
    metric("活动热量", latest.get("active_calories"), "kcal"),
    standMetric,
    metric("气压", latest.get("air_pressure"), "hPa"),
    metric("海拔", latest.get("altitude"), "m"),
    metric("手表电量", latest.get("battery_percent"), "%"),
    typeof extra.battery_percent === "number"
      ? { label: "电量", value: String(extra.battery_percent), unit: "%", at: device?.last_seen_at }
      : null,
    extra.device?.network_type
      ? { label: "网络", value: extra.device.network_type, unit: extra.device.cellular_generation || "", at: device?.last_seen_at }
      : null,
  ].filter(Boolean) as BodyMetric[]);

  if (items.length === 0) return null;
  const preview = items.slice(0, 5);

  return (
    <section className="mb-4 rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-3">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <div className="text-xs font-semibold text-[var(--color-text-muted)]">{title}</div>
          {device && (
            <div className="truncate text-[10px] text-[var(--color-text-muted)]">
              {device.device_name} · {device.is_online === 1 ? "在线" : "手表离线"}
            </div>
          )}
        </div>
        {items.length > preview.length && (
          <button type="button" className="pill-btn px-3 py-1 text-xs" onClick={() => setExpanded((v) => !v)}>
            {expanded ? "收起" : "详情"}
          </button>
        )}
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
        {preview.map((item) => (
          <div key={item.label} className="rounded border border-dashed border-[var(--color-border)] px-3 py-2">
            <div className="text-[10px] text-[var(--color-text-muted)]">{item.label}</div>
            <div className="font-mono text-sm text-[var(--color-primary)]">
              {item.value}
              {item.unit && <span className="ml-1 text-[10px] text-[var(--color-text-muted)]">{item.unit}</span>}
            </div>
          </div>
        ))}
      </div>
      {expanded && (
        <>
          <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {items.slice(preview.length).map((item) => (
              <div key={item.label} className="rounded border border-[var(--color-border)] px-3 py-2">
                <div className="text-[10px] text-[var(--color-text-muted)]">{item.label}</div>
                <div className="font-mono text-sm text-[var(--color-primary)]">
                  {item.value}
                  {item.unit && <span className="ml-1 text-[10px] text-[var(--color-text-muted)]">{item.unit}</span>}
                </div>
              </div>
            ))}
          </div>
          {heartRateHistory.length > 1 && (
            <div className="mt-3 rounded border border-[var(--color-border)] px-3 py-2">
              <div className="mb-2 flex items-center justify-between text-[10px] text-[var(--color-text-muted)]">
                <span>历史心率</span>
                <span>{heartRateHistory.length} 条</span>
              </div>
              <div className="flex h-16 items-end gap-[2px] overflow-hidden">
                {sampleRecords(heartRateHistory, 80).map((record, index) => {
                  const height = Math.max(8, Math.min(100, ((record.value - 45) / 90) * 100));
                  return (
                    <span
                      key={`${record.recorded_at}-${index}`}
                      title={`${formatShortTime(record.recorded_at)} ${Math.round(record.value)} bpm`}
                      className="min-w-[2px] flex-1 rounded-sm bg-[var(--color-primary)] opacity-70"
                      style={{ height: `${height}%` }}
                    />
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function sampleRecords(records: HealthRecord[], max: number) {
  if (records.length <= max) return records;
  const step = records.length / max;
  const result: HealthRecord[] = [];
  for (let i = 0; i < max; i += 1) {
    result.push(records[Math.floor(i * step)]!);
  }
  return result;
}

function formatShortTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--:--";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function metric(label: string, record: HealthRecord | undefined, fallbackUnit: string) {
  if (!record) return null;
  const value = Number.isInteger(record.value) ? String(record.value) : record.value.toFixed(1);
  return { label, value, unit: friendlyUnit(record.unit || fallbackUnit), at: record.recorded_at };
}

function friendlyUnit(unit: string) {
  if (unit === "minutes") return "分钟";
  if (unit === "count") return "次";
  if (unit === "celsius") return "℃";
  if (unit === "status" || unit === "minute_of_day") return "";
  return unit;
}

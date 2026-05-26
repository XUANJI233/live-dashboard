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
  const { current, timeline, selectedDate, changeDate, loading, error, viewerCount } = useDashboard();

  // Selected device for CurrentStatus bubble
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);

  // Tab state (lifted from RightPanelTabs for conditional rendering)
  const [tab, setTab] = useState<"activity" | "health">("activity");

  // Check if health data exists for the selected date
  const [hasHealthData, setHasHealthData] = useState(false);
  const [healthRecords, setHealthRecords] = useState<HealthRecord[]>([]);

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

  // Auto-select: default to first online device, fallback to first device
  const selectedDevice = useMemo(() => {
    if (devices.length === 0) return undefined;
    if (selectedDeviceId) {
      const found = devices.find((d) => d.device_id === selectedDeviceId);
      if (found) return found;
    }
    return devices.find((d) => d.is_online === 1) || devices[0];
  }, [devices, selectedDeviceId]);

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
      <Header serverTime={current?.server_time} viewerCount={viewerCount} />

      {/* Error banner */}
      {error && (
        <div className="vn-bubble mb-4 border-[var(--color-primary)]">
          <p className="text-sm text-[var(--color-primary)]">
            (>-<) 连接暂时中断了…
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
          <BodySnapshot device={selectedDevice} records={healthRecords} />

          {/* 将健康数据也展示在页面顶部，突出身体信息而不是仅放在设备侧栏 */}
          <div className="w-full">
            <HealthData selectedDate={selectedDate} deviceId={selectedDevice?.device_id} />
          </div>

          {selectedDevice && <CurrentStatus device={selectedDevice} sleepStatus={latestHealthValue(healthRecords, "sleep_status")} />}

          <div className="grid gap-6 lg:grid-cols-[14rem_minmax(0,1fr)_20rem]">
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

            {selectedDevice && (
              <aside className="min-w-0">
                <VisitorMessages device={selectedDevice} />
              </aside>
            )}
          </div>
        </>
      )}

      {/* Footer */}
      <footer className="mt-12 pt-4 separator-dashed text-center">
            <p className="text-[10px] text-[var(--color-text-muted)]">
          {displayName} 现在在做什么 · 每 10 秒自动刷新一次 · 喵~
        </p>
      </footer>
    </>
  );
}

const platformIcons: Record<string, string> = {
  windows: "\u{1F5A5}",
  android: "\u{1F4F1}",
};

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

function BodySnapshot({ device, records }: { device: DeviceState | undefined; records: HealthRecord[] }) {
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

  const items = ([
    metric("心率", latest.get("heart_rate"), "bpm"),
    metric("血氧", latest.get("oxygen_saturation"), "%"),
    metric("体温", latest.get("body_temperature"), "℃"),
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

  return (
    <section className="mb-4 flex flex-wrap gap-2">
      {items.map((item) => (
        <div key={item.label} className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 min-w-[5.5rem]">
          <div className="text-[10px] text-[var(--color-text-muted)]">{item.label}</div>
          <div className="font-mono text-sm text-[var(--color-primary)]">
            {item.value}
            {item.unit && <span className="ml-1 text-[10px] text-[var(--color-text-muted)]">{item.unit}</span>}
          </div>
        </div>
      ))}
    </section>
  );
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

function latestHealthValue(records: HealthRecord[], type: string) {
  let latest: HealthRecord | undefined;
  for (const record of records) {
    if (record.type !== type) continue;
    if (!latest || record.recorded_at > latest.recorded_at) latest = record;
  }
  return latest?.value;
}

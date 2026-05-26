"use client";

import { useEffect, useMemo, useState } from "react";
import { useDashboard } from "@/hooks/useDashboard";
import { useConfig, useConfigLoader, ConfigContext } from "@/hooks/useConfig";
import type { DeviceState } from "@/lib/api";
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
      return;
    }
    setHasHealthData(false); // reset immediately on device/date change
    const controller = new AbortController();
    fetchHealthData(selectedDate, controller.signal, selectedDeviceIdResolved)
      .then((d) => {
        if (!controller.signal.aborted) {
          setHasHealthData(d.records.length > 0);
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
            (&gt;_&lt;) 连接失败了喵...
          </p>
          <p className="text-xs text-[var(--color-text-muted)] mt-1">
            别担心，会自动重试的~
          </p>
        </div>
      )}

      {/* Loading state */}
      {loading && !current && (
        <div className="flex flex-col items-center justify-center py-16 gap-3">
          <p className="text-2xl">(=^-ω-^=)</p>
          <div className="loading-dots">
            <span />
            <span />
            <span />
          </div>
          <p className="text-xs text-[var(--color-text-muted)]">正在加载喵~</p>
        </div>
      )}

      {current && (
        <>
          {/* Current status - prominent VN dialog */}
          <CurrentStatus device={selectedDevice} />

          <div className="flex flex-col lg:flex-row gap-6">
            {/* Left: device cards (narrow) */}
            <div className="lg:w-56 flex-shrink-0 space-y-2">
              <h2 className="text-xs font-bold text-[var(--color-text-muted)] uppercase tracking-wider mb-2">
                Devices
              </h2>
              {devices.length === 0 ? (
                <div className="text-center py-4">
                  <p className="text-lg mb-1">( -ω-) zzZ</p>
                  <p className="text-xs text-[var(--color-text-muted)] italic">
                    还没有设备连接呢~
                  </p>
                </div>
              ) : (
                devices.map((d) => (
                  <DeviceCard
                    key={d.device_id}
                    device={d}
                    selected={selectedDevice?.device_id === d.device_id}
                    onSelect={() => setSelectedDeviceId(d.device_id)}
                  />
                ))
              )}
            </div>

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

              <VisitorMessages device={selectedDevice} />
              <ExposurePanel device={selectedDevice} />

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
                  ) : filteredTimeline ? (
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

      {/* Footer */}
      <footer className="mt-12 pt-4 separator-dashed text-center">
        <p className="text-[10px] text-[var(--color-text-muted)]">
          {displayName} Now &middot; 每 10 秒自动刷新 &middot; (◕ᴗ◕)
        </p>
      </footer>
    </>
  );
}

function boolText(value: boolean | undefined) {
  if (value === undefined) return "未知";
  return value ? "是" : "否";
}

function ExposurePanel({ device }: { device: DeviceState | undefined }) {
  if (!device) return null;
  const extra = device.extra || {};
  const rows: Array<[string, string | undefined]> = [
    ["设备 ID", device.device_id],
    ["设备名", device.device_name],
    ["平台", device.platform],
    ["应用 ID", device.app_id],
    ["应用名", device.app_name],
    ["页面标题", device.display_title || device.window_title],
    ["最后上报", device.last_seen_at],
    ["采集模式", extra.device?.capability_mode],
    ["网络连接", boolText(extra.device?.network_connected)],
    ["VPN", extra.device?.vpn_active ? (extra.device.vpn_name || "开启") : boolText(extra.device?.vpn_active)],
    ["前台包名", extra.foreground?.package_name],
    ["前台应用", extra.foreground?.app_name],
    ["前台 Activity", extra.foreground?.activity],
    ["前台来源", extra.foreground?.source],
    ["媒体标题", extra.media?.title],
    ["媒体作者", extra.media?.artist],
    ["媒体应用", extra.media?.app],
    ["媒体状态", extra.media?.state],
    ["正在输入", boolText(extra.input?.is_typing)],
    ["位置", extra.location?.latitude !== undefined && extra.location?.longitude !== undefined
      ? `${extra.location.latitude}, ${extra.location.longitude}${extra.location.accuracy_m ? ` ±${extra.location.accuracy_m}m` : ""}`
      : undefined],
    ["位置来源", extra.location?.provider],
  ];

  return (
    <section className="vn-bubble mt-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-xs font-bold text-[var(--color-text-muted)] uppercase tracking-wider">
          当前暴露状态
        </h2>
        <span className="text-[10px] text-[var(--color-text-muted)]">尽量展示已收到的数据</span>
      </div>
      <div className="grid sm:grid-cols-2 gap-2 text-xs">
        {rows.map(([label, value]) => (
          <div key={label} className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 min-w-0">
            <div className="text-[10px] text-[var(--color-text-muted)]">{label}</div>
            <div className="truncate" title={value || "未上报"}>{value || "未上报"}</div>
          </div>
        ))}
      </div>
      <details className="mt-3 text-xs">
        <summary className="cursor-pointer text-[var(--color-text-muted)]">原始 extra JSON</summary>
        <pre className="mt-2 max-h-56 overflow-auto rounded border border-[var(--color-border)] bg-[var(--color-surface)] p-2 text-[10px] whitespace-pre-wrap">
          {JSON.stringify(extra, null, 2)}
        </pre>
      </details>
    </section>
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
            {icon} {d.device_name} · {isOnline ? (d.app_name === "idle" ? "暂时离开" : d.app_name || "idle") : "offline"}
          </span>
        );
      })}
    </div>
  );
}

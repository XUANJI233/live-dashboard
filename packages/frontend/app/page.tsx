"use client";

import { startTransition, useEffect, useMemo, useRef, useState } from "react";
import { useDashboard } from "@/hooks/useDashboard";
import { useConfig, useConfigLoader, ConfigContext } from "@/hooks/useConfig";
import type { DeviceState, HealthRecord } from "@/lib/api";
import { fetchHealthData } from "@/lib/api";
import { shouldMaskAppDescription } from "@/lib/app-descriptions";
import Header from "@/components/Header";
import CurrentStatus from "@/components/CurrentStatus";
import DeviceCard from "@/components/DeviceCard";
import DatePicker from "@/components/DatePicker";
import Timeline from "@/components/Timeline";
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
  const { current, timeline, selectedDate, changeDate, loading, error, viewerCount, wsConnected } = useDashboard();

  // Selected device for CurrentStatus bubble
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);

  // Sidebar state for the visitor message panel
  const [messagesCollapsed, setMessagesCollapsed] = useState(false);

  const [allHealthRecords, setAllHealthRecords] = useState<HealthRecord[]>([]);

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

  // Auto-select: default to the device that is actively reporting current work.
  // This keeps the timeline aligned with the hero status when multiple devices are online.
  const selectedDevice = useMemo(() => {
    if (devices.length === 0) return undefined;
    if (selectedDeviceId) {
      const found = devices.find((d) => d.device_id === selectedDeviceId);
      if (found) return found;
    }
    return [...devices].sort(deviceDefaultSort)[0];
  }, [devices, selectedDeviceId]);

  const hasAnyHealthData = allHealthRecords.some((record) => record.type !== "battery_percent");

  // Set of online device IDs for Timeline offline detection
  const onlineDevices = useMemo(() => {
    const set = new Set<string>();
    if (current?.devices) {
      for (const d of current.devices) {
        if (d.is_online === 1) set.add(d.device_id);
      }
    }
    return set;
  }, [current?.devices]);
  useEffect(() => {
    if (!selectedDate) {
      setAllHealthRecords([]);
      return;
    }
    const controller = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let idleId: number | null = null;
    setAllHealthRecords([]);

    const loadHealth = () => {
      fetchHealthData(selectedDate, controller.signal, undefined, { summary: true })
        .then((d) => {
          if (!controller.signal.aborted) {
            startTransition(() => setAllHealthRecords(d.records));
          }
        })
        .catch(() => {
          if (!controller.signal.aborted) {
            startTransition(() => setAllHealthRecords([]));
          }
        });
    };

    if (typeof window !== "undefined") {
      const idleWindow = window as Window & {
        requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
        cancelIdleCallback?: (handle: number) => void;
      };
      if (idleWindow.requestIdleCallback) {
        idleId = idleWindow.requestIdleCallback(loadHealth, { timeout: 1200 });
      } else {
        timeoutId = setTimeout(loadHealth, 80);
      }
    } else {
      loadHealth();
    }

    return () => {
      controller.abort();
      if (timeoutId) clearTimeout(timeoutId);
      if (idleId !== null) {
        const idleWindow = window as Window & { cancelIdleCallback?: (handle: number) => void };
        idleWindow.cancelIdleCallback?.(idleId);
      }
    };
  }, [selectedDate]);

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

  const refreshText = wsConnected
    ? "实时通道已连接，时间线每 30 秒补一次"
    : "实时通道暂未连上，正在用 15 秒刷新兜底";

  return (
    <>
      <main className="relative z-10 max-w-6xl mx-auto px-4 py-8">
        <div className="flex flex-col gap-4 lg:flex-row">
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
          <DeviceSnapshot selectedDevice={selectedDevice} devices={devices} />

          {hasAnyHealthData && (
            <HealthSnapshot selectedDate={selectedDate} devices={devices} records={allHealthRecords} />
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
              {/* Date picker */}
              <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
                <DatePicker selectedDate={selectedDate} onChange={changeDate} />
              </div>

              <div className="separator-dashed mb-3" />

              {/* Device overview - compact, below dashed line */}
              {devices.length > 1 && (
                <DeviceOverview devices={devices} />
              )}

              {loading && filteredTimeline ? (
                <div className="opacity-60">
                  <Timeline
                    segments={filteredTimeline.segments}
                    summary={filteredTimeline.summary}
                    currentAppByDevice={currentAppByDevice}
                    onlineDevices={onlineDevices}
                  />
                </div>
              ) : filteredTimeline && hasTimelineData ? (
                <Timeline
                  segments={filteredTimeline.segments}
                  summary={filteredTimeline.summary}
                  currentAppByDevice={currentAppByDevice}
                  onlineDevices={onlineDevices}
                />
              ) : null}
            </div>
          </div>
        </>
      )}

      </div>

      {/* Right sidebar: visitor messages (collapsible) */}
      {current && (
        <div className={`flex-shrink-0 overflow-hidden transition-[width,opacity] duration-300 ease-out ${messagesCollapsed ? "w-full opacity-95 lg:w-10" : "w-full opacity-100 lg:w-72"}`}>
          <div className="relative min-h-10">
            <button
              onClick={() => setMessagesCollapsed(false)}
              className={`pill-btn absolute right-0 top-0 flex h-10 w-10 items-center justify-center text-xs transition-[opacity,transform] duration-200 ${messagesCollapsed ? "translate-x-0 opacity-100" : "pointer-events-none translate-x-2 opacity-0"}`}
              title="展开留言"
            >
              💬
            </button>
            <div className={`glass-sm rounded-lg p-3 transition-[opacity,transform,visibility] duration-300 ease-out ${messagesCollapsed ? "invisible pointer-events-none translate-x-2 opacity-0" : "visible translate-x-0 opacity-100"}`}>
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
          </div>
        </div>
      )}

      </div>

      {/* Footer */}
      <footer className="mt-12 pt-4 separator-dashed text-center">
            <p className="text-[10px] text-[var(--color-text-muted)]">
          {displayName} 现在在做什么 · {refreshText} · 喵~
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

function deviceDefaultSort(a: DeviceState, b: DeviceState) {
  const score = (device: DeviceState) => {
    const lastSeen = device.last_seen_at ? Date.parse(device.last_seen_at) : 0;
    return [
      device.is_online === 1 ? 1 : 0,
      isActivePrimaryDevice(device) ? 1 : 0,
      isWatchDevice(device) ? 0 : 1,
      Number.isFinite(lastSeen) ? lastSeen : 0,
    ];
  };
  const as = score(a);
  const bs = score(b);
  for (let i = 0; i < as.length; i += 1) {
    const delta = (bs[i] ?? 0) - (as[i] ?? 0);
    if (delta !== 0) return delta;
  }
  return a.device_id.localeCompare(b.device_id);
}

function isActivePrimaryDevice(device: DeviceState) {
  if (device.is_online !== 1 || isWatchDevice(device)) return false;
  if (device.extra?.sleeping) return false;
  const combined = `${device.app_id} ${device.app_name}`.toLowerCase();
  if (!combined.trim() || combined.includes("idle") || combined.includes("sleeping")) return false;
  const lastSeen = device.last_seen_at ? Date.parse(device.last_seen_at) : 0;
  return Number.isFinite(lastSeen) && Date.now() - lastSeen <= 2 * 60_000;
}

function isWatchDevice(device: DeviceState) {
  return device.platform === "zepp" || device.extra?.device?.device_kind === "watch";
}

function DeviceOverview({ devices }: { devices: DeviceState[] }) {
  const { nsfwFilterEnabled } = useConfig();
  return (
    <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-0.5 text-[11px] text-[var(--color-text-muted)]">
      {devices.map((d) => {
        const isOnline = d.is_online === 1;
        const icon = platformIcons[d.platform] || "\u{1F4BB}";
        return (
          <span key={d.device_id} className={isOnline ? "" : "opacity-40"}>
            {icon} {d.device_name} · {isOnline ? getOverviewAppLabel(d, nsfwFilterEnabled) : "离线"}
            {deviceInlineMeta(d)}
          </span>
        );
      })}
    </div>
  );
}

function deviceInlineMeta(device: DeviceState) {
  const parts: string[] = [];
  const extra = device.extra;
  if (extra?.sleeping) parts.push("睡眠");
  if (extra?.device?.network_type) parts.push(extra.device.network_type);
  if (extra?.device?.vpn_active) parts.push("VPN");
  if (extra?.device?.audio_output_connected) parts.push(formatAudioOutputType(extra.device.audio_output_type));
  if (typeof extra?.device?.ambient_lux === "number") parts.push(`${Math.round(extra.device.ambient_lux)} lx`);
  return parts.length > 0 ? ` · ${parts.join("/")}` : "";
}

function DeviceSnapshot({ selectedDevice, devices }: { selectedDevice: DeviceState | undefined; devices: DeviceState[] }) {
  const [expanded, setExpanded] = useState(false);
  const summaryItems = selectedDevice ? deviceSummaryItems(selectedDevice) : [];
  const detailItems = selectedDevice ? deviceInfoItems(selectedDevice) : [];
  const others = devices.filter((device) => device.device_id !== selectedDevice?.device_id);
  if (!selectedDevice && devices.length === 0) return null;
  const items = summaryItems.length > 0 ? summaryItems : selectedDevice ? [{ label: "状态", value: selectedDevice.is_online === 1 ? "在线" : "离线" }] : [];
  const preview = items.slice(0, 4);
  const previewLabels = new Set(preview.map((item) => item.label));
  const hiddenDetails = detailItems.filter((item) => !previewLabels.has(item.label));

  return (
    <section className="mb-4 rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-3">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <div className="text-xs font-semibold text-[var(--color-text-muted)]">设备信息</div>
          {selectedDevice && (
            <div className="truncate text-[10px] text-[var(--color-text-muted)]">
              {selectedDevice.device_name} · {selectedDevice.is_online === 1 ? "在线" : "离线"} · {formatShortTime(selectedDevice.last_seen_at)}
            </div>
          )}
        </div>
        {(hiddenDetails.length > 0 || others.length > 0) && (
          <button type="button" className="pill-btn px-3 py-1 text-xs" onClick={() => setExpanded((v) => !v)}>
            {expanded ? "收起" : "详情"}
          </button>
        )}
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
        {preview.map((item) => (
          <DeviceInfoCard key={item.label} item={item} />
        ))}
      </div>
      {expanded && (
        <>
          {hiddenDetails.length > 0 && (
            <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {hiddenDetails.map((item) => (
              <DeviceInfoCard key={item.label} item={item} />
            ))}
            </div>
          )}
          {others.length > 0 && (
            <div className="mt-3 space-y-1 rounded border border-[var(--color-border)] px-3 py-2 text-xs">
              {others.map((device) => (
                <div key={device.device_id} className="flex items-center justify-between gap-3">
                  <span className="truncate text-[var(--color-text-muted)]">{platformIcons[device.platform] || "\u{1F4BB}"} {device.device_name}</span>
                  <span className="truncate text-right font-mono text-[var(--color-text)]">{compactDeviceInfo(device)}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function HealthSnapshot({ selectedDate, devices, records }: { selectedDate: string; devices: DeviceState[]; records: HealthRecord[] }) {
  const [expanded, setExpanded] = useState(false);
  const [selectedType, setSelectedType] = useState<string | null>(null);
  const [detailRecords, setDetailRecords] = useState<HealthRecord[] | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const deviceById = useMemo(() => new Map(devices.map((device) => [device.device_id, device])), [devices]);
  const grouped = useMemo(() => groupHealth(records), [records]);
  const detailGrouped = useMemo(() => groupHealth(detailRecords ?? records), [detailRecords, records]);
  const items = useMemo(() => healthItems(grouped, deviceById), [grouped, deviceById]);
  const detailAllItems = useMemo(() => healthItems(detailGrouped, deviceById), [detailGrouped, deviceById]);
  const sourceCount = useMemo(() => new Set(records.map((record) => record.device_id).filter(Boolean)).size || 1, [records]);

  useEffect(() => {
    setDetailRecords(null);
    setDetailLoading(false);
    setDetailError(null);
    setExpanded(false);
    setSelectedType(null);
  }, [selectedDate]);

  useEffect(() => {
    if (!expanded || detailRecords !== null || detailLoading || detailError) return;
    const controller = new AbortController();
    setDetailLoading(true);
    setDetailError(null);
    fetchHealthData(selectedDate, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setDetailRecords(data.records);
      })
      .catch((error) => {
        if (!controller.signal.aborted && error?.name !== "AbortError") {
          setDetailError(error instanceof Error ? error.message : String(error));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setDetailLoading(false);
      });
    return () => controller.abort();
  }, [detailRecords, expanded, selectedDate]);

  useEffect(() => {
    if (!selectedType) return;
    const hasSelected = isSleepType(selectedType)
      ? Array.from(detailGrouped.keys()).some(isSleepType)
      : detailGrouped.has(selectedType);
    if (!hasSelected) setSelectedType(null);
  }, [detailGrouped, selectedType]);
  if (items.length === 0) return null;
  const preview = items.slice(0, 6);
  const detailItems = selectedType
    ? detailAllItems.filter((item) => isSleepType(selectedType) ? isSleepType(item.type) : item.type === selectedType)
    : detailAllItems;

  return (
    <section className="mb-4 rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-3">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <div className="text-xs font-semibold text-[var(--color-text-muted)]">健康</div>
          <div className="truncate text-[10px] text-[var(--color-text-muted)]">
            已聚合 {sourceCount} 个来源
          </div>
        </div>
        {items.length > 0 && (
          <button
            type="button"
            className="pill-btn px-3 py-1 text-xs"
            onClick={() => {
              setSelectedType(null);
              if (!expanded) setDetailError(null);
              setExpanded((v) => !v);
            }}
          >
            {expanded && !selectedType ? "收起" : "详情"}
          </button>
        )}
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
        {preview.map((item) => (
          <HealthMetricCard
            key={item.type}
            item={item}
            onOpen={() => {
              setSelectedType(isSleepType(item.type) ? "sleep_status" : item.type);
              setDetailError(null);
              setExpanded(true);
            }}
          />
        ))}
      </div>
      {expanded && (
        <HealthDetailPanel
          grouped={detailGrouped}
          items={detailItems}
          selectedType={selectedType}
          deviceById={deviceById}
          loading={detailLoading}
          error={detailError}
          onShowAll={() => setSelectedType(null)}
          onSelectType={setSelectedType}
        />
      )}
    </section>
  );
}

function getOverviewAppLabel(device: DeviceState, nsfwFilterEnabled: boolean) {
  if (device.app_name === "idle") return "暂时离开";
  if (nsfwFilterEnabled && shouldMaskAppDescription(device.app_name, device.app_id, device.display_title)) {
    return "私密活动中";
  }
  return device.app_name || "不知道在忙什么";
}

type DeviceInfoItem = { label: string; value: string; unit?: string };
type HealthItem = { type: string; label: string; value: string; unit: string; source: string; records: HealthRecord[] };
type HealthGroup = { latest: HealthRecord; all: HealthRecord[] };
const SLEEP_DETAIL_TYPES = ["sleep", "sleep_status", "sleep_start", "sleep_end", "sleep_duration", "deep_sleep_duration", "sleep_score", "sleep_stage_count", "nap_start", "nap_end", "nap_duration"];
const IGNORED_HEALTH_TYPES = new Set(["battery_percent"]);
const HEALTH_TYPE_ORDER = new Map([
  "heart_rate", "oxygen_saturation", "body_temperature", "sleep_status", "sleep_start", "sleep_end", "sleep_duration",
  "deep_sleep_duration", "sleep_score",
  "nap_start", "nap_end", "nap_duration", "sleep_stage_count", "wear_status", "stress", "steps",
  "active_calories", "stand_count", "stand_target", "air_pressure", "altitude",
].map((type, index) => [type, index]));

function DeviceInfoCard({ item }: { item: DeviceInfoItem }) {
  return (
    <div className="rounded border border-dashed border-[var(--color-border)] px-3 py-2">
      <div className="text-[10px] text-[var(--color-text-muted)]">{item.label}</div>
      <div className="font-mono text-sm text-[var(--color-primary)]">
        {item.value}
        {item.unit && <span className="ml-1 text-[10px] text-[var(--color-text-muted)]">{item.unit}</span>}
      </div>
    </div>
  );
}

function HealthMetricCard({ item, onOpen }: { item: HealthItem; onOpen?: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="relative rounded border border-dashed border-[var(--color-border)] px-3 py-2 pb-5 text-left transition-colors hover:border-[var(--color-primary)]"
    >
      <div className="text-[10px] text-[var(--color-text-muted)]">{item.label}</div>
      <div className="font-mono text-sm text-[var(--color-primary)]">
        {item.value}
        {item.unit && <span className="ml-1 text-[10px] text-[var(--color-text-muted)]">{item.unit}</span>}
      </div>
      <div className="pointer-events-none absolute bottom-1 right-2 max-w-[70%] truncate text-[9px] text-[var(--color-text-muted)] opacity-55">
        {item.source}
      </div>
    </button>
  );
}

function HealthDetailPanel({
  grouped,
  items,
  selectedType,
  deviceById,
  loading,
  error,
  onShowAll,
  onSelectType,
}: {
  grouped: Map<string, HealthGroup>;
  items: HealthItem[];
  selectedType: string | null;
  deviceById: Map<string, DeviceState>;
  loading: boolean;
  error: string | null;
  onShowAll: () => void;
  onSelectType: (type: string) => void;
}) {
  const allItems = useMemo(() => healthItems(grouped, deviceById), [grouped, deviceById]);
  const visibleItems = useMemo(() => items.filter((item) => !isSleepType(item.type)), [items]);
  const chartItems = useMemo(
    () => visibleItems.filter((item) => item.records.length > 1 && isChartableHealthType(item.type)),
    [visibleItems]
  );
  const recentRecords = useMemo(() => collectRecentHealthRecords(visibleItems, 24), [visibleItems]);
  const navItems = useMemo(() => aggregateHealthNavItems(allItems), [allItems]);

  return (
    <div className="mt-3 rounded border border-[var(--color-border)] px-3 py-3">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-xs font-semibold text-[var(--color-text-muted)]">
            {selectedType ? `${isSleepType(selectedType) ? "睡眠" : healthLabel(selectedType)}详情` : "身体数据详情"}
          </div>
          <div className="text-[10px] text-[var(--color-text-muted)]">
            {selectedType ? "点击“全部”查看其他指标" : "摘要卡片可直接展开对应历史"}
          </div>
        </div>
        {selectedType && (
          <button type="button" className="pill-btn px-3 py-1 text-xs" onClick={onShowAll}>
            全部
          </button>
        )}
      </div>

      {(loading || error) && (
        <div className="mb-3 rounded border border-dashed border-[var(--color-border)] px-3 py-2 text-[10px] text-[var(--color-text-muted)]">
          {loading ? "正在补全详细历史..." : "详细历史暂时没有取到，先显示摘要。"}
        </div>
      )}

      {!selectedType && navItems.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-1">
          {navItems.map((item) => (
            <button
              key={item.type}
              type="button"
              className="pill-btn px-2 py-1 text-[10px]"
              onClick={() => onSelectType(isSleepType(item.type) ? "sleep_status" : item.type)}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}

      <SleepDetail grouped={grouped} items={items} />

      {visibleItems.length > 0 && (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {visibleItems.map((item) => (
          <div key={item.type} className="rounded border border-dashed border-[var(--color-border)] px-3 py-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] text-[var(--color-text-muted)]">{item.label}</span>
              <span className="text-[9px] text-[var(--color-text-muted)]">{item.records.length} 条</span>
            </div>
            <div className="mt-1 font-mono text-sm text-[var(--color-primary)]">
              {item.value}
              {item.unit && <span className="ml-1 text-[10px] text-[var(--color-text-muted)]">{item.unit}</span>}
            </div>
            <div className="mt-1 truncate text-[9px] text-[var(--color-text-muted)]">{item.source}</div>
          </div>
        ))}
        </div>
      )}

      {chartItems.length > 0 && (
        <div className="mt-3 grid gap-2 lg:grid-cols-2">
          {chartItems.map((item) => (
            <div key={item.type} className="rounded border border-[var(--color-border)] px-3 py-2">
              <div className="mb-2 flex items-center justify-between text-[10px] text-[var(--color-text-muted)]">
                <span>{item.label}历史</span>
                <span>{item.records.length} 条</span>
              </div>
              <Sparkline records={item.records} type={item.type} />
            </div>
          ))}
        </div>
      )}

      {recentRecords.length > 0 && (
        <div className="mt-3 max-h-64 overflow-auto rounded border border-[var(--color-border)]">
          <div className="grid grid-cols-[4.5rem_1fr_1fr] gap-2 border-b border-[var(--color-border)] px-3 py-2 text-[10px] text-[var(--color-text-muted)]">
            <span>时间</span>
            <span>指标</span>
            <span className="text-right">数值</span>
          </div>
          {recentRecords.map((record, index) => (
            <div
              key={`${record.type}-${record.recorded_at}-${index}`}
              className="grid grid-cols-[4.5rem_1fr_1fr] gap-2 px-3 py-1.5 text-xs"
            >
              <span className="font-mono text-[var(--color-text-muted)]">{formatShortTime(record.recorded_at)}</span>
              <span className="truncate text-[var(--color-text-muted)]">
                {healthLabel(record.type)} · {sourceLabel(record.device_id, deviceById)}
              </span>
              <span className="text-right font-mono">
                {formatHealthValue(record.value, record.type)}
                {healthUnit(record.type, record.unit) && <span className="ml-1 text-[10px] text-[var(--color-text-muted)]">{healthUnit(record.type, record.unit)}</span>}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SleepDetail({ grouped, items }: { grouped: Map<string, HealthGroup>; items: HealthItem[] }) {
  const selectedTypes = new Set(items.map((item) => item.type));
  const shouldShow = selectedTypes.size === 0 || SLEEP_DETAIL_TYPES.some((type) => selectedTypes.has(type));
  if (!shouldShow) return null;

  const details = SLEEP_DETAIL_TYPES
    .map((type) => {
      const entry = grouped.get(type);
      return entry ? { type, entry } : null;
    })
    .filter(Boolean) as { type: string; entry: HealthGroup }[];
  if (details.length === 0) return null;
  const current = grouped.get("sleep_status")?.latest;
  const sleepStart = grouped.get("sleep_start")?.latest;
  const sleepEnd = grouped.get("sleep_end")?.latest;
  const sleepDuration = grouped.get("sleep_duration")?.latest || grouped.get("sleep")?.latest;
  const deepSleepDuration = grouped.get("deep_sleep_duration")?.latest;
  const sleepScore = grouped.get("sleep_score")?.latest;
  const napStart = grouped.get("nap_start")?.latest;
  const napEnd = grouped.get("nap_end")?.latest;
  const napDuration = grouped.get("nap_duration")?.latest;
  const stageCount = grouped.get("sleep_stage_count")?.latest;

  return (
    <div className="mb-3 rounded border border-dashed border-[var(--color-border)] px-3 py-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-[10px] font-semibold text-[var(--color-text-muted)]">睡眠汇总</div>
          <div className="text-[9px] text-[var(--color-text-muted)]">{details.length} 项睡眠数据</div>
        </div>
        {current && (
          <div className="font-mono text-sm text-[var(--color-primary)]">
            {formatHealthValue(current.value, "sleep_status")}
          </div>
        )}
      </div>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <SleepSummaryItem label="夜间睡眠" value={formatSleepRange(sleepStart, sleepEnd, sleepDuration)} />
        <SleepSummaryItem label="睡眠时长" value={sleepDuration ? formatHealthValue(sleepDuration.value, "sleep_duration") : "--"} />
        <SleepSummaryItem label="深睡" value={deepSleepDuration ? formatHealthValue(deepSleepDuration.value, "deep_sleep_duration") : "--"} />
        <SleepSummaryItem label="评分" value={sleepScore ? formatHealthValue(sleepScore.value, "sleep_score") : "--"} />
        <SleepSummaryItem label="睡眠阶段" value={stageCount ? `${formatHealthValue(stageCount.value, "sleep_stage_count")}次` : "--"} />
        <SleepSummaryItem label="小睡" value={formatSleepRange(napStart, napEnd, napDuration)} />
      </div>
      {details.some(({ entry }) => entry.all.length > 1) && (
        <div className="mt-2 text-[9px] text-[var(--color-text-muted)]">
          多条记录已按最新值汇总，完整记录仍保留在下方时间列表。
        </div>
      )}
    </div>
  );
}

function SleepSummaryItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-[var(--color-border)] px-3 py-2">
      <div className="text-[10px] text-[var(--color-text-muted)]">{label}</div>
      <div className="font-mono text-sm text-[var(--color-primary)]">{value}</div>
    </div>
  );
}

function formatSleepRange(start?: HealthRecord, end?: HealthRecord, duration?: HealthRecord) {
  const parts: string[] = [];
  if (start && end) {
    parts.push(`${formatHealthValue(start.value, start.type)} - ${formatHealthValue(end.value, end.type)}`);
  } else if (start) {
    parts.push(`${formatHealthValue(start.value, start.type)} - --:--`);
  } else if (end) {
    parts.push(`--:-- - ${formatHealthValue(end.value, end.type)}`);
  }
  if (duration) parts.push(formatHealthValue(duration.value, duration.type));
  return parts.length > 0 ? parts.join(" · ") : "--";
}

function deviceInfoItems(device: DeviceState): DeviceInfoItem[] {
  const extra = device.extra;
  const info: DeviceInfoItem[] = [...deviceSummaryItems(device)];
  if (extra?.device?.network_type) info.push({ label: "网络", value: extra.device.network_type, unit: extra.device.cellular_generation || "" });
  if (typeof extra?.device?.network_connected === "boolean") info.push({ label: "联网", value: extra.device.network_connected ? "在线" : "断开" });
  if (typeof extra?.device?.vpn_active === "boolean") info.push({ label: "VPN", value: extra.device.vpn_active ? "开启" : "关闭" });
  if (extra?.device?.capability_mode) info.push({ label: "采集", value: extra.device.uploader || extra.device.capability_mode });
  if (extra?.device?.relay_mode) info.push({ label: "中继", value: extra.device.relay_mode });
  if (extra?.device?.energy_policy) info.push({ label: "节能", value: extra.device.energy_policy });
  if (typeof extra?.device?.min_interval_ms === "number") info.push({ label: "间隔", value: formatDurationMinutes(extra.device.min_interval_ms / 60_000) });
  if (extra?.device?.window_mode && extra.device.window_mode !== "fullscreen") info.push({ label: "窗口", value: extra.device.window_mode });
  if (typeof extra?.device?.audio_output_connected === "boolean") {
    info.push({
      label: "音频",
      value: extra.device.audio_output_connected ? formatAudioOutputType(extra.device.audio_output_type) : "扬声器",
      unit: extra.device.audio_output_name || "",
    });
  }
  if (typeof extra?.device?.ambient_lux === "number") {
    info.push({ label: "环境光", value: String(Math.round(extra.device.ambient_lux)), unit: "lx" });
  }
  if (extra?.sleeping) info.push({ label: "状态", value: "息屏/睡眠" });
  return info;
}

function formatAudioOutputType(type?: string) {
  if (type === "bluetooth_headset") return "蓝牙耳机";
  if (type === "wired_headset") return "有线耳机";
  if (type === "usb_audio") return "USB 音频";
  if (type === "external_audio") return "外接音频";
  return "耳机/外放";
}

function deviceSummaryItems(device: DeviceState): DeviceInfoItem[] {
  const extra = device.extra;
  const info: DeviceInfoItem[] = [];
  if (typeof extra?.battery_percent === "number") info.push({ label: "电量", value: String(extra.battery_percent), unit: "%" });
  if (typeof extra?.battery_charging === "boolean") info.push({ label: "充电", value: extra.battery_charging ? "充电中" : "未充电" });
  info.push({ label: "状态", value: device.is_online === 1 ? "在线" : "离线" });
  if (extra?.device?.last_sample_at) info.push({ label: "采样", value: formatShortTime(extra.device.last_sample_at) });
  return info;
}

function compactDeviceInfo(device: DeviceState) {
  const parts = deviceSummaryItems(device).slice(0, 3).map((item) => `${item.label}:${item.value}${item.unit || ""}`);
  return parts.length > 0 ? parts.join(" / ") : (device.is_online === 1 ? "在线" : "离线");
}

function groupHealth(records: HealthRecord[]) {
  const map = new Map<string, HealthGroup>();
  for (const record of records) {
    if (IGNORED_HEALTH_TYPES.has(record.type)) continue;
    const existing = map.get(record.type);
    if (existing) {
      existing.all.push(record);
      if (record.recorded_at > existing.latest.recorded_at) existing.latest = record;
    } else {
      map.set(record.type, { latest: record, all: [record] });
    }
  }
  return map;
}

function healthItems(grouped: Map<string, HealthGroup>, deviceById: Map<string, DeviceState>): HealthItem[] {
  return Array.from(grouped.entries())
    .sort(([a], [b]) => (HEALTH_TYPE_ORDER.get(a) ?? 99) - (HEALTH_TYPE_ORDER.get(b) ?? 99))
    .map(([type, entry]) => ({
      type,
      label: healthLabel(type),
      value: formatHealthValue(entry.latest.value, type),
      unit: healthUnit(type, entry.latest.unit),
      source: sourceLabel(entry.latest.device_id, deviceById),
      records: entry.all,
    }));
}

function sourceLabel(deviceId: string, deviceById: Map<string, DeviceState>) {
  const device = deviceById.get(deviceId);
  if (!device) return deviceId || "未知来源";
  if (device.platform === "zepp" || device.extra?.device?.device_kind === "watch") return `来自 ${device.device_name || "手表"}`;
  return `来自 ${device.device_name || "设备"}`;
}

function collectRecentHealthRecords(items: HealthItem[], max: number) {
  if (max <= 0) return [];
  const picked: { record: HealthRecord; ts: number }[] = [];
  let minIndex = -1;
  let minTs = Infinity;

  const recomputeMin = () => {
    minIndex = -1;
    minTs = Infinity;
    for (let i = 0; i < picked.length; i += 1) {
      if (picked[i]!.ts < minTs) {
        minTs = picked[i]!.ts;
        minIndex = i;
      }
    }
  };

  for (const item of items) {
    for (const record of item.records) {
      const ts = Date.parse(record.recorded_at);
      if (!Number.isFinite(ts)) continue;
      if (picked.length < max) {
        picked.push({ record, ts });
        if (ts < minTs) {
          minTs = ts;
          minIndex = picked.length - 1;
        }
      } else if (ts > minTs && minIndex >= 0) {
        picked[minIndex] = { record, ts };
        recomputeMin();
      }
    }
  }

  picked.sort((a, b) => b.ts - a.ts);
  return picked.map((entry) => entry.record);
}

function buildCanvasSeries(records: HealthRecord[]) {
  const points: { time: number; value: number }[] = [];
  let minTime = Infinity;
  let maxTime = -Infinity;
  let minValue = Infinity;
  let maxValue = -Infinity;
  let previousTime = -Infinity;
  let isSorted = true;

  for (const record of records) {
    const time = Date.parse(record.recorded_at);
    const value = record.value;
    if (!Number.isFinite(time) || !Number.isFinite(value)) continue;
    if (time < previousTime) isSorted = false;
    previousTime = time;
    points.push({ time, value });
    if (time < minTime) minTime = time;
    if (time > maxTime) maxTime = time;
    if (value < minValue) minValue = value;
    if (value > maxValue) maxValue = value;
  }

  if (!isSorted) points.sort((a, b) => a.time - b.time);
  if (points.length === 0) {
    return { points, minTime: 0, maxTime: 1, minValue: 0, maxValue: 1 };
  }
  if (minValue === maxValue) {
    minValue -= 1;
    maxValue += 1;
  }
  return { points, minTime, maxTime, minValue, maxValue };
}

function Sparkline({ records, type }: { records: HealthRecord[]; type: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const series = useMemo(() => buildCanvasSeries(records), [records]);
  const label = `${healthLabel(type)}历史，${series.points.length} 条`;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || series.points.length === 0) return;

    const draw = () => {
      const rect = canvas.getBoundingClientRect();
      const width = Math.max(1, rect.width);
      const height = Math.max(1, rect.height);
      const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);

      const styles = getComputedStyle(canvas);
      const stroke = styles.getPropertyValue("--color-primary").trim() || "#88c0d0";
      const muted = styles.getPropertyValue("--color-border").trim() || "rgba(128,128,128,0.3)";
      ctx.strokeStyle = muted;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, height - 0.5);
      ctx.lineTo(width, height - 0.5);
      ctx.stroke();

      const points = series.points;
      const tSpan = Math.max(1, series.maxTime - series.minTime);
      const vSpan = Math.max(1, series.maxValue - series.minValue);
      const toX = (time: number) => ((time - series.minTime) / tSpan) * width;
      const toY = (value: number) => height - ((value - series.minValue) / vSpan) * (height - 8) - 4;

      ctx.strokeStyle = stroke;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let i = 0; i < points.length; i += 1) {
        const point = points[i]!;
        const x = toX(point.time);
        const y = toY(point.value);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();

      if (points.length === 1) {
        const point = points[0]!;
        ctx.fillStyle = stroke;
        ctx.beginPath();
        ctx.arc(toX(point.time), toY(point.value), 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
    };

    draw();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [series]);

  if (series.points.length === 0) return null;

  return (
    <canvas
      ref={canvasRef}
      className="block h-16 w-full"
      role="img"
      aria-label={label}
      title={label}
    />
  );
}

function isChartableHealthType(type: string) {
  return !isSleepType(type) && type !== "wear_status";
}

function isSleepType(type: string) {
  return SLEEP_DETAIL_TYPES.includes(type) || type === "sleep";
}

function aggregateHealthNavItems(items: HealthItem[]) {
  const result: HealthItem[] = [];
  let hasSleep = false;
  for (const item of items) {
    if (isSleepType(item.type)) {
      hasSleep = true;
    } else {
      result.push(item);
    }
  }
  if (hasSleep) {
    result.splice(Math.min(2, result.length), 0, {
      type: "sleep_status",
      label: "睡眠",
      value: "",
      unit: "",
      source: "",
      records: [],
    });
  }
  return result;
}

function formatShortTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--:--";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatDurationMinutes(value: number) {
  if (!Number.isFinite(value)) return "--";
  const h = Math.floor(value / 60);
  const m = Math.round(value % 60);
  return h > 0 ? `${h}小时${m}分` : `${m}分`;
}

function healthLabel(type: string) {
  const labels: Record<string, string> = {
    heart_rate: "心率",
    resting_heart_rate: "静息心率",
    oxygen_saturation: "血氧",
    body_temperature: "体表温度",
    sleep: "睡眠",
    sleep_status: "睡眠",
    sleep_start: "入睡时间",
    sleep_end: "起床时间",
    sleep_duration: "睡眠时长",
    deep_sleep_duration: "深睡时长",
    sleep_score: "睡眠评分",
    sleep_stage_count: "睡眠阶段",
    nap_start: "小睡开始",
    nap_end: "小睡结束",
    nap_duration: "小睡时长",
    wear_status: "佩戴",
    stress: "压力",
    steps: "步数",
    active_calories: "活动热量",
    stand_count: "站立提醒",
    stand_target: "站立目标",
    air_pressure: "气压",
    altitude: "海拔",
  };
  return labels[type] || type;
}

function formatHealthValue(value: number, type: string) {
  if (type === "sleep_status") return value > 0 ? "睡着了" : "醒着";
  if (type === "wear_status") return value > 0 ? "佩戴中" : "未佩戴";
  if (type === "sleep_duration" || type === "nap_duration" || type === "sleep" || type === "deep_sleep_duration") {
    return formatDurationMinutes(value);
  }
  if (type === "sleep_start" || type === "sleep_end" || type === "nap_start" || type === "nap_end") {
    return formatMinuteOfDay(value);
  }
  if (type === "sleep_score") return `${Math.round(value)}分`;
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(1);
}

function formatMinuteOfDay(value: number) {
  if (!Number.isFinite(value)) return "--:--";
  const minutes = ((Math.round(value) % 1440) + 1440) % 1440;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function friendlyUnit(unit: string) {
  if (unit === "minutes") return "分钟";
  if (unit === "count") return "次";
  if (unit === "celsius" || unit === "°C") return "℃";
  if (unit === "status" || unit === "state" || unit === "minute_of_day") return "";
  return unit;
}

function healthUnit(type: string, unit: string) {
  if (type === "sleep" || type === "sleep_duration" || type === "nap_duration" || type === "deep_sleep_duration") return "";
  if (type === "sleep_score") return "";
  if (type === "sleep_start" || type === "sleep_end" || type === "nap_start" || type === "nap_end") return "";
  return friendlyUnit(unit);
}

"use client";
import { useState, useEffect, useCallback, useRef } from "react";
import {
  fetchCurrent,
  fetchTimeline,
  type CurrentResponse,
  type DeviceState,
  type TimelineResponse,
} from "@/lib/api";
import { subscribeRealtime, subscribeRealtimeState } from "@/lib/realtime-client";

const TIMELINE_POLL_INTERVAL = 30 * 1000;
const DEVICE_POLL_INTERVAL = 15 * 1000;
const TIMELINE_EVENT_DEBOUNCE = 800;

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function mergeDevicePayload(
  existing: DeviceState,
  payload: Record<string, unknown>,
  timestamp: string,
): DeviceState {
  const updated: DeviceState = { ...existing };

  if (typeof payload.app_id === "string") updated.app_id = payload.app_id;
  if (typeof payload.app_name === "string") updated.app_name = payload.app_name;
  if (typeof payload.display_title === "string") updated.display_title = payload.display_title;
  if (typeof payload.window_title === "string") updated.window_title = payload.window_title;

  if (payload.extra && typeof payload.extra === "object" && !Array.isArray(payload.extra)) {
    const incoming = payload.extra as Record<string, unknown>;
    const base = (existing.extra ?? {}) as Record<string, unknown>;
    const merged: Record<string, unknown> = { ...base };

    for (const [key, val] of Object.entries(incoming)) {
      if (
        key !== "media" &&
        val && typeof val === "object" && !Array.isArray(val) &&
        base[key] && typeof base[key] === "object" && !Array.isArray(base[key])
      ) {
        merged[key] = { ...(base[key] as Record<string, unknown>), ...(val as Record<string, unknown>) };
      } else {
        merged[key] = val;
      }
    }
    updated.extra = merged as DeviceState["extra"];
  }

  updated.is_online = 1;
  updated.last_seen_at = timestamp;

  return updated;
}

function mergeCurrentResponse(prev: CurrentResponse | null, next: CurrentResponse): CurrentResponse {
  if (!prev) return next;
  const previousById = new Map(prev.devices.map((device) => [device.device_id, device]));
  const devices = next.devices.map((device) => {
    const previous = previousById.get(device.device_id);
    if (!previous) return device;
    const previousSeen = previous.last_seen_at ? Date.parse(previous.last_seen_at) : 0;
    const nextSeen = device.last_seen_at ? Date.parse(device.last_seen_at) : 0;
    return previousSeen > nextSeen ? previous : device;
  });
  return { ...next, devices };
}

function currentDevicesSignature(devices: DeviceState[]): string {
  return devices.map((device) => [
    device.device_id,
    device.is_online,
    device.last_seen_at,
    device.app_id,
    device.app_name,
    device.display_title || "",
    device.window_title || "",
    device.extra?.battery_percent ?? "",
    device.extra?.battery_charging ?? "",
    device.extra?.sleeping ?? "",
    device.extra?.foreground?.package_name || "",
    device.extra?.foreground?.title || "",
    device.extra?.media?.playing ?? "",
    device.extra?.media?.title || "",
    device.extra?.device?.profile || "",
    device.extra?.device?.frozen_packages?.map((item) => `${item.package_name || ""}:${item.mode || ""}:${item.until || ""}`).join(",") || "",
  ].join("\u001f")).join("\u001e");
}

function timelineSignature(timeline: TimelineResponse): string {
  const segmentKey = timeline.segments.map((segment) => [
    segment.device_id,
    segment.app_id,
    segment.app_name,
    segment.display_title || "",
    segment.started_at,
    segment.ended_at || "",
    segment.duration_seconds,
  ].join("\u001f")).join("\u001e");
  const summaryKey = Object.keys(timeline.summary)
    .sort()
    .map((deviceId) => {
      const values = timeline.summary[deviceId] || {};
      return `${deviceId}:${Object.keys(values).sort().map((app) => `${app}=${values[app]}`).join(",")}`;
    })
    .join("\u001e");
  return `${timeline.date}|${timeline.window || ""}|${segmentKey}|${summaryKey}`;
}

function msUntilNextLocalDay(): number {
  const now = new Date();
  const next = new Date(now);
  next.setHours(24, 0, 0, 0);
  return Math.max(1_000, next.getTime() - now.getTime() + 1_000);
}

export function useDashboard() {
  const [current, setCurrent] = useState<CurrentResponse | null>(null);
  const [timeline, setTimeline] = useState<TimelineResponse | null>(null);
  const [serverTime, setServerTime] = useState("");
  const [selectedDate, setSelectedDate] = useState("");
  const [loading, setLoading] = useState(true);
  const [timelineLoading, setTimelineLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [viewerCount, setViewerCount] = useState(0);
  const [wsConnected, setWsConnected] = useState(false);
  const wsConnectedRef = useRef(false);
  const selectedDateRef = useRef("");
  const refreshTimelineRef = useRef<(() => void) | null>(null);
  const timelineRefreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const firstLoad = useRef(true);

  useEffect(() => {
    selectedDateRef.current = selectedDate;
  }, [selectedDate]);

  useEffect(() => {
    setSelectedDate(todayStr());
  }, []);

  useEffect(() => {
    const unsubscribeState = subscribeRealtimeState((next) => {
      wsConnectedRef.current = next;
      setWsConnected(next);
    });

    const unsubscribeMessages = subscribeRealtime((msg) => {
      if (msg.type === "device_update" && msg.device_id && msg.payload) {
        setCurrent((prev) => {
          if (!prev) return prev;
          const idx = prev.devices.findIndex((d) => d.device_id === msg.device_id);
          if (idx === -1) return prev;
          const devices = [...prev.devices];
          devices[idx] = mergeDevicePayload(devices[idx], msg.payload, msg.timestamp);
          return { ...prev, devices };
        });
        if (selectedDateRef.current === todayStr()) {
          if (timelineRefreshTimer.current) clearTimeout(timelineRefreshTimer.current);
          timelineRefreshTimer.current = setTimeout(() => {
            timelineRefreshTimer.current = null;
            if (selectedDateRef.current === todayStr()) refreshTimelineRef.current?.();
          }, TIMELINE_EVENT_DEBOUNCE);
        }
      }
      if (msg.type === "viewer_count" && typeof msg.count === "number") {
        setViewerCount(msg.count);
      }
    });

    return () => {
      if (timelineRefreshTimer.current) clearTimeout(timelineRefreshTimer.current);
      unsubscribeMessages();
      unsubscribeState();
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let currentRequestId = 0;
    let timelineRequestId = 0;

    const doFetchTimeline = async (showLoading = false) => {
      const thisRequest = ++timelineRequestId;
      if (showLoading) setTimelineLoading(true);
      try {
        const tl = await fetchTimeline(selectedDate, controller.signal);
        if (!controller.signal.aborted && thisRequest === timelineRequestId) {
          setTimeline((prev) => {
            if (prev && timelineSignature(prev) === timelineSignature(tl)) return prev;
            return tl;
          });
        }
      } catch {
        // Timeline fetch errors are non-critical.
      } finally {
        if (!controller.signal.aborted && thisRequest === timelineRequestId) {
          setTimelineLoading(false);
        }
      }
    };

    const doFetchCurrent = async () => {
      const thisRequest = ++currentRequestId;
      try {
        setError(null);
        if (firstLoad.current) setLoading(true);
        const cur = await fetchCurrent(controller.signal);
        if (!controller.signal.aborted && thisRequest === currentRequestId) {
          setServerTime((prev) => prev === cur.server_time ? prev : cur.server_time);
          setCurrent((prev) => {
            const merged = mergeCurrentResponse(prev, cur);
            if (prev && currentDevicesSignature(prev.devices) === currentDevicesSignature(merged.devices)) return prev;
            return { ...merged, server_time: cur.server_time };
          });
          setViewerCount((prev) => {
            const next = cur.viewer_count ?? 0;
            return prev === next ? prev : next;
          });
          firstLoad.current = false;
        }
      } catch (e) {
        if (!controller.signal.aborted && thisRequest === currentRequestId) {
          setError(e instanceof Error ? e.message : "数据拉取失败，正在重试");
        }
      } finally {
        if (!controller.signal.aborted && thisRequest === currentRequestId) {
          setLoading(false);
        }
      }
    };

    if (!selectedDate) return;
    firstLoad.current = true;
    setTimelineLoading(true);
    refreshTimelineRef.current = () => {
      void doFetchTimeline(false);
    };

    doFetchCurrent();
    doFetchTimeline(true);

    const timelinePollId = selectedDate === todayStr()
      ? setInterval(() => {
        if (selectedDate === todayStr() && !wsConnectedRef.current) {
          void doFetchTimeline(false);
        }
      }, TIMELINE_POLL_INTERVAL)
      : null;
    const devicePollId = setInterval(() => {
      if (!wsConnectedRef.current) {
        doFetchCurrent();
      }
    }, DEVICE_POLL_INTERVAL);
    const midnightTimer = selectedDate === todayStr()
      ? setTimeout(() => {
        setSelectedDate(todayStr());
      }, msUntilNextLocalDay())
      : null;

    return () => {
      refreshTimelineRef.current = null;
      controller.abort();
      if (timelinePollId) clearInterval(timelinePollId);
      clearInterval(devicePollId);
      if (midnightTimer) clearTimeout(midnightTimer);
    };
  }, [selectedDate]);

  const changeDate = useCallback((date: string) => {
    setSelectedDate(date);
  }, []);

  return { current, timeline, serverTime, selectedDate, changeDate, loading, timelineLoading, error, viewerCount, wsConnected };
}

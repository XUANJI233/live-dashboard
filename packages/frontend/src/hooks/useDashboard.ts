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

function shallowEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }
  const ka = Object.keys(a as Record<string, unknown>);
  const kb = Object.keys(b as Record<string, unknown>);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if ((a as Record<string, unknown>)[k] !== (b as Record<string, unknown>)[k]) return false;
  }
  return true;
}

export function useDashboard() {
  const [current, setCurrent] = useState<CurrentResponse | null>(null);
  const [timeline, setTimeline] = useState<TimelineResponse | null>(null);
  const [selectedDate, setSelectedDate] = useState("");
  const [loading, setLoading] = useState(true);
  const [timelineLoading, setTimelineLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [viewerCount, setViewerCount] = useState(0);
  const [wsConnected, setWsConnected] = useState(false);
  const wsConnectedRef = useRef(false);
  const firstLoad = useRef(true);

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
      }
      if (msg.type === "viewer_count" && typeof msg.count === "number") {
        setViewerCount(msg.count);
      }
    });

    return () => {
      unsubscribeMessages();
      unsubscribeState();
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let currentRequestId = 0;
    let timelineRequestId = 0;

    const doFetchTimeline = async () => {
      const thisRequest = ++timelineRequestId;
      setTimelineLoading(true);
      try {
        const tl = await fetchTimeline(selectedDate, controller.signal);
        if (!controller.signal.aborted && thisRequest === timelineRequestId) {
          setTimeline((prev) => {
            if (prev && shallowEqual(prev.segments, tl.segments) && shallowEqual(prev.summary, tl.summary)) return prev;
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
          setCurrent((prev) => {
            const merged = mergeCurrentResponse(prev, cur);
            if (prev && shallowEqual(prev.devices, merged.devices) && prev.server_time === merged.server_time) return prev;
            return merged;
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

    doFetchCurrent();
    doFetchTimeline();

    const timelinePollId = setInterval(doFetchTimeline, TIMELINE_POLL_INTERVAL);
    const devicePollId = setInterval(() => {
      if (!wsConnectedRef.current) {
        doFetchCurrent();
      }
    }, DEVICE_POLL_INTERVAL);

    return () => {
      controller.abort();
      clearInterval(timelinePollId);
      clearInterval(devicePollId);
    };
  }, [selectedDate]);

  const changeDate = useCallback((date: string) => {
    setSelectedDate(date);
  }, []);

  return { current, timeline, selectedDate, changeDate, loading, timelineLoading, error, viewerCount, wsConnected };
}

"use client";
import { useState, useEffect, useCallback, useRef } from "react";
import {
  fetchCurrent,
  fetchTimeline,
  getRealtimeUrl,
  type CurrentResponse,
  type DeviceState,
  type TimelineResponse,
} from "@/lib/api";
import { ensureViewerToken } from "@/lib/viewer-token";

const TIMELINE_POLL_INTERVAL = 30 * 1000;
const DEVICE_POLL_INTERVAL = 15 * 1000; // slower fallback polling for devices
const WS_RECONNECT_BASE = 3000;
const WS_RECONNECT_MAX = 30000;

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Merge a raw device_update payload into an existing DeviceState.
 * The payload is the server-sanitized device update, not the full DeviceState
 * shape, so we only overwrite fields that are present.
 */
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

  // Deep-merge extra
  if (payload.extra && typeof payload.extra === "object" && !Array.isArray(payload.extra)) {
    const incoming = payload.extra as Record<string, unknown>;
    const base = (existing.extra ?? {}) as Record<string, unknown>;
    const merged: Record<string, unknown> = { ...base };

    for (const [key, val] of Object.entries(incoming)) {
      if (val && typeof val === "object" && !Array.isArray(val) &&
          base[key] && typeof base[key] === "object" && !Array.isArray(base[key])) {
        merged[key] = { ...(base[key] as Record<string, unknown>), ...(val as Record<string, unknown>) };
      } else {
        merged[key] = val;
      }
    }
    updated.extra = merged as DeviceState["extra"];
  }

  // Device is actively reporting → online, update last_seen
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

/** Shallow compare two objects — returns true if equal (no re-render needed) */
function shallowEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  // Handle arrays: compare length + each element by reference
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }
  // Handle objects: compare keys + each value by reference
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
  // SSR-safe: initialize with empty string, set real date in useEffect
  // todayStr() uses new Date() which can differ between server and client
  const [selectedDate, setSelectedDate] = useState("");
  const [loading, setLoading] = useState(true);
  const [timelineLoading, setTimelineLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [viewerCount, setViewerCount] = useState(0);
  const [wsConnected, setWsConnected] = useState(false);
  const wsConnectedRef = useRef(false);
  const firstLoad = useRef(true);

  // Initialize selectedDate on client mount (SSR-safe)
  useEffect(() => {
    setSelectedDate(todayStr());
  }, []);

  // ── Effect 1: WebSocket for real-time device updates ──────────────────
  useEffect(() => {
    if (typeof window === "undefined") return;

    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectDelay = WS_RECONNECT_BASE;
    let disposed = false;

    async function connect() {
      let token = "";
      try {
        token = (await ensureViewerToken()).token;
      } catch {
        if (!disposed) reconnectTimer = setTimeout(connect, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, WS_RECONNECT_MAX);
        return;
      }
      if (disposed) return;

      ws = new WebSocket(getRealtimeUrl(token));

      ws.onopen = () => {
        setWsConnected(true);
        wsConnectedRef.current = true;
        reconnectDelay = WS_RECONNECT_BASE; // reset backoff
      };

      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data as string);
          if (msg.type === "device_update" && msg.device_id && msg.payload) {
            setCurrent((prev) => {
              if (!prev) return prev;
              const idx = prev.devices.findIndex((d) => d.device_id === msg.device_id);
              if (idx === -1) return prev; // unknown device, skip
              const devices = [...prev.devices];
              devices[idx] = mergeDevicePayload(devices[idx], msg.payload, msg.timestamp);
              return { ...prev, devices };
            });
          }
          // Handle viewer_count updates if the server pushes them
          if (msg.type === "viewer_count" && typeof msg.count === "number") {
            setViewerCount(msg.count);
          }
        } catch {
          // ignore unparseable messages
        }
      };

      ws.onclose = () => {
        setWsConnected(false);
        wsConnectedRef.current = false;
        ws = null;
        if (!disposed) {
          reconnectTimer = setTimeout(connect, reconnectDelay);
          reconnectDelay = Math.min(reconnectDelay * 2, WS_RECONNECT_MAX);
        }
      };

      ws.onerror = () => {
        // onclose will fire after onerror — reconnect handled there
      };
    }

    connect();

    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ws) {
        ws.onclose = null; // prevent reconnect on intentional close
        ws.close();
      }
    };
  }, []);

  // ── Effect 2: Polling ─────────────────────────────────────────────────
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
            setTimeline(prev => {
              if (prev && shallowEqual(prev.segments, tl.segments) && shallowEqual(prev.summary, tl.summary)) return prev;
              return tl;
            });
        }
      } catch {
        // timeline fetch errors are non-critical
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
          setCurrent(prev => {
            const merged = mergeCurrentResponse(prev, cur);
            if (prev && shallowEqual(prev.devices, merged.devices) && prev.server_time === merged.server_time) return prev;
            return merged;
          });
          setViewerCount(prev => {
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

    // Skip fetch if selectedDate is not yet initialized (SSR-safe)
    if (!selectedDate) return;
    firstLoad.current = true;

    // Always do an initial full fetch
    doFetchCurrent();
    doFetchTimeline();

    // Timeline always polls (cheap, data changes throughout the day)
    const timelinePollId = setInterval(doFetchTimeline, TIMELINE_POLL_INTERVAL);

    // Device state polls only as fallback when WS is down.
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

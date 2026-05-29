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

const TIMELINE_POLL_INTERVAL = 10 * 1000;
const DEVICE_POLL_INTERVAL = 15 * 1000; // slower fallback polling for devices
const WS_RECONNECT_BASE = 3000;
const WS_RECONNECT_MAX = 30000;

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function getViewerToken(): string | null {
  if (typeof window === "undefined") return null;
  const token = localStorage.getItem("live-dashboard-viewer-token");
  const exp = Number(localStorage.getItem("live-dashboard-viewer-token-exp") || 0);
  if (token && Date.now() < exp - 60_000) return token;
  return null;
}

/**
 * Merge a raw device_update payload into an existing DeviceState.
 * The payload is the device report body (app_id, window_title, extra, …),
 * NOT the full DeviceState shape, so we only overwrite fields that are present.
 */
function mergeDevicePayload(
  existing: DeviceState,
  payload: Record<string, unknown>,
  timestamp: string,
): DeviceState {
  const updated: DeviceState = { ...existing };

  if (typeof payload.app_id === "string") updated.app_id = payload.app_id;
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

    function connect() {
      const token = getViewerToken();
      if (!token) {
        // No token yet (PoW not done) — retry shortly
        if (!disposed) reconnectTimer = setTimeout(connect, 2000);
        return;
      }

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
    let requestId = 0;

    const doFetchTimeline = async () => {
      const thisRequest = ++requestId;
      setTimelineLoading(true);
      try {
        const tl = await fetchTimeline(selectedDate, controller.signal);
        if (!controller.signal.aborted && thisRequest === requestId) {
          setTimeline(tl);
        }
      } catch {
        // timeline fetch errors are non-critical
      } finally {
        if (!controller.signal.aborted && thisRequest === requestId) {
          setTimelineLoading(false);
        }
      }
    };

    const doFetchCurrent = async () => {
      const thisRequest = ++requestId;
      try {
        setError(null);
        if (firstLoad.current) setLoading(true);
        const cur = await fetchCurrent(controller.signal);
        if (!controller.signal.aborted && thisRequest === requestId) {
          setCurrent(cur);
          setViewerCount(cur.viewer_count ?? 0);
          firstLoad.current = false;
        }
      } catch (e) {
        if (!controller.signal.aborted && thisRequest === requestId) {
          setError(e instanceof Error ? e.message : "Failed to fetch data");
        }
      } finally {
        if (!controller.signal.aborted && thisRequest === requestId) {
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

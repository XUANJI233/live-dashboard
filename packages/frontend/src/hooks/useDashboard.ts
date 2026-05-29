"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
  fetchCurrent,
  fetchTimeline,
  type CurrentResponse,
  type TimelineResponse,
} from "@/lib/api";

const POLL_INTERVAL = 10 * 1000; // 10 seconds

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function useDashboard() {
  const [current, setCurrent] = useState<CurrentResponse | null>(null);
  const [timeline, setTimeline] = useState<TimelineResponse | null>(null);
  // SSR-safe: initialize with empty string, set real date in useEffect
  // todayStr() uses new Date() which can differ between server and client
  const [selectedDate, setSelectedDate] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [viewerCount, setViewerCount] = useState(0);
  const firstLoad = useRef(true);

  // Initialize selectedDate on client mount (SSR-safe)
  useEffect(() => {
    setSelectedDate(todayStr());
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let requestId = 0;

    const doFetch = async () => {
      const thisRequest = ++requestId;
      try {
        setError(null);
        if (firstLoad.current) setLoading(true);
        const [cur, tl] = await Promise.all([
          fetchCurrent(controller.signal),
          fetchTimeline(selectedDate, controller.signal),
        ]);
        if (!controller.signal.aborted && thisRequest === requestId) {
          setCurrent(cur);
          setTimeline(tl);
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
    doFetch();
    const pollId = setInterval(doFetch, POLL_INTERVAL);

    return () => {
      controller.abort();
      clearInterval(pollId);
    };
  }, [selectedDate]);

  const changeDate = useCallback((date: string) => {
    setSelectedDate(date);
  }, []);

  return { current, timeline, selectedDate, changeDate, loading, error, viewerCount };
}

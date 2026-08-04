import {
  cleanupExpiredMessages,
  cleanupOldActivities,
  cleanupOldAiJobs,
  cleanupOldDeviceCommandResults,
  cleanupOldDeviceCommands,
  cleanupOldLocations,
  cleanupOldSummaries,
  cleanupOldWeeklySummaries,
  getDailySummary,
  getWeeklySummary,
  markOfflineDevices,
  optimizeDatabase,
} from "../db";
import type { DeviceInfo } from "../types";
import { getSummarySettings } from "./daily-summary-gen";
import { submitAiJob } from "./ai-jobs";
import { collectDueSummaryJobs, initialSummaryScheduleState } from "./summary-scheduler";
import { runSupervisionTick } from "./supervision";

// Cleanup old activities + old summaries every hour
const hourlyCleanupTimer = setInterval(() => {
  try {
    const result = cleanupOldActivities.run();
    if (result.changes > 0) {
      console.log(`[cleanup] Deleted ${result.changes} old activity records`);
    }
  } catch (e) {
    console.error("[cleanup] Activities cleanup failed:", e);
  }

  try {
    const locationResult = cleanupOldLocations.run();
    if (locationResult.changes > 0) {
      console.log(`[cleanup] Deleted ${locationResult.changes} old location records`);
    }
  } catch (e) {
    console.error("[cleanup] Locations cleanup failed:", e);
  }

  try {
    const messageResult = cleanupExpiredMessages.run();
    if (messageResult.changes > 0) {
      console.log(`[cleanup] Deleted ${messageResult.changes} expired device messages`);
    }
  } catch (e) {
    console.error("[cleanup] Messages cleanup failed:", e);
  }

  try {
    const commandEventResult = cleanupOldDeviceCommandResults.run();
    const commandResult = cleanupOldDeviceCommands.run();
    if (commandResult.changes > 0 || commandEventResult.changes > 0) {
      console.log(`[cleanup] Deleted ${commandResult.changes} old device commands and ${commandEventResult.changes} command results`);
    }
  } catch (e) {
    console.error("[cleanup] Device command cleanup failed:", e);
  }

  try {
    const aiJobResult = cleanupOldAiJobs.run();
    if (aiJobResult.changes > 0) {
      console.log(`[cleanup] Deleted ${aiJobResult.changes} old AI jobs`);
    }
  } catch (e) {
    console.error("[cleanup] AI job cleanup failed:", e);
  }

  try {
    const summaryResult = cleanupOldSummaries.run();
    if (summaryResult.changes > 0) {
      console.log(`[cleanup] Deleted ${summaryResult.changes} old daily summaries`);
    }
  } catch (e) {
    console.error("[cleanup] Summaries cleanup failed:", e);
  }

  try {
    const weeklySummaryResult = cleanupOldWeeklySummaries.run();
    if (weeklySummaryResult.changes > 0) {
      console.log(`[cleanup] Deleted ${weeklySummaryResult.changes} old weekly summaries`);
    }
  } catch (e) {
    console.error("[cleanup] Weekly summaries cleanup failed:", e);
  }

  try {
    optimizeDatabase();
  } catch (e) {
    console.error("[cleanup] SQLite optimize failed:", e);
  }
}, 60 * 60 * 1000);
hourlyCleanupTimer.unref();

// Mark offline devices every 60 seconds
const offlineTimer = setInterval(() => {
  try {
    markOfflineDevices.run();
  } catch {
    // silent
  }
}, 60_000);
offlineTimer.unref();

// AI summaries — check every minute, trigger according to server-synced settings.
let summaryScheduleState = initialSummaryScheduleState();
const summaryTimer = setInterval(() => {
  const now = new Date();
  const settings = getSummarySettings();
  const scheduled = collectDueSummaryJobs(now, settings, summaryScheduleState);
  summaryScheduleState = scheduled.state;
  for (const job of scheduled.jobs) {
    if (job.kind === "daily") {
      if (hasStoredSummary("daily", job.date)) continue;
      queueScheduledSummaryJob("daily_summary", {
        date: job.date,
        tz_offset_minutes: job.tzOffsetMinutes,
      });
    } else {
      if (hasStoredSummary("weekly", job.weekStart)) continue;
      queueScheduledSummaryJob("weekly_summary", {
        week_start: job.weekStart,
        tz_offset_minutes: job.tzOffsetMinutes,
      });
    }
  }
}, 60_000);
summaryTimer.unref();

const supervisionTimer = setInterval(() => {
  runSupervisionTick().catch((e) => console.error("[cleanup] AI supervision failed:", e));
}, 300_000);
supervisionTimer.unref();

console.log("[cleanup] Scheduled: hourly cleanup, 60s offline check, configurable AI summaries, AI supervision");

function hasStoredSummary(kind: "daily" | "weekly", key: string): boolean {
  const row = (kind === "daily"
    ? getDailySummary.get(key)
    : getWeeklySummary.get(key)) as { generated_at?: string; summary?: string } | null;
  return Boolean(row?.generated_at || row?.summary);
}

const schedulerDevice: DeviceInfo = {
  device_id: "__server_scheduler__",
  device_name: "Live Dashboard Scheduler",
  platform: "windows",
};

function queueScheduledSummaryJob(
  kind: "daily_summary" | "weekly_summary",
  payload: Record<string, unknown>,
): void {
  try {
    const submitted = submitAiJob({
      kind,
      payload,
      device: schedulerDevice,
      deviceToken: "",
    });
    if (!submitted.attached) {
      console.log(`[cleanup] Queued ${kind} AI job ${submitted.job.request_id}`);
    }
  } catch (e) {
    console.error(`[cleanup] ${kind} AI job queue failed:`, e);
  }
}

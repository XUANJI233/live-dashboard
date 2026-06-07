import { cleanupExpiredMessages, cleanupOldActivities, cleanupOldLocations, cleanupOldSummaries, cleanupOldWeeklySummaries, markOfflineDevices, optimizeDatabase } from "../db";
import { generateDailySummary, generateWeeklySummary, getSummarySettings, isoWeekday } from "./daily-summary-gen";
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
let lastDailySummaryDate = "";
let lastWeeklySummaryKey = "";
const summaryTimer = setInterval(() => {
  const now = new Date();
  const settings = getSummarySettings();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const clock = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  if (settings.daily_summary_time && clock === settings.daily_summary_time && today !== lastDailySummaryDate) {
    lastDailySummaryDate = today;
    generateDailySummary({ date: today }).catch((e) => console.error("[cleanup] AI daily summary failed:", e));
  }
  const weeklyKey = `${today}:${settings.weekly_summary_weekday}:${settings.weekly_summary_time}`;
  if (
    settings.weekly_summary_time &&
    clock === settings.weekly_summary_time &&
    isoWeekday(today) === settings.weekly_summary_weekday &&
    weeklyKey !== lastWeeklySummaryKey
  ) {
    lastWeeklySummaryKey = weeklyKey;
    generateWeeklySummary({ date: today }).catch((e) => console.error("[cleanup] AI weekly summary failed:", e));
  }
}, 60_000);
summaryTimer.unref();

const supervisionTimer = setInterval(() => {
  runSupervisionTick().catch((e) => console.error("[cleanup] AI supervision failed:", e));
}, 300_000);
supervisionTimer.unref();

console.log("[cleanup] Scheduled: hourly cleanup, 60s offline check, configurable AI summaries, AI supervision");

import { cleanupExpiredMessages, cleanupOldActivities, cleanupOldLocations, cleanupOldSummaries, cleanupOldWeeklySummaries, markOfflineDevices, optimizeDatabase } from "../db";
import { generateDailySummary } from "./daily-summary-gen";

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

// AI daily summary — check every minute, trigger at 21:00
let lastSummaryDate = "";
const summaryTimer = setInterval(() => {
  const now = new Date();
  if (now.getHours() === 21 && now.getMinutes() === 0) {
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    if (today !== lastSummaryDate) {
      lastSummaryDate = today;
      generateDailySummary().catch((e) => console.error("[cleanup] AI summary failed:", e));
    }
  }
}, 60_000);
summaryTimer.unref();

console.log("[cleanup] Scheduled: hourly cleanup, 60s offline check, 21:00 AI summary");

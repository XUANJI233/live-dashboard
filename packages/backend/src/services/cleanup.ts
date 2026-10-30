import {
  cleanupExpiredMessages,
  cleanupExpiredDeviceScreenshots,
  cleanupOldActivities,
  cleanupOldAiJobs,
  cleanupOldControllerEvents,
  cleanupOldDeviceCommandResults,
  cleanupOldDeviceCommands,
  cleanupOldLocations,
  cleanupOldSummaries,
  cleanupOldWeeklySummaries,
  getDailySummary,
  getWeeklySummary,
  optimizeDatabase,
} from "../db";
import type { DeviceInfo } from "../types";
import { getSummarySettings } from "./daily-summary-gen";
import { expireUnclaimedDelegatedAiJobs, submitAiJob } from "./ai-jobs";
import { collectDueSummaryJobs, initialSummaryScheduleState } from "./summary-scheduler";
import { runSupervisionTick } from "./supervision";
import { checkOfflineDevices } from "./offline-controller";
import { maybeNudgeUnreachableController } from "./controller-health";
import { enforceCommitments } from "./commitment-enforcement";
import { cleanupOldInstalledAppChanges } from "./installed-app-changes";
import { flushControllerEvents } from "./controller-event-outbox";
import { maintainLedger } from "./ledger";
import { queueDueLedgerWake } from "./ledger-due";

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
    const installedResult = cleanupOldInstalledAppChanges.run();
    if (installedResult.changes > 0) {
      console.log(`[cleanup] Deleted ${installedResult.changes} old installed-app changes`);
    }
  } catch (e) {
    console.error("[cleanup] Installed-app changes cleanup failed:", e);
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
    const screenshotResult = cleanupExpiredDeviceScreenshots.run();
    if (screenshotResult.changes > 0) {
      console.log(`[cleanup] Deleted ${screenshotResult.changes} expired device screenshots`);
    }
  } catch (e) {
    console.error("[cleanup] Device screenshot cleanup failed:", e);
  }

  try {
    const expired = expireUnclaimedDelegatedAiJobs();
    if (expired > 0) {
      console.warn(`[cleanup] Failed ${expired} delegated AI jobs the controller never claimed`);
    }
  } catch (e) {
    console.error("[cleanup] Delegated AI job expiry failed:", e);
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
    const controllerEventResult = cleanupOldControllerEvents.run();
    if (controllerEventResult.changes > 0) {
      console.log(`[cleanup] Deleted ${controllerEventResult.changes} delivered controller events`);
    }
  } catch (e) {
    console.error("[cleanup] Controller event cleanup failed:", e);
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
    const ledgerResult = maintainLedger();
    if (ledgerResult.closed > 0 || ledgerResult.pruned > 0) {
      console.log(`[cleanup] Ledger: closed ${ledgerResult.closed} past their clock, deleted ${ledgerResult.pruned} old records`);
    }
  } catch (e) {
    console.error("[cleanup] Ledger maintenance failed:", e);
  }

  try {
    optimizeDatabase();
  } catch (e) {
    console.error("[cleanup] SQLite optimize failed:", e);
  }
}, 60 * 60 * 1000);
hourlyCleanupTimer.unref();

// Mark offline devices every 60 seconds
let offlineCheckRunning = false;
const offlineTimer = setInterval(() => {
  if (offlineCheckRunning) return;
  offlineCheckRunning = true;
  checkOfflineDevices()
    .then((result) => {
      if (result.pending > 0) {
        console.warn(`[offline-controller] ${result.pending} controller event(s) pending delivery`);
      }
      if (maybeNudgeUnreachableController()) {
        console.warn("[controller-health] controller unreachable; told the phone once");
      }
    })
    .catch((error) => console.error("[offline-controller] device offline check failed:", error))
    .finally(() => {
      offlineCheckRunning = false;
    });
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

// Commitments hold without a controller: re-freeze, relock exceptions, release closed windows.
const commitmentTimer = setInterval(() => {
  try {
    const result = enforceCommitments();
    if (result.freeze_requests > 0 || result.unfreeze_requests > 0) {
      console.log(`[commitments] ${result.freeze_requests} freeze and ${result.unfreeze_requests} release request(s)`);
    }
  } catch (e) {
    console.error("[commitments] enforcement failed:", e);
  }
}, 60_000);
commitmentTimer.unref();

// The ledger wakes the controller when an agreed time arrives.
const ledgerTimer = setInterval(() => {
  try {
    const now = new Date();
    if (queueDueLedgerWake(now) === "queued") {
      flushControllerEvents(now).catch((e) => console.error("[ledger] due wake delivery failed:", e));
    }
  } catch (e) {
    console.error("[ledger] due wake failed:", e);
  }
}, 60_000);
ledgerTimer.unref();

const supervisionTimer = setInterval(() => {
  runSupervisionTick().catch((e) => console.error("[cleanup] AI supervision failed:", e));
}, 300_000);
supervisionTimer.unref();

console.log("[cleanup] Scheduled: hourly cleanup, 60s offline check, commitment enforcement and ledger wakes, configurable AI summaries, AI supervision");

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

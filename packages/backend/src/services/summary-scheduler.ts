import { isoWeekday, startOfWeek, summaryTimezoneOffset, type SummarySettings } from "./daily-summary-gen";
import { localClockStringForOffset, localDateStringForOffset } from "./prompt-time";

export interface SummaryScheduleState {
  lastDailySummaryDate: string;
  lastWeeklySummaryKey: string;
}

export type ScheduledSummaryJob =
  | { kind: "daily"; date: string; tzOffsetMinutes: number }
  | { kind: "weekly"; date: string; weekStart: string; tzOffsetMinutes: number };

export function initialSummaryScheduleState(): SummaryScheduleState {
  return {
    lastDailySummaryDate: "",
    lastWeeklySummaryKey: "",
  };
}

export function collectDueSummaryJobs(
  now: Date,
  settings: SummarySettings,
  state: SummaryScheduleState,
): { jobs: ScheduledSummaryJob[]; state: SummaryScheduleState } {
  const tzOffsetMinutes = summaryTimezoneOffset(settings);
  const today = localDateStringForOffset(now, tzOffsetMinutes);
  const clock = localClockStringForOffset(now, tzOffsetMinutes);
  const jobs: ScheduledSummaryJob[] = [];
  const nextState = { ...state };

  if (settings.daily_summary_time && clockAtOrAfter(clock, settings.daily_summary_time) && today !== state.lastDailySummaryDate) {
    nextState.lastDailySummaryDate = today;
    jobs.push({ kind: "daily", date: today, tzOffsetMinutes });
  }

  const weekStart = startOfWeek(today);
  const weeklyKey = `${weekStart}:${settings.weekly_summary_weekday}:${settings.weekly_summary_time}:tz=${tzOffsetMinutes}`;
  if (
    settings.weekly_summary_time &&
    clockAtOrAfter(clock, settings.weekly_summary_time) &&
    isoWeekday(today) === settings.weekly_summary_weekday &&
    weeklyKey !== state.lastWeeklySummaryKey
  ) {
    nextState.lastWeeklySummaryKey = weeklyKey;
    jobs.push({ kind: "weekly", date: today, weekStart, tzOffsetMinutes });
  }

  return { jobs, state: nextState };
}

function clockAtOrAfter(clock: string, scheduledClock: string): boolean {
  return /^\d{2}:\d{2}$/.test(clock) &&
    /^\d{2}:\d{2}$/.test(scheduledClock) &&
    clock >= scheduledClock;
}

import { metaGet, metaSet } from "../db";

const LAST_SCHEDULED_REVIEW_USAGE_KEY = "supervision_last_scheduled_review_usage";
// Unchanged usage may skip at most two due periodic reviews in a row, and never
// once the last delivered review is four hours old, so a long steady stretch is
// still looked at again instead of waiting indefinitely for a change.
const MAX_UNCHANGED_SKIPS = 2;
const MAX_UNCHANGED_REVIEW_AGE_MS = 4 * 60 * 60_000;

export interface ScheduledReviewUsageState {
  signature: string;
  reviewed_at: string;
  skipped_rounds: number;
}

/** Decide whether a due periodic review can be skipped because usage has not materially changed. */
export function nextScheduledReviewState(
  previous: ScheduledReviewUsageState | null,
  signature: string,
  now: Date,
): { skip: boolean; state: ScheduledReviewUsageState } {
  if (
    previous
    && previous.signature === signature
    && previous.skipped_rounds < MAX_UNCHANGED_SKIPS
    && now.getTime() - Date.parse(previous.reviewed_at) < MAX_UNCHANGED_REVIEW_AGE_MS
  ) {
    return { skip: true, state: { ...previous, skipped_rounds: previous.skipped_rounds + 1 } };
  }
  return { skip: false, state: { signature, reviewed_at: now.toISOString(), skipped_rounds: 0 } };
}

export function readScheduledReviewState(): ScheduledReviewUsageState | null {
  try {
    const value = JSON.parse(metaGet(LAST_SCHEDULED_REVIEW_USAGE_KEY) || "null") as Record<string, unknown> | null;
    if (!value || typeof value.signature !== "string" || typeof value.reviewed_at !== "string") return null;
    if (!Number.isFinite(Date.parse(value.reviewed_at))) return null;
    const skipped = typeof value.skipped_rounds === "number" && Number.isInteger(value.skipped_rounds) && value.skipped_rounds >= 0
      ? value.skipped_rounds
      : 0;
    return { signature: value.signature, reviewed_at: value.reviewed_at, skipped_rounds: skipped };
  } catch {
    return null;
  }
}

export function writeScheduledReviewState(state: ScheduledReviewUsageState): void {
  metaSet(LAST_SCHEDULED_REVIEW_USAGE_KEY, JSON.stringify(state));
}

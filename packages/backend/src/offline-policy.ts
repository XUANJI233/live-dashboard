export const ACTIVE_DEVICE_OFFLINE_TIMEOUT_MINUTES = 1;
export const SLEEPING_DEVICE_OFFLINE_TIMEOUT_MINUTES = 20;
export const MIN_REPORTED_OFFLINE_TIMEOUT_MINUTES = ACTIVE_DEVICE_OFFLINE_TIMEOUT_MINUTES;
export const MAX_REPORTED_OFFLINE_TIMEOUT_MINUTES = 60;
export const OFFLINE_TIMEOUT_FIELD = "offline_timeout_minutes";

export interface ReportedOfflineTimeoutResult {
  value?: number;
  error?: string;
}

export function validateReportedOfflineTimeoutMinutes(value: unknown): ReportedOfflineTimeoutResult {
  if (value == null) return {};
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return { error: `${OFFLINE_TIMEOUT_FIELD} must be a finite number of minutes` };
  }

  if (value < MIN_REPORTED_OFFLINE_TIMEOUT_MINUTES) {
    return { error: `${OFFLINE_TIMEOUT_FIELD} must be at least ${MIN_REPORTED_OFFLINE_TIMEOUT_MINUTES} minute` };
  }
  if (value > MAX_REPORTED_OFFLINE_TIMEOUT_MINUTES) {
    return { error: `${OFFLINE_TIMEOUT_FIELD} must not exceed ${MAX_REPORTED_OFFLINE_TIMEOUT_MINUTES} minutes` };
  }

  const rounded = Math.round(value);
  return { value: rounded };
}

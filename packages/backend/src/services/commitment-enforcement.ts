import { metaGet, metaSet } from "../db";
import { getDeviceContext, getDeviceInstalledApps } from "./device-context";
import { sendDeviceCommands } from "./device-control";
import {
  activeCommitments,
  commitmentInWindow,
  commitmentPackages,
  dueExceptions,
  endedCommitmentsStillMarkedInWindow,
  lockedPackages,
  markExceptionRelocked,
  openExceptionPackages,
  setCommitmentInWindow,
  type CommitmentRow,
} from "./commitments";

// Runs every minute. Live itself keeps committed packages frozen, so enforcement no longer waits
// for a controller to wake: it re-freezes after the Android LSP 03:00 cleanup, after a time-boxed
// exception runs out, and releases a window's packages when the window closes.

const RETRY_INTERVAL_MS = 10 * 60_000;
const MAX_FREEZE_PER_COMMAND = 12;

export interface EnforcementResult {
  freeze_requests: number;
  unfreeze_requests: number;
}

export function enforceCommitments(now = new Date()): EnforcementResult {
  const result: EnforcementResult = { freeze_requests: 0, unfreeze_requests: 0 };
  for (const exception of dueExceptions(now)) {
    // A short exception must not wait out the retry interval of the window's first freeze.
    metaSet(attemptKey(exception.commitment_id, exception.package_name), "");
    markExceptionRelocked(exception.exception_id, now);
  }

  const active = activeCommitments(now).filter((row) => row.kind === "block");
  const closing: CommitmentRow[] = endedCommitmentsStillMarkedInWindow();
  for (const row of active) {
    const inWindow = commitmentInWindow(row, now);
    if (inWindow) {
      if (row.in_window !== 1) setCommitmentInWindow(row.commitment_id, true, now);
      if (freezeMissing(row, now)) result.freeze_requests += 1;
    } else if (row.in_window === 1) {
      closing.push(row);
    }
  }
  for (const row of closing) {
    setCommitmentInWindow(row.commitment_id, false, now);
    if (releaseWindow(row, now)) result.unfreeze_requests += 1;
  }
  return result;
}

function freezeMissing(row: CommitmentRow, now: Date): boolean {
  const device = getDeviceContext(row.device_id);
  if (!device?.is_online) return false;
  const frozen = new Set(device.frozen_packages.map((item) => item.package_name));
  const open = openExceptionPackages(row.commitment_id, now);
  const installed = installedPackages(row.device_id);
  const missing = commitmentPackages(row).filter((name) => (
    !frozen.has(name)
    && !open.has(name)
    && (installed.size === 0 || installed.has(name))
    && !recentlyAttempted(row.commitment_id, name, now)
  )).slice(0, MAX_FREEZE_PER_COMMAND);
  if (missing.length === 0) return false;
  for (const name of missing) metaSet(attemptKey(row.commitment_id, name), now.toISOString());
  sendDeviceCommands({
    request_id: `commitment-freeze-${row.commitment_id}-${Math.floor(now.getTime() / 60_000)}`,
    created_by: "supervision",
    commands: [{ device_id: row.device_id, freeze_commands: missing }],
  }, { bypassCommitments: true });
  return true;
}

function releaseWindow(row: CommitmentRow, now: Date): boolean {
  // Another rule still in its window keeps its packages; release only what this window held.
  const stillLocked = lockedPackages(row.device_id, now);
  const release = commitmentPackages(row).filter((name) => !stillLocked.has(name)).slice(0, MAX_FREEZE_PER_COMMAND);
  if (release.length === 0 || !getDeviceContext(row.device_id)) return false;
  sendDeviceCommands({
    request_id: `commitment-release-${row.commitment_id}-${Math.floor(now.getTime() / 60_000)}`,
    created_by: "supervision",
    commands: [{ device_id: row.device_id, unfreeze_commands: release }],
  }, { bypassCommitments: true });
  return true;
}

function installedPackages(deviceId: string): Set<string> {
  return new Set(getDeviceInstalledApps(deviceId).installed_apps.map((app) => app.package_name));
}

function recentlyAttempted(commitmentId: string, packageName: string, now: Date): boolean {
  const last = Date.parse(metaGet(attemptKey(commitmentId, packageName)) || "");
  return Number.isFinite(last) && now.getTime() - last < RETRY_INTERVAL_MS;
}

function attemptKey(commitmentId: string, packageName: string): string {
  return `commitment_freeze_attempt:${commitmentId}:${packageName}`;
}

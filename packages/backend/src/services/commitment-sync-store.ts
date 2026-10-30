import { db } from "../db";

// Live's record of each committed package on the phone (commitment_package_state). Only command
// results move it: a freeze applied sets `frozen_until` to the phone's own expiry (its next local
// 03:00), a confirmed release clears it. `owned` is false when the package was already frozen by
// someone else (a controller, the phone's own time limit), so Live never releases that freeze.
// `exception_group` links a pending exception unfreeze, so its quota can be refunded if the
// phone never applies it.

export type PendingAction = "freeze" | "release" | "";

export interface PackageStateRow {
  device_id: string;
  package_name: string;
  frozen_until: string;
  confirmed_at: string;
  pending_command_id: string;
  pending_action: PendingAction;
  pending_sent_at: string;
  release_attempts: number;
  retry_after: string;
  owned: number;
  exception_group: string;
  updated_at: string;
}

const deviceStatesStmt = db.prepare("SELECT * FROM commitment_package_state WHERE device_id = ?");
const upsertStmt = db.prepare(`
  INSERT INTO commitment_package_state (
    device_id, package_name, frozen_until, confirmed_at, pending_command_id, pending_action,
    pending_sent_at, release_attempts, retry_after, owned, exception_group, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(device_id, package_name) DO UPDATE SET
    frozen_until = excluded.frozen_until,
    confirmed_at = excluded.confirmed_at,
    pending_command_id = excluded.pending_command_id,
    pending_action = excluded.pending_action,
    pending_sent_at = excluded.pending_sent_at,
    release_attempts = excluded.release_attempts,
    retry_after = excluded.retry_after,
    owned = excluded.owned,
    exception_group = excluded.exception_group,
    updated_at = excluded.updated_at
`);
const deleteStmt = db.prepare("DELETE FROM commitment_package_state WHERE device_id = ? AND package_name = ?");
const devicesStmt = db.prepare("SELECT DISTINCT device_id FROM commitment_package_state");

export function packageStates(deviceId: string): Map<string, PackageStateRow> {
  return new Map((deviceStatesStmt.all(deviceId) as PackageStateRow[]).map((row) => [row.package_name, row]));
}

export function emptyPackageState(deviceId: string, packageName: string, at: string): PackageStateRow {
  return {
    device_id: deviceId,
    package_name: packageName,
    frozen_until: "",
    confirmed_at: "",
    pending_command_id: "",
    pending_action: "",
    pending_sent_at: "",
    release_attempts: 0,
    retry_after: "",
    owned: 1,
    exception_group: "",
    updated_at: at,
  };
}

export function savePackageState(row: PackageStateRow): void {
  upsertStmt.run(
    row.device_id, row.package_name, row.frozen_until, row.confirmed_at, row.pending_command_id,
    row.pending_action, row.pending_sent_at, row.release_attempts, row.retry_after, row.owned,
    row.exception_group, row.updated_at,
  );
}

export function forgetPackageState(deviceId: string, packageName: string): void {
  deleteStmt.run(deviceId, packageName);
}

export function trackedDevices(): string[] {
  return (devicesStmt.all() as { device_id: string }[]).map((row) => row.device_id);
}

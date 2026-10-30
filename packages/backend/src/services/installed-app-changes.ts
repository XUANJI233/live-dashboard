import { db } from "../db";

// The phone reports a full installed-app snapshot; Live keeps only the latest one in device
// state. Diffs between consecutive snapshots make uninstall/reinstall visible for 30 days.
export const INSTALLED_CHANGES_SCHEMA = "live_dashboard.installed_app_changes.v1";
export const INSTALLED_CHANGES_CONTEXT_DAYS = 7;
export const INSTALLED_CHANGES_CONTEXT_LIMIT = 20;
export const INSTALLED_CHANGES_DEVICE_LIMIT = 50;
const RETENTION_DAYS = 30;
// A snapshot that hit the reporting cap may be cut at a different app each time; its diff is noise.
const SNAPSHOT_CAP = 512;
const MAX_CHANGES_PER_SNAPSHOT = 100;

export type InstalledAppChangeKind = "installed" | "removed";

export interface InstalledAppChange {
  device_id: string;
  package_name: string;
  app_name: string;
  change: InstalledAppChangeKind;
  /** When Live received the snapshot that first showed the change. */
  detected_at: string;
  /** When the device captured the previous snapshot; the change happened between the two. */
  previous_snapshot_at: string;
}

interface SnapshotApp {
  package_name: string;
  app_name: string;
}

const insertChangeStmt = db.prepare(`
  INSERT INTO installed_app_changes (device_id, package_name, app_name, change, detected_at, previous_snapshot_at)
  VALUES (?, ?, ?, ?, ?, ?)
`);

const countChangesSinceStmt = db.prepare(`
  SELECT COUNT(*) AS count
  FROM installed_app_changes
  WHERE detected_at >= ?
`);

const listChangesSinceStmt = db.prepare(`
  SELECT device_id, package_name, app_name, change, detected_at, previous_snapshot_at
  FROM installed_app_changes
  WHERE detected_at >= ?
  ORDER BY detected_at DESC, id DESC
  LIMIT ?
`);

const countDeviceChangesSinceStmt = db.prepare(`
  SELECT COUNT(*) AS count
  FROM installed_app_changes
  WHERE device_id = ? AND detected_at >= ?
`);

const listDeviceChangesSinceStmt = db.prepare(`
  SELECT device_id, package_name, app_name, change, detected_at, previous_snapshot_at
  FROM installed_app_changes
  WHERE device_id = ? AND detected_at >= ?
  ORDER BY detected_at DESC, id DESC
  LIMIT ?
`);

export const cleanupOldInstalledAppChanges = db.prepare(`
  DELETE FROM installed_app_changes WHERE created_at < datetime('now', '-${RETENTION_DAYS} days')
`);

export const deleteDeviceInstalledAppChanges = db.prepare(`
  DELETE FROM installed_app_changes WHERE device_id = ?
`);

/**
 * Records the packages added and removed since the device's previous stored snapshot. The first
 * snapshot a device ever reports, and reports that omit the list, record nothing.
 */
export function recordInstalledAppChanges(
  deviceId: string,
  previousDeviceExtra: Record<string, unknown> | null,
  currentApps: Array<Record<string, string>>,
  detectedAt: string,
): number {
  if (!previousDeviceExtra || currentApps.length === 0) return 0;
  const previousApps = snapshotApps(previousDeviceExtra.installed_apps);
  if (previousApps.length === 0) return 0;
  const current = snapshotApps(currentApps);
  if (previousApps.length >= SNAPSHOT_CAP || current.length >= SNAPSHOT_CAP) return 0;
  const previousSnapshotAt = typeof previousDeviceExtra.installed_apps_updated_at === "string"
    ? previousDeviceExtra.installed_apps_updated_at
    : "";
  const changes = diffInstalledApps(previousApps, current).slice(0, MAX_CHANGES_PER_SNAPSHOT);
  if (changes.length === 0) return 0;
  db.transaction(() => {
    for (const change of changes) {
      insertChangeStmt.run(deviceId, change.package_name, change.app_name, change.change, detectedAt, previousSnapshotAt);
    }
  })();
  return changes.length;
}

export function diffInstalledApps(
  previous: SnapshotApp[],
  current: SnapshotApp[],
): Array<SnapshotApp & { change: InstalledAppChangeKind }> {
  const before = new Map(previous.map((app) => [app.package_name, app]));
  const after = new Map(current.map((app) => [app.package_name, app]));
  const removed = previous
    .filter((app) => !after.has(app.package_name))
    .map((app) => ({ ...app, change: "removed" as const }));
  const installed = current
    .filter((app) => !before.has(app.package_name))
    .map((app) => ({ ...app, change: "installed" as const }));
  return [...removed, ...installed];
}

/** Bounded newest-first changes of every device for the controller context. */
export function installedAppChangesContext(now = new Date()): {
  schema: typeof INSTALLED_CHANGES_SCHEMA;
  window_days: number;
  total_count: number;
  returned_count: number;
  has_more: boolean;
  changes: InstalledAppChange[];
} {
  const since = new Date(now.getTime() - INSTALLED_CHANGES_CONTEXT_DAYS * 24 * 60 * 60_000).toISOString();
  const total = (countChangesSinceStmt.get(since) as { count: number } | null)?.count ?? 0;
  const changes = listChangesSinceStmt.all(since, INSTALLED_CHANGES_CONTEXT_LIMIT) as InstalledAppChange[];
  return {
    schema: INSTALLED_CHANGES_SCHEMA,
    window_days: INSTALLED_CHANGES_CONTEXT_DAYS,
    total_count: total,
    returned_count: changes.length,
    has_more: total > changes.length,
    changes,
  };
}

/** One device's retained changes, newest first, for get_device_installed_apps. */
export function deviceInstalledAppChanges(deviceId: string, now = new Date()): {
  retention_days: number;
  total_count: number;
  has_more: boolean;
  changes: InstalledAppChange[];
} {
  const since = new Date(now.getTime() - RETENTION_DAYS * 24 * 60 * 60_000).toISOString();
  const total = (countDeviceChangesSinceStmt.get(deviceId, since) as { count: number } | null)?.count ?? 0;
  const changes = listDeviceChangesSinceStmt.all(deviceId, since, INSTALLED_CHANGES_DEVICE_LIMIT) as InstalledAppChange[];
  return {
    retention_days: RETENTION_DAYS,
    total_count: total,
    has_more: total > changes.length,
    changes,
  };
}

function snapshotApps(value: unknown): SnapshotApp[] {
  if (!Array.isArray(value)) return [];
  const out: SnapshotApp[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const body = item as Record<string, unknown>;
    const packageName = typeof body.package_name === "string" ? body.package_name.trim() : "";
    if (!packageName || seen.has(packageName)) continue;
    seen.add(packageName);
    out.push({
      package_name: packageName,
      app_name: typeof body.app_name === "string" ? body.app_name.trim() : "",
    });
  }
  return out;
}

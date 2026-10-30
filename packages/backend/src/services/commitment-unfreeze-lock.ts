import { getDeviceInstalledApps } from "./device-context";
import { lockedPackages } from "./commitments";

// A controller's unfreeze must not reach a committed package. Android LSP matches unfreeze
// patterns against package names and app labels, so a pattern is dropped when it could match
// either for any locked package; "全部" and other catch-alls are dropped while anything is locked.

const CATCH_ALL = new Set(["*", ".*", "全部", "all"]);

export function commitmentUnfreezeFilter(
  deviceId: string,
  patterns: string[],
  now = new Date(),
): { allowed: string[]; locked: boolean } {
  if (patterns.length === 0) return { allowed: patterns, locked: false };
  const locked = lockedPackages(deviceId, now);
  if (locked.size === 0) return { allowed: patterns, locked: false };
  const labels = new Map(getDeviceInstalledApps(deviceId).installed_apps.map((app) => [app.package_name, app.app_name]));
  const allowed = patterns.filter((pattern) => !touchesLocked(pattern, locked, labels));
  return { allowed, locked: allowed.length < patterns.length };
}

function touchesLocked(pattern: string, locked: Set<string>, labels: Map<string, string>): boolean {
  if (CATCH_ALL.has(pattern.replace(/\s+/g, "").toLowerCase())) return true;
  let matcher: RegExp;
  try {
    matcher = new RegExp(pattern, "i");
  } catch {
    return true;
  }
  for (const name of locked) {
    const label = labels.get(name);
    if (matcher.test(name) || (label && matcher.test(label))) return true;
  }
  return false;
}

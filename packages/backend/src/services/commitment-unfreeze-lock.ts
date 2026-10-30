import { getDeviceInstalledApps } from "./device-context";
import { exactPackagePattern, isCatchAll } from "./device-command-packages";
import { knownFrozenPackages } from "./device-frozen-knowledge";
import { lockedPackages } from "./commitments";

// A controller's unfreeze must not reach a committed package. The phone runs each pattern as a
// case-insensitive Java regex against package name, app name and freeze reason; Java reads many
// constructs differently from JavaScript (\x{..}, \b, \w, octal, nested classes), and a locked
// app's freeze reason may be unknown to Live. So while anything is locked, no controller pattern
// reaches the phone as written: each becomes the exact names of the known frozen packages it
// matches here, minus the locked ones. Java-vs-JavaScript differences can then only change which
// unlocked apps open, never open a locked one.

const MAX_PATTERNS = 12;

export interface UnfreezeFilterResult {
  allowed: string[];
  /** A pattern could have reached a committed package. */
  locked: boolean;
  /** Patterns that matched no known frozen app, so nothing was sent for them. */
  unresolved: boolean;
  truncated: boolean;
}

export function commitmentUnfreezeFilter(deviceId: string, patterns: string[], now = new Date()): UnfreezeFilterResult {
  const passthrough = { allowed: patterns, locked: false, unresolved: false, truncated: false };
  if (patterns.length === 0) return passthrough;
  const locked = lockedPackages(deviceId, now);
  if (locked.size === 0) return passthrough;

  const known = knownFrozenPackages(deviceId, now);
  const labels = new Map(getDeviceInstalledApps(deviceId).installed_apps.map((app) => [app.package_name, app.app_name]));
  const textsOf = (name: string) => [name, ...(known.get(name)?.texts ?? []), labels.get(name) ?? ""].filter(Boolean);
  const openable = [...known.keys()].filter((name) => !locked.has(name));

  const allowed: string[] = [];
  let touchedLock = false;
  let unresolved = false;
  for (const pattern of patterns) {
    const matcher = isCatchAll(pattern) ? null : compile(pattern);
    const matches = (name: string) => matcher !== null && textsOf(name).some((text) => matcher.test(text));
    if (isCatchAll(pattern) || matcher === null || [...locked].some(matches)) touchedLock = true;
    const targets = isCatchAll(pattern) ? openable : openable.filter(matches);
    if (targets.length === 0) unresolved = true;
    for (const name of targets) allowed.push(exactPackagePattern(name));
  }
  const unique = [...new Set(allowed)];
  return { allowed: unique.slice(0, MAX_PATTERNS), locked: touchedLock, unresolved, truncated: unique.length > MAX_PATTERNS };
}

function compile(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern, "i");
  } catch {
    return null;
  }
}

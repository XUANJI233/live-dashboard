import { getDeviceInstalledApps } from "./device-context";
import { exactPackagePattern, isCatchAll } from "./device-command-packages";
import { knownFrozenPackages } from "./device-frozen-knowledge";
import { lockedPackages } from "./commitments";

// A controller's unfreeze must not reach a committed package. The phone runs each pattern as a
// case-insensitive Java regex against the package name, app name and freeze reason, and treats
// 全部/全量/所有/all/*/.* as "everything". A pattern that could reach a locked package (or uses
// syntax JavaScript may read differently from Java) is therefore replaced by the exact names of
// the known frozen packages it matches, minus the locked ones; other patterns pass unchanged.

const MAX_PATTERNS = 12;
// Constructs whose Java meaning JavaScript does not share; translate those instead of trusting them.
const JAVA_ONLY = /\\[pPQEhHRXzZAG]|&&|[*+?}]\+|\(\?/;

export interface UnfreezeFilterResult {
  allowed: string[];
  locked: boolean;
  truncated: boolean;
}

export function commitmentUnfreezeFilter(deviceId: string, patterns: string[], now = new Date()): UnfreezeFilterResult {
  if (patterns.length === 0) return { allowed: patterns, locked: false, truncated: false };
  const locked = lockedPackages(deviceId, now);
  if (locked.size === 0) return { allowed: patterns, locked: false, truncated: false };

  const known = knownFrozenPackages(deviceId, now);
  const labels = new Map(getDeviceInstalledApps(deviceId).installed_apps.map((app) => [app.package_name, app.app_name]));
  const textsOf = (name: string) => [name, ...(known.get(name)?.texts ?? []), labels.get(name) ?? ""].filter(Boolean);
  const lockedTexts = [...locked].flatMap(textsOf);
  const openable = [...known.keys()].filter((name) => !locked.has(name));

  const allowed: string[] = [];
  let touched = false;
  for (const pattern of patterns) {
    const matcher = isCatchAll(pattern) || JAVA_ONLY.test(pattern) ? null : compile(pattern);
    if (matcher && !lockedTexts.some((text) => matcher.test(text))) {
      allowed.push(pattern);
      continue;
    }
    touched = true;
    const targets = isCatchAll(pattern) ? openable : matcher ? openable.filter((name) => textsOf(name).some((text) => matcher.test(text))) : [];
    for (const name of targets) allowed.push(exactPackagePattern(name));
  }
  const unique = [...new Set(allowed)];
  return { allowed: unique.slice(0, MAX_PATTERNS), locked: touched, truncated: unique.length > MAX_PATTERNS };
}

function compile(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern, "i");
  } catch {
    return null;
  }
}

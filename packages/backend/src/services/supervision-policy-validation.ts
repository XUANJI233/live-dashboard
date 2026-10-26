import { normalizeSupervisionPatternList } from "./supervision-patterns";

/**
 * Patterns the server would silently drop at compile time (catastrophic backtracking, catch-alls,
 * invalid syntax). Rejecting them keeps devices from enforcing a rule Live itself ignores.
 */
export function unsafePolicyPatterns(input: {
  risk_app_regex?: unknown;
  whitelist_app_regex?: unknown;
  blacklist_app_regex?: unknown;
  target_app_regex?: unknown;
  app_time_limits?: unknown;
}): string[] {
  const patterns: unknown[] = [
    ...arrayValue(input.risk_app_regex),
    ...arrayValue(input.whitelist_app_regex),
    ...arrayValue(input.blacklist_app_regex),
    ...arrayValue(input.target_app_regex),
    ...arrayValue(input.app_time_limits).map((limit) => (
      limit && typeof limit === "object" ? (limit as { app_regex?: unknown }).app_regex : undefined
    )),
  ];
  return patterns
    .filter((pattern): pattern is string => typeof pattern === "string" && pattern.trim().length > 0)
    .filter((pattern) => normalizeSupervisionPatternList([pattern]).length === 0);
}

/** Optimistic concurrency: the snapshot the controller edited must still be the current one. */
export function policyVersionMatches(expected: unknown, current: string | null): boolean {
  if (expected === undefined) return true;
  if (typeof expected !== "string" || !current) return false;
  const expectedMs = Date.parse(expected);
  return Number.isFinite(expectedMs) && expectedMs === Date.parse(current);
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

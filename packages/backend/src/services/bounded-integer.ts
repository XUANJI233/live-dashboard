export function boundedInteger(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

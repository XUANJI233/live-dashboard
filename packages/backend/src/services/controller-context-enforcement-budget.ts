// Budget steps for the daily/weekly `enforcement` section (controller-context-enforcement.ts).
// Its totals always stay; only the listed commands are dropped.

/** Drop the oldest listed command, rule enforcement first. */
export function trimOldestEnforcementCommand(section: unknown, minimum: number): boolean {
  if (!isRecord(section) || !Array.isArray(section.commands) || section.commands.length <= minimum) return false;
  const ruleIndex = section.commands.findIndex((item) => isRecord(item) && item.source === "rule_enforcement");
  section.commands.splice(Math.max(0, ruleIndex), 1);
  section.returned_count = section.commands.length;
  section.truncated = true;
  return true;
}

export function enforcementTotalsOnly(section: unknown): Record<string, unknown> {
  const source = isRecord(section) ? section : {};
  return {
    range: source.range,
    totals: isRecord(source.totals) ? source.totals : {},
    command_count: typeof source.command_count === "number" ? source.command_count : 0,
    returned_count: 0,
    truncated: true,
    commands: [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

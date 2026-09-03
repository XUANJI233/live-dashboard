export type SupervisionRunSource = "scheduled" | "report";

export interface SupervisionTriggerSettings {
  supervision_check_interval_minutes: number;
  supervision_blacklist_minutes: number;
  supervision_risk_trigger_minutes: number;
  supervision_target_min_minutes: number;
  supervision_heuristic_triggers: boolean;
}

export interface SupervisionTriggerStats {
  blacklistMinutes: number;
  riskMinutes: number;
  targetMinutes: number;
  whitelistMinutes?: number;
  totalMinutes: number;
}

export interface SupervisionTriggerDecision {
  blacklistTriggered: boolean;
  riskTriggered: boolean;
  targetTriggered: boolean;
  heuristicTriggered: boolean;
  heuristicReasons: string[];
}

export function supervisionWindowMinutes(settings: SupervisionTriggerSettings, source: SupervisionRunSource): number {
  return source === "scheduled"
    ? settings.supervision_check_interval_minutes
    : 60;
}

export function scheduledSupervisionIntervalMinutes(intervalMinutes: number, everyPhoneScreenOff: boolean): number {
  const bounded = Math.min(240, Math.max(5, Math.trunc(intervalMinutes)));
  return everyPhoneScreenOff ? Math.min(240, bounded * 4) : bounded;
}

export function supervisionTriggerDecision(
  settings: SupervisionTriggerSettings,
  stats: SupervisionTriggerStats,
  options: { targetRuleCount: number; windowMinutes: number },
): SupervisionTriggerDecision {
  const blacklistTriggered = settings.supervision_blacklist_minutes > 0 &&
    stats.blacklistMinutes >= settings.supervision_blacklist_minutes;
  const riskTriggered = settings.supervision_risk_trigger_minutes > 0 &&
    stats.riskMinutes >= settings.supervision_risk_trigger_minutes;
  const targetTriggered = options.targetRuleCount > 0 &&
    stats.targetMinutes < settings.supervision_target_min_minutes &&
    stats.totalMinutes >= Math.min(50, options.windowMinutes);
  const hardTriggered = blacklistTriggered || riskTriggered || targetTriggered;
  const heuristicReasons = hardTriggered ? [] : heuristicTriggerReasons(settings, stats, options);
  return {
    blacklistTriggered,
    riskTriggered,
    targetTriggered,
    heuristicTriggered: heuristicReasons.length > 0,
    heuristicReasons,
  };
}

export function shouldRunSupervisionAi(source: SupervisionRunSource, decision: SupervisionTriggerDecision): boolean {
  if (source !== "scheduled") return true;
  return decision.blacklistTriggered || decision.riskTriggered || decision.targetTriggered || decision.heuristicTriggered;
}

function heuristicTriggerReasons(
  settings: SupervisionTriggerSettings,
  stats: SupervisionTriggerStats,
  options: { targetRuleCount: number; windowMinutes: number },
): string[] {
  const reasons: string[] = [];
  if (!settings.supervision_heuristic_triggers) return reasons;
  const activeMinutes = Math.max(0, stats.totalMinutes - (stats.whitelistMinutes ?? 0));
  if (activeMinutes <= 0) return reasons;

  const earlyBlacklistMinutes = Math.min(3, settings.supervision_blacklist_minutes);
  if (
    settings.supervision_blacklist_minutes > 0 &&
    stats.blacklistMinutes >= earlyBlacklistMinutes &&
    stats.targetMinutes === 0 &&
    stats.blacklistMinutes * 2 >= activeMinutes
  ) {
    reasons.push("early_blacklist_without_target");
  }

  const earlyRiskMinutes = Math.min(2, settings.supervision_risk_trigger_minutes);
  if (
    settings.supervision_risk_trigger_minutes > 0 &&
    stats.riskMinutes >= earlyRiskMinutes &&
    (stats.targetMinutes === 0 || stats.riskMinutes * 2 >= activeMinutes)
  ) {
    reasons.push("early_risk_dominant");
  }

  const driftWindow = Math.min(20, options.windowMinutes);
  const offTargetMinutes = stats.blacklistMinutes + stats.riskMinutes;
  if (
    options.targetRuleCount > 0 &&
    stats.totalMinutes >= driftWindow &&
    offTargetMinutes >= 2 &&
    stats.targetMinutes * 5 < stats.totalMinutes
  ) {
    reasons.push("low_target_with_risk_or_blacklist");
  }

  return reasons;
}

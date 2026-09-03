import { describe, expect, test } from "bun:test";
import {
  scheduledSupervisionIntervalMinutes,
  shouldRunSupervisionAi,
  supervisionTriggerDecision,
  supervisionWindowMinutes,
} from "../src/services/supervision-trigger-plan";

describe("supervision trigger plan", () => {
  const settings = {
    supervision_check_interval_minutes: 45,
    supervision_blacklist_minutes: 20,
    supervision_risk_trigger_minutes: 3,
    supervision_target_min_minutes: 25,
    supervision_heuristic_triggers: false,
  };

  test("filters a scheduled check when the rule scorer found no review candidate", () => {
    const quietStats = {
      blacklistMinutes: 0,
      riskMinutes: 0,
      targetMinutes: 30,
      totalMinutes: 45,
    };
    const decision = supervisionTriggerDecision(settings, quietStats, {
      targetRuleCount: 1,
      windowMinutes: supervisionWindowMinutes(settings, "scheduled"),
    });

    expect(supervisionWindowMinutes(settings, "scheduled")).toBe(45);
    expect(shouldRunSupervisionAi("scheduled", decision)).toBe(false);
    expect(shouldRunSupervisionAi("report", decision)).toBe(true);
    expect(decision.heuristicTriggered).toBe(false);
  });

  test("lets condition triggers run between scheduled checks when thresholds are met", () => {
    const riskStats = {
      blacklistMinutes: 0,
      riskMinutes: 4,
      targetMinutes: 10,
      totalMinutes: 10,
    };
    const decision = supervisionTriggerDecision(settings, riskStats, {
      targetRuleCount: 0,
      windowMinutes: supervisionWindowMinutes(settings, "report"),
    });

    expect(supervisionWindowMinutes(settings, "report")).toBe(60);
    expect(decision.riskTriggered).toBe(true);
    expect(shouldRunSupervisionAi("report", decision)).toBe(true);
  });

  test("keeps every deterministic review candidate eligible on scheduled checks", () => {
    const baseDecision = {
      blacklistTriggered: false,
      riskTriggered: false,
      targetTriggered: false,
      heuristicTriggered: false,
      heuristicReasons: [],
    };

    for (const trigger of [
      "blacklistTriggered",
      "riskTriggered",
      "targetTriggered",
      "heuristicTriggered",
    ] as const) {
      expect(shouldRunSupervisionAi("scheduled", {
        ...baseDecision,
        [trigger]: true,
      })).toBe(true);
    }
  });

  test("does not turn disabled zero thresholds into permanent scheduled candidates", () => {
    const decision = supervisionTriggerDecision({
      ...settings,
      supervision_blacklist_minutes: 0,
      supervision_risk_trigger_minutes: 0,
      supervision_heuristic_triggers: true,
    }, {
      blacklistMinutes: 0,
      riskMinutes: 0,
      targetMinutes: 0,
      totalMinutes: 45,
    }, {
      targetRuleCount: 0,
      windowMinutes: 45,
    });

    expect(decision.blacklistTriggered).toBe(false);
    expect(decision.riskTriggered).toBe(false);
    expect(decision.targetTriggered).toBe(false);
    expect(decision.heuristicTriggered).toBe(false);
    expect(shouldRunSupervisionAi("scheduled", decision)).toBe(false);
  });

  test("uses heuristics to catch early dominant risk before the hard threshold", () => {
    const earlyRiskStats = {
      blacklistMinutes: 0,
      riskMinutes: 2,
      targetMinutes: 0,
      whitelistMinutes: 0,
      totalMinutes: 3,
    };
    const decision = supervisionTriggerDecision({
      ...settings,
      supervision_heuristic_triggers: true,
    }, earlyRiskStats, {
      targetRuleCount: 1,
      windowMinutes: supervisionWindowMinutes(settings, "report"),
    });

    expect(decision.riskTriggered).toBe(false);
    expect(decision.heuristicTriggered).toBe(true);
    expect(decision.heuristicReasons).toContain("early_risk_dominant");
    expect(shouldRunSupervisionAi("report", decision)).toBe(true);
  });

  test("backs scheduled reviews off while every phone screen is off", () => {
    expect(scheduledSupervisionIntervalMinutes(30, false)).toBe(30);
    expect(scheduledSupervisionIntervalMinutes(30, true)).toBe(120);
    expect(scheduledSupervisionIntervalMinutes(240, true)).toBe(240);
  });
});

import type { SummarySettings } from "./daily-summary-gen";
import { emptyWebAllowlistPolicy } from "./web-allowlist";

/**
 * Merge a Live AI rules refresh into the latest settings. Live AI always writes its rule lists;
 * the hard policy (review interval, risk trigger, risk regexes, app limits, web allowlist) is reset
 * to Live AI defaults only when Live AI already owns it. After a handback the previous
 * controller's hard limits stay in force until a controller replaces them or supervision is
 * switched off, instead of being wiped by an unrelated settings save.
 */
export function applyLiveAiRules(
  latest: SummarySettings,
  rules: SummarySettings["supervision_rules"],
  at: string,
): SummarySettings {
  const refreshed = {
    ...latest,
    supervision_rules_updated_at: at,
    supervision_rules_error: null,
  };
  const ownsHardPolicy = latest.supervision_policy_owner === null || latest.supervision_policy_owner === "live_ai";
  if (!ownsHardPolicy) {
    return {
      ...refreshed,
      supervision_rules: { ...rules, risk_app_regex: latest.supervision_rules.risk_app_regex },
    };
  }
  return {
    ...refreshed,
    supervision_policy_owner: "live_ai",
    supervision_policy_reason: rules.reason,
    supervision_policy_updated_at: at,
    supervision_check_interval_minutes: 60,
    supervision_risk_trigger_minutes: 3,
    supervision_app_time_limits: [],
    supervision_web_allowlist: emptyWebAllowlistPolicy(),
    supervision_rules: rules,
  };
}

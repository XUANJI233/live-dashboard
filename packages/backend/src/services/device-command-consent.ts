import { getSummarySettings, type SummarySettings } from "./daily-summary-gen";

/**
 * The user's supervision switches decide which device actions any controller may take.
 * Each field is "" when the action is allowed, otherwise the note reported back for it.
 * Unfreeze, say and screenshots are never gated: they cannot restrict the user.
 */
export interface DeviceActionConsent {
  freeze: string;
  vibrate: string;
  screenOff: string;
}

export const USER_CONSENT_NOTES = new Set([
  "supervision_disabled",
  "freeze_disabled_by_user",
  "vibrate_disabled_by_user",
]);

type ConsentSettings = Pick<SummarySettings, "supervision_enabled" | "supervision_lsp_freeze" | "supervision_vibrate">;

export function deviceActionConsent(settings: ConsentSettings = getSummarySettings()): DeviceActionConsent {
  if (!settings.supervision_enabled) {
    return {
      freeze: "supervision_disabled",
      vibrate: "supervision_disabled",
      screenOff: "supervision_disabled",
    };
  }
  return {
    freeze: settings.supervision_lsp_freeze ? "" : "freeze_disabled_by_user",
    vibrate: settings.supervision_vibrate ? "" : "vibrate_disabled_by_user",
    screenOff: "",
  };
}

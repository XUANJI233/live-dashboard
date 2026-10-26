// Device actions (freeze, vibrate, screen_off) follow the user's stored supervision switches.
// Tests that exercise those actions turn the switches on and restore the previous settings.
// Writes bypass the phone's last-write-wins clock so later tests' timestamps are unaffected.
export async function enableSupervisionActions(): Promise<() => void> {
  const { getSummarySettings, saveSummarySettings } = await import("../../src/services/daily-summary-gen");
  const previous = getSummarySettings();
  saveSummarySettings({
    ...previous,
    supervision_enabled: true,
    supervision_lsp_freeze: true,
    supervision_vibrate: true,
  });
  return () => {
    saveSummarySettings(previous);
  };
}

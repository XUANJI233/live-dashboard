import type { SummarySettings } from "./daily-summary-gen";
import { sendDeviceCommandsViaMcp, type McpSendDeviceCommandsResult } from "./ai-mcp";
import type { DeviceCommandRequest } from "./device-control";

const SUPERVISION_COMMAND_EXPIRES_SECONDS = 45 * 60;

export interface SupervisionCommandForDevice {
  device_id: string;
  deviated: boolean;
  message: string;
  reason: string;
  vibrate: boolean;
  freeze: boolean;
  freeze_commands: string[];
  screen_off: boolean;
  unfreeze: boolean;
  unfreeze_commands: string[];
}

export function sendSupervisionDeviceCommands(
  settings: Pick<SummarySettings, "supervision_lsp_freeze" | "supervision_vibrate">,
  decisions: SupervisionCommandForDevice[],
): Promise<McpSendDeviceCommandsResult> {
  return sendDeviceCommandsViaMcp({
    request_id: `req_supervision_${crypto.randomUUID()}`,
    created_by: "supervision",
    commands: decisions.map((decision) => supervisionDeviceCommand(settings, decision)),
  });
}

function supervisionDeviceCommand(
  settings: Pick<SummarySettings, "supervision_lsp_freeze" | "supervision_vibrate">,
  decision: SupervisionCommandForDevice,
): DeviceCommandRequest {
  return {
    device_id: decision.device_id,
    freeze_commands: settings.supervision_lsp_freeze && decision.freeze
      ? decision.freeze_commands
      : [],
    unfreeze_commands: decision.unfreeze ? decision.unfreeze_commands : [],
    vibrate: !decision.unfreeze && settings.supervision_vibrate && decision.vibrate,
    screen_off: false,
    say: supervisionCommandText(decision),
    expires_in_seconds: SUPERVISION_COMMAND_EXPIRES_SECONDS,
  };
}

function supervisionCommandText(decision: SupervisionCommandForDevice): string {
  return (decision.message || decision.reason || "").slice(0, 500);
}

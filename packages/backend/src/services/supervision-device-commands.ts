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
  const freezeCommands = settings.supervision_lsp_freeze && decision.freeze
    ? decision.freeze_commands
    : [];
  const unfreezeCommands = decision.unfreeze ? decision.unfreeze_commands : [];
  const vibrate = !decision.unfreeze && settings.supervision_vibrate && decision.vibrate;
  const screenOff = !decision.unfreeze && decision.screen_off;
  return {
    device_id: decision.device_id,
    freeze_commands: freezeCommands,
    unfreeze_commands: unfreezeCommands,
    vibrate,
    screen_off: screenOff,
    say: supervisionCommandText(decision, {
      freeze: freezeCommands.length > 0,
      unfreeze: unfreezeCommands.length > 0,
      vibrate,
      screenOff,
    }),
    expires_in_seconds: SUPERVISION_COMMAND_EXPIRES_SECONDS,
  };
}

function supervisionCommandText(
  decision: SupervisionCommandForDevice,
  actions: { freeze: boolean; unfreeze: boolean; vibrate: boolean; screenOff: boolean },
): string {
  const rawReason = (decision.reason || decision.message || "").trim();
  const reason = mentionsControlAction(rawReason) ? "" : rawReason;
  const actionText = supervisionActionText(actions);
  if (actionText) {
    return `${actionText}${reason ? ` 原因：${reason}` : ""}`.slice(0, 500);
  }
  const fallback = (decision.message || decision.reason || "").trim();
  return (mentionsControlAction(fallback) ? "检测到偏离，请回到目标。" : fallback).slice(0, 500);
}

function supervisionActionText(actions: { freeze: boolean; unfreeze: boolean; vibrate: boolean; screenOff: boolean }): string {
  if (actions.unfreeze) return "正在解除临时限制，请继续回到目标。";
  const parts: string[] = [];
  if (actions.freeze) parts.push("限制偏离应用");
  if (actions.screenOff) parts.push("息屏打断");
  if (actions.vibrate) parts.push("震动提醒");
  if (parts.length === 0) return "";
  return `检测到偏离，正在${parts.join("、")}，请回到目标。`;
}

function mentionsControlAction(value: string): boolean {
  return /冻结|解冻|解除限制|临时限制|限制应用|拦截|息屏|锁屏|震动/.test(value);
}

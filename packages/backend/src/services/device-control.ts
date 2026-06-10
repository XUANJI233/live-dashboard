import {
  deviceSupportsCommand,
  getDeviceContext,
  type DeviceContext,
} from "./device-context";
import {
  getCommandStatuses,
  insertDeviceCommand,
  recordCommandDelivery,
  recordServerCommandResult,
} from "./device-command-ledger";
import {
  cleanIdentifier,
  cleanLooseIdentifier,
  cleanText,
  generatedCommandId,
  generatedRequestId,
  type DeviceCommandCreatedBy,
  type DeviceCommandEnvelope,
  type DeviceCommandPayload,
  type DeliveryStatus,
} from "./mcp-contracts";
import { deliverDeviceCommandMessage } from "./realtime";

const MAX_COMMANDS_PER_REQUEST = 20;
const MAX_PATTERN_COUNT = 12;
const MAX_PATTERN_LENGTH = 120;
const DEFAULT_EXPIRES_SECONDS = 3 * 60;
const MIN_EXPIRES_SECONDS = 10;
const MAX_EXPIRES_SECONDS = 60 * 60;

export interface DeviceCommandRequest {
  device_id: string;
  freeze_commands?: string[];
  unfreeze_commands?: string[];
  vibrate?: boolean;
  screen_off?: boolean;
  say?: string;
  expires_in_seconds?: number;
}

export interface SendDeviceCommandsInput {
  request_id?: string;
  created_by?: DeviceCommandCreatedBy;
  commands: DeviceCommandRequest[];
}

export function sendDeviceCommands(input: SendDeviceCommandsInput): {
  request_id: string;
  commands: ReturnType<typeof getCommandStatuses>["commands"];
} {
  const requestId = cleanIdentifier(input.request_id) || generatedRequestId();
  const createdBy = input.created_by === "supervision" ? "supervision" : "mcp";
  const commands = input.commands.slice(0, MAX_COMMANDS_PER_REQUEST);
  const commandIds: string[] = [];

  for (const command of commands) {
    const commandId = generatedCommandId();
    commandIds.push(commandId);
    const targetDeviceId = cleanLooseIdentifier(command.device_id, 160);
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + expiresSeconds(command.expires_in_seconds) * 1000);
    const device = targetDeviceId ? getDeviceContext(targetDeviceId) : null;
    const normalized = normalizeCommandPayload(command, device);
    const envelope: DeviceCommandEnvelope = {
      type: "device_command",
      v: 1,
      request_id: requestId,
      command_id: commandId,
      created_by: createdBy,
      target_device_id: targetDeviceId,
      issued_at: issuedAt.toISOString(),
      expires_at: expiresAt.toISOString(),
      payload: normalized.payload,
    };

    insertDeviceCommand(envelope);

    if (!targetDeviceId) {
      markSkipped(commandId, "invalid_device_id", "unsupported");
      continue;
    }
    if (!device) {
      markSkipped(commandId, "device_not_found", "unsupported");
      continue;
    }
    if (!normalized.hasAction) {
      markSkipped(commandId, normalized.resultReason, normalized.resultStatus);
      continue;
    }

    const delivery = deliverDeviceCommandMessage({
      deviceId: targetDeviceId,
      commandId,
      requestId,
      text: normalized.payload.say || "设备命令",
      envelope,
    });
    recordCommandDelivery({
      commandId,
      status: delivery.status,
      reason: delivery.reason,
    });
  }

  return {
    request_id: requestId,
    commands: commandIds.flatMap((commandId) => getCommandStatuses({ commandId }).commands),
  };
}

function normalizeCommandPayload(command: DeviceCommandRequest, device: DeviceContext | null): {
  payload: DeviceCommandPayload;
  hasAction: boolean;
  resultStatus: "ignored" | "unsupported";
  resultReason: string;
} {
  const notes: string[] = [];
  const requestedFreeze = normalizePatternList(command.freeze_commands, { allowAll: false });
  const requestedUnfreeze = normalizePatternList(command.unfreeze_commands, { allowAll: true });
  const requestedVibrate = command.vibrate === true;
  const requestedSay = cleanText(command.say, 500);
  const requestedScreenOff = command.screen_off === true;

  if (requestedScreenOff) notes.push("screen_off_not_supported");

  const freezeCommands = device && deviceSupportsCommand(device, "freeze") ? requestedFreeze : [];
  const unfreezeCommands = device && deviceSupportsCommand(device, "unfreeze") ? requestedUnfreeze : [];
  const vibrate = !!device && deviceSupportsCommand(device, "vibrate") && requestedVibrate;
  const say = device && deviceSupportsCommand(device, "say") ? requestedSay : "";

  if (requestedFreeze.length > 0 && freezeCommands.length === 0) notes.push("freeze_not_supported");
  if (requestedUnfreeze.length > 0 && unfreezeCommands.length === 0) notes.push("unfreeze_not_supported");
  if (requestedVibrate && !vibrate) notes.push("vibrate_not_supported");
  if (requestedSay && !say) notes.push("say_not_supported");

  const hasAction = freezeCommands.length > 0 ||
    unfreezeCommands.length > 0 ||
    vibrate ||
    !!say;
  const requestedAny = requestedFreeze.length > 0 ||
    requestedUnfreeze.length > 0 ||
    requestedVibrate ||
    requestedScreenOff ||
    !!requestedSay;
  return {
    payload: {
      kind: "supervision",
      freeze_commands: freezeCommands,
      unfreeze_commands: unfreezeCommands,
      vibrate,
      screen_off: false,
      say,
      notes,
    },
    hasAction,
    resultStatus: requestedAny ? "unsupported" : "ignored",
    resultReason: requestedAny ? notes.join(",") || "unsupported_device_capability" : "empty_command",
  };
}

function markSkipped(commandId: string, reason: string, resultStatus: "ignored" | "unsupported"): void {
  recordCommandDelivery({ commandId, status: "skipped" satisfies DeliveryStatus, reason });
  recordServerCommandResult({ commandId, status: resultStatus, reason });
}

function normalizePatternList(value: unknown, options: { allowAll: boolean }): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const pattern = normalizePattern(cleanText(item, MAX_PATTERN_LENGTH));
    if (!pattern || !isSafePattern(pattern, options.allowAll)) continue;
    if (!out.includes(pattern)) out.push(pattern);
    if (out.length >= MAX_PATTERN_COUNT) break;
  }
  return out;
}

function normalizePattern(pattern: string): string {
  const withoutInlineFlag = pattern.replace(/^\(\?i\)/i, "").trim();
  const scopedInlineFlag = withoutInlineFlag.match(/^\(\?i:(.*)\)$/i);
  return scopedInlineFlag ? `(?:${scopedInlineFlag[1]})` : withoutInlineFlag;
}

function isSafePattern(pattern: string, allowAll: boolean): boolean {
  if (!pattern || pattern.length > MAX_PATTERN_LENGTH) return false;
  const compact = pattern.replace(/\s+/g, "").toLowerCase();
  if (!allowAll && (compact === "*" || compact === ".*" || compact === "全部" || compact === "all")) return false;
  if (/\\[1-9]/.test(pattern)) return false;
  if (/\(\?<?[=!]/.test(pattern)) return false;
  if (/\([^)]*[+*][^)]*\)[+*?]/.test(pattern)) return false;
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

function expiresSeconds(value: unknown): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return DEFAULT_EXPIRES_SECONDS;
  return Math.min(MAX_EXPIRES_SECONDS, Math.max(MIN_EXPIRES_SECONDS, parsed));
}

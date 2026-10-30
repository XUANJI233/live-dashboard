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
import { boundedInteger } from "./bounded-integer";
import { deliverDeviceCommandMessage } from "./realtime-message-delivery";
import { deviceActionConsent, USER_CONSENT_NOTES, type DeviceActionConsent } from "./device-command-consent";
import { deviceCommandRequestFingerprint, inspectDeviceCommandRequest } from "./device-command-replay";
import { commitmentUnfreezeFilter } from "./commitment-unfreeze-lock";

const MAX_COMMANDS_PER_REQUEST = 20;
const MAX_PATTERN_COUNT = 12;
const MAX_PATTERN_LENGTH = 120;
const DEFAULT_EXPIRES_SECONDS = 3 * 60;
const MIN_EXPIRES_SECONDS = 10;
const MAX_EXPIRES_SECONDS = 60 * 60;

export interface DeviceCommandRequest {
  command_id?: string;
  device_id: string;
  freeze_commands?: string[];
  unfreeze_commands?: string[];
  vibrate?: boolean;
  screen_off?: boolean;
  say?: string;
  screenshot?: {
    screenshot_id: string;
    max_width: number;
    jpeg_quality: number;
  };
  expires_in_seconds?: number;
}

export interface SendDeviceCommandsInput {
  request_id?: string;
  created_by?: DeviceCommandCreatedBy;
  commands: DeviceCommandRequest[];
}

export interface SendDeviceCommandsOptions {
  /** Live's own commitment enforcement and granted exceptions; never set for controller calls. */
  bypassCommitments?: boolean;
}

export function sendDeviceCommands(input: SendDeviceCommandsInput, options: SendDeviceCommandsOptions = {}): {
  request_id: string;
  duplicate?: true;
  commands: ReturnType<typeof getCommandStatuses>["commands"];
} {
  const suppliedRequestId = cleanIdentifier(input.request_id);
  const requestId = suppliedRequestId || generatedRequestId();
  const createdBy = input.created_by === "supervision" ? "supervision" : "mcp";
  const commands = input.commands.slice(0, MAX_COMMANDS_PER_REQUEST);
  const fingerprint = deviceCommandRequestFingerprint(commands);
  if (suppliedRequestId) {
    const seen = inspectDeviceCommandRequest(requestId, fingerprint);
    if (seen === "conflict") throw new Error("request_id_conflict");
    if (seen === "retry") {
      return { request_id: requestId, duplicate: true, commands: getCommandStatuses({ requestId }).commands };
    }
  }
  const consent = deviceActionConsent();
  const commandIds: string[] = [];

  for (const command of commands) {
    const commandId = cleanIdentifier(command.command_id) || generatedCommandId();
    commandIds.push(commandId);
    const targetDeviceId = cleanLooseIdentifier(command.device_id, 160);
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + expiresSeconds(command.expires_in_seconds) * 1000);
    const device = targetDeviceId ? getDeviceContext(targetDeviceId) : null;
    const normalized = normalizeCommandPayload(command, device, consent, options.bypassCommitments === true);
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

    insertDeviceCommand(envelope, fingerprint);

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

function normalizeCommandPayload(
  command: DeviceCommandRequest,
  device: DeviceContext | null,
  consent: DeviceActionConsent,
  bypassCommitments: boolean,
): {
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
  const requestedScreenshot = screenshotRequest(command.screenshot);

  const supportedFreeze = device && deviceSupportsCommand(device, "freeze") ? requestedFreeze : [];
  const supportedUnfreeze = device && deviceSupportsCommand(device, "unfreeze") ? requestedUnfreeze : [];
  // Packages under an active commitment open only through a time-boxed exception.
  const unfreezeLock = device && !bypassCommitments
    ? commitmentUnfreezeFilter(device.device_id, supportedUnfreeze)
    : { allowed: supportedUnfreeze, locked: false };
  const unfreezeCommands = unfreezeLock.allowed;
  const supportedVibrate = !!device && deviceSupportsCommand(device, "vibrate") && requestedVibrate;
  const say = device && deviceSupportsCommand(device, "say") ? requestedSay : "";
  const supportedScreenOff = !!device && deviceSupportsCommand(device, "screen_off") && requestedScreenOff;
  const screenshot = device && deviceSupportsCommand(device, "screenshot") ? requestedScreenshot : null;
  // The user's switches apply to every controller, not only the Live AI path.
  const freezeCommands = consent.freeze ? [] : supportedFreeze;
  const vibrate = supportedVibrate && !consent.vibrate;
  const screenOff = supportedScreenOff && !consent.screenOff;

  if (requestedFreeze.length > 0 && supportedFreeze.length === 0) notes.push("freeze_not_supported");
  else if (supportedFreeze.length > 0 && consent.freeze) notes.push(consent.freeze);
  if (requestedUnfreeze.length > 0 && supportedUnfreeze.length === 0) notes.push("unfreeze_not_supported");
  if (unfreezeLock.locked) notes.push("commitment_locked");
  if (requestedVibrate && !supportedVibrate) notes.push("vibrate_not_supported");
  else if (supportedVibrate && consent.vibrate) notes.push(consent.vibrate);
  if (requestedSay && !say) notes.push("say_not_supported");
  if (requestedScreenOff && !supportedScreenOff) notes.push("screen_off_not_supported");
  else if (supportedScreenOff && consent.screenOff) notes.push(consent.screenOff);
  if (requestedScreenshot && !screenshot) notes.push("screenshot_not_supported");
  const uniqueNotes = [...new Set(notes)];
  // A commitment is his own rule, so a refused unfreeze reads like a refused switch.
  const onlyUserBlocked = uniqueNotes.length > 0 &&
    uniqueNotes.every((note) => USER_CONSENT_NOTES.has(note) || note === "commitment_locked");

  const hasAction = freezeCommands.length > 0 ||
    unfreezeCommands.length > 0 ||
    vibrate ||
    screenOff ||
    !!say ||
    !!screenshot;
  const requestedAny = requestedFreeze.length > 0 ||
    requestedUnfreeze.length > 0 ||
    requestedVibrate ||
    requestedScreenOff ||
    !!requestedSay ||
    !!requestedScreenshot;
  return {
    payload: {
      kind: screenshot ? "screenshot" : "supervision",
      freeze_commands: freezeCommands,
      unfreeze_commands: unfreezeCommands,
      vibrate,
      screen_off: screenOff,
      say,
      notes: uniqueNotes,
      ...(screenshot ? { screenshot } : {}),
    },
    hasAction,
    resultStatus: requestedAny && !onlyUserBlocked ? "unsupported" : "ignored",
    resultReason: requestedAny ? uniqueNotes.join(",") || "unsupported_device_capability" : "empty_command",
  };
}

function screenshotRequest(value: DeviceCommandRequest["screenshot"]): DeviceCommandPayload["screenshot"] | null {
  if (!value || typeof value !== "object") return null;
  const screenshotId = cleanIdentifier(value.screenshot_id);
  if (!screenshotId) return null;
  return {
    screenshot_id: screenshotId,
    max_width: boundedInteger(value.max_width, 320, 1080, 720),
    jpeg_quality: boundedInteger(value.jpeg_quality, 35, 85, 65),
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

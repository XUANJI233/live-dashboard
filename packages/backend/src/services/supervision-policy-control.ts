import { supervisionPolicySnapshot, updateSupervisionPolicy } from "./daily-summary-gen";
import { getDeviceContext, listDeviceContexts } from "./device-context";
import { getCommandStatuses, insertDeviceCommand, recordCommandDelivery, recordServerCommandResult } from "./device-command-ledger";
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

const DEFAULT_EXPIRES_SECONDS = 5 * 60;
const MIN_EXPIRES_SECONDS = 10;
const MAX_EXPIRES_SECONDS = 60 * 60;

export interface SupervisionPolicyInput {
  risk_app_regex?: string[];
  risk_trigger_minutes?: number;
  app_time_limits?: unknown;
  device_ids?: string[];
  expires_in_seconds?: number;
  request_id?: string;
  created_by?: DeviceCommandCreatedBy;
}

export function setAndSendSupervisionPolicy(input: SupervisionPolicyInput): {
  request_id: string;
  policy: ReturnType<typeof supervisionPolicySnapshot>;
  commands: ReturnType<typeof getCommandStatuses>["commands"];
} {
  const settings = updateSupervisionPolicy({
    risk_app_regex: input.risk_app_regex,
    risk_trigger_minutes: input.risk_trigger_minutes,
    app_time_limits: input.app_time_limits,
  });
  const policy = supervisionPolicySnapshot(settings);
  const requestId = cleanIdentifier(input.request_id) || generatedRequestId();
  const createdBy = input.created_by === "supervision" ? "supervision" : "mcp";
  const deviceIds = targetDeviceIds(input.device_ids);
  const commandIds: string[] = [];

  for (const deviceId of deviceIds) {
    const commandId = generatedCommandId();
    commandIds.push(commandId);
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + expiresSeconds(input.expires_in_seconds) * 1000);
    const envelope: DeviceCommandEnvelope = {
      type: "device_command",
      v: 1,
      request_id: requestId,
      command_id: commandId,
      created_by: createdBy,
      target_device_id: deviceId,
      issued_at: issuedAt.toISOString(),
      expires_at: expiresAt.toISOString(),
      payload: supervisionPolicyPayload(policy),
    };
    insertDeviceCommand(envelope);

    const device = getDeviceContext(deviceId);
    if (!device) {
      markSkipped(commandId, "device_not_found", "unsupported");
      continue;
    }
    if (device.capability.profile !== "android_lsp" || device.capability.capabilities.freeze !== true) {
      markSkipped(commandId, "policy_requires_android_lsp", "unsupported");
      continue;
    }

    const delivery = deliverDeviceCommandMessage({
      deviceId,
      commandId,
      requestId,
      text: "监督策略更新",
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
    policy,
    commands: commandIds.flatMap((commandId) => getCommandStatuses({ commandId }).commands),
  };
}

function targetDeviceIds(values: unknown): string[] {
  const requested = Array.isArray(values)
    ? values.map((value) => cleanLooseIdentifier(value, 160)).filter(Boolean)
    : [];
  const source = requested.length > 0
    ? requested
    : listDeviceContexts()
      .filter((device) => device.capability.profile === "android_lsp")
      .map((device) => device.device_id);
  const out: string[] = [];
  for (const item of source) {
    if (!out.includes(item)) out.push(item);
    if (out.length >= 20) break;
  }
  return out;
}

function supervisionPolicyPayload(policy: ReturnType<typeof supervisionPolicySnapshot>): DeviceCommandPayload {
  return {
    kind: "supervision_policy",
    freeze_commands: [],
    unfreeze_commands: [],
    vibrate: false,
    screen_off: false,
    say: "",
    notes: [],
    risk_app_regex: policy.risk_app_regex,
    risk_trigger_minutes: policy.risk_trigger_minutes,
    app_time_limits: policy.app_time_limits.map((item) => ({
      app_regex: item.app_regex,
      limit_minutes: item.limit_minutes,
      reason: cleanText(item.reason, 120),
    })),
  };
}

function markSkipped(commandId: string, reason: string, resultStatus: "ignored" | "unsupported"): void {
  recordCommandDelivery({ commandId, status: "skipped" satisfies DeliveryStatus, reason });
  recordServerCommandResult({ commandId, status: resultStatus, reason });
}

function expiresSeconds(value: unknown): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return DEFAULT_EXPIRES_SECONDS;
  return Math.min(MAX_EXPIRES_SECONDS, Math.max(MIN_EXPIRES_SECONDS, parsed));
}

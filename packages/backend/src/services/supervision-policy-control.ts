import { metaGet, metaSet } from "../db";
import {
  effectiveSupervisionPolicySnapshot,
  supervisionPolicySnapshot,
  updateSupervisionPolicy,
  type SummarySettings,
} from "./daily-summary-gen";
import { getDeviceContext, listDeviceContexts, type DeviceContext } from "./device-context";
import { getCommandStatuses, insertDeviceCommand, recordCommandDelivery, recordServerCommandResult } from "./device-command-ledger";
import {
  cleanIdentifier,
  cleanLooseIdentifier,
  cleanText,
  generatedCommandId,
  generatedRequestId,
  safeJsonParseObject,
  type DeviceCommandCreatedBy,
  type DeviceCommandEnvelope,
  type DeviceCommandPayload,
  type DeliveryStatus,
} from "./mcp-contracts";
import { deliverDeviceCommandMessage } from "./realtime-message-delivery";

const DEFAULT_EXPIRES_SECONDS = 60 * 60;
const MIN_EXPIRES_SECONDS = 10;
const MAX_EXPIRES_SECONDS = 60 * 60;
const QUEUED_POLICY_RETRY_MS = 25 * 60_000;
const SENT_POLICY_RETRY_MS = 5 * 60_000;
const POLICY_SYNC_META_PREFIX = "supervision_policy_sync:";
const POLICY_SYNC_META_SCHEMA = "supervision_policy_sync.v1";

type SupervisionPolicySnapshot = ReturnType<typeof supervisionPolicySnapshot>;
type SupervisionPolicySendResult = {
  request_id: string;
  policy: SupervisionPolicySnapshot;
  commands: ReturnType<typeof getCommandStatuses>["commands"];
};
type SupervisionPolicySendInput = Pick<
  SupervisionPolicyInput,
  "device_ids" | "expires_in_seconds" | "request_id" | "created_by"
> & {
  skip_synced?: boolean;
};

export interface SupervisionPolicyInput {
  risk_app_regex?: string[];
  risk_trigger_minutes?: number;
  app_time_limits?: unknown;
  device_ids?: string[];
  expires_in_seconds?: number;
  request_id?: string;
  created_by?: DeviceCommandCreatedBy;
}

export function setAndSendSupervisionPolicy(input: SupervisionPolicyInput): SupervisionPolicySendResult {
  const settings = updateSupervisionPolicy({
    risk_app_regex: input.risk_app_regex,
    risk_trigger_minutes: input.risk_trigger_minutes,
    app_time_limits: input.app_time_limits,
  });
  return sendSupervisionPolicySnapshot(supervisionPolicySnapshot(settings), input);
}

export function syncCurrentSupervisionPolicyToCapableDevices(settings?: SummarySettings): SupervisionPolicySendResult {
  return sendSupervisionPolicySnapshot(effectiveSupervisionPolicySnapshot(settings), {
    created_by: "supervision",
    skip_synced: true,
  });
}

export function syncCurrentSupervisionPolicyForDevice(deviceId: string, settings?: SummarySettings): {
  synced: boolean;
  reason: string;
  request_id: string;
  policy: SupervisionPolicySnapshot;
  commands: ReturnType<typeof getCommandStatuses>["commands"];
} {
  const cleanDeviceId = cleanLooseIdentifier(deviceId, 160);
  const policy = effectiveSupervisionPolicySnapshot(settings);
  if (!cleanDeviceId) {
    return { synced: false, reason: "device_id_required", request_id: "", policy, commands: [] };
  }
  const device = getDeviceContext(cleanDeviceId);
  if (!device) {
    return { synced: false, reason: "device_not_found", request_id: "", policy, commands: [] };
  }
  if (!deviceSupportsPolicy(device, policy)) {
    return { synced: false, reason: "policy_capability_not_supported", request_id: "", policy, commands: [] };
  }
  const hash = policySyncHash(policy);
  if (isPolicySyncSatisfied(cleanDeviceId, hash)) {
    return { synced: false, reason: "policy_already_synced", request_id: "", policy, commands: [] };
  }
  const sent = sendSupervisionPolicySnapshot(policy, {
    device_ids: [cleanDeviceId],
    created_by: "supervision",
  });
  const synced = sent.commands.some((command) => command.delivery.status === "sent" || command.delivery.status === "queued");
  return {
    synced,
    reason: synced ? "policy_sync_sent" : "policy_sync_not_delivered",
    request_id: sent.request_id,
    policy: sent.policy,
    commands: sent.commands,
  };
}

function sendSupervisionPolicySnapshot(
  policy: SupervisionPolicySnapshot,
  input: SupervisionPolicySendInput,
): SupervisionPolicySendResult {
  const requestId = cleanIdentifier(input.request_id) || generatedRequestId();
  const createdBy = input.created_by === "supervision" ? "supervision" : "mcp";
  const commandIds: string[] = [];
  const syncHash = policySyncHash(policy);

  for (const deviceId of targetDeviceIds(input.device_ids)) {
    if (input.skip_synced && isPolicySyncSatisfied(deviceId, syncHash)) {
      continue;
    }
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
    if (!deviceSupportsPolicy(device, policy)) {
      markSkipped(commandId, "policy_capability_not_supported", "unsupported");
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
    if (delivery.status === "sent" || delivery.status === "queued") {
      metaSet(policySyncMetaKey(deviceId), policySyncMetaValue(syncHash, commandId));
    }
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
      .filter((device) => device.capability.capabilities.risk_app_monitor || device.capability.capabilities.app_time_limit)
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

function deviceSupportsPolicy(device: DeviceContext, policy: ReturnType<typeof supervisionPolicySnapshot>): boolean {
  const capabilities = device.capability.capabilities;
  if (device.capability.profile !== "android_lsp") return false;
  if (policy.risk_app_regex.length > 0 && capabilities.risk_app_monitor !== true) return false;
  if (policy.app_time_limits.length > 0 && capabilities.app_time_limit !== true) return false;
  return capabilities.risk_app_monitor === true || capabilities.app_time_limit === true;
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

function policySyncMetaKey(deviceId: string): string {
  return `${POLICY_SYNC_META_PREFIX}${deviceId}`;
}

function policySyncMetaValue(hash: string, commandId: string): string {
  return JSON.stringify({
    schema: POLICY_SYNC_META_SCHEMA,
    hash,
    command_id: commandId,
    recorded_at: new Date().toISOString(),
  });
}

function isPolicySyncSatisfied(deviceId: string, hash: string): boolean {
  const meta = readPolicySyncMeta(deviceId);
  if (!meta || meta.hash !== hash || !meta.commandId) return false;
  const command = getCommandStatuses({ commandId: meta.commandId }).commands[0];
  if (!command) return false;
  if (command.result.status === "applied" || command.result.status === "partial") return true;
  if (command.result.status !== "unknown") return false;
  if (command.receipt.status === "received") {
    return !isExpiredIso(command.expires_at);
  }
  const ageMs = Date.now() - meta.recordedAtMs;
  if (!Number.isFinite(ageMs) || ageMs < 0) return false;
  if (command.delivery.status === "queued") return ageMs < QUEUED_POLICY_RETRY_MS;
  if (command.delivery.status === "sent") return ageMs < SENT_POLICY_RETRY_MS;
  return false;
}

function readPolicySyncMeta(deviceId: string): { hash: string; commandId: string; recordedAtMs: number } | null {
  const raw = metaGet(policySyncMetaKey(deviceId));
  if (!raw) return null;
  const parsed = safeJsonParseObject(raw);
  const hash = cleanText(parsed.hash, 4096);
  const commandId = cleanIdentifier(parsed.command_id);
  const recordedAtMs = Date.parse(cleanText(parsed.recorded_at, 40));
  return {
    hash: hash || cleanText(raw, 4096),
    commandId,
    recordedAtMs,
  };
}

function policySyncHash(policy: SupervisionPolicySnapshot): string {
  return JSON.stringify({
    schema: "supervision_policy.v1",
    risk_app_regex: policy.risk_app_regex,
    risk_trigger_minutes: policy.risk_trigger_minutes,
    app_time_limits: policy.app_time_limits,
  });
}

function isExpiredIso(value: string): boolean {
  const ms = Date.parse(value);
  return Number.isFinite(ms) && ms < Date.now();
}

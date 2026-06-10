import type { DeviceInfo } from "../types";
import {
  recordCommandReceipt,
  recordCommandResult,
  type CommandWriteReceipt,
} from "./device-command-ledger";
import {
  cleanIdentifier,
  cleanText,
  normalizeReceiptStatus,
  normalizeResultStatus,
} from "./mcp-contracts";

export function deviceCommandReceiptWsResponse(message: unknown, device?: DeviceInfo): Record<string, unknown> {
  const receipt = receiveDeviceCommandReceipt(message, device);
  return {
    type: "device_command_receipt_received",
    command_id: receipt.command_id,
    request_id: receipt.request_id,
    received: receipt.received,
    ...(receipt.error ? { error: receipt.error } : {}),
  };
}

export function deviceCommandResultWsResponse(message: unknown, device?: DeviceInfo): Record<string, unknown> {
  const receipt = receiveDeviceCommandResult(message, device);
  return {
    type: "device_command_result_received",
    command_id: receipt.command_id,
    request_id: receipt.request_id,
    result_id: receipt.result_id,
    received: receipt.received,
    duplicate: receipt.duplicate === true,
    ...(receipt.error ? { error: receipt.error } : {}),
  };
}

export function receiveDeviceCommandReceipt(message: unknown, device?: DeviceInfo): CommandWriteReceipt {
  const body = extractAckObject(message);
  if (!body) return { received: false, command_id: "", error: "invalid_receipt" };
  const commandId = cleanIdentifier(body.command_id);
  if (!commandId) return { received: false, command_id: "", error: "command_id_required" };
  return recordCommandReceipt({
    commandId,
    requestId: cleanIdentifier(body.request_id),
    device,
    status: normalizeReceiptStatus(body.status),
    receivedAt: typeof body.received_at === "string" ? body.received_at : undefined,
  });
}

export function receiveDeviceCommandResult(message: unknown, device?: DeviceInfo): CommandWriteReceipt {
  const body = extractAckObject(message);
  if (!body) return { received: false, command_id: "", error: "invalid_result" };
  const commandId = cleanIdentifier(body.command_id);
  if (!commandId) return { received: false, command_id: "", error: "command_id_required" };
  const resultId = cleanIdentifier(body.result_id);
  if (!resultId) return { received: false, command_id: commandId, error: "result_id_required" };
  return recordCommandResult({
    commandId,
    requestId: cleanIdentifier(body.request_id),
    resultId,
    device,
    status: normalizeResultStatus(body.status),
    receivedAt: typeof body.executed_at === "string"
      ? body.executed_at
      : typeof body.received_at === "string"
        ? body.received_at
        : undefined,
    actions: Array.isArray(body.actions) ? body.actions : [],
    stateAfter: body.state_after && typeof body.state_after === "object" ? body.state_after : null,
    reason: cleanText(body.reason, 240),
  });
}

function extractAckObject(message: unknown): Record<string, unknown> | null {
  if (!message || typeof message !== "object" || Array.isArray(message)) return null;
  const body = message as Record<string, unknown>;
  const payload = body.payload;
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    return payload as Record<string, unknown>;
  }
  return body;
}

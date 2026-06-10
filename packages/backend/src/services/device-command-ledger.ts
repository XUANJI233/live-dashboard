import type { DeviceInfo } from "../types";
import { db } from "../db";
import {
  COMMAND_SCHEMA,
  cleanIdentifier,
  cleanLooseIdentifier,
  cleanText,
  generatedResultId,
  normalizeIsoTimestamp,
  safeJsonParseObject,
  safeJsonStringify,
  type DeliveryStatus,
  type DeviceCommandEnvelope,
  type ReceiptStatus,
  type ResultStatus,
} from "./mcp-contracts";

const MAX_STATUS_ROWS = 100;
const COMMAND_PAYLOAD_MAX_BYTES = 8 * 1024;
const COMMAND_RESULT_PAYLOAD_MAX_BYTES = 32 * 1024;

const insertCommandStmt = db.prepare(`
  INSERT INTO device_commands (
    command_id,
    request_id,
    target_device_id,
    message_id,
    kind,
    payload,
    issued_at,
    expires_at,
    created_by,
    updated_at
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
`);

const updateDeliveryStmt = db.prepare(`
  UPDATE device_commands
  SET delivery_status = ?,
      delivery_reason = ?,
      delivered_at = ?,
      updated_at = datetime('now')
  WHERE command_id = ?
`);

const updateReceiptStmt = db.prepare(`
  UPDATE device_commands
  SET receipt_status = ?,
      receipt_at = ?,
      updated_at = datetime('now')
  WHERE command_id = ?
`);

const updateResultStmt = db.prepare(`
  UPDATE device_commands
  SET result_status = ?,
      result_id = ?,
      result_at = ?,
      result_payload = ?,
      updated_at = datetime('now')
  WHERE command_id = ?
`);

const getCommandStmt = db.prepare(`
  SELECT *
  FROM device_commands
  WHERE command_id = ?
  LIMIT 1
`);

const getRequestCommandsStmt = db.prepare(`
  SELECT *
  FROM device_commands
  WHERE request_id = ?
  ORDER BY issued_at ASC
  LIMIT ${MAX_STATUS_ROWS}
`);

const insertResultEventStmt = db.prepare(`
  INSERT INTO device_command_results (result_id, command_id, device_id, status, received_at, payload)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(result_id) DO NOTHING
`);

const getResultEventStmt = db.prepare(`
  SELECT command_id
  FROM device_command_results
  WHERE result_id = ?
  LIMIT 1
`);

export interface CommandDeliveryInput {
  commandId: string;
  status: DeliveryStatus;
  reason?: string;
  deliveredAt?: string;
}

export interface CommandReceiptInput {
  commandId: string;
  requestId?: string;
  device?: DeviceInfo;
  status: Exclude<ReceiptStatus, "missing">;
  receivedAt?: string;
}

export interface CommandResultInput {
  commandId: string;
  requestId?: string;
  resultId?: string;
  device?: DeviceInfo;
  status: ResultStatus;
  receivedAt?: string;
  actions?: unknown;
  stateAfter?: unknown;
  reason?: string;
}

export interface CommandWriteReceipt {
  received: boolean;
  command_id: string;
  request_id?: string;
  result_id?: string;
  duplicate?: boolean;
  error?: string;
}

interface DeviceCommandRow {
  command_id: string;
  request_id: string;
  target_device_id: string;
  message_id: string;
  kind: string;
  payload: string;
  issued_at: string;
  expires_at: string;
  delivery_status: DeliveryStatus;
  delivery_reason: string;
  delivered_at: string;
  receipt_status: ReceiptStatus;
  receipt_at: string;
  result_status: ResultStatus;
  result_id: string;
  result_at: string;
  result_payload: string;
  created_by: string;
  updated_at: string;
}

export function insertDeviceCommand(envelope: DeviceCommandEnvelope): void {
  insertCommandStmt.run(
    envelope.command_id,
    envelope.request_id,
    envelope.target_device_id,
    envelope.command_id,
    envelope.payload.kind,
    safeJsonStringify(envelope, COMMAND_PAYLOAD_MAX_BYTES),
    envelope.issued_at,
    envelope.expires_at,
    envelope.created_by,
  );
}

export function recordCommandDelivery(input: CommandDeliveryInput): void {
  const deliveredAt = input.status === "sent"
    ? input.deliveredAt || new Date().toISOString()
    : "";
  updateDeliveryStmt.run(
    input.status,
    cleanText(input.reason, 120),
    deliveredAt,
    input.commandId,
  );
}

export function recordCommandReceipt(input: CommandReceiptInput): CommandWriteReceipt {
  const commandId = cleanIdentifier(input.commandId);
  if (!commandId) return { received: false, command_id: "", error: "command_id_required" };
  const row = getCommandRow(commandId);
  const validation = validateCommandEvent(row, input.device, input.requestId);
  if (validation) return { received: false, command_id: commandId, error: validation };

  const receivedAt = normalizeIsoTimestamp(input.receivedAt) || new Date().toISOString();
  updateReceiptStmt.run(input.status, receivedAt, commandId);
  return {
    received: true,
    command_id: commandId,
    request_id: row!.request_id,
  };
}

export function recordCommandResult(input: CommandResultInput): CommandWriteReceipt {
  const commandId = cleanIdentifier(input.commandId);
  if (!commandId) return { received: false, command_id: "", error: "command_id_required" };
  const row = getCommandRow(commandId);
  const validation = validateCommandEvent(row, input.device, input.requestId);
  if (validation) return { received: false, command_id: commandId, error: validation };

  const receivedAt = normalizeIsoTimestamp(input.receivedAt) || new Date().toISOString();
  const resultId = cleanIdentifier(input.resultId) || generatedResultId();
  const payload = safeJsonStringify({
    actions: input.actions ?? [],
    state_after: input.stateAfter ?? null,
    reason: cleanText(input.reason, 240),
  }, COMMAND_RESULT_PAYLOAD_MAX_BYTES);

  const eventResult = insertResultEventStmt.run(
    resultId,
    commandId,
    input.device?.device_id ?? row!.target_device_id,
    input.status,
    receivedAt,
    payload,
  );
  if (eventResult.changes === 0) {
    const existing = getResultEventStmt.get(resultId) as { command_id: string } | null;
    if (existing?.command_id !== commandId) {
      return {
        received: false,
        command_id: commandId,
        request_id: row!.request_id,
        result_id: resultId,
        error: "result_id_conflict",
      };
    }
    return {
      received: true,
      command_id: commandId,
      request_id: row!.request_id,
      result_id: resultId,
      duplicate: true,
    };
  }

  updateResultStmt.run(input.status, resultId, receivedAt, payload, commandId);
  if (row!.receipt_status === "missing") {
    updateReceiptStmt.run("received", receivedAt, commandId);
  }
  return {
    received: true,
    command_id: commandId,
    request_id: row!.request_id,
    result_id: resultId,
  };
}

export function recordServerCommandResult(input: {
  commandId: string;
  status: ResultStatus;
  reason?: string;
}): void {
  const commandId = cleanIdentifier(input.commandId);
  if (!commandId || !getCommandRow(commandId)) return;
  const now = new Date().toISOString();
  updateResultStmt.run(
    input.status,
    generatedResultId(),
    now,
    safeJsonStringify({ reason: cleanText(input.reason, 240) }, COMMAND_RESULT_PAYLOAD_MAX_BYTES),
    commandId,
  );
}

export function getCommandStatuses(query: { commandId?: string; requestId?: string }): {
  schema: typeof COMMAND_SCHEMA;
  found: boolean;
  commands: ReturnType<typeof commandStatusFromRow>[];
} {
  const commandId = query.commandId ? cleanIdentifier(query.commandId) : "";
  const requestId = query.requestId ? cleanIdentifier(query.requestId) : "";
  const rows = commandId
    ? [getCommandRow(commandId)].filter((row): row is DeviceCommandRow => !!row)
    : requestId
      ? getRequestCommandsStmt.all(requestId) as DeviceCommandRow[]
      : [];
  return {
    schema: COMMAND_SCHEMA,
    found: rows.length > 0,
    commands: rows.map(commandStatusFromRow),
  };
}

export function getCommandRow(commandId: string): DeviceCommandRow | null {
  return getCommandStmt.get(commandId) as DeviceCommandRow | null;
}

function commandStatusFromRow(row: DeviceCommandRow) {
  const expired = Date.parse(row.expires_at) < Date.now();
  const resultStatus = row.result_status === "unknown" && expired ? "timeout" : row.result_status;
  return {
    command_id: row.command_id,
    request_id: row.request_id,
    target_device_id: row.target_device_id,
    message_id: row.message_id,
    created_by: row.created_by,
    issued_at: row.issued_at,
    expires_at: row.expires_at,
    kind: row.kind,
    delivery: {
      status: row.delivery_status,
      reason: row.delivery_reason || null,
      delivered_at: row.delivered_at || null,
    },
    receipt: {
      status: row.receipt_status,
      received_at: row.receipt_at || null,
    },
    result: {
      status: resultStatus,
      result_id: row.result_id || null,
      result_at: row.result_at || null,
      payload: safeJsonParseObject(row.result_payload),
    },
    payload: safeJsonParseObject(row.payload),
    updated_at: row.updated_at,
  };
}

function validateCommandEvent(row: DeviceCommandRow | null, device: DeviceInfo | undefined, requestId: string | undefined): string | null {
  if (!row) return "unknown_command";
  const cleanRequestId = requestId ? cleanIdentifier(requestId) : "";
  if (cleanRequestId && cleanRequestId !== row.request_id) return "request_mismatch";
  const deviceId = device?.device_id ? cleanLooseIdentifier(device.device_id, 160) : "";
  if (deviceId && deviceId !== row.target_device_id) return "device_mismatch";
  return null;
}

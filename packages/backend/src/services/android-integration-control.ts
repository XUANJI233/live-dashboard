import type { ServerWebSocket } from "bun";
import { cleanLooseIdentifier, cleanText } from "./mcp-contracts";
import { coyoteCommandAllowed, coyoteRateLimitAllowed, normalizeCoyoteCommand } from "./coyote-control";
import { realtimeSocketHub, sendJson } from "./realtime-socket-hub";
import type { WsData } from "./realtime-types";

const COMMAND_TIMEOUT_MS = 12_000;
const MAX_WAITERS = 100;

export interface CoyoteIntegrationState {
  available: boolean;
  connected: boolean;
  device_name: string;
  generation: "v2" | "v3" | "unknown";
  battery_percent: number | null;
  strength_a: number;
  strength_b: number;
  limit_a: number;
  limit_b: number;
  wave_active_a: boolean;
  wave_active_b: boolean;
  waveform_a: string;
  waveform_b: string;
  remote_control_enabled: boolean;
}

export interface AndroidIntegrationState {
  device_id: string;
  online: boolean;
  updated_at: string;
  coyote: CoyoteIntegrationState;
  accounting: {
    available: boolean;
    last_sync_at: string;
    last_error: string;
  };
}

interface PendingResult {
  deviceId: string;
  kind: "coyote" | "accounting";
  resolve: (value: Record<string, unknown>) => void;
  timer: ReturnType<typeof setTimeout>;
}

const states = new Map<string, AndroidIntegrationState>();
const pending = new Map<string, PendingResult>();

export function handleAndroidIntegrationWsMessage(
  ws: ServerWebSocket<WsData>,
  data: Record<string, unknown>,
): void {
  if (data.type === "integration_status") {
    const state = updateIntegrationState(ws.data.id, data);
    sendJson(ws, { type: "integration_status_received", received: true, updated_at: state.updated_at });
    return;
  }
  if (data.type === "coyote_command_result") {
    updateIntegrationState(ws.data.id, data);
    settlePending(ws.data.id, data.request_id, "coyote", data);
    sendJson(ws, { type: "coyote_command_result_received", request_id: cleanRequestId(data.request_id) });
    return;
  }
  if (data.type === "accounting_sync_result") {
    updateIntegrationState(ws.data.id, data);
    settlePending(ws.data.id, data.request_id, "accounting", data);
    sendJson(ws, { type: "accounting_sync_result_received", request_id: cleanRequestId(data.request_id) });
    return;
  }
  sendJson(ws, { type: "error", error: "unsupported_integration_message" });
}

export function markAndroidIntegrationOffline(deviceIdInput: string): void {
  const deviceId = cleanLooseIdentifier(deviceIdInput, 160);
  const previous = states.get(deviceId);
  if (!previous) return;
  states.set(deviceId, { ...previous, online: false, updated_at: new Date().toISOString() });
}

export function getCoyoteStatuses(deviceIdInput?: string): {
  generated_at: string;
  devices: AndroidIntegrationState[];
} {
  const deviceId = cleanLooseIdentifier(deviceIdInput, 160);
  const devices = Array.from(states.values())
    .filter((item) => !deviceId || item.device_id === deviceId)
    .map((item) => ({
      ...item,
      online: realtimeSocketHub.getIntegrationSocket(item.device_id) != null,
    }));
  return { generated_at: new Date().toISOString(), devices };
}

export async function executeCoyoteCommand(
  deviceIdInput: string,
  commandInput: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const deviceId = cleanLooseIdentifier(deviceIdInput, 160);
  if (!deviceId) throw new Error("invalid_device_id");
  const command = normalizeCoyoteCommand(commandInput);
  const state = states.get(deviceId);
  const socket = realtimeSocketHub.getIntegrationSocket(deviceId);
  const grant = {
    online: !!socket,
    connected: state?.coyote.connected === true,
    remote_control_enabled: state?.coyote.remote_control_enabled === true,
  };
  if (!coyoteCommandAllowed(command.action, grant)) {
    return {
      ok: false,
      status: socket ? "denied" : "offline",
      error: socket ? "coyote_remote_control_not_granted_or_disconnected" : "android_integration_offline",
      device_id: deviceId,
      command,
    };
  }
  if (!coyoteRateLimitAllowed(deviceId, command.action)) {
    return {
      ok: false,
      status: "rate_limited",
      error: "coyote_command_rate_limited",
      device_id: deviceId,
      command,
    };
  }
  const requestId = `coyote_${crypto.randomUUID()}`;
  const result = waitForResult(requestId, deviceId, "coyote", () => {
    sendJson(socket!, {
      type: "coyote_command",
      request_id: requestId,
      command,
    });
  });
  return {
    request_id: requestId,
    device_id: deviceId,
    command,
    ...await result,
  };
}

export async function requestAccountingSync(options: {
  deviceId?: string;
  start: string;
  end: string;
}): Promise<Record<string, unknown>> {
  const startMs = Date.parse(options.start);
  const endMs = Date.parse(options.end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    throw new Error("invalid_accounting_range");
  }
  if (endMs - startMs > 3_650 * 24 * 60 * 60_000) {
    throw new Error("accounting_range_too_large");
  }
  const requestedDeviceId = cleanLooseIdentifier(options.deviceId, 160);
  const deviceId = requestedDeviceId || realtimeSocketHub.onlineIntegrationDeviceIds()[0] || "";
  const socket = deviceId ? realtimeSocketHub.getIntegrationSocket(deviceId) : undefined;
  if (!deviceId || !socket) {
    return {
      ok: false,
      status: "offline",
      error: "android_integration_offline",
      device_id: requestedDeviceId || null,
    };
  }
  const requestId = `accounting_${crypto.randomUUID()}`;
  const result = waitForResult(requestId, deviceId, "accounting", () => {
    sendJson(socket, {
      type: "accounting_sync_request",
      request_id: requestId,
      start: options.start,
      end: options.end,
    });
  });
  return {
    request_id: requestId,
    device_id: deviceId,
    ...await result,
  };
}

function waitForResult(
  requestId: string,
  deviceId: string,
  kind: PendingResult["kind"],
  send: () => void,
): Promise<Record<string, unknown>> {
  if (pending.size >= MAX_WAITERS) {
    return Promise.resolve({ ok: false, status: "busy", error: "integration_waiter_limit" });
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      resolve({ ok: false, status: "timeout", error: "integration_result_timeout" });
    }, COMMAND_TIMEOUT_MS);
    timer.unref?.();
    pending.set(requestId, { deviceId, kind, resolve, timer });
    try {
      send();
    } catch {
      clearTimeout(timer);
      pending.delete(requestId);
      resolve({ ok: false, status: "failed", error: "integration_send_failed" });
    }
  });
}

function settlePending(
  deviceId: string,
  requestIdInput: unknown,
  kind: PendingResult["kind"],
  value: Record<string, unknown>,
): void {
  const requestId = cleanRequestId(requestIdInput);
  const waiter = pending.get(requestId);
  if (!waiter || waiter.deviceId !== deviceId || waiter.kind !== kind) return;
  clearTimeout(waiter.timer);
  pending.delete(requestId);
  waiter.resolve(value);
}

function updateIntegrationState(deviceIdInput: string, data: Record<string, unknown>): AndroidIntegrationState {
  const deviceId = cleanLooseIdentifier(deviceIdInput, 160);
  const previous = states.get(deviceId) ?? emptyIntegrationState(deviceId);
  const coyoteBody = objectField(data.coyote) ?? objectField(data.state);
  const accountingBody = objectField(data.accounting);
  const next = {
    device_id: deviceId,
    online: true,
    updated_at: new Date().toISOString(),
    coyote: coyoteBody ? normalizeCoyoteState(coyoteBody, previous.coyote) : previous.coyote,
    accounting: accountingBody ? normalizeAccountingState(accountingBody, previous.accounting) : previous.accounting,
  };
  states.set(deviceId, next);
  return next;
}

function normalizeCoyoteState(
  body: Record<string, unknown>,
  previous: CoyoteIntegrationState,
): CoyoteIntegrationState {
  const generation = body.generation === "v2" || body.generation === "v3" ? body.generation : "unknown";
  return {
    available: strictBoolean(body.available, previous.available),
    connected: strictBoolean(body.connected, previous.connected),
    device_name: cleanText(body.device_name, 100),
    generation,
    battery_percent: nullableNumber(body.battery_percent, 0, 100),
    strength_a: integer(body.strength_a, 0, 200, previous.strength_a),
    strength_b: integer(body.strength_b, 0, 200, previous.strength_b),
    limit_a: integer(body.limit_a, 0, 200, previous.limit_a),
    limit_b: integer(body.limit_b, 0, 200, previous.limit_b),
    wave_active_a: strictBoolean(body.wave_active_a, previous.wave_active_a),
    wave_active_b: strictBoolean(body.wave_active_b, previous.wave_active_b),
    waveform_a: cleanText(body.waveform_a, 40),
    waveform_b: cleanText(body.waveform_b, 40),
    remote_control_enabled: strictBoolean(body.remote_control_enabled, previous.remote_control_enabled),
  };
}

function normalizeAccountingState(
  body: Record<string, unknown>,
  previous: AndroidIntegrationState["accounting"],
): AndroidIntegrationState["accounting"] {
  return {
    available: strictBoolean(body.available, previous.available),
    last_sync_at: cleanText(body.last_sync_at, 40),
    last_error: cleanText(body.last_error, 240),
  };
}

function emptyIntegrationState(deviceId: string): AndroidIntegrationState {
  return {
    device_id: deviceId,
    online: false,
    updated_at: "",
    coyote: {
      available: false,
      connected: false,
      device_name: "",
      generation: "unknown",
      battery_percent: null,
      strength_a: 0,
      strength_b: 0,
      limit_a: 50,
      limit_b: 50,
      wave_active_a: false,
      wave_active_b: false,
      waveform_a: "",
      waveform_b: "",
      remote_control_enabled: false,
    },
    accounting: { available: false, last_sync_at: "", last_error: "" },
  };
}

function objectField(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function strictBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function integer(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.round(value)))
    : fallback;
}

function nullableNumber(value: unknown, min: number, max: number): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : null;
}

function cleanRequestId(value: unknown): string {
  const text = cleanText(value, 160);
  return /^[a-zA-Z0-9_.:-]{1,160}$/.test(text) ? text : "";
}
